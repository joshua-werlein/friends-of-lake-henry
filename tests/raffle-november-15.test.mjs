import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { decidePhoto, matchPrize, calendarDate, loadContext, writeDecision } from '../src/lib/server/raffle-photo-autopublish.ts';
import { asStored, calendar, events, fixture, inserted } from './november-table.mjs';

// November 15, 2026 (incident photo:review:122335947860073310). Both production reads returned the bonus cell
// "Blackstone - Mike Loeser, Osseo, WI". The approved calendar says Black Stone 28" Griddle, so the winner was held and the griddle
// was reported a second time as a prize with no winner. Both reads also spelled the stored Nov 14 winner Chad Cliburn "Cilburn".
// The reads and stored winners below are the production records; nothing here calls a model.
const { winners } = await fixture('november-2026-winners-through-15.json');
const nov15 = await fixture('facebook-winners-2026-11-15.extraction.json');
const GRIDDLE = 'event-bonus:2026-11-05-day-15-tikka-t3x-lite-roughtech-ember-7mm-rem-mag'; // The event id says 11-05; its date is Nov 15.
const before = date => winners.filter(w => w.drawDate < date);
const summary = d => d.rows.filter(r => r.outcome !== 'duplicate' && r.outcome !== 'outside-window').map(r => [r.outcome, r.row.drawDate, r.row.name, r.prize]);
const passes = () => structuredClone(nov15.extractionPasses);
const relabel = label => passes().map(p => ({ ...p, rows: p.rows.map(r => r.name === 'Mike Loeser' ? { ...r, prize: label, cellText: r.cellText.replace('Blackstone', label) } : r) }));

test('a differently spaced label names the approved prize; brands, misspellings and partial words do not', async t => {
    const schedule = await calendar(t);
    for (const label of ['Blackstone', 'BLACKSTONE', 'Black Stone', 'Blackstone 28', 'Blacks tone 28', 'Black Stone 28" Griddle', 'Griddle']) {
        assert.deepEqual(matchPrize(label, '2026-11-15', schedule), { description: 'Black Stone 28" Griddle', match: 'scheduled' }, label);
        assert.equal(calendarDate({ prize: label }, schedule), '2026-11-15', label);
    }
    // Words joined from the middle of a prize name keep the manual review they had: Nov 27 "Chainsaw" (Stihl Chain Saw MS 170).
    for (const [label, date] of [['Chainsaw', '2026-11-27'], ['Lifejacket', '2026-11-28'], ['Fishfinder', '2026-11-22'], ['Stone28', '2026-11-15']]) {
        assert.equal(matchPrize(label, date, schedule).match, 'unmatched', label);
        assert.equal(calendarDate({ prize: label }, schedule), null, label);
    }
    assert.equal(matchPrize('Chain Saw', '2026-11-27', schedule).description, 'Stihl Chain Saw MS 170'); // Unchanged: an exact phrase.
    // Not the prize's opening words: held as before.
    for (const label of ['Blackstone Griddle', 'Blackstne', 'Blackstones', 'Black', 'Stone', 'Kstone', 'Lackstone', 'Blackston'])
        assert.equal(matchPrize(label, '2026-11-15', schedule).match, 'unmatched', label);
    // Only on the prize's own date, and never for the firearm or gift card by accident.
    assert.equal(matchPrize('Blackstone', '2026-11-14', schedule).match, 'unmatched');
    assert.equal(matchPrize('Blackstone', '2026-11-16', schedule).match, 'unmatched');
});

test('November 15 production reads: Mike Loeser publishes as the Black Stone griddle bonus, once', async t => {
    const schedule = await calendar(t);
    const [a, b] = nov15.extractionPasses.map(p => p.rows.find(r => r.name === 'Mike Loeser'));
    assert.deepEqual(a, b, 'both production passes read the cell identically');
    assert.deepEqual([a.prize, a.cellText, a.ticketNumber, a.ticketStatus], ['Blackstone', 'Blackstone - Mike Loeser, Osseo, WI', '', 'blank']);
    const d = decidePhoto(passes(), before('2026-11-15'), schedule, '2026-11-15');
    assert.deepEqual(summary(d), [
        ['rejected', '2026-11-14', 'Chad Cilburn', null],
        ['insert', '2026-11-15', 'Fran Manka', '1st place — Tikka T3X Lite Roughtech Ember 7MM Rem Mag'],
        ['insert', '2026-11-15', 'Tom Kupietz', '2nd place — $100 gift certificate from Safe & Secure Firearms'],
        ['insert', '2026-11-15', 'Mike Loeser', 'Bonus — Black Stone 28" Griddle'],
    ]);
    const mike = d.rows.find(r => r.row.name === 'Mike Loeser');
    assert.deepEqual([mike.prizeSlotId, mike.prizeMatch, mike.row.town, mike.winnerId], [GRIDDLE, 'scheduled', 'Osseo, WI', `2026-11-2026-11-15-slot-${GRIDDLE.replace(/[^\w-]/g, '-')}`]);
    assert.ok(mike.reasons.includes(`prize matches approved calendar entry ${GRIDDLE}`));
    assert.equal(d.rows.some(r => /no winner was read/.test(r.reasons.join(' '))), false);
    // As production stands today (Fran Manka and Tom Kupietz already published): a requeue adds Mike Loeser and nothing else.
    const requeue = decidePhoto(passes(), winners, schedule, '2026-11-15');
    assert.deepEqual(inserted(requeue).map(r => [r.row.name, r.prizeSlotId]), [['Mike Loeser', GRIDDLE]]);
    // Once he is stored, another run of the same photo writes nothing.
    const again = decidePhoto(passes(), [...winners, ...asStored(requeue)], schedule, '2026-11-15');
    assert.equal(inserted(again).length, 0);
    assert.equal(again.rows.find(r => r.row.name === 'Mike Loeser').outcome, 'duplicate');
});

