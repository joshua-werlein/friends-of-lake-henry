import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePhoto } from '../src/lib/server/raffle-photo-autopublish.ts';
import { readDates, WINDOW_MAX_TOKENS, estimateNeurons } from '../workers/facebook-photos/reads.ts';
import { LABELS, asStored, assertTrue, calendar, storedThrough11, day, fixture, futureTruth, inserted, read, slots, tonight } from './november-table.mjs';

// The Worker's primary reads ask only for the announcement window (tonight and the two nights before) plus four anchor dates, whose
// stored winners prove each pass's date-to-column association. These tests replay the Nov 12–30 simulation and the real Nov 9–11 and
// rendered Nov 12–30 reads restricted to exactly those rows, under the same failure modes as the whole-table tests.
const only = (pass, n) => { const dates = new Set(readDates(day(n))); return { ...pass, rows: pass.rows.filter(r => dates.has(r.drawDate)) }; };
const windowRead = (n, truth, mode = {}) => only(read(n, truth, mode), n);

test('window reads: each night Nov 12–30 publishes exactly its approved winners, bonus nights included, with no duplicates', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    const nights = [
        [{}, {}],
        [{ warning: 'ambiguous-layout', bonusLate: 1 }, { bonusLate: 2 }],
        [{ warning: 'ambiguous-layout', bonusLate: 2 }, { warning: 'ambiguous-layout', bonusLate: 1, dropOldBonus: true }],
    ];
    for (const [k, [a, b]] of nights.entries()) {
        let stored = [...storedThrough11];
        for (let n = 12; n <= 30; n++) {
            const d = decidePhoto([windowRead(n, truth, a), windowRead(n, truth, b)], stored, schedule, day(n));
            assertTrue(d, truth);
            assert.equal(d.status, 'published', `scenario ${k} Nov ${n}: ${JSON.stringify([d.reasons, d.rows.filter(r => r.outcome === 'held' || r.outcome === 'rejected').map(r => [r.row.drawDate, r.row.name, r.reasons])])}`);
            assert.deepEqual(slots(d), tonight(truth, n), `scenario ${k} Nov ${n}`);
            stored = [...stored, ...asStored(d)];
            // A repeated post (requeue or Meta redelivery) writes nothing more.
            assert.equal(inserted(decidePhoto([windowRead(n, truth, a), windowRead(n, truth, b)], stored, schedule, day(n))).length, 0);
        }
        const ids = stored.map(w => w.id), slotIds = stored.map(w => w.prizeSlotId);
        assert.equal(new Set(ids).size, ids.length);
        assert.equal(new Set(slotIds).size, slotIds.length);
        assert.equal(stored.length, storedThrough11.length + truth.length);
        assert.deepEqual(stored.slice(0, storedThrough11.length), storedThrough11, 'historical winners are never changed');
    }
});

