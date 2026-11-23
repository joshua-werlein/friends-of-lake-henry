import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePhoto, matchPrize, calendarDate } from '../src/lib/server/raffle-photo-autopublish.ts';
import { calendar, cell, fixture, inserted } from './november-table.mjs';

// November 22, 2026: the firearm and gift card published, and the bonus cell "Vexliar - 781 - Troy Mish, Westby, WI" was held: the
// approved bonus is "Vexilar Fish Finder" and "Vexliar" swaps two letters of the brand. The winner has since been entered manually;
// nothing here touches production. The firearm and gift card winners below are placeholders (their cells are not part of the record).
const { winners } = await fixture('november-2026-winners-through-21.json');
const nov21 = await fixture('facebook-winners-2026-11-21.extraction.json');
const DATE = '2026-11-22';
const CELL = 'Vexliar - 781 - Troy Mish, Westby, WI';
const day22 = schedule => {
    const day = schedule.filter(p => p.status === 'approved' && p.drawDate === DATE);
    const by = c => { const list = day.filter(p => p.category === c); assert.equal(list.length, 1, c); return list[0]; };
    return { day, firearm: by('Main prize'), gift: by('Gift card'), bonus: by('Bonus drawing') };
};
const bonusCell = (label, change = {}) => ({ ...cell(DATE, null, '781', 'Troy Mish', 'Westby, WI', label), ...change });
const FIREARM = cell(DATE, 'Firearm', '512', 'Ann Placeholder', 'Blair, WI');
const GIFT = cell(DATE, 'Gift Card', '633', 'Ben Placeholder', 'Osseo, WI');
/** Two identical window reads of Nov 20–22 (the real Nov 20–21 cells plus tonight's); `perPass` changes the bonus cell in one pass. */
function reads(bonus, { perPass = [], tonight = [FIREARM, GIFT] } = {}) {
    const old = nov21.extractionPasses[0].rows.filter(r => r.drawDate >= '2026-11-20');
    return [0, 1].map(i => ({ containsWinners: true, warnings: [],
        rows: structuredClone([...old, ...tonight, ...(bonus ? [{ ...bonus, ...(perPass[i] ?? {}) }] : [])]) }));
}
const decide = (passes, schedule, existing = winners, options) => decidePhoto(passes, existing, schedule, DATE, options);
const troy = d => d.rows.find(r => r.row.name === 'Troy Mish');
const stored = (d, slot) => inserted(d).filter(r => r.prizeSlotId !== slot).map(r => ({ id: r.winnerId, drawDate: r.row.drawDate,
    ticketNumber: Number(r.row.ticketNumber), name: r.row.name, town: r.row.town, prize: r.prize, prizeSlotId: r.prizeSlotId }));

test('Nov 22: "Vexliar" names the approved Vexilar Fish Finder, and the real cell publishes with the night\'s other winners', async t => {
    const schedule = await calendar(t), { firearm, gift, bonus } = day22(schedule);
    assert.equal(bonus.description, 'Vexilar Fish Finder');
    for (const label of ['Vexliar', 'VEXLIAR', 'vexliar.', 'Vexilar', 'Vexliar Fish Finder', 'Vexilar Fish Findr', 'Vexliar Fish', 'Fish Finder', 'Fish Fin'])
        assert.equal(matchPrize(label, DATE, schedule).description, 'Vexilar Fish Finder', label);
    // Only the drawing's own approved prizes are candidates, and a lone brand word never moves a cell to another night.
    assert.equal(matchPrize('Vexliar', '2026-11-21', schedule).match, 'unmatched');
    assert.equal(calendarDate({ prize: 'Vexliar' }, schedule), null);
    const d = decide(reads(bonusCell('Vexliar')), schedule);
    assert.equal(d.status, 'published', JSON.stringify(d.rows.filter(r => r.outcome !== 'insert' && r.outcome !== 'duplicate').map(r => r.reasons)));
    assert.deepEqual(inserted(d).map(r => r.prizeSlotId).sort(), [firearm.id, gift.id, bonus.id].sort());
    assert.equal(troy(d).row.cellText, CELL);
    assert.deepEqual([troy(d).winnerId, troy(d).prize], ['2026-11-2026-11-22-781', 'Bonus — Vexilar Fish Finder']);
    assert.ok(troy(d).reasons.includes(`prize matches approved calendar entry ${bonus.id}`));
});

