import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRaffleSelection, SnapshotCache, STATE_KEY, VERIFICATION_KEY } from '../src/lib/server/raffle-selection.ts';
import { AUTOMATIC_KEY } from '../src/lib/server/facebook-automation.ts';
import { alertWindowEnd, inAlertDeliveryWindow, inDiscoveryWindow } from '../src/lib/server/raffle-discovery-schedule.ts';
import { DiscoveryCoordinator } from '../workers/facebook-live/coordinator.ts';
import { runPoll } from '../workers/facebook-live/poller.ts';
import { FACEBOOK_API_VERSION, FACEBOOK_GRAPH_PAGE_ID, FACEBOOK_LIVE_CONTRACT, FACEBOOK_PAGE_ID, RAFFLE_LIVE_KEY } from '../src/lib/facebook.ts';

// Production season vars (November 2026). Times: Central = UTC-6 in winter.
const seasonEnv = { FB_SEASON_START: '2026-11-01T00:00:00-05:00', FB_SEASON_END: '2026-12-01T00:00:00-06:00' };
const url = id => `https://www.facebook.com/${FACEBOOK_PAGE_ID}/videos/${id}/`;
const central = (y, mo, d, h, mi, s = 0) => Date.UTC(y, mo - 1, d, h + 6, mi, s);
const baseReceipt = { schemaVersion: 5, graphPageId: FACEBOOK_GRAPH_PAGE_ID, publicPageId: FACEBOOK_PAGE_ID, apiVersion: FACEBOOK_API_VERSION,
    contract: FACEBOOK_LIVE_CONTRACT, verifiedVideoId: '1129604836279234', evidence: 'page-video-live-origin-policy-reviewed', publicPlaybackVerified: true,
    rollbackTested: true, verifiedAt: '2026-11-06T03:03:33.834Z' };
const CURRENT_RECEIPT = { ...baseReceipt, expiresAt: '2026-12-01T06:00:00.000Z' };      // the production receipt, unchanged
const REVIEWED_RENEWAL = { ...baseReceipt, expiresAt: '2027-11-06T00:00:00.000Z' };    // a hypothetical future reviewed receipt
const NOV30 = '1999999999999999';
const finalStage = { schemaVersion: 2, graphPageId: FACEBOOK_GRAPH_PAGE_ID, publicPageId: FACEBOOK_PAGE_ID, apiVersion: FACEBOOK_API_VERSION,
    contract: FACEBOOK_LIVE_CONTRACT, id: NOV30, videoId: NOV30, postId: `${FACEBOOK_GRAPH_PAGE_ID}_${NOV30}`, url: url(NOV30),
    publishedAt: '2026-12-01T00:00:10+0000', observedAt: '2026-12-01T00:00:20.000Z', origin: 'page-video-live-status', originStatus: 'LIVE',
    originObservedAt: '2026-12-01T00:00:20.000Z', drawingDate: '2026-11-30', status: 'video', liveStatus: 'LIVE' };
const finalState = { version: 1, accessRevision: 'r', lastAttemptAt: Date.parse('2026-12-01T00:15:00Z'), nextAttemptAt: Date.parse('2026-12-01T00:16:00Z'),
    failures: 0, status: 'unchanged', paused: false, lastVerifiedVideoId: NOV30, lastVerifiedAt: '2026-12-01T00:15:00.000Z' };
const alertsOn = { ALERTS_ENABLED: 'true', ALERTS_MODE: 'live', ALERT_RESEND_API_KEY: 're_test', ALERT_EMAIL_TO: 'ops@example.test' };

