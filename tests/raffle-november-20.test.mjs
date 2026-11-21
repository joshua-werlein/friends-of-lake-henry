import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { decidePhoto, parseCell, printedName, reasonCode, rowDiagnostics, loadContext, writeDecision } from '../src/lib/server/raffle-photo-autopublish.ts';
import { readDates } from '../workers/facebook-photos/reads.ts';
import { asStored, assertTrue, calendar, day, events, fixture, futureTruth, inserted, read, slots, storedThrough11, tonight as truthTonight } from './november-table.mjs';

// November 20, 2026 (incident photo:review:122336881070073310). Both production window reads returned the bonus cell
// "Bubba Filet Knife - 628 - John Wickum, Wilson, WI" correctly, ticket 628 included: the first labelled cell with a ticket. The
// printed-name check knew only "ticket - name", "name" and "label - name", read the name as "628 - John Wickum" and held the row.
// The reads and stored winners below are the production records; nothing here calls a model.
const { winners } = await fixture('november-2026-winners-through-20.json');
const nov20 = await fixture('facebook-winners-2026-11-20.extraction.json');
const DATE = '2026-11-20';
const KNIFE = 'event-bonus:2026-11-20-day-20-smith-and-wesson-500-s-w-magnum';
const FIREARM = 'event:2026-11-20-day-20-smith-and-wesson-500-s-w-magnum';
const GIFT = 'daily:2026-11-20:0';
const CELL = 'Bubba Filet Knife - 628 - John Wickum, Wilson, WI';
const before = date => winners.filter(w => w.drawDate < date);
const passes = () => structuredClone(nov20.extractionPasses);
/** Both passes with the bonus cell changed; `only` changes a single pass. */
const bonus = (change, only = null) => passes().map((p, i) => ({ ...p, rows: p.rows.map(r => r.ticketNumber === '628' && (only === null || only === i) ? { ...r, ...change } : r) }));
const tonight = d => d.rows.filter(r => r.row.drawDate === DATE);
const outcomes = d => tonight(d).map(r => [r.outcome, r.row.name, r.prizeSlotId ?? null]);
const knifeRow = d => d.rows.find(r => r.row.name === 'John Wickum' || r.row.ticketNumber === '628' || (r.row.cellText ?? '').includes('Knife -'));

test('the cell grammar reads label, ticket and name in every known form', () => {
    const cases = [
        ['025 - Jason Haen, LaCrosse, WI', { label: null, ticket: '025', name: 'Jason Haen' }],
        ['797 -JJ Demaske, Melrose, WI', { label: null, ticket: '797', name: 'JJ Demaske' }],
        ['#797-JJ Demaske, Melrose, WI', { label: null, ticket: '797', name: 'JJ Demaske' }],
        ['Blackstone - Mike Loeser, Osseo, WI', { label: 'Blackstone', ticket: null, name: 'Mike Loeser' }],
        [CELL, { label: 'Bubba Filet Knife', ticket: '628', name: 'John Wickum' }],
        ['Bubba Filet Knife - 628 -John Wickum, Wilson, WI', { label: 'Bubba Filet Knife', ticket: '628', name: 'John Wickum' }],
        ['Gift Card - 540 - Tallie Everson, Brodhead, WI', { label: 'Gift Card', ticket: '540', name: 'Tallie Everson' }],
        ['Black Stone 28" Griddle - Mike Loeser, Osseo, WI', { label: 'Black Stone 28" Griddle', ticket: null, name: 'Mike Loeser' }],
        ['2nd Drawing - Kent Johnson, Blair, WI', { label: '2nd Drawing', ticket: null, name: 'Kent Johnson' }],
        ['797 - Mary Smith-Jones, Blair, WI', { label: null, ticket: '797', name: 'Mary Smith-Jones' }],
        ['Mary Smith-Jones, Blair, WI', { label: null, ticket: null, name: 'Mary Smith-Jones' }],
        ['412 - BAMS', { label: null, ticket: '412', name: undefined }],
        // Not separators: a label dash with uneven spacing, a colon, a number with no dash.
        ['Life Jacket -JJ Demaske, Melrose, WI', { label: null, ticket: null, name: 'Life Jacket -JJ Demaske' }],
        ['797: JJ Demaske, Melrose, WI', { label: null, ticket: null, name: '797: JJ Demaske' }],
        // A label after the ticket is not a known form: the "name" keeps it and never matches.
        ['628 - Bubba Filet Knife - John Wickum, Wilson, WI', { label: null, ticket: '628', name: 'Bubba Filet Knife - John Wickum' }],
    ];
    for (const [cell, want] of cases) {
        const { label, ticket, name } = parseCell(cell);
        assert.deepEqual({ label, ticket, name }, want, cell);
    }
    // Only the extracted ticket's own digits are stripped.
    assert.equal(printedName(CELL, '628'), 'John Wickum');
    assert.equal(printedName(CELL, '629'), '628 - John Wickum');
    assert.equal(printedName('Bubba Filet Knife - 1628 - John Wickum, Wilson, WI', '628'), '1628 - John Wickum');
});