test('Nov 22 published records stay untouched: the manual entry is a duplicate and a different slot holder is never overwritten', async t => {
    const schedule = await calendar(t), { bonus } = day22(schedule);
    const first = decide(reads(bonusCell('Vexliar')), schedule);
    const manual = { id: '2026-11-2026-11-22-781', drawDate: DATE, ticketNumber: 781, name: 'Troy Mish', town: 'Westby, WI', prize: 'Bonus — Vexilar Fish Finder', prizeSlotId: bonus.id };
    const now = decide(reads(bonusCell('Vexliar')), schedule, [...winners, ...stored(first, bonus.id), manual]);
    assert.equal(now.status, 'duplicate');
    assert.equal(inserted(now).length, 0);
    const other = { ...manual, id: '2026-11-2026-11-22-slot-x', ticketNumber: null, name: 'Someone Else', town: 'Blair, WI' };
    assert.equal(troy(decide(reads(bonusCell('Vexliar')), schedule, [...winners, ...stored(first, bonus.id), other])).outcome, 'rejected');
    // Elimination never overwrites either: the bonus slot already taken means no remaining prize.
    assert.notEqual(troy(decide(reads(bonusCell('Vexil')), schedule, [...winners, other])).outcome, 'insert');
});

test('Nov 22 elimination: an unnamed bonus winner takes the only approved bonus left when its column is verified', async t => {
    const schedule = await calendar(t), { bonus } = day22(schedule);
    const assigned = (d, label) => {
        assert.equal(troy(d).outcome, 'insert', `${label}: ${JSON.stringify(troy(d).reasons)}`);
        assert.deepEqual([troy(d).prizeSlotId, troy(d).prize, troy(d).winnerId], [bonus.id, 'Bonus — Vexilar Fish Finder', '2026-11-2026-11-22-781'], label);
        assert.ok(troy(d).reasons.includes(`prize assigned by elimination to approved calendar entry ${bonus.id}`), label);
        assert.match(troy(d).reasons.join(' '), /prize by elimination/, label);
        assert.equal(d.rows.some(r => /no winner was read for this approved prize/.test(r.reasons.join(' '))), false, label);
    };
    // Its own printed label, too misspelled or abbreviated to identify the prize, but with no word that names anything else.
    for (const label of ['Vexil', 'Fnder Fsh', 'Vexilor Fsh Findr', 'Vxlr Fndr', 'Vexlar Fish Fnder']) {
        assert.equal(matchPrize(label, DATE, schedule).match, 'unmatched', `${label} is not identified on its own`);
        assigned(decide(reads(bonusCell(label)), schedule), label);
    }
    // No prize name at all, but the column heading or an explicit Bonus place puts it in the bonus column.
    assigned(decide(reads(bonusCell(undefined, { prize: '', position: 'Bonus', cellText: '781 - Troy Mish, Westby, WI' })), schedule), 'Bonus place');
    // The firearm and gift card already stored (a requeue): the remaining prize is still the bonus.
    const first = decide(reads(bonusCell('Vexil')), schedule);
    assigned(decide(reads(bonusCell('Vexil')), schedule, [...winners, ...stored(first, bonus.id)]), 'requeue');
    // A removed winner is not brought back by elimination.
    assert.equal(troy(decide(reads(bonusCell('Vexil')), schedule, winners, { removedWinnerIds: new Set(['2026-11-2026-11-22-781']) })).outcome, 'held');
});

test('Nov 22 ambiguity: a label or remaining prize that fits two approved prizes stays held', async t => {
    const base = await calendar(t), { bonus } = day22(base);
    // A second approved bonus the same night: the brand fits both, and two prizes remain for elimination.
    const two = [...base, { ...bonus, id: bonus.id + '-flasher', description: 'Vexilar FL-8 Ice Flasher' }];
    for (const label of ['Vexliar', 'Vexilar']) assert.equal(matchPrize(label, DATE, two).match, 'unmatched', label);
    for (const label of ['Vexliar', 'Vexil']) {
        const d = decide(reads(bonusCell(label)), two);
        assert.equal(troy(d).outcome, 'held', label);
        assert.equal(troy(d).prizeSlotId ?? null, null, label);
    }
    // Two unnamed bonus winners in the window: neither takes the remaining prize.
    const second = { ...bonusCell('Gadget'), ticketNumber: '782', name: 'Second Person', cellText: 'Gadget - 782 - Second Person, Blair, WI', town: 'Blair, WI' };
    const d = decide(reads(bonusCell('Vexil'), { tonight: [FIREARM, GIFT, second] }), base);
    assert.deepEqual(d.rows.filter(r => r.row.drawDate === DATE && r.row.ticketNumber.startsWith('78')).map(r => r.outcome), ['held', 'held']);
    // Short or digit-bearing words never vary.
    assert.equal(matchPrize('Vexl', DATE, base).match, 'unmatched');
});

