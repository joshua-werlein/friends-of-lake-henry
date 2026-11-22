import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { decidePhoto, matchPrize, calendarDate, loadContext, writeDecision } from '../src/lib/server/raffle-photo-autopublish.ts';
import { readDates } from '../workers/facebook-photos/reads.ts';
import { PAGE_LABELS, asStored, assertTrue, calendar, day, events, fixture, futureTruth, inserted, read, slots, storedThrough11, tonight as truthTonight } from './november-table.mjs';

// November 21, 2026 (incident photo:review:122337048518073310). Both production window reads returned the bonus cell
// "Ice Auger - 029 - Pat Keating, LaCrosse, WI" with prize "Ice Auger". The approved calendar's bonus is "Strike Master Ice Augur"
// (the published event summary's spelling). Prize identification had no rule for a shortened label with a one-letter spelling
// difference ("ice auger" is not a phrase of "strike master ice augur", and shares 1 of its 4 words), so the winner was held and an
// administrator published it as "Bonus — Strike Master Ice Augur". The reads and stored winners below are the production records.
const { winners } = await fixture('november-2026-winners-through-21.json');
const nov21 = await fixture('facebook-winners-2026-11-21.extraction.json');
const DATE = '2026-11-21';
const AUGER = 'event-bonus:2026-11-21-day-21-diamondback-dbx-pistol-5-7x28';
const FIREARM = 'event:2026-11-21-day-21-diamondback-dbx-pistol-5-7x28';
const GIFT = 'daily:2026-11-21:0';
const CELL = 'Ice Auger - 029 - Pat Keating, LaCrosse, WI';
const MANUAL = { id: '2026-11-2026-11-21-29', prize: 'Bonus — Strike Master Ice Augur', prizeSlotId: AUGER }; // The administrator's correction.
const before = date => winners.filter(w => w.drawDate < date);
const passes = () => structuredClone(nov21.extractionPasses);
/** Both passes with the bonus cell's label (prize and printed label) changed, or any other change; `only` changes a single pass. */
const bonus = (change, only = null) => passes().map((p, i) => ({ ...p, rows: p.rows.map(r => r.ticketNumber === '029' && (only === null || only === i) ? { ...r, ...change } : r) }));
const relabel = (label, only = null) => bonus({ prize: label, cellText: CELL.replace('Ice Auger', label) }, only);
const tonight = d => d.rows.filter(r => r.row.drawDate === DATE);
const outcomes = d => tonight(d).map(r => [r.outcome, r.row.name, r.prizeSlotId ?? null]);
const augerRow = d => d.rows.find(r => r.row.ticketNumber === '029' || r.row.name === 'Pat Keating');
const record = w => [w.id, w.drawDate, w.ticketNumber, w.name, w.town, w.prize, w.prizeSlotId];

test('November 21 evidence: the printed label, both reads and the approved calendar entry', async t => {
    const schedule = await calendar(t);
    const [a, b] = nov21.extractionPasses.map(p => p.rows.find(r => r.ticketNumber === '029'));
    assert.deepEqual(a, b, 'both production passes read the cell identically');
    assert.deepEqual([a.cellText, a.prize, a.name, a.town, a.ticketStatus], [CELL, 'Ice Auger', 'Pat Keating', 'LaCrosse, WI', 'readable']);
    assert.deepEqual(schedule.filter(p => p.drawDate === DATE).map(p => [p.id, p.description]), [
        [FIREARM, 'Diamondback DBX Pistol 5.7x28'], [AUGER, 'Strike Master Ice Augur'], [GIFT, '$100 gift certificate from Safe & Secure Firearms']]);
    assert.deepEqual(record(winners.find(w => w.prizeSlotId === AUGER)), ['2026-11-2026-11-21-29', DATE, 29, 'Pat Keating', 'LaCrosse, WI', MANUAL.prize, AUGER]);
});

