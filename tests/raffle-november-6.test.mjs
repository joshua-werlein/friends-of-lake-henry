import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { decidePhoto, finishPost, failPost, claimPost, matchPrize, reconcileRows, reasonCode, requeuePost, rowDiagnostics, sanitizeCode, writeDecision } from '../src/lib/server/raffle-photo-autopublish.ts';
import { calendarPosition, matchApprovedSlot, prizeSchedule, supplementDraft } from '../src/lib/server/raffle-prizes.ts';
import { parseExtraction } from '../src/lib/raffle-photo-import.ts';
import { composeWinnerPrize, parseWinnerPrize, prizeCells, ticketLabel, ticketlessWinnerId } from '../src/lib/winner-prize.ts';
import { winnerPrompt } from '../workers/facebook-live/photos.ts';
import { completedDrawingDates } from '../src/pages/api/raffle/prizes.ts';
import { GET as adminWinners, POST as adminPost } from '../src/pages/api/admin/raffle/winners.ts';
import { POST as prizePost } from '../src/pages/api/admin/raffle/winner-prize.ts';
import { GET as publicMonth } from '../src/pages/api/raffle/month.ts';
import { GET as importsGet, POST as importsPost } from '../src/pages/api/admin/raffle/photo-imports.ts';

// tests/fixtures/facebook-winners-2026-11-06.jpg is the genuine corrected announcement, and the .json holds two passes
// captured from Workers AI on those bytes. Variations below are edits of that capture, labelled as such.
const capture = JSON.parse(await readFile(new URL('./fixtures/facebook-winners-2026-11-06.json', import.meta.url)));
const image = await readFile(new URL('./fixtures/facebook-winners-2026-11-06.jpg', import.meta.url));
const events = JSON.parse(await readFile(new URL('./fixtures/november-2026-published-raffle-events.json', import.meta.url))).events;
const DATE = '2026-11-06', MONTH = '2026-11';
const FIREARM = 'Springfield Armory 1911 Emissary 9MM', GIFT = '$100 gift certificate from Safe & Secure Firearms', CUTTING = 'Cutting Board, Cheese Board & Knife sponsored by Cutting Canteen';
const EVENT = '2026-11-06-day-6-springfield-armory-1911-emissary-9mm';
const SLOT = { main: `event:${EVENT}`, gift: `daily:${DATE}:0`, bonus: `event-bonus:${EVENT}` };
const PRIZE = { troy: `1st place — ${FIREARM}`, lyle: `2nd place — ${GIFT}`, kent: `Bonus — ${CUTTING}` };
const passes = () => structuredClone(capture.extractionPasses);
const named = (rows, name) => rows.find(r => r.row.name === name);
const today = rows => rows.filter(r => r.row.drawDate === DATE);
const cell = (list, name) => list.map(p => p.rows.find(r => r.name === name)).filter(Boolean);
const edit = (change, list = passes()) => { change(list); return list; };
const MIGRATIONS = ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '004_raffle_photo_autopublish.sql',
    '005_winner_ticket_text.sql', '006_bonus_winner_tickets.sql', '007_photo_import_diagnostics.sql'];
async function apply(DB) {
    for (const name of MIGRATIONS) {
        const sql = (await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');
        for (const statement of sql.split(';').filter(v => v.trim())) await DB.prepare(statement).run();
    }
    for (const e of events) await DB.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id, e.title, e.kind, e.status, e.date_start, e.summary).run();
}
async function database(t) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    await apply(DB);
    return DB;
}
const insert = (DB, id, date, ticket, label, name, town, prize, slot = null) => DB.prepare(`INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,ticket_number_text,winner_name,town,prize,prize_slot_id) VALUES(?,?,?,?,?,?,?,?,?)`)
    .bind(id, date.slice(0, 7), date, ticket, label, name, town, prize, slot).run();
// The state production reports today: Troy correct, Kent wrongly 2nd with 681, Lyle missing. Older in-window winners exactly as stored.
const KENT_ID = `${MONTH}-${DATE}-681`, LYLE_ID = ticketlessWinnerId(DATE, SLOT.gift);
async function seedProduction(DB, { kentTown = 'Blair, Wi' } = {}) {
    await insert(DB, `${MONTH}-2026-11-04-226`, '2026-11-04', 226, null, 'Jim Wilber', '', '1st place — Firearm: Henry Big Boy All Weather 44 Mag');
    await insert(DB, `${MONTH}-2026-11-04-362`, '2026-11-04', 362, null, 'Rob Stanton', 'Dakota, MN', '2nd place — Gift card: $100 gift certificate from Safe & Secure Firearms');
    await insert(DB, `${MONTH}-2026-11-05-789`, '2026-11-05', 789, '789', 'Dan Heffner', 'LaCrosse, WI', '1st place — Bergara HMR 6.5 Creedmoor');
    await insert(DB, `${MONTH}-2026-11-05-50`, '2026-11-05', 50, '050', 'Brent Janzen', 'Blair, WI', '2nd place — $100 gift certificate from Safe & Secure Firearms');
    await insert(DB, `${MONTH}-${DATE}-288`, DATE, 288, '288', 'Troy Lindberg', 'Hixton, WI', PRIZE.troy, SLOT.main);
    await insert(DB, KENT_ID, DATE, 681, '681', 'Kent Johnson', kentTown, PRIZE.lyle, SLOT.gift);
}
const stored = DB => DB.prepare('SELECT id, draw_date AS drawDate, ticket_number AS ticketNumber, ticket_number_text AS label, winner_name AS name, town, prize, prize_slot_id AS prizeSlotId FROM raffle_winners ORDER BY draw_date, id').all().then(r => r.results);
const onDay = async DB => (await stored(DB)).filter(r => r.drawDate === DATE);
const photo = (id = capture.photoId) => ({ photoId: id, postId: capture.postId, sha256: capture.sha256, width: null, height: null, model: capture.model, passes: [] });
const decide = async (DB, list = passes(), extra) => decidePhoto(list, await stored(DB), await prizeSchedule(DB, MONTH), DATE, extra);
const ctx = (DB, url, body) => ({ locals: { runtime: { env: { DB } } }, request: new Request(url, body ? { method: 'POST', body: JSON.stringify(body) } : undefined) });
const WINNERS = 'https://example.test/api/admin/raffle/winners';
const admin = (DB, body) => adminPost(ctx(DB, WINNERS, body));
const list = async DB => (await (await adminWinners(ctx(DB, `${WINNERS}?raffleKey=${MONTH}`))).json()).winners.filter(w => w.drawDate === DATE);
const manualLyle = { drawDate: DATE, ticketNumber: '', name: 'Lyle Schlomer', town: 'Osseo, WI', prize: PRIZE.lyle, ticketMissingVerified: true };
const correctKent = async (DB, ticketNumber = '') => {
    const kent = (await list(DB)).find(w => w.id === KENT_ID);
    return admin(DB, { action: 'update', id: KENT_ID, expected: kent, winner: { drawDate: DATE, ticketNumber, name: 'Kent Johnson', town: 'Blair, Wi', prize: PRIZE.kent, ticketMissingVerified: ticketNumber === '' } });
};

