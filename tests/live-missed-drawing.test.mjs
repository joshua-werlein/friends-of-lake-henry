// Regression tests for the November 26, 2026 missed drawing: the Live was posted as a Reel (/reel/<id>), which the
// exact /<page>/videos/<id>/ rule silently rejected, and no alert covered a drawing with no video at all.
// Every test drives the real cron handler, coordinator, poller and public resolver over in-memory DO storage, KV,
// Graph and Resend. No network, no production data.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadRaffleSelection, SnapshotCache, STATE_KEY, VERIFICATION_KEY } from '../src/lib/server/raffle-selection.ts';
import { AUTOMATIC_KEY } from '../src/lib/server/facebook-automation.ts';
import { configureSeason, seasonObjectName } from '../src/lib/server/raffle-season.ts';
import { DiscoveryCoordinator } from '../workers/facebook-live/coordinator.ts';
import { runPoll } from '../workers/facebook-live/poller.ts';
import worker from '../workers/facebook-live/index.ts';
import { extractCandidates } from '../workers/facebook-live/graph.ts';
import { extractLiveCandidates, discoverLivestreams } from '../workers/facebook-live/livestream.ts';
import { drawingSelection, missedDrawingSignals, noDrawingDays } from '../workers/facebook-live/alerts.ts';
import { timingEntry } from '../workers/facebook-live/timing.ts';
import { FACEBOOK_API_VERSION, FACEBOOK_GRAPH_PAGE_ID as GRAPH, FACEBOOK_LIVE_CONTRACT, FACEBOOK_PAGE_ID as PAGE, RAFFLE_LIVE_KEY } from '../src/lib/facebook.ts';

const season2026 = { FB_SEASON_START: '2026-11-01T00:00:00-05:00', FB_SEASON_END: '2026-12-01T00:00:00-06:00' };
const season2027 = { FB_SEASON_START: '2027-11-01T00:00:00-05:00', FB_SEASON_END: '2027-12-01T00:00:00-06:00' };
const central = (y, mo, d, h, mi, s = 0) => Date.UTC(y, mo - 1, d, h + 6, mi, s); // CST (UTC-6) all of late November
const nov26 = (h, mi, s = 0) => central(2026, 11, 26, h, mi, s);
const iso = t => new Date(t).toISOString().replace('.000Z', '+0000');
const canonical = id => `https://www.facebook.com/${PAGE}/videos/${id}/`;
const REEL = '1467167912212118'; // the real November 26 video (public ID from the admin's manual selection)
const TOKEN = 'TEST_ONLY_TOKEN_SHOULD_NEVER_BE_STORED';
const receipt = (expiresAt = '2026-12-01T06:00:00.000Z') => ({ schemaVersion: 5, graphPageId: GRAPH, publicPageId: PAGE, apiVersion: FACEBOOK_API_VERSION,
    contract: FACEBOOK_LIVE_CONTRACT, verifiedVideoId: '1129604836279234', evidence: 'page-video-live-origin-policy-reviewed', publicPlaybackVerified: true,
    rollbackTested: true, verifiedAt: '2026-11-06T03:03:33.834Z', expiresAt });
const alertsOn = { ALERTS_ENABLED: 'true', ALERTS_MODE: 'live', ALERT_RESEND_API_KEY: 're_test', ALERT_EMAIL_TO: 'ops@example.test' };
// Yesterday's (Nov 25) real selection shape, so "previous drawing" handling is exercised.
const YESTERDAY = '2466752293857807';
const yesterdayStage = { schemaVersion: 2, graphPageId: GRAPH, publicPageId: PAGE, apiVersion: FACEBOOK_API_VERSION, contract: FACEBOOK_LIVE_CONTRACT,
    id: YESTERDAY, videoId: YESTERDAY, postId: `${GRAPH}_${YESTERDAY}`, url: canonical(YESTERDAY), publishedAt: '2026-11-26T00:00:34+0000',
    observedAt: '2026-11-26T00:00:45.001Z', origin: 'page-video-live-status', originStatus: 'LIVE', originObservedAt: '2026-11-26T00:00:45.001Z',
    drawingDate: '2026-11-25', status: 'video', liveStatus: 'LIVE' };

/**
 * One drawing day. `videos`: { id, posted (post created_time ms), created (Video created_time ms), live (status or fn(clock)),
 * link, owner, type, visibleFrom (post appears in published_posts), message }.
 */