test('November 21 production reads: all three winners publish, the bonus exactly as the administrator stored it', async t => {
    const schedule = await calendar(t);
    const d = decidePhoto(passes(), before(DATE), schedule, DATE);
    assert.equal(d.status, 'published', JSON.stringify(tonight(d).map(r => r.reasons)));
    assert.deepEqual(outcomes(d), [['insert', 'Joe Stevens', FIREARM], ['insert', "Pam O'leary", GIFT], ['insert', 'Pat Keating', AUGER]]);
    const auger = augerRow(d);
    assert.deepEqual([auger.winnerId, auger.prize, auger.prizeSlotId], [MANUAL.id, MANUAL.prize, MANUAL.prizeSlotId]);
    assert.ok(auger.reasons.includes(`prize matches approved calendar entry ${AUGER}`));
    // The firearm and gift card are what production published that night.
    for (const r of inserted(d)) assert.deepEqual([r.winnerId, r.prize], [winners.find(w => w.prizeSlotId === r.prizeSlotId).id, winners.find(w => w.prizeSlotId === r.prizeSlotId).prize]);
    assert.equal(d.rows.filter(r => r.row.drawDate < DATE).every(r => r.outcome === 'duplicate'), true, 'every earlier cell is a stored winner');
    assert.equal(d.rows.some(r => /no winner was read|exactly one approved/.test(r.reasons.join(' '))), false);
});

test('November 21 duplicates: the manually corrected winner is recognised, never written again or changed', async t => {
    const schedule = await calendar(t);
    // As production stands (all three stored, the bonus by an administrator): nothing is written.
    const now = decidePhoto(passes(), winners, schedule, DATE);
    assert.equal(now.status, 'duplicate');
    assert.equal(inserted(now).length, 0);
    assert.deepEqual([augerRow(now).outcome, augerRow(now).winnerId], ['duplicate', MANUAL.id]);
    // As production stood at the hold (firearm and gift card stored): a requeue adds only the bonus, then nothing.
    const atHold = winners.filter(w => w.prizeSlotId !== AUGER);
    const requeue = decidePhoto(passes(), atHold, schedule, DATE);
    assert.deepEqual(inserted(requeue).map(r => [r.winnerId, r.prize, r.prizeSlotId]), [[MANUAL.id, MANUAL.prize, AUGER]]);
    assert.equal(inserted(decidePhoto(passes(), [...atHold, ...asStored(requeue)], schedule, DATE)).length, 0);
    // An administrator deleted it after this photo published it: it is not brought back.
    const removed = decidePhoto(passes(), atHold, schedule, DATE, { removedWinnerIds: new Set([MANUAL.id]) });
    assert.equal(augerRow(removed).outcome, 'held');
    // Another winner already holds the bonus slot: rejected, never overwritten.
    const other = [...atHold, { id: '2026-11-2026-11-21-slot-x', drawDate: DATE, ticketNumber: null, name: 'Someone Else', town: 'Blair, WI', prize: MANUAL.prize, prizeSlotId: AUGER }];
    assert.equal(augerRow(decidePhoto(passes(), other, schedule, DATE)).outcome, 'rejected');
});

test('November 21 labels: shortened names and one-letter spellings of the approved prize publish', async t => {
    const schedule = await calendar(t);
    for (const label of ['Ice Auger', 'Ice Augur', 'ICE AUGER', 'ice auger', 'Auger', 'Augur', 'Strike Master Ice Auger', 'Strike Master Ice Augur',
        'Strikemaster Ice Auger', 'StrikeMaster Ice Augur', 'Master Ice Auger']) {
        assert.equal(matchPrize(label, DATE, schedule).description, 'Strike Master Ice Augur', label);
        const d = decidePhoto(relabel(label), before(DATE), schedule, DATE);
        assert.deepEqual([augerRow(d).outcome, augerRow(d).prizeSlotId, augerRow(d).prize], ['insert', AUGER, MANUAL.prize], label);
    }
    // The passes spell it differently from each other: still one approved prize, so they agree.
    const mixed = decidePhoto(relabel('Ice Augur', 1), before(DATE), schedule, DATE);
    assert.deepEqual([augerRow(mixed).outcome, augerRow(mixed).prizeSlotId], ['insert', AUGER]);
    // The model copied the column heading into prize; the cell's own label still names the auger.
    const heading = decidePhoto(bonus({ prize: 'Bonus' }), before(DATE), schedule, DATE);
    assert.deepEqual([augerRow(heading).outcome, augerRow(heading).prizeSlotId], ['insert', AUGER]);
    // Ticketless form of the same cell, as on Nov 13-15.
    const ticketless = decidePhoto(bonus({ ticketNumber: '', ticketStatus: 'blank', cellText: 'Ice Auger - Pat Keating, LaCrosse, WI' }), before(DATE), schedule, DATE);
    assert.deepEqual([augerRow(ticketless).outcome, augerRow(ticketless).prizeSlotId], ['insert', AUGER]);
});