test('the genuine image and captured passes are the fixture they claim to be', () => {
    assert.equal(createHash('sha256').update(image).digest('hex'), capture.sha256);
    assert.equal(capture.extractionPasses.length, 2);
    assert.match(capture.model, /mistral-small-3\.1/);
    for (const pass of capture.extractionPasses) {
        assert.deepEqual(pass.warnings, []);
        assert.equal(pass.rows.length, 13); // Six days of Firearm and Gift Card, plus the one Cutting Board cell.
        assert.deepEqual(pass.rows.filter(r => r.drawDate === DATE).map(r => [r.cellText, r.ticketNumber, r.name, r.town, r.prize]), [
            ['288 - Troy Lindberg, Hixton, WI', '288', 'Troy Lindberg', 'Hixton, WI', 'Firearm'],
            ['Lyle Schlomer, Osseo, WI', '', 'Lyle Schlomer', 'Osseo, WI', 'Gift Card'],
            ['Cutting Board - Kent Johnson, Blair, Wi', '', 'Kent Johnson', 'Blair, Wi', 'Cutting Board']]);
    }
});

test('corrected announcement: Troy 1st with 288, Lyle 2nd and Kent Bonus with no ticket, from the real capture', async t => {
    const DB = await database(t);
    const decision = await decide(DB);
    assert.deepEqual(today(decision.rows).map(r => [r.row.name, r.outcome, r.row.ticketNumber, r.prize, r.prizeSlotId]), [
        ['Troy Lindberg', 'insert', '288', PRIZE.troy, SLOT.main],
        ['Lyle Schlomer', 'insert', '', PRIZE.lyle, SLOT.gift],
        ['Kent Johnson', 'insert', '', PRIZE.kent, SLOT.bonus]]);
    // The shortened label keeps the complete calendar description for display.
    assert.deepEqual(matchPrize('Cutting Board', DATE, await prizeSchedule(DB, MONTH)), { description: CUTTING, match: 'scheduled' });
    await writeDecision(DB, photo(), decision, true);
    const rows = await onDay(DB);
    assert.deepEqual(rows.map(r => [r.name, r.ticketNumber, r.label, r.town, r.prizeSlotId]).sort(), [
        ['Kent Johnson', null, null, 'Blair, Wi', SLOT.bonus],
        ['Lyle Schlomer', null, null, 'Osseo, WI', SLOT.gift],
        ['Troy Lindberg', 288, '288', 'Hixton, WI', SLOT.main]]);
    // Both public and admin readers present all three correctly; a missing ticket is never 0 or null.
    const pub = await (await publicMonth(ctx(DB, `https://example.test/api/raffle/month?month=${MONTH}`))).json();
    assert.deepEqual(pub.winners.filter(w => w.drawDate === DATE).map(w => [w.name, ticketLabel(w.ticketNumberText ?? w.ticketNumber), prizeCells(w.prize).place, prizeCells(w.prize).prize, w.town]), [
        ['Troy Lindberg', '288', '1st', FIREARM, 'Hixton, WI'],
        ['Lyle Schlomer', 'Not published', '2nd', GIFT, 'Osseo, WI'],
        ['Kent Johnson', 'Not published', '3rd', CUTTING, 'Blair, Wi']]);
    assert.deepEqual((await list(DB)).map(w => w.name), ['Troy Lindberg', 'Lyle Schlomer', 'Kent Johnson']);
    const prizes = await DB.prepare('SELECT draw_date AS drawDate, prize FROM raffle_winners WHERE raffle_key=?').bind(MONTH).all();
    assert.ok(completedDrawingDates(await prizeSchedule(DB, MONTH), prizes.results).includes(DATE));
    for (const value of [null, '', 0, '0', '000', undefined]) assert.equal(ticketLabel(value), 'Not published', String(value));
    assert.equal(ticketLabel('047'), '047');
    assert.equal(ticketLabel(681), '681');
});

test('the revised prompt still reads the genuine two-column November 3 and 4 images', async t => {
    const schedule = await prizeSchedule(await database(t), MONTH);
    for (const [day, expected] of [['03', [['392', 'Nate Berg', 'Brainerd, MN', '1st place — Tikka T3X Hunter 7MM Rem Mag'], ['047', 'Kerry & Jeff Jacobson', 'Monona, WI', `2nd place — ${GIFT}`]]],
        ['04', [['226', 'Jim Wilber', '', '1st place — Henry Big Boy All Weather 44 Mag'], ['362', 'Rob Stanton', 'Dakota, MN', `2nd place — ${GIFT}`]]]]) {
        const fixture = JSON.parse(await readFile(new URL(`./fixtures/facebook-winners-2026-11-${day}.cell-vision.json`, import.meta.url)));
        assert.equal(createHash('sha256').update(await readFile(new URL(`./fixtures/facebook-winners-2026-11-${day}.jpg`, import.meta.url))).digest('hex'), fixture.sha256);
        const rows = decidePhoto(fixture.extractionPasses, [], schedule, `2026-11-${day}`).rows.filter(r => r.row.drawDate === `2026-11-${day}`);
        assert.deepEqual(rows.map(r => [r.row.ticketNumber, r.row.name, r.row.town, r.prize]), expected);
        assert.ok(rows.every(r => r.outcome === 'insert'));
    }
});

test('the existing wrong Kent record is a conflict from the real capture, never accepted or duplicated', async t => {
    const DB = await database(t);
    await seedProduction(DB);
    const before = await stored(DB);
    const decision = await decide(DB);
    const row = name => named(decision.rows, name);
    assert.equal(row('Troy Lindberg').outcome, 'duplicate');
    assert.equal(row('Kent Johnson').outcome, 'rejected');
    assert.match(row('Kent Johnson').reasons.join(), new RegExp(`prize slot: stored ${SLOT.gift}, announcement ${SLOT.bonus}`));
    assert.equal(row('Lyle Schlomer').outcome, 'rejected'); // Kent still holds the gift card slot.
    assert.match(row('Lyle Schlomer').reasons.join(), /2nd place for 2026-11-06 already belongs/);
    for (const name of ['Jim Wilber', 'Rob Stanton', 'Dan Heffner', 'Brent Janzen']) assert.equal(row(name).outcome, 'duplicate', name);
    for (const name of ['Tim Hartley', 'Troy Zigler', 'Art Soborowicz', 'Amos Carvalho', 'Nate Berg', 'Kerry & Jeff Jacobson']) assert.equal(row(name).outcome, 'outside-window', name);
    assert.equal(await writeDecision(DB, photo(), decision, true), 'rejected');
    assert.deepEqual(await stored(DB), before);
    // A stored row with no slot (not yet backfilled) resolves from its description, with the same result.
    await DB.prepare('UPDATE raffle_winners SET prize_slot_id=NULL WHERE id=?').bind(KENT_ID).run();
    assert.equal(named((await decide(DB)).rows, 'Kent Johnson').outcome, 'rejected');
    // A hometown difference is also a conflict, not a duplicate.
    const other = await database(t);
    await seedProduction(other, { kentTown: 'Blair' });
    assert.match(named((await decide(other)).rows, 'Kent Johnson').reasons.join(), /conflicts with existing winner \(town\)/);
});