test('Nov 22 uncertain column association or drawing state stays held', async t => {
    const schedule = await calendar(t);
    const held = (d, why) => { assert.equal(troy(d).outcome, 'held', `${why}: ${JSON.stringify(troy(d).reasons)}`); assert.equal(troy(d).prizeSlotId ?? null, null, why); };
    // A printed label that names something else is a contradiction, not a misspelling: never assigned by elimination.
    for (const label of ['Ice Flasher', 'Fish Finder Combo', 'Locator', 'Gift Card Bonus', 'Vexilar 12']) held(decide(reads(bonusCell(label)), schedule), label);
    // A generic or very short one-word fragment is no evidence of the remaining prize.
    for (const label of ['Fish', 'Vxlr', 'Vex']) held(decide(reads(bonusCell(label)), schedule), label);
    held(decide(reads(bonusCell('Ice Flasher', { prize: 'Bonus Drawing' })), schedule), 'heading read, contradicting label printed');
    held(decide(reads(bonusCell(undefined, { prize: '', position: 'Bonus', cellText: 'Ice Flasher - 781 - Troy Mish, Westby, WI' })), schedule), 'Bonus place, contradicting label printed');
    // No label in the cell's own text, no heading and no place: the column is unknown (the label belongs to a neighbour).
    held(decide(reads(bonusCell(undefined, { prize: 'Vexil', cellText: '781 - Troy Mish, Westby, WI' })), schedule), 'stray label');
    held(decide(reads(bonusCell(undefined, { prize: '', cellText: '781 - Troy Mish, Westby, WI' })), schedule), 'no column evidence');
    // A numbered place, in one pass or both.
    held(decide(reads(bonusCell('Vexil'), { perPass: [{ position: 2 }] }), schedule), 'one pass reads 2nd place');
    held(decide(reads(bonusCell('Vexil', { position: 3 })), schedule), '3rd place');
    // One pass reads the label, the other does not.
    held(decide(reads(bonusCell('Vexil'), { perPass: [{}, { prize: '', cellText: '781 - Troy Mish, Westby, WI' }] }), schedule), 'passes disagree');
    // A label that names another night's approved prize (a misdated cell).
    held(decide(reads(bonusCell('Gun Safe')), schedule), 'label of the Nov 26 bonus');
    // The Nov 20 bonus's label: dated to Nov 20 by the calendar, where that slot is already stored, so it is rejected, never placed on Nov 22.
    const nov20 = troy(decide(reads(bonusCell('Bubba Knife')), schedule));
    assert.deepEqual([nov20.outcome, nov20.row.drawDate], ['rejected', '2026-11-20']);
    assert.equal(matchPrize('Fish Fndr', DATE, schedule).match, 'unmatched', 'two letters missing is not a minor variant');
    // The firearm was not read: first place is not confidently matched, so nothing is eliminated.
    held(decide(reads(bonusCell('Vexil'), { tonight: [GIFT] }), schedule), 'firearm missing');
    // The firearm cell held (ticket not in its cell text): first place is not settled.
    held(decide(reads(bonusCell('Vexil'), { tonight: [{ ...FIREARM, cellText: '999 - Ann Placeholder, Blair, WI' }, GIFT] }), schedule), 'firearm held');
    // Another bonus of the window is unaccounted for (Nov 21's not stored and not read): the cell could belong to either night.
    const augur = schedule.find(p => p.drawDate === '2026-11-21' && p.category === 'Bonus drawing');
    const withoutAugur = winners.filter(w => w.prizeSlotId !== augur.id);
    const passes = reads(bonusCell('Vexil')).map(p => ({ ...p, rows: p.rows.filter(r => r.ticketNumber !== '029') }));
    held(decide(passes, schedule, withoutAugur), 'another bonus of the window open');
});