test('similar approved prizes on one drawing stay ambiguous and the winner is held', async t => {
    const schedule = await calendar(t);
    const second = { ...schedule.find(p => p.id === GRIDDLE), id: 'supplement:griddle-36', description: 'Black Stone 36" Griddle', source: 'supplement' };
    const two = [...schedule, second];
    for (const label of ['Blackstone', 'Black Stone', 'Griddle']) assert.equal(matchPrize(label, '2026-11-15', two).match, 'unmatched', label);
    assert.equal(calendarDate({ prize: 'Blackstone' }, two), null);
    assert.equal(matchPrize('Blackstone 36', '2026-11-15', two).description, 'Black Stone 36" Griddle');
    const d = decidePhoto(passes(), before('2026-11-15'), two, '2026-11-15');
    const mike = d.rows.find(r => r.row.name === 'Mike Loeser');
    assert.equal(mike.outcome, 'held');
    assert.match(mike.reasons.join(' '), /must identify exactly one approved scheduled prize/);
    assert.equal(inserted(d).some(r => r.row.name === 'Mike Loeser'), false);
    // One unidentified winner cannot cover two unaccounted prizes, so both are still listed.
    assert.deepEqual(d.rows.filter(r => /no winner was read/.test(r.reasons.join(' '))).map(r => r.row.prize), ['Black Stone 28" Griddle', 'Black Stone 36" Griddle']);
    // The same prize under a joined spelling elsewhere on the day is ambiguous too.
    const brand = [...schedule, { ...second, description: 'Blackstone Tool Kit' }];
    assert.equal(matchPrize('Blackstone', '2026-11-15', brand).match, 'unmatched');
    // A draft or rejected look-alike is not on the approved calendar and changes nothing.
    assert.equal(matchPrize('Blackstone', '2026-11-15', [...schedule, { ...second, status: 'draft' }]).description, 'Black Stone 28" Griddle');
});

