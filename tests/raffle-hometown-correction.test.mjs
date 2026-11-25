import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { decidePhoto, confirmTownCorrections, townCorrectionTargets, rereadConfirms, loadContext, writeDecision, MAX_TOWN_CORRECTIONS } from '../src/lib/server/raffle-photo-autopublish.ts';
import { compareWinner, townKey } from '../src/lib/raffle-photo-import.ts';
import { calendar, cell, fixture, inserted, events } from './november-table.mjs';

// November 24, 2026 (incident photo:review:122337496586073310): the Nov 22 photo's two passes read the bonus cell as
// "Vexliar - 781 - Troy Mish, Westby, WI" (Westby, WI is also the hometown of the Gift Card cell beside it) and it was published after a
// review that changed only the prize. Both passes of the Nov 24 cumulative table read the same cell as "…, Maple Park, IL" and the row was
// rejected: "conflicts with existing winner (town)". The owner has since corrected the winner by hand; nothing here touches production.
// The extractions and winners below are the real stored production data (see each fixture's "source").
const nov22 = await fixture('facebook-winners-2026-11-22.extraction.json');
const nov24 = await fixture('facebook-winners-2026-11-24.extraction.json');
const { winners: before24 } = await fixture('november-2026-winners-before-2026-11-24.json');
const DATE = '2026-11-24', TROY = '2026-11-2026-11-22-781', OLD = 'Westby, WI', NEW = 'Maple Park, IL';
const strip = passes => passes.map(({ read: _read, ...p }) => structuredClone(p));
/** The winners as loadContext reads them: `sources` says which stored hometowns came from a winner photo or an administrator. */
const stored = (sources = { [TROY]: 'automated' }, winners = before24) => winners.map(w => ({ ...w, townSource: sources[w.id] ?? null }));
const decide = (passes, schedule, existing = stored(), date = DATE) => decidePhoto(passes, existing, schedule, date);
const troy = d => d.rows.find(r => r.row.ticketNumber === '781' && r.row.drawDate === '2026-11-22');
const counts = d => Object.fromEntries(['insert', 'duplicate', 'held', 'rejected', 'correct'].map(o => [o, d.rows.filter(r => r.outcome === o).length]));
/** What a targeted re-read of the cell returns. */
const reread = (town = NEW, change = {}) => ({ drawDate: '2026-11-22', position: null, ticketNumber: '781', ticketStatus: 'readable', name: 'Troy Mish',
    town, townStatus: 'readable', prize: '', notes: '', cellText: `Vexliar - 781 - Troy Mish, ${town}`, ...change });
const withTown = (passes, ticket, town, cellTown = town) => passes.map(p => ({ ...p, rows: p.rows.map(r => r.ticketNumber === ticket
    ? { ...r, town, cellText: r.cellText.replace(/, [^,]+, [A-Z]{2}$/i, `, ${cellTown}`) } : r) }));

test('Nov 24 as it ran: without a stored automated hometown the cell is still rejected, exactly as production recorded it', async t => {
    const schedule = await calendar(t);
    const d = decide(strip(nov24.extractionPasses), schedule, stored({}));
    assert.deepEqual(counts(d), { insert: 2, duplicate: 12, held: 0, rejected: 1, correct: 0 });
    assert.deepEqual(troy(d).reasons, ['conflicts with existing winner (town)']);
    assert.deepEqual(townCorrectionTargets(d), []); // no extra AI call
});

test('Nov 24 self-correction: the automated Westby hometown is replaced only after a targeted re-read confirms Maple Park', async t => {
    const schedule = await calendar(t);
    const d = decide(strip(nov24.extractionPasses), schedule);
    // Proposed, not applied: until the re-read confirms it, the row is the same rejection with the same first reason.
    assert.equal(troy(d).outcome, 'rejected');
    assert.equal(troy(d).reasons[0], 'conflicts with existing winner (town)');
    assert.deepEqual(troy(d).correction, { winnerId: TROY, drawDate: '2026-11-22', ticketNumber: '781', name: 'Troy Mish',
        prizeSlotId: 'event-bonus:2026-11-22-day-22-winchester-m70-ext-spt-6-8-western', from: OLD, to: NEW, fallback: 'rejected' });
    assert.deepEqual(townCorrectionTargets(d), [{ rowNumber: troy(d).rowNumber, drawDate: '2026-11-22', ticketNumber: '781', name: 'Troy Mish' }]);
    const done = confirmTownCorrections(d, new Map([[troy(d).rowNumber, reread()]]));
    assert.equal(troy(done).outcome, 'correct');
    // Distinguishable on Admin > Photo imports: who corrected it and the old and new hometowns (never the name; never in an alert).
    assert.equal(troy(done).reasons[0], 'hometown corrected automatically by the photo importer, not by an administrator: “Westby, WI” → “Maple Park, IL”');
    assert.ok(troy(done).reasons.every(r => !r.includes('Troy')), 'reasons never carry names');
    // Nothing left for review: the two Nov 23 winners publish and the photo is not partial, so no review alert is raised.
    assert.deepEqual(counts(done), { insert: 2, duplicate: 12, held: 0, rejected: 0, correct: 1 });
    assert.equal(done.status, 'published');
    // Every other row decides exactly as without the correction.
    const plain = decide(strip(nov24.extractionPasses), schedule, stored({}));
    assert.deepEqual(done.rows.filter(r => r !== troy(done)).map(r => [r.outcome, r.winnerId, r.prizeSlotId]),
        plain.rows.filter(r => r !== troy(plain)).map(r => [r.outcome, r.winnerId, r.prizeSlotId]));
});

test('a re-read that does not confirm the new hometown leaves the ordinary rejection for review', async t => {
    const schedule = await calendar(t);
    const d = decide(strip(nov24.extractionPasses), schedule), n = troy(d).rowNumber;
    const rejected = rereads => { const r = troy(confirmTownCorrections(d, rereads)); assert.equal(r.outcome, 'rejected'); return r.reasons; };
    assert.match(rejected(new Map()).at(-1), /re-read of the cell was not available; not corrected automatically; review required/);
    for (const [label, cellRead] of [['not found', null], ['old town', reread(OLD)], ['a third town', reread('Blair, WI')],
        ['uncertain', reread(NEW, { townStatus: 'uncertain' })], ['notes', reread(NEW, { notes: 'state may be clipped' })],
        ['town not in the copied cell', reread(NEW, { cellText: `Vexliar - 781 - Troy Mish, ${OLD}` })],
        ['another ticket', reread(NEW, { ticketNumber: '782', cellText: `Vexliar - 782 - Troy Mish, ${NEW}` })],
        ['another name', reread(NEW, { name: 'Troy Mash', cellText: `Vexliar - 781 - Troy Mash, ${NEW}` })],
        ['another date', reread(NEW, { drawDate: '2026-11-23' })]]) {
        const reasons = rejected(new Map([[n, cellRead]]));
        assert.equal(reasons[0], 'conflicts with existing winner (town)', label);
        assert.match(reasons.at(-1), /did not confirm the new hometown; not corrected automatically; review required/, label);
    }
    // Formatting of the re-read itself is harmless.
    assert.equal(rereadConfirms(troy(d).correction, reread('maple park IL')), true);
});

