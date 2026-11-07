import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryCoordinator } from '../workers/facebook-live/coordinator.ts';
import { runPoll, STATE_KEY, VERIFICATION_KEY } from '../workers/facebook-live/poller.ts';
import { AUTOMATIC_KEY } from '../src/lib/server/facebook-automation.ts';
import { loadRaffleSelection } from '../src/lib/server/raffle-selection.ts';
import { discoverySlot, nextDiscoverySlot } from '../src/lib/server/raffle-discovery-schedule.ts';
import { FACEBOOK_API_VERSION, FACEBOOK_GRAPH_PAGE_ID, FACEBOOK_LIVE_CONTRACT, FACEBOOK_PAGE_ID, RAFFLE_LIVE_KEY } from '../src/lib/facebook.ts';

// Characterizes, and does not change, Live selection during the November 6 interval.
// 5:58:48 and 6:00:15 PM Central are 23:58:48 and 00:00:15 UTC. No production log is involved, so these tests
// prove what the code would do under each scenario, not which scenario happened on November 6.
const at = (m, s = 0, ms = 0) => Date.UTC(2026, 10, m >= 58 ? 6 : 7, m >= 58 ? 23 : 0, m, s, ms);
const VIDEO = '1234567890', POST = `${FACEBOOK_GRAPH_PAGE_ID}_555`;
const env = store => ({ FB_AUTOMATION_ENABLED: 'true', FB_VIDEO_PROBE_ENABLED: 'true', FB_GRAPH_PAGE_ID: FACEBOOK_GRAPH_PAGE_ID, FB_PUBLIC_PAGE_ID: FACEBOOK_PAGE_ID,
    FB_PAGE_ACCESS_TOKEN: 'test-token', FB_ACCESS_REVISION: '1', FB_POLL_INTERVAL_SECONDS: '60', CONFIG: store,
    FB_SEASON_START: '2026-11-01T00:00:00-05:00', FB_SEASON_END: '2026-12-01T00:00:00-06:00' });
const receipt = () => JSON.stringify({ schemaVersion: 5, graphPageId: FACEBOOK_GRAPH_PAGE_ID, publicPageId: FACEBOOK_PAGE_ID, apiVersion: FACEBOOK_API_VERSION,
    contract: FACEBOOK_LIVE_CONTRACT, verifiedVideoId: '222', evidence: 'page-video-live-origin-policy-reviewed', publicPlaybackVerified: true, rollbackTested: true,
    verifiedAt: '2026-11-01T23:00:00Z', expiresAt: '2026-12-01T05:59:00Z' });
const kv = () => {
    const data = new Map([[VERIFICATION_KEY, receipt()], [RAFFLE_LIVE_KEY, JSON.stringify({ latestVideoUrl: null, automaticEnabled: true, selectionMode: 'automatic', updatedAt: '2026-11-01T22:00:00Z' })]]);
    return { data, writes: [], async get(k) { return data.get(k) ?? null; }, async put(k, v) { this.writes.push(k); data.set(k, v); } };
};
const doStorage = () => {
    const data = new Map(); let alarm = null;
    return { alarm: () => alarm, async get(k) { return data.get(k); }, async put(k, v) { data.set(k, v); }, async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; } };
};
/** Graph as seen at a moment. `visibleFrom` is when the Page feed first lists the video; `fail(t)` simulates a provider failure. */
const graph = ({ now, visibleFrom = Infinity, created = new Date(at(58, 48)), fail = () => false, calls }) => async request => {
    const url = new URL(String(request.url ?? request)), path = url.pathname.split('/').slice(2).join('/'), time = now();
    calls?.push({ time, path });
    if (fail(time)) return new Response('{}', { status: 500 });
    if (path === FACEBOOK_GRAPH_PAGE_ID) return Response.json({ id: FACEBOOK_GRAPH_PAGE_ID });
    if (path.endsWith('published_posts')) return Response.json({ data: time >= visibleFrom ? [{ id: POST, created_time: created.toISOString().replace('.000Z', '+0000'),
        attachments: { data: [{ type: 'video_inline', target: { id: VIDEO }, url: `https://www.facebook.com/${FACEBOOK_PAGE_ID}/videos/${VIDEO}/` }] } }] : [] });
    if (path === VIDEO && url.searchParams.get('fields') === 'id,format') return Response.json({ id: VIDEO });
    if (path === VIDEO) return Response.json({ id: VIDEO, from: { id: FACEBOOK_GRAPH_PAGE_ID }, created_time: created.toISOString().replace('.000Z', '+0000'), live_status: 'LIVE',
        permalink_url: `/${FACEBOOK_PAGE_ID}/videos/${VIDEO}/`, status: { video_status: 'ready' }, embeddable: true, published: true });
    return Response.json({ error: { code: 100 } }, { status: 400 });
};
/** Runs the real coordinator and poller from start to end, firing each alarm `lag(scheduledAt)` milliseconds late. */
async function simulate({ start = at(58) - 60_000, end = at(59 + 3), visibleFrom, fail, lag = () => 40 }) {
    let clock = start;
    const store = kv(), storage = doStorage(), calls = [], outcomes = [];
    const fetcher = graph({ now: () => clock, visibleFrom, fail, calls });
    const coordinator = new DiscoveryCoordinator(storage, env(store), () => clock, runPoll, fetcher);
    await storage.setAlarm(start);
    while (storage.alarm() !== null && storage.alarm() < end) {
        clock = storage.alarm() + lag(storage.alarm());
        await storage.setAlarm(null);
        const outcome = await coordinator.alarm();
        outcomes.push({ at: clock, status: outcome.status });
        if (storage.alarm() === null) break;
    }
    return { store, outcomes, calls };
}
const firstStaged = sim => sim.outcomes.find(o => o.status === 'staged')?.at ?? null;