test('safe correction keeps Kent\'s ID, moves him to Bonus and keeps ticket 681 as evidence; Lyle never receives it', async t => {
    const DB = await database(t);
    await seedProduction(DB);
    const first = await DB.prepare('SELECT created_at, rowid AS rid FROM raffle_winners WHERE id=?').bind(KENT_ID).first();
    // Lyle cannot take the gift card while Kent still holds it.
    assert.equal((await admin(DB, manualLyle)).status, 409);
    assert.equal((await onDay(DB)).length, 2);
    // Clearing the ticket needs explicit confirmation, and a Bonus description cannot stay labelled 2nd.
    const kent = (await list(DB)).find(w => w.id === KENT_ID);
    assert.equal((await admin(DB, { action: 'update', id: KENT_ID, expected: kent, winner: { drawDate: DATE, ticketNumber: '', name: 'Kent Johnson', town: 'Blair, Wi', prize: PRIZE.kent } })).status, 400);
    assert.equal((await admin(DB, { action: 'update', id: KENT_ID, expected: kent, winner: { drawDate: DATE, ticketNumber: '681', name: 'Kent Johnson', town: 'Blair, Wi', prize: `2nd place — ${CUTTING}` } })).status, 400);
    assert.equal((await correctKent(DB)).status, 200);
    const after = (await onDay(DB)).find(r => r.name === 'Kent Johnson');
    assert.deepEqual([after.id, after.ticketNumber, after.label, after.prize, after.prizeSlotId], [KENT_ID, null, null, PRIZE.kent, SLOT.bonus]);
    assert.deepEqual(await DB.prepare('SELECT created_at, rowid AS rid FROM raffle_winners WHERE id=?').bind(KENT_ID).first(), first);
    // The previously published assignment survives in the correction log.
    const log = await DB.prepare(`SELECT action, before_json AS b, after_json AS a FROM raffle_winner_corrections WHERE winner_id=?`).bind(KENT_ID).first();
    assert.equal(log.action, 'update');
    assert.deepEqual([JSON.parse(log.b).ticket_number, JSON.parse(log.b).ticket_number_text, JSON.parse(log.b).prize], [681, '681', PRIZE.lyle]);
    assert.equal(JSON.parse(log.a).ticketNumber, null);
    // Now Lyle can be added, with no ticket and no transfer of 681.
    assert.equal((await admin(DB, manualLyle)).status, 200);
    const lyle = (await onDay(DB)).find(r => r.name === 'Lyle Schlomer');
    assert.deepEqual([lyle.id, lyle.ticketNumber, lyle.label, lyle.prizeSlotId], [LYLE_ID, null, null, SLOT.gift]);
    // The corrected announcement now matches everything stored, and writes nothing.
    const replay = await decide(DB);
    assert.deepEqual(today(replay.rows).map(r => r.outcome), ['duplicate', 'duplicate', 'duplicate']);
    const settled = await stored(DB);
    assert.equal(await writeDecision(DB, photo(), replay, true), 'duplicate');
    assert.deepEqual(await stored(DB), settled);
    // The owner may instead confirm 681 remains Kent's: same ID, Bonus slot, label kept, and replay still agrees.
    const keep = await database(t);
    await seedProduction(keep);
    assert.equal((await correctKent(keep, '681')).status, 200);
    const kept = (await onDay(keep)).find(r => r.name === 'Kent Johnson');
    assert.deepEqual([kept.id, kept.ticketNumber, kept.label, kept.prizeSlotId], [KENT_ID, 681, '681', SLOT.bonus]);
    assert.equal(named((await decide(keep)).rows, 'Kent Johnson').outcome, 'duplicate');
});

test('owner-confirmed corrections preserve winner IDs and verified tickets through announcement replay', async t => {
    const DB = await database(t);
    await seedProduction(DB, { kentTown: 'Blair, WI' });
    const before = await stored(DB);
    const jimId = `${MONTH}-2026-11-04-226`;
    const jim = (await (await adminWinners(ctx(DB, `${WINNERS}?raffleKey=${MONTH}`))).json()).winners.find(w => w.id === jimId);
    const lyle = { ...manualLyle, ticketNumber: '838', ticketMissingVerified: false };
    assert.equal((await admin(DB, lyle)).status, 409);
    assert.equal((await correctKent(DB, '681')).status, 200);
    assert.equal((await admin(DB, lyle)).status, 200);
    assert.equal((await admin(DB, lyle)).status, 409);
    assert.equal((await admin(DB, { action: 'update', id: jimId, expected: jim,
        winner: { ...jim, ticketNumber: '226', town: 'Galesville, WI' } })).status, 200);

    const pub = await (await publicMonth(ctx(DB, `https://example.test/api/raffle/month?month=${MONTH}`))).json();
    assert.deepEqual(pub.winners.filter(w => w.drawDate === DATE).map(w =>
        [w.id, w.name, w.ticketNumber, w.ticketNumberText, prizeCells(w.prize).place, prizeCells(w.prize).prize]), [
        [`${MONTH}-${DATE}-288`, 'Troy Lindberg', 288, '288', '1st', FIREARM],
        [`${MONTH}-${DATE}-838`, 'Lyle Schlomer', 838, '838', '2nd', GIFT],
        [KENT_ID, 'Kent Johnson', 681, '681', '3rd', CUTTING],
    ]);
    const jimAfter = pub.winners.find(w => w.id === jimId);
    assert.deepEqual([jimAfter.name, jimAfter.town, jimAfter.ticketNumber, jimAfter.ticketNumberText, jimAfter.prize],
        [jim.name, 'Galesville, WI', 226, '226', jim.prize]);
    const settled = await stored(DB);
    const expectedUnchanged = before.filter(w => w.id !== KENT_ID && w.id !== jimId);
    assert.deepEqual(settled.filter(w => expectedUnchanged.some(original => original.id === w.id)), expectedUnchanged);
    for (const photoId of ['10001', '10002']) {
        const replay = await decide(DB);
        assert.deepEqual(today(replay.rows).map(r => r.outcome), ['duplicate', 'duplicate', 'duplicate']);
        assert.ok(!replay.rows.some(r => r.outcome === 'insert'));
        await writeDecision(DB, photo(photoId), replay, true);
        assert.deepEqual(await stored(DB), settled);
    }
});

test('the superseded announcement can never reintroduce the old assignment', async t => {
    const DB = await database(t);
    await seedProduction(DB);
    await correctKent(DB);
    await admin(DB, manualLyle);
    const before = await stored(DB);
    // Edit of the real capture, reproducing the earlier table: Kent 681 on the gift card and Lyle on the cutting board.
    const old = edit(l => { for (const p of l) { const [ly, ke] = [p.rows.find(r => r.name === 'Lyle Schlomer'), p.rows.find(r => r.name === 'Kent Johnson')];
        Object.assign(ke, { ticketNumber: '681', ticketStatus: 'readable', prize: 'Gift Card', cellText: '681 - Kent Johnson, Blair, Wi' }); Object.assign(ly, { prize: 'Cutting Board', cellText: 'Cutting Board - Lyle Schlomer, Osseo, WI' }); } });
    const decision = await decide(DB, old);
    assert.equal(named(decision.rows, 'Lyle Schlomer').outcome, 'rejected');
    assert.equal(named(decision.rows, 'Kent Johnson').outcome, 'held');
    assert.ok(!decision.rows.some(r => r.outcome === 'insert'));
    await writeDecision(DB, photo('superseded'), decision, true);
    assert.deepEqual(await stored(DB), before);
});