test('November 20 production reads: all three winners publish, the bonus as the Bubba Fillet Knife with ticket 628', async t => {
    const schedule = await calendar(t);
    const [a, b] = nov20.extractionPasses.map(p => p.rows.find(r => r.ticketNumber === '628'));
    assert.deepEqual(a, b, 'both production passes read the cell identically');
    assert.deepEqual([a.cellText, a.name, a.town, a.prize, a.ticketStatus], [CELL, 'John Wickum', 'Wilson, WI', 'Bubba Filet Knife', 'readable']);
    const d = decidePhoto(passes(), before(DATE), schedule, DATE);
    assert.equal(d.status, 'published', JSON.stringify(tonight(d).map(r => r.reasons)));
    assert.deepEqual(outcomes(d), [['insert', 'Jason Haen', FIREARM], ['insert', 'Tallie Everson', GIFT], ['insert', 'John Wickum', KNIFE]]);
    const knife = knifeRow(d);
    // The same id and prize text the administrator's manual publication stored, so a later run recognises it.
    const stored = winners.find(w => w.prizeSlotId === KNIFE);
    assert.deepEqual([knife.winnerId, knife.prize], [stored.id, stored.prize]);
    assert.deepEqual([knife.winnerId, knife.prize], ['2026-11-2026-11-20-628', 'Bonus — Bubba Fillet Knife']);
    assert.ok(knife.reasons.includes(`prize matches approved calendar entry ${KNIFE}`));
    assert.equal(d.rows.filter(r => r.row.drawDate < DATE).every(r => r.outcome === 'duplicate'), true, 'every earlier cell is a stored winner');
    assert.equal(d.rows.some(r => /no winner was read/.test(r.reasons.join(' '))), false);
});

test('November 20 duplicates: a requeue or redelivery never writes a winner twice', async t => {
    const schedule = await calendar(t);
    // As production stands (all three stored, the bonus by an administrator): nothing is written.
    const now = decidePhoto(passes(), winners, schedule, DATE);
    assert.equal(now.status, 'duplicate');
    assert.equal(inserted(now).length, 0);
    // As production stood at the hold (firearm and gift card stored): a requeue adds only the bonus, then nothing.
    const atHold = winners.filter(w => w.prizeSlotId !== KNIFE);
    const requeue = decidePhoto(passes(), atHold, schedule, DATE);
    assert.deepEqual(inserted(requeue).map(r => [r.row.name, r.prizeSlotId]), [['John Wickum', KNIFE]]);
    assert.equal(inserted(decidePhoto(passes(), [...atHold, ...asStored(requeue)], schedule, DATE)).length, 0);
    // An administrator deleted it after this photo published it: it is not brought back.
    const removed = decidePhoto(passes(), atHold, schedule, DATE, { removedWinnerIds: new Set(['2026-11-2026-11-20-628']) });
    assert.equal(knifeRow(removed).outcome, 'held');
    assert.match(knifeRow(removed).reasons.join(' '), /administrator removed it/);
    // Another winner already holds the bonus slot: rejected, never overwritten.
    const other = [...atHold, { id: '2026-11-2026-11-20-slot-x', drawDate: DATE, ticketNumber: null, name: 'Someone Else', town: 'Blair, WI', prize: 'Bonus — Bubba Fillet Knife', prizeSlotId: KNIFE }];
    assert.equal(knifeRow(decidePhoto(passes(), other, schedule, DATE)).outcome, 'rejected');
});