/** The real coordinator, poller and resolver over in-memory DO storage, KV, Graph and Resend. */
function harness(startMs, { receipt = REVIEWED_RENEWAL, videos = [], alerts = false, graphFails = null, resend = () => 200, manual } = {}) {
    let clock = startMs, alarm = null, n = 0;
    const data = new Map([[RAFFLE_LIVE_KEY, JSON.stringify(manual ?? { latestVideoUrl: url('1129604836279234'), updatedAt: '2026-11-06T03:00:00.000Z', selectionMode: 'automatic', automaticEnabled: true })],
        [VERIFICATION_KEY, JSON.stringify(receipt)], [AUTOMATIC_KEY, JSON.stringify(finalStage)], [STATE_KEY, JSON.stringify(finalState)]]);
    const kvWrites = [];
    const kv = { data, async get(k) { return data.get(k) ?? null; }, async put(k, v) { kvWrites.push(k); data.set(k, v); } };
    const disk = new Map();
    const storage = { async get(k) { return structuredClone(disk.get(k)); }, async put(k, v) { disk.set(k, structuredClone(v)); },
        async getAlarm() { return alarm; }, async setAlarm(v) { alarm = v; } };
    const graphCalls = [], emails = [];
    const fetcher = async (input, init) => {
        const u = new URL(String(input.url ?? input));
        if (u.hostname === 'api.resend.com') {
            emails.push({ at: clock, key: init.headers['Idempotency-Key'], subject: JSON.parse(init.body).subject });
            return new Response('{}', { status: resend(emails.length) });
        }
        const path = u.pathname.split('/').slice(2).join('/');
        graphCalls.push(path);
        if (graphFails) return Response.json({ error: { code: graphFails } }, { status: 403 });
        if (path === FACEBOOK_GRAPH_PAGE_ID) return Response.json({ id: FACEBOOK_GRAPH_PAGE_ID });
        if (path.endsWith('published_posts')) return Response.json({ data: videos.filter(v => clock >= (v.visibleFrom ?? -Infinity)).map(v => ({ id: `${FACEBOOK_GRAPH_PAGE_ID}_${v.id}9`,
            created_time: v.published, attachments: { data: [{ type: v.type ?? 'video_inline', target: { id: v.id }, url: v.link ?? url(v.id) }] } })) });
        const v = videos.find(x => x.id === path);
        if (v && u.searchParams.get('fields') === 'id,format') return Response.json({ id: v.id });
        if (v) return Response.json({ id: v.id, from: { id: v.owner ?? FACEBOOK_GRAPH_PAGE_ID }, created_time: v.published, live_status: v.live ?? 'LIVE',
            permalink_url: `/${FACEBOOK_PAGE_ID}/videos/${v.id}/`, status: { video_status: 'ready' }, embeddable: true, published: true });
        return Response.json({ error: { code: 100 } }, { status: 400 });
    };
    const env = { FB_AUTOMATION_ENABLED: 'true', FB_VIDEO_PROBE_ENABLED: 'true', FB_GRAPH_PAGE_ID: FACEBOOK_GRAPH_PAGE_ID, FB_PUBLIC_PAGE_ID: FACEBOOK_PAGE_ID,
        FB_PAGE_ACCESS_TOKEN: 'test-token', FB_ACCESS_REVISION: 'r', FB_POLL_INTERVAL_SECONDS: '60', CONFIG: kv, ...seasonEnv, ...(alerts ? alertsOn : {}) };
    const coord = new DiscoveryCoordinator(storage, env, () => clock, runPoll, fetcher);
    return { kv, kvWrites, graphCalls, emails, coord,
        get alarm() { return alarm; }, get clock() { return clock; }, set clock(v) { clock = v; },
        async fire(at = alarm) { clock = at; alarm = null; return coord.alarm(); },
        async hint(at) { clock = at; assert.equal(await coord.event((++n).toString(16).padStart(64, '0')), true); return this.fire(at); },
        show(at) { return loadRaffleSelection(kv, true, new Date(at), seasonEnv, () => coord.selectionSnapshot(), new SnapshotCache()); } };
}
const jan15 = (h, m, s = 0) => central(2027, 1, 15, h, m, s);