test('two passes disagreeing on who holds a column hold those records rather than guessing', async t => {
    const schedule = await prizeSchedule(await database(t), MONTH);
    const swapped = edit(l => { const [ly, ke] = [l[1].rows.find(r => r.name === 'Lyle Schlomer'), l[1].rows.find(r => r.name === 'Kent Johnson')];
        Object.assign(ly, { prize: 'Cutting Board', cellText: 'Cutting Board - Lyle Schlomer, Osseo, WI' }); Object.assign(ke, { prize: 'Gift Card', cellText: 'Kent Johnson, Blair, Wi' }); });
    const decision = decidePhoto(swapped, [], schedule, DATE);
    for (const name of ['Lyle Schlomer', 'Kent Johnson']) {
        assert.equal(named(decision.rows, name).outcome, 'held', name);
        assert.match(named(decision.rows, name).reasons.join(), /disagree on prize/);
    }
    assert.equal(named(decision.rows, 'Troy Lindberg').outcome, 'insert');
    // A person missing from one pass's fourth column, or an unsplit cell, is held.
    const missing = edit(l => { l[1].rows = l[1].rows.filter(r => r.name !== 'Kent Johnson'); });
    assert.equal(named(decidePhoto(missing, [], schedule, DATE).rows, 'Kent Johnson').outcome, 'held');
    const unsplit = edit(l => { for (const r of cell(l, 'Kent Johnson')) Object.assign(r, { name: 'Cutting Board - Kent Johnson', prize: '' }); });
    assert.notEqual(named(decidePhoto(unsplit, [], schedule, DATE).rows, 'Cutting Board - Kent Johnson').outcome, 'insert');
});

test('optional Bonus column: headings, aliases and two-column days', async t => {
    const DB = await database(t), schedule = await prizeSchedule(DB, MONTH);
    const withLabel = (label, name = 'Kent Johnson') => edit(l => { for (const r of cell(l, name)) r.prize = label; });
    for (const label of ['Cutting Board', 'cutting board', 'CUTTING BOARD.', 'Cheese Board', 'Bonus', 'Bonus Drawing', '2nd Drawing', CUTTING])
        assert.equal(named(decidePhoto(withLabel(label), [], schedule, DATE).rows, 'Kent Johnson').prize, PRIZE.kent, label);
    // Unrelated, one-word or absent labels never reach a slot.
    for (const label of ['Cutting', 'Board', 'Paddle Board', 'Mystery Prize', ''])
        assert.equal(named(decidePhoto(withLabel(label), [], schedule, DATE).rows, 'Kent Johnson').outcome, 'held', label);
    // A Bonus label on a day with no bonus drawing is held; another day's prize never applies.
    const otherDay = edit(l => { for (const p of l) for (const r of p.rows) if (r.drawDate === DATE) r.drawDate = '2026-11-05'; });
    assert.notEqual(named(decidePhoto(otherDay, [], schedule, '2026-11-05').rows, 'Kent Johnson').outcome, 'insert');
    // Two-column announcements keep working: 1st and 2nd come from the calendar without a bonus entry.
    const twoColumn = edit(l => { for (const p of l) p.rows = p.rows.filter(r => r.name !== 'Kent Johnson'); });
    const noBonus = schedule.filter(p => !(p.drawDate === DATE && p.category === 'Bonus drawing'));
    assert.deepEqual(today(decidePhoto(twoColumn, [], noBonus, DATE).rows).map(r => [r.row.name, r.prize]), [['Troy Lindberg', PRIZE.troy], ['Lyle Schlomer', PRIZE.lyle]]);
    assert.equal(named(decidePhoto(passes(), [], noBonus, DATE).rows, 'Kent Johnson').outcome, 'held');
    // The prompt tells the model about headingless columns and raw cells.
    for (const pass of [0, 1]) { const prompt = winnerPrompt(MONTH, DATE, pass); assert.match(prompt, /may have no heading/); assert.match(prompt, /Cutting Board - Kent Johnson/); assert.match(prompt, /cellText/); }
});

test('multiple distinct Bonus drawings each get their own slot; ambiguous labels hold', async t => {
    const DB = await database(t);
    await DB.prepare(`UPDATE events SET summary=? WHERE id=?`).bind('2nd drawing: Cutting Board, Cheese Board & Knife sponsored by Cutting Canteen\n3rd drawing: Inflatable Paddle Board', EVENT).run();
    const schedule = await prizeSchedule(DB, MONTH);
    const bonus = schedule.filter(p => p.drawDate === DATE && p.category === 'Bonus drawing');
    assert.deepEqual(bonus.map(p => [p.id, p.description]), [[SLOT.bonus, CUTTING], [`${SLOT.bonus}:2`, 'Inflatable Paddle Board']]);
    assert.ok(bonus.every(p => calendarPosition(p, schedule) === 'Bonus'));
    const second = { drawDate: DATE, position: null, ticketNumber: '', ticketStatus: 'blank', name: 'Second Bonus', town: 'Blair, Wi', townStatus: 'readable', notes: '', prize: 'Paddle Board', cellText: 'Paddle Board - Second Bonus, Blair, Wi' };
    const both = edit(l => { for (const p of l) p.rows.push({ ...second }); });
    const decision = decidePhoto(both, [], schedule, DATE);
    assert.deepEqual([named(decision.rows, 'Kent Johnson').prizeSlotId, named(decision.rows, 'Second Bonus').prizeSlotId], [SLOT.bonus, `${SLOT.bonus}:2`]);
    assert.ok(today(decision.rows).every(r => r.outcome === 'insert'));
    const explicitlyBonus = edit(list => {
        for (const pass of list) for (const row of pass.rows) {
            if (row.name === 'Kent Johnson' || row.name === 'Second Bonus') row.position = 'Bonus';
        }
    }, structuredClone(both));
    assert.ok(today(decidePhoto(explicitlyBonus, [], schedule, DATE).rows).every(r => r.outcome === 'insert'),
        'explicit Bonus labels do not merge distinct approved prize slots');
    await writeDecision(DB, photo(), decision, true);
    const rows = await onDay(DB);
    assert.equal(rows.filter(r => parseWinnerPrize(r.prize).position === 'Bonus').length, 2);
    assert.equal(new Set(rows.map(r => r.id)).size, 4);
    // A generic heading cannot pick between two drawings. Nor can a phrase two descriptions share.
    const generic = edit(l => { for (const r of cell(l, 'Kent Johnson')) r.prize = 'Bonus Drawing'; });
    assert.equal(named(decidePhoto(generic, [], schedule, DATE).rows, 'Kent Johnson').outcome, 'held');
    const shared = [...schedule, { ...bonus[0], id: 'x', source: 'supplement', description: 'Cutting Board Deluxe' }];
    assert.equal(named(decidePhoto(passes(), [], shared, DATE).rows, 'Kent Johnson').outcome, 'held');
    // A bonus drawing can be added explicitly through an approved supplement, with no numbered place.
    assert.equal(supplementDraft({ drawDate: DATE, category: 'Bonus drawing', position: null, description: 'Gun Safe' }, MONTH).category, 'Bonus drawing');
    assert.throws(() => supplementDraft({ drawDate: DATE, category: 'Bonus drawing', position: 2, description: 'Gun Safe' }, MONTH));
    const supplement = { id: 'sup-1', drawDate: DATE, category: 'Bonus drawing', position: null, description: 'Gun Safe', source: 'supplement', status: 'approved', notes: '' };
    const extended = [...schedule, supplement];
    assert.equal(calendarPosition(extended.find(p => p.id === 'sup-1'), extended), 'Bonus');
});

