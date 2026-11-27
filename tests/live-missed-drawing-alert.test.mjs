// Release A (alert only; discovery unchanged from production cf8252e). Regression tests for the November 26, 2026 missed drawing: the Live was posted as a Reel (/reel/<id>), which the
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
function day({ videos = [], season = season2026, alerts = true, manual, graphError, resend = () => 200, extraEnv = {} } = {}) {
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
        if (path === '/event') return Response.json({ accepted: await coord.event(init.body) });
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
        async hint(at) { clock = at; return coord.event((++n).toString(16).padStart(64, '0')); },
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

test('unrelated uploads never make the drawing ambiguous; two real Lives are held and raise exactly one alert', async () => {
    const reelUpload = { id: '6001', posted: nov26(17, 55), link: 'https://www.facebook.com/reel/6001', live: '' };
    const h = day({ videos: [reelUpload, { id: REEL, posted: nov26(18, 0, 34), live: 'LIVE' }] });
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
    const h = day({ videos: [{ id: REEL, posted: nov26(18, 0, 34), live: 'LIVE', visibleFrom: nov26(18, 12) }] });
    await evening(h);
    assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, REEL);
    assert.equal(h.emails.length, 0);
});

test('missed drawing: one alert after the final backup slot, then a recovery when a late webhook selects it', async () => {
    // Indexed only at 6:20 PM, after the final 6:15 PM slot: polling cannot see it; the missed alert goes out at 6:16.
    const h = day({ videos: [{ id: REEL, posted: nov26(18, 0, 34), live: 'LIVE', visibleFrom: nov26(18, 20) }] });
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

test('resource use stays bounded on a normal drawing day', async () => {
    const h = day({ videos: [{ id: REEL, posted: nov26(18, 0, 34), live: t => t < nov26(18, 9) ? 'LIVE' : 'VOD' }] });
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
        'Reel, live_status absent (dropped by link form)': { link: `https://www.facebook.com/reel/${REEL}`, live: '', status: 'no-eligible-video' },
        'Reel, LIVE (still dropped by production link rule)': { link: `https://www.facebook.com/reel/${REEL}`, live: 'LIVE', status: 'no-eligible-video' },

        'Page video, status absent (held pending)': { live: '', status: 'pending-live-confirmation' },
        'Page video, VOD never observed Live': { live: 'VOD', status: 'pending-live-confirmation' },
    };
    for (const [name, c] of Object.entries(cases)) {
        const h = day({ videos: [{ id: REEL, posted: nov26(18, 0, 34), created: nov26(18, 0, 20), ...(c.link ? { link: c.link } : {}), live: c.live }] });
        await h.run(nov26(17, 49), nov26(18, 31), 5000);
        assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, YESTERDAY, name); // never selected
        assert.equal(h.state().status, c.status, name);
        assert.equal(h.emails.length, 1, name);
        assert.equal(h.emails[0].at, nov26(18, 16), name);
        assert.match(h.emails[0].subject, /Raffle drawing video not on the website/, name);
        assert.match(h.emails[0].text, new RegExp(c.status), name);
        assert.equal(h.incidents()['live:missing:2026-11-26'].status, 'open', name);
    }
});

test('exact Nov 26 Graph v27 response (owner, published, embeddable, created 00:03:41Z, live_status omitted) is rejected and the alert fires', async () => {
    const created = Date.parse('2026-11-27T00:03:41Z');
    for (const posted of [created, created + 60_000]) { // post time not observed (published_posts needed a Page token)
        const h = day({ videos: [{ id: REEL, posted, created, link: `https://www.facebook.com/reel/${REEL}`, live: '' }] });
        await h.run(nov26(17, 49), nov26(18, 31), 5000);
        assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, YESTERDAY);
        assert.equal(h.state().candidates, 0); // exactly today's production outcome
        assert.equal(h.emails.length, 1); assert.equal(h.emails[0].at, nov26(18, 16));
    }
});