test('November 21 labels that are not the approved prize, or are not certain, stay held', async t => {
    const schedule = await calendar(t);
    const held = (cells, label) => { const d = decidePhoto(cells, before(DATE), schedule, DATE);
        assert.equal(inserted(d).some(r => r.prizeSlotId === AUGER || r.row.ticketNumber === '029'), false, label); return augerRow(d); };
    // Two letters off, added or reordered words, words from another prize, or a different item.
    for (const label of ['Ice Augerr', 'Ice Augers', 'Ice Agur', 'Ice Fishing Auger', 'Auger Ice', 'Strike Ice Auger', 'Ice Auger Bit', 'Ice Shelter',
        'Strike Mastr Ice Auger', 'Ice', 'Master', 'Auger Set'])
        assert.match(held(relabel(label), label).reasons.join(' '), /exactly one approved|label printed in the cell/, label);
    // Another night's prize, in the calendar's or the Page's spelling.
    for (const label of ['Bubba Filet Knife', 'Fish Finder', 'Blackstone']) held(relabel(label), label);
    // The cell is labelled for another prize while the extraction says auger, in both passes or one.
    const LABEL = 'the prize label printed in the cell does not name the extracted prize';
    assert.ok(held(bonus({ cellText: CELL.replace('Ice Auger', 'Fish Finder') }), 'cell').reasons.includes(LABEL));
    assert.ok(held(bonus({ cellText: CELL.replace('Ice Auger', 'Fish Finder') }, 1), 'cell one pass').reasons.includes(LABEL));
    // One pass reads another prize.
    // (Its calendar dates that pass's cell to Nov 22, so the passes no longer share the row.)
    assert.match(held(relabel('Fish Finder', 1), 'one pass').reasons.join(' '), /read by only 1 of 2|disagree on prize|exactly one approved|label printed/);
});

test('November 21 ambiguity: a label that fits two approved prizes of the night names neither', async t => {
    const schedule = await calendar(t);
    const auger = schedule.find(p => p.id === AUGER);
    const second = (description, id = 'supplement:2026-11-21-second') => [...schedule, { ...auger, id, description, source: 'supplement' }];
    // An exact phrase of one prize that is a one-letter variant of the other is not a guess either way.
    for (const [extra, labels] of [['Eskimo Ice Auger', ['Ice Auger', 'Ice Augur', 'Auger', 'Augur']], ['Jiffy Ice Augur', ['Ice Auger', 'Ice Augur', 'Auger']],
        ['Ice Auger Extension', ['Ice Auger', 'Auger']]]) {
        const two = second(extra);
        for (const label of labels) {
            assert.equal(matchPrize(label, DATE, two).match, 'unmatched', `${extra}: ${label}`);
            const d = decidePhoto(relabel(label), before(DATE), two, DATE);
            assert.equal(inserted(d).some(r => r.row.ticketNumber === '029'), false, `${extra}: ${label}`);
        }
        assert.equal(calendarDate({ prize: 'Ice Auger' }, two), null, extra);
    }
    // Distinguishing words still name one of them.
    const two = second('Eskimo Ice Auger');
    assert.equal(matchPrize('Strike Master Ice Auger', DATE, two).description, 'Strike Master Ice Augur');
    assert.equal(matchPrize('Eskimo Ice Auger', DATE, two).description, 'Eskimo Ice Auger');
    // The same night's spelling variant never borrows a word that belongs to the firearm or gift card.
    for (const label of ['Diamondbak', 'Gift Certificat', 'Firearms']) assert.notEqual(matchPrize(label, DATE, schedule).description, 'Strike Master Ice Augur', label);
});