test('uniqueness is at the prize slot, whatever the ticket or punctuation', async t => {
    const DB = await database(t), add = (id, ticket, prize, slot = SLOT.bonus) => insert(DB, id, DATE, ticket, ticket === null ? null : String(ticket), 'Someone', '', prize, slot);
    await add('a', null, PRIZE.kent);
    for (const [id, ticket, prize] of [['b', null, PRIZE.kent], ['c', null, `Bonus — ${CUTTING.toUpperCase()}.`], ['d', 77, 'Bonus - cutting board, cheese board and knife']])
        await assert.rejects(add(id, ticket, prize), /UNIQUE/);
    // The API normalizes through the same identity, so differently punctuated text cannot open a second row.
    assert.equal((await admin(DB, { drawDate: DATE, ticketNumber: '5', name: 'Other', town: '', prize: `Bonus — cutting board, cheese board & knife sponsored by cutting canteen.` })).status, 409);
    // No slot, no ticketless row. A numbered row with no calendar match is still allowed.
    await assert.rejects(insert(DB, 'e', DATE, null, null, 'No Slot', '', PRIZE.lyle, null), /CHECK/);
    await insert(DB, 'f', DATE, 9, '9', 'Unmatched Prize', '', 'Local Donated Prize', null);
    assert.equal(matchApprovedSlot(await prizeSchedule(DB, MONTH), DATE, 'Local Donated Prize'), null);
    // Adding a ticket later keeps the row, and its slot stays taken.
    assert.equal((await DB.prepare(`UPDATE raffle_winners SET ticket_number=321, ticket_number_text='0321' WHERE id='a'`).run()).meta.changes, 1);
    await assert.rejects(add('g', null, PRIZE.kent), /UNIQUE/);
});

test('admin add and edit support ticketless winners in every verified category, and later tickets keep the ID', async t => {
    const DB = await database(t), add = body => admin(DB, body);
    const main = { ...manualLyle, name: 'Main Winner', prize: PRIZE.troy };
    for (const [label, body, error] of [
        ['not confirmed', { ...manualLyle, ticketMissingVerified: false }, /confirm the official announcement/i],
        ['wrong place', { ...manualLyle, prize: `Bonus — ${GIFT}` }, /is 2nd place on the approved calendar/],
        ['unknown place', { ...manualLyle, prize: GIFT }, /is 2nd place on the approved calendar/],
        ['unapproved prize', { ...manualLyle, prize: '2nd place — Something Else' }, /must match one approved/],
        ['no prize', { ...manualLyle, prize: '' }, /must match one approved/],
        ['no bonus that day', { ...manualLyle, drawDate: '2026-11-03', prize: PRIZE.kent }, /must match one approved/],
    ]) { const r = await add(body); assert.equal(r.status, 400, label); assert.match((await r.json()).error, error, label); }
    for (const ticketNumber of ['abc', '0', '1e2']) assert.equal((await add({ ...manualLyle, ticketNumber })).status, 400);
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM raffle_winners').first()).n, 0);
    // Punctuation and case do not change which slot is matched.
    assert.equal((await add({ ...manualLyle, prize: `2nd place — $100 GIFT CERTIFICATE from Safe & Secure Firearms.` })).status, 200);
    assert.equal((await add({ ...manualLyle, name: 'Kent Johnson', town: 'Blair, Wi', prize: `Bonus - ${CUTTING}.` })).status, 200);
    assert.equal((await add(main)).status, 200);
    assert.equal((await add({ ...main, name: 'Second Main' })).status, 409);
    const row = async name => (await list(DB)).find(w => w.name === name);
    let lyle = await row('Lyle Schlomer');
    assert.deepEqual([lyle.id, lyle.ticketNumber, lyle.ticketNumberText], [LYLE_ID, null, '']);
    assert.equal((await row('Kent Johnson')).prize, PRIZE.kent);
    const winner = w => ({ drawDate: DATE, ticketNumber: '', name: w.name, town: w.town, prize: w.prize, ticketMissingVerified: true });
    const update = (w, next) => admin(DB, { action: 'update', id: w.id, expected: w, winner: next });
    assert.equal((await update(lyle, { ...winner(lyle), town: 'Osseo, Wi' })).status, 200);
    lyle = await row('Lyle Schlomer');
    assert.equal((await update(lyle, { ...winner(lyle), ticketMissingVerified: false })).status, 400);
    assert.equal((await update({ ...lyle, ticketNumber: 5 }, winner(lyle))).status, 409); // Stale edit.
    assert.equal((await update(lyle, { ...winner(lyle), prize: PRIZE.kent })).status, 409); // Slot taken by Kent.
    // The prize editor enforces the same rules and refreshes the slot.
    const prize = body => prizePost(ctx(DB, 'https://example.test/api/admin/raffle/winner-prize', { id: lyle.id, expectedPrize: lyle.prize, category: '', approved: true, positionConfirmed: true, ...body }));
    assert.equal((await prize({ description: GIFT, position: 1 })).status, 400);
    assert.equal((await prize({ description: 'Other', position: 2 })).status, 400);
    assert.equal((await prize({ description: GIFT, position: 2, category: 'Gift card' })).status, 200);
    lyle = await row('Lyle Schlomer');
    assert.equal(lyle.prize, `2nd place — Gift card: ${GIFT}`);
    assert.equal((await onDay(DB)).find(r => r.name === 'Lyle Schlomer').prizeSlotId, SLOT.gift);
    // A verified ticket arrives: same ID, same created_at, exact label.
    const before = await DB.prepare('SELECT created_at FROM raffle_winners WHERE id=?').bind(LYLE_ID).first();
    assert.equal((await update(lyle, { ...winner(lyle), ticketNumber: '0321', ticketMissingVerified: false })).status, 200);
    lyle = await row('Lyle Schlomer');
    assert.deepEqual([lyle.id, lyle.ticketNumber, lyle.ticketNumberText], [LYLE_ID, 321, '0321']);
    assert.deepEqual(await DB.prepare('SELECT created_at FROM raffle_winners WHERE id=?').bind(LYLE_ID).first(), before);
    // Reprocessing the ticket-free announcement leaves the added ticket alone; one printing a ticket never overwrites a ticketless row.
    assert.equal(named((await decide(DB)).rows, 'Lyle Schlomer').outcome, 'duplicate');
    assert.equal((await row('Lyle Schlomer')).ticketNumberText, '0321');
    const printed = edit(l => { for (const r of cell(l, 'Kent Johnson')) Object.assign(r, { ticketNumber: '555', ticketStatus: 'readable', cellText: '555 - Kent Johnson, Blair, Wi', prize: 'Cutting Board' }); });
    const held = named((await decide(DB, printed)).rows, 'Kent Johnson');
    assert.equal(held.outcome, 'held');
    assert.match(held.reasons.join(), /add it in admin/);
    assert.equal((await row('Kent Johnson')).ticketNumber, null);
    // Deleting a winner keeps the removed row in the correction log.
    const kent = await row('Kent Johnson');
    assert.equal((await admin(DB, { action: 'delete', id: kent.id })).status, 200);
    assert.equal(JSON.parse((await DB.prepare(`SELECT before_json AS b FROM raffle_winner_corrections WHERE action='delete' AND winner_id=?`).bind(kent.id).first()).b).winner_name, 'Kent Johnson');
});