test('the source spreadsheet corrected again: a later table that goes back to the old hometown is corrected the same way', async t => {
    const schedule = await calendar(t);
    // After the automatic correction the stored hometown is Maple Park, written by the importer ('automated'); a later table prints Westby.
    const corrected = stored().map(w => w.id === TROY ? { ...w, town: NEW } : w);
    const later = withTown(strip(nov24.extractionPasses), '781', OLD);
    const d = decide(later, schedule, corrected);
    assert.deepEqual([troy(d).correction?.from, troy(d).correction?.to], [NEW, OLD]);
    assert.equal(troy(confirmTownCorrections(d, new Map([[troy(d).rowNumber, reread(OLD)]]))).outcome, 'correct');
});

test('equivalent hometown formatting is a duplicate, never a correction or a conflict', async t => {
    const schedule = await calendar(t);
    for (const town of ['Maple Park, IL', 'maple park, il', 'Maple Park IL', 'Maple Park,IL', ' Maple  Park , IL ', 'Maple Park, I.L.', 'Maplé Park, IL']) {
        const d = decide(strip(nov24.extractionPasses), schedule, stored().map(w => w.id === TROY ? { ...w, town } : w));
        assert.equal(troy(d).outcome, 'duplicate', town);
        assert.deepEqual(townCorrectionTargets(d), [], town);
    }
    for (const [a, b] of [['Brodhead, Wi', 'Brodhead, WI'], ['Auburn,WA', 'Auburn, WA'], ['La Crosse, WI', 'LaCrosse, WI'], ['St. Paul, MN', 'St Paul, MN']])
        assert.equal(townKey(a), townKey(b), `${a} = ${b}`);
    // A missing or different state is a real difference.
    for (const [a, b] of [['Hixton', 'Hixton, WI'], ['Tomah, W', 'Tomah, WI'], ['Maple Park, IL', 'Maple Park, WI']]) assert.notEqual(townKey(a), townKey(b));
    // The Nov 24 table's "Brodhead, WI" for a stored "Brodhead, Wi" (Nov 20, ticket 540) was always a duplicate.
    const nov20 = decide(strip(nov24.extractionPasses), schedule).rows.find(r => r.row.ticketNumber === '540');
    assert.equal(nov20.outcome, 'duplicate');
});

test('incorrect or conflicting extractions never propose a correction', async t => {
    const schedule = await calendar(t);
    const base = strip(nov24.extractionPasses);
    const none = (passes, label, existing) => { const d = decide(passes, schedule, existing); assert.equal(troy(d)?.correction, undefined, label);
        assert.notEqual(troy(d)?.outcome, 'insert', label); return d; };
    // The passes disagree on the hometown.
    none([base[0], withTown([base[1]], '781', OLD)[0]], 'passes disagree');
    // A pass is unsure of the hometown, or flags the row.
    none([base[0], { ...base[1], rows: base[1].rows.map(r => r.ticketNumber === '781' ? { ...r, townStatus: 'uncertain' } : r) }], 'uncertain');
    none([base[0], { ...base[1], rows: base[1].rows.map(r => r.ticketNumber === '781' ? { ...r, notes: 'faint' } : r) }], 'notes');
    // The parsed hometown is not the copied cell's (a neighbour's town).
    none(withTown(base, '781', NEW, OLD), 'cell text disagrees');
    // Only one pass read the cell.
    none([base[0], { ...base[1], rows: base[1].rows.filter(r => r.ticketNumber !== '781') }], 'one pass');
    // A layout remark in a pass.
    none(base.map((p, i) => i ? p : { ...p, warnings: [{ scope: 'image', code: 'ambiguous-layout', message: 'The date/column association is ambiguous.' }] }), 'layout');
    // A blank hometown.
    none(base.map(p => ({ ...p, rows: p.rows.map(r => r.ticketNumber === '781' ? { ...r, town: '', townStatus: 'blank', cellText: 'Vexliar - 781 - Troy Mish' } : r) })), 'blank');
    // A stored winner without a recorded prize slot.
    none(base, 'no slot', stored().map(w => w.id === TROY ? { ...w, prizeSlotId: null } : w));
});

test('manually corrected, manually entered or unknown hometowns are never corrected automatically', async t => {
    const schedule = await calendar(t);
    for (const source of ['manual', null, undefined]) {
        const d = decide(strip(nov24.extractionPasses), schedule, stored({ [TROY]: source }));
        assert.deepEqual([troy(d).outcome, troy(d).reasons, townCorrectionTargets(d)], ['rejected', ['conflicts with existing winner (town)'], []], String(source));
    }
    // Today's state: the owner's correction to Maple Park is 'manual'; the Nov 24 table now agrees with it, and an older read never overrides it.
    const owner = stored({ [TROY]: 'manual' }).map(w => w.id === TROY ? { ...w, town: NEW } : w);
    assert.equal(troy(decide(strip(nov24.extractionPasses), schedule, owner)).outcome, 'duplicate');
    const back = decide(withTown(strip(nov24.extractionPasses), '781', OLD), schedule, owner);
    assert.deepEqual([troy(back).outcome, troy(back).correction], ['rejected', undefined]);
});

test('genuine winner identity conflicts stay rejected for review', async t => {
    const schedule = await calendar(t);
    const base = strip(nov24.extractionPasses);
    const change = (fn) => base.map(p => ({ ...p, rows: p.rows.map(r => r.ticketNumber === '781' ? fn(r) : r) }));
    // Same ticket, different person (and town).
    const name = decide(change(r => ({ ...r, name: 'Tracy Mish', cellText: r.cellText.replace('Troy', 'Tracy') })), schedule);
    const row = name.rows.find(r => r.row.name === 'Tracy Mish');
    assert.deepEqual([row.outcome, row.correction], ['rejected', undefined]);
    assert.match(row.reasons[0], /conflicts with existing winner \(name, town\)/);
    // Same person, different ticket.
    const ticket = decide(change(r => ({ ...r, ticketNumber: '787', cellText: r.cellText.replace('781', '787') })), schedule);
    const t787 = ticket.rows.find(r => r.row.ticketNumber === '787');
    assert.deepEqual([t787.outcome, t787.correction], ['rejected', undefined]);
    // Same winner and ticket but stored in another approved prize slot: the prize slot conflict wins, nothing is corrected.
    const slot = decide(base, schedule, stored().map(w => w.id === TROY ? { ...w, prizeSlotId: 'daily:2026-11-22:0' } : w));
    assert.equal(troy(slot).correction, undefined);
    assert.notEqual(troy(slot).outcome, 'correct');
    // compareWinner itself still reports the town conflict unchanged.
    assert.deepEqual(compareWinner(base[0].rows.find(r => r.ticketNumber === '781'), stored()).conflicts, ['town']);
});

