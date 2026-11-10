import test from 'node:test';
import assert from 'node:assert/strict';
import { selectRaffleVideo, loadRaffleSelection, verificationValid, VERIFICATION_KEY, STATE_KEY } from '../src/lib/server/raffle-selection.ts';
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
    origin:'page-video-live-status',originStatus:'LIVE',originObservedAt:'2026-11-02T00:00:00Z',drawingDate:'2026-11-01',observedAt: '2026-11-02T00:00:00Z', status: 'video', liveStatus: 'VOD' };
const state = { version: 1, paused: false, failures: 0, status: 'staged', lastVerifiedVideoId: '222',
    lastVerifiedAt: now.toISOString(), lastAttemptAt: now.getTime() };
const receipt = { schemaVersion: 5, graphPageId: FACEBOOK_GRAPH_PAGE_ID, publicPageId: FACEBOOK_PAGE_ID,
    apiVersion: FACEBOOK_API_VERSION, contract: FACEBOOK_LIVE_CONTRACT, verifiedVideoId: '222',
    evidence: 'page-video-live-origin-policy-reviewed', marker: '#LakeHenryRaffle', publicPlaybackVerified: true, rollbackTested: true,
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
        { automaticRaw: JSON.stringify({ ...stage, status: 'live' }) },
        { automaticRaw: JSON.stringify({ ...stage, graphPageId: FACEBOOK_PAGE_ID }) },
        { automaticRaw: JSON.stringify({ ...stage, observedAt: '2026-11-03T00:00:00Z' }) },
        ...[{ lastVerifiedVideoId: '999' }, { lastVerifiedAt: '2026-11-01T23:54:59Z' },
            { lastVerifiedAt:'2026-11-01T23:59:59Z' }].map(change => ({ stateRaw: JSON.stringify({ ...state, ...change }) }))]) {
        assert.equal(selectRaffleVideo(input(extra)).config.latestVideoUrl, url('111'), JSON.stringify(extra));
    }
    const cleared = selectRaffleVideo(input({ manualRaw: JSON.stringify({ ...manual, latestVideoUrl: null }), stateRaw: '{}' }));
    assert.equal(cleared.config.latestVideoUrl, null);
    assert.equal(selectRaffleVideo(input()).source, 'automatic'); // recovery
});

test('long Live uses fresh health without timestamp churn; unproven replay falls back', () => {
    const later = new Date('2026-11-02T02:05:00Z');
    const freshState = JSON.stringify({ ...state, lastVerifiedAt: later.toISOString(), lastAttemptAt: later.getTime() });
    assert.equal(selectRaffleVideo(input({ now: later, stateRaw: freshState })).config.updatedAt, stage.observedAt);
    assert.equal(selectRaffleVideo(input({ now: later, stateRaw: freshState,
        automaticRaw: JSON.stringify({ ...stage, status: 'replay', liveStatus: 'LIVE_STOPPED' }) })).reason, 'invalid-discovery');
});

test('verified replays remain displayed without repeating API requests', () => {
    const later = new Date('2026-11-03T13:00:01Z');
    const fresh = JSON.stringify({ ...state, lastVerifiedAt: later.toISOString(), lastAttemptAt: later.getTime() });
    assert.equal(selectRaffleVideo(input({ now: later, stateRaw: fresh })).source, 'automatic');
});