test('ticket-free reads must match the raw cell: agreed false blanks and borrowed hometowns are held', async t => {
    const schedule = await prizeSchedule(await database(t), MONTH);
    const outcome = (change, name) => named(decidePhoto(edit(change), [], schedule, DATE).rows, name);
    assert.equal(outcome(() => {}, 'Lyle Schlomer').outcome, 'insert');
    // Observed from the real model before this check: both passes reported ticket 894 as blank, and one took a neighbor's hometown.
    let row = outcome(l => { for (const r of cell(l, 'Lyle Schlomer')) r.cellText = '894 - Lyle Schlomer, Osseo, WI'; }, 'Lyle Schlomer');
    assert.equal(row.outcome, 'held');
    assert.match(row.reasons.join(), /cell text shows a ticket number/);
    row = outcome(l => { for (const r of cell(l, 'Lyle Schlomer')) r.cellText = '894 Lyle Schlomer, Osseo, WI'; }, 'Lyle Schlomer');
    assert.match(row.reasons.join(), /cell text shows a ticket number/);
    // A numbered label is not a ticket. Nor does a blank ticket depend on the category: a verified Main winner qualifies too.
    assert.equal(outcome(l => { for (const r of cell(l, 'Kent Johnson')) Object.assign(r, { prize: '2nd Drawing', cellText: '2nd Drawing - Kent Johnson, Blair, Wi' }); }, 'Kent Johnson').outcome, 'insert');
    const main = outcome(l => { for (const r of cell(l, 'Troy Lindberg')) Object.assign(r, { ticketNumber: '', ticketStatus: 'blank', cellText: 'Troy Lindberg, Hixton, WI' }); }, 'Troy Lindberg');
    assert.deepEqual([main.outcome, main.prize, main.prizeSlotId, main.winnerId], ['insert', PRIZE.troy, SLOT.main, ticketlessWinnerId(DATE, SLOT.main)]);
    row = outcome(l => { for (const r of cell(l, 'Lyle Schlomer')) delete r.cellText; }, 'Lyle Schlomer');
    assert.match(row.reasons.join(), /needs the raw cell text/);
    row = outcome(l => { for (const r of cell(l, 'Troy Lindberg')) r.town = 'Dakota, MN'; }, 'Troy Lindberg');
    assert.match(row.reasons.join(), /hometown is not in the cell text/);
    row = outcome(l => { for (const r of cell(l, 'Troy Lindberg')) r.ticketNumber = '298'; }, 'Troy Lindberg');
    assert.match(row.reasons.join(), /ticket number is not in the cell text/);
    row = outcome(l => { for (const r of cell(l, 'Kent Johnson')) r.name = 'Kent Johnston'; }, 'Kent Johnston');
    assert.match(row.reasons.join(), /name is not in the cell text/);
    row = outcome(l => { for (const r of cell(l, 'Troy Lindberg')) Object.assign(r, { town: '', townStatus: 'blank' }); }, 'Troy Lindberg');
    assert.match(row.reasons.join(), /cell text shows a hometown/);
    // Ticket-free status rules still apply on top of the raw cell.
    for (const [label, change, reason] of [
        ['one pass unconfirmed', l => { delete cell(l, 'Lyle Schlomer')[1].ticketStatus; }, /disagree on whether the ticket/],
        ['none confirmed', l => { for (const r of cell(l, 'Lyle Schlomer')) delete r.ticketStatus; }, /ticket number missing/],
        ['uncertain', l => { cell(l, 'Lyle Schlomer')[1].ticketStatus = 'uncertain'; }, /uncertainty/],
        ['only one reads a ticket', l => { Object.assign(cell(l, 'Lyle Schlomer')[1], { ticketNumber: '123', ticketStatus: 'readable', cellText: '123 - Lyle Schlomer, Osseo, WI' }); }, /disagree on ticketNumber/],
        ['placeholder', l => { for (const r of cell(l, 'Lyle Schlomer')) Object.assign(r, { ticketNumber: 'N/A', ticketStatus: 'readable' }); }, /ticket number missing or invalid/],
    ]) { row = outcome(change, 'Lyle Schlomer'); assert.equal(row.outcome, 'held', label); assert.match(row.reasons.join(), reason, label); }
    // A blank ticket needs a calendar-proven slot: an unproven day does not qualify.
    const extra = [...schedule, { id: 's', drawDate: DATE, category: 'Other', position: null, description: 'Extra Prize', source: 'supplement', status: 'approved', notes: '' }];
    assert.match(named(decidePhoto(passes(), [], extra, DATE).rows, 'Lyle Schlomer').reasons.join(), /place is missing or conflicts/);
});

test('whole-image rejection, row warnings, blank hometowns and exact tickets are preserved', async t => {
    const DB = await database(t), schedule = await prizeSchedule(DB, MONTH);
    const withWarning = warning => { const l = passes(); l[0].warnings = [warning]; return decidePhoto(l, [], schedule, DATE); };
    for (const warning of ['The right winner column is clipped', 'Layout is ambiguous', 'Date association is uncertain', 'A prize heading is missing', 'Something looks wrong', 'Ticket 288 cell is clipped',
        { scope: 'image', code: 'other', message: 'Odd image' }, { scope: 'cell', code: 'clipped', ticketNumber: '288', name: 'Troy Lindberg', drawDate: DATE, field: 'town' },
        { scope: 'row', code: 'uncertain-association', name: 'Kent Johnson', drawDate: DATE }, { scope: 'row', code: 'other', name: 'Nobody', message: 'Unknown row' }]) {
        const decision = withWarning(warning);
        assert.equal(decision.status, 'rejected', JSON.stringify(warning));
        assert.equal(decision.rows.length, 0);
    }
    const scoped = withWarning({ scope: 'cell', code: 'illegible', field: 'town', name: 'Lyle Schlomer', drawDate: DATE, message: 'faint' });
    assert.equal(named(scoped.rows, 'Lyle Schlomer').outcome, 'held');
    assert.equal(named(scoped.rows, 'Kent Johnson').outcome, 'insert');
    for (const warning of [{ scope: 'cell', code: 'blank-cell', field: 'ticketNumber', name: 'Kent Johnson', drawDate: DATE }, 'No ticket number is printed for Kent Johnson'])
        assert.equal(named(withWarning(warning).rows, 'Kent Johnson').outcome, 'insert', JSON.stringify(warning));
    const parsed = parseExtraction({ response: { containsWinners: true, rows: [{ cellText: 'A, B', ticketNumber: 5 }], warnings: [{ scope: 'cell', code: 'blank-cell', field: 'town', name: 'A', drawDate: DATE, ticketNumber: 5 }, { scope: 'mystery', message: 'odd' }, 'plain'] } });
    assert.equal(parsed.rows[0].cellText, 'A, B');
    assert.deepEqual(parsed.warnings.slice(1), ['odd', 'plain']);
    // Jim Wilber: a real blank hometown stored blank is a duplicate, never filled in; only both passes confirming it counts.
    const jim = [{ id: 'jim', drawDate: '2026-11-04', ticketNumber: 226, name: 'Jim Wilber', town: '', prize: '1st place — Firearm: Henry Big Boy All Weather 44 Mag' }];
    assert.equal(named(decidePhoto(passes(), jim, schedule, DATE).rows, 'Jim Wilber').outcome, 'duplicate');
    const oneBlank = edit(l => { Object.assign(cell(l, 'Jim Wilber')[1], { townStatus: 'uncertain' }); });
    assert.equal(named(decidePhoto(oneBlank, [], schedule, DATE).rows, 'Jim Wilber').outcome, 'held');
    // 050 is preserved exactly; a pass dropping the zero is a disagreement.
    assert.equal(named(decidePhoto(passes(), [], schedule, DATE).rows, 'Brent Janzen').row.ticketNumber, '050');
    const dropped = edit(l => { Object.assign(cell(l, 'Brent Janzen')[1], { ticketNumber: '50', cellText: '50 - Brent Janzen, Blair, WI' }); });
    assert.match(named(decidePhoto(dropped, [], schedule, DATE).rows, 'Brent Janzen').reasons.join(), /printed ticket label/);
    // Blair, Wi is stored as printed, and a case-only difference between passes still agrees.
    assert.equal(named(decidePhoto(passes(), [], schedule, DATE).rows, 'Kent Johnson').row.town, 'Blair, Wi');
    assert.equal(named(decidePhoto(edit(l => { Object.assign(cell(l, 'Kent Johnson')[1], { town: 'Blair, WI' }); }), [], schedule, DATE).rows, 'Kent Johnson').outcome, 'insert');
    // Reordered passes change nothing.
    const reversed = edit(l => { l[1].rows.reverse(); });
    assert.ok(reconcileRows(reversed).every(g => g.members.filter(Boolean).length === 2));
    assert.deepEqual(today(decidePhoto(reversed, [], schedule, DATE).rows).map(r => r.outcome), ['insert', 'insert', 'insert']);
});

