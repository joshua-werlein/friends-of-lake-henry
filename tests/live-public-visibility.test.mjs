import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRaffleSelection, freshSelectionFrom, SnapshotCache, FRESH_SELECTION_TIMEOUT_MS, STATE_KEY, VERIFICATION_KEY } from '../src/lib/server/raffle-selection.ts';
import { AUTOMATIC_KEY } from '../src/lib/server/facebook-automation.ts';
import { drawingStartFastUntil, inDiscoveryWindow, liveDay } from '../src/lib/server/raffle-discovery-schedule.ts';
import { DiscoveryCoordinator, ACTIVE_DISPLAY_MS } from '../workers/facebook-live/coordinator.ts';
import { runPoll } from '../workers/facebook-live/poller.ts';
import { GET } from '../src/pages/api/raffle/live.ts';
import { FACEBOOK_API_VERSION, FACEBOOK_GRAPH_PAGE_ID, FACEBOOK_LIVE_CONTRACT, FACEBOOK_PAGE_ID, RAFFLE_LIVE_KEY } from '../src/lib/facebook.ts';

// 6:00 PM Central on November 9 is 00:00 UTC on November 10; 10:30 AM Central on November 12 is 16:30 UTC.
const url = id => `https://www.facebook.com/${FACEBOOK_PAGE_ID}/videos/${id}/`;
const seasonEnv = { FB_SEASON_START: '2026-11-01T00:00:00-05:00', FB_SEASON_END: '2026-12-01T00:00:00-06:00' };
const stage = (id, day, publishedAt, observedAt) => ({ schemaVersion: 2, graphPageId: FACEBOOK_GRAPH_PAGE_ID, publicPageId: FACEBOOK_PAGE_ID,
    apiVersion: FACEBOOK_API_VERSION, contract: FACEBOOK_LIVE_CONTRACT, id, videoId: id, postId: `${FACEBOOK_GRAPH_PAGE_ID}_${id}`, url: url(id),
    publishedAt, observedAt, origin: 'page-video-live-status', originStatus: 'LIVE', originObservedAt: observedAt, drawingDate: day,
    status: 'video', liveStatus: 'LIVE' });
const state = (id, verifiedAt) => ({ version: 1, accessRevision: 'r', lastAttemptAt: Date.parse(verifiedAt), nextAttemptAt: Date.parse(verifiedAt) + 15000,
    failures: 0, status: 'unchanged', paused: false, lastVerifiedVideoId: id, lastVerifiedAt: verifiedAt });
const NOV8 = '1160320550010687', NOV9 = '1466425035434328';
const nov8Stage = JSON.stringify(stage(NOV8, '2026-11-08', '2026-11-09T00:00:20+0000', '2026-11-09T00:00:29.200Z'));
const nov8State = JSON.stringify(state(NOV8, '2026-11-09T00:15:00.000Z'));
const nov9Stage = JSON.stringify(stage(NOV9, '2026-11-09', '2026-11-10T00:00:15+0000', '2026-11-10T00:00:26.366Z'));
const nov9State = JSON.stringify(state(NOV9, '2026-11-10T00:00:26.366Z'));
const receipt = JSON.stringify({ schemaVersion: 5, graphPageId: FACEBOOK_GRAPH_PAGE_ID, publicPageId: FACEBOOK_PAGE_ID, apiVersion: FACEBOOK_API_VERSION,
    contract: FACEBOOK_LIVE_CONTRACT, verifiedVideoId: '1129604836279234', evidence: 'page-video-live-origin-policy-reviewed', publicPlaybackVerified: true,
    rollbackTested: true, verifiedAt: '2026-11-06T03:03:33.834Z', expiresAt: '2026-12-01T06:00:00.000Z' });