function day({ videos = [], season = season2026, alerts = true, manual, graphError, resend = () => 200, extraEnv = {}, liveVideos = {} } = {}) {
    configureSeason(season);
    let clock = 0, alarm = null, n = 0;
    const data = new Map([[RAFFLE_LIVE_KEY, JSON.stringify(manual ?? { latestVideoUrl: canonical(YESTERDAY), updatedAt: '2026-11-26T00:01:00.000Z', selectionMode: 'automatic', automaticEnabled: true })],
        [VERIFICATION_KEY, JSON.stringify(receipt(season === season2027 ? '2027-12-01T06:00:00.000Z' : undefined))],
        [AUTOMATIC_KEY, JSON.stringify(yesterdayStage)]]);
    const kvReads = [], kvWrites = [];
    const kv = { data, async get(k) { kvReads.push(k); return data.get(k) ?? null; }, async put(k, v) { kvWrites.push(k); data.set(k, v); } };
    const disk = new Map();
    const storage = { async get(k) { return structuredClone(disk.get(k)); }, async put(k, v) { disk.set(k, structuredClone(v)); },
        async getAlarm() { return alarm; }, async setAlarm(v) { alarm = v; } };
    const graphCalls = [], emails = [];
    const fetcher = async (input, init) => {
        const u = new URL(String(input.url ?? input));
        if (u.hostname === 'api.resend.com') {
            const body = JSON.parse(init.body);
            emails.push({ at: clock, key: init.headers['Idempotency-Key'], subject: body.subject, text: body.text ?? '' });
            return new Response('{}', { status: resend(emails.length) });
        }
        const path = u.pathname.split('/').slice(2).join('/');
        graphCalls.push(path);
        if (graphError) return Response.json({ error: { code: graphError } }, { status: graphError === 190 ? 401 : 400 });
        if (path === GRAPH) return Response.json({ id: GRAPH });
        if (path.endsWith('published_posts')) return Response.json({ data: videos.filter(v => clock >= (v.visibleFrom ?? -Infinity)).map(v => ({
            id: `${GRAPH}_${v.post ?? v.id}`, created_time: iso(v.posted), ...(v.message ? { message: v.message } : {}),
            attachments: { data: [{ type: v.type ?? 'video_inline', target: { id: v.id, url: v.link ?? canonical(v.id) }, url: v.link ?? canonical(v.id) }] } })) });
        // Read-only LiveVideo node lookups (Release B): { [liveId]: { video, status } | { error: code } }.
        if (u.searchParams.get('fields') === 'id,status,video' && liveVideos[path]) { const lv = liveVideos[path];
            if (lv.error) return Response.json({ error: { code: lv.error } }, { status: 400 });
            return Response.json({ id: path, ...(lv.status ? { status: lv.status } : {}), ...(lv.video ? { video: { id: lv.video } } : {}) }); }
        const v = videos.find(x => x.id === path);
        if (v && u.searchParams.get('fields') === 'id,format') return Response.json({ id: v.id, format: [{ width: 720, height: 1280 }] });
        if (v) { const live = typeof v.live === 'function' ? v.live(clock) : v.live;
            return Response.json({ id: v.id, from: { id: v.owner ?? GRAPH }, published: true, embeddable: v.embeddable ?? true,
                ...(v.created ? { created_time: iso(v.created) } : {}), ...(live ? { live_status: live } : {}) }); }
        return Response.json({ error: { code: 100 } }, { status: 400 });
    };
    const env = { FB_AUTOMATION_ENABLED: 'true', FB_VIDEO_PROBE_ENABLED: 'true', FB_GRAPH_PAGE_ID: GRAPH, FB_PUBLIC_PAGE_ID: PAGE,
        FB_PAGE_ACCESS_TOKEN: TOKEN, FB_ACCESS_REVISION: 'r', FB_POLL_INTERVAL_SECONDS: '60', CONFIG: kv, ...season, ...(alerts ? alertsOn : {}), ...extraEnv };
    const coord = new DiscoveryCoordinator(storage, env, () => clock, runPoll, fetcher);
    // The Durable Object's private routes (discovery-object.ts) over the same coordinator.
    const objectNames = [];
    const scheduler = { idFromName(name) { objectNames.push(name); return name; }, get() { return { async fetch(u, init) {
        const path = new URL(u).pathname;
        if (path === '/kick') { await coord.kick(); return new Response(null, { status: 204 }); }
        if (path === '/missed') return Response.json(await coord.missedDrawing());
        if (path === '/alerts/claim') return Response.json(await coord.claimAlerts());
        if (path === '/alerts/result') { const b = JSON.parse(init.body); return Response.json({ applied: await coord.recordAlert(b.id, b.key, b.result) }); }
        if (path === '/event') { const b = init.body.startsWith('{') ? JSON.parse(init.body) : { id: init.body, events: [] }; return Response.json({ accepted: await coord.event(b.id, b.events) }); }
        return new Response(null, { status: 404 });
    } }; } };
    const cronEnv = { ...env, DISCOVERY_SCHEDULER: scheduler };
    const realFetch = globalThis.fetch;
    // Production crons (UTC): "50-59 23 * 11 *" and "0-30 0 * 11,12 *".
    const cronDue = t => { const d = new Date(t), m = d.getUTCMonth() + 1, h = d.getUTCHours(), mi = d.getUTCMinutes();
        return (h === 23 && mi >= 50 && m === 11) || (h === 0 && mi <= 30 && (m === 11 || m === 12)); };
    return { kv, kvReads, kvWrites, graphCalls, emails, coord, disk, objectNames,
        get alarm() { return alarm; }, get clock() { return clock; },
        incidents() { return disk.get('alerts:incidents') ?? {}; },
        state() { return JSON.parse(data.get(STATE_KEY) ?? 'null'); },
        manualSave(at, videoUrl) { const prev = JSON.parse(data.get(RAFFLE_LIVE_KEY));
            data.set(RAFFLE_LIVE_KEY, JSON.stringify({ ...prev, latestVideoUrl: videoUrl, updatedAt: new Date(at).toISOString(), manualOverrideAt: new Date(at).toISOString(), manualOverrideUrl: videoUrl })); },
        async hint(at, events = []) { clock = at; return coord.event((++n).toString(16).padStart(64, '0'), events); },
        show(at) { return loadRaffleSelection(kv, true, new Date(at), season, () => coord.selectionSnapshot(), new SnapshotCache()); },
        /** Advance second by second: cron each minute when due, then any due alarm (the DO serializes alarms). */
        async run(from, to, step = 1000, onTick) {
            globalThis.fetch = fetcher;
            try {
                for (let t = from; t <= to; t += step) {
                    clock = t;
                    if (onTick) await onTick(t);
                    if (t % 60000 === 0 && cronDue(t)) { mock.timers.enable({ apis: ['Date'], now: t }); try { await worker.scheduled(undefined, cronEnv); } finally { mock.timers.reset(); } }
                    if (alarm !== null && alarm <= t) { alarm = null; await coord.alarm(); }
                }
            } finally { globalThis.fetch = realFetch; }
        } };
}
const evening = h => h.run(nov26(17, 49), nov26(23, 59, 59), 5000);

