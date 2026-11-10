import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRaffleSelection, freshSelectionFrom, FRESH_SELECTION_TIMEOUT_MS, STATE_KEY, VERIFICATION_KEY } from '../src/lib/server/raffle-selection.ts';
import { AUTOMATIC_KEY } from '../src/lib/server/facebook-automation.ts';
import { inFreshSelectionWindow, liveRefreshMs } from '../src/lib/server/raffle-discovery-schedule.ts';
import { DiscoveryCoordinator } from '../workers/facebook-live/coordinator.ts';
import { runPoll } from '../workers/facebook-live/poller.ts';
import { GET } from '../src/pages/api/raffle/live.ts';
import { FACEBOOK_API_VERSION, FACEBOOK_GRAPH_PAGE_ID, FACEBOOK_LIVE_CONTRACT, FACEBOOK_PAGE_ID, RAFFLE_LIVE_KEY } from '../src/lib/facebook.ts';

// Reproduces November 9, 2026: video 1466425035434328 was published 6:00:15 PM Central and staged 6:00:26 PM, but public
// KV reads kept returning November 8's selection/state. 6:00 PM Central on November 9 is 00:00 UTC on November 10.
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
const nov8State = JSON.stringify(state(NOV8, '2026-11-09T00:30:00.000Z'));
const nov9Stage = JSON.stringify(stage(NOV9, '2026-11-09', '2026-11-10T00:00:15+0000', '2026-11-10T00:00:26.366Z'));
const nov9State = JSON.stringify(state(NOV9, '2026-11-10T00:00:26.366Z'));
const receipt = JSON.stringify({ schemaVersion: 5, graphPageId: FACEBOOK_GRAPH_PAGE_ID, publicPageId: FACEBOOK_PAGE_ID, apiVersion: FACEBOOK_API_VERSION,
    contract: FACEBOOK_LIVE_CONTRACT, verifiedVideoId: '1129604836279234', evidence: 'page-video-live-origin-policy-reviewed', publicPlaybackVerified: true,
    rollbackTested: true, verifiedAt: '2026-11-06T03:03:33.834Z', expiresAt: '2026-12-01T06:00:00.000Z' });
const automaticManual = { latestVideoUrl: url('1129604836279234'), updatedAt: '2026-11-06T03:00:00.000Z', selectionMode: 'automatic', automaticEnabled: true };
/** KV as a Pages edge saw it: still holding November 8 unless told otherwise. */
const edge = ({ automatic = nov8Stage, st = nov8State, manual = automaticManual } = {}) => {
    const data = new Map([[RAFFLE_LIVE_KEY, JSON.stringify(manual)], [VERIFICATION_KEY, receipt], [AUTOMATIC_KEY, automatic], [STATE_KEY, st]]);
    const reads = [];
    return { data, reads, async get(k) { reads.push(k); return data.get(k) ?? null; }, async put(k, v) { data.set(k, v); } };
};
/** Coordinator snapshot reader that counts its calls. */
const coordinator = (value = { automaticRaw: nov9Stage, stateRaw: nov9State }) => { const f = async () => { f.calls++; return value; }; f.calls = 0; return f; };
const t = iso => new Date(iso);
const at603 = t('2026-11-10T00:00:29.000Z'); // 6:00:29 PM Central, 3 seconds after staging

test('November 9 reproduction: stale edge KV keeps showing yesterday; the coordinator snapshot shows tonight immediately', async () => {
    const before = await loadRaffleSelection(edge(), true, at603, seasonEnv);
    assert.deepEqual([before.source, before.config.latestVideoUrl, before.readPath], ['automatic', url(NOV8), 'kv']);
    const after = await loadRaffleSelection(edge(), true, at603, seasonEnv, coordinator());
    assert.deepEqual([after.source, after.reason, after.config.latestVideoUrl, after.readPath], ['automatic', 'verified-discovery', url(NOV9), 'durable-object']);
});

test('partially stale KV in either direction falls back without the coordinator, and is correct with it', async () => {
    for (const kv of [edge({ automatic: nov9Stage }), edge({ st: nov9State })]) {
        const stale = await loadRaffleSelection(kv, true, at603, seasonEnv);
        assert.notEqual(stale.config.latestVideoUrl, url(NOV9));
        const fresh = await loadRaffleSelection(kv, true, at603, seasonEnv, coordinator());
        assert.equal(fresh.config.latestVideoUrl, url(NOV9));
    }
});