test('Durable Object cadence: one-minute slots until 5:59:00 PM, then every 15 seconds through 6:01:45 PM', () => {
    const slots = [];
    for (let t = at(58); t !== null && t < at(59 + 4); t = nextDiscoverySlot(new Date(t))) slots.push(t);
    assert.deepEqual(slots.slice(0, 6), [at(58), at(59), at(59, 15), at(59, 30), at(59, 45), at(59 + 1)]);
    assert.ok(slots.includes(at(59 + 3, 45)) === false);
    assert.ok(slots.includes(at(59 + 2, 45)));
    assert.equal(discoverySlot(new Date(at(58, 48))), at(58));
});

test('healthy polling: a video visible from 5:58:48 PM is staged on the 5:59:00 slot, 12 seconds later', async () => {
    const sim = await simulate({ visibleFrom: at(58, 48) });
    assert.equal(firstStaged(sim), at(59) + 40);
});

test('Graph lag alone can produce 6:00:15: stage time is the first slot after the feed lists the video', async () => {
    const sim = await simulate({ visibleFrom: at(59 + 1, 5) });
    assert.equal(firstStaged(sim), at(59 + 1, 15) + 40);
});

test('one failed poll at 5:58:00 PM alone can also produce 6:00:15: backoff suppresses the whole 15-second burst', async () => {
    const fail = t => t >= at(58) && t < at(58, 30);
    // The failed poll sets nextAttemptAt to its own start + 120s, so alarm jitter decides between the two slots at 6:00.
    assert.equal(firstStaged(await simulate({ visibleFrom: at(58, 48), fail, lag: () => 40 })), at(59 + 1) + 40);
    const sim = await simulate({ visibleFrom: at(58, 48), fail, lag: scheduled => scheduled === at(58) ? 200 : 40 });
    assert.equal(firstStaged(sim), at(59 + 1, 15) + 40);
    const during = sim.outcomes.filter(o => o.at > at(58, 30) && o.at < at(59 + 1, 15));
    assert.ok(during.length >= 5);
    assert.ok(during.every(o => o.status === 'not-due'), JSON.stringify(during));
    // No Facebook request was made for any of the 15-second slots while the video was already visible.
    assert.equal(sim.calls.filter(c => c.time > at(58, 30) && c.time < at(59 + 1, 15)).length, 0);
    assert.equal(JSON.parse(sim.store.data.get(STATE_KEY)).failures, 0);
});

test('webhook arrival: a signed event wakes the coordinator immediately and bypasses the slot claim', async () => {
    const store = kv(), storage = doStorage(); let clock = at(58, 48);
    const coordinator = new DiscoveryCoordinator(storage, env(store), () => clock, runPoll, graph({ now: () => clock, visibleFrom: at(58, 48) }));
    assert.equal(await coordinator.event('a'.repeat(64)), true);
    assert.equal(storage.alarm(), clock);
    assert.equal(JSON.parse(store.data.get('raffle_live_webhook_state')).lastEventReceivedAt, new Date(clock).toISOString());
    assert.equal(await coordinator.event('a'.repeat(64)), false); // Meta redelivery is ignored.
    clock += 50;
    assert.equal((await coordinator.alarm()).status, 'staged');
    assert.equal(storage.alarm(), at(59)); // The next regular slot is re-armed.
    // Outside the window and malformed IDs do no work.
    clock = at(58) - 2 * 3600_000;
    assert.equal(await coordinator.event('b'.repeat(64)), false);
    assert.equal(await coordinator.event('not-a-hash'), false);
});