test('Nov 26 root cause: the shared exact-URL extractor drops a Page Reel; the Live extractor keeps it', () => {
    const now = new Date(nov26(18, 5));
    const posts = [{ id: `${GRAPH}_${REEL}`, created_time: iso(nov26(18, 0, 34)),
        attachments: { data: [{ type: 'video_inline', target: { id: REEL, url: `https://www.facebook.com/reel/${REEL}` }, url: `https://www.facebook.com/reel/${REEL}` }] } }];
    assert.equal(extractCandidates(posts, '', now).length, 0); // production cf8252e behavior (candidates: 0)
    const rejections = {};
    const live = extractLiveCandidates(posts, now, rejections);
    assert.deepEqual(live.map(c => [c.videoId, c.form]), [[REEL, 'reel']]);
    assert.deepEqual(rejections, {});
});

test('a Page-owned Live posted as a Reel is selected by backup polling alone (no webhook, no hashtag) and shown with the canonical URL', async () => {
    const h = day({ videos: [{ id: REEL, posted: nov26(18, 0, 34), created: nov26(18, 0, 20), link: `https://www.facebook.com/reel/${REEL}`,
        live: t => t < nov26(18, 9) ? 'LIVE' : 'VOD', visibleFrom: nov26(18, 0, 40) }] });
    await evening(h);
    const stage = JSON.parse(h.kv.data.get(AUTOMATIC_KEY));
    assert.equal(stage.id, REEL); assert.equal(stage.url, canonical(REEL)); assert.equal(stage.drawingDate, '2026-11-26');
    assert.equal(stage.originStatus, 'LIVE');
    const shown = await h.show(nov26(23, 59, 59));
    assert.equal(shown.source, 'automatic'); assert.equal(shown.config.latestVideoUrl, canonical(REEL));
    assert.equal(h.emails.length, 0); // no missed-drawing alert on a selected drawing
    assert.equal(Object.keys(h.incidents()).length, 0);
    // The replay keeps the first Live observation after the status becomes VOD.
    assert.equal(h.state().lastVerifiedVideoId, REEL);
});

test('other link forms (watch, share, unknown) are selected when Graph proves a Page-owned Live; ownership, embedding and status still decide', async () => {
    for (const link of [`https://www.facebook.com/watch/?v=${REEL}`, `https://www.facebook.com/share/v/AbCd/`, 'https://fb.watch/xyz/']) {
        configureSeason(season2026);
        const r = await discoverLivestreams({ token: TOKEN, now: new Date(nov26(18, 3)), fetcher: (async (input) => {
            const u = new URL(String(input)); const path = u.pathname.split('/').slice(2).join('/');
            if (path === GRAPH) return Response.json({ id: GRAPH });
            if (path.endsWith('published_posts')) return Response.json({ data: [{ id: `${GRAPH}_${REEL}`, created_time: iso(nov26(18, 0, 34)), attachments: { data: [{ type: 'video_inline', target: { id: REEL, url: link } }] } }] });
            if (u.searchParams.get('fields') === 'id,format') return Response.json({ id: REEL });
            return Response.json({ id: REEL, from: { id: GRAPH }, published: true, embeddable: true, live_status: 'LIVE' });
        }) });
        assert.equal(r.ok, true, link); assert.equal(r.discoveries.length, 1, link); assert.equal(r.discoveries[0].url, canonical(REEL));
    }
    const cases = { 'not-page-owned': { owner: '999' }, 'not-embeddable': { embeddable: false }, 'not-live-video': { live: '' } };
    for (const [reason, extra] of Object.entries(cases)) {
        const h = day({ videos: [{ id: REEL, posted: nov26(18, 0, 34), link: `https://www.facebook.com/reel/${REEL}`, live: 'LIVE', ...extra }] });
        await h.run(nov26(18, 1), nov26(18, 1));
        await h.coord.kick(); await h.run(nov26(18, 1), nov26(18, 1));
        assert.notEqual(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, REEL, reason);
        assert.equal(h.state().rejections[reason], 1, reason);
        assert.equal(h.state().status, 'no-eligible-video', reason); // never "pending", never ambiguous
    }
});

