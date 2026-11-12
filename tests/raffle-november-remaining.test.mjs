import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { decidePhoto, calendarDate } from '../src/lib/server/raffle-photo-autopublish.ts';
import { prizeSchedule } from '../src/lib/server/raffle-prizes.ts';

// Every remaining November 2026 drawing (Nov 12–30), simulated as the Page posts it: one cumulative table per night with a row per
// date, a Firearm column, a Gift Card column and a headingless bonus column whose few cells carry their own labels. Prizes come
// from the approved calendar (published events + the poster's daily gift certificate), never from assumptions about the night.
// The history is the real stored Nov 1–11 winners; the cells are the real Nov 11 reads. The AI failure modes are the ones seen in
// production on Nov 8–11 (sparse bonus cells read one or two rows late, a layout remark from one pass) plus adversarial ones.
const fixture = name => readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8').then(JSON.parse);
const { events } = await fixture('november-2026-published-raffle-events.json');
const { winners: storedThrough11 } = await fixture('november-2026-winners-through-11.json');
const nov11 = await fixture('facebook-winners-2026-11-11.extraction.json');

async function calendar(t) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    // Migration 009 (approved calendars, reviewed recurring prizes) exists only once the future-season code is merged. It records
    // November 2026 exactly as production computes it without 009, so the same expectations hold on both schemas.
    for (const name of ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '009_raffle_season_calendar.sql']) {
        const file = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8').catch(e => { if (e.code === 'ENOENT' && name.startsWith('009')) return null; throw e; });
        if (file === null) continue;
        for (const s of file.replace(/--[^\n]*/g, '').split(';').filter(v => v.trim())) await DB.prepare(s).run();
    }
    for (const e of events) await DB.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id, e.title, e.kind ?? 'raffle', e.status, e.date_start, e.summary ?? null).run();
    return prizeSchedule(DB, '2026-11');
}

const day = n => `2026-11-${String(n).padStart(2, '0')}`;
// Short labels as the Page writes bonus cells ("Cutting Board", "Paddle board"), including one-word and joined forms.
const LABELS = { 13: 'Panfish Rod', 14: 'Walleye Rod', 15: 'Griddle', 20: 'Fillet Knife', 21: 'Ice Augur', 22: 'Fish Finder',
    26: 'Gun Safe', 27: 'Chain Saw', 28: 'Life Jacket', 29: 'Gun Vise' };
const cell = (date, column, ticket, name, town, label) => ({ drawDate: date, position: null, ticketNumber: ticket, ticketStatus: ticket ? 'readable' : 'blank',
    name, town, townStatus: town ? 'readable' : 'blank', prize: label ?? column, notes: '',
    cellText: (label ? `${label} - ` : ticket ? `${ticket} - ` : '') + name + (town ? `, ${town}` : '') });

// The truth for Nov 12–30: one winner per approved slot, with repeat winners mixed in (a gift card and a bonus won again by stored
// winners, a stored ticket drawn again for a firearm).
function futureTruth(schedule) {
    const truth = [];
    let ticket = 400;
    for (let n = 12; n <= 30; n++) for (const p of schedule.filter(p => p.drawDate === day(n))) {
        const column = p.category === 'Main prize' ? 'Firearm' : p.category === 'Gift card' ? 'Gift Card' : null;
        let who = { name: `Winner ${n}${column === 'Firearm' ? 'F' : column ? 'G' : 'B'}`, town: n % 2 ? 'Blair, WI' : 'Taylor, WI', ticket: String(ticket++) };
        if (n === 16 && column === 'Gift Card') who = { name: 'Gary Gran', town: 'Osseo, WI', ticket: '105' };
        if (n === 20 && !column) who = { name: 'John Kraemer', town: 'Neillsville, WI', ticket: '' };
        if (n === 25 && column === 'Firearm') who = { name: 'Dennis McHenry', town: 'LaCrosse, WI', ticket: '698' };
        if (!column) who.ticket = '';
        truth.push({ slot: p.id, ...cell(day(n), column, who.ticket, who.name, who.town, column ? undefined : LABELS[n]) });
    }
    return truth;
}
// Nov 1–11 exactly as the real Nov 11 pass read the Firearm and Gift Card cells, with the bonus cells on their true rows.
const BONUS_HISTORY = [cell(day(6), null, '', 'Kent Johnson', 'Blair, Wi', 'Cutting Board'), cell(day(7), null, '', 'Gage Everson', 'Independence, WI', 'Meat Bundle'),
    cell(day(8), null, '', 'John Kraemer', 'Neillsville, WI', 'Paddle board')];