test('November 20 label spellings: verified variants of the approved prize publish, other prizes and added words do not', async t => {
    const schedule = await calendar(t);
    for (const label of ['Bubba Filet Knife', 'Bubba Fillet Knife', 'BUBBA FILET KNIFE', 'Fillet Knife', 'Bubba Filet knife']) {
        const d = decidePhoto(bonus({ prize: label, cellText: CELL.replace('Bubba Filet Knife', label) }), before(DATE), schedule, DATE);
        assert.deepEqual([knifeRow(d).outcome, knifeRow(d).prizeSlotId], ['insert', KNIFE], label);
    }
    // The model copied the column heading "Bonus" into prize: the cell's label still has to name the same prize.
    const heading = decidePhoto(bonus({ prize: 'Bonus' }), before(DATE), schedule, DATE);
    assert.deepEqual([knifeRow(heading).outcome, knifeRow(heading).prizeSlotId], ['insert', KNIFE]);
    // The ticketless form of the same cell, as on Nov 13-15, still publishes under the slot id.
    const ticketless = decidePhoto(bonus({ ticketNumber: '', ticketStatus: 'blank', cellText: 'Bubba Filet Knife - John Wickum, Wilson, WI' }), before(DATE), schedule, DATE);
    assert.deepEqual([knifeRow(ticketless).outcome, knifeRow(ticketless).prizeSlotId], ['insert', KNIFE]);

    const held = (change, only = null) => { const d = decidePhoto(bonus(change, only), before(DATE), schedule, DATE);
        assert.equal(inserted(d).some(r => r.prizeSlotId === KNIFE), false, JSON.stringify(change)); return knifeRow(d); };
    const LABEL = 'the prize label printed in the cell does not name the extracted prize';
    // The cell is labelled for another prize while the extraction says knife, in both passes or in one.
    assert.ok(held({ cellText: CELL.replace('Bubba Filet Knife', 'Ice Augur') }).reasons.includes(LABEL));
    assert.ok(held({ cellText: CELL.replace('Bubba Filet Knife', 'Ice Augur') }, 1).reasons.includes(LABEL));
    // Added words, a different word that shares a letter pattern, and a near-miss spelling below 5 letters.
    for (const label of ['Bubba Knife Sharpener', 'Bubba Fillet Knives Set', 'Bubba Flat Knife'])
        assert.ok(held({ prize: label, cellText: CELL.replace('Bubba Filet Knife', label) }).reasons.some(r => r === LABEL || /must identify exactly one/.test(r)), label);
    // Prize matching itself is unchanged: "Filet Knife" shares only one of the three words of Bubba Fillet Knife, so it stays held.
    held({ prize: 'Filet Knife', cellText: CELL.replace('Bubba Filet Knife', 'Filet Knife') });
    // The label names another night's prize: it is never published as tonight's knife.
    held({ prize: 'Ice Augur', cellText: CELL.replace('Bubba Filet Knife', 'Ice Augur') });
});