const automaticManual = { latestVideoUrl: url('1129604836279234'), updatedAt: '2026-11-06T03:00:00.000Z', selectionMode: 'automatic', automaticEnabled: true };
/** KV as a Pages edge saw it: still holding November 8 unless told otherwise. */
const edge = ({ automatic = nov8Stage, st = nov8State, manual = automaticManual } = {}) => {
    const data = new Map([[RAFFLE_LIVE_KEY, JSON.stringify(manual)], [VERIFICATION_KEY, receipt], [AUTOMATIC_KEY, automatic], [STATE_KEY, st]]);
    return { data, async get(k) { return data.get(k) ?? null; }, async put(k, v) { data.set(k, v); } };
};
/** Coordinator snapshot reader that counts its calls. */
const coordinator = (value = { automaticRaw: nov9Stage, stateRaw: nov9State, activeUntil: 0 }) => { const f = async () => { f.calls++; return value; }; f.calls = 0; return f; };
const t = iso => new Date(iso);
const at603 = t('2026-11-10T00:00:29.000Z'); // 6:00:29 PM Central, 3 seconds after staging
const load = (kv, now, fresh, cache = new SnapshotCache()) => loadRaffleSelection(kv, true, now, seasonEnv, fresh, cache);

test('November 9 reproduction: stale edge KV keeps showing yesterday; the coordinator snapshot shows tonight immediately', async () => {
    const before = await load(edge(), at603);
    assert.deepEqual([before.source, before.config.latestVideoUrl, before.readPath], ['automatic', url(NOV8), 'kv']);
    const after = await load(edge(), at603, coordinator());
    assert.deepEqual([after.source, after.reason, after.config.latestVideoUrl, after.readPath], ['automatic', 'verified-discovery', url(NOV9), 'durable-object']);
});

test('partially stale KV in either direction falls back without the coordinator, and is correct with it', async () => {
    for (const kv of [edge({ automatic: nov9Stage }), edge({ st: nov9State })]) {
        assert.notEqual((await load(kv, at603)).config.latestVideoUrl, url(NOV9));
        assert.equal((await load(kv, at603, coordinator())).config.latestVideoUrl, url(NOV9));
    }
});

test('a same-day manual override still wins over a fresh coordinator selection; an earlier-day override does not', async () => {
    const pasted = { ...automaticManual, latestVideoUrl: url('999'), manualOverrideAt: '2026-11-10T00:01:31.703Z', manualOverrideUrl: url('999') };
    const later = t('2026-11-10T00:02:00.000Z');
    const manual = await load(edge({ manual: pasted }), later, coordinator());
    assert.deepEqual([manual.source, manual.reason, manual.config.latestVideoUrl], ['manual', 'manual-override', url('999')]);
    const yesterday = { ...pasted, manualOverrideAt: '2026-11-09T00:05:00.000Z' };
    assert.equal((await load(edge({ manual: yesterday }), later, coordinator())).config.latestVideoUrl, url(NOV9));
});

test('manual mode, admin-disabled automation and a disabled deployment never consult the coordinator', async () => {
    for (const [manual, enabled] of [[{ ...automaticManual, selectionMode: 'manual', automaticEnabled: false }, true], [automaticManual, false]]) {
        const read = coordinator();
        const selection = await loadRaffleSelection(edge({ manual }), enabled, at603, seasonEnv, read, new SnapshotCache());
        assert.deepEqual([selection.source, selection.refreshMs, read.calls], ['manual', 15000, 0]);
    }
});

test('coordinator failure, timeout, malformed or partial replies fall back to KV; nothing unverified is shown', async () => {
    const replies = [async () => { throw Error('rpc down'); }, async () => ({}), async () => ({ automaticRaw: nov9Stage }),
        async () => ({ automaticRaw: 7, stateRaw: nov9State }), async () => null,
        () => new Promise(resolve => setTimeout(() => resolve({ automaticRaw: nov9Stage, stateRaw: nov9State }), FRESH_SELECTION_TIMEOUT_MS + 200))];
    for (const reply of replies) {
        const started = Date.now();
        const selection = await load(edge(), at603, reply);
        assert.deepEqual([selection.readPath, selection.config.latestVideoUrl], ['kv', url(NOV8)]);
        assert.ok(Date.now() - started < FRESH_SELECTION_TIMEOUT_MS + 150);
    }
    // A coordinator selection that fails verification is never promoted just because it is fresh.
    const unverified = await load(edge(), at603, coordinator({ automaticRaw: nov9Stage, stateRaw: nov8State }));
    assert.deepEqual([unverified.readPath, unverified.source, unverified.reason], ['durable-object', 'manual', 'detection-unavailable']);
});

