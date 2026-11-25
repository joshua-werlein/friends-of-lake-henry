import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { decidePhoto, matchPrize, chicagoDate, composePrize, writeDecision, printedName } from '../src/lib/server/raffle-photo-autopublish.ts';
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
    for (const name of ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '009_raffle_season_calendar.sql', '004_raffle_photo_autopublish.sql', '005_winner_ticket_text.sql', '006_bonus_winner_tickets.sql', '007_photo_import_diagnostics.sql']) {
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
    const twice = decide([dan, { ...dan, ticketNumber: '123' }], dan.drawDate);
    assert.deepEqual(twice.rows.filter(r => r.row.name).map(r => r.outcome), ['held', 'held']);
    // The approved gift card no cell accounts for is reported, not silently skipped.
    assert.deepEqual(twice.rows.filter(r => !r.row.name).map(r => [r.outcome, r.prizeSlotId]), [['held', `daily:${dan.drawDate}:0`]]);
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
    assert.deepEqual(d1.rows.filter(r => r.row.name).map(r => r.outcome), ['insert', 'held']);
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
    assert.deepEqual(decide([row(), row({ ticketNumber: '99', name: 'Other Person' })]).rows.filter(r => r.row.name).map(r => r.outcome), ['held', 'held']);
    // A row only one pass read is held; the row both passes agree on still publishes.
    const counts = decidePhoto([pass([row()]), pass([row(), row({ ticketNumber: '1', position: null })])], [], schedule, '2026-11-03');
    assert.equal(counts.status, 'partial');
    assert.deepEqual(counts.rows.filter(r => r.row.name).map(r => [r.row.ticketNumber, r.outcome]), [['412', 'insert'], ['1', 'held']]);
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

test('November 8: a lone ambiguous-layout remark is outvoted by an identical clean read; clipping, free text and disagreement still reject',async t=>{
 const schedule=await prizeSchedule(await database(t),'2026-11');
 const fixture=JSON.parse(await readFile(new URL('./fixtures/facebook-winners-2026-11-08.extraction.json',import.meta.url),'utf8'));
 const {extractionPasses:[clean,flagged]}=fixture;
 assert.deepEqual([clean.warnings.length,flagged.warnings.length,flagged.warnings[0].code],[0,1,'ambiguous-layout']);
 // Both real production reads: the second added blank-cell notes beside the same layout remark.
 for(const passes of [[clean,flagged],fixture.requeue.extractionPasses]){
  const today=decidePhoto(passes,[],schedule,'2026-11-08').rows.filter(r=>r.row.drawDate==='2026-11-08');
  assert.deepEqual(today.map(r=>[r.outcome,r.row.ticketNumber,r.row.name,r.row.town]),[['insert','619','Dale Schaub','Blair, WI'],['insert','291','Ryan Casper','Black River Falls, WI'],['insert','','John Kraemer','Neillsville, WI']]);
  assert.match(today[0].prize,/^1st place/);assert.match(today[1].prize,/^2nd place/);assert.match(today[2].prize,/^Bonus/);
 }
 // Row-level notes beside an outvoted layout remark are still judged: a blank-cell note the reads contradict holds that row.
 const contradicted=decidePhoto([clean,{...flagged,warnings:[...flagged.warnings,{scope:'cell',code:'blank-cell',drawDate:'2026-11-08',ticketNumber:'619',name:'Dale Schaub',field:'ticketNumber',message:'blank'}]}],[],schedule,'2026-11-08');
 assert.equal(contradicted.rows.find(r=>r.row.ticketNumber==='619').outcome,'held');
 // Order of passes does not matter.
 assert.notEqual(decidePhoto([flagged,clean],[],schedule,'2026-11-08').status,'rejected');
 const warn=w=>({...flagged,warnings:[{...flagged.warnings[0],...w}]});
 const rejected=passes=>assert.equal(decidePhoto(passes,[],schedule,'2026-11-08').status,'rejected');
 rejected([clean,warn({code:'clipped'})]);
 rejected([clean,warn({message:'The right column is cut off.'})]);
 rejected([clean,warn({message:'Some cells are blurry.'})]);
 rejected([clean,warn({scope:'row'})].map((p,i)=>i?{...p,warnings:[{...p.warnings[0],code:'uncertain-association'}]}:p));
 rejected([clean,{...flagged,warnings:['The layout of the table is ambiguous.']}]);
 rejected([clean,{...flagged,warnings:[...flagged.warnings,{...flagged.warnings[0],code:'missing-heading'}]}]);
 // A layout remark that is not outvoted no longer rejects the image, but with no stored winners to confirm the Firearm and Gift Card
 // columns nothing in them publishes. Only the bonus cell, dated by its own label and read identically, can; a changed row never does.
 const unconfirmed=(passes,changed)=>{
  const d=decidePhoto(passes,[],schedule,'2026-11-08');
  assert.notEqual(d.status,'published');
  // Only cells dated by their own bonus label (Nov 6 Cutting Board, Nov 7 Meat Bundle, Nov 8 Paddle Board) may publish here.
  assert.ok(d.rows.filter(r=>r.outcome==='insert').every(r=>r.row.readDate!==undefined&&r.prizeSlotId.startsWith('event-bonus:')));
  if(changed)assert.equal(d.rows.filter(r=>r.outcome==='insert'&&r.row.name===changed).length,0);
  return d;
 };
 const both=unconfirmed([warn({}),warn({})]);
 assert.deepEqual(both.rows.filter(r=>r.row.drawDate==='2026-11-08').map(r=>r.outcome),['held','held','insert']);
 unconfirmed([clean,{...flagged,rows:flagged.rows.map((r,i)=>i===16?{...r,town:'Blair'}:r)}]);
 unconfirmed([clean,{...flagged,rows:flagged.rows.map((r,i)=>i===17?{...r,cellText:'291 - Ryan Casper, Black River'}:r)}]);
 unconfirmed([clean,{...flagged,rows:flagged.rows.slice(0,-1)}],'John Kraemer');
});

// Production winners stored before the November 10 announcement (Nov 6–9), as the photo Worker loads them.
const storedBeforeNov10=[
 ['2026-11-2026-11-06-288','2026-11-06',288,'Troy Lindberg','Hixton, WI','1st place — Springfield Armory 1911 Emissary 9MM','event:2026-11-06-day-6-springfield-armory-1911-emissary-9mm'],
 ['2026-11-2026-11-06-681','2026-11-06',681,'Kent Johnson','Blair, WI','Bonus — Cutting Board, Cheese Board & Knife sponsored by Cutting Canteen','event-bonus:2026-11-06-day-6-springfield-armory-1911-emissary-9mm'],
 ['2026-11-2026-11-06-838','2026-11-06',838,'Lyle Schlomer','Osseo, WI','2nd place — $100 gift certificate from Safe & Secure Firearms','daily:2026-11-06:0'],
 ['2026-11-2026-11-07-338','2026-11-07',338,'Joe Rabuck','Augusta, WI','1st place — Winchester 1892 Carbine 357 Mag','event:2026-11-07-day-7-winchester-1892-carbine-357-mag'],
 ['2026-11-2026-11-07-375','2026-11-07',375,'Troy Gilson','Tomah, WI','2nd place — $100 gift certificate from Safe & Secure Firearms','daily:2026-11-07:0'],
 ['2026-11-2026-11-07-slot-event-bonus-2026-11-07-day-7-winchester-1892-carbine-357-mag','2026-11-07',null,'Gage Everson','Independence, WI','Bonus — Meat Bundle sponsored by Blair Meat Market','event-bonus:2026-11-07-day-7-winchester-1892-carbine-357-mag'],
 ['2026-11-2026-11-08-619','2026-11-08',619,'Dale Schaub','Blair, WI','1st place — Kimber Stainless II 1911 38 Super','event:2026-11-08-day-8-kimber-stainless-ii-1911-38-super'],
 ['2026-11-2026-11-08-291','2026-11-08',291,'Ryan Casper','Black River Falls, WI','2nd place — $100 gift certificate from Safe & Secure Firearms','daily:2026-11-08:0'],
 ['2026-11-2026-11-08-slot-event-bonus-2026-11-08-day-8-kimber-stainless-ii-1911-38-super','2026-11-08',null,'John Kraemer','Neillsville, WI','Bonus — Inflatable Paddle Board','event-bonus:2026-11-08-day-8-kimber-stainless-ii-1911-38-super'],
 ['2026-11-2026-11-09-873','2026-11-09',873,'Roxy Krause','Eau Claire, WI','1st place — Auto Ordnance M1 30 Carbine','event:2026-11-09-day-9-auto-ordnance-m1-30-carbine'],
 ['2026-11-2026-11-09-673','2026-11-09',673,'Al "Cowpie" Chikowski','Berlin, WI','2nd place — $100 gift certificate from Safe & Secure Firearms','daily:2026-11-09:0'],
].map(([id,drawDate,ticketNumber,name,town,prize,prizeSlotId])=>({id,drawDate,ticketNumber,name,town,prize,prizeSlotId}));

test('November 10: a cumulative month table publishes today\'s identical reads despite a lone layout remark and old-cell disagreement',async t=>{
 const schedule=await prizeSchedule(await database(t),'2026-11');
 const fixture=JSON.parse(await readFile(new URL('./fixtures/facebook-winners-2026-11-10.extraction.json',import.meta.url),'utf8'));
 const [clean,flagged]=fixture.extractionPasses;
 assert.deepEqual([clean.rows.length,flagged.rows.length,clean.warnings.length,flagged.warnings.map(w=>w.code)],[23,21,0,['ambiguous-layout']]);
 for(const passes of [[clean,flagged],[flagged,clean]]){
  const decision=decidePhoto(passes,storedBeforeNov10,schedule,'2026-11-10');
  assert.equal(decision.status,'published');
  const today=decision.rows.filter(r=>r.row.drawDate==='2026-11-10');
  assert.deepEqual(today.map(r=>[r.outcome,r.row.ticketNumber,r.row.name,r.row.town]),[['insert','368','Jared White','LaCrosse, WI'],['insert','105','Gary Gran','Osseo, WI']]);
  assert.match(today[0].prize,/^1st place — /);assert.match(today[1].prize,/^2nd place — \$100 gift certificate/);
  assert.deepEqual(today.map(r=>r.winnerId),['2026-11-2026-11-10-368','2026-11-2026-11-10-105']);
  // Nov 8–9 are inside the window and already stored: duplicates, never republished. Older cells cannot publish.
  for(const r of decision.rows.filter(r=>r.row.drawDate==='2026-11-08'||r.row.drawDate==='2026-11-09'))assert.equal(r.outcome,'duplicate',r.row.cellText);
  assert.ok(decision.rows.filter(r=>r.row.drawDate<'2026-11-08').every(r=>r.outcome==='outside-window'||r.outcome==='duplicate'));
  assert.equal(decision.rows.filter(r=>r.outcome==='insert').length,2);
 }
 // Re-processing after publication finds both winners stored and inserts nothing.
 const published=decidePhoto([clean,flagged],storedBeforeNov10,schedule,'2026-11-10').rows.filter(r=>r.outcome==='insert')
  .map(r=>({id:r.winnerId,drawDate:r.row.drawDate,ticketNumber:Number(r.row.ticketNumber),name:r.row.name,town:r.row.town,prize:r.prize,prizeSlotId:r.prizeSlotId}));
 const again=decidePhoto([clean,flagged],[...storedBeforeNov10,...published],schedule,'2026-11-10');
 assert.equal(again.rows.filter(r=>r.outcome==='insert').length,0);
 assert.deepEqual(again.rows.filter(r=>r.row.drawDate==='2026-11-10').map(r=>r.outcome),['duplicate','duplicate']);
 // Strictness is unchanged for every row that could publish. A layout remark that is not outvoted no longer rejects the image:
 // a disputed row is held, and an agreed row publishes only in a column whose dates the stored Nov 6–9 winners confirm in every pass.
 const today=(p,i)=>p.rows.map(r=>r.drawDate==='2026-11-10'&&r.ticketNumber==='105'?{...r,...i}:r);
 const rejected=passes=>assert.equal(decidePhoto(passes,storedBeforeNov10,schedule,'2026-11-10').status,'rejected');
 const only=(passes,inserted)=>{
  const d=decidePhoto(passes,storedBeforeNov10,schedule,'2026-11-10');
  assert.deepEqual(d.rows.filter(r=>r.outcome==='insert').map(r=>[r.row.drawDate,r.row.ticketNumber]),inserted.map(t=>['2026-11-10',t]));
  return d;
 };
 for(const v of [{town:'Osseo'},{drawDate:'2026-11-09'}])assert.equal(only([clean,{...flagged,rows:today(flagged,v)}],['368']).status,'partial');
 // A pass showing two Firearm winners for tonight confirms nothing about that column: neither is published.
 assert.equal(only([clean,{...flagged,rows:today(flagged,{prize:'Firearm'})}],[]).status,'held');
 only([clean,{...flagged,rows:flagged.rows.filter(r=>r.ticketNumber!=='105')}],['368']);
 const kraus=only([clean,{...flagged,rows:flagged.rows.map(r=>r.ticketNumber==='873'?{...r,name:'Roxy Kraus'}:r)}],['368','105']);
 assert.equal(kraus.rows.find(r=>r.row.ticketNumber==='873').outcome,'held');
 rejected([clean,{...flagged,warnings:[{...flagged.warnings[0],code:'clipped'}]}]);
 rejected([clean,{...flagged,warnings:[...flagged.warnings,{...flagged.warnings[0],code:'uncertain-association'}]}]);
 // Both passes remarking on the layout: the stored winners confirm both columns, so tonight's identical reads publish.
 assert.equal(only([flagged,{...flagged}],['368','105']).status,'published');
 // Without enough stored history (only Nov 9 stored) the remark stands and nothing publishes from those columns.
 const thin=decidePhoto([flagged,{...flagged}],storedBeforeNov10.filter(w=>w.drawDate==='2026-11-09'),schedule,'2026-11-10');
 assert.deepEqual(thin.rows.filter(r=>r.row.drawDate==='2026-11-10').map(r=>r.outcome),['held','held']);
 // The Nov 8 Paddle Board cell is dated by its own label, so it may publish; nothing from the unconfirmed columns does.
 assert.deepEqual(thin.rows.filter(r=>r.outcome==='insert').map(r=>[r.row.drawDate,r.row.name,r.prizeSlotId.split(':')[0]]),[['2026-11-08','John Kraemer','event-bonus']]);
 // A pass that moves a stored Firearm winner into the window is recognised against the stored record: nothing is written
 // for it and tonight's Firearm cell, in the column it proved misdated, is held. The Gift Card column is unaffected.
 const moved=decidePhoto([clean,{...flagged,rows:flagged.rows.map(r=>r.ticketNumber==='288'?{...r,drawDate:'2026-11-09'}:r)}],storedBeforeNov10,schedule,'2026-11-10');
 assert.deepEqual(moved.rows.filter(r=>r.row.drawDate==='2026-11-10').map(r=>[r.outcome,r.row.ticketNumber]),[['held','368'],['insert','105']]);
 assert.equal(moved.rows.find(r=>r.row.ticketNumber==='288'&&r.row.drawDate==='2026-11-09').outcome,'duplicate');
 // A pass that moves an unrecognised cell into the window: that cell is held, and the Firearm column it came from no longer
 // has a confirmed stored Nov 6 cell in that pass, so tonight's Firearm is held too. One that only misreads old cells does not matter.
 const lindgren=only([clean,{...flagged,rows:flagged.rows.map(r=>r.ticketNumber==='288'?{...r,drawDate:'2026-11-09',name:'Troy Lindgren'}:r)}],['105']);
 assert.equal(lindgren.rows.find(r=>r.row.name==='Troy Lindgren').outcome,'held');
 assert.equal(decidePhoto([clean,{...flagged,rows:flagged.rows.map(r=>r.ticketNumber==='288'?{...r,name:'Troy Lindburg'}:r)}],storedBeforeNov10,schedule,'2026-11-10').status,'published');
});

const storedBeforeNov11=[...storedBeforeNov10,
 ['2026-11-2026-11-10-105','2026-11-10',105,'Gary Gran','Osseo, WI','2nd place — $100 gift certificate from Safe & Secure Firearms','daily:2026-11-10:0'],
 ['2026-11-2026-11-10-368','2026-11-10',368,'Jared White','LaCrosse, WI','1st place — Bergara HMR 300 Win Mag','event:2026-11-10-day-10-bergara-hmr-300-win-mag'],
].map(w=>Array.isArray(w)?(([id,drawDate,ticketNumber,name,town,prize,prizeSlotId])=>({id,drawDate,ticketNumber,name,town,prize,prizeSlotId}))(w):w);

test('November 11: bonus cells misdated into the window are recognised from stored winners; tonight\'s Firearm and Gift Card cells publish',async t=>{
 const schedule=await prizeSchedule(await database(t),'2026-11');
 const fixture=JSON.parse(await readFile(new URL('./fixtures/facebook-winners-2026-11-11.extraction.json',import.meta.url),'utf8'));
 const [flagged,clean]=fixture.extractionPasses;
 assert.deepEqual([flagged.rows.length,clean.rows.length,flagged.warnings.map(w=>w.code),clean.warnings.length],[24,25,['ambiguous-layout'],0]);
 // The real reads: the clean pass puts the stored Nov 7 Meat Bundle and Nov 8 Paddle Board winners on Nov 9.
 assert.deepEqual(clean.rows.filter(r=>r.drawDate==='2026-11-09'&&!r.ticketNumber).map(r=>r.name),['Gage Everson','John Kraemer']);
 for(const passes of [[flagged,clean],[clean,flagged]]){
  const decision=decidePhoto(passes,storedBeforeNov11,schedule,'2026-11-11');
  assert.equal(decision.status,'published',JSON.stringify(decision.reasons));
  const inserted=decision.rows.filter(r=>r.outcome==='insert');
  assert.deepEqual(inserted.map(r=>[r.row.drawDate,r.row.ticketNumber,r.row.name,r.row.town,r.prize,r.winnerId]),[
   ['2026-11-11','698','Dennis McHenry','LaCrosse, WI','1st place — Savage 110 Long Range Hunter 338 Lapua Mag','2026-11-2026-11-11-698'],
   ['2026-11-11','566','John Kraemer','Neillsville, WI','2nd place — $100 gift certificate from Safe & Secure Firearms','2026-11-2026-11-11-566']]);
  // Each bonus cell's own label names one approved drawing, so it is dated by the calendar (Nov 6, 7, 8), outside tonight's window,
  // whichever row each pass placed it on. Nothing lands on Nov 9.
  const bonus=decision.rows.filter(r=>r.row.readDate!==undefined).map(r=>[r.row.name,r.row.drawDate,r.outcome]);
  assert.deepEqual(bonus.sort(),[['Gage Everson','2026-11-07','duplicate'],['John Kraemer','2026-11-08','duplicate'],['Kent Johnson','2026-11-06','duplicate']]);
  assert.equal(decision.rows.filter(r=>r.row.drawDate==='2026-11-09').length,2);
  assert.ok(decision.rows.filter(r=>r.row.drawDate<'2026-11-11').every(r=>r.outcome==='duplicate'||r.outcome==='outside-window'));
 }
 // Re-processing after publication inserts nothing.
 const published=decidePhoto([flagged,clean],storedBeforeNov11,schedule,'2026-11-11').rows.filter(r=>r.outcome==='insert')
  .map(r=>({id:r.winnerId,drawDate:r.row.drawDate,ticketNumber:Number(r.row.ticketNumber),name:r.row.name,town:r.row.town,prize:r.prize,prizeSlotId:r.prizeSlotId}));
 const again=decidePhoto([flagged,clean],[...storedBeforeNov11,...published],schedule,'2026-11-11');
 assert.equal(again.status,'duplicate');
 // Strictness is unchanged for anything that could publish.
 const tonight=(p,i,ticket='566')=>({...p,rows:p.rows.map(r=>r.drawDate==='2026-11-11'&&r.ticketNumber===ticket?{...r,...i}:r)});
 const rejected=passes=>assert.equal(decidePhoto(passes,storedBeforeNov11,schedule,'2026-11-11').status,'rejected');
 const only=(passes,inserted)=>{
  const d=decidePhoto(passes,storedBeforeNov11,schedule,'2026-11-11');
  assert.deepEqual(d.rows.filter(r=>r.outcome==='insert').map(r=>[r.row.drawDate,r.row.ticketNumber]),inserted.map(t=>['2026-11-11',t]));
  return d;
 };
 only([flagged,tonight(clean,{town:'Neillsville'})],['698']);
 only([flagged,tonight(clean,{drawDate:'2026-11-10'})],['698']);
 only([flagged,{...clean,rows:clean.rows.filter(r=>r.ticketNumber!=='698')}],['566']);
 rejected([flagged,{...clean,warnings:[{...flagged.warnings[0],code:'clipped'}]}]);
 assert.equal(only([flagged,{...flagged}],['698','566']).status,'published');
 // An unknown winner under a stored bonus label is dated to that past drawing by the calendar: it can never publish tonight.
 only([flagged,{...clean,rows:[...clean.rows,{...clean.rows.at(-1),ticketNumber:'',ticketStatus:'blank',name:'New Person',town:'Blair, WI',prize:'Paddle board',cellText:'Paddle board - New Person, Blair, WI'}]}],['698','566']);
 // A pass that shifts a whole column (stored Nov 10 Firearm read on Nov 11) holds that column, never publishes it on the wrong date.
 const shift=p=>({...p,rows:p.rows.filter(r=>r.ticketNumber!=='698').map(r=>r.ticketNumber==='368'?{...r,drawDate:'2026-11-11'}:r)});
 const shifted=decidePhoto([shift(flagged),shift(clean)],storedBeforeNov11,schedule,'2026-11-11');
 assert.equal(shifted.rows.filter(r=>r.outcome==='insert'&&r.row.ticketNumber==='368').length,0);
 assert.equal(shifted.rows.find(r=>r.row.ticketNumber==='368').outcome,'duplicate');
 // Every other Firearm read is fine there, but with the column misplaced a new Firearm cell tonight is held.
 const extra=p=>({...shift(p),rows:[...shift(p).rows,p.rows.find(r=>r.ticketNumber==='698')]});
 const held=decidePhoto([extra(flagged),extra(clean)],storedBeforeNov11,schedule,'2026-11-11');
 assert.equal(held.rows.find(r=>r.row.ticketNumber==='698').outcome,'held');
 assert.equal(held.rows.find(r=>r.row.ticketNumber==='566').outcome,'insert');
 // A genuine repeat winner keeps the old row at its stored date, so the new cell is not mistaken for a moved one.
 const repeat=p=>({...p,rows:p.rows.map(r=>r.ticketNumber==='566'?{...r,ticketNumber:'105',name:'Gary Gran',town:'Osseo, WI',cellText:'105 - Gary Gran, Osseo, WI'}:r)});
 const repeated=decidePhoto([repeat(flagged),repeat(clean)],storedBeforeNov11,schedule,'2026-11-11');
 assert.equal(repeated.rows.find(r=>r.row.drawDate==='2026-11-11'&&r.row.ticketNumber==='105').outcome,'insert');
});

test('November 9: the cumulative table publishes only the two new winners and never republishes stored history',async t=>{
 const schedule=await prizeSchedule(await database(t),'2026-11');
 const fixture=JSON.parse(await readFile(new URL('./fixtures/facebook-winners-2026-11-09.extraction.json',import.meta.url),'utf8'));
 const storedBefore=storedBeforeNov10.filter(w=>w.drawDate<'2026-11-09');
 const decision=decidePhoto(fixture.extractionPasses,storedBefore,schedule,'2026-11-09');
 const inserted=decision.rows.filter(r=>r.outcome==='insert');
 assert.deepEqual(inserted.map(r=>[r.row.drawDate,r.row.ticketNumber,r.row.name,r.row.town]),[['2026-11-09','873','Roxy Krause','Eau Claire, WI'],['2026-11-09','673','Al "Cowpie" Chikowski','Berlin, WI']]);
 assert.match(inserted[0].prize,/^1st place/);assert.match(inserted[1].prize,/^2nd place/);
 assert.ok(decision.rows.every(r=>r.outcome!=='insert'||r.row.drawDate==='2026-11-09'));
 const again=decidePhoto(fixture.extractionPasses,storedBeforeNov10,schedule,'2026-11-09');
 assert.equal(again.rows.filter(r=>r.outcome==='insert').length,0);
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
    // Graph backup discovery: 17:55-18:15 Central, November only (CST is UTC-6 after Nov 1 2026).
    assert.ok(!pollDue(new Date('2026-11-03T23:54:00Z')));  // 17:54 Central
    assert.ok(pollDue(new Date('2026-11-03T23:55:00Z')));   // 17:55 Central
    assert.ok(pollDue(new Date('2026-11-04T00:00:00Z')));   // 18:00 Central
    assert.ok(pollDue(new Date('2026-11-04T00:10:00Z')));   // 18:10 Central
    assert.ok(pollDue(new Date('2026-11-04T00:15:00Z')));   // 18:15 Central
    assert.ok(!pollDue(new Date('2026-11-04T00:16:00Z')));  // 18:16 Central
    assert.ok(!pollDue(new Date('2026-11-04T00:30:00Z')));  // 18:30 Central: no evening sweep
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
    assert.deepEqual(live.triggers.crons, ['50-59 23 * 11 *', '0-30 0 * 11,12 *']);
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
    // 1. Signed delivery → durably queued, no extraction in webhook background → the cron tick publishes two winners.
    const res = await webhook([daily]);
    assert.equal(res.status, 200);
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await DB.prepare('SELECT status FROM raffle_photo_auto_posts WHERE post_id=?').bind(daily).first()).status, 'queued');
    assert.equal(aiCalls, 0);
    // Two overlapping cron invocations (the next tick starts while this one still runs): exactly one claims the post.
    await mf.getWorker('photos').then(w => Promise.all([w.scheduled({ scheduledTime: now, cron: '*/2 * * * *' }), w.scheduled({ scheduledTime: new Date(now.getTime() + 1000), cron: '*/2 * * * *' })]));
    await settle(`SELECT status FROM raffle_photo_auto_posts WHERE post_id=?`, 'done', daily);
    // Two independent reads that had to agree. The month-wide hometown scan (once the month has dates before the reads' first date) is
    // only queued here: it runs in a later invocation that processes no post, so it never adds to this one's CPU or wall time.
    const { readDates } = await import('../workers/facebook-photos/reads.ts');
    const monthScan = readDates(D)[0] > D.slice(0, 8) + '01', perPost = monthScan ? 4 : 2;
    const scanRow = async () => (await DB.prepare(`SELECT reasons_json FROM raffle_photo_auto_rows WHERE photo_id='900000000000001' AND row_number=9000`).all()).results;
    const kinds = async () => JSON.parse((await DB.prepare('SELECT extraction_json FROM raffle_photo_auto_imports WHERE photo_id=?').bind('900000000000001').first()).extraction_json).map(r => r.read.kind);
    await new Promise(r => setTimeout(r, 300));
    // The overlapping invocation found no post to process; it may already have taken the queued scan. Either way it is one scan.
    assert.ok(aiCalls === 2 || aiCalls === perPost, String(aiCalls));
    assert.equal((await scanRow()).length, monthScan ? 1 : 0);
    // The post was finished by the window decision alone.
    assert.equal((await DB.prepare('SELECT publication_status FROM raffle_photo_auto_posts WHERE post_id=?').bind(daily).first()).publication_status, 'published');
    const published = (await winners()).filter(w => w.drawDate === D);
    assert.deepEqual(published, [
        { drawDate: D, ticketNumber: 77, name: 'Bob Smith', town: 'Taylor', prize: '2nd place — $100 gift certificate from Safe & Secure Firearms' },
        { drawDate: D, ticketNumber: 412, name: 'Jane Doe', town: 'Blair', prize: '1st place — Tikka T3X Hunter 7MM Rem Mag' }]);
    assert.equal((await DB.prepare('SELECT status FROM raffle_photo_auto_imports WHERE photo_id=?').bind('900000000000001').first()).status, 'published');

    // The public website API serves them immediately (no cache), ordered 1st then 2nd.
    const pub = await (await publicMonth({ request: new Request(`https://example.test/api/raffle/month?month=${D.slice(0, 7)}`), locals: { runtime: { env: { DB } } } })).json();
    assert.deepEqual(pub.winners.filter(w => w.drawDate === D).map(w => [w.name, w.prize]),
        [['Jane Doe', '1st place — Tikka T3X Hunter 7MM Rem Mag'], ['Bob Smith', '2nd place — $100 gift certificate from Safe & Secure Firearms']]);

    // 2. Meta redelivers the same event, and the polling fallback sees the same post: no duplicate work or rows. Two more overlapping idle
    // invocations: the queued scan is taken by exactly one of them (or was already taken above), and nothing is read again afterwards.
    assert.equal((await webhook([daily])).status, 200);
    await mf.getWorker('photos').then(w => Promise.all([w.scheduled({ scheduledTime: new Date(now.getTime() + 60000), cron: '*/2 * * * *' }),
        w.scheduled({ scheduledTime: new Date(now.getTime() + 61000), cron: '*/2 * * * *' })]));
    for (let i = 0; i < 100 && aiCalls < perPost; i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(aiCalls, perPost);
    await mf.getWorker('photos').then(w => w.scheduled({ scheduledTime: new Date(now.getTime() + 120000), cron: '*/2 * * * *' }));
    await new Promise(r => setTimeout(r, 300));
    assert.equal(aiCalls, perPost);
    assert.deepEqual(await kinds(), monthScan ? ['window', 'window', 'table', 'table'] : ['window', 'window']);
    const claims = await scanRow();
    assert.equal(claims.length, monthScan ? 1 : 0);
    if (monthScan) assert.match(claims[0].reasons_json, /month-wide hometown check: 2 cells read; 0 hometown\(s\) corrected; 0 new conflict\(s\) shown/);
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
    await tick(new Date(first.getTime() + 7 * 60000));
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
    await tick(new Date(first.getTime() + 12 * 60000));
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

test('Worker extraction: Images enlargement with fallback, anchored window reads, bounded whole-table fallback, quota classification, renewed lease', async t => {
    const DB = await database(t);
    const { readableImage, extractPasses, readDates, estimateNeurons, isQuotaExhausted, QuotaExhausted } = await import('../workers/facebook-photos/reads.ts');
    const { renewLease, claimPost, enqueuePost } = await import('../src/lib/server/raffle-photo-autopublish.ts');
    const { focusPrompt, FOCUS_SCHEMA } = await import('../workers/facebook-photos/focus.ts');
    const { winnerPrompt } = await import('../workers/facebook-live/photos.ts');
    const context = { postId: '144051422124740_9', photoId: '9', attempt: 1 };
    const jpeg = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
    // Enlarging: only below the read width, through the binding, and the original on any failure.
    let transforms = [];
    const images = result => ({ input: () => ({ transform: t => { transforms.push(t); return { output: async () => { if (result instanceof Error) throw result;
        return { response: () => new Response(result) }; } }; } }) });
    assert.deepEqual(await readableImage({ IMAGES: images(jpeg) }, new Uint8Array([1]), 'image/png', 958, context), { bytes: jpeg, mime: 'image/jpeg', enlarged: true });
    assert.deepEqual(transforms, [{ width: 1540, fit: 'contain' }]);
    for (const env of [{ IMAGES: images(Error('quota')) }, { IMAGES: images(new Uint8Array([1, 2, 3])) }, {}])
        assert.equal((await readableImage(env, new Uint8Array([9]), 'image/png', 958, context)).enlarged, false);
    transforms = [];
    assert.equal((await readableImage({ IMAGES: images(jpeg) }, new Uint8Array([9]), 'image/png', 1600, context)).enlarged, false);
    assert.equal(transforms.length, 0);
    // The focused prompt uses the same response schema and names only dates, never winners or prizes.
    assert.ok(winnerPrompt('2026-11', '2026-11-28', 0).includes(FOCUS_SCHEMA));
    assert.match(focusPrompt(['2026-11-26', '2026-11-27', '2026-11-28'], 0), /2026-11-26 \(printed like "Nov 26" or "11\/26"\).*2026-11-28/);
    // AI stub: a window read (recognised by its prompt) returns only the rows of the dates it names; a whole-table read returns every row.
    const row = (drawDate, name) => ({ drawDate, position: null, ticketNumber: '101', ticketStatus: 'readable', name, town: 'Blair, WI', townStatus: 'readable', prize: 'Firearm', notes: '', cellText: `101 - ${name}, Blair, WI` });
    const usage = { prompt_tokens: 3000, completion_tokens: 1800 };
    const run = (rows, { fail, reply } = {}) => { const calls = []; return { calls, AI: { async run(model, input) { const prompt = input.messages[0].content[0].text;
        const window = prompt.startsWith('This image is a raffle winner table'), asked = new Set(prompt.match(/\d{4}-\d{2}-\d{2}(?= \(printed)/g) ?? []);
        calls.push({ window, max: input.max_tokens, dates: [...asked] });
        if (fail && fail(window, calls.length)) throw fail.error ?? Error('ai-unavailable');
        if (reply) return reply(window);
        return { response: { containsWinners: true, rows: window ? rows.filter(r => asked.has(r.drawDate)) : rows, warnings: [] }, usage }; } } }; };
    await enqueuePost(DB, context.postId, 'webhook');
    assert.equal(await claimPost(DB, context.postId, new Date(), 600), true);
    // The window (Nov 26-28) and four anchor dates (Nov 22-25), read twice; the month's other rows are never transcribed.
    assert.deepEqual(readDates('2026-11-28'), ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28']);
    assert.deepEqual(readDates('2026-11-02'), ['2026-11-01', '2026-11-02']); // never before the month's first row
    const month = run([row('2026-11-01', 'Old Winner'), row('2026-11-24', 'Anchor Winner'), row('2026-11-28', 'New Winner')]);
    const reads = await extractPasses({ DB, ...month }, jpeg, 'image/jpeg', '2026-11-28', context);
    assert.deepEqual([reads.passes.length, reads.aiCalls, reads.reused, reads.fallback, month.calls.every(c => c.window && c.max === 6144 && c.dates.length === 7)], [2, 2, 0, null, true]);
    assert.deepEqual(reads.passes.map(p => p.rows.map(r => r.name)), [['Anchor Winner', 'New Winner'], ['Anchor Winner', 'New Winner']]);
    assert.deepEqual(reads.reads.map(r => [r.read.kind, r.read.pass, r.read.usage.estNeurons]), [['window', 0, estimateNeurons(3000, 1800)], ['window', 1, estimateNeurons(3000, 1800)]]);
    assert.ok(reads.passes.every(p => !('read' in p)));
    // A table without the requested dates (no printed dates) falls back once to the two whole-table reads.
    const undated = run([row('', 'New Winner')]);
    const tableReads = await extractPasses({ DB, ...undated }, jpeg, 'image/jpeg', '2026-11-28', context);
    assert.deepEqual([undated.calls.map(c => c.window), undated.calls.map(c => c.max), tableReads.fallback, tableReads.passes[0].rows.length], [[true, true, false, false], [6144, 6144, 16384, 16384], 'no-window-dates', 1]);
    // An unparseable (cut-off) window reply is not repeated: the whole-table reads decide instead.
    const cut = run([row('2026-11-28', 'New Winner')], { reply: window => window ? { response: '{"containsWinners":true,"rows":[{"cellText":"101 - New' } : { response: { containsWinners: true, rows: [row('2026-11-28', 'New Winner')], warnings: [] } } });
    const recovered = await extractPasses({ DB, ...cut }, jpeg, 'image/jpeg', '2026-11-28', context);
    assert.deepEqual([cut.calls.map(c => c.window), recovered.fallback, recovered.passes.length], [[true, false, false], 'unparseable', 2]);
    // A non-winner photo stops after one read.
    const notWinners = run([], { reply: () => ({ response: { containsWinners: false, rows: [], warnings: [] } }) });
    assert.deepEqual([(await extractPasses({ DB, ...notWinners }, jpeg, 'image/jpeg', '2026-11-28', context)).passes.length, notWinners.calls.length], [1, 1]);
    // Any other AI failure still fails the attempt (retried with backoff); a 4006 refusal is classified as quota exhaustion.
    await assert.rejects(extractPasses({ DB, ...run([], { fail: () => true }) }, jpeg, 'image/jpeg', '2026-11-28', context), e => !(e instanceof QuotaExhausted) && /ai-unavailable/.test(e.message));
    const refusal = Object.assign(() => true, { error: Error('4006: you have used up your daily free allocation of 10,000 neurons, please upgrade') });
    await assert.rejects(extractPasses({ DB, ...run([], { fail: refusal }) }, jpeg, 'image/jpeg', '2026-11-28', context), QuotaExhausted);
    assert.ok(isQuotaExhausted('4006:-you-have-used-up-your-daily-free-allocation-of-10-000-neurons-please-upgra') && !isQuotaExhausted('ai-unavailable') && !isQuotaExhausted('error 40060'));
    // Every read renews this run's lease; once another run has taken the post the old run stops before its next read.
    const lease = async () => (await DB.prepare(`SELECT locked_until FROM raffle_photo_auto_posts WHERE post_id=?`).bind(context.postId).first()).locked_until;
    const before = await lease();
    assert.equal(await renewLease(DB, context.postId, 1, new Date(Date.now() + 60000)), true);
    assert.ok(await lease() > before);
    await DB.prepare(`UPDATE raffle_photo_auto_posts SET locked_until=? WHERE post_id=?`).bind(new Date(Date.now() - 1000).toISOString(), context.postId).run();
    assert.equal(await claimPost(DB, context.postId, new Date(), 600), true); // attempt 2 takes over after the lease lapsed
    assert.equal(await renewLease(DB, context.postId, 1), false);
    await assert.rejects(extractPasses({ DB, ...run([row('2026-11-28', 'X')]) }, jpeg, 'image/jpeg', '2026-11-28', context), /lease-lost/);
});

test('AI quota: completed reads are checkpointed and reused, refusals give the attempt back and retry hourly and after the UTC reset', async t => {
    const DB = await database(t);
    const { extractPasses, storedReads } = await import('../workers/facebook-photos/reads.ts');
    const { claimPost, enqueuePost, failPost, nextQuotaAttempt, MAX_ATTEMPTS } = await import('../src/lib/server/raffle-photo-autopublish.ts');
    const { postSignal } = await import('../workers/facebook-photos/alerts.ts');
    const context = { postId: '144051422124740_7', photoId: '7', attempt: null };
    const jpeg = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
    const image = { sha256: 'a'.repeat(64), width: 958, height: 680 };
    const cellRow = { drawDate: '2026-11-12', position: null, ticketNumber: '377', ticketStatus: 'readable', name: 'Test Winner', town: 'Tomah, WI', townStatus: 'readable', prize: 'Firearm', notes: '', cellText: '377 - Test Winner, Tomah, WI' };
    const QUOTA = '4006: you have used up your daily free allocation of 10,000 neurons, please upgrade';
    const ai = refuseFrom => { const s = { calls: 0 }; s.AI = { async run() { if (++s.calls >= refuseFrom) throw Error(QUOTA); return { response: { containsWinners: true, rows: [cellRow], warnings: [] }, usage: { prompt_tokens: 2400, completion_tokens: 1700 } }; } }; return s; };
    // Pass 1 succeeds and pass 2 is refused: pass 1 is kept.
    const first = ai(2);
    await assert.rejects(extractPasses({ DB, AI: first.AI }, jpeg, 'image/jpeg', '2026-11-12', context, image, true), /4006/);
    assert.equal((await storedReads(DB, context.photoId, image.sha256)).length, 1);
    // The retry pays only for pass 2.
    const second = ai(Infinity);
    const done = await extractPasses({ DB, AI: second.AI }, jpeg, 'image/jpeg', '2026-11-12', context, image, true);
    assert.deepEqual([second.calls, done.aiCalls, done.reused, done.passes.length], [1, 1, 1, 2]);
    // Reuse needs the same image bytes, enlargement and prompt version.
    const other = ai(Infinity);
    await extractPasses({ DB, AI: other.AI }, jpeg, 'image/jpeg', '2026-11-12', { ...context, photoId: '8' }, { ...image, sha256: 'b'.repeat(64) }, true);
    assert.equal(other.calls, 2);
    const notEnlarged = ai(Infinity);
    await extractPasses({ DB, AI: notEnlarged.AI }, jpeg, 'image/jpeg', '2026-11-12', context, image, false);
    assert.equal(notEnlarged.calls, 2);
    await DB.prepare(`UPDATE raffle_photo_auto_imports SET extraction_json=? WHERE photo_id=?`)
        .bind(JSON.stringify((await storedReads(DB, context.photoId, image.sha256)).map(r => ({ ...r, read: { ...r.read, version: 'older-prompt' } }))), context.photoId).run();
    const newPrompt = ai(Infinity);
    await extractPasses({ DB, AI: newPrompt.AI }, jpeg, 'image/jpeg', '2026-11-12', context, image, false);
    assert.equal(newPrompt.calls, 2);
    // A decided photo is never reopened by stored reads.
    await DB.prepare(`UPDATE raffle_photo_auto_imports SET status='published' WHERE photo_id=?`).bind(context.photoId).run();
    assert.equal((await storedReads(DB, context.photoId, image.sha256)).length, 0);

    // Queue: Nov 12 at 00:06 UTC on Nov 13 (6:06 PM Central). A refusal leaves the attempt budget unchanged and retries within the hour.
    const postId = '144051422124740_122335449590073310', at = new Date('2026-11-13T00:06:49Z');
    const state = () => DB.prepare(`SELECT status, attempts, next_attempt_at AS next FROM raffle_photo_auto_posts WHERE post_id=?`).bind(postId).first();
    await enqueuePost(DB, postId, 'webhook');
    await DB.prepare(`UPDATE raffle_photo_auto_posts SET created_at=? WHERE post_id=?`).bind('2026-11-13T00:06:00.000Z', postId).run();
    for (let i = 0; i < MAX_ATTEMPTS + 4; i++) {
        const now = new Date(at.getTime() + i * 3600000);
        assert.equal(await claimPost(DB, postId, new Date(Math.max(now.getTime(), Date.parse((await state()).next))), 600), true);
        await failPost(DB, postId, '4006:-you-have-used-up-your-daily-free-allocation', 1, now, 0, false, true);
        const s = await state();
        assert.deepEqual([s.status, s.attempts], ['retry', 0], `refusal ${i + 1}`);
        assert.equal(s.next, nextQuotaAttempt(now).toISOString());
    }
    assert.equal(nextQuotaAttempt(new Date('2026-11-13T00:06:49Z')).toISOString(), '2026-11-13T01:06:49.000Z');
    assert.equal(nextQuotaAttempt(new Date('2026-11-13T23:40:00Z')).toISOString(), '2026-11-14T00:05:00.000Z'); // just after the reset
    // The owner is told it is the allocation and that retries continue.
    const waiting = postSignal({ post_id: postId, source: 'webhook', status: 'retry', attempts: 0, error_code: '4006:-you-have-used-up-your-daily-free-allocation', last_error_code: null,
        created_at: '2026-11-13T00:06:00.000Z' }, new Date('2026-11-13T00:40:00Z'));
    assert.match(waiting.title, /daily allocation used up/);
    // An ordinary failure afterwards still has its full backoff budget.
    assert.equal(await claimPost(DB, postId, new Date('2026-11-14T12:00:00Z'), 600), true);
    await failPost(DB, postId, 'ai-unavailable', 1, new Date('2026-11-14T12:00:00Z'));
    assert.equal((await state()).status, 'retry');
    // After 30 hours of refusals the post is parked as failed (and alerted) for an administrator.
    assert.equal(await claimPost(DB, postId, new Date('2026-11-14T12:05:00Z'), 600), true);
    await failPost(DB, postId, '4006:-you-have-used-up-your-daily-free-allocation', 2, new Date('2026-11-14T12:05:00Z'), 0, false, true);
    assert.equal((await state()).status, 'failed');
});

// Nov 16, 2026 (photo 122336394524073310): both passes read "797 -JJ Demaske, Melrose, WI" and agreed, but the printed-name check only
// recognised a dash spaced on both sides and held the row. Uneven spacing is accepted only after the extracted ticket's own digits.
test('printed-name parsing accepts uneven spacing after the ticket and keeps rejecting wrong names', () => {
    const fold = v => v.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9$]+/g, ' ').trim();
    const agrees = (cell, ticket, name) => { const p = printedName(cell, ticket); return p === undefined || fold(p) === fold(name); };
    const cases = [
        ['797 -JJ Demaske, Melrose, WI', '797', 'JJ Demaske', true],
        ['797-JJ Demaske, Melrose, WI', '797', 'JJ Demaske', true],
        ['797- JJ Demaske, Melrose, WI', '797', 'JJ Demaske', true],
        ['797 - JJ Demaske, Melrose, WI', '797', 'JJ Demaske', true],
        ['797 — JJ Demaske, Melrose, WI', '797', 'JJ Demaske', true],
        ['#797-JJ Demaske, Melrose, WI', '797', 'JJ Demaske', true],
        ['047 -Ann Lee, Blair, WI', '047', 'Ann Lee', true],
        ['797 -JJ Demaske, Melrose, WI', '797', 'JJ', false],
        ['797 -JJ Demaske, Melrose, WI', '797', 'Demaske', false],
        ['797 -JJ Demaske, Melrose, WI', '797', 'JJ Demaske Melrose', false],
        ['797 - Mary Smith-Jones, Blair, WI', '797', 'Mary Smith-Jones', true],
        ['797-Mary Smith-Jones, Blair, WI', '797', 'Mary Smith-Jones', true],
        ['797 -Smith-Jones, Blair, WI', '797', 'Smith-Jones', true],
        ['797 - Mary Smith-Jones, Blair, WI', '797', 'Jones', false],
        ['797-Smith-Jones, Blair, WI', '797', 'Jones', false],
        ['797 - Mary Smith-Jones, Blair, WI', '797', 'Mary Smith', false],
        ['442 - Winner 28G, Taylor, WI', '442', 'Winner', false],
        ['Life Jacket - JJ Demaske, Melrose, WI', '', 'JJ Demaske', true],
        ['Paddle board - New Person, Blair, WI', '', 'New Person', true],
        ['Life Jacket -JJ Demaske, Melrose, WI', '', 'JJ Demaske', false],
        ['798 -JJ Demaske, Melrose, WI', '797', 'JJ Demaske', false],
        ['1797-JJ Demaske, Melrose, WI', '797', 'JJ Demaske', false],
        // Edge cases: a colon is not a separator, and a ticket the model returned without its printed leading zero is not stripped.
        ['797: JJ Demaske, Melrose, WI', '797', 'JJ Demaske', false],
        ['047 -Ann Lee, Blair, WI', '47', 'Ann Lee', false],
    ];
    for (const [cell, ticket, name, want] of cases) assert.equal(agrees(cell, ticket, name), want, `${cell} / ${ticket} / ${name}`);
});

test('November 16 "797 -JJ Demaske" publishes; mismatches, neighbour contamination and stored winners do not', async t => {
    const DB = await database(t), schedule = await prizeSchedule(DB, '2026-11');
    const jj = row({ drawDate: '2026-11-16', position: null, ticketNumber: '797', ticketStatus: 'readable', name: 'JJ Demaske', town: 'Melrose, WI',
        townStatus: 'readable', prize: 'Firearm', cellText: '797 -JJ Demaske, Melrose, WI' });
    const decide = (r, existing = []) => decidePhoto([pass([r]), pass([structuredClone(r)])], existing, schedule, '2026-11-16').rows.find(d => d.row.ticketNumber === r.ticketNumber);
    const ok = decide(jj);
    assert.equal(ok.outcome, 'insert', ok.reasons.join('; '));
    assert.equal(ok.winnerId, '2026-11-2026-11-16-797');
    assert.match(ok.prize, /Colt Python/);
    for (const cellText of ['797-JJ Demaske, Melrose, WI', '797- JJ Demaske, Melrose, WI', '797 - JJ Demaske, Melrose, WI'])
        assert.equal(decide({ ...jj, cellText }).outcome, 'insert', cellText);
    // Hyphenated names with either spacing.
    assert.equal(decide({ ...jj, name: 'Mary Smith-Jones', cellText: '797-Mary Smith-Jones, Melrose, WI' }).outcome, 'insert');
    // A shortened, extended or different name is still held.
    for (const name of ['JJ', 'Demaske', 'JJ Demaske Melrose', 'Jj Demask'])
        assert.equal(decide({ ...jj, name }).outcome, 'held', name);
    assert.ok(decide({ ...jj, name: 'Demaske' }).reasons.includes('name differs from the name printed in the cell'));
    // The name or hometown of a neighbouring cell is not accepted.
    assert.equal(decide({ ...jj, cellText: '797 -JJ Demaske, Melrose, WI 798 - Other Person, Blair, WI', name: 'Other Person' }).outcome, 'held');
    assert.equal(decide({ ...jj, town: 'Blair, WI' }).outcome, 'held');
    // A ticket that is not the cell's own leading number is not stripped and the row is held.
    assert.equal(decide({ ...jj, cellText: '1797-JJ Demaske, Melrose, WI' }).outcome, 'held');
    // A label with uneven spacing stays in manual review, as before.
    assert.equal(decide({ ...jj, ticketNumber: '', ticketStatus: 'blank', prize: 'Gift Card', cellText: 'Gift Card -JJ Demaske, Melrose, WI' }).outcome !== 'insert', true);
    // Prize labels: the day's gift card read beside the firearm, both with uneven dash spacing, map to their own approved slots.
    const gift = { ...jj, ticketNumber: '798', name: 'Pat Doe', town: 'Blair, WI', prize: 'Gift Card', cellText: '798-Pat Doe, Blair, WI' };
    const both = decidePhoto([pass([jj, gift]), pass(structuredClone([jj, gift]))], [], schedule, '2026-11-16').rows;
    assert.deepEqual(both.filter(d => d.row.ticketNumber).map(d => [d.outcome, d.row.ticketNumber, /Colt Python/.test(d.prize) ? 'main' : /gift certificate/.test(d.prize) ? 'gift' : d.prize]),
        [['insert', '797', 'main'], ['insert', '798', 'gift']]);
    // A winner already entered manually (Nov 16 was corrected by hand) is a duplicate, never a second insert.
    const stored = { id: '2026-11-2026-11-16-797', drawDate: '2026-11-16', ticketNumber: 797, name: 'JJ Demaske', town: 'Melrose, WI', prize: ok.prize };
    assert.equal(decide(jj, [stored]).outcome, 'duplicate');
});