test('November 20 wrong or ambiguous cells are held with a reason that says what is wrong, and never name the winner', async t => {
    const schedule = await calendar(t);
    const decide = (change, only) => knifeRow(decidePhoto(bonus(change, only), before(DATE), schedule, DATE));
    const cases = [
        // Genuine extraction errors.
        [{ name: 'Wickum' }, 'name differs from the name printed in the cell'],
        [{ name: 'John' }, 'name differs from the name printed in the cell'],
        [{ name: 'John Wickum Wilson' }, 'name differs from the name printed in the cell'],
        [{ name: 'Jon Wickum' }, 'name is not in the cell text'],
        [{ ticketNumber: '629' }, 'ticket number is not in the cell text'],
        [{ cellText: CELL.replace('628', '1628') }, 'ticket number is not in the cell text'],
        [{ cellText: 'Bubba Filet Knife - 629 - John Wickum, Wilson, WI 628' }, 'ticket number differs from the ticket printed in the cell'],
        [{ ticketNumber: '', ticketStatus: 'blank' }, 'cell text shows a ticket number that was not extracted'],
        [{ town: 'Blair, WI' }, 'hometown is not in the cell text'],
        // Layouts the parser does not know: reported as such, not as a wrong name.
        [{ cellText: '628 - Bubba Filet Knife - John Wickum, Wilson, WI' }, 'cell layout not recognised'],
        [{ cellText: 'Bubba Filet Knife - John Wickum 628, Wilson, WI' }, 'cell layout not recognised'],
        // The passes disagree.
        [{ name: 'John Wickam', cellText: CELL.replace('Wickum', 'Wickam') }, 'extraction passes disagree on name', 1],
        [{ ticketNumber: '629', cellText: CELL.replace('628', '629') }, 'extraction passes disagree on ticketNumber', 1],
        // A neighbour's name read with this cell.
        [{ name: 'Other Person', cellText: CELL + ' 629 - Other Person, Blair, WI' }, 'name differs from the name printed in the cell'],
    ];
    for (const [change, reason, only = null] of cases) {
        const d = decidePhoto(bonus(change, only), before(DATE), schedule, DATE);
        assert.equal(inserted(d).some(r => r.prizeSlotId === KNIFE || r.row.ticketNumber === '628' || r.row.ticketNumber === '629'), false, JSON.stringify(change));
        const all = d.rows.filter(r => r.row.drawDate === DATE && r.outcome !== 'insert').flatMap(r => r.reasons);
        assert.ok(all.some(r => r.startsWith(reason)), `${JSON.stringify(change)}: ${JSON.stringify(all)}`);
        // Reasons reach alert emails and incident records: no winner name, and the logged code drops anything after a colon.
        assert.equal(all.some(r => /Wickum|Wickam|Other Person/.test(r)), false, JSON.stringify(all));
        for (const r of d.rows) assert.equal(JSON.stringify(rowDiagnostics(r)).includes('Wickum'), false);
    }
    assert.equal(reasonCode('cell layout not recognised: the text before the name is neither the ticket nor a prize label in a known form; review required'), 'cell-layout-not-recognised');
    // The bonus ticket read as the firearm's ticket: both cells are held, neither is guessed.
    const twice = decidePhoto(bonus({ ticketNumber: '025', cellText: CELL.replace('628', '025') }), before(DATE), schedule, DATE);
    assert.deepEqual(outcomes(twice).map(([o, n]) => [o, n]), [['held', 'Jason Haen'], ['insert', 'Tallie Everson'], ['held', 'John Wickum']]);
});

test('two bonus prizes on one night each publish to their own slot; swapped labels are held', async t => {
    const schedule = await calendar(t);
    const knife = schedule.find(p => p.id === KNIFE);
    const shelter = { ...knife, id: 'supplement:2026-11-20-ice-shelter', description: 'Eskimo Ice Shelter', source: 'supplement' };
    const two = [...schedule, shelter];
    const second = { drawDate: DATE, position: null, ticketNumber: '', ticketStatus: 'blank', name: 'Ruth Lund', town: 'Blair, WI', townStatus: 'readable',
        notes: '', prize: 'Ice Shelter', cellText: 'Ice Shelter - Ruth Lund, Blair, WI' };
    const withSecond = (cell = {}) => passes().map(p => ({ ...p, rows: [...p.rows, { ...second, ...cell }] }));
    const d = decidePhoto(withSecond(), before(DATE), two, DATE);
    assert.equal(d.status, 'published', JSON.stringify(tonight(d).map(r => r.reasons)));
    assert.deepEqual(outcomes(d), [['insert', 'Jason Haen', FIREARM], ['insert', 'Tallie Everson', GIFT], ['insert', 'John Wickum', KNIFE], ['insert', 'Ruth Lund', shelter.id]]);
    // The second winner's cell carries the knife's label: held, and the knife is not given away twice.
    const swapped = decidePhoto(withSecond({ cellText: 'Bubba Filet Knife - Ruth Lund, Blair, WI' }), before(DATE), two, DATE);
    assert.deepEqual(outcomes(swapped).filter(([, n]) => n === 'Ruth Lund').map(([o]) => o), ['held']);
    assert.equal(inserted(swapped).filter(r => r.prizeSlotId === KNIFE).length, 1);
    // A heading that fits either bonus names neither.
    const heading = decidePhoto(withSecond({ prize: 'Bonus', cellText: 'Bonus - Ruth Lund, Blair, WI' }), before(DATE), two, DATE);
    assert.equal(inserted(heading).some(r => r.row.name === 'Ruth Lund'), false);
});

