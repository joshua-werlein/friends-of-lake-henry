import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRaffleVideo, loadRaffleSelection, VERIFICATION_KEY, STATE_KEY } from '../src/lib/server/raffle-selection.ts';
import { raffleSeason } from '../src/lib/server/raffle-season.ts';
import { GET, POST } from '../src/pages/api/admin/raffle/live.ts';
import { onRequest } from '../src/middleware.ts';
import { FACEBOOK_PAGE_ID, FACEBOOK_GRAPH_PAGE_ID, FACEBOOK_API_VERSION, FACEBOOK_LIVE_CONTRACT, RAFFLE_LIVE_KEY } from '../src/lib/facebook.ts';
const now = new Date('2026-11-02T00:05:00Z');
const url = id => `https://www.facebook.com/${FACEBOOK_PAGE_ID}/videos/${id}/`;
const manual = { latestVideoUrl: url('111'), updatedAt: '2026-11-01T22:00:00Z', selectionMode: 'automatic', preserved: 'yes' };
const stage = { schemaVersion: 2, graphPageId: FACEBOOK_GRAPH_PAGE_ID, publicPageId: FACEBOOK_PAGE_ID,
    apiVersion: FACEBOOK_API_VERSION, contract: FACEBOOK_LIVE_CONTRACT, id: '222', videoId: '222',
    postId: `${FACEBOOK_GRAPH_PAGE_ID}_333`, url: url('222'), publishedAt: '2026-11-02T00:00:00Z',
    observedAt: '2026-11-02T00:00:00Z', status: 'live', liveStatus: 'LIVE' };
const state = { version: 1, paused: false, failures: 0, status: 'staged', lastVerifiedVideoId: '222',
    lastVerifiedAt: now.toISOString(), lastAttemptAt: now.getTime() };
const receipt = { schemaVersion: 1, graphPageId: FACEBOOK_GRAPH_PAGE_ID, publicPageId: FACEBOOK_PAGE_ID,
    apiVersion: FACEBOOK_API_VERSION, contract: FACEBOOK_LIVE_CONTRACT, verifiedVideoId: '222',
    verifiedAt: '2026-11-01T23:00:00Z', expiresAt: '2026-12-01T06:00:00Z' };
const input = extra => ({ enabled: true, now, manualRaw: JSON.stringify(manual), automaticRaw: JSON.stringify(stage),
    stateRaw: JSON.stringify(state), verificationRaw: JSON.stringify(receipt), ...extra });
function kvStore() {
    const data = new Map([[RAFFLE_LIVE_KEY, JSON.stringify(manual)], [VERIFICATION_KEY, JSON.stringify(receipt)],
        ['raffle_live_automatic', JSON.stringify(stage)], [STATE_KEY, JSON.stringify(state)]]);
    return { data, writes: [], async get(k) { return data.get(k) ?? null; }, async put(k,v) { this.writes.push(k); data.set(k,v); } };
}
const context = (kv, body, enabled = true) => ({ locals: { runtime: { env: { CONFIG: kv,
    RAFFLE_AUTOMATIC_SELECTION_ENABLED: String(enabled) } } }, request: new Request('https://example.test/api/admin/raffle/live',
    { method: 'POST', body: JSON.stringify(body) }) });

test('automatic requires explicit opt-in, verification and fresh matching health; Manual always wins', () => {
    assert.equal(selectRaffleVideo(input()).config.latestVideoUrl, url('222'));
    assert.equal(selectRaffleVideo(input({ enabled: false })).config.latestVideoUrl, url('111'));
    for (const selectionMode of ['manual', undefined, 'unknown']) {
        assert.equal(selectRaffleVideo(input({ manualRaw: JSON.stringify({ ...manual, selectionMode }) })).source, 'manual');
    }
    for (const extra of [{ verificationRaw: null }, { automaticRaw: '{}' }, { stateRaw: '{}' },
        { verificationRaw: JSON.stringify({ ...receipt, expiresAt: now.toISOString() }) },
        { automaticRaw: JSON.stringify({ ...stage, liveStatus: 'VOD' }) },
        { automaticRaw: JSON.stringify({ ...stage, graphPageId: FACEBOOK_PAGE_ID }) },
        { automaticRaw: JSON.stringify({ ...stage, observedAt: '2026-11-03T00:00:00Z' }) },
        ...[{ paused: true }, { failures: 1 }, { status: 'permission-denied' }, { status: 'no-verified-live' },
            { lastVerifiedVideoId: '999' }, { lastVerifiedAt: '2026-11-01T23:54:59Z' },
            { lastAttemptAt: now.getTime() - 600001 }].map(change => ({ stateRaw: JSON.stringify({ ...state, ...change }) }))]) {
        assert.equal(selectRaffleVideo(input(extra)).config.latestVideoUrl, url('111'), JSON.stringify(extra));
    }
    const cleared = selectRaffleVideo(input({ manualRaw: JSON.stringify({ ...manual, latestVideoUrl: null }), stateRaw: '{}' }));
    assert.equal(cleared.config.latestVideoUrl, null);
    assert.equal(selectRaffleVideo(input()).source, 'automatic'); // recovery
});