test(`more than ${MAX_TOWN_CORRECTIONS} hometown conflicts in one photo look like a misread column: none is corrected`, async t => {
    const schedule = await calendar(t);
    const tickets = ['781', '248', '281'];
    const everyone = Object.fromEntries(before24.map(w => [w.id, 'automated']));
    const passes = tickets.reduce((p, k) => withTown(p, k, 'Elsewhere, MN'), strip(nov24.extractionPasses));
    const d = decide(passes, schedule, stored(everyone));
    assert.deepEqual(townCorrectionTargets(d), []);
    for (const k of tickets) {
        const r = d.rows.find(v => v.row.ticketNumber === k);
        assert.equal(r.outcome, 'rejected', k);
        assert.match(r.reasons.join(' '), /3 hometown conflicts in one photo; automatic correction is limited to 2/, k);
    }
    // Two are still eligible.
    assert.equal(townCorrectionTargets(decide(tickets.slice(0, 2).reduce((p, k) => withTown(p, k, 'Elsewhere, MN'), strip(nov24.extractionPasses)), schedule, stored(everyone))).length, 2);
});

test('previously resolved November photos replay unchanged and propose no correction', async t => {
    const schedule = await calendar(t);
    const { winners: through21 } = await fixture('november-2026-winners-through-21.json');
    const everyone = ws => ws.map(w => ({ ...w, townSource: 'automated' }));
    // The real Nov 22 photo against the winners before it: with today's code the Vexliar bonus publishes (Westby, as it was read).
    const d22 = decide(strip(nov22.extractionPasses), schedule, everyone(through21), '2026-11-22');
    assert.deepEqual(inserted(d22).map(r => r.row.ticketNumber).sort(), ['248', '281', '781']);
    assert.deepEqual(townCorrectionTargets(d22), []);
    // The real Nov 21 photo against the winners after it: every row is a duplicate.
    const nov21 = await fixture('facebook-winners-2026-11-21.extraction.json');
    const d21 = decide(strip(nov21.extractionPasses), schedule, everyone(through21), '2026-11-21');
    assert.deepEqual(townCorrectionTargets(d21), []);
    assert.equal(d21.rows.filter(r => r.outcome === 'insert').length, 0);
    // The six Nov 12 cleanup corrections (Tomah, W -> Tomah, WI and others) were made by an administrator: a cumulative table that still
    // read the old spelling would be rejected for review, never "corrected" back.
    const tomah = { id: '2026-11-2026-11-22-248', town: 'Osseo, WI' };
    const manual = stored({ [tomah.id]: 'manual' });
    const old = decide(withTown(strip(nov24.extractionPasses), '248', 'Osseo, W'), schedule, manual);
    const r248 = old.rows.find(r => r.row.ticketNumber === '248');
    assert.deepEqual([r248.outcome, r248.correction], ['rejected', undefined]);
});

