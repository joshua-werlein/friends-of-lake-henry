import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { decidePhoto, matchPrize, chicagoDate, composePrize, writeDecision } from '../src/lib/server/raffle-photo-autopublish.ts';
import { prizeSchedule } from '../src/lib/server/raffle-prizes.ts';
import { webhookPostIds, qualifies, pollDue, alertsDue, validSignature } from '../workers/facebook-photos/webhook.ts';
import { checkPhotoWorker } from '../workers/facebook-photos/check-deployment.mjs';
import { base64Image } from '../workers/facebook-live/photos.ts';
import { GET as publicMonth } from '../src/pages/api/raffle/month.ts';
import { POST as winnersPost } from '../src/pages/api/admin/raffle/winners.ts';

test('isolated FOHL Sync callback checks signatures and keeps Graph diagnostics off public HTTP', async () => {
    const bundle = await build({ entryPoints: ['workers/fohl-sync/index.ts'], bundle: true,
        format: 'esm', external: ['cloudflare:workers'], write: false });
    const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text,
        compatibilityDate: '2025-09-15', bindings: { FB_APP_SECRET: 'test-signing-key', FB_WEBHOOK_VERIFY_TOKEN: 'test-challenge-key' },
        outboundService: () => { throw Error('The callback must not contact external services'); } });
    try {
        const url = 'https://test.invalid/facebook/webhook';
        const challenge = await mf.dispatchFetch(url + '?hub.mode=subscribe&hub.verify_token=test-challenge-key&hub.challenge=12345');
        assert.equal(challenge.status, 200);
        assert.equal(await challenge.text(), '12345');
        assert.equal((await mf.dispatchFetch(url + '?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345')).status, 403);
        const body = JSON.stringify({ object: 'page', entry: [{ id: '144051422124740', changes: [
            { field: 'feed', value: { item: 'photo', verb: 'add', post_id: '144051422124740_123' } },
        ] }] });
        const signature = 'sha256=' + createHmac('sha256', 'test-signing-key').update(body).digest('hex');
        const send = (text, sig) => mf.dispatchFetch(url, { method: 'POST', body: text,
            headers: sig ? { 'X-Hub-Signature-256': sig } : {} });
        assert.equal((await send(body)).status, 403);
        assert.equal((await send(body + ' ', signature)).status, 403);
        assert.equal((await send(body, signature)).status, 200);
        assert.equal((await mf.dispatchFetch('https://test.invalid/inspect')).status, 404);
    } finally {
        await mf.dispose();
    }
});