test('broadcast time: an early-posted Live qualifies by its video creation time; an unrelated afternoon Live that is still LIVE does not', async () => {
    // Announced at 2 PM, broadcast created at 6:00 PM.
    const scheduled = day({ videos: [{ id: '5001', posted: nov26(14, 0), created: nov26(18, 0, 5), live: 'LIVE' }] });
    await scheduled.run(nov26(17, 59), nov26(18, 3), 5000);
    const stage = JSON.parse(scheduled.kv.data.get(AUTOMATIC_KEY));
    assert.equal(stage.id, '5001'); assert.equal(stage.publishedAt, iso(nov26(18, 0, 5))); // the broadcast time, same day
    assert.equal((await scheduled.show(nov26(18, 3))).source, 'automatic');
    // A Live running since 1 PM is not the 6 PM drawing even though it is LIVE now.
    const unrelated = day({ videos: [{ id: '5002', posted: nov26(13, 0), created: nov26(13, 0), live: 'LIVE' }] });
    await unrelated.run(nov26(17, 59), nov26(18, 3), 5000);
    assert.equal(JSON.parse(unrelated.kv.data.get(AUTOMATIC_KEY)).id, YESTERDAY);
    assert.equal(unrelated.state().rejections['outside-time-window'] >= 1, true);
    assert.equal(unrelated.state().status, 'no-eligible-video');
    // Yesterday's drawing post is never re-probed as a new broadcast.
    const again = day({ videos: [{ id: YESTERDAY, posted: Date.parse('2026-11-26T00:00:34Z'), live: 'VOD' }] });
    await again.run(nov26(17, 59), nov26(18, 0), 5000);
    assert.ok(!again.graphCalls.includes(YESTERDAY)); assert.ok(again.state().rejections['previous-drawing'] >= 1);
});

test('unrelated uploads never make the drawing ambiguous; two real Lives are held and raise exactly one alert', async () => {
    const reelUpload = { id: '6001', posted: nov26(17, 55), link: 'https://www.facebook.com/reel/6001', live: '' };
    const h = day({ videos: [reelUpload, { id: REEL, posted: nov26(18, 0, 34), link: `https://www.facebook.com/reel/${REEL}`, live: 'LIVE' }] });
    await h.run(nov26(17, 59), nov26(18, 2), 5000);
    assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, REEL);
    // Two Page Lives at once: hold (ambiguous), keep yesterday's, and alert once (not twice).
    const both = day({ videos: [{ id: '7001', posted: nov26(17, 50), live: 'LIVE' }, { id: '7002', posted: nov26(17, 50), live: 'LIVE' }] });
    await evening(both);
    assert.equal(JSON.parse(both.kv.data.get(AUTOMATIC_KEY)).id, YESTERDAY);
    assert.equal(both.state().status, 'ambiguous-livestream');
    assert.equal(both.emails.length, 1, JSON.stringify(both.emails.map(e => e.subject)));
    assert.match(both.emails[0].subject, /confirmed but not shown/i);
    assert.equal(both.incidents()['live:missing:2026-11-26'], undefined); // suppressed: one problem, one email
});

test('delayed Facebook indexing: a post visible at 6:12 PM is still selected by backup polling; no alert', async () => {
    const h = day({ videos: [{ id: REEL, posted: nov26(18, 0, 34), link: `https://www.facebook.com/reel/${REEL}`, live: 'LIVE', visibleFrom: nov26(18, 12) }] });
    await evening(h);
    assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, REEL);
    assert.equal(h.emails.length, 0);
});

test('missed drawing: one alert after the final backup slot, then a recovery when a late webhook selects it', async () => {
    // Indexed only at 6:20 PM, after the final 6:15 PM slot: polling cannot see it; the missed alert goes out at 6:16.
    const h = day({ videos: [{ id: REEL, posted: nov26(18, 0, 34), link: `https://www.facebook.com/reel/${REEL}`, live: 'LIVE', visibleFrom: nov26(18, 20) }] });
    await h.run(nov26(17, 49), nov26(18, 21), 5000);
    assert.equal(h.emails.length, 1);
    assert.equal(h.emails[0].at, nov26(18, 16)); // after the final discovery attempt, from the cron
    assert.match(h.emails[0].subject, /Raffle drawing video not on the website/);
    assert.match(h.emails[0].text, /2026-11-26/);
    assert.match(h.emails[0].text, /no-eligible-video/);
    // A signed webhook at 6:21 PM checks once and selects the Reel; the 6:22 cron tick resolves the incident.
    assert.equal(await h.hint(nov26(18, 21, 30)), true);
    await h.run(nov26(18, 21, 30), nov26(23, 59, 59), 5000);
    assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, REEL);
    assert.equal(h.emails.length, 2);
    assert.match(h.emails[1].subject, /resolved|recovered/i);
    assert.equal(h.incidents()['live:missing:2026-11-26'].status, 'resolved');
    assert.equal(h.alarm, null); // no rechecks after resolution
});