// ---- D1: provenance, atomic idempotent writes, manual protection, dry run ----
async function database(t) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    for (const name of ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '004_raffle_photo_autopublish.sql',
        '005_winner_ticket_text.sql', '006_bonus_winner_tickets.sql', '007_photo_import_diagnostics.sql']) {
        const sql = (await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');
        for (const s of sql.split(';').filter(v => v.trim())) await DB.prepare(s).run();
    }
    for (const e of events) await DB.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id, e.title, e.kind ?? 'raffle', e.status, e.date_start, e.summary ?? null).run();
    await DB.batch(before24.map(w => DB.prepare(`INSERT INTO raffle_winners (id, raffle_key, draw_date, ticket_number, winner_name, town, prize, ticket_number_text, prize_slot_id)
        VALUES (?,?,?,?,?,?,?,?,?)`).bind(w.id, '2026-11', w.drawDate, w.ticketNumber, w.name, w.town, w.prize, w.ticketNumber === null ? null : String(w.ticketNumber), w.prizeSlotId)));
    // The Nov 22 photo's audit row for ticket 781, as the admin review left it (row_json keeps the original read).
    const read = nov22.extractionPasses[0].rows.find(r => r.ticketNumber === '781');
    await DB.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json) VALUES (?,?,?,?,?,?,?)`)
        .bind(nov22.photoId, 17, 'inserted', TROY, 'Bonus — Vexilar Fish Finder', '["published by an administrator after review (edit)"]', JSON.stringify(read)).run();
    return DB;
}
const photo = { photoId: nov24.photoId, postId: nov24.postId, sha256: nov24.sha256, width: nov24.width, height: nov24.height, model: nov24.model, passes: nov24.extractionPasses };
const winner = (DB, id = TROY) => DB.prepare('SELECT * FROM raffle_winners WHERE id=?').bind(id).first();
const corrections = DB => DB.prepare('SELECT * FROM raffle_winner_corrections ORDER BY id').all().then(r => r.results);
async function decided(DB, schedule, confirm = NEW) {
    const { existing } = await loadContext(DB, ['2026-11']);
    const d = decidePhoto(strip(nov24.extractionPasses), existing, schedule, DATE);
    const targets = townCorrectionTargets(d);
    return { d: confirm && targets.length ? confirmTownCorrections(d, new Map(targets.map(x => [x.rowNumber, reread(confirm)]))) : d, existing, targets };
}

test('D1: an automated hometown is corrected once, atomically, with a full audit row, and repeated processing changes nothing', async t => {
    const DB = await database(t), schedule = await calendar(t);
    const { d, existing, targets } = await decided(DB, schedule);
    assert.equal(existing.find(w => w.id === TROY).townSource, 'automated');
    assert.equal(existing.filter(w => w.townSource === 'automated').length, 1); // winners without a photo audit row are unknown, not automated
    assert.equal(targets.length, 1);
    assert.equal(await writeDecision(DB, photo, d, true), 'published');
    assert.equal((await winner(DB)).town, NEW);
    const [c, ...more] = await corrections(DB);
    assert.equal(more.length, 0);
    assert.deepEqual([c.winner_id, c.action], [TROY, 'update']);
    const beforeJson = JSON.parse(c.before_json), after = JSON.parse(c.after_json);
    assert.deepEqual([beforeJson.town, beforeJson.winner_name, beforeJson.ticket_number, beforeJson.prize_slot_id], [OLD, 'Troy Mish', 781, 'event-bonus:2026-11-22-day-22-winchester-m70-ext-spt-6-8-western']);
    assert.deepEqual([after.town, after.from, after.source, after.photoId], [NEW, OLD, 'photo-auto', nov24.photoId]);
    const audit = await DB.prepare(`SELECT outcome, winner_id, reasons_json FROM raffle_photo_auto_rows WHERE photo_id=? AND winner_id=?`).bind(nov24.photoId, TROY).first();
    assert.equal(audit.outcome, 'duplicate');
    assert.match(audit.reasons_json, /hometown corrected automatically/);
    const status = await DB.prepare(`SELECT status FROM raffle_photo_auto_imports WHERE photo_id=?`).bind(nov24.photoId).first();
    assert.equal(status.status, 'published'); // not held/rejected/partial: no review alert
    assert.equal((await DB.prepare(`SELECT count(*) AS n FROM raffle_photo_auto_rows WHERE photo_id=? AND outcome IN ('held','rejected')`).bind(nov24.photoId).first()).n, 0);
    // After the correction the stored hometown is still 'automated' (written by the importer), and the same table is now a plain duplicate.
    const again = await decided(DB, schedule);
    assert.equal(again.existing.find(w => w.id === TROY).townSource, 'automated');
    assert.deepEqual(again.targets, []);
    assert.equal(troy(again.d).outcome, 'duplicate');
    // A requeue reopens the photo and writes the same decisions again (the stale correcting one too): no second correction, no new alert.
    const reopen = () => DB.prepare(`UPDATE raffle_photo_auto_imports SET status='failed' WHERE photo_id=?`).bind(nov24.photoId).run();
    await reopen();
    assert.equal(await writeDecision(DB, photo, d, true), 'published');
    await reopen();
    assert.equal(await writeDecision(DB, photo, again.d, true), 'published');
    // A photo already decided is final: writing it again without a requeue changes nothing at all.
    await writeDecision(DB, photo, d, true);
    assert.equal((await DB.prepare(`SELECT status FROM raffle_photo_auto_imports WHERE photo_id=?`).bind(nov24.photoId).first()).status, 'published');
    assert.equal((await DB.prepare(`SELECT count(*) AS n FROM raffle_photo_auto_rows WHERE photo_id=? AND outcome IN ('held','rejected')`).bind(nov24.photoId).first()).n, 0);
    assert.equal((await corrections(DB)).length, 1);
    assert.equal((await winner(DB)).town, NEW);
});

test('D1: an administrator edit protects the hometown, at decision time and again at write time', async t => {
    const DB = await database(t), schedule = await calendar(t);
    const { d } = await decided(DB, schedule);
    assert.equal(troy(d).outcome, 'correct');
    // The owner edits the winner after the decision and before the write (an edit that keeps the old town still protects it).
    const row = await winner(DB);
    await DB.prepare(`INSERT INTO raffle_winner_corrections (winner_id, action, before_json, after_json) VALUES (?,?,?,?)`)
        .bind(TROY, 'update', JSON.stringify(row), JSON.stringify({ drawDate: row.draw_date, name: row.winner_name, town: row.town })).run();
    assert.equal(await writeDecision(DB, photo, d, true), 'partial');
    assert.equal((await winner(DB)).town, OLD);
    assert.equal((await corrections(DB)).length, 1);
    const audit = await DB.prepare(`SELECT outcome, reasons_json FROM raffle_photo_auto_rows WHERE photo_id=? AND winner_id=?`).bind(nov24.photoId, TROY).first();
    assert.equal(audit.outcome, 'rejected');
    assert.match(audit.reasons_json, /^\["conflicts with existing winner \(town\)"/);
    // From now on the decision itself sees a manual hometown and proposes nothing, so no re-read is paid for.
    const now = await decided(DB, schedule);
    assert.equal(now.existing.find(w => w.id === TROY).townSource, 'manual');
    assert.deepEqual(now.targets, []);
});

test('D1: a hometown changed underneath, or a dry run, changes nothing', async t => {
    const DB = await database(t), schedule = await calendar(t);
    const { d } = await decided(DB, schedule);
    const dry = { ...photo, photoId: 'dry-run' };
    assert.equal(await writeDecision(DB, dry, d, false), 'held');
    assert.equal((await winner(DB)).town, OLD);
    assert.match((await DB.prepare(`SELECT reasons_json FROM raffle_photo_auto_rows WHERE photo_id='dry-run' AND winner_id=?`).bind(TROY).first()).reasons_json, /dry run/);
    // Someone else stored a different town between decision and write: the write is refused and the row is an ordinary conflict.
    await DB.prepare(`UPDATE raffle_winners SET town='Blair, WI' WHERE id=?`).bind(TROY).run();
    assert.equal(await writeDecision(DB, photo, d, true), 'partial');
    assert.equal((await winner(DB)).town, 'Blair, WI');
    assert.equal((await corrections(DB)).length, 0);
});

// ---- Worker: the targeted re-read is the only extra AI call, and only for a proposed correction ----
test('Worker: one targeted re-read per proposed cell, never told either hometown, checkpointed and reused, failures never block', async t => {
    const { rereadTownCells, parseCellRead, CELL_MAX_TOKENS } = await import('../workers/facebook-photos/reads.ts');
    const DB = await database(t);
    const context = { postId: nov24.postId, photoId: nov24.photoId, attempt: null };
    const image = { sha256: nov24.sha256, width: nov24.width, height: nov24.height };
    const target = { rowNumber: 13, drawDate: '2026-11-22', ticketNumber: '781', name: 'Troy Mish' };
    const ai = (reply) => { const calls = []; return { calls, AI: { async run(model, input) { calls.push({ model, prompt: input.messages[0].content[0].text, max: input.max_tokens });
        if (reply instanceof Error) throw reply; return reply; } } }; };
    const ok = { response: { found: true, cellText: 'Vexliar - 781 - Troy Mish, Maple Park, IL', ticketNumber: '781', name: 'Troy Mish', town: 'Maple Park, IL', townStatus: 'readable', notes: '' },
        usage: { prompt_tokens: 2600, completion_tokens: 60 } };
    // No proposed correction: no AI call at all.
    const idle = ai(ok);
    assert.equal((await rereadTownCells({ DB, ...idle }, new Uint8Array([255, 216, 1]), 'image/jpeg', context, image, true, [], [])).results.size, 0);
    assert.equal(idle.calls.length, 0);
    // The stored extraction checkpoint exists (status failed) while the photo is being decided.
    await DB.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status, image_sha256, extraction_json) VALUES (?,?,'failed',?,?)`)
        .bind(nov24.photoId, nov24.postId, nov24.sha256, JSON.stringify(nov24.extractionPasses)).run();
    const first = ai(ok), reads = structuredClone(nov24.extractionPasses);
    const got = await rereadTownCells({ DB, ...first }, new Uint8Array([255, 216, 1]), 'image/jpeg', context, image, true, [target], reads);
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].max, CELL_MAX_TOKENS);
    assert.match(first.calls[0].prompt, /ticket number "781" and the winner "Troy Mish"/);
    assert.ok(!/Maple|Westby|Vexliar|Vexilar/.test(first.calls[0].prompt), 'the re-read is never told a hometown or prize');
    assert.ok(!first.calls[0].prompt.startsWith('This image is a raffle winner table'), 'not a window read');
    assert.deepEqual([got.results.get(13).town, got.results.get(13).townStatus, got.aiCalls], ['Maple Park, IL', 'readable', 1]);
    assert.equal(reads.at(-1).read.kind, 'cell');
    // A requeued run of the same image reuses the checkpointed re-read.
    const second = ai(Error('should not run'));
    const again = await rereadTownCells({ DB, ...second }, new Uint8Array([255, 216, 1]), 'image/jpeg', context, image, true, [target], structuredClone(nov24.extractionPasses));
    assert.deepEqual([second.calls.length, again.reused, again.results.get(13).town], [0, 1, 'Maple Park, IL']);
    // Failures, quota refusals and unparseable replies are simply "not available": the row keeps its ordinary outcome.
    for (const reply of [Error('4006: you have used up your daily free allocation of 10,000 neurons'), Error('ai-unavailable'), { response: 'not json' }, { response: { cellText: 'x' } }]) {
        const r = await rereadTownCells({ DB, ...ai(reply) }, new Uint8Array([255, 216, 1]), 'image/jpeg', { ...context, photoId: 'other' }, null, true, [target], []);
        assert.equal(r.results.has(13), false);
    }
    assert.equal(parseCellRead({ response: { found: false } }, '2026-11-22'), null);
    assert.equal(parseCellRead({ response: '```json\n{"found":true,"cellText":"781 - A B, Blair, WI","ticketNumber":781,"name":"A B","town":"Blair, WI","townStatus":"readable","notes":""}\n```' }, '2026-11-22').ticketNumber, '781');
});