test('production callback keys are isolated and switching credentials changes only the active route', async () => {
    const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
        import worker from './workers/facebook-photos/index.ts';
        export default { async fetch(request, env, ctx) {
            let forwarded = 0;
            const response = await worker.fetch(request, {
                ...env,
                FACEBOOK_LIVE: { async notify() { forwarded++; } },
            }, ctx);
            return new Response(response.body, { status: response.status, headers: { forwarded: String(forwarded) } });
        } };
    ` }, bundle: true, format: 'esm', external: ['cloudflare:workers'], write: false });
    const body = JSON.stringify({ object: 'page', entry: [{ id: '144051422124740', changes: [
        { field: 'feed', value: { item: 'video', verb: 'add', post_id: '144051422124740_123' } },
    ] }] });
    for (const active of ['legacy', 'fohl-sync']) {
        const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-09-15',
            bindings: { FB_CREDENTIAL_SET: active, FB_APP_SECRET: 'old-test-key', FOHL_SYNC_APP_SECRET: 'new-test-key' } });
        try {
            for (const [suffix, key, otherKey] of [['', 'old-test-key', 'new-test-key'], ['/fohl-sync', 'new-test-key', 'old-test-key']]) {
                const send = signingKey => mf.dispatchFetch('https://test.invalid/facebook/webhook' + suffix, {
                    method: 'POST', body, headers: { 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', signingKey).update(body).digest('hex') },
                });
                assert.equal((await send(otherKey)).status, 403);
                const response = await send(key);
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('forwarded'), Boolean(suffix) === (active === 'fohl-sync') ? '1' : '0');
            }
        } finally {
            await mf.dispose();
        }
    }
});
import { GET as importsGet, POST as importsPost } from '../src/pages/api/admin/raffle/photo-imports.ts';

const events = JSON.parse(await readFile(new URL('./fixtures/november-2026-published-raffle-events.json', import.meta.url))).events;
const picture = new Uint8Array(await readFile(new URL('./fixtures/november-2025-winner-table.png', import.meta.url)));
const PAGE = '144051422124740';
const row = (extra = {}) => ({ drawDate: '2026-11-03', position: 1, ticketNumber: '412', name: 'Jane Doe', town: 'Blair', prize: 'Firearm', notes: '', ...extra });
const pass = rows => ({ containsWinners: true, rows, warnings: [] });
// Stored November 2 placements that must survive every automated run.
const art = { id: '2026-11-2026-11-02-118', drawDate: '2026-11-02', ticketNumber: 118, name: 'Art Soborowicz', town: 'Galesville', prize: '1st place — Savage 110 High Country 30-06' };
const amos = { id: '2026-11-2026-11-02-907', drawDate: '2026-11-02', ticketNumber: 907, name: 'Amos Carvalho', town: 'Ettrick', prize: '2nd place' };

async function database(t) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    await migrate(DB);
    return DB;
}
async function migrate(DB, seedWinners = true) {
    for (const name of ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '004_raffle_photo_autopublish.sql', '005_winner_ticket_text.sql', '006_bonus_winner_tickets.sql', '007_photo_import_diagnostics.sql']) {
        const sql = (await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');
        for (const statement of sql.split(';').filter(v => v.trim())) await DB.prepare(statement).run();
    }
    for (const e of events) await DB.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id, e.title, e.kind, e.status, e.date_start, e.summary).run();
    if (seedWinners) for (const w of [art, amos]) await DB.prepare('INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town,prize) VALUES(?,?,?,?,?,?,?)')
        .bind(w.id, '2026-11', w.drawDate, w.ticketNumber, w.name, w.town, w.prize).run();
}

test('daily Safe & Secure $100 gift certificate is a scheduled prize on every published drawing day', async t => {
    const DB = await database(t), rows = await prizeSchedule(DB, '2026-11');
    const daily = rows.filter(p => p.source === 'daily');
    assert.equal(daily.length, 30);
    assert.ok(daily.every(p => p.category === 'Gift card' && p.description === '$100 gift certificate from Safe & Secure Firearms' && p.position === null));
    const nov3 = rows.filter(p => p.drawDate === '2026-11-03').map(p => p.category);
    assert.deepEqual(nov3, ['Main prize', 'Gift card']); // Main prize first, then the poster's daily prize.
    assert.equal((await prizeSchedule(DB, '2026-12')).length, 0); // No calendar, no invented daily prize.
});

test('November 5 column reads map both prizes and a cumulative Friday table stays eligible', async t => {
    const db = await database(t);
    const schedule = await prizeSchedule(db, '2026-11');
    const dan = row({ drawDate: '2026-11-05', position: null, ticketNumber: '789',
        name: 'Dan Heffner', town: 'LaCrosse, WI', prize: 'Firearm' });
    const brent = { ...dan, ticketNumber: '050', name: 'Brent Janzen', town: 'Blair, WI', prize: 'Gift Card' };
    const decide = (rows, date) => decidePhoto([pass(rows), pass(structuredClone(rows))], [], schedule, date);
    const decision = decide([dan, brent], dan.drawDate);
    assert.deepEqual(decision.rows.map(r => [r.outcome, r.row.ticketNumber, r.prize]), [
        ['insert', '789', '1st place — Bergara HMR 6.5 Creedmoor'],
        ['insert', '050', '2nd place — $100 gift certificate from Safe & Secure Firearms'],
    ]);
    await writeDecision(db, { photoId: '122333668490073310', postId: '144051422124740_122333668526073310',
        sha256: null, width: null, height: null, model: null, passes: [pass([dan, brent]), pass([dan, brent])] }, decision, true);
    assert.deepEqual((await db.prepare("SELECT ticket_number_text FROM raffle_winners WHERE draw_date=? ORDER BY ticket_number").bind(dan.drawDate).all()).results,
        [{ ticket_number_text: '050' }, { ticket_number_text: '789' }]);
    const anotherPost = {photoId:'111',postId:'144051422124740_111',sha256:null,width:null,height:null,model:null,passes:[]};
    assert.equal(await writeDecision(db,anotherPost,decision,true),'duplicate');
    const conflict = decide([{...dan,ticketNumber:'123'}],dan.drawDate);
    assert.equal(await writeDecision(db,{...anotherPost,photoId:'112'},conflict,true),'rejected');
    const audit = await db.prepare("SELECT outcome,reasons_json FROM raffle_photo_auto_rows WHERE photo_id='112'").first();
    assert.equal(audit.outcome,'rejected');
    assert.match(audit.reasons_json,/place became unavailable/);
    const friday = '2026-11-06';
    const history = Array.from({ length: 10 }, (_, i) => ({ ...dan, drawDate: '2026-11-02', ticketNumber: String(i + 1) }));
    const fridayRows = [{ ...dan, drawDate: friday }, { ...brent, drawDate: friday },
        { ...brent, drawDate: friday, ticketNumber: '100', prize: '2nd drawing' }];
    assert.deepEqual(decide([...history, ...fridayRows], friday).rows.slice(-3).map(r => r.prize), [
        '1st place — Springfield Armory 1911 Emissary 9MM',
        '2nd place — $100 gift certificate from Safe & Secure Firearms',
        'Bonus — Cutting Board, Cheese Board & Knife sponsored by Cutting Canteen',
    ]);
    assert.equal(decide([{ ...dan, position: 2 }], dan.drawDate).rows[0].outcome, 'held');
    assert.deepEqual(decide([dan, { ...dan, ticketNumber: '123' }], dan.drawDate).rows.map(r => r.outcome), ['held', 'held']);
});

test('visible prize text matches exactly one verified scheduled prize; nothing is inferred from place', async t => {
    const schedule = await prizeSchedule(await database(t), '2026-11');
    assert.deepEqual(matchPrize('Tikka T3X 7MM Rem Mag', '2026-11-03', schedule), { description: 'Tikka T3X Hunter 7MM Rem Mag', match: 'scheduled' });
    assert.deepEqual(matchPrize('$100 Safe & Secure Firearms gift certificate', '2026-11-03', schedule), { description: '$100 gift certificate from Safe & Secure Firearms', match: 'scheduled' });
    assert.equal(matchPrize('Tikka T3X 7MM Rem Mag', '2026-11-04', schedule).match, 'unmatched'); // Wrong day's prize.
    assert.equal(matchPrize('Mystery prize', '2026-11-03', schedule).match, 'unmatched');
    assert.equal(matchPrize('', '2026-11-03', schedule).match, 'none');
    assert.equal(composePrize(2, null), '2nd place');
    assert.equal(composePrize(null, null), null);
});

test('a representative daily announcement publishes verified rows with matched prizes', async t => {
    const DB = await database(t), schedule = await prizeSchedule(DB, '2026-11');
    const rows = [row({ prize: 'Tikka T3X Hunter 7MM Rem Mag' }), row({ position: 2, ticketNumber: '77', name: 'Bob Smith', town: 'Taylor', prize: '$100 Safe & Secure gift certificate' })];
    const d = decidePhoto([pass(rows), pass(rows)], [art, amos], schedule, '2026-11-03');
    assert.equal(d.status, 'published');
    assert.deepEqual(d.rows.map(r => [r.outcome, r.prize, r.winnerId]), [
        ['insert', '1st place — Tikka T3X Hunter 7MM Rem Mag', '2026-11-2026-11-03-412'],
        ['insert', '2nd place — $100 gift certificate from Safe & Secure Firearms', '2026-11-2026-11-03-77']]);
});

test('uncertain or disagreeing rows are held and conflicting rows rejected, never guessed or overwritten', async t => {
    const DB = await database(t), schedule = await prizeSchedule(DB, '2026-11');
    const decide = (a, b = a, existing = [art, amos], date = '2026-11-03') => decidePhoto([pass(a), pass(b)], existing, schedule, date);
    // Passes disagree on the ticket of row 2 → only row 2 is held back.
    const d1 = decide([row(), row({ position: 2, ticketNumber: '77', name: 'Bob Smith' })], [row(), row({ position: 2, ticketNumber: '71', name: 'Bob Smith' })]);
    assert.equal(d1.status, 'partial');
    assert.deepEqual(d1.rows.map(r => r.outcome), ['insert', 'held']);
    assert.match(d1.rows[1].reasons.join(), /disagree on ticketNumber/);
    // Model notes, missing fields or question marks are uncertainty.
    for (const bad of [row({ notes: 'last digit unclear' }), row({ town: '' }), row({ name: 'J?ne Doe' }), row({ drawDate: '' }), row({ ticketNumber: '4l2' })])
        assert.equal(decide([bad]).rows[0].outcome, 'held');
    // November 2 is already filled: a different 1st place for that day conflicts; the stored winner is untouched.
    const takeover = decide([row({ drawDate: '2026-11-02', ticketNumber: '555', name: 'Someone Else' })]);
    assert.equal(takeover.rows[0].outcome, 'rejected');
    assert.match(takeover.rows[0].reasons.join(), /1st place for 2026-11-02 already belongs/);
    // A misspelled re-announcement of Art's ticket is a conflict, not an update.
    assert.equal(decide([row({ drawDate: '2026-11-02', ticketNumber: '118', name: 'Art Soborowitz', town: 'Galesville' })]).rows[0].outcome, 'rejected');
    // An exact re-announcement is a duplicate.
    const repeat = decide([row({ drawDate: '2026-11-02', ticketNumber: '118', name: 'Art Soborowicz', town: 'Galesville' })]);
    assert.equal(repeat.status, 'duplicate');
    // The same ticket or place twice in one image holds both rows.
    assert.deepEqual(decide([row(), row({ ticketNumber: '99', name: 'Other Person' })]).rows.map(r => r.outcome), ['held', 'held']);
    // A row only one pass read is held; the row both passes agree on still publishes.
    const counts = decidePhoto([pass([row()]), pass([row(), row({ ticketNumber: '1', position: null })])], [], schedule, '2026-11-03');
    assert.equal(counts.status, 'partial');
    assert.deepEqual(counts.rows.map(r => [r.row.ticketNumber, r.outcome]), [['412', 'insert'], ['1', 'held']]);
    assert.match(counts.rows[1].reasons.join(), /only 1 of 2 extraction passes/);
    // Passes that disagree on being a winner photo reject the whole photo.
    assert.equal(decidePhoto([pass([row()]), { containsWinners: false, rows: [], warnings: [] }], [], schedule, '2026-11-03').status, 'rejected');
    assert.equal(decidePhoto([{ containsWinners: false, rows: [], warnings: [] }], [], schedule, '2026-11-03').status, 'ignored');
    // An excessive number of eligible rows and dates outside the announcement window never publish automatically.
    assert.equal(decide(Array.from({ length: 30 }, (_, i) => row({ ticketNumber: String(i + 1), position: null }))).status, 'rejected');
    assert.equal(decide([row({ drawDate: '2026-11-01', position: null })], undefined, [art, amos], '2026-11-05').rows[0].outcome, 'outside-window');
    assert.equal(decide([row({ drawDate: '2026-11-04' })]).rows[0].reasons[0], 'draw date is after the announcement');
    // Unmatched or absent prize evidence holds the row for review.
    const unmatched = decide([row({ prize: 'Remington 700' })]);
    assert.equal(unmatched.rows[0].outcome, 'held');
    assert.equal(unmatched.rows[0].prize, null);
    assert.match(unmatched.rows[0].reasons.join(), /exactly one approved scheduled prize/);
});

test('image encoding is exact and cheap enough for the Workers Free CPU limit', () => {
    for (const n of [0, 1, 2, 3, 4, 5, picture.length]) assert.equal(base64Image(picture.subarray(0, n)), Buffer.from(picture.subarray(0, n)).toString('base64'));
    const start = performance.now();
    for (let i = 0; i < 10; i++) base64Image(picture);
    assert.ok((performance.now() - start) / 10 < 5, 'encoding a 600 KB winner image must stay well under 10 ms');
});

test('blank hometown needs both reads to verify the empty cell; incomplete prize, label disagreement and image warnings stay held', async t => {
 const schedule=await prizeSchedule(await database(t),'2026-11');
 const a=row({town:'',townStatus:'blank',prize:'Firearm',position:null});
 const decide=(x,y=x,warnings=[])=>decidePhoto([{...pass([x]),warnings},pass([y])],[],schedule,'2026-11-03');
 assert.equal(decide(a).rows[0].outcome,'insert');
 const stored={id:'blank-town-winner',drawDate:a.drawDate,ticketNumber:Number(a.ticketNumber),name:a.name,town:'',prize:'Tikka T3X Hunter 7MM Rem Mag'};
 assert.equal(decidePhoto([pass([a]),pass([a])],[stored],schedule,'2026-11-03').rows[0].outcome,'duplicate');
 assert.equal(decidePhoto([pass([a])],[],schedule,'2026-11-03').status,'rejected');
 for(const bad of [{...a,townStatus:undefined},{...a,townStatus:'uncertain'},{...a,notes:'hometown clipped'},{...a,prize:''}])assert.equal(decide(bad).rows[0].outcome,'held');
 assert.equal(decide(a,{...a,townStatus:undefined}).rows[0].outcome,'held');
 assert.equal(decide(a,{...a,notes:'hometown clipped'}).rows[0].outcome,'held');
 assert.equal(decide({...a,ticketNumber:'047'},{...a,ticketNumber:'47'}).rows[0].outcome,'held');
 assert.equal(decide(a,a,['right winner column is clipped']).status,'rejected');
 assert.equal(decidePhoto([pass([a]),pass([a])],[],[],'2026-11-03').rows[0].outcome,'held');
 const duplicate=schedule.find(p=>p.drawDate==='2026-11-03'&&p.category==='Main prize');
 assert.equal(decidePhoto([pass([a]),pass([a])],[],[...schedule,{...duplicate,id:'other-main'}],'2026-11-03').rows[0].outcome,'held');
});

test('real column-aware AI reads recover November 3–4 headings, full towns, blank hometown and 047 without inventing places',async t=>{
 const schedule=await prizeSchedule(await database(t),'2026-11');
 for(const day of ['03','04']){
  const fixture=suffix=>new URL(`./fixtures/facebook-winners-2026-11-${day}${suffix}`,import.meta.url);
  const before=JSON.parse(await readFile(fixture('.json'),'utf8'));
  const after=JSON.parse(await readFile(fixture('.table-vision.json'),'utf8'));
  const {createHash}=await import('node:crypto');assert.equal(createHash('sha256').update(await readFile(fixture('.jpg'))).digest('hex'),after.sha256);
  assert.equal(after.sha256,before.sha256);
  assert.equal(after.extractionPasses.length,2);
  for(const pass of after.extractionPasses){assert.equal(pass.rows.length,day==='03'?6:8);assert.deepEqual(pass.warnings,[]);assert.ok(pass.rows.every(r=>r.position===null));assert.ok(pass.rows.every(r=>['Firearm','Gift Card'].includes(r.prize)));assert.ok(pass.rows.every(r=>!r.town||/\b(?:WI|MN|WA)$/.test(r.town)));assert.equal(pass.rows.find(r=>r.name==='Kerry & Jeff Jacobson').ticketNumber,'047');}
  const decision=decidePhoto(after.extractionPasses,[],schedule,`2026-11-${day}`);
  const latest=decision.rows.filter(r=>r.row.drawDate===`2026-11-${day}`);
  assert.ok(latest.every(r=>r.outcome==='insert'));
  assert.deepEqual(latest.map(r=>[r.row.ticketNumber,r.prize]),day==='03'?[['392','1st place — Tikka T3X Hunter 7MM Rem Mag'],['047','2nd place — $100 gift certificate from Safe & Secure Firearms']]:[['226','1st place — Henry Big Boy All Weather 44 Mag'],['362','2nd place — $100 gift certificate from Safe & Secure Firearms']]);
  if(day==='04'){const jim=latest.find(r=>r.row.name==='Jim Wilber');assert.equal(jim.row.town,'');assert.equal(jim.row.townStatus,'blank');const old=decidePhoto(before.extractionPasses,[],schedule,'2026-11-04');assert.ok(old.rows.filter(r=>r.row.drawDate==='2026-11-04').every(r=>r.outcome==='rejected'));}
 }
});

test('webhook payload parsing, signature verification, post qualification and poll window', async () => {
    const payload = { object: 'page', entry: [{ id: PAGE, changes: [
        { field: 'feed', value: { item: 'photo', verb: 'add', post_id: `${PAGE}_123` } },
        { field: 'feed', value: { item: 'status', verb: 'edited', post_id: `61552199315213_456` } },
        { field: 'feed', value: { item: 'comment', verb: 'add', post_id: `${PAGE}_789` } },
        { field: 'feed', value: { item: 'photo', verb: 'remove', post_id: `${PAGE}_790` } },
        { field: 'feed', value: { item: 'photo', verb: 'add', post_id: `999_791` } }] },
        { id: '999', changes: [{ field: 'feed', value: { item: 'photo', verb: 'add', post_id: '999_1' } }] }] };
    assert.deepEqual(webhookPostIds(payload), [`${PAGE}_123`, `${PAGE}_456`]);
    assert.deepEqual(webhookPostIds({ object: 'user', entry: payload.entry }), []);
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const sig = 'sha256=' + createHmac('sha256', 'app-secret').update(body).digest('hex');
    assert.equal(await validSignature('app-secret', sig, body.buffer), true);
    assert.equal(await validSignature('other-secret', sig, body.buffer), false);
    assert.equal(await validSignature('app-secret', 'sha1=abc', body.buffer), false);
    assert.equal(await validSignature('app-secret', null, body.buffer), false);
    assert.ok(qualifies('Congratulations to tonight’s winners! #LakeHenryRaffle'));
    assert.ok(!qualifies('Day 3 calendar raffle winners'));
    assert.ok(!qualifies('Drawing winners #LakeHenryRaffleArchive'));
    assert.ok(!qualifies('Ice fishing report and photos'));
    assert.ok(!qualifies('Our raffle poster is here'));
    // Graph backup discovery: 17:55-18:05 Central, November only (CST is UTC-6 after Nov 1 2026).
    assert.ok(!pollDue(new Date('2026-11-03T23:54:00Z')));  // 17:54 Central
    assert.ok(pollDue(new Date('2026-11-03T23:55:00Z')));   // 17:55 Central
    assert.ok(pollDue(new Date('2026-11-04T00:00:00Z')));   // 18:00 Central
    assert.ok(pollDue(new Date('2026-11-04T00:05:00Z')));   // 18:05 Central
    assert.ok(!pollDue(new Date('2026-11-04T00:06:00Z')));  // 18:06 Central
    assert.ok(!pollDue(new Date('2026-11-04T00:10:00Z')));  // 18:10 Central: no evening sweep
    assert.ok(!pollDue(new Date('2026-11-03T16:30:00Z')));  // no daytime half-hourly sweep
    assert.ok(pollDue(new Date('2026-12-01T00:00:00Z')));   // Nov 30 18:00 Central
    assert.ok(!pollDue(new Date('2026-12-02T00:00:00Z')));  // Dec 1 18:00 Central
    assert.ok(!pollDue(new Date('2026-10-31T23:00:00Z')));  // Oct 31 18:00 Central (CDT)
    // Alert evaluations keep their schedule independent of the poll window.
    assert.ok(alertsDue(new Date('2026-11-04T00:10:00Z')));  // 18:10 Central
    assert.ok(!alertsDue(new Date('2026-11-03T16:14:00Z'))); // 10:14 Central
    assert.ok(alertsDue(new Date('2026-11-03T16:30:00Z')));  // half-hourly
    assert.ok(alertsDue(new Date('2026-12-02T00:00:00Z')));  // not limited to November
});

test('deployment preflight rejects anything that could replace the Live discovery Worker', async () => {
    const config = JSON.parse(await readFile(new URL('../workers/facebook-photos/wrangler.json', import.meta.url)));
    assert.ok(checkPhotoWorker(config));
    assert.throws(() => checkPhotoWorker({ ...config, name: 'folh-facebook-live-discovery' }), /never folh-facebook-live-discovery/);
    assert.throws(() => checkPhotoWorker({ ...config, durable_objects: { bindings: [] } }), /Durable Objects/);
    assert.throws(() => checkPhotoWorker({ ...config, migrations: [] }), /migrations/);
    assert.throws(() => checkPhotoWorker({ ...config, vars: { ...config.vars, FB_PAGE_ACCESS_TOKEN: 'x' } }), /secrets/);
    const live = JSON.parse(await readFile(new URL('../workers/facebook-live/wrangler.video.activation.existing-account.json', import.meta.url)));
    assert.equal(live.name, 'folh-facebook-live-discovery');
    assert.deepEqual(live.migrations, [{ tag: 'discovery-scheduler-v1', new_sqlite_classes: ['DiscoveryScheduler'] }]);
    assert.deepEqual(live.triggers.crons, ['* * * * *']);
});

// ---- End to end under workerd: signed webhook → Graph → CDN → AI (2 passes) → D1 → public API → admin edit/delete ----
for (const ownToken of [true,false]) test(`Facebook photo via ${ownToken?'own token':'fallback binding'} → AI → D1 → public website, dedupe and retries`, async t => {
    const bundle = await build({ entryPoints: [new URL('../workers/facebook-photos/index.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
        bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
    const readsBundle = await build({entryPoints:['workers/facebook-live/photo-reads.ts'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:workers']});
    const now = new Date(), publishedAt = new Date(now.getTime() - 10 * 60000);
    const D = chicagoDate(publishedAt), prev = chicagoDate(new Date(publishedAt.getTime() - 86400000));
    const created = publishedAt.toISOString().replace(/\.\d+Z$/, '+0000');
    const posts = new Map(), photoPng = 'https://scontent-ord5-1.xx.fbcdn.net/v/t39/winner.png';
    const post = (n, message) => { const id = `${PAGE}_${n}`; posts.set(id, { id, message, created_time: created,
        attachments: { data: [{ type: 'photo', target: { id: `90000000000000${n}` }, url: 'https://www.facebook.com/photo/' }] } }); return id; };
    const daily = post(1, `Congratulations to tonight's winners! #LakeHenryRaffle`);
    const liveEvents=new Set();let liveForwardCalls=0;
    let aiCalls = 0, failNextAi = false, aiRows = new Map();
    aiRows.set(1, [row({ drawDate: D, prize: 'Tikka T3X Hunter 7MM Rem Mag' }), row({ drawDate: D, position: 2, ticketNumber: '77', name: 'Bob Smith', town: 'Taylor', prize: 'Gift Card' })]);
    let currentPhoto = 0;
    const graphCalls = [];
    const mockOutbound = async request => {
                    const url = new URL(request.url);
                    if (url.hostname.endsWith('.fbcdn.net')) {
                        assert.equal(request.headers.get('authorization'), null); // The Page token never reaches the CDN.
                        return new Response(picture, { headers: { 'content-type': 'image/png' } });
                    }
                    assert.equal(url.hostname, 'graph.facebook.com');
                    assert.equal(request.headers.get('authorization'), 'Bearer page-token');
                    const path = url.pathname.split('/').slice(2).join('/');
                    graphCalls.push(path);
                    if (path === `${PAGE}/published_posts`) return Response.json({ data: [...posts.values()] });
                    if (posts.has(path)) return Response.json(posts.get(path));
                    if (/^90000000000000\d$/.test(path)) { currentPhoto = Number(path.slice(-1));
                        return Response.json({ id: path, images: [{ source: photoPng, width: 831, height: 1554 }, { source: photoPng.replace('winner', 'small'), width: 100, height: 187 }] }); }
                    return Response.json({ error: { code: 100 } }, { status: 400 });};
    const mf = new Miniflare({
        workers: [
            { name: 'photos', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-09-15',
                d1Databases: ['DB'], serviceBindings:{FACEBOOK_READS:{name:'reads',entrypoint:'FacebookPhotoReads'}}, wrappedBindings: { AI: { scriptName: 'ai-shim' }, FACEBOOK_LIVE:{scriptName:'events-shim'} },
                bindings: { ...(ownToken?{FB_PAGE_ACCESS_TOKEN:'page-token'}:{}), FB_APP_SECRET: 'app-secret', FB_WEBHOOK_VERIFY_TOKEN: 'verify-me',
                    FB_PHOTO_AUTOMATION_ENABLED: 'true', FB_PHOTO_AUTOPUBLISH: 'true', FB_PHOTO_POLL_ENABLED: 'true', FB_PHOTO_EXTRACTION_PASSES: '2',
                    FB_RAFFLE_MARKER: '#LakeHenryRaffle', FB_SEASON_START: new Date(now.getTime() - 10 * 86400000).toISOString(),
                    FB_SEASON_END: new Date(now.getTime() + 10 * 86400000).toISOString() },
                outboundService: mockOutbound },
            {name:'reads',modules:true,script:readsBundle.outputFiles[0].text,compatibilityDate:'2025-09-15',bindings:{FB_PAGE_ACCESS_TOKEN:'page-token'},outboundService:mockOutbound},
            {name:'events-shim',modules:true,serviceBindings:{CONTROL:async request=>{liveForwardCalls++;liveEvents.add(await request.text());return Response.json({accepted:true});}},script: `export default function(env){return {async notify(id){const r=await env.CONTROL.fetch('http://events',{method:'POST',body:id});return r.json()}}}`},
            { name: 'ai-shim', modules: true, serviceBindings: { CONTROL: async request => {
                    const input = await request.json();
                    assert.match(input.image, /^data:image\/png;base64,/);
                    aiCalls++;
                    if (failNextAi) { failNextAi = false; return new Response('busy', { status: 503 }); }
                    return Response.json({ response: { containsWinners: aiRows.get(currentPhoto).length > 0, rows: aiRows.get(currentPhoto), warnings: [] } });
                } },
                script: `export default function(env){return {async run(model,input){const r=await env.CONTROL.fetch('http://ai/run',{method:'POST',body:JSON.stringify({model,image:input.messages[0].content[1].image_url.url.slice(0,40)})});if(!r.ok)throw new Error('ai-unavailable');return r.json();}}}` },
        ],
        d1Persist: false,
    });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    await migrate(DB, false);
    // Today's main prize and the previous day's stored placements (stand-ins for Art/Amos on Nov 2).
    await DB.prepare(`INSERT INTO events(id,title,kind,status,date_start) VALUES('e2e','Day 99 - Tikka T3X Hunter 7MM Rem Mag','Raffle','published',?)
        ON CONFLICT(id) DO NOTHING`).bind(D).run();
    await DB.prepare(`UPDATE events SET status='draft' WHERE id<>'e2e'`).run();
    await DB.prepare("INSERT INTO events(id,title,kind,status,date_start) VALUES('previous-test','Day 98 - Savage 110 High Country 30-06','Raffle','published',?)").bind(prev).run();
    const prevArt = { ...art, id: `${prev.slice(0, 7)}-${prev}-118`, drawDate: prev };
    await DB.prepare('INSERT OR IGNORE INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town,prize) VALUES(?,?,?,?,?,?,?)')
        .bind(prevArt.id, prev.slice(0, 7), prev, 118, art.name, art.town, art.prize).run();

    const sign = body => 'sha256=' + createHmac('sha256', 'app-secret').update(body).digest('hex');
    const webhook = (ids, signature) => { const body = JSON.stringify({ object: 'page', entry: [{ id: PAGE, time: 1, changes: ids.map(id => ({ field: 'feed', value: { item: 'photo', verb: 'add', post_id: id } })) }] });
        return mf.dispatchFetch('https://photos.test/facebook/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(body) } }); };
    const settle = async (sql, value, ...args) => { for (let i = 0; i < 100; i++) { const r = await DB.prepare(sql).bind(...args).first(); if (r && Object.values(r)[0] === value) return; await new Promise(r => setTimeout(r, 100)); } assert.fail('timed out: ' + sql); };
    const winners = async () => (await DB.prepare('SELECT draw_date AS drawDate,ticket_number AS ticketNumber,winner_name AS name,town,prize FROM raffle_winners ORDER BY draw_date,ticket_number').all()).results;

    // Subscription handshake.
    assert.equal(await (await mf.dispatchFetch('https://photos.test/facebook/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444')).text(), '1158201444');
    assert.equal((await mf.dispatchFetch('https://photos.test/facebook/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
    assert.equal((await mf.dispatchFetch('https://photos.test/')).status, 404);
    // Forged deliveries are refused and queue nothing.
    assert.equal((await webhook([daily], 'sha256=' + '0'.repeat(64))).status, 403);
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM raffle_photo_auto_posts').first()).n, 0);

    // A signed official Page video event forwards independently of photo extraction; forged and wrong-Page events do not.
    const videoBody=JSON.stringify({object:'page',entry:[{id:PAGE,changes:[{field:'feed',value:{item:'video',verb:'add',post_id:PAGE+'_28261694626839193'}}]}]});
    const deliverVideo=signature=>mf.dispatchFetch('https://photos.test/facebook/webhook',{method:'POST',body:videoBody,headers:{'x-hub-signature-256':signature}});
    assert.equal((await deliverVideo('sha256='+'0'.repeat(64))).status,403);assert.equal(liveForwardCalls,0);
    assert.equal((await deliverVideo(sign(videoBody))).status,200);assert.equal((await deliverVideo(sign(videoBody))).status,200);assert.equal(liveEvents.size,1);assert.equal(aiCalls,0);
    // 1. Signed delivery → processed in the background → two winners published.
    const res = await webhook([daily]);
    assert.equal(res.status, 200);
    await settle(`SELECT status FROM raffle_photo_auto_posts WHERE post_id=?`, 'done', daily);
    assert.equal(aiCalls, 2); // Two independent reads that had to agree.
    const published = (await winners()).filter(w => w.drawDate === D);
    assert.deepEqual(published, [
        { drawDate: D, ticketNumber: 77, name: 'Bob Smith', town: 'Taylor', prize: '2nd place — $100 gift certificate from Safe & Secure Firearms' },
        { drawDate: D, ticketNumber: 412, name: 'Jane Doe', town: 'Blair', prize: '1st place — Tikka T3X Hunter 7MM Rem Mag' }]);
    assert.equal((await DB.prepare('SELECT status FROM raffle_photo_auto_imports WHERE photo_id=?').bind('900000000000001').first()).status, 'published');

    // The public website API serves them immediately (no cache), ordered 1st then 2nd.
    const pub = await (await publicMonth({ request: new Request(`https://example.test/api/raffle/month?month=${D.slice(0, 7)}`), locals: { runtime: { env: { DB } } } })).json();
    assert.deepEqual(pub.winners.filter(w => w.drawDate === D).map(w => [w.name, w.prize]),
        [['Jane Doe', '1st place — Tikka T3X Hunter 7MM Rem Mag'], ['Bob Smith', '2nd place — $100 gift certificate from Safe & Secure Firearms']]);

    // 2. Meta redelivers the same event, and the polling fallback sees the same post: no duplicate work or rows.
    assert.equal((await webhook([daily])).status, 200);
    await mf.getWorker('photos').then(w => w.scheduled({ scheduledTime: new Date(now.getTime() + 60000), cron: '*/2 * * * *' }));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(aiCalls, 2);
    assert.equal((await winners()).filter(w => w.drawDate === D).length, 2);

    // 3. Found only by polling (no webhook), first AI call fails → retried on a later tick → published once.
    const late = post(2, 'Bonus drawing winners #LakeHenryRaffle');
    aiRows.set(2, [row({ drawDate: D, position: 3, ticketNumber: '5', name: 'Cal Jones', town: 'Osseo', prize: 'Bonus knife' })]);
    await DB.prepare("INSERT INTO raffle_prize_supplements(id,raffle_key,draw_date,category,position,description,status) VALUES('bonus-test',?,?,'Other',3,'Bonus knife','approved')").bind(D.slice(0,7),D).run();
    failNextAi = true;
    // Cron ticks at the first poll-due minute at/after the offset, so the test does not depend on the time of day.
    const dueAt = offsetMs => { let at = new Date(Date.now() + offsetMs); while (!pollDue(at)) at = new Date(at.getTime() + 60000); return at; };
    const tick = async at => (await mf.getWorker('photos')).scheduled({ scheduledTime: at, cron: '*/2 * * * *' });
    const first = dueAt(0);
    await tick(first);
    await settle(`SELECT status FROM raffle_photo_auto_posts WHERE post_id=?`, 'retry', late);
    assert.equal((await DB.prepare(`SELECT source FROM raffle_photo_auto_posts WHERE post_id=?`).bind(late).first()).source, 'poll');
    assert.equal((await DB.prepare(`SELECT status FROM raffle_photo_auto_imports WHERE photo_id='900000000000002'`).first()).status, 'failed');
    await tick(new Date(first.getTime() + 5 * 60000));
    await settle(`SELECT status FROM raffle_photo_auto_posts WHERE post_id=?`, 'done', late);
    assert.equal((await winners()).filter(w => w.name === 'Cal Jones').length, 1);

    // 4. A conflicting announcement for the previous day changes nothing and is recorded for correction.
    const bad = post(3, 'Correction: yesterday’s winners #LakeHenryRaffle');
    aiRows.set(3, [row({ drawDate: prev, ticketNumber: '555', name: 'Someone Else', town: 'Hixton' })]);
    await webhook([bad]);
    await settle(`SELECT status FROM raffle_photo_auto_posts WHERE post_id=?`, 'done', bad);
    assert.equal((await DB.prepare(`SELECT status FROM raffle_photo_auto_imports WHERE photo_id='900000000000003'`).first()).status, 'rejected');
    assert.deepEqual((await winners()).filter(w => w.drawDate === prev).map(w => [w.name, w.prize]), [['Art Soborowicz', '1st place — Savage 110 High Country 30-06']]);

    // 5. Admin log shows reasons; admin can correct and delete auto-published winners afterwards.
    const log = await (await importsGet({ locals: { runtime: { env: { DB } } } })).json();
    const rejected = log.imports.find(i => i.photoId === '900000000000003');
    assert.equal(rejected.rows[0].outcome, 'rejected');
    assert.match(rejected.rows[0].reasons.join(), /already belongs to another winner/);
    const admin = body => winnersPost({ request: new Request('https://example.test/api/admin/raffle/winners', { method: 'POST', body: JSON.stringify(body) }), locals: { runtime: { env: { DB } } } });
    const bob = {...(await winners()).find(w=>w.name==='Bob Smith'),ticketNumberText:'77'};
    const idBob = `${D.slice(0, 7)}-${D}-77`;
    assert.equal((await admin({ action: 'update', id: idBob, expected: bob, winner: { ...bob, name: 'Robert Smith' } })).status, 200);
    assert.equal((await admin({ action: 'update', id: idBob, expected: bob, winner: { ...bob, name: 'Stale Edit' } })).status, 409); // Concurrent-edit guard.
    assert.equal((await admin({ action: 'update', id: idBob, expected: { ...bob, name: 'Robert Smith' }, winner: { ...bob, ticketNumber: 412 } })).status, 409); // Unique ticket/day.
    assert.equal((await admin({ action: 'delete', id: `${D.slice(0, 7)}-${D}-5` })).status, 200);
    assert.deepEqual((await winners()).filter(w => w.drawDate === D).map(w => w.name), ['Robert Smith', 'Jane Doe']);
    // A deleted auto winner is not resurrected by later redeliveries: its photo is final.
    await webhook([late]);
    await tick(new Date(first.getTime() + 10 * 60000));
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await winners()).filter(w => w.name === 'Cal Jones').length, 0);
    // Admin requeue of a post accepts only real post IDs/links.
    const queue = body => importsPost({ request: new Request('https://example.test/api/admin/raffle/photo-imports', { method: 'POST', body: JSON.stringify(body) }), locals: { runtime: { env: { DB } } } });
    assert.equal((await queue({ action: 'queue', source: 'https://www.facebook.com/photo/?fbid=1' })).status, 400);
    assert.equal((await queue({ action: 'queue', source: `https://www.facebook.com/61552199315213/posts/42` })).status, 200);
    assert.equal((await DB.prepare(`SELECT source FROM raffle_photo_auto_posts WHERE post_id=?`).bind(`${PAGE}_42`).first()).source, 'admin');
    // An untagged post is ignored by polling/webhooks but processed when an administrator queues it explicitly.
    const untagged = post(4, 'Tonight at the Legion');
    aiRows.set(4, [row({ drawDate: prev, position: 2, ticketNumber: '600', name: 'Dee Park', town: 'Arcadia', prize: 'Gift Card' })]);
    await webhook([untagged]);
    await settle(`SELECT status FROM raffle_photo_auto_posts WHERE post_id=?`, 'ignored', untagged);
    assert.equal((await queue({ action: 'queue', source: `https://www.facebook.com/61552199315213/posts/4` })).status, 200);
    await tick(new Date(first.getTime() + 15 * 60000));
    await settle(`SELECT status FROM raffle_photo_auto_posts WHERE post_id=?`, 'done', untagged);
    assert.equal((await winners()).filter(w => w.name === 'Dee Park').length, 1);
    // Every Graph request stayed on Page-owned objects.
    assert.ok(graphCalls.every(p => p.startsWith(PAGE) || /^90000000000000\d$/.test(p)));
});


test('actual November 3 image and both captured AI passes retain exact names, leading-zero ticket and unique category prizes',async t=>{
 const evidence=JSON.parse(await readFile(new URL('./fixtures/facebook-winners-2026-11-03.json',import.meta.url)));
 const {createHash}=await import('node:crypto');const image=await readFile(new URL('./fixtures/facebook-winners-2026-11-03.jpg',import.meta.url));
 assert.equal(createHash('sha256').update(image).digest('hex'),evidence.sha256);
 const schedule=await prizeSchedule(await database(t),'2026-11');const decision=decidePhoto(evidence.extractionPasses,[],schedule,'2026-11-03');
 // Historical model warnings now hold the image; retain its immutable field evidence separately.
 assert.equal(decision.status,'rejected');assert.match(decision.reasons.join(),/warnings/);
 const rows=evidence.extractionPasses[0].rows.filter(r=>r.drawDate==='2026-11-03');assert.deepEqual(rows.map(r=>[r.ticketNumber,r.name,r.town,r.position,matchPrize(r.prize,r.drawDate,schedule).description]),[
 ['392','Nate Berg','Brainerd, MN',null,'Tikka T3X Hunter 7MM Rem Mag'],['047','Kerry & Jeff Jacobson','Monona, WI',null,'$100 gift certificate from Safe & Secure Firearms']]);
 const duplicate=schedule.filter(p=>p.drawDate==='2026-11-03'&&p.category==='Gift card')[0];assert.equal(matchPrize('Gift Card','2026-11-03',[...schedule,{...duplicate,id:'another'}]).match,'unmatched');
});