const history = [...nov11.extractionPasses[0].rows.filter(r => r.ticketNumber || r.prize === 'Gift Card'), ...BONUS_HISTORY];

const sorted = rows => rows.sort((a, b) => a.drawDate.localeCompare(b.drawDate));
/** The cumulative table posted on night `n`, read by one AI pass with the given failure modes. */
function read(n, truth, mode = {}) {
    let rows = [...history, ...truth.filter(r => r.drawDate <= day(n))].map(({ slot, ...r }) => ({ ...r }));
    const isBonus = r => !r.ticketNumber && r.prize !== 'Gift Card';
    // Sparse bonus cells read k rows late (never past the last row), as on Nov 9–11.
    if (mode.bonusLate) rows = rows.map(r => isBonus(r) ? { ...r, drawDate: day(Math.min(n, Number(r.drawDate.slice(8)) + mode.bonusLate)) } : r);
    if (mode.dropOldBonus) rows = rows.filter(r => !isBonus(r) || r.drawDate >= day(n - 1));
    if (mode.dropTonight) rows = rows.filter(r => !(r.drawDate === day(n) && mode.dropTonight(r)));
    if (mode.changeTonight) rows = rows.map(r => r.drawDate === day(n) && mode.changeTonight.match(r) ? { ...r, ...mode.changeTonight.to(r) } : r);
    // The whole Firearm column read one row late: every cell lands on the next date and tonight's falls off.
    if (mode.firearmLate) rows = rows.filter(r => !(r.prize === 'Firearm' && r.drawDate === day(n)))
        .map(r => r.prize === 'Firearm' ? { ...r, drawDate: day(Number(r.drawDate.slice(8)) + 1) } : r);
    const warnings = mode.warning ? [{ scope: 'image', code: mode.warning, drawDate: '', ticketNumber: '', name: '',
        message: mode.warning === 'clipped' ? 'The right edge is cut off.' : 'The layout of the table is ambiguous, with multiple prize columns and no clear association between dates and prizes.' }] : [];
    return { containsWinners: true, rows: sorted(rows), warnings };
}
const inserted = d => d.rows.filter(r => r.outcome === 'insert');
const asStored = d => inserted(d).map(r => ({ id: r.winnerId, drawDate: r.row.drawDate, ticketNumber: r.row.ticketNumber ? Number(r.row.ticketNumber) : null,
    name: r.row.name, town: r.row.town, prize: r.prize, prizeSlotId: r.prizeSlotId }));
// Every insert must be exactly one true winner in exactly its approved slot. Nothing else may ever be written.
function assertTrue(d, truth) {
    for (const r of inserted(d)) {
        const t = truth.find(t => t.slot === r.prizeSlotId);
        assert.ok(t, `inserted into an unexpected slot ${r.prizeSlotId}`);
        assert.deepEqual([r.row.drawDate, r.row.ticketNumber, r.row.name, r.row.town], [t.drawDate, t.ticketNumber, t.name, t.town], r.prizeSlotId);
    }
}
const tonight = (truth, n) => truth.filter(t => t.drawDate === day(n)).map(t => t.slot).sort();
const slots = d => inserted(d).map(r => r.prizeSlotId).sort();

test('every remaining bonus label dates itself from the approved calendar; shared or generic labels do not', async t => {
    const schedule = await calendar(t);
    for (const [n, label] of Object.entries(LABELS)) assert.equal(calendarDate({ prize: label }, schedule), day(n), label);
    for (const label of ['Cutting Board', 'Meat Bundle', 'Paddle board']) assert.ok(calendarDate({ prize: label }, schedule));
    for (const label of ['Rod', 'Bonus', 'Gift Card', 'Firearm', 'Safe', 'Henry Side Gate', '$100 gift certificate']) assert.equal(calendarDate({ prize: label }, schedule), null, label);
    // One-word labels match only as a single-item prize's final noun; a brand, a joined spelling or a misspelling is held for review.
    for (const label of ['Vexilar', 'Chainsaw', 'Ice Auger', 'Blackstone Griddle', 'Cutting', 'Board']) assert.equal(calendarDate({ prize: label }, schedule), null, label);
});