test('season is configurable for future years and validates dates; a later season activates only with its own reviewed receipt', () => {
    const future = raffleSeason({ FB_SEASON_START: '2027-11-01T00:00:00-05:00', FB_SEASON_END: '2027-12-01T00:00:00-06:00' });
    assert.ok(future);
    assert.equal(selectRaffleVideo(input({ season: future })).source, 'manual');
    for (const env of [{ FB_SEASON_START: 'bad' }, { FB_SEASON_START: '2026-11-31T00:00:00Z' },
        { FB_SEASON_END: '2026-10-01T00:00:00Z' }, { FB_SEASON_END: '2028-12-01T00:00:00Z' }]) assert.equal(raffleSeason(env), null);
    const advance = value => JSON.stringify(value).replaceAll('2026-', '2027-');
    const result = selectRaffleVideo(input({ now: new Date('2027-11-02T00:05:00Z'), season: future,
        manualRaw: advance(manual), automaticRaw: advance(stage), verificationRaw: advance(receipt),
        stateRaw: JSON.stringify({ ...state, lastVerifiedAt: '2027-11-02T00:05:00Z', lastAttemptAt: Date.parse('2027-11-02T00:05:00Z') }) }));
    assert.equal(result.source, 'automatic'); // year-round code: the reviewed receipt, not the calendar, authorizes
    const withOldReceipt = selectRaffleVideo(input({ now: new Date('2027-11-02T00:05:00Z'), season: future,
        manualRaw: advance(manual), automaticRaw: advance(stage), verificationRaw: JSON.stringify(receipt),
        stateRaw: JSON.stringify({ ...state, lastVerifiedAt: '2027-11-02T00:05:00Z', lastAttemptAt: Date.parse('2027-11-02T00:05:00Z') }) }));
    assert.deepEqual([withOldReceipt.source, withOldReceipt.reason], ['manual', 'verification-required']); // 2026 receipt cannot authorize 2027
    // A receipt may never authorize more than 400 days after its verification (receipt verifiedAt 2026-11-01T23:00Z).
    for (const [expiresAt, source] of [['2027-12-06T23:00:00Z', 'automatic'], ['2027-12-06T23:00:01Z', 'manual']]) {
        assert.equal(selectRaffleVideo(input({ verificationRaw: JSON.stringify({ ...receipt, expiresAt }) })).source, source, expiresAt);
    }
    // The planned one-year receipt: verified in November 2026, expiring 2027-12-01 00:00 Central, valid until then and not after.
    const term = JSON.stringify({ ...receipt, verifiedAt: '2026-11-10T03:00:00Z', expiresAt: '2027-12-01T06:00:00.000Z' });
    assert.equal(verificationValid(term, new Date('2027-11-30T23:59:59Z'), raffleSeason()), true);
    assert.equal(verificationValid(term, new Date('2027-12-01T06:00:00Z'), raffleSeason()), false);
    // Every other receipt rule still applies to a long-lived receipt.
    for (const change of [{ contract: 'tagged-page-video-v1' }, { evidence: 'other' }, { publicPlaybackVerified: false }, { rollbackTested: false },
        { graphPageId: '1' }, { apiVersion: 'v25.0' }, { schemaVersion: 4 }, { verifiedAt: '2026-10-31T23:00:00Z' }]) {
        assert.equal(verificationValid(JSON.stringify({ ...JSON.parse(term), ...change }), new Date('2027-06-01T00:00:00Z'), raffleSeason()), false, JSON.stringify(change));
    }
});

test('extra KV failures retain saved fallback; disabled reads only the manual record', async () => {
    const reads = [];
    const kv = { async get(k) { reads.push(k); if (k === RAFFLE_LIVE_KEY) return JSON.stringify(manual); throw Error('private'); } };
    assert.equal((await loadRaffleSelection(kv, false, now)).config.latestVideoUrl, url('111'));
    assert.deepEqual(reads, [RAFFLE_LIVE_KEY]);
    assert.equal((await loadRaffleSelection(kv, true, now)).reason, 'detection-unavailable');
});

test('admin mode preserves manual fields; automatic setting remains independent of manual saves', async () => {
    const kv = kvStore();
    assert.equal((await POST(context(kv, { action: 'setMode', selectionMode: 'automatic' }, false))).status, 409);
    // Actual wall clock is irrelevant: no valid receipt may be assumed in this API test.
    kv.data.delete(VERIFICATION_KEY);
    assert.equal((await POST(context(kv, { action: 'setMode', selectionMode: 'automatic' }))).status, 200);
    const response = await POST(context(kv, { action: 'setMode', selectionMode: 'manual' }));
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(kv.data.get(RAFFLE_LIVE_KEY)), { ...manual, selectionMode: 'manual', automaticEnabled:false });
    kv.data.set(RAFFLE_LIVE_KEY, JSON.stringify(manual));
    await POST(context(kv, { latestVideoUrl: manual.latestVideoUrl }));
    assert.equal(JSON.parse(kv.data.get(RAFFLE_LIVE_KEY)).selectionMode, 'automatic');
    assert.equal(JSON.parse(kv.data.get(RAFFLE_LIVE_KEY)).preserved, 'yes');
    await POST(context(kv, { latestVideoUrl: '' }));
    assert.equal(JSON.parse(kv.data.get(RAFFLE_LIVE_KEY)).latestVideoUrl, null);
    assert.equal((await (await GET(context(kv))).json()).selectionMode, 'automatic');
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

test('saving a fallback preserves both the displayed explicit manual override and independent automatic enablement',async()=>{
 const kv=kvStore();await POST(context(kv,{action:'showVideo',latestVideoUrl:url('333')}));
 await POST(context(kv,{action:'saveFallback',latestVideoUrl:url('444')}));
 const saved=JSON.parse(kv.data.get(RAFFLE_LIVE_KEY));assert.equal(saved.automaticEnabled,true);assert.equal(saved.manualOverrideUrl,url('333'));assert.equal(saved.latestVideoUrl,url('444'));
 const selected=selectRaffleVideo(input({now:new Date(),manualRaw:JSON.stringify(saved)}));assert.equal(selected.config.latestVideoUrl,url('333'));assert.equal(selected.manualConfig.latestVideoUrl,url('444'));
});