test('older winners and legacy 3rd records stay intact and readable', async t => {
    const DB = await database(t);
    const seed = (id, ticket, name, prize) => DB.prepare('INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town,prize) VALUES(?,?,?,?,?,?,?)').bind(id, '2026-02', '2026-02-01', ticket, name, 'Osseo', prize).run();
    await seed('unknown', 4, 'Unknown', 'Mystery prize');
    await seed('bonus', 5, 'Bonus Winner', 'Bonus — Old knife');
    await seed('legacy', 3, 'Legacy', '3rd place — Old prize');
    await seed('second', 2, 'Second', '2nd place — Old prize');
    await seed('first', 1, 'First', '1st place — Old prize');
    const pub = await (await publicMonth(ctx(DB, 'https://example.test/api/raffle/month?month=2026-02'))).json();
    assert.deepEqual(pub.winners.map(w => [w.name, prizeCells(w.prize).place]), [['First', '1st'], ['Second', '2nd'], ['Legacy', '3rd'], ['Bonus Winner', '3rd'], ['Unknown', '—']]);
    const legacy = pub.winners.find(w => w.name === 'Legacy');
    assert.equal((await admin(DB, { action: 'update', id: 'legacy', expected: legacy, winner: { drawDate: legacy.drawDate, ticketNumber: '3', name: legacy.name, town: 'Taylor', prize: legacy.prize } })).status, 200);
    const row = await DB.prepare(`SELECT prize, prize_slot_id AS slot FROM raffle_winners WHERE id='legacy'`).first();
    assert.deepEqual([row.prize, row.slot], ['3rd place — Old prize', null]);
    assert.equal(parseWinnerPrize('Bonus knife').position, null);
    assert.equal(composeWinnerPrize({ category: '', description: 'Old', position: 3, positionConfirmed: true, approved: true }), '3rd place — Old');
    // A printed legacy 3rd still publishes through an approved supplement at that place.
    const supplement = { id: 's', drawDate: DATE, category: 'Other', position: 3, description: 'Old prize', source: 'supplement', status: 'approved', notes: '' };
    const third = { drawDate: DATE, position: 3, ticketNumber: '9', ticketStatus: 'readable', name: 'Third Person', town: 'Blair, Wi', townStatus: 'readable', prize: 'Old prize', notes: '' };
    const decision = decidePhoto([{ containsWinners: true, warnings: [], rows: [third] }, { containsWinners: true, warnings: [], rows: [{ ...third }] }], [], [supplement], DATE);
    assert.equal(decision.rows[0].prize, '3rd place — Old prize');
    assert.equal(rowDiagnostics(decision.rows[0]).placement, 3);
    // Processing the cumulative table never edits an older stored row.
    const prod = await database(t);
    await seedProduction(prod);
    const before = (await stored(prod)).filter(r => r.drawDate < DATE);
    await writeDecision(prod, photo(), await decide(prod), true);
    assert.deepEqual((await stored(prod)).filter(r => r.drawDate < DATE), before);
});