test('the fast display path is no longer limited to 5:50-8 PM: any November time reads the coordinator; other months use KV only', async () => {
    for (const iso of ['2026-11-12T16:30:00.000Z', '2026-11-13T03:00:00.000Z', '2026-11-10T05:59:00.000Z']) {
        const read = coordinator();
        assert.equal((await load(edge(), t(iso), read)).readPath, 'durable-object', iso);
        assert.equal(read.calls, 1);
    }
    for (const iso of ['2026-12-02T00:00:00.000Z', '2026-10-31T23:55:00.000Z']) {
        const read = coordinator();
        assert.equal(liveDay(t(iso)), false);
        assert.equal((await load(edge(), t(iso), read)).readPath, 'kv');
        assert.equal(read.calls, 0);
    }
});

test('idle pages reuse a snapshot for 15 s and poll every 15 s; while a Live may appear they read every 2 s and poll every 5 s', async () => {
    const base = Date.parse('2026-11-12T16:30:00.000Z');
    const idle = coordinator({ automaticRaw: nov8Stage, stateRaw: nov8State, activeUntil: 0 }), cache = new SnapshotCache();
    for (const [offset, calls] of [[0, 1], [5000, 1], [14999, 1], [15000, 2]]) {
        const r = await load(edge(), new Date(base + offset), idle, cache);
        assert.deepEqual([r.refreshMs, idle.calls], [15000, calls], String(offset));
    }
    const active = coordinator({ automaticRaw: nov9Stage, stateRaw: nov9State, activeUntil: base + 60_000 }), hot = new SnapshotCache();
    for (const [offset, calls] of [[0, 1], [1999, 1], [2000, 2], [5000, 3]]) {
        const r = await load(edge(), new Date(base + offset), active, hot);
        assert.deepEqual([r.refreshMs, active.calls], [5000, calls], String(offset));
    }
    assert.equal((await load(edge(), new Date(base + 60_000), active, hot)).refreshMs, 15000); // activity over: back to 15 s
    // Scheduled drawing start (5:58-6:05:59 PM) polls fast even before any hint.
    assert.equal((await load(edge(), t('2026-11-12T23:58:00.000Z'), idle, new SnapshotCache())).refreshMs, 5000);
    assert.equal((await load(edge(), t('2026-11-13T00:06:00.000Z'), idle, new SnapshotCache())).refreshMs, 15000);
    assert.equal(drawingStartFastUntil(t('2026-11-12T23:57:59.000Z')), 0);
    // A failed read is not cached: the next request asks again.
    let failures = 0; const flaky = async () => { failures++; throw Error('down'); }, cold = new SnapshotCache();
    await load(edge(), new Date(base), flaky, cold); await load(edge(), new Date(base + 1000), flaky, cold);
    assert.equal(failures, 2);
});