test('November 12: tonight\'s approved Firearm and Gift Card winners publish under the failure modes seen on Nov 8–11', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    assert.deepEqual(schedule.filter(p => p.drawDate === day(12)).map(p => p.category), ['Main prize', 'Gift card']);
    for (const [a, b] of [[{}, {}], [{ warning: 'ambiguous-layout', bonusLate: 1 }, { bonusLate: 2 }], [{ warning: 'ambiguous-layout' }, { warning: 'ambiguous-layout', bonusLate: 1 }],
        [{ warning: 'ambiguous-layout', dropOldBonus: true }, { bonusLate: 1 }]]) {
        const d = decidePhoto([read(12, truth, a), read(12, truth, b)], storedThrough11, schedule, day(12));
        assertTrue(d, truth);
        assert.equal(d.status, 'published', JSON.stringify([a, b, d.reasons, d.rows.filter(r => r.outcome === 'held').map(r => r.reasons)]));
        assert.deepEqual(slots(d), tonight(truth, 12));
        assert.deepEqual(inserted(d).map(r => [r.row.ticketNumber, r.prize]), [['400', '1st place — Henry Side Gate 410'], ['401', '2nd place — $100 gift certificate from Safe & Secure Firearms']]);
    }
});

test('Nov 12–30: each night publishes exactly its approved winners, bonus prizes included, and the month ends complete with no duplicates', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    const nights = [
        [{}, {}],
        // The production pattern: one pass remarks on the layout, both read the bonus cells late, differently.
        [{ warning: 'ambiguous-layout', bonusLate: 1 }, { bonusLate: 2 }],
        // Both passes remark on the layout: the stored winners confirm the Firearm and Gift Card columns; bonus cells date themselves.
        [{ warning: 'ambiguous-layout', bonusLate: 2 }, { warning: 'ambiguous-layout', bonusLate: 1, dropOldBonus: true }],
    ];
    for (const [k, [a, b]] of nights.entries()) {
        let stored = [...storedThrough11];
        for (let n = 12; n <= 30; n++) {
            const d = decidePhoto([read(n, truth, a), read(n, truth, b)], stored, schedule, day(n));
            assertTrue(d, truth);
            assert.equal(d.status, 'published', `scenario ${k} Nov ${n}: ${JSON.stringify([d.reasons, d.rows.filter(r => r.outcome === 'held' || r.outcome === 'rejected').map(r => [r.row.drawDate, r.row.name, r.reasons])])}`);
            assert.deepEqual(slots(d), tonight(truth, n), `scenario ${k} Nov ${n}`);
            stored = [...stored, ...asStored(d)];
            // A requeue or Meta redelivery of the same post writes nothing more.
            assert.equal(inserted(decidePhoto([read(n, truth, a), read(n, truth, b)], stored, schedule, day(n))).length, 0);
        }
        const ids = stored.map(w => w.id), slotIds = stored.map(w => w.prizeSlotId);
        assert.equal(new Set(ids).size, ids.length);
        assert.equal(new Set(slotIds).size, slotIds.length);
        assert.equal(stored.length, storedThrough11.length + truth.length);
        assert.deepEqual(stored.slice(0, storedThrough11.length), storedThrough11, 'historical winners are never changed');
    }
});

test('Nov 12–30: a late photo publishes the drawings it reports inside the window, and the row bound counts only new winners', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    // Posted on Nov 28 covering Nov 26–28 (three nights with bonus drawings): 9 new winners, plus 25+ stored rows in the table.
    const stored = [...storedThrough11, ...truth.filter(r => r.drawDate < day(26)).map(r => ({ id: r.slot, drawDate: r.drawDate,
        ticketNumber: r.ticketNumber ? Number(r.ticketNumber) : null, name: r.name, town: r.town, prize: null, prizeSlotId: r.slot }))];
    const d = decidePhoto([read(28, truth, { warning: 'ambiguous-layout', bonusLate: 1 }), read(28, truth, { bonusLate: 2 })], stored, schedule, day(28));
    assertTrue(d, truth);
    assert.deepEqual(slots(d), truth.filter(r => r.drawDate >= day(26) && r.drawDate <= day(28)).map(r => r.slot).sort());
    // Stored rows inside the window (Nov 26–28 table rows that already exist) do not count toward the 12-row bound.
    const all = [...stored, ...asStored(d)];
    assert.equal(decidePhoto([read(28, truth), read(28, truth)], all, schedule, day(28)).status, 'duplicate');
});