test('missed drawing resolves on a manual save (Reel URL) at 6:40 PM; rechecks stop and never pass midnight', async () => {
    const h = day({ videos: [] });
    let saved = false;
    await h.run(nov26(17, 49), nov26(23, 59, 59), 5000, async t => { if (!saved && t >= nov26(18, 40)) { saved = true; h.manualSave(t, `https://www.facebook.com/reel/${REEL}`); } });
    assert.equal(h.emails.length, 2);
    assert.equal(h.emails[0].at, nov26(18, 16));
    assert.ok(h.emails[1].at > nov26(18, 40) && h.emails[1].at <= nov26(18, 46), 'recovery within one 5-minute recheck');
    assert.equal(h.incidents()['live:missing:2026-11-26'].status, 'resolved');
    assert.equal(h.alarm, null);
    // Never resolved: rechecks run every 5 minutes after the cron window and stop at the end of the day.
    const open = day({ videos: [] });
    const reads = () => open.kvReads.filter(k => k === RAFFLE_LIVE_KEY).length;
    await open.run(nov26(17, 49), nov26(23, 59, 59), 5000);
    assert.equal(open.emails.length, 1);
    assert.ok(open.alarm === null || open.alarm < central(2026, 11, 27, 0, 0));
    // 35 backup polls + 6:16-6:30 cron (15) + the 6:16 alarm + 5-minute rechecks to midnight (<= 70).
    assert.ok(reads() <= 35 + 16 + 70, `bounded KV reads: ${reads()}`);
});

test('once per drawing day across cron ticks; a past day resolves quietly; no alert on no-drawing or off-season days', async () => {
    const h = day({ videos: [] });
    await h.run(nov26(17, 49), nov26(18, 31), 5000);
    assert.equal(h.emails.length, 1); // 15 cron evaluations + the 6:16 alarm, one email
    // The next day's evaluation (no selection either) resolves Nov 26 without a recovery email and opens Nov 27 once.
    await h.run(central(2026, 11, 27, 18, 16), central(2026, 11, 27, 18, 17), 5000);
    assert.equal(h.incidents()['live:missing:2026-11-26'].status, 'resolved');
    assert.equal(h.incidents()['live:missing:2026-11-26'].recoveryNotifiedAt, null);
    assert.equal(h.emails.length, 2); assert.match(h.emails[1].text, /2026-11-27/);
    // Configured no-drawing day, alerts disabled, off-season evening: nothing.
    const skip = day({ videos: [], extraEnv: { FB_NO_DRAWING_DAYS: '2026-11-25, 2026-11-26' } });
    await skip.run(nov26(18, 15), nov26(18, 31), 5000);
    assert.equal(skip.emails.length, 0); assert.deepEqual(noDrawingDays(' 2026-11-26,bad'), new Set(['2026-11-26']));
    const off = day({ videos: [], alerts: false });
    await off.run(nov26(18, 15), nov26(18, 31), 5000);
    assert.equal(off.emails.length, 0); assert.equal(off.disk.get('alerts:incidents'), undefined);
    const december = day({ videos: [] });
    await december.run(central(2026, 12, 1, 18, 15), central(2026, 12, 1, 18, 40), 5000);
    assert.equal(december.emails.length, 0);
});

test('a future season (November 2027) alerts on its own days with its own coordinator; no 2026 dates involved', async () => {
    const h = day({ videos: [], season: season2027 });
    await h.run(central(2027, 11, 10, 18, 15), central(2027, 11, 10, 18, 17), 5000);
    assert.equal(h.emails.length, 1); assert.match(h.emails[0].text, /2027-11-10/);
    assert.ok(h.objectNames.every(name => name === 'november-2027'));
    assert.equal(seasonObjectName(), 'november-2027');
    configureSeason(season2026);
});

test('expired token: Live access pauses with its own alert; the missed-drawing alert does not duplicate it', async () => {
    const h = day({ videos: [], graphError: 190 });
    await evening(h);
    assert.equal(h.state().paused, true);
    assert.equal(h.emails.length, 1);
    assert.match(h.emails[0].subject, /paused/i);
    assert.equal(h.incidents()['live:missing:2026-11-26'], undefined);
});

