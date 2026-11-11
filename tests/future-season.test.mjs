import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { activeSeason, configureSeason, inSeasonDay, raffleSeason, seasonKey, seasonLabel, seasonObjectName } from '../src/lib/server/raffle-season.ts';
import { burstCadence, drawingStartFastUntil, inDiscoveryWindow, inDrawingMonth } from '../src/lib/server/raffle-discovery-schedule.ts';
import { calendarPosition, monthCalendar, prizeSchedule, recurringPrizes, reviewRecurring, saveRecurring, setCalendarStatus } from '../src/lib/server/raffle-prizes.ts';
import { decidePhoto } from '../src/lib/server/raffle-photo-autopublish.ts';
import { timingDay } from '../workers/facebook-live/timing.ts';
import { pollDue } from '../workers/facebook-photos/webhook.ts';
import { build } from 'esbuild';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// The Worker module imports cloudflare:workers for its RPC class; a stub is enough to call processPost directly.
async function photoWorker() {
    const out = await build({ entryPoints: ['workers/facebook-photos/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022',
        plugins: [{ name: 'cf', setup(b) { b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf' }));
            b.onLoad({ filter: /.*/, namespace: 'cf' }, () => ({ contents: 'export class WorkerEntrypoint { constructor(ctx, env) { this.env = env; } }' })); } }] });
    const file = join(await mkdtemp(join(tmpdir(), 'fohl-photo-')), 'index.mjs');
    await writeFile(file, out.outputFiles[0].text);
    return import(pathToFileURL(file).href);
}

const SEASON_2027 = { FB_SEASON_START: '2027-11-01T00:00:00-05:00', FB_SEASON_END: '2027-12-01T00:00:00-06:00' };
const SEASON_2026 = { FB_SEASON_START: '2026-11-01T00:00:00-05:00', FB_SEASON_END: '2026-12-01T00:00:00-06:00' };
const shift = v => JSON.parse(JSON.stringify(v).replaceAll('2026-11', '2027-11'));
const events2026 = JSON.parse(await readFile(new URL('./fixtures/november-2026-published-raffle-events.json', import.meta.url))).events;
const nov10 = JSON.parse(await readFile(new URL('./fixtures/facebook-winners-2026-11-10.extraction.json', import.meta.url)));

async function database(t, events = events2026) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    for (const name of ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '009_raffle_season_calendar.sql',
        '004_raffle_photo_autopublish.sql', '005_winner_ticket_text.sql', '006_bonus_winner_tickets.sql', '007_photo_import_diagnostics.sql']) {
        const sql = (await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');
        for (const statement of sql.split(';').filter(v => v.trim())) await DB.prepare(statement).run();
    }
    for (const e of events) await DB.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id, e.title, e.kind, e.status, e.date_start, e.summary).run();
    return DB;
}
const at = central => new Date(central); // ISO with explicit Central offset

test('the 2026 season keeps its exact identity: November 1–30, coordinator november-2026, same windows', t => {
    t.after(() => configureSeason(undefined));
    for (const env of [undefined, SEASON_2026]) {
        configureSeason(env);
        assert.equal(seasonObjectName(), 'november-2026');
        assert.equal(seasonKey(activeSeason()), '2026-11');
        assert.equal(seasonLabel(), 'November 1–30, 2026');
        assert.ok(inSeasonDay('2026-11-01') && inSeasonDay('2026-11-30') && !inSeasonDay('2026-10-31') && !inSeasonDay('2026-12-01'));
        assert.ok(timingDay('2026-11-30') && !timingDay('2026-12-01') && !timingDay('2027-11-05'));
        assert.ok(inDiscoveryWindow(at('2026-11-10T17:55:00-06:00')) && !inDiscoveryWindow(at('2027-11-10T17:55:00-06:00')));
        assert.ok(burstCadence(at('2026-11-10T18:00:00-06:00')));
        assert.ok(pollDue(at('2026-11-10T18:00:00-06:00')) && !pollDue(at('2027-11-10T18:00:00-06:00')));
    }
});