test('window reads: disputed, missing, misdated or mislabelled cells are held one by one; verified neighbours still publish', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    const warn = { warning: 'ambiguous-layout', bonusLate: 1 };
    const byColumn = column => r => column === 'Bonus' ? !r.ticketNumber && r.prize !== 'Gift Card' : r.prize === column;
    let stored = [...storedThrough11];
    for (let n = 12; n <= 30; n++) {
        const bonusNight = truth.some(r => r.drawDate === day(n) && !r.ticketNumber && r.prize !== 'Gift Card');
        const slotOf = column => truth.find(r => r.drawDate === day(n) && byColumn(column)(r))?.slot;
        const decide = (a, b) => { const d = decidePhoto([windowRead(n, truth, a), windowRead(n, truth, b)], stored, schedule, day(n)); assertTrue(d, truth); return d; };
        const expectHeld = (d, column) => {
            assert.equal(slots(d).includes(slotOf(column)), false, `Nov ${n} ${column} must not publish`);
            assert.deepEqual(slots(d), tonight(truth, n).filter(s => s !== slotOf(column)), `Nov ${n} others publish`);
            assert.equal(d.status, 'partial');
        };
        expectHeld(decide(warn, { dropTonight: byColumn('Gift Card') }), 'Gift Card');
        expectHeld(decide(warn, { changeTonight: { match: byColumn('Gift Card'), to: r => ({ ticketNumber: '999', cellText: r.cellText.replace(r.ticketNumber, '999') }) } }), 'Gift Card');
        expectHeld(decide({}, { changeTonight: { match: byColumn('Firearm'), to: r => ({ town: 'Blair', cellText: r.cellText.replace(/, \w\w$/, '') }) } }), 'Firearm');
        // A pass that reads the Firearm column a row late moves the anchor dates' stored winners: the column is held, nothing is misdated.
        expectHeld(decide(warn, { firearmLate: true }), 'Firearm');
        if (bonusNight) {
            const bleed = { match: byColumn('Gift Card'), to: () => ({ prize: LABELS[n] }) };
            expectHeld(decide({ ...warn, changeTonight: bleed }, { changeTonight: bleed }), 'Gift Card');
            const blind = decide({ changeTonight: bleed, dropTonight: byColumn('Bonus') }, { changeTonight: bleed, dropTonight: byColumn('Bonus') });
            assert.deepEqual(slots(blind), [slotOf('Firearm')]);
            // The approved bonus prize that no cell accounts for is reported, never silently dropped.
            assert.ok(blind.rows.some(r => r.outcome === 'held' && /no winner was read for this approved prize/.test(r.reasons.join(' '))));
            expectHeld(decide(warn, { dropTonight: byColumn('Bonus') }), 'Bonus');
            expectHeld(decide(warn, { changeTonight: { match: byColumn('Bonus'), to: r => ({ name: 'Someone Else', cellText: r.cellText.replace(r.name, 'Someone Else') }) } }), 'Bonus');
        }
        // A wrong date on tonight's cell (both passes): it is outside the window or another night's slot, never published as tonight's.
        const misdated = { changeTonight: { match: byColumn('Firearm'), to: () => ({ drawDate: day(n - 3) }) } };
        assert.equal(slots(decide(misdated, misdated)).includes(slotOf('Firearm')), false);
        assert.equal(decide({ warning: 'clipped' }, {}).status, 'rejected');
        assert.equal(decide({ warning: 'missing-heading' }, {}).status, 'rejected');
        stored = [...stored, ...asStored(decide({}, {}))];
    }
});

test('window reads: a late photo publishes the window it reports; a table read with no stored anchors still never misdates', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    const toStored = r => ({ id: r.slot, drawDate: r.drawDate, ticketNumber: r.ticketNumber ? Number(r.ticketNumber) : null, name: r.name, town: r.town, prize: null, prizeSlotId: r.slot });
    const stored = [...storedThrough11, ...truth.filter(r => r.drawDate < day(26)).map(toStored)];
    const d = decidePhoto([windowRead(28, truth, { warning: 'ambiguous-layout', bonusLate: 1 }), windowRead(28, truth, { bonusLate: 2 })], stored, schedule, day(28));
    assertTrue(d, truth);
    assert.deepEqual(slots(d), truth.filter(r => r.drawDate >= day(26) && r.drawDate <= day(28)).map(r => r.slot).sort());
    assert.equal(decidePhoto([windowRead(28, truth), windowRead(28, truth)], [...stored, ...asStored(d)], schedule, day(28)).status, 'duplicate');
    // Both passes remark on the layout but the anchors' winners were never stored (e.g. entered late): the columns cannot be confirmed,
    // so the dated columns are held rather than trusted; self-labelled bonus cells still date themselves from the calendar.
    const bare = storedThrough11.filter(w => w.drawDate < day(5));
    const noAnchors = decidePhoto([windowRead(13, truth, { warning: 'ambiguous-layout' }), windowRead(13, truth, { warning: 'ambiguous-layout' })], bare, schedule, day(13));
    assertTrue(noAnchors, truth);
    assert.ok(!slots(noAnchors).some(s => s.startsWith('event:') || s.startsWith('daily:')), JSON.stringify(slots(noAnchors)));
});