test('alert delivery failure: Resend 500s are retried with the same idempotency key and delivered once', async () => {
    const h = day({ videos: [], resend: count => count <= 2 ? 500 : 200 });
    await h.run(nov26(17, 49), nov26(19, 0), 5000);
    const missed = h.emails.filter(e => /not on the website/.test(e.subject));
    assert.equal(missed.length, 3);
    assert.equal(new Set(missed.map(e => e.key)).size, 1);
    assert.equal(h.incidents()['live:missing:2026-11-26'].alertOutcome, 'delivered');
});

test('rejection reasons are recorded as codes and counts in state, logs and the timing journal, never secrets or post text', async () => {
    const h = day({ videos: [
        { id: '8001', posted: nov26(17, 55), owner: '999', message: 'private caption text' },
        { id: '8002', posted: nov26(17, 56), link: 'https://www.facebook.com/reel/8002', live: '' },
        { id: '8003', posted: nov26(17, 57), type: 'photo' }] });
    const logs = []; const log = console.log; console.log = line => logs.push(String(line));
    try { await h.run(nov26(17, 59), nov26(18, 0), 5000); } finally { console.log = log; }
    const state = h.state();
    assert.deepEqual(state.rejections, { 'no-video-attachment': 1, 'not-page-owned': 1, 'not-live-video': 1 });
    const journal = h.disk.get('timing:v1:2026-11-26');
    const result = journal.entries.find(e => e.stage === 'check-result');
    assert.deepEqual(result.rejections, state.rejections);
    assert.ok(result.videos.some(v => v.reason === 'not-page-owned'));
    const everything = JSON.stringify([state, journal, logs, [...h.disk.values()]]);
    assert.ok(!everything.includes(TOKEN)); assert.ok(!everything.includes('private caption text'));
    assert.ok(logs.some(l => l.includes('"rejections"')));
    // The sanitizer drops anything that is not a short code with a count.
    assert.deepEqual(timingEntry({ stage: 'check-result', at: nov26(18, 0), rejections: { 'ok-code': 2, 'Bad Code!': 1, 'neg': -1, x: 'y' } }).rejections, { 'ok-code': 2 });
});

test('resource use stays bounded on a normal drawing day', async () => {
    const h = day({ videos: [{ id: REEL, posted: nov26(18, 0, 34), link: `https://www.facebook.com/reel/${REEL}`, live: t => t < nov26(18, 9) ? 'LIVE' : 'VOD' }] });
    await h.run(central(2026, 11, 26, 0, 0), nov26(23, 59, 59), 5000);
    // 35 backup checks (identity + posts + <=1 video each) + one format probe; no work outside the window.
    assert.ok(h.graphCalls.length <= 35 * 3 + 2, `graph calls ${h.graphCalls.length}`);
    assert.equal(h.kvWrites.filter(k => k === STATE_KEY).length, 35);
    // Missed-drawing evaluation: the cron window (15) + the 6:16 alarm, one raffle_live read each, then nothing.
    assert.ok(h.kvReads.filter(k => k === RAFFLE_LIVE_KEY).length <= 35 + 16 + 1);
    assert.equal(h.alarm, null);
});

test('drawingSelection: manual saves count any time today; automatic only in automatic mode and from 5:30 PM', () => {
    const today = '2026-11-26';
    const stage = at => JSON.stringify({ ...yesterdayStage, drawingDate: today, originObservedAt: new Date(at).toISOString() });
    const auto = JSON.stringify({ latestVideoUrl: null, selectionMode: 'automatic', automaticEnabled: true });
    assert.equal(drawingSelection(today, { manualRaw: auto, automaticRaw: stage(nov26(18, 1)) }), 'automatic');
    assert.equal(drawingSelection(today, { manualRaw: auto, automaticRaw: stage(nov26(14, 0)) }), null); // earlier unrelated Live
    const manualMode = JSON.stringify({ latestVideoUrl: canonical('1'), selectionMode: 'manual', automaticEnabled: false });
    assert.equal(drawingSelection(today, { manualRaw: manualMode, automaticRaw: stage(nov26(18, 1)) }), null);
    assert.equal(drawingSelection(today, { manualRaw: JSON.stringify({ ...JSON.parse(auto), manualOverrideAt: new Date(nov26(18, 10, 38)).toISOString() }) }), 'manual');
    assert.equal(missedDrawingSignals(new Date(nov26(18, 15, 59)), {}, []).length, 0); // never before the final slot ends
    assert.equal(missedDrawingSignals(new Date(nov26(18, 16)), {}, []).length, 1);
});