test('requeue state changes are atomic and cannot disturb a run in progress', async t => {
    const DB = await database(t), postId = capture.postId;
    const imported = status => DB.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status) VALUES ('1',?,?) ON CONFLICT(photo_id) DO UPDATE SET status=excluded.status`).bind(postId, status).run();
    const state = async () => [(await DB.prepare('SELECT status FROM raffle_photo_auto_posts WHERE post_id=?').bind(postId).first())?.status, (await DB.prepare(`SELECT status FROM raffle_photo_auto_imports WHERE photo_id='1'`).first())?.status];
    // A successful requeue moves both together.
    await DB.prepare(`INSERT INTO raffle_photo_auto_posts (post_id, source, status, attempts) VALUES (?,'webhook','done',3)`).bind(postId).run();
    await imported('rejected');
    assert.equal(await requeuePost(DB, postId), true);
    assert.deepEqual(await state(), ['queued', 'failed']);
    assert.equal((await DB.prepare('SELECT attempts FROM raffle_photo_auto_posts WHERE post_id=?').bind(postId).first()).attempts, 0);
    // A post being processed is left alone, and its photo is not reopened underneath it.
    assert.equal(await claimPost(DB, postId, new Date(Date.now() + 1000)), true);
    await imported('held');
    assert.equal(await requeuePost(DB, postId), false);
    assert.deepEqual(await state(), ['processing', 'held']);
    // A failed batch changes neither. The API reports the failure instead of half-applying.
    const broken = { prepare: (...a) => DB.prepare(...a), batch: async () => { throw Error('D1 unavailable'); } };
    const response = await importsPost(ctx(broken, 'https://example.test/api/admin/raffle/photo-imports', { action: 'requeue', postId }));
    assert.equal(response.status, 503);
    assert.deepEqual(await state(), ['processing', 'held']);
    // Published and duplicate photos stay final; partial photos reopen.
    const done = () => DB.prepare(`UPDATE raffle_photo_auto_posts SET status='done' WHERE post_id=?`).bind(postId).run();
    await done();
    for (const status of ['published', 'duplicate']) { await imported(status); await requeuePost(DB, postId); assert.equal((await state())[1], status); await done(); }
    await imported('partial');
    await requeuePost(DB, postId);
    assert.equal((await state())[1], 'failed');
    // A run whose lease expired cannot overwrite the newer run's state.
    const later = new Date(Date.now() + 1000);
    assert.equal(await claimPost(DB, postId, later), true);
    assert.equal(await claimPost(DB, postId, new Date(later.getTime() + 200_000)), true);
    const { attempts } = await DB.prepare('SELECT attempts FROM raffle_photo_auto_posts WHERE post_id=?').bind(postId).first();
    await finishPost(DB, postId, 'done', undefined, attempts - 1);
    await failPost(DB, postId, 'late', attempts - 1, later);
    assert.equal((await state())[0], 'processing');
    await finishPost(DB, postId, 'done', undefined, attempts);
    assert.equal((await state())[0], 'done');
    assert.equal(await requeuePost(DB, 'not-a-post').catch(e => e.message), 'invalid-post-id');
});

test('diagnostics never expose credentials, URLs or winner names, and reason codes drop model text', () => {
    for (const secret of ['fetch https://graph.facebook.com/v1?access_token=abc123', 'Bearer abc123', 'https://scontent.fbcdn.net/v/signed', 'bad signature abc', 'FB_APP_SECRET missing', 'EAAG' + 'x'.repeat(60)])
        assert.equal(sanitizeCode(Error(secret)), 'redacted-error');
    for (const code of ['ai-unavailable', 'token-expired', 'missing-token', 'permission-denied', 'rate-limited']) assert.equal(sanitizeCode(Error(code)), code);
    assert.equal(reasonCode('model flagged uncertainty: Lyle Schlomer unclear'), 'model-flagged-uncertainty');
    const row = { drawDate: DATE, position: null, ticketNumber: '', ticketStatus: 'blank', name: 'Lyle Schlomer', town: 'Osseo, WI', townStatus: 'readable', notes: 'Lyle Schlomer', prize: GIFT, cellText: 'Lyle Schlomer, Osseo, WI' };
    const text = JSON.stringify(rowDiagnostics({ rowNumber: 1, outcome: 'held', reasons: ['model flagged uncertainty: Lyle Schlomer'], row, winnerId: null, prize: null, prizeMatch: 'none' }));
    assert.ok(!text.includes('Lyle') && !text.includes('Osseo'));
});

test('real Worker with the real image and capture: conflict, correction, one insert, retries and repeat requeues', async t => {
    const bundle = await build({ entryPoints: ['workers/facebook-photos/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
    const created = '2026-11-07T02:20:00+0000', postId = capture.postId, photoId = capture.photoId;
    let aiCalls = 0, failure = null;
    const outbound = async request => {
        const url = new URL(request.url);
        if (url.hostname.endsWith('.fbcdn.net')) return new Response(image, { headers: { 'content-type': 'image/jpeg' } });
        const path = url.pathname.split('/').slice(2).join('/');
        if (path === postId) return Response.json({ id: postId, message: 'Winners #LakeHenryRaffle', created_time: created, attachments: { data: [{ type: 'photo', target: { id: photoId }, url: 'https://www.facebook.com/photo/' }] } });
        if (path === photoId) return Response.json({ id: photoId, images: [{ source: 'https://scontent-ord5-1.xx.fbcdn.net/v/t39/winner.jpg?signed=1', width: 856, height: 243 }] });
        return Response.json({ error: { code: 100 } }, { status: 400 });
    };
    const mf = new Miniflare({ workers: [
        { name: 'photos', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-09-15', d1Databases: ['DB'], wrappedBindings: { AI: { scriptName: 'ai-shim' } },
            bindings: { FB_PAGE_ACCESS_TOKEN: 'page-token', FB_PHOTO_AUTOMATION_ENABLED: 'true', FB_PHOTO_AUTOPUBLISH: 'true', FB_PHOTO_POLL_ENABLED: 'false', FB_PHOTO_EXTRACTION_PASSES: '2',
                FB_RAFFLE_MARKER: '#LakeHenryRaffle', FB_SEASON_START: '2026-11-01T00:00:00-05:00', FB_SEASON_END: '2030-12-01T00:00:00-06:00' }, outboundService: outbound },
        { name: 'ai-shim', modules: true, serviceBindings: { CONTROL: async () => { const i = aiCalls++; if (failure) { const m = failure; failure = null; return new Response(m, { status: 503 }); } return Response.json(passes()[i % 2]); } },
            script: `export default function(env){return {async run(){const r=await env.CONTROL.fetch('http://ai/run',{method:'POST'});if(!r.ok)throw new Error(await r.text());return {response:await r.json()};}}}` },
    ], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    await apply(DB);
    await seedProduction(DB);
    let clock = Math.max(Date.now(), Date.parse('2026-11-07T03:00:00Z'));
    const tick = async () => { clock += 3 * 3600_000; await (await mf.getWorker('photos')).scheduled({ scheduledTime: new Date(clock), cron: '*/2 * * * *' }); };
    const post = () => DB.prepare('SELECT status, attempts, error_code AS code, last_error_code AS last, publication_status AS publication FROM raffle_photo_auto_posts WHERE post_id=?').bind(postId).first();
    const settle = async want => { for (let i = 0; i < 120; i++) { const row = await post(); if (want.includes(row.status)) return row; await new Promise(r => setTimeout(r, 50)); } assert.fail('timed out waiting for ' + want); };
    const requeue = async () => assert.equal((await importsPost(ctx(DB, 'https://example.test/api/admin/raffle/photo-imports', { action: 'requeue', postId }))).status, 200);
    const importStatus = async () => (await DB.prepare('SELECT status FROM raffle_photo_auto_imports WHERE photo_id=?').bind(photoId).first())?.status;

    // Today's wrong data: nothing changes, the queue finishes, and the admin can see why.
    const before = await stored(DB);
    await requeue();
    await tick();
    let row = await settle(['done', 'failed']);
    assert.deepEqual([row.status, row.publication], ['done', 'rejected']);
    assert.deepEqual(await stored(DB), before);
    assert.equal(await importStatus(), 'rejected');
    // Correct Kent through admin. A failed attempt then keeps its reason after the later success.
    assert.equal((await correctKent(DB)).status, 200);
    await requeue();
    failure = 'ai-unavailable';
    await tick();
    row = await settle(['retry']);
    assert.deepEqual([row.code, row.last], ['ai-unavailable', 'ai-unavailable']);
    await tick();
    row = await settle(['done']);
    assert.deepEqual([row.code, row.last, row.publication], [null, 'ai-unavailable', 'published']);
    const rows = await onDay(DB);
    assert.deepEqual(rows.map(r => [r.name, r.ticketNumber, r.prize, r.prizeSlotId]).sort(), [
        ['Kent Johnson', null, PRIZE.kent, SLOT.bonus], ['Lyle Schlomer', null, PRIZE.lyle, SLOT.gift], ['Troy Lindberg', 288, PRIZE.troy, SLOT.main]]);
    assert.equal(rows.find(r => r.name === 'Kent Johnson').id, KENT_ID);
    assert.equal(rows.find(r => r.name === 'Lyle Schlomer').id, LYLE_ID);
    // Repeat requeues of the published photo cost no AI calls and change nothing.
    const calls = aiCalls;
    for (let i = 0; i < 3; i++) { await requeue(); await tick(); assert.equal((await settle(['done'])).publication, 'published'); }
    assert.equal(aiCalls, calls);
    assert.deepEqual(await onDay(DB), rows);
    // The admin log tells the same story and its sanitized history holds no names or secrets.
    const log = await (await importsGet(ctx(DB, 'https://example.test/api/admin/raffle/photo-imports'))).json();
    assert.equal(log.posts[0].lastErrorCode, 'ai-unavailable');
    const attempts = JSON.stringify(log.attempts);
    for (const stage of ['post', 'photo', 'pass', 'row']) assert.ok(attempts.includes(`"stage":"${stage}"`), stage);
    for (const banned of ['Lyle', 'Troy', 'Kent', 'fbcdn', 'page-token', 'signed', 'Cutting']) assert.ok(!attempts.includes(banned), banned);
    const accepted = log.imports[0].rows.find(r => r.row.name === 'Lyle Schlomer');
    assert.deepEqual([accepted.outcome, accepted.winnerId], ['inserted', LYLE_ID]);
    assert.match(accepted.reasons.join(), new RegExp(`approved calendar entry ${SLOT.gift}`));
    // A partial photo reopens on requeue; an administrator's removal of an auto winner is respected.
    await DB.prepare('DELETE FROM raffle_winners WHERE id=?').bind(LYLE_ID).run();
    await DB.prepare(`UPDATE raffle_photo_auto_imports SET status='partial' WHERE photo_id=?`).bind(photoId).run();
    await requeue();
    await tick();
    await settle(['done']);
    assert.equal((await onDay(DB)).filter(r => r.name === 'Lyle Schlomer').length, 0);
    const refused = await DB.prepare(`SELECT reasons_json AS reasons FROM raffle_photo_auto_rows WHERE photo_id=? AND outcome='held' AND json_extract(row_json,'$.name')='Lyle Schlomer'`).bind(photoId).first();
    assert.match(refused.reasons, /administrator removed it/);
});