test('window reads stay bounded on the largest November tables', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    let worst = 0;
    for (let n = 12; n <= 30; n++) {
        const cells = windowRead(n, truth).rows.length, whole = read(n, truth).rows.length;
        worst = Math.max(worst, cells);
        assert.ok(cells <= 20 && cells < whole, `Nov ${n}: ${cells} of ${whole}`);
    }
    // 154 tokens per cell was the most verbose real read; the cap still has room for the largest window.
    assert.ok(worst * 154 < WINDOW_MAX_TOKENS, String(worst));
    // Neurons, from the recorded rates and the real enlarged Nov 30 read (3,390 prompt tokens, 7,948 output tokens for 73 cells):
    // the window read of the same image costs well under half, and its cost no longer grows with the month.
    assert.ok(estimateNeurons(3390, worst * 110) < estimateNeurons(3390, 7948) / 2);
});

test('real model reads: Nov 9–11 production and rendered Nov 12, 20, 28 and 30 tables publish the same winners from their window rows', async t => {
    const schedule = await calendar(t);
    for (const date of ['2026-11-09', '2026-11-10', '2026-11-11']) {
        const stored = storedThrough11.filter(w => w.drawDate < date);
        const { extractionPasses } = await fixture(`facebook-winners-${date}.extraction.json`);
        const n = Number(date.slice(8));
        const whole = decidePhoto(extractionPasses, stored, schedule, date), windowed = decidePhoto(extractionPasses.map(p => only(p, n)), stored, schedule, date);
        const ins = d => d.rows.filter(r => r.outcome === 'insert').map(r => [r.winnerId, r.prize]).sort();
        assert.ok(ins(whole).length, date);
        assert.deepEqual(ins(windowed), ins(whole), date);
        // Every insert is a winner production actually stored for that date.
        for (const [id] of ins(windowed)) assert.ok(storedThrough11.some(w => w.id === id), `${date} ${id}`);
    }
    const truth = futureTruth(schedule);
    const stored = [...storedThrough11, ...truth.map(r => ({ id: r.slot, drawDate: r.drawDate, ticketNumber: r.ticketNumber ? Number(r.ticketNumber) : null,
        name: r.name, town: r.town, prize: null, prizeSlotId: r.slot }))];
    for (const n of [12, 20, 30]) {
        const { extractionPasses } = await fixture(`simulated-table-2026-11-${n}.live-extraction.json`);
        const d = decidePhoto(extractionPasses.map(p => only(p, n)), stored.filter(w => w.drawDate < day(n)), schedule, day(n));
        assertTrue(d, truth);
        assert.equal(d.status, 'published', `Nov ${n}`);
        assert.deepEqual(slots(d), tonight(truth, n));
    }
    // The real focused reads (window dates only) of rendered Nov 28 and 30 tables never publish a wrong winner. Their synthetic names
    // contain digits ("Winner 28G"); the reads copied the cell exactly but returned name "Winner", and each such cell is held for that.
    for (const n of [28, 30]) {
        const { focusPasses } = await fixture(`simulated-table-2026-11-${n}.live-extraction.json`);
        const d = decidePhoto(focusPasses, stored.filter(w => w.drawDate < day(n)), schedule, day(n));
        assertTrue(d, truth);
        for (const r of d.rows.filter(r => r.row.drawDate === day(n) && r.row.name === 'Winner')) {
            assert.equal(r.outcome, 'held');
            assert.ok(r.reasons.includes('name differs from the name printed in the cell'));
        }
    }
});

