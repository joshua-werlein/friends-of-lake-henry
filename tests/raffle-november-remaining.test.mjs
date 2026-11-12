import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePhoto, calendarDate } from '../src/lib/server/raffle-photo-autopublish.ts';

// Every remaining November 2026 drawing (Nov 12–30), simulated as the Page posts it: one cumulative table per night with a row per
// date, a Firearm column, a Gift Card column and a headingless bonus column whose few cells carry their own labels. Prizes come
// from the approved calendar (published events + the poster's daily gift certificate), never from assumptions about the night.
// The history is the real stored Nov 1–11 winners; the cells are the real Nov 11 reads. The AI failure modes are the ones seen in
// production on Nov 8–11 (sparse bonus cells read one or two rows late, a layout remark from one pass) plus adversarial ones.
import { BONUS_HISTORY, LABELS, asStored, assertTrue, calendar, storedThrough11, cell, day, fixture, focus, futureTruth, history, inserted, nov11, read, slots, sorted, tonight } from './november-table.mjs';

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

test('two-stage reads: focused window reads recover bonus cells the whole-table reads drop, every night Nov 12-30', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    let stored = [...storedThrough11], bonusPublished = 0;
    for (let n = 12; n <= 30; n++) {
        // Whole-table reads as measured on large tables: no bonus cells, one layout remark, Firearm/Gift Card read correctly.
        const full = [read(n, truth, { noBonus: true, warning: 'ambiguous-layout' }), read(n, truth, { noBonus: true })];
        const bonusTonight = truth.filter(r => r.drawDate === day(n) && !r.ticketNumber && r.prize !== 'Gift Card');
        // Without focused reads tonight's bonus is never read: it is held by the completeness check, never published.
        const blind = decidePhoto(full, stored, schedule, day(n));
        assertTrue(blind, truth);
        if (bonusTonight.length) assert.match(blind.rows.find(r => !r.row.name).reasons[0], /no winner was read for this approved prize/);
        const d = decidePhoto(full, stored, schedule, day(n), { focused: [focus(n, truth), focus(n, truth, { bonusLate: 1 })] });
        assertTrue(d, truth);
        assert.equal(d.status, 'published', `Nov ${n}: ${JSON.stringify([d.reasons, d.rows.filter(r => r.outcome === 'held' || r.outcome === 'rejected').map(r => [r.row.name, r.reasons])])}`);
        assert.deepEqual(slots(d), tonight(truth, n), `Nov ${n}`);
        bonusPublished += inserted(d).filter(r => r.prizeSlotId.startsWith('event-bonus:')).length;
        stored = [...stored, ...asStored(d)];
    }
    assert.equal(bonusPublished, 10); // Nov 13, 14, 15, 20, 21, 22, 26, 27, 28, 29.
    assert.equal(stored.length, storedThrough11.length + truth.length);
    assert.equal(new Set(stored.map(w => w.prizeSlotId)).size, stored.length);
});

test('two-stage reads keep every safety check: disagreement between reads holds the cell, never picks one', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    for (const n of [13, 22, 28]) {
        const stored = [...storedThrough11, ...truth.filter(r => r.drawDate < day(n)).map(r => ({ id: r.slot, drawDate: r.drawDate,
            ticketNumber: r.ticketNumber ? Number(r.ticketNumber) : null, name: r.name, town: r.town, prize: null, prizeSlotId: r.slot }))];
        const full = (mode = {}) => [read(n, truth, { noBonus: true, ...mode }), read(n, truth, { noBonus: true, ...mode })];
        const decide = (f, focused) => { const d = decidePhoto(f, stored, schedule, day(n), { focused }); assertTrue(d, truth); return d; };
        const column = c => r => c === 'Bonus' ? !r.ticketNumber && r.prize !== 'Gift Card' : r.prize === c;
        const slotOf = c => truth.find(r => r.drawDate === day(n) && column(c)(r)).slot;
        // Both focused reads give tonight's Firearm winner the same wrong name (real 1x reads did this for a stored winner): the
        // whole-table reads disagree, so the cell is held, not published under either name.
        const misread = { changeTonight: { match: column('Firearm'), to: r => ({ name: 'Dennis Stedman', cellText: r.cellText.replace(r.name, 'Dennis Stedman') }) } };
        const wrongName = decide(full(), [focus(n, truth, misread), focus(n, truth, misread)]);
        assert.equal(slots(wrongName).includes(slotOf('Firearm')), false);
        assert.ok(slots(wrongName).includes(slotOf('Gift Card')) && slots(wrongName).includes(slotOf('Bonus')));
        // A focused read that misses tonight's bonus cell: only one focused read has it and no whole-table read does, so it is held.
        const drop = decide(full(), [focus(n, truth), focus(n, truth, { dropTonight: column('Bonus') })]);
        assert.equal(slots(drop).includes(slotOf('Bonus')), false);
        assert.equal(drop.status, 'partial');
        // ...but when that pass's whole-table read did see it, the cell is backfilled and publishes.
        const backfilled = decide([read(n, truth, { noBonus: true }), read(n, truth)], [focus(n, truth), focus(n, truth, { dropTonight: column('Bonus') })]);
        assert.deepEqual(slots(backfilled), tonight(truth, n));
        // The two focused reads disagree on tonight's bonus winner: held.
        const other = { changeTonight: { match: column('Bonus'), to: r => ({ name: 'Someone Else', cellText: r.cellText.replace(r.name, 'Someone Else') }) } };
        assert.equal(slots(decide(full(), [focus(n, truth), focus(n, truth, other)])).includes(slotOf('Bonus')), false);
        // A focused read that also returns rows outside the window (with errors) changes nothing outside the window.
        const noisy = p => ({ ...p, rows: [...p.rows, { ...p.rows[0], drawDate: day(n - 5), name: 'Old Misread', cellText: 'Old Misread, Blair, WI', ticketNumber: '', ticketStatus: 'blank' }] });
        assert.deepEqual(slots(decide(full(), [noisy(focus(n, truth)), noisy(focus(n, truth))])), tonight(truth, n));
        // An incomplete focused set (one read failed) is ignored: the decision is the whole-table one, bonus held by completeness.
        const partial = decide(full(), [focus(n, truth)]);
        assert.equal(slots(partial).includes(slotOf('Bonus')), false);
        assert.match(partial.rows.find(r => !r.row.name).reasons[0], /no winner was read/);
        // A clipped focused read rejects the image like any other clipping remark.
        assert.equal(decide(full(), [focus(n, truth, { warning: 'clipped' }), focus(n, truth)]).status, 'rejected');
    }
    // A genuine repeat winner (Gary Gran, Nov 10 and Nov 16 gift cards) read by focused passes publishes on Nov 16.
    const stored16 = [...storedThrough11, ...truth.filter(r => r.drawDate < day(16)).map(r => ({ id: r.slot, drawDate: r.drawDate,
        ticketNumber: r.ticketNumber ? Number(r.ticketNumber) : null, name: r.name, town: r.town, prize: null, prizeSlotId: r.slot }))];
    const d16 = decidePhoto([read(16, truth, { noBonus: true }), read(16, truth, { noBonus: true })], stored16, schedule, day(16), { focused: [focus(16, truth), focus(16, truth)] });
    assert.ok(inserted(d16).some(r => r.row.name === 'Gary Gran' && r.row.drawDate === day(16) && r.prizeSlotId === 'daily:2026-11-16:0'));
});