test('a configured 2027 season moves every schedule, window and coordinator without code changes', t => {
    t.after(() => configureSeason(undefined));
    configureSeason(SEASON_2027);
    assert.equal(seasonObjectName(), 'november-2027');
    assert.equal(seasonLabel(), 'November 1–30, 2027');
    assert.ok(inDrawingMonth(at('2027-11-10T12:00:00-06:00')) && !inDrawingMonth(at('2026-11-10T12:00:00-06:00')));
    assert.ok(inDiscoveryWindow(at('2027-11-10T17:50:00-06:00')) && !inDiscoveryWindow(at('2027-11-10T17:49:00-06:00')));
    assert.ok(!inDiscoveryWindow(at('2026-11-10T17:55:00-06:00')) && !inDiscoveryWindow(at('2028-11-10T17:55:00-06:00')));
    assert.ok(drawingStartFastUntil(at('2027-11-10T18:00:00-06:00')) > 0 && drawingStartFastUntil(at('2026-11-10T18:00:00-06:00')) === 0);
    assert.ok(timingDay('2027-11-30') && !timingDay('2026-11-10'));
    assert.ok(pollDue(at('2027-11-10T18:00:00-06:00')) && !pollDue(at('2026-11-10T18:00:00-06:00')));
    // An invalid or missing setting means no season at all, never a guessed one.
    configureSeason({ FB_SEASON_START: 'November 2028', FB_SEASON_END: SEASON_2027.FB_SEASON_END });
    assert.equal(activeSeason(), null);
    assert.ok(!inDiscoveryWindow(at('2027-11-10T17:55:00-06:00')) && !inSeasonDay('2027-11-10'));
    assert.equal(raffleSeason({ FB_SEASON_START: '2027-11-01T00:00:00-05:00', FB_SEASON_END: '2029-11-01T00:00:00-05:00' }), null);
});

test('November 2026 calendar is approved by migration with the same prizes, slot ids and places as before', async t => {
    const DB = await database(t);
    assert.deepEqual(await monthCalendar(DB, '2026-11'), { month: '2026-11', status: 'approved', approvedAt: '2026-11-01T06:00:00.000Z', mainPrizeHeading: 'Firearm' });
    const schedule = await prizeSchedule(DB, '2026-11');
    const daily = schedule.filter(p => p.source === 'daily');
    assert.equal(daily.length, 30);
    assert.ok(daily.every(p => p.id === `daily:${p.drawDate}:0` && p.position === null && p.place === 2));
    const main = schedule.find(p => p.drawDate === '2026-11-10' && p.category === 'Main prize');
    assert.equal(calendarPosition(main, schedule), 1);
    assert.equal(calendarPosition(daily.find(p => p.drawDate === '2026-11-10'), schedule), 2);
});