test('real model window reads (live, 2026-11-13): rendered Nov 13 and Nov 30 tables publish exactly tonight\'s winners', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule, { realistic: true });
    for (const n of [13, 30]) {
        const live = await fixture(`simulated-table-2026-11-${n}.window-live.json`);
        assert.deepEqual(live.dates, readDates(day(n)));
        const stored = [...storedThrough11, ...truth.filter(r => r.drawDate < day(n)).map(r => ({ id: r.slot, drawDate: r.drawDate,
            ticketNumber: r.ticketNumber ? Number(r.ticketNumber) : null, name: r.name, town: r.town, prize: null, prizeSlotId: r.slot }))];
        // Every printed cell on the seven requested rows, anchors and bonus cells included, copied exactly by both reads.
        const printed = read(n, truth).rows.filter(r => live.dates.includes(r.drawDate));
        const cells = rows => rows.map(r => JSON.stringify([r.drawDate, r.cellText, r.ticketNumber, r.name, r.town])).sort();
        for (const p of live.windowPasses) assert.deepEqual(cells(p.rows), cells(printed), `Nov ${n}`);
        const d = decidePhoto(live.windowPasses, stored, schedule, day(n));
        assertTrue(d, truth);
        assert.equal(d.status, 'published');
        assert.deepEqual(slots(d), tonight(truth, n));
        assert.ok(live.usage.every(u => u.completionTokens < WINDOW_MAX_TOKENS / 3));
    }
});

test('window reads: stray rows outside the window change nothing; a genuine repeat winner still publishes', async t => {
    const schedule = await calendar(t);
    const truth = futureTruth(schedule);
    const storedBefore = n => [...storedThrough11, ...truth.filter(r => r.drawDate < day(n)).map(r => ({ id: r.slot, drawDate: r.drawDate,
        ticketNumber: r.ticketNumber ? Number(r.ticketNumber) : null, name: r.name, town: r.town, prize: null, prizeSlotId: r.slot }))];
    for (const n of [13, 22, 28]) {
        // A read that also returns a misread anchor row publishes exactly tonight's winners.
        const stray = (p, back, name) => ({ ...p, rows: [...p.rows, { ...p.rows[0], drawDate: day(n - back), name, cellText: `${name}, Blair, WI`, ticketNumber: '', ticketStatus: 'blank' }] });
        const d = decidePhoto([stray(windowRead(n, truth), 5, 'Old Misread'), stray(windowRead(n, truth), 5, 'Old Misread')], storedBefore(n), schedule, day(n));
        assertTrue(d, truth);
        assert.deepEqual(slots(d), tonight(truth, n));
        // A row from a date it was not asked for makes that date a read date. On Nov 22 a stored Nov 10 gift-card winner (Gary Gran,
        // who won again on Nov 16) then looks moved, so the Gift Card column is held for review: conservative, never a wrong insert.
        const far = decidePhoto([stray(windowRead(n, truth), 12, 'Far Misread'), stray(windowRead(n, truth), 12, 'Far Misread')], storedBefore(n), schedule, day(n));
        assertTrue(far, truth);
        assert.ok(slots(far).every(s => tonight(truth, n).includes(s)));
        for (const r of far.rows.filter(r => r.row.drawDate === day(n) && r.outcome === 'held')) assert.match(r.reasons[0], /dates an already-stored winner in this prize column differently/);
    }
    // Gary Gran won the Nov 10 gift card and wins again on Nov 16; Nov 10 is outside the Nov 16 read, and he publishes.
    const d16 = decidePhoto([windowRead(16, truth), windowRead(16, truth)], storedBefore(16), schedule, day(16));
    assert.ok(inserted(d16).some(r => r.row.name === 'Gary Gran' && r.row.drawDate === day(16) && r.prizeSlotId === 'daily:2026-11-16:0'));
    // Dennis McHenry (Nov 11 firearm, ticket 698) wins the Nov 25 firearm with the same ticket: Nov 11 is outside the Nov 25 read.
    const d25 = decidePhoto([windowRead(25, truth), windowRead(25, truth)], storedBefore(25), schedule, day(25));
    assert.ok(inserted(d25).some(r => r.row.name === 'Dennis McHenry' && r.row.drawDate === day(25)));
});