test('an unidentified winner and the one prize nobody was read for are reported as one held row', async t => {
    const schedule = await calendar(t);
    const d = decidePhoto(relabel('Flat Top Grill'), before('2026-11-15'), schedule, '2026-11-15');
    const held = d.rows.filter(r => r.outcome === 'held');
    assert.equal(held.length, 1);
    assert.equal(held[0].row.name, 'Mike Loeser');
    assert.equal(held[0].winnerId, null);
    assert.match(held[0].reasons[0], /must identify exactly one approved scheduled prize/);
    assert.match(held[0].reasons[1], /^approved for this drawing with no winner read; check whether this winner belongs to it: Black Stone 28" Griddle$/);
    assert.deepEqual(inserted(d).map(r => r.row.name), ['Fran Manka', 'Tom Kupietz']);
    // A prize no cell could belong to is still reported on its own.
    const missed = passes().map(p => ({ ...p, rows: p.rows.filter(r => r.name !== 'Mike Loeser') }));
    const alone = decidePhoto(missed, before('2026-11-15'), schedule, '2026-11-15');
    assert.deepEqual(alone.rows.filter(r => r.outcome === 'held').map(r => [r.row.name, r.row.prize]), [['', 'Black Stone 28" Griddle']]);
});

test('November 14: the stored Chad Cliburn is never changed by the later "Cilburn" read', async t => {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    for (const name of ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '009_raffle_season_calendar.sql', '004_raffle_photo_autopublish.sql', '005_winner_ticket_text.sql', '006_bonus_winner_tickets.sql', '007_photo_import_diagnostics.sql']) {
        const sql = (await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');
        for (const s of sql.split(';').filter(v => v.trim())) await DB.prepare(s).run();
    }
    for (const e of events) await DB.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id, e.title, e.kind ?? 'raffle', e.status, e.date_start, e.summary ?? null).run();
    for (const w of before('2026-11-15')) await DB.prepare('INSERT INTO raffle_winners(id,raffle_key,draw_date,ticket_number,winner_name,town,prize,ticket_number_text,prize_slot_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .bind(w.id, '2026-11', w.drawDate, w.ticketNumber, w.name, w.town, w.prize, w.ticketNumber === null ? null : String(w.ticketNumber), w.prizeSlotId).run();
    const stored = async () => (await DB.prepare('SELECT id, draw_date AS drawDate, ticket_number AS ticketNumber, winner_name AS name, town, prize, prize_slot_id AS prizeSlotId FROM raffle_winners ORDER BY draw_date, id').all()).results;
    const original = await stored();
    const chad = original.find(w => w.id === '2026-11-2026-11-14-449');
    assert.deepEqual([chad.name, chad.town, chad.prize], ['Chad Cliburn', 'Boerne, TX', '2nd place — $100 gift certificate from Safe & Secure Firearms']);

    const photo = { photoId: nov15.photoId, postId: nov15.postId, sha256: nov15.sha256, width: 1021, height: 408, model: nov15.model, passes: passes() };
    for (let run = 1; run <= 3; run++) {
        // The same path as the Worker: stored winners and the approved calendar from D1, then the decision, then the write.
        const { existing, schedule } = await loadContext(DB, ['2026-11']);
        const d = decidePhoto(passes(), existing, schedule, '2026-11-15');
        const row = d.rows.find(r => r.row.ticketNumber === '449');
        assert.deepEqual([row.outcome, row.row.name, row.reasons], ['rejected', 'Chad Cilburn', ['conflicts with existing winner (name)']]);
        assert.equal(await writeDecision(DB, photo, d, true), 'partial');
        const now = await stored();
        // Every winner stored before the photo is byte for byte the same; only the three Nov 15 winners are added, once.
        assert.deepEqual(now.filter(w => w.drawDate < '2026-11-15'), original, `run ${run}`);
        assert.deepEqual(now.filter(w => w.drawDate === '2026-11-15').map(w => [w.name, w.town, w.ticketNumber, w.prize, w.prizeSlotId]).sort(), [
            ['Fran Manka', 'Blair, WI', 885, '1st place — Tikka T3X Lite Roughtech Ember 7MM Rem Mag', 'event:2026-11-05-day-15-tikka-t3x-lite-roughtech-ember-7mm-rem-mag'],
            ['Mike Loeser', 'Osseo, WI', null, 'Bonus — Black Stone 28" Griddle', GRIDDLE],
            ['Tom Kupietz', 'Arcadia, WI', 6, '2nd place — $100 gift certificate from Safe & Secure Firearms', 'daily:2026-11-15:0'],
        ], `run ${run}`);
        assert.equal(now.filter(w => /c[il]{2}burn/i.test(w.name)).length, 1);
        const audit = (await DB.prepare(`SELECT outcome, count(*) AS n FROM raffle_photo_auto_rows WHERE photo_id=? GROUP BY outcome ORDER BY outcome`).bind(nov15.photoId).all()).results;
        assert.deepEqual(audit.filter(r => r.outcome === 'inserted' || r.outcome === 'held' || r.outcome === 'rejected'), [{ outcome: 'inserted', n: 3 }, { outcome: 'rejected', n: 1 }], `run ${run}`);
        // A requeue reopens a partial photo exactly like this.
        await DB.prepare(`UPDATE raffle_photo_auto_imports SET status='failed' WHERE photo_id=?`).bind(nov15.photoId).run();
    }
});

test('the November 13 and November 14 production reads decide exactly as they did in production', async t => {
    const schedule = await calendar(t);
    const nov13 = await fixture('facebook-winners-2026-11-13.extraction.json');
    assert.deepEqual(summary(decidePhoto(nov13.extractionPasses, before('2026-11-13'), schedule, '2026-11-13')), [
        // Stored by hand as "Tomah, W" and "Coon Valley, W"; the photo's full hometowns are reported and nothing is overwritten.
        ['rejected', '2026-11-12', 'Kurt Kuehl', null],
        ['rejected', '2026-11-12', 'Carmen Peters', null],
        ['insert', '2026-11-13', 'Mary Drangstveit', '1st place — Kimber K6S DASA Combat 357 Mag'],
        ['insert', '2026-11-13', 'Dan Molstad', '2nd place — $100 gift certificate from Safe & Secure Firearms'],
        ['insert', '2026-11-13', 'Tom Field', 'Bonus — St. Croix Panfish Rod'],
    ]);
    // The Nov 14 drawing's photo was posted on Nov 15 at 5:29 PM Central and read the name correctly.
    const nov14 = await fixture('facebook-winners-2026-11-14.extraction.json');
    const d = decidePhoto(nov14.extractionPasses, before('2026-11-14'), schedule, '2026-11-15');
    assert.equal(d.status, 'published');
    assert.deepEqual(summary(d), [
        ['insert', '2026-11-14', 'Dennis Bishop', '1st place — Colt Lightweight Officers Model 45 ACP'],
        ['insert', '2026-11-14', 'Chad Cliburn', '2nd place — $100 gift certificate from Safe & Secure Firearms'],
        ['insert', '2026-11-14', 'Troy Lindberg', 'Bonus — St. Croix Walleye Rod'],
    ]);
    // Processed again today, both photos write nothing.
    assert.equal(inserted(decidePhoto(nov13.extractionPasses, winners, schedule, '2026-11-13')).length, 0);
    assert.equal(decidePhoto(nov14.extractionPasses, winners, schedule, '2026-11-15').status, 'duplicate');
});