test('long Live uses fresh health without timestamp churn; stale replay falls back', () => {
    const later = new Date('2026-11-03T02:05:00Z');
    const freshState = JSON.stringify({ ...state, lastVerifiedAt: later.toISOString(), lastAttemptAt: later.getTime() });
    assert.equal(selectRaffleVideo(input({ now: later, stateRaw: freshState })).config.updatedAt, stage.observedAt);
    assert.equal(selectRaffleVideo(input({ now: later, stateRaw: freshState,
        automaticRaw: JSON.stringify({ ...stage, status: 'replay', liveStatus: 'LIVE_STOPPED' }) })).reason, 'stale-discovery');
});

test('season is configurable for future years, validates dates, and never activates outside season', () => {
    const future = raffleSeason({ FB_SEASON_START: '2027-11-01T00:00:00-05:00', FB_SEASON_END: '2027-12-01T00:00:00-06:00' });
    assert.ok(future);
    assert.equal(selectRaffleVideo(input({ season: future })).source, 'manual');
    for (const env of [{ FB_SEASON_START: 'bad' }, { FB_SEASON_START: '2026-11-31T00:00:00Z' },
        { FB_SEASON_END: '2026-10-01T00:00:00Z' }, { FB_SEASON_END: '2028-12-01T00:00:00Z' }]) assert.equal(raffleSeason(env), null);
    const advance = value => JSON.stringify(value).replaceAll('2026-', '2027-');
    const result = selectRaffleVideo(input({ now: new Date('2027-11-02T00:05:00Z'), season: future,
        manualRaw: advance(manual), automaticRaw: advance(stage), verificationRaw: advance(receipt),
        stateRaw: JSON.stringify({ ...state, lastVerifiedAt: '2027-11-02T00:05:00Z', lastAttemptAt: Date.parse('2027-11-02T00:05:00Z') }) }));
    assert.equal(result.source, 'automatic');
});

test('extra KV failures retain saved fallback; disabled reads only the manual record', async () => {
    const reads = [];
    const kv = { async get(k) { reads.push(k); if (k === RAFFLE_LIVE_KEY) return JSON.stringify(manual); throw Error('private'); } };
    assert.equal((await loadRaffleSelection(kv, false, now)).config.latestVideoUrl, url('111'));
    assert.deepEqual(reads, [RAFFLE_LIVE_KEY]);
    assert.equal((await loadRaffleSelection(kv, true, now)).reason, 'detection-unavailable');
});

test('admin mode preserves manual fields; unverified Automatic rejected; any manual save immediately restores Manual', async () => {
    const kv = kvStore();
    assert.equal((await POST(context(kv, { action: 'setMode', selectionMode: 'automatic' }, false))).status, 409);
    // Actual wall clock is irrelevant: no valid receipt may be assumed in this API test.
    kv.data.delete(VERIFICATION_KEY);
    assert.equal((await POST(context(kv, { action: 'setMode', selectionMode: 'automatic' }))).status, 409);
    const response = await POST(context(kv, { action: 'setMode', selectionMode: 'manual' }));
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(kv.data.get(RAFFLE_LIVE_KEY)), { ...manual, selectionMode: 'manual' });
    kv.data.set(RAFFLE_LIVE_KEY, JSON.stringify(manual));
    await POST(context(kv, { latestVideoUrl: manual.latestVideoUrl }));
    assert.equal(JSON.parse(kv.data.get(RAFFLE_LIVE_KEY)).selectionMode, 'manual');
    assert.equal(JSON.parse(kv.data.get(RAFFLE_LIVE_KEY)).preserved, 'yes');
    await POST(context(kv, { latestVideoUrl: '' }));
    assert.equal(JSON.parse(kv.data.get(RAFFLE_LIVE_KEY)).latestVideoUrl, null);
    assert.equal((await (await GET(context(kv))).json()).selectionMode, 'manual');
    assert.equal(kv.writes.every(k => k === RAFFLE_LIVE_KEY), true);
});

test('existing middleware enforces authentication and same-origin CSRF for mode changes', async () => {
    const url = new URL('https://example.test/api/admin/raffle/live');
    const ctx = (origin, cookie = '') => ({ url, request: new Request(url, { method: 'POST',
        headers: { Origin: origin, Cookie: cookie } }), locals: { runtime: { env: { SESSION: {
            async get() { return JSON.stringify({ role: 'admin' }); } } } } } });
    let calls = 0;
    const next = async () => { calls++; return new Response('ok'); };
    assert.equal((await onRequest(ctx('https://evil.test', 'admin_session=local'), next)).status, 403);
    assert.equal((await onRequest(ctx(url.origin), next)).status, 401);
    assert.equal((await onRequest(ctx(url.origin, 'admin_session=local'), next)).status, 200);
    assert.equal(calls, 1);
});