test('November 21 winner, ticket and hometown checks are unchanged for a matched prize', async t => {
    const schedule = await calendar(t);
    const cases = [
        [{ name: 'Pat Keatin' }, /name is not in the cell text|name differs/],
        [{ name: 'Keating' }, /name differs from the name printed in the cell/],
        [{ ticketNumber: '028' }, /ticket number is not in the cell text/],
        [{ cellText: CELL.replace('029', '0291') }, /ticket number is not in the cell text/],
        [{ town: 'Blair, WI' }, /hometown is not in the cell text/],
        [{ ticketNumber: '', ticketStatus: 'blank' }, /cell text shows a ticket number that was not extracted/],
        [{ notes: 'name partly obscured' }, /model flagged uncertainty/],
        [{ name: 'Pat Keeting', cellText: CELL.replace('Keating', 'Keeting') }, /disagree on name/, 1],
    ];
    for (const [change, reason, only = null] of cases) {
        const d = decidePhoto(bonus(change, only), before(DATE), schedule, DATE);
        assert.equal(inserted(d).some(r => r.prizeSlotId === AUGER), false, JSON.stringify(change));
        assert.match(d.rows.filter(r => r.row.drawDate === DATE && r.outcome !== 'insert').flatMap(r => r.reasons).join(' | '), reason, JSON.stringify(change));
    }
    // The bonus ticket read as the firearm's ticket: both cells are held.
    const twice = decidePhoto(bonus({ ticketNumber: '018', cellText: CELL.replace('029', '018') }), before(DATE), schedule, DATE);
    assert.deepEqual(outcomes(twice).map(([o, n]) => [o, n]), [['held', 'Joe Stevens'], ['insert', "Pam O'leary"], ['held', 'Pat Keating']]);
});

test('every real production photo from Nov 13 on reproduces exactly the winners stored for it, and a requeue today writes nothing', async t => {
    const schedule = await calendar(t);
    // Drawing date, announcement date, fixture. Nov 15 and Nov 20 bonuses were published by an administrator after a hold (Nov 15
    // "Blackstone", fixed by 7a9d4c4; Nov 20 the cell grammar, fixed by e2f9aa4); Nov 21 is this fix. The Nov 16 drawing's "797 -JJ"
    // hold (photo of Nov 18, fixed by 49b3fd3) was a name-separator problem, not a prize; its cell is in the Nov 20 and Nov 21 reads.
    for (const [drawing, announced, name] of [['2026-11-13', '2026-11-13', '13'], ['2026-11-14', '2026-11-15', '14'], ['2026-11-15', '2026-11-15', '15'],
        ['2026-11-20', '2026-11-20', '20'], ['2026-11-21', '2026-11-21', '21']]) {
        const photo = await fixture(`facebook-winners-2026-11-${name}.extraction.json`);
        const d = decidePhoto(photo.extractionPasses, before(drawing), schedule, announced);
        const want = winners.filter(w => w.drawDate === drawing).map(record).sort();
        const got = asStored(d).filter(w => w.drawDate === drawing).map(record).sort();
        assert.deepEqual(got, want, `drawing ${drawing}`);
        assert.equal(d.rows.filter(r => r.row.drawDate === drawing).some(r => r.outcome === 'held'), false, `drawing ${drawing}`);
        // Today, with every winner stored (including the manual corrections), the same photo writes nothing.
        assert.equal(inserted(decidePhoto(photo.extractionPasses, winners, schedule, announced)).length, 0, `requeue ${drawing}`);
    }
});

test('window reads Nov 12–30 with the Page\'s own spellings publish exactly each night\'s winners, once', async t => {
    const schedule = await calendar(t);
    for (const bonusTickets of [false, true]) for (const realistic of [false, true]) {
        const truth = futureTruth(schedule, { bonusTickets, realistic, labels: PAGE_LABELS });
        assert.ok(truth.some(r => r.cellText.startsWith('Ice Auger - ')), 'the simulation prints the Page spelling');
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
        assert.equal(new Set(stored.map(w => w.id)).size, stored.length);
    }
});