// ---- The month-wide scan: whole-table reads after tonight's decision, corrections only, for dates the window reads did not cover ----
const { monthCorrections, writeMonthScan, queueMonthScan, nextMonthScan, startMonthScan, finishMonthScan, decidedReads, MONTH_SCAN_ROW } = await import('../src/lib/server/raffle-photo-autopublish.ts');
const { readDates } = await import('../workers/facebook-photos/reads.ts');
/** A whole-table read of the Nov 24 cumulative table: every stored Nov 1-22 winner as printed, plus the real Nov 23 cells. */
function monthTable(schedule, change = {}) {
    const rows = before24.map(w => {
        const slot = schedule.find(p => p.id === w.prizeSlotId);
        const column = slot?.category === 'Main prize' ? 'Firearm' : slot?.category === 'Gift card' ? 'Gift Card' : null;
        const ticket = w.ticketNumber === null ? '' : String(w.ticketNumber);
        const r = cell(w.drawDate, column, ticket, w.name, w.town, column ? undefined : slot?.description ?? 'Bonus');
        return change[w.id] ? { ...r, ...change[w.id](r) } : r;
    });
    const nov23 = nov24.extractionPasses[0].rows.filter(r => r.drawDate === '2026-11-23');
    return [0, 1].map(() => ({ containsWinners: true, warnings: [], rows: structuredClone([...rows, ...nov23]) }));
}
const COVERED = readDates(DATE); // Nov 18-24: decided with tonight's winners from the window reads
const everyoneAutomated = Object.fromEntries(before24.map(w => [w.id, 'automated']));
const older = before24.find(w => w.drawDate === '2026-11-05' && w.ticketNumber && w.prizeSlotId);
const kuehl = before24.find(w => w.id === '2026-11-2026-11-12-377');
const retown = (town, cellTown = town) => r => ({ town, cellText: r.cellText.replace(/, [^,]+, [A-Za-z]{1,2}$/, `, ${cellTown}`) });
const cellOf = (w, town) => ({ drawDate: w.drawDate, position: null, ticketNumber: String(w.ticketNumber), ticketStatus: 'readable', name: w.name, town,
    townStatus: 'readable', prize: '', notes: '', cellText: `${w.ticketNumber} - ${w.name}, ${town}` });