test('missed-drawing alert fires when Facebook does not identify the video as Live (Reel with no status, VOD with no prior, unproven /videos/ post)', async () => {
    const cases = {
        'Reel, live_status absent': { link: `https://www.facebook.com/reel/${REEL}`, live: '' , status: 'no-eligible-video', reason: 'not-live-video' },
        'Reel, VOD never observed Live': { link: `https://www.facebook.com/reel/${REEL}`, live: 'VOD', status: 'no-eligible-video', reason: 'not-live-video' },
        'Page video, status absent (held pending)': { live: '', status: 'pending-live-confirmation', reason: 'live-origin-unproven' },
    };
    for (const [name, c] of Object.entries(cases)) {
        const h = day({ videos: [{ id: REEL, posted: nov26(18, 0, 34), created: nov26(18, 0, 20), ...(c.link ? { link: c.link } : {}), live: c.live }] });
        await h.run(nov26(17, 49), nov26(18, 31), 5000);
        assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, YESTERDAY, name); // never selected
        assert.equal(h.state().status, c.status, name);
        assert.equal(h.state().rejections[c.reason] >= 1, true, name);
        assert.equal(h.emails.length, 1, name);
        assert.equal(h.emails[0].at, nov26(18, 16), name);
        assert.match(h.emails[0].subject, /Raffle drawing video not on the website/, name);
        assert.match(h.emails[0].text, new RegExp(c.status), name);
        assert.match(h.emails[0].text, new RegExp(c.reason), name);
        assert.equal(h.incidents()['live:missing:2026-11-26'].status, 'open', name);
    }
});

test('exact Nov 26 Graph v27 response (owner, published, embeddable, created 00:03:41Z, live_status omitted) is rejected and the alert fires', async () => {
    const created = Date.parse('2026-11-27T00:03:41Z');
    for (const posted of [created, created + 60_000]) { // post time not observed (published_posts needed a Page token)
        const h = day({ videos: [{ id: REEL, posted, created, link: `https://www.facebook.com/reel/${REEL}`, live: '' }] });
        await h.run(nov26(17, 49), nov26(18, 31), 5000);
        assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, YESTERDAY);
        assert.equal(h.state().rejections['not-live-video'] >= 1, true);
        assert.equal(h.emails.length, 1); assert.equal(h.emails[0].at, nov26(18, 16));
    }
});

// ---- Release B: Live origin from a signed live_videos webhook tied to the exact video ID ----
const REEL_LINK = `https://www.facebook.com/reel/${REEL}`;
const CREATED = Date.parse('2026-11-27T00:03:41Z'); // the real Nov 26 created_time (6:03:41 PM CT)
const HINT = Date.parse('2026-11-27T00:04:34Z');    // the real signed webhook arrival (6:04:34 PM CT)
const reelVideo = (extra = {}) => ({ id: REEL, posted: CREATED + 20_000, created: CREATED, link: REEL_LINK, live: '', ...extra });
const liveEvent = (id, status = 'live') => ({ field: 'live_videos', id, status, keys: ['id', 'status'] });
const feedVideo = id => ({ field: 'feed', item: 'video', verb: 'add', videoId: id, postId: `${GRAPH}_${id}`, keys: ['item', 'post_id', 'verb', 'video_id'] });
const everRejected = (h, reason) => (h.state().rejections?.[reason] ?? 0) >= 1
    || (h.disk.get('timing:v1:2026-11-26')?.entries ?? []).some(e => (e.rejections?.[reason] ?? 0) >= 1);

test('Nov 26 replay: a signed live_videos event whose id is the Reel video id proves Live origin without live_status', async () => {
    const h = day({ videos: [reelVideo()] });
    await h.run(nov26(17, 49), HINT - 1000, 5000);
    assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, YESTERDAY); // not before the event
    assert.equal(await h.hint(HINT, [liveEvent(REEL)]), true);
    await h.run(HINT, HINT); await h.run(nov26(18, 5), nov26(23, 59, 59), 5000);
    const stage = JSON.parse(h.kv.data.get(AUTOMATIC_KEY));
    assert.equal(stage.id, REEL); assert.equal(stage.url, canonical(REEL));
    assert.equal(stage.originEvidence, 'signed-live-webhook'); assert.equal(stage.originCorrelation, 'event-video-id');
    assert.match(stage.originEventRef, /^[a-f0-9]{12}$/);
    assert.equal(stage.origin, 'page-video-live-status'); // resolver-compatible value; the evidence is recorded separately
    assert.equal((await h.show(nov26(23, 59, 59))).source, 'automatic');
    assert.equal(h.emails.length, 0); // selected: no missed-drawing alert
    const journal = h.disk.get('timing:v1:2026-11-26');
    assert.ok(journal.entries.some(e => e.stage === 'webhook-live-event' && e.liveVideoId === REEL && e.status === 'live'));
});

test('a LiveVideo id differing from the video id is tied only by a read-only lookup returning that exact video id; one lookup, then cached', async () => {
    const h = day({ videos: [reelVideo()], liveVideos: { '9990001': { video: REEL, status: 'LIVE' } } });
    await h.hint(HINT, [liveEvent('9990001')]);
    await h.run(HINT, HINT); await h.run(nov26(18, 5), nov26(18, 15), 5000);
    const stage = JSON.parse(h.kv.data.get(AUTOMATIC_KEY));
    assert.equal(stage.id, REEL); assert.equal(stage.originCorrelation, 'live-video-lookup');
    assert.equal(h.graphCalls.filter(p => p === '9990001').length, 1);
    assert.deepEqual(Object.keys(h.disk.get('live-video-map')), ['9990001']);
    assert.equal(h.disk.get('live-video-map')['9990001'].videoId, REEL);
});