test('off-season (January): a signed webhook selects a verified Live under a current reviewed receipt, and it appears promptly', async () => {
    const h = harness(jan15(10, 0), { videos: [{ id: '5555', published: '2027-01-15T16:30:05+0000', visibleFrom: jan15(10, 30, 5) }] });
    assert.equal(inDiscoveryWindow(new Date(jan15(18, 0))), false); // no scheduled backup outside November 2026
    assert.equal((await h.hint(jan15(10, 29, 40))).status, 'no-eligible-video'); // hint before the video exists
    assert.equal(h.alarm, null); // no follow-on polling
    assert.equal((await h.hint(jan15(10, 30, 15))).status, 'staged');
    const shown = await h.show(jan15(10, 30, 17));
    assert.deepEqual([shown.source, shown.reason, shown.config.latestVideoUrl, shown.readPath, shown.refreshMs], ['automatic', 'verified-discovery', url('5555'), 'durable-object', 5000]);
});

test('off-season with the current receipt (expires Dec 1): hints select nothing, make no Graph calls or writes, and the final November replay stays', async () => {
    const h = harness(jan15(10, 0), { receipt: CURRENT_RECEIPT, videos: [{ id: '5555', published: '2027-01-15T16:30:05+0000' }] });
    assert.equal((await h.hint(jan15(10, 30, 15))).status, 'verification-required');
    assert.deepEqual([h.graphCalls.length, h.kvWrites.filter(k => k !== 'raffle_live_webhook_state').length], [0, 0]);
    const shown = await h.show(jan15(10, 30, 17));
    assert.deepEqual([shown.source, shown.config.latestVideoUrl], ['automatic', url(NOV30)]);
    // A forged stage observed after the season cannot ride on the season's receipt either.
    h.kv.data.set(AUTOMATIC_KEY, JSON.stringify({ ...finalStage, id: '5555', videoId: '5555', postId: `${FACEBOOK_GRAPH_PAGE_ID}_5555`, url: url('5555'),
        publishedAt: '2027-01-15T16:30:05+0000', observedAt: '2027-01-15T16:30:15.000Z', originObservedAt: '2027-01-15T16:30:15.000Z', drawingDate: '2027-01-15' }));
    h.kv.data.set(STATE_KEY, JSON.stringify({ ...finalState, lastVerifiedVideoId: '5555', lastVerifiedAt: '2027-01-15T16:30:15.000Z' }));
    const forged = await loadRaffleSelection(h.kv, true, new Date(jan15(10, 31)), seasonEnv, undefined, new SnapshotCache());
    assert.equal(forged.source, 'manual');
});

test('unrelated posts, old videos and unverified broadcasts never replace the featured video', async () => {
    const at = jan15(13, 0);
    const cases = {
        'previous day': [{ id: '6001', published: '2027-01-14T22:00:00+0000' }],
        'older than 2 hours': [{ id: '6002', published: '2027-01-15T16:30:00+0000' }],
        'VOD never observed Live': [{ id: '6003', published: '2027-01-15T18:55:00+0000', live: 'VOD' }],
        'another Page owns it': [{ id: '6004', published: '2027-01-15T18:55:00+0000', owner: '999' }],
        'reel/share link, not a Page video': [{ id: '6005', published: '2027-01-15T18:55:00+0000', link: 'https://www.facebook.com/reel/6005' }],
        'photo post': [{ id: '6006', published: '2027-01-15T18:55:00+0000', type: 'photo' }],
    };
    for (const [name, videos] of Object.entries(cases)) {
        const h = harness(at, { videos });
        const outcome = await h.hint(at);
        assert.ok(['no-eligible-video', 'pending-live-confirmation'].includes(outcome.status), `${name}: ${outcome.status}`);
        assert.equal(JSON.parse(h.kv.data.get(AUTOMATIC_KEY)).id, NOV30, name);
        assert.equal((await h.show(at + 2000)).config.latestVideoUrl, url(NOV30), name);
    }
    // Two plausible broadcasts at once are ambiguous: hold, never guess.
    const both = harness(at, { videos: [{ id: '7001', published: '2027-01-15T18:58:00+0000' }, { id: '7002', published: '2027-01-15T18:59:00+0000' }] });
    assert.equal((await both.hint(at)).status, 'ambiguous-livestream');
    assert.equal(JSON.parse(both.kv.data.get(AUTOMATIC_KEY)).id, NOV30);
});