test('month scan: an older winner (Nov 5, outside the window and the anchor dates) is corrected after the targeted re-read', async t => {
    const schedule = await calendar(t);
    assert.deepEqual(COVERED, ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
    // Unchanged table: every stored winner reads as stored, nothing is proposed, so no cell re-read is paid for.
    assert.deepEqual(townCorrectionTargets(monthCorrections(monthTable(schedule), stored(everyoneAutomated), schedule, DATE, COVERED)), []);
    const passes = monthTable(schedule, { [older.id]: retown('Holmen, WI') });
    const found = monthCorrections(passes, stored(everyoneAutomated), schedule, DATE, COVERED);
    assert.deepEqual(found.rows.map(d => [d.correction.winnerId, d.correction.from, d.correction.to, d.correction.fallback]), [[older.id, older.town, 'Holmen, WI', 'outside-window']]);
    const done = confirmTownCorrections(found, new Map([[found.rows[0].rowNumber, cellOf(older, 'Holmen, WI')]]));
    assert.equal(done.rows[0].outcome, 'correct');
    assert.equal(done.rows[0].reasons[0], `hometown corrected automatically by the photo importer, not by an administrator: “${older.town}” → “Holmen, WI”`);
    // Not confirmed: nothing at all is written for it (no hold, no rejection, no alert); the next night's table is scanned again.
    assert.notEqual(confirmTownCorrections(found, new Map([[found.rows[0].rowNumber, cellOf(older, older.town)]])).rows[0].outcome, 'correct');
    // Tonight's window decision is exactly as before: it never sees Nov 5, and new winners still publish only from the window.
    const tonight = decide(strip(nov24.extractionPasses), schedule, stored(everyoneAutomated));
    assert.deepEqual(counts(tonight), { insert: 2, duplicate: 12, held: 0, rejected: 1, correct: 0 });
    // Nothing from the month reads is ever an insert, hold or rejection, even rows that would be new winners.
    const fresh = monthCorrections(passes, stored(everyoneAutomated).filter(w => w.drawDate !== '2026-11-10'), schedule, DATE, COVERED);
    assert.ok(fresh.rows.every(d => d.correction));
});

test('month scan: window dates are left to the window decision, other months are ignored', async t => {
    const schedule = await calendar(t);
    // Ticket 781 (Nov 22) is inside tonight's 3-day publication window: the month scan neither proposes nor shows it (the window decision
    // rejects it for review, as before).
    assert.deepEqual(monthCorrections(monthTable(schedule, { [TROY]: retown(NEW) }), stored(), schedule, DATE, COVERED).rows, []);
    assert.deepEqual(monthCorrections(monthTable(schedule, { [TROY]: retown(NEW) }), stored(), schedule, DATE, []).rows, []);
    // An anchor date (Nov 19) was read with tonight's window, so only that decision may correct it; the month scan just shows the conflict.
    const anchor = before24.find(w => w.drawDate === '2026-11-19' && w.ticketNumber && w.prizeSlotId);
    const passes = monthTable(schedule, { [anchor.id]: retown('Holmen, WI') });
    const shown = monthCorrections(passes, stored(everyoneAutomated), schedule, DATE, COVERED);
    assert.deepEqual(shown.rows.map(d => [d.winnerId, d.outcome, !!d.correction, d.reasons[1]]),
        [[anchor.id, 'outside-window', false, "read with tonight's announcement window, whose decision did not correct it"]]);
    // Without the covered dates it would be a proposal (the same rule as the window path).
    assert.equal(townCorrectionTargets(monthCorrections(passes, stored(everyoneAutomated), schedule, DATE, [])).length, 1);
    // A December announcement never touches November winners.
    assert.deepEqual(monthCorrections(passes, stored(everyoneAutomated), schedule, '2026-12-01', []).rows, []);
});

test('month scan: older manual hometowns, identity conflicts, disagreement, warnings and bulk conflicts propose nothing', async t => {
    const schedule = await calendar(t);
    const none = (passes, label, existing = stored(everyoneAutomated)) =>
        assert.deepEqual(townCorrectionTargets(monthCorrections(passes, existing, schedule, DATE, COVERED)), [], label);
    // Nov 12 Kurt Kuehl was corrected by the owner from "Tomah, W" to "Tomah, WI": a table still printing the old spelling never undoes it.
    none(monthTable(schedule, { [kuehl.id]: retown('Tomah, W') }), 'manual Nov 12 correction', stored({ ...everyoneAutomated, [kuehl.id]: 'manual' }));
    // A hand-entered (unknown) older winner.
    none(monthTable(schedule, { [older.id]: retown('Holmen, WI') }), 'unknown source', stored({}));
    // Same ticket, another name.
    none(monthTable(schedule, { [older.id]: r => ({ ...retown('Holmen, WI')(r), name: 'Someone Else', cellText: `${older.ticketNumber} - Someone Else, Holmen, WI` }) }), 'name');
    // The two passes disagree on the new hometown.
    const split = monthTable(schedule, { [older.id]: retown('Holmen, WI') });
    split[1] = monthTable(schedule, { [older.id]: retown('Onalaska, WI') })[1];
    none(split, 'disagree');
    // The parsed hometown is not the copied cell's.
    none(monthTable(schedule, { [older.id]: retown('Holmen, WI', older.town) }), 'cell text');
    // Any image-wide warning in a month read.
    none(monthTable(schedule, { [older.id]: retown('Holmen, WI') }).map((p, i) => i ? p : { ...p, warnings: [{ scope: 'image', code: 'clipped', message: 'The right edge is cut off.' }] }), 'warning');
    // Formatting only.
    none(monthTable(schedule, { [older.id]: r => ({ town: older.town.toUpperCase().replace(', ', ','), cellText: r.cellText.toUpperCase() }) }), 'formatting');
    // Three older conflicts at once look like a misread column, not an edited spreadsheet.
    const three = before24.filter(w => w.drawDate < '2026-11-12' && w.ticketNumber && w.prizeSlotId).slice(0, 3);
    none(monthTable(schedule, Object.fromEntries(three.map(w => [w.id, retown('Elsewhere, MN')]))), 'three');
    assert.equal(townCorrectionTargets(monthCorrections(monthTable(schedule, Object.fromEntries(three.slice(0, 2).map(w => [w.id, retown('Elsewhere, MN')]))),
        stored(everyoneAutomated), schedule, DATE, COVERED)).length, 2);
});

test('D1: an older correction on an already decided photo is atomic, audited as automatic, and idempotent across nights', async t => {
    const DB = await database(t), schedule = await calendar(t);
    // The older winner was published by an earlier photo exactly as read; an administrator edited a different winner by hand.
    await DB.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json) VALUES (?,?,?,?,?,?,?)`)
        .bind('122334000000073310', 4, 'inserted', older.id, older.prize, '[]', JSON.stringify(cellOf(older, older.town))).run();
    const k = await winner(DB, kuehl.id);
    await DB.prepare(`INSERT INTO raffle_winner_corrections (winner_id, action, before_json, after_json) VALUES (?,?,?,?)`)
        .bind(kuehl.id, 'update', JSON.stringify({ ...k, town: 'Tomah, W' }), JSON.stringify({ drawDate: k.draw_date, name: k.winner_name, town: k.town, note: 'owner cleanup' })).run();
    // Tonight's photo is already decided and final.
    const { d } = await decided(DB, schedule);
    assert.equal(await writeDecision(DB, photo, d, true), 'published');
    const before = await DB.prepare(`SELECT status, updated_at FROM raffle_photo_auto_imports WHERE photo_id=?`).bind(nov24.photoId).first();
    const scan = async () => {
        const { existing } = await loadContext(DB, ['2026-11']);
        assert.equal(existing.find(w => w.id === kuehl.id).townSource, 'manual');
        const found = monthCorrections(monthTable(schedule, { [older.id]: retown('Holmen, WI') }), existing, schedule, DATE, COVERED);
        return confirmTownCorrections(found, new Map(found.rows.map(r => [r.rowNumber, cellOf(older, 'Holmen, WI')])));
    };
    const first = await scan();
    assert.equal(first.rows.length, 1);
    assert.deepEqual(await writeMonthScan(DB, nov24.photoId, first, 'correct', true), { corrected: 1, shown: 0 });
    assert.equal((await winner(DB, older.id)).town, 'Holmen, WI');
    // The photo's own decision and status are untouched; the correction is one more 'duplicate' row with readable reasons.
    assert.deepEqual(await DB.prepare(`SELECT status, updated_at FROM raffle_photo_auto_imports WHERE photo_id=?`).bind(nov24.photoId).first(), before);
    const row = await DB.prepare(`SELECT outcome, winner_id, reasons_json FROM raffle_photo_auto_rows WHERE photo_id=? AND winner_id=?`).bind(nov24.photoId, older.id).first();
    assert.equal(row.outcome, 'duplicate');
    assert.match(JSON.parse(row.reasons_json)[0], /^hometown corrected automatically by the photo importer, not by an administrator: /);
    // Correction history: the automatic rows name their source and photo; the administrator's rows have no source.
    const history = await corrections(DB);
    const auto = history.filter(c => JSON.parse(c.after_json).source === 'photo-auto');
    assert.deepEqual(auto.map(c => [c.winner_id, JSON.parse(c.before_json).town, JSON.parse(c.after_json).town, JSON.parse(c.after_json).photoId]).filter(c => c[0] === older.id),
        [[older.id, older.town, 'Holmen, WI', nov24.photoId]]);
    assert.deepEqual(history.filter(c => !JSON.parse(c.after_json).source).map(c => c.winner_id), [kuehl.id]);
    // Admin > Raffle > Photo imports (its API): the photo lists the correction as a completed row with who made it and old → new.
    const { GET: importsGet } = await import('../src/pages/api/admin/raffle/photo-imports.ts');
    const log = await (await importsGet({ locals: { runtime: { env: { DB } } } })).json();
    const shown = log.imports.find(i => i.photoId === nov24.photoId).rows.find(r => r.winnerId === older.id);
    assert.deepEqual([shown.outcome, shown.row.town], ['duplicate', 'Holmen, WI']);
    assert.equal(shown.reasons[0], `hometown corrected automatically by the photo importer, not by an administrator: “${older.town}” → “Holmen, WI”`);
    const count = (await corrections(DB)).length;
    // Repeats: the same write again, and the next night's scan of the same table, change and propose nothing.
    assert.deepEqual(await writeMonthScan(DB, nov24.photoId, first, 'correct', true), { corrected: 0, shown: 0 });
    assert.deepEqual((await scan()).rows, []);
    assert.equal((await corrections(DB)).length, count);
    // The Nov 12 manual hometown was never touched, and a dry run writes nothing.
    assert.equal((await winner(DB, kuehl.id)).town, kuehl.town);
    assert.deepEqual(await writeMonthScan(DB, nov24.photoId, first, 'correct', false), { corrected: 0, shown: 0 });
});

test('Photo imports: unconfirmed older conflicts are shown once, never as review items or alerts, and never change a winner', async t => {
    const DB = await database(t), schedule = await calendar(t);
    const k = await winner(DB, kuehl.id);
    await DB.prepare(`INSERT INTO raffle_winner_corrections (winner_id, action, before_json, after_json) VALUES (?,?,?,?)`)
        .bind(kuehl.id, 'update', JSON.stringify({ ...k, town: 'Tomah, W' }), JSON.stringify({ town: k.town, note: 'owner cleanup' })).run();
    const { d } = await decided(DB, schedule);
    assert.equal(await writeDecision(DB, photo, d, true), 'published');
    const statusBefore = await DB.prepare(`SELECT status, updated_at FROM raffle_photo_auto_imports WHERE photo_id=?`).bind(nov24.photoId).first();
    const winnersBefore = (await DB.prepare('SELECT * FROM raffle_winners ORDER BY id').all()).results;
    // The table still prints the owner-corrected Nov 12 hometown the old way, and an older hand-entered winner differently.
    const table = monthTable(schedule, { [kuehl.id]: retown('Tomah, W'), [older.id]: retown('Holmen, WI') });
    const night = async photoId => {
        const { existing } = await loadContext(DB, ['2026-11']);
        const found = monthCorrections(table, existing, schedule, DATE, COVERED);
        assert.deepEqual(townCorrectionTargets(found), []); // neither may be corrected, so no re-read is paid for
        await DB.prepare(`INSERT OR IGNORE INTO raffle_photo_auto_imports (photo_id, post_id, status) VALUES (?,?,'published')`).bind(photoId, nov24.postId).run();
        return writeMonthScan(DB, photoId, found, 'correct', true);
    };
    assert.deepEqual(await night(nov24.photoId), { corrected: 0, shown: 2 });
    const rows = (await DB.prepare(`SELECT outcome, winner_id, reasons_json FROM raffle_photo_auto_rows WHERE photo_id=? AND winner_id IN (?,?) ORDER BY row_number`)
        .bind(nov24.photoId, kuehl.id, older.id).all()).results;
    assert.deepEqual(rows.map(r => [r.outcome, r.winner_id, JSON.parse(r.reasons_json)]), [
        ['outside-window', older.id, [`older hometown differs from the stored winner; not corrected automatically: stored “${older.town}”, printed “Holmen, WI”`, 'the stored winner was not published from a winner photo exactly as read']],
        ['outside-window', kuehl.id, [`older hometown differs from the stored winner; not corrected automatically: stored “${kuehl.town}”, printed “Tomah, W”`, 'the stored hometown was edited by an administrator']]]);
    // Nothing changed: winners, the photo's status, and no held or rejected row, so no review item, resolution or alert.
    assert.deepEqual((await DB.prepare('SELECT * FROM raffle_winners ORDER BY id').all()).results, winnersBefore);
    assert.deepEqual(await DB.prepare(`SELECT status, updated_at FROM raffle_photo_auto_imports WHERE photo_id=?`).bind(nov24.photoId).first(), statusBefore);
    assert.equal((await DB.prepare(`SELECT count(*) AS n FROM raffle_photo_auto_rows WHERE outcome IN ('held','rejected')`).first()).n, 0);
    // The admin Photo imports API lists them with their reasons.
    const { GET: importsGet } = await import('../src/pages/api/admin/raffle/photo-imports.ts');
    const log = await (await importsGet({ locals: { runtime: { env: { DB } } } })).json();
    assert.equal(log.imports.find(i => i.photoId === nov24.photoId).rows.filter(r => r.outcome === 'outside-window' && /^older hometown differs/.test(r.reasons[0])).length, 2);
    // The next nights' cumulative tables show the same conflicts again: nothing is added, on this photo or on later ones.
    assert.deepEqual(await night(nov24.photoId), { corrected: 0, shown: 0 });
    assert.deepEqual(await night('122337700000073310'), { corrected: 0, shown: 0 });
    // A different printed hometown is a new conflict and is shown once.
    const again = monthCorrections(monthTable(schedule, { [older.id]: retown('Onalaska, WI') }), (await loadContext(DB, ['2026-11'])).existing, schedule, DATE, COVERED);
    assert.deepEqual(await writeMonthScan(DB, '122337700000073310', again, 'correct', true), { corrected: 0, shown: 1 });
});

test('the two-correction limit is shared by the window decision and the month scan of one photo', async t => {
    const schedule = await calendar(t);
    const olderTwo = before24.filter(w => w.drawDate < '2026-11-12' && w.ticketNumber && w.prizeSlotId).slice(0, 2);
    const table = monthTable(schedule, Object.fromEntries(olderTwo.map(w => [w.id, retown('Elsewhere, MN')])));
    const scan = windowProposed => monthCorrections(table, stored(everyoneAutomated), schedule, DATE, COVERED, windowProposed);
    // Alone, two older corrections fit the limit.
    assert.equal(townCorrectionTargets(scan(0)).length, 2);
    // Tonight's window decision already proposed one (Nov 24: ticket 781): together they would be three, so neither older one is
    // corrected; both are shown with the reason, and no re-read is paid for.
    const window = decide(strip(nov24.extractionPasses), schedule);
    assert.equal(townCorrectionTargets(window).length, 1);
    const shared = scan(townCorrectionTargets(window).length);
    assert.deepEqual(townCorrectionTargets(shared), []);
    assert.deepEqual(shared.rows.map(d => [d.winnerId, d.outcome, d.correction]), olderTwo.map(w => [w.id, 'outside-window', undefined]));
    assert.ok(shared.rows.every(d => d.reasons.at(-1) === "3 hometown corrections in one photo would exceed its limit of 2 (1 already proposed by tonight's window reads); review required"));
    // One window proposal plus one older one fits; two window proposals leave no room for any older one.
    const one = monthCorrections(monthTable(schedule, { [olderTwo[0].id]: retown('Elsewhere, MN') }), stored(everyoneAutomated), schedule, DATE, COVERED, 1);
    assert.equal(townCorrectionTargets(one).length, 1);
    const full = monthCorrections(monthTable(schedule, { [olderTwo[0].id]: retown('Elsewhere, MN') }), stored(everyoneAutomated), schedule, DATE, COVERED, 2);
    assert.deepEqual(townCorrectionTargets(full), []);
    // The window decision's own limit is unchanged (3 conflicts -> none), see the test above.
});

test('one month-wide scan per photo: queued once, taken by exactly one overlapping invocation; report-only mode and a lost race', async t => {
    const DB = await database(t), schedule = await calendar(t);
    const job = { photoId: nov24.photoId, postId: nov24.postId, announcementDate: DATE, windowProposed: 1 };
    // A photo that is not decided yet (only its checkpoint exists) cannot be queued.
    await DB.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status) VALUES ('122337800000073310', ?, 'failed')`).bind(nov24.postId).run();
    assert.equal(await queueMonthScan(DB, { ...job, photoId: '122337800000073310' }), false);
    assert.equal(await nextMonthScan(DB), null);
    const { d } = await decided(DB, schedule);
    await writeDecision(DB, photo, d, true);
    // Queued once, however often the decision path runs; the queue entry carries what the later invocation needs.
    assert.deepEqual(await Promise.all([queueMonthScan(DB, job), queueMonthScan(DB, job)]).then(r => r.filter(Boolean).length), 1);
    assert.deepEqual(await nextMonthScan(DB), job);
    // Overlapping invocations race for it: exactly one takes it; then it is no longer queued for anyone.
    const takes = await Promise.all([startMonthScan(DB, nov24.photoId), startMonthScan(DB, nov24.photoId), startMonthScan(DB, nov24.photoId)]);
    assert.equal(takes.filter(Boolean).length, 1);
    assert.equal(await startMonthScan(DB, nov24.photoId), false);
    assert.equal(await nextMonthScan(DB), null);
    assert.equal(await queueMonthScan(DB, job), false); // a finished or running scan is never queued again
    // The stored image hash and reads the scan reuses (and compares with the image Facebook serves then).
    const kept = await decidedReads(DB, nov24.photoId);
    assert.deepEqual([kept.sha256, kept.reads.map(r => r.read.kind)], [nov24.sha256, ['window', 'window']]);
    await finishMonthScan(DB, nov24.photoId, '73 cells read; 0 hometown(s) corrected; 0 new conflict(s) shown');
    const claim = await DB.prepare(`SELECT outcome, reasons_json FROM raffle_photo_auto_rows WHERE photo_id=? AND row_number=?`).bind(nov24.photoId, MONTH_SCAN_ROW).first();
    assert.deepEqual([claim.outcome, JSON.parse(claim.reasons_json)], ['outside-window', ['month-wide hometown check: 73 cells read; 0 hometown(s) corrected; 0 new conflict(s) shown']]);
    // Report-only mode: a confirmed older correction is shown, not written.
    await DB.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json) VALUES (?,?,?,?,?,?,?)`)
        .bind('122334000000073310', 4, 'inserted', older.id, older.prize, '[]', JSON.stringify(cellOf(older, older.town))).run();
    const confirm = async () => { const found = monthCorrections(monthTable(schedule, { [older.id]: retown('Holmen, WI') }), (await loadContext(DB, ['2026-11'])).existing, schedule, DATE, COVERED);
        return confirmTownCorrections(found, new Map(found.rows.map(r => [r.rowNumber, cellOf(older, 'Holmen, WI')]))); };
    const report = await confirm();
    assert.equal(report.rows[0].outcome, 'correct');
    assert.deepEqual(await writeMonthScan(DB, nov24.photoId, report, 'report', true), { corrected: 0, shown: 1 });
    assert.equal((await winner(DB, older.id)).town, older.town);
    assert.match((await DB.prepare(`SELECT reasons_json FROM raffle_photo_auto_rows WHERE photo_id=? AND winner_id=? AND row_number>?`).bind(nov24.photoId, older.id, MONTH_SCAN_ROW).first()).reasons_json, /report-only mode/);
    // A lost race (the hometown changed between decision and write) is shown as a conflict, never a rejection for review.
    const live = await confirm();
    await DB.prepare(`UPDATE raffle_winners SET town='Arcadia, WI' WHERE id=?`).bind(older.id).run();
    await writeMonthScan(DB, '122337700000073310', live, 'correct', true);
    assert.equal((await winner(DB, older.id)).town, 'Arcadia, WI');
    assert.deepEqual((await DB.prepare(`SELECT outcome FROM raffle_photo_auto_rows WHERE photo_id='122337700000073310'`).all()).results.map(r => r.outcome), ['outside-window']);
    assert.equal((await DB.prepare(`SELECT count(*) AS n FROM raffle_photo_auto_rows WHERE outcome IN ('held','rejected')`).first()).n, 0);
});

test('Worker: no month-scan or cell read starts after the invocation deadline', async t => {
    const { extractMonthPasses, rereadTownCells } = await import('../workers/facebook-photos/reads.ts');
    const DB = await database(t);
    let calls = 0;
    const AI = { async run() { calls++; return { response: { containsWinners: true, rows: [], warnings: [] } }; } };
    const context = { postId: nov24.postId, photoId: nov24.photoId, attempt: null };
    const past = Date.now() - 1;
    assert.equal((await extractMonthPasses({ DB, AI }, new Uint8Array([255, 216, 1]), 'image/jpeg', DATE, context, null, true, [], past)).passes, null);
    const cells = await rereadTownCells({ DB, AI }, new Uint8Array([255, 216, 1]), 'image/jpeg', context, null, true,
        [{ rowNumber: 1, drawDate: '2026-11-05', ticketNumber: '1', name: 'A B' }], [], past);
    assert.deepEqual([calls, cells.results.size], [0, 0]);
});

test('Worker: month-scan reads are whole-table reads, reuse earlier reads, are kept with the photo, and never throw', async t => {
    const { extractMonthPasses } = await import('../workers/facebook-photos/reads.ts');
    const DB = await database(t), schedule = await calendar(t);
    const context = { postId: nov24.postId, photoId: nov24.photoId, attempt: null };
    const image = { sha256: nov24.sha256, width: nov24.width, height: nov24.height };
    const table = monthTable(schedule);
    const ai = (reply) => { const calls = []; return { calls, AI: { async run(model, input) { calls.push({ prompt: input.messages[0].content[0].text, max: input.max_tokens });
        if (reply instanceof Error) throw reply; return reply; } } }; };
    await DB.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status, image_sha256, extraction_json) VALUES (?,?,'published',?,?)`)
        .bind(nov24.photoId, nov24.postId, nov24.sha256, JSON.stringify(nov24.extractionPasses)).run();
    const ok = ai({ response: table[0], usage: { prompt_tokens: 2600, completion_tokens: 6000 } }), reads = structuredClone(nov24.extractionPasses);
    const got = await extractMonthPasses({ DB, ...ok }, new Uint8Array([255, 216, 1]), 'image/jpeg', DATE, context, image, true, reads);
    assert.deepEqual([got.passes.length, got.aiCalls, got.reused, ok.calls.length], [2, 2, 0, 2]);
    assert.ok(ok.calls.every(c => !c.prompt.startsWith('This image is a raffle winner table') && c.max === 16384), 'whole-table prompt and token cap');
    assert.equal(got.passes[0].rows.length, table[0].rows.length);
    const kept = JSON.parse((await DB.prepare(`SELECT extraction_json FROM raffle_photo_auto_imports WHERE photo_id=?`).bind(nov24.photoId).first()).extraction_json);
    assert.deepEqual(kept.map(r => r.read.kind), ['window', 'window', 'table', 'table']);
    // Reads already made (for example the window step's whole-table fallback) are reused, not paid again.
    const again = ai(Error('must not run'));
    const reusedRun = await extractMonthPasses({ DB, ...again }, new Uint8Array([255, 216, 1]), 'image/jpeg', DATE, context, image, true, kept);
    assert.deepEqual([again.calls.length, reusedRun.reused, reusedRun.passes.length], [0, 2, 2]);
    // Quota refusal, outage and an unparseable reply end the scan quietly.
    for (const reply of [Error('4006: you have used up your daily free allocation of 10,000 neurons'), Error('ai-unavailable'), { response: 'cut off {' }]) {
        const r = await extractMonthPasses({ DB, ...ai(reply) }, new Uint8Array([255, 216, 1]), 'image/jpeg', DATE, context, image, true, structuredClone(nov24.extractionPasses));
        assert.equal(r.passes, null);
    }
});