test('two-stage reads leave the real Nov 9, 10 and 11 decisions unchanged', async t => {
    const schedule = await calendar(t);
    for (const [day, stored] of [['2026-11-09', storedThrough11.filter(w => w.drawDate < '2026-11-09')], ['2026-11-10', storedThrough11.filter(w => w.drawDate < '2026-11-10')],
        ['2026-11-11', storedThrough11.filter(w => w.drawDate < '2026-11-11')]]) {
        const { extractionPasses } = await fixture(`facebook-winners-${day}.extraction.json`);
        const before = decidePhoto(extractionPasses, stored, schedule, day);
        // Focused reads that return exactly each real pass's own window rows.
        const lo = new Date(Date.parse(day + 'T12:00:00Z') - 2 * 86400000).toISOString().slice(0, 10);
        const focused = extractionPasses.map(p => ({ containsWinners: true, warnings: [], rows: p.rows.filter(r => r.drawDate >= lo && r.drawDate <= day) }));
        const after = decidePhoto(extractionPasses, stored, schedule, day, { focused });
        assert.deepEqual(after.rows.filter(r => r.outcome === 'insert').map(r => [r.winnerId, r.prize]), before.rows.filter(r => r.outcome === 'insert').map(r => [r.winnerId, r.prize]), day);
        assert.ok(before.rows.some(r => r.outcome === 'insert'), day);
    }
});

test('real model reads, two-stage (Nov 28, Nov 30): focused reads copy every window cell, and misparsed cells are held one by one', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    const stored = [...storedThrough11, ...truth.map(r => ({ id: r.slot, drawDate: r.drawDate, ticketNumber: r.ticketNumber ? Number(r.ticketNumber) : null,
        name: r.name, town: r.town, prize: null, prizeSlotId: r.slot }))];
    const recall = { 28: [], 30: [] };
    for (const n of [28, 30]) {
        const { extractionPasses, focusPasses } = await fixture(`simulated-table-2026-11-${n}.live-extraction.json`);
        // Independently recorded table: every printed cell of the window (tonight and the two nights before).
        const printed = read(n, truth).rows.filter(r => r.drawDate >= day(n - 2));
        const copied = p => printed.filter(c => p.rows.some(r => r.drawDate === c.drawDate && (r.cellText ?? '').trim() === c.cellText.trim()));
        const bonus = c => !c.ticketNumber && c.prize !== 'Gift Card';
        recall[n] = [...extractionPasses, ...focusPasses].map(p => [copied(p).length, copied(p).filter(bonus).length]);
        const d = decidePhoto(extractionPasses, stored.filter(w => w.drawDate < day(n)), schedule, day(n), { focused: focusPasses });
        assertTrue(d, truth); // No wrong winner, date or prize, ever.
        assert.deepEqual(d.reasons, [], `Nov ${n}: no image-level rejection`);
        // These synthetic names contain digits ("Winner 28G"); the focused reads copied the cell text exactly but returned name
        // "Winner". Every such cell is held for that reason instead of being published under a shortened name.
        for (const r of d.rows.filter(r => r.row.drawDate === day(n) && r.row.name === 'Winner')) {
            assert.equal(r.outcome, 'held');
            assert.ok(r.reasons.includes('name differs from the name printed in the cell'));
        }
    }
    // [cells copied, bonus cells copied] per read: whole-table pass 0, pass 1, focused pass 0, pass 1. Nov 28's window has 9 cells
    // (3 bonus), Nov 30's 8 (2 bonus, Nov 28-29). Whole-table reads missed every window bonus cell; focused reads found them, except
    // Nov 30 focused pass 0, which returned 6 of 8 cells.
    assert.deepEqual(recall, { 28: [[6, 0], [6, 0], [9, 3], [9, 3]], 30: [[6, 0], [6, 0], [6, 0], [8, 2]] });
});