test('a same-day manual override still wins over a fresh coordinator selection; an earlier-day override does not', async () => {
    const pasted = { ...automaticManual, latestVideoUrl: url('999'), manualOverrideAt: '2026-11-10T00:01:31.703Z', manualOverrideUrl: url('999') };
    const later = t('2026-11-10T00:02:00.000Z');
    const manual = await loadRaffleSelection(edge({ manual: pasted }), true, later, seasonEnv, coordinator());
    assert.deepEqual([manual.source, manual.reason, manual.config.latestVideoUrl], ['manual', 'manual-override', url('999')]);
    const yesterday = { ...pasted, manualOverrideAt: '2026-11-09T00:05:00.000Z' };
    assert.equal((await loadRaffleSelection(edge({ manual: yesterday }), true, later, seasonEnv, coordinator())).config.latestVideoUrl, url(NOV9));
});

test('manual mode, admin-disabled automation and a disabled deployment never consult the coordinator', async () => {
    for (const [manual, enabled] of [[{ ...automaticManual, selectionMode: 'manual', automaticEnabled: false }, true], [automaticManual, false]]) {
        const read = coordinator();
        const selection = await loadRaffleSelection(edge({ manual }), enabled, at603, seasonEnv, read);
        assert.equal(selection.source, 'manual');
        assert.equal(read.calls, 0);
    }
});

test('coordinator failure, timeout, malformed or partial replies fall back to KV; nothing unverified is shown', async () => {
    const replies = [async () => { throw Error('rpc down'); }, async () => ({}), async () => ({ automaticRaw: nov9Stage }),
        async () => ({ automaticRaw: 7, stateRaw: nov9State }), async () => null,
        () => new Promise(resolve => setTimeout(() => resolve({ automaticRaw: nov9Stage, stateRaw: nov9State }), FRESH_SELECTION_TIMEOUT_MS + 200))];
    for (const reply of replies) {
        const started = Date.now();
        const selection = await loadRaffleSelection(edge(), true, at603, seasonEnv, reply);
        assert.deepEqual([selection.readPath, selection.config.latestVideoUrl], ['kv', url(NOV8)]);
        assert.ok(Date.now() - started < FRESH_SELECTION_TIMEOUT_MS + 150);
    }
    // A coordinator selection that fails verification is never promoted just because it is fresh.
    const unverified = await loadRaffleSelection(edge(), true, at603, seasonEnv, coordinator({ automaticRaw: nov9Stage, stateRaw: nov8State }));
    assert.deepEqual([unverified.readPath, unverified.source, unverified.reason], ['durable-object', 'manual', 'detection-unavailable']);
});

test('outside the drawing window the public path reads KV only', async () => {
    for (const iso of ['2026-11-09T23:49:59.000Z', '2026-11-10T02:00:00.000Z', '2026-12-02T00:00:00.000Z', '2026-10-31T23:55:00.000Z']) {
        const read = coordinator();
        assert.equal(inFreshSelectionWindow(t(iso)), false, iso);
        assert.equal((await loadRaffleSelection(edge(), true, t(iso), seasonEnv, read)).readPath, 'kv');
        assert.equal(read.calls, 0);
    }
    for (const iso of ['2026-11-09T23:50:00.000Z', '2026-11-10T00:31:00.000Z', '2026-11-10T01:59:59.000Z']) assert.equal(inFreshSelectionWindow(t(iso)), true, iso);
});