// ---- Off-schedule Live sessions through the real coordinator, poller and resolver.
function harness(startIso, { visibleFrom = -Infinity, published, liveStatus = () => 'LIVE', videoId = '2222', extra = [] } = {}) {
    let clock = Date.parse(startIso);
    const kv = edge(), data = new Map(); let alarm = null; const calls = [];
    const storage = { async get(k) { return data.get(k); }, async put(k, v) { data.set(k, v); }, async getAlarm() { return alarm; }, async setAlarm(v) { alarm = v; } };
    const env = { FB_AUTOMATION_ENABLED: 'true', FB_VIDEO_PROBE_ENABLED: 'true', FB_GRAPH_PAGE_ID: FACEBOOK_GRAPH_PAGE_ID, FB_PUBLIC_PAGE_ID: FACEBOOK_PAGE_ID,
        FB_PAGE_ACCESS_TOKEN: 'test-token', FB_ACCESS_REVISION: 'r', FB_POLL_INTERVAL_SECONDS: '60', CONFIG: kv, ...seasonEnv };
    const videos = [{ id: videoId, published, live: liveStatus, visibleFrom }, ...extra];
    const graph = async request => {
        const u = new URL(String(request.url ?? request)), path = u.pathname.split('/').slice(2).join('/');
        calls.push(path);
        if (path === FACEBOOK_GRAPH_PAGE_ID) return Response.json({ id: FACEBOOK_GRAPH_PAGE_ID });
        if (path.endsWith('published_posts')) return Response.json({ data: videos.filter(v => clock >= v.visibleFrom).map(v => ({ id: `${FACEBOOK_GRAPH_PAGE_ID}_${v.id}9`,
            created_time: v.published, attachments: { data: [{ type: 'video_inline', target: { id: v.id }, url: url(v.id) }] } })) });
        const v = videos.find(x => x.id === path);
        if (v && u.searchParams.get('fields') === 'id,format') return Response.json({ id: v.id });
        if (v) return Response.json({ id: v.id, from: { id: FACEBOOK_GRAPH_PAGE_ID }, created_time: v.published, live_status: v.live(clock),
            permalink_url: `/${FACEBOOK_PAGE_ID}/videos/${v.id}/`, status: { video_status: 'ready' }, embeddable: true, published: true });
        return Response.json({ error: { code: 100 } }, { status: 400 });
    };
    const coord = new DiscoveryCoordinator(storage, env, () => clock, runPoll, graph);
    let n = 0;
    return { kv, calls, coord, get alarm() { return alarm; }, get clock() { return clock; }, set clock(v) { clock = v; },
        /** A firing alarm is cleared first, as on the platform. */
        async fire() { alarm = null; return coord.alarm(); },
        async hint(atMs) { clock = atMs; assert.equal(await coord.event((++n).toString(16).padStart(64, '0')), true); assert.equal(alarm, atMs); alarm = null; return coord.alarm(); },
        async show(atMs) { return loadRaffleSelection(kv, true, new Date(atMs), seasonEnv, () => coord.selectionSnapshot(), new SnapshotCache()); } };
}
const nov12 = (h, m, s = 0) => Date.UTC(2026, 10, 12, h + 6, m, s); // Central -> UTC (CST)

test('off-schedule Live (10:30 AM): a pre-live hint finds nothing and schedules no polling; the next hint selects it and the site shows it', async () => {
    const h = harness('2026-11-12T16:29:00Z', { published: '2026-11-12T16:30:05+0000', visibleFrom: nov12(10, 30, 5) });
    assert.equal(inDiscoveryWindow(new Date(nov12(10, 30))), false);
    assert.equal((await h.hint(nov12(10, 29, 30))).status, 'no-eligible-video');
    assert.equal(h.alarm, null); // one check per hint, no follow-on polling outside the backup window
    assert.equal((await h.fire()).status, 'outside-drawing-window'); // a stray alarm does nothing
    const graphCalls = h.calls.length;
    assert.equal((await h.hint(nov12(10, 30, 15))).status, 'staged');
    assert.ok(h.calls.length > graphCalls);
    assert.equal(h.alarm, null);
    const shown = await h.show(nov12(10, 30, 17));
    assert.deepEqual([shown.source, shown.reason, shown.config.latestVideoUrl, shown.readPath, shown.refreshMs], ['automatic', 'verified-discovery', url('2222'), 'durable-object', 5000]);
    assert.equal((await h.show(nov12(10, 30, 15) + ACTIVE_DISPLAY_MS + 1000)).refreshMs, 15000); // fast polling ends 2 min later
    // Later the video becomes a replay: a later hint keeps it selected using the same-day Live proof.
    const replay = harness('2026-11-12T16:29:00Z', { published: '2026-11-12T16:30:05+0000', liveStatus: c => c < nov12(11, 0) ? 'LIVE' : 'VOD' });
    assert.equal((await replay.hint(nov12(10, 30, 15))).status, 'staged');
    const later = await replay.hint(nov12(11, 15));
    assert.equal(later.status, 'unchanged');
    assert.equal(later.monitor.selected, true);
    assert.equal((await replay.show(nov12(11, 15, 2))).config.latestVideoUrl, url('2222'));
});