test('no exact tie, no selection: other video, failed or unsupported lookup, non-live status, feed fact only; detection never pauses; the alert fires', async () => {
    const cases = {
        'lookup returns a different video': { liveVideos: { '9990002': { video: '1234' } }, events: [liveEvent('9990002')], reason: 'live-event-uncorrelated' },
        'lookup unsupported (code 100)': { liveVideos: { '9990003': { error: 100 } }, events: [liveEvent('9990003')], reason: 'live-lookup-unsupported-contract' },
        'lookup permission denied (code 10)': { liveVideos: { '9990004': { error: 10 } }, events: [liveEvent('9990004')], reason: 'live-lookup-permission-denied' },
        'scheduled status on the exact id': { events: [liveEvent(REEL, 'scheduled_live')], reason: 'not-live-video' },
        'only a feed video fact (no live event)': { events: [feedVideo(REEL)], reason: 'not-live-video' },
    };
    for (const [name, c] of Object.entries(cases)) {
        const h = day({ videos: [reelVideo()], liveVideos: c.liveVideos ?? {} });
        await h.run(nov26(17, 49), HINT - 1000, 5000);
        await h.hint(HINT, c.events);
        await h.run(HINT, HINT); await h.run(nov26(18, 5), nov26(18, 31), 5000);
        assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, YESTERDAY, name);
        assert.ok(everRejected(h, c.reason), name);
        assert.equal(h.state().paused, false, name); assert.equal(h.state().failures, 0, name);
        assert.equal(h.emails.length, 1, name); assert.match(h.emails[0].subject, /not on the website/, name);
    }
    // Final lookup outcomes are not retried; a transient failure is retried on a later check.
    const unsupported = day({ videos: [reelVideo()], liveVideos: { '9990003': { error: 100 } } });
    await unsupported.hint(HINT, [liveEvent('9990003')]); await unsupported.run(HINT, HINT); await unsupported.run(nov26(18, 5), nov26(18, 15), 5000);
    assert.equal(unsupported.graphCalls.filter(p => p === '9990003').length, 1);
    const transient = day({ videos: [reelVideo()], liveVideos: { '9990005': { error: 2 } } });
    await transient.hint(HINT, [liveEvent('9990005')]); await transient.run(HINT, HINT); await transient.run(nov26(18, 5), nov26(18, 10), 5000);
    assert.ok(transient.graphCalls.filter(p => p === '9990005').length > 1);
});

test('ordinary Reels stay out: a signed live event for one video never makes another (ordinary) Reel eligible', async () => {
    const ordinary = { id: '6100', posted: nov26(17, 58), created: nov26(17, 57), link: 'https://www.facebook.com/reel/6100', live: '' };
    const h = day({ videos: [ordinary, reelVideo()] });
    await h.hint(HINT, [liveEvent(REEL)]);
    await h.run(HINT, HINT); await h.run(nov26(18, 5), nov26(18, 15), 5000);
    assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, REEL); // only the correlated video
    assert.ok(everRejected(h, 'not-live-video'));                      // the ordinary Reel
    // Two videos each tied to a signed live event: ambiguous, nothing new selected.
    const both = day({ videos: [reelVideo(), reelVideo({ id: '6200', link: 'https://www.facebook.com/reel/6200' })] });
    await both.hint(HINT, [liveEvent(REEL), liveEvent('6200')]);
    await both.run(HINT, HINT); await both.run(nov26(18, 5), nov26(18, 15), 5000);
    assert.equal(JSON.parse(both.kv.data.get(AUTOMATIC_KEY)).id, YESTERDAY); assert.equal(both.state().status, 'ambiguous-livestream');
});

test('delayed indexing: a signed feed video fact names the video before published_posts shows it', async () => {
    // Graph reports LIVE for the video, but the Page post is not indexed until 6:30 PM.
    const h = day({ videos: [reelVideo({ live: 'LIVE', visibleFrom: nov26(18, 30) })] });
    await h.hint(HINT, [feedVideo(REEL)]);
    await h.run(HINT, HINT); await h.run(nov26(18, 5), nov26(18, 6), 5000);
    const stage = JSON.parse(h.kv.data.get(AUTOMATIC_KEY));
    assert.equal(stage.id, REEL); assert.equal(stage.postId, `${GRAPH}_${REEL}`); assert.equal(stage.publishedAt, iso(CREATED));
    assert.equal(stage.originEvidence, 'graph-live-status');
});

test('older body format (bare id) is still accepted, and a redelivered webhook stores its facts once', async () => {
    const h = day({ videos: [] });
    await h.run(nov26(18, 0), nov26(18, 0));
    assert.equal(await h.coord.event('c'.repeat(64)), true);
    assert.equal(await h.coord.event('d'.repeat(64), [liveEvent(REEL)]), true);
    assert.equal(await h.coord.event('d'.repeat(64), [liveEvent(REEL)]), false); // redelivery
    assert.equal(h.disk.get('live-events').length, 1);
    assert.ok(!JSON.stringify([...h.disk.values()]).includes(TOKEN));
});