test('the remaining November bonus prizes: realistic labels name their own prize only, and "Chainsaw" stays in manual review', async t => {
    const schedule = await calendar(t);
    const names = {
        '2026-11-22': ['Vexilar Fish Finder', ['Fish Finder', 'Vexilar Fish Finder', 'Finder', 'Fish Findr', 'Vexilar Fish Fnder']],
        '2026-11-26': ['Gun Safe', ['Gun Safe', 'gun safe']],
        '2026-11-27': ['Stihl Chain Saw MS 170', ['Chain Saw', 'Stihl Chain Saw', 'Stihl Chain Saw MS 170']],
        '2026-11-28': ['Inflatable Life Jacket', ['Life Jacket', 'Inflatable Life Jacket', 'Inflatible Life Jacket', 'Life Jackett', 'Jacket']],
        '2026-11-29': ['Gun Vise for Hunting', ['Gun Vise', 'Gun Vise for Hunting', 'Gun Vise for Huntng']],
    };
    for (const [date, [description, labels]] of Object.entries(names)) {
        assert.equal(schedule.find(p => p.drawDate === date && p.category === 'Bonus drawing').description, description);
        for (const label of labels) assert.equal(matchPrize(label, date, schedule).description, description, `${date} ${label}`);
    }
    // The owner's 2026-11-15 decision: joined words from the middle of a description are not identified. ("Stihl Chainsaw" is the
    // description's opening words respaced, which the Nov 15 rule of 7a9d4c4 already accepted; this fix does not change it.)
    for (const label of ['Chainsaw', 'Chainsaws', 'Chainsaw MS 170']) assert.equal(matchPrize(label, '2026-11-27', schedule).match, 'unmatched', label);
    assert.equal(matchPrize('Stihl Chainsaw', '2026-11-27', schedule).description, 'Stihl Chain Saw MS 170');
    // Short words never vary ("Vice" for Vise, "Saf" for Safe).
    assert.equal(matchPrize('Gun Vice', '2026-11-29', schedule).match, 'unmatched');
    assert.equal(matchPrize('Gun Saf', '2026-11-26', schedule).match, 'unmatched');
    // A label is only ever its own night's prize.
    assert.equal(matchPrize('Life Jacket', '2026-11-29', schedule).match, 'unmatched');
    assert.equal(matchPrize('Ice Auger', '2026-11-22', schedule).match, 'unmatched');
    assert.equal(matchPrize('Fish Finder', DATE, schedule).match, 'unmatched');
});

test('November 21 through D1: earlier winners are untouched and the three winners are written once', async t => {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    // 009 exists only on the post-cutover code (main), whose calendar reads it; production (pre-009) has no such file.
    for (const name of ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '009_raffle_season_calendar.sql', '004_raffle_photo_autopublish.sql', '005_winner_ticket_text.sql', '006_bonus_winner_tickets.sql', '007_photo_import_diagnostics.sql']) {
        const file = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8').catch(e => { if (e.code === 'ENOENT' && name.startsWith('009')) return null; throw e; });
        if (file === null) continue;
        for (const s of file.replace(/--[^\n]*/g, '').split(';').filter(v => v.trim())) await DB.prepare(s).run();
    }
    for (const e of events) await DB.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id, e.title, e.kind ?? 'raffle', e.status, e.date_start, e.summary ?? null).run();
    for (const w of before(DATE)) await DB.prepare('INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town,prize,ticket_number_text,prize_slot_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .bind(w.id, '2026-11', w.drawDate, w.ticketNumber, w.name, w.town, w.prize, w.ticketNumber === null ? null : String(w.ticketNumber), w.prizeSlotId).run();
    const stored = async () => (await DB.prepare('SELECT id, draw_date AS drawDate, ticket_number AS ticketNumber, winner_name AS name, town, prize, prize_slot_id AS prizeSlotId FROM raffle_winners ORDER BY draw_date, id').all()).results;
    const original = await stored();
    const photo = { photoId: nov21.photoId, postId: nov21.postId, sha256: nov21.sha256, width: 1179, height: 609, model: nov21.model, passes: passes() };
    for (let run = 1; run <= 3; run++) {
        const { existing, schedule } = await loadContext(DB, ['2026-11']);
        const d = decidePhoto(passes(), existing, schedule, DATE);
        assert.equal(d.status, run === 1 ? 'published' : 'duplicate', `run ${run}`);
        assert.equal(inserted(d).length, run === 1 ? 3 : 0, `run ${run}`);
        assert.equal(await writeDecision(DB, photo, d, true), 'published', `run ${run}`);
        const now = await stored();
        assert.deepEqual(now.filter(w => w.drawDate < DATE), original, `run ${run}: earlier winners unchanged`);
        // Byte for byte what production holds now, the administrator's bonus record included.
        assert.deepEqual(now.filter(w => w.drawDate === DATE).map(record).sort(), winners.filter(w => w.drawDate === DATE).map(record).sort(), `run ${run}: same as production`);
        await DB.prepare(`UPDATE raffle_photo_auto_imports SET status='failed' WHERE photo_id=?`).bind(nov21.photoId).run(); // as a requeue
    }
});