test('a future season stays private until its recurring prizes and calendar are explicitly approved', async t => {
    const DB = await database(t, shift(events2026));
    const passes = shift(nov10.extractionPasses);
    // Published 2027 events alone are not authoritative: nothing public, nothing publishable.
    assert.equal((await prizeSchedule(DB, '2027-11')).length, 0);
    assert.equal((await monthCalendar(DB, '2027-11')).status, 'draft');
    const unapproved = decidePhoto(passes, [], await prizeSchedule(DB, '2027-11'), '2027-11-10');
    assert.equal(unapproved.rows.filter(r => r.outcome === 'insert').length, 0);
    // An AI or manual recurring proposal is a private draft; its place needs independent confirmation.
    const { id } = await saveRecurring(DB, '2027-11', { category: 'Gift card', position: null, description: '$100 gift certificate from Safe & Secure Firearms', notes: 'from poster' });
    assert.deepEqual((await saveRecurring(DB, '2027-11', { category: 'Gift card', position: null, description: '$100 Gift Certificate from Safe & Secure Firearms', notes: '' })).duplicate, true);
    await assert.rejects(reviewRecurring(DB, id, 1, 'approve', { category: 'Gift card', position: 2, description: '$100 gift certificate from Safe & Secure Firearms', notes: '' }, false), /Independently confirm/);
    await reviewRecurring(DB, id, 1, 'approve', { category: 'Gift card', position: 2, description: '$100 gift certificate from Safe & Secure Firearms', notes: '' }, true);
    assert.equal((await recurringPrizes(DB, '2027-11'))[0].slot, 0);
    // Still private: the calendar itself has not been approved.
    assert.equal((await prizeSchedule(DB, '2027-11')).length, 0);
    const drafts = await prizeSchedule(DB, '2027-11', true);
    assert.ok(drafts.some(p => p.id === 'daily:2027-11-10:0'));
    await assert.rejects(setCalendarStatus(DB, '2027-12', 'approved'), /Publish the month/);
    await setCalendarStatus(DB, '2027-11', 'approved', 'Firearm');
    const schedule = await prizeSchedule(DB, '2027-11');
    const decision = decidePhoto(passes, [], schedule, '2027-11-10');
    const today = decision.rows.filter(r => r.row.drawDate === '2027-11-10');
    assert.deepEqual(today.map(r => [r.outcome, r.row.ticketNumber, r.row.name]), [['insert', '368', 'Jared White'], ['insert', '105', 'Gary Gran']]);
    assert.match(today[0].prize, /^1st place — /);
    assert.match(today[1].prize, /^2nd place — \$100 gift certificate/);
    assert.ok(decision.rows.every(r => r.outcome !== 'insert' || r.row.drawDate >= '2027-11-08'));
    assert.ok(decision.rows.filter(r => r.row.drawDate < '2027-11-08').every(r => r.outcome === 'outside-window'));
    // Reopening returns the month to private: nothing publishes, and the review is logged.
    await setCalendarStatus(DB, '2027-11', 'draft');
    assert.equal((await prizeSchedule(DB, '2027-11')).length, 0);
    const log = await DB.prepare("SELECT action FROM raffle_prize_review_log WHERE prize_id IN ('calendar:2027-11', ?) ORDER BY created_at").bind(id).all();
    assert.deepEqual(log.results.map(r => r.action).sort(), ['calendar-approve', 'calendar-reopen', 'recurring-approve', 'recurring-draft'].sort());
    // November 2026's approval is unaffected by anything done to 2027.
    assert.equal((await monthCalendar(DB, '2026-11')).status, 'approved');
});

test('photo Worker does not download or run AI for a post whose month calendar is unapproved', async t => {
    const DB = await database(t, shift(events2026));
    const now = new Date('2027-11-10T18:20:00-06:00'), postId = '144051422124740_777';
    let aiCalls = 0, downloads = 0;
    const env = { DB, ...SEASON_2027, FB_RAFFLE_MARKER: '#LakeHenryRaffle',
        AI: { run: async () => { aiCalls++; throw Error('AI must not run'); } },
        FACEBOOK_READS: { read: async (path) => {
            if (path !== postId) { downloads++; throw Error('photo must not be downloaded'); }
            return { id: postId, message: 'Tonight\'s winners #LakeHenryRaffle', created_time: '2027-11-11T00:10:00+0000',
                attachments: { data: [{ type: 'photo', target: { id: '9000001' }, url: 'https://www.facebook.com/photo/' }] } };
        } } };
    configureSeason(env);
    t.after(() => configureSeason(undefined));
    const { processPost } = await photoWorker();
    const result = await processPost(env, postId, () => { downloads++; throw Error('no network'); }, now);
    assert.deepEqual(result, { queue: 'ignored' });
    assert.equal(aiCalls, 0);
    assert.equal(downloads, 0);
});