test('the real coordinator snapshot equals what the alarm just wrote, as one matching pair', async () => {
    const VIDEO = '1234567890', POST = `${FACEBOOK_GRAPH_PAGE_ID}_555`, published = '2026-11-10T00:00:15+0000';
    let clock = Date.parse('2026-11-10T00:00:26.366Z');
    const kv = edge({ automatic: nov8Stage, st: nov8State });
    const data = new Map(); let alarm = null;
    const storage = { async get(k) { return data.get(k); }, async put(k, v) { data.set(k, v); }, async getAlarm() { return alarm; }, async setAlarm(v) { alarm = v; } };
    const env = { FB_AUTOMATION_ENABLED: 'true', FB_VIDEO_PROBE_ENABLED: 'true', FB_GRAPH_PAGE_ID: FACEBOOK_GRAPH_PAGE_ID, FB_PUBLIC_PAGE_ID: FACEBOOK_PAGE_ID,
        FB_PAGE_ACCESS_TOKEN: 'test-token', FB_ACCESS_REVISION: 'r', FB_POLL_INTERVAL_SECONDS: '60', CONFIG: kv, ...seasonEnv };
    const graph = async request => {
        const u = new URL(String(request.url ?? request)), path = u.pathname.split('/').slice(2).join('/');
        if (path === FACEBOOK_GRAPH_PAGE_ID) return Response.json({ id: FACEBOOK_GRAPH_PAGE_ID });
        if (path.endsWith('published_posts')) return Response.json({ data: [{ id: POST, created_time: published,
            attachments: { data: [{ type: 'video_inline', target: { id: VIDEO }, url: url(VIDEO) }] } }] });
        if (path === VIDEO && u.searchParams.get('fields') === 'id,format') return Response.json({ id: VIDEO });
        if (path === VIDEO) return Response.json({ id: VIDEO, from: { id: FACEBOOK_GRAPH_PAGE_ID }, created_time: published, live_status: 'LIVE',
            permalink_url: `/${FACEBOOK_PAGE_ID}/videos/${VIDEO}/`, status: { video_status: 'ready' }, embeddable: true, published: true });
        return Response.json({ error: { code: 100 } }, { status: 400 });
    };
    const coord = new DiscoveryCoordinator(storage, env, () => clock, runPoll, graph);
    assert.deepEqual(await coord.selectionSnapshot(), {}); // No copy yet: callers use KV.
    assert.equal((await coord.alarm()).status, 'staged');
    const snapshot = await coord.selectionSnapshot();
    assert.equal(snapshot.automaticRaw, kv.data.get(AUTOMATIC_KEY));
    assert.equal(snapshot.stateRaw, kv.data.get(STATE_KEY));
    // An edge that still serves November 8 now resolves tonight's video through the snapshot.
    clock += 2000;
    const selection = await loadRaffleSelection(edge(), true, new Date(clock), seasonEnv, async () => snapshot);
    assert.deepEqual([selection.source, selection.config.latestVideoUrl], ['automatic', url(VIDEO)]);
});

test('public API serves the coordinator selection, records its read path, and hints a 5-second poll at drawing start', async () => {
    const diagnostics = [], waits = [];
    const realNow = Date.now; Date.now = () => at603.getTime();
    const RealDate = globalThis.Date;
    globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [at603.getTime()])); } static now() { return at603.getTime(); } };
    try {
        const env = { CONFIG: edge(), RAFFLE_AUTOMATIC_SELECTION_ENABLED: 'true', ...seasonEnv,
            FACEBOOK_LIVE: { selection: coordinator(), recordDiagnostic: async v => { diagnostics.push(v); } } };
        const response = await GET({ locals: { runtime: { env, ctx: { waitUntil: p => waits.push(p) } } } });
        const body = await response.json();
        await Promise.all(waits);
        assert.deepEqual([body.source, body.config.latestVideoUrl, body.refreshMs], ['automatic', url(NOV9), 5000]);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual([diagnostics[0]?.stage, diagnostics[0]?.videoId, diagnostics[0]?.reason], ['public-visible', NOV9, 'durable-object']);
    } finally { globalThis.Date = RealDate; Date.now = realNow; }
});

test('browser refresh hint: 5 seconds from 5:58:00 through 6:05:59 PM Central in November, otherwise 15 seconds', () => {
    assert.equal(liveRefreshMs(t('2026-11-09T23:57:59.000Z')), 15000);
    assert.equal(liveRefreshMs(t('2026-11-09T23:58:00.000Z')), 5000);
    assert.equal(liveRefreshMs(t('2026-11-10T00:05:59.000Z')), 5000);
    assert.equal(liveRefreshMs(t('2026-11-10T00:06:00.000Z')), 15000);
    assert.equal(liveRefreshMs(t('2026-12-02T00:00:00.000Z')), 15000);
});

test('Pages binding adapter: only an object with a selection() method is used', () => {
    assert.equal(freshSelectionFrom(undefined), undefined);
    assert.equal(freshSelectionFrom({ timeline() {} }), undefined);
    assert.equal(typeof freshSelectionFrom({ selection: async () => ({}) }), 'function');
});