test('webhook during backoff: a signed event bypasses a failure backoff', async () => {
    const store = kv(), storage = doStorage(); let clock = at(58), failing = true;
    const fetcher = graph({ now: () => clock, visibleFrom: at(58), fail: () => failing });
    const coordinator = new DiscoveryCoordinator(storage, env(store), () => clock, runPoll, fetcher);
    await coordinator.alarm();
    assert.ok(JSON.parse(store.data.get(STATE_KEY)).nextAttemptAt >= at(58) + 120_000);
    failing = false;
    clock = at(58, 48);
    await coordinator.event('c'.repeat(64));
    assert.equal((await coordinator.alarm()).status, 'staged');
});

test('Graph verification failure stays unpublished: nothing is staged without a verified Page Live video', async () => {
    const store = kv(); const now = () => at(59, 15);
    const wrongPage = async request => {
        const response = await graph({ now, visibleFrom: at(58) })(request);
        const body = await response.clone().json();
        return body.from ? Response.json({ ...body, from: { id: '999' } }) : response;
    };
    const result = await runPoll(env(store), { now: new Date(now()), fetcher: wrongPage, nextScheduledAt: at(59, 30) });
    assert.notEqual(result.status, 'staged');
    assert.equal(store.data.get(AUTOMATIC_KEY), undefined);
});

test('KV write completion: the selection is written before state, so public reads can briefly fall back', async () => {
    const store = kv(); let clock = at(59);
    const result = await runPoll(env(store), { now: new Date(clock), fetcher: graph({ now: () => clock, visibleFrom: at(58, 48) }), nextScheduledAt: at(59, 15) });
    assert.equal(result.status, 'staged');
    assert.deepEqual(store.writes.filter(k => k === AUTOMATIC_KEY || k === STATE_KEY), [AUTOMATIC_KEY, STATE_KEY]);
    // Public availability: a reader that sees the new selection without the new state gets the safe fallback.
    const reader = keys => ({ get: async k => keys.has(k) ? store.data.get(k) ?? null : null });
    const seasonEnv = env(store);
    const both = new Set([RAFFLE_LIVE_KEY, VERIFICATION_KEY, AUTOMATIC_KEY, STATE_KEY]);
    const later = new Date(at(59, 1));
    const ready = await loadRaffleSelection(reader(both), true, later, seasonEnv);
    assert.deepEqual([ready.source, ready.reason], ['automatic', 'verified-discovery']);
    assert.match(ready.config.latestVideoUrl, new RegExp(VIDEO));
    const stateBehind = new Set([RAFFLE_LIVE_KEY, VERIFICATION_KEY, AUTOMATIC_KEY]);
    const partial = await loadRaffleSelection(reader(stateBehind), true, later, seasonEnv);
    assert.deepEqual([partial.source, partial.reason], ['manual', 'detection-unavailable']);
    // A failed state write leaves the same safe fallback rather than an unverified selection.
    const brokenState = kv(); const put = brokenState.put;
    brokenState.put = async function (k, v) { if (k === STATE_KEY) throw Error('kv down'); return put.call(this, k, v); };
    assert.equal((await runPoll(env(brokenState), { now: new Date(clock), fetcher: graph({ now: () => clock, visibleFrom: at(58, 48) }), nextScheduledAt: at(59, 15) })).status, 'storage-or-state-failure');
    assert.equal((await loadRaffleSelection(brokenState, true, later, env(brokenState))).source, 'manual');
});

test('automatic selection stays on once detected, and admin-disabled automation does no Facebook work', async () => {
    const sim = await simulate({ visibleFrom: at(58, 48) });
    const statuses = sim.outcomes.filter(o => o.at > at(59) + 40).map(o => o.status);
    assert.ok(statuses.length && statuses.every(s => s === 'unchanged'), JSON.stringify(statuses));
    const store = kv();
    store.data.set(RAFFLE_LIVE_KEY, JSON.stringify({ automaticEnabled: false }));
    let requests = 0;
    const result = await runPoll(env(store), { now: new Date(at(59)), fetcher: async () => { requests++; return new Response('{}'); }, nextScheduledAt: at(59, 15) });
    assert.deepEqual([result.status, requests], ['disabled-by-admin', 0]);
});