test('window reads Nov 12–30 with tickets printed on bonus cells publish exactly each night\'s winners, once', async t => {
    const schedule = await calendar(t);
    for (const realistic of [false, true]) {
        const truth = futureTruth(schedule, { bonusTickets: true, realistic });
        assert.ok(truth.some(r => r.prize !== 'Firearm' && r.prize !== 'Gift Card' && r.ticketNumber && / - \d+ - /.test(r.cellText)), 'the simulation prints bonus tickets');
        const windowRead = n => { const dates = new Set(readDates(day(n))); const p = read(n, truth); return { ...p, rows: p.rows.filter(r => dates.has(r.drawDate)) }; };
        let stored = [...storedThrough11];
        for (let n = 12; n <= 30; n++) {
            const d = decidePhoto([windowRead(n), windowRead(n)], stored, schedule, day(n));
            assertTrue(d, truth);
            assert.equal(d.status, 'published', `Nov ${n}: ${JSON.stringify(d.rows.filter(r => r.outcome === 'held' || r.outcome === 'rejected').map(r => [r.row.drawDate, r.row.cellText, r.reasons]))}`);
            assert.deepEqual(slots(d), truthTonight(truth, n), `Nov ${n}`);
            stored = [...stored, ...asStored(d)];
            assert.equal(inserted(decidePhoto([windowRead(n), windowRead(n)], stored, schedule, day(n))).length, 0, `Nov ${n} repeated`);
        }
        const ids = stored.map(w => w.id);
        assert.equal(new Set(ids).size, ids.length);
        assert.equal(stored.length, storedThrough11.length + truth.length);
    }
});

test('November 20 through D1: earlier winners are untouched and the three winners are written once', async t => {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    for (const name of ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '009_raffle_season_calendar.sql', '004_raffle_photo_autopublish.sql', '005_winner_ticket_text.sql', '006_bonus_winner_tickets.sql', '007_photo_import_diagnostics.sql']) {
        const sql = (await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');
        for (const s of sql.split(';').filter(v => v.trim())) await DB.prepare(s).run();
    }
    for (const e of events) await DB.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id, e.title, e.kind ?? 'raffle', e.status, e.date_start, e.summary ?? null).run();
    for (const w of before(DATE)) await DB.prepare('INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town,prize,ticket_number_text,prize_slot_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .bind(w.id, '2026-11', w.drawDate, w.ticketNumber, w.name, w.town, w.prize, w.ticketNumber === null ? null : String(w.ticketNumber), w.prizeSlotId).run();
    const stored = async () => (await DB.prepare('SELECT id, draw_date AS drawDate, ticket_number AS ticketNumber, winner_name AS name, town, prize, prize_slot_id AS prizeSlotId FROM raffle_winners ORDER BY draw_date, id').all()).results;
    const original = await stored();
    const photo = { photoId: nov20.photoId, postId: nov20.postId, sha256: nov20.sha256, width: 1159, height: 556, model: nov20.model, passes: passes() };
    for (let run = 1; run <= 3; run++) {
        const { existing, schedule } = await loadContext(DB, ['2026-11']);
        const d = decidePhoto(passes(), existing, schedule, DATE);
        assert.equal(d.status, run === 1 ? 'published' : 'duplicate', `run ${run}`);
        assert.equal(inserted(d).length, run === 1 ? 3 : 0, `run ${run}`);
        // The import keeps its 'published' status: the run that inserted the winners stays on record across requeues.
        assert.equal(await writeDecision(DB, photo, d, true), 'published', `run ${run}`);
        const now = await stored();
        assert.deepEqual(now.filter(w => w.drawDate < DATE), original, `run ${run}: earlier winners unchanged`);
        assert.deepEqual(now.filter(w => w.drawDate === DATE).map(w => [w.id, w.name, w.town, w.ticketNumber, w.prize, w.prizeSlotId]).sort(),
            winners.filter(w => w.drawDate === DATE).map(w => [w.id, w.name, w.town, w.ticketNumber, w.prize, w.prizeSlotId]).sort(), `run ${run}: same as production`);
        await DB.prepare(`UPDATE raffle_photo_auto_imports SET status='failed' WHERE photo_id=?`).bind(nov20.photoId).run(); // as a requeue
    }
});