test('off-schedule hints never select stale videos: older than 2 hours or from a previous day', async () => {
    for (const published of ['2026-11-12T16:00:00+0000', '2026-11-11T22:00:00+0000']) {
        const h = harness('2026-11-12T19:00:00Z', { published }); // hint at 1:00 PM Central
        assert.equal((await h.hint(nov12(13, 0))).status, 'no-eligible-video', published);
        assert.equal((await h.show(nov12(13, 0, 2))).config.latestVideoUrl, url(NOV8));
    }
});

test('the 6 PM drawing is unchanged: an earlier same-day upload does not make it ambiguous; backup polling stops after 6:15 PM', async () => {
    const h = harness('2026-11-12T23:59:00Z', { published: '2026-11-13T00:00:10+0000', visibleFrom: nov12(18, 0, 10),
        extra: [{ id: '3333', published: '2026-11-12T22:30:00+0000', live: () => 'VOD', visibleFrom: -Infinity }] });
    h.clock = nov12(18, 0, 15); await h.coord.kick(); assert.equal(h.alarm, nov12(18, 0, 15));
    assert.equal((await h.fire()).status, 'staged');
    assert.equal(h.alarm, nov12(18, 0, 30)); // burst cadence continues
    assert.equal((await h.show(nov12(18, 0, 17))).config.latestVideoUrl, url('2222'));
    // 6:15 PM is the last backup slot; after it the cron kick and stray alarms do nothing.
    h.clock = nov12(18, 15); await h.coord.kick();
    assert.equal((await h.fire()).status, 'unchanged');
    assert.equal(h.alarm, null);
    h.clock = nov12(18, 16); await h.coord.kick(); assert.equal(h.alarm, null);
    const calls = h.calls.length;
    assert.equal((await h.fire()).status, 'outside-drawing-window');
    assert.equal(h.calls.length, calls);
});

test('a same-day manual override wins over an off-schedule automatic selection', async () => {
    const h = harness('2026-11-12T16:29:00Z', { published: '2026-11-12T16:30:05+0000' });
    h.kv.data.set(RAFFLE_LIVE_KEY, JSON.stringify({ ...automaticManual, latestVideoUrl: url('999'), manualOverrideAt: '2026-11-12T15:00:00.000Z', manualOverrideUrl: url('999') }));
    assert.equal((await h.hint(nov12(10, 30, 15))).status, 'staged');
    const shown = await h.show(nov12(10, 30, 17));
    assert.deepEqual([shown.source, shown.reason, shown.config.latestVideoUrl], ['manual', 'manual-override', url('999')]);
});

test('public API serves the coordinator selection off-schedule, records its read path, and hints a 5-second poll while active', async () => {
    const diagnostics = [], waits = [], now = nov12(10, 30, 17);
    const RealDate = globalThis.Date;
    globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
    try {
        const nov12Stage = JSON.stringify(stage('2222', '2026-11-12', '2026-11-12T16:30:05+0000', '2026-11-12T16:30:15.000Z'));
        const env = { CONFIG: edge(), RAFFLE_AUTOMATIC_SELECTION_ENABLED: 'true', ...seasonEnv,
            FACEBOOK_LIVE: { selection: coordinator({ automaticRaw: nov12Stage, stateRaw: JSON.stringify(state('2222', '2026-11-12T16:30:15.000Z')), activeUntil: now + 60_000 }),
                recordDiagnostic: async v => { diagnostics.push(v); } } };
        const response = await GET({ locals: { runtime: { env, ctx: { waitUntil: p => waits.push(p) } } } });
        const body = await response.json();
        await Promise.all(waits);
        assert.deepEqual([body.source, body.config.latestVideoUrl, body.refreshMs], ['automatic', url('2222'), 5000]);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual([diagnostics[0]?.stage, diagnostics[0]?.videoId, diagnostics[0]?.reason], ['public-visible', '2222', 'durable-object']);
    } finally { globalThis.Date = RealDate; }
});

test('Pages binding adapter: only an object with a selection() method is used', () => {
    assert.equal(freshSelectionFrom(undefined), undefined);
    assert.equal(freshSelectionFrom({ timeline() {} }), undefined);
    assert.equal(typeof freshSelectionFrom({ selection: async () => ({}) }), 'function');
});