test('Nov 12–30: disputed, missing or misplaced current cells are held one by one; verified neighbours still publish', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    const warn = { warning: 'ambiguous-layout', bonusLate: 1 };
    const byColumn = column => r => column === 'Bonus' ? !r.ticketNumber && r.prize !== 'Gift Card' : r.prize === column;
    let stored = [...storedThrough11];
    for (let n = 12; n <= 30; n++) {
        const bonusNight = truth.some(r => r.drawDate === day(n) && !r.ticketNumber && r.prize !== 'Gift Card');
        const slotOf = column => truth.find(r => r.drawDate === day(n) && byColumn(column)(r))?.slot;
        const decide = (a, b) => { const d = decidePhoto([read(n, truth, a), read(n, truth, b)], stored, schedule, day(n)); assertTrue(d, truth); return d; };
        const expectHeld = (d, column) => {
            assert.equal(slots(d).includes(slotOf(column)), false, `Nov ${n} ${column} must not publish`);
            assert.deepEqual(slots(d), tonight(truth, n).filter(s => s !== slotOf(column)), `Nov ${n} others publish`);
            assert.equal(d.status, 'partial');
        };
        // One pass misses tonight's Gift Card cell, or reads a different ticket or hometown in it.
        expectHeld(decide(warn, { dropTonight: byColumn('Gift Card') }), 'Gift Card');
        expectHeld(decide(warn, { changeTonight: { match: byColumn('Gift Card'), to: r => ({ ticketNumber: '999', cellText: r.cellText.replace(r.ticketNumber, '999') }) } }), 'Gift Card');
        expectHeld(decide({}, { changeTonight: { match: byColumn('Firearm'), to: r => ({ town: 'Blair', cellText: r.cellText.replace(/, \w\w$/, '') }) } }), 'Firearm');
        // One pass reads the whole Firearm column a row late: stored winners move, so that column is held; nothing lands on a wrong date.
        expectHeld(decide(warn, { firearmLate: true }), 'Firearm');
        if (bonusNight) {
            // Label bleed (seen in real reads): tonight's Gift Card cell carries the row's bonus label. It is never published as the bonus,
            // even when both passes bleed and both miss the real bonus cell.
            const bleed = { match: byColumn('Gift Card'), to: () => ({ prize: LABELS[n] }) };
            expectHeld(decide({ ...warn, changeTonight: bleed }, { changeTonight: bleed }), 'Gift Card');
            const blind = decide({ changeTonight: bleed, dropTonight: byColumn('Bonus') }, { changeTonight: bleed, dropTonight: byColumn('Bonus') });
            assert.deepEqual(slots(blind), [slotOf('Firearm')]);
            assert.match(blind.rows.find(r => r.row.drawDate === day(n) && r.row.strayLabel).reasons.join(' '), /not in its own text/);
            // One pass misses tonight's bonus cell, or reads a different person in it.
            expectHeld(decide(warn, { dropTonight: byColumn('Bonus') }), 'Bonus');
            expectHeld(decide(warn, { changeTonight: { match: byColumn('Bonus'), to: r => ({ name: 'Someone Else', cellText: r.cellText.replace(r.name, 'Someone Else') }) } }), 'Bonus');
        }
        // Clipping, illegibility or a garbled heading still rejects the whole image.
        assert.equal(decide({ warning: 'clipped' }, {}).status, 'rejected');
        assert.equal(decide({ warning: 'missing-heading' }, {}).status, 'rejected');
        stored = [...stored, ...asStored(decide({}, {}))];
    }
});

test('real model reads of rendered Nov 12, 20 and 30 tables publish exactly the right winners', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    const stored = [...storedThrough11, ...truth.map(r => ({ id: r.slot, drawDate: r.drawDate, ticketNumber: r.ticketNumber ? Number(r.ticketNumber) : null,
        name: r.name, town: r.town, prize: null, prizeSlotId: r.slot }))];
    for (const n of [12, 20, 30]) {
        const { extractionPasses } = await fixture(`simulated-table-2026-11-${n}.live-extraction.json`);
        const d = decidePhoto(extractionPasses, stored.filter(w => w.drawDate < day(n)), schedule, day(n));
        assertTrue(d, truth);
        assert.equal(d.status, 'published', `Nov ${n}`);
        assert.deepEqual(slots(d), tonight(truth, n));
    }
    // On the 30-row table both passes put the Nov 28 and Nov 29 bonus labels on those rows' Gift Card cells as well.
    const { extractionPasses: [a] } = await fixture('simulated-table-2026-11-30.live-extraction.json');
    assert.ok(a.rows.some(r => r.drawDate === day(28) && /^\d+ - /.test(r.cellText) && r.prize === LABELS[28]));
});