test('a same-day manual override wins over an off-season automatic selection', async () => {
    const h = harness(jan15(10, 0), { videos: [{ id: '5555', published: '2027-01-15T16:30:05+0000' }],
        manual: { latestVideoUrl: url('888'), updatedAt: '2027-01-15T15:00:00.000Z', selectionMode: 'automatic', automaticEnabled: true, manualOverrideAt: '2027-01-15T15:00:00.000Z', manualOverrideUrl: url('888') } });
    assert.equal((await h.hint(jan15(10, 30, 15))).status, 'staged');
    const shown = await h.show(jan15(10, 30, 17));
    assert.deepEqual([shown.source, shown.reason, shown.config.latestVideoUrl], ['manual', 'manual-override', url('888')]);
});

test('without a webhook nothing checks off-season: stray alarms and cron kicks do no Graph or KV work', async () => {
    const h = harness(jan15(18, 0), { videos: [{ id: '5555', published: '2027-01-16T00:00:05+0000' }] });
    await h.coord.kick();
    assert.equal(h.alarm, null);
    assert.equal((await h.fire(jan15(18, 0, 30))).status, 'outside-drawing-window');
    assert.deepEqual([h.graphCalls.length, h.kvWrites.length], [0, 0]);
});

test('email: an incident raised by an off-window check is emailed immediately by the coordinator, retried with the same key, never duplicated', async () => {
    const h = harness(jan15(10, 0), { alerts: true, graphFails: 10, resend: n => n === 1 ? 500 : 200 }); // permission denied -> access paused
    assert.equal((await h.hint(jan15(10, 30))).status, 'permission-denied');
    assert.equal(h.emails.length, 1); // sent right after the check, no cron involved
    assert.match(h.emails[0].subject, /Facebook Live detection paused/);
    const retryAt = h.alarm;
    assert.ok(retryAt >= jan15(10, 30) + 15_000, 'retry alarm scheduled'); // Resend 500 -> transient retry
    assert.equal((await h.fire(retryAt)).status, 'outside-drawing-window');
    assert.equal(h.emails.length, 2);
    assert.equal(h.emails[1].key, h.emails[0].key); // same idempotency key: Resend deduplicates
    assert.equal(h.alarm, null); // delivered: nothing pending, no more alarms
    // Later hints while still paused raise no second email for the same open incident.
    await h.hint(jan15(11, 0));
    assert.equal(h.emails.length, 2);
});

test('email: inside the 5:50-6:30 PM November window the cron sends; the coordinator takes over at 6:31 PM', async () => {
    const nov12 = (hh, mm, ss = 0) => central(2026, 11, 12, hh, mm, ss);
    assert.equal(inAlertDeliveryWindow(new Date(nov12(18, 30, 59))), true);
    assert.equal(inAlertDeliveryWindow(new Date(nov12(18, 31))), false);
    assert.equal(inAlertDeliveryWindow(new Date(central(2026, 12, 12, 18, 0))), false);
    assert.equal(alertWindowEnd(new Date(nov12(18, 15))), nov12(18, 31));
    const h = harness(nov12(18, 15), { alerts: true, graphFails: 10, receipt: CURRENT_RECEIPT });
    h.kv.data.delete(STATE_KEY); // fixture state is from Nov 30; this drawing has none yet
    await h.coord.kick();
    assert.equal((await h.fire(nov12(18, 15))).status, 'permission-denied'); // last backup slot raises the incident
    assert.equal(h.emails.length, 0); // the cron's job inside the window
    assert.equal(h.alarm, nov12(18, 31)); // safety net if the cron has not sent it by the window's end
    await h.fire(nov12(18, 31));
    assert.equal(h.emails.length, 1);
    assert.equal(h.alarm, null);
});

test('a pending alert-retry alarm never postpones the 5:50 PM backup check', async () => {
    const nov12 = (hh, mm) => central(2026, 11, 12, hh, mm);
    const h = harness(nov12(17, 49), { receipt: CURRENT_RECEIPT });
    // A retry alarm armed for 6:31 PM, through the same storage the coordinator uses.
    await h.coord['storage'].setAlarm(nov12(18, 31));
    h.clock = nov12(17, 50);
    await h.coord.kick();
    assert.equal(h.alarm, nov12(17, 50));
});
