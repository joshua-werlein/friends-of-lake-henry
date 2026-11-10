import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { FACEBOOK_PAGE_ID, RAFFLE_LIVE_KEY, normalizeFacebookVideoUrl, parseLiveConfig, facebookEmbedSrc } from '../src/lib/facebook.ts';
import { AUTOMATIC_KEY, FUNDRAISER_START, FUNDRAISER_END, pollBroadcasts, validateBroadcast } from '../src/lib/server/facebook-automation.ts';
import worker from '../workers/facebook-live/index.ts';
import { GET as publicLiveGet } from '../src/pages/api/raffle/live.ts';
import { GET, POST } from '../src/pages/api/admin/raffle/live.ts';

const canonical = id => `https://www.facebook.com/${FACEBOOK_PAGE_ID}/videos/${id}/`;
const broadcast = (id = '123', startedAt = '2026-11-02T19:00:00Z', status = 'live') => ({
    id, pageId: FACEBOOK_PAGE_ID, url: canonical(id), startedAt, status, isRaffle: true,
});
function store(entries = []) {
    const data = new Map(entries), writes = [];
    return { data, writes, async get(k) { return data.get(k) ?? null; }, async put(k, v) { writes.push(k); data.set(k, v); } };
}
const options = extra => ({ enabled: true, now: new Date('2026-11-03T20:00:00Z'), store: store(),
    source: async () => ({ ok: true, broadcasts: [broadcast()] }), ...extra });
const context = (kv, body) => ({ locals: { runtime: { env: { CONFIG: kv } } },
    request: new Request('https://example.test/api/admin/raffle/live', { method: 'POST', body: JSON.stringify(body) }) });

test('public video timestamp matches SSR formatting after initial load and the next poll; the poll follows the server hint', async () => {
    const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/scripts/raffle-live.ts', import.meta.url))],
        bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022' });
    class Anchor { href = ''; }
    const url = 'https://www.facebook.com/reel/123';
    const nodes = { livePlayer: { dataset: { videoUrl: url } }, facebookFallback: new Anchor(), liveMessage: {}, liveUpdated: {} };
    let poll, interval, hint;
    runInNewContext(compiled.outputFiles[0].text, {
        URL, Intl, Date, AbortSignal, HTMLAnchorElement: Anchor,
        document: { hidden: false, getElementById: id => nodes[id], addEventListener() {} },
        window: { setTimeout(callback, ms) { poll = callback; interval = ms; } },
        fetch: async () => Response.json({ ok: true, presentation: { orientation: 'landscape' }, config: { latestVideoUrl: url, updatedAt: '2026-02-02T19:30:38.607Z' }, ...hint }),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nodes.liveUpdated.textContent, 'Video selected: Feb 2, 2026, 1:30 PM Central');
    assert.equal(interval, 15000);
    assert.equal(nodes.livePlayer.dataset.videoLayout, 'landscape');
    // No DOM replacement methods exist on this mock: an unchanged URL must not reload.
    const tick = async () => { poll(); for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
    hint = { refreshMs: 5000 };
    await tick();
    assert.equal(nodes.liveUpdated.textContent, 'Video selected: Feb 2, 2026, 1:30 PM Central');
    assert.equal(interval, 5000);
    // A malformed or extreme hint can neither poll faster than 5 seconds nor stall the poll.
    for (const [refreshMs, expected] of [[100, 5000], [1e9, 60000], ['x', 15000]]) { hint = { refreshMs }; await tick(); assert.equal(interval, expected); }
});

test('normalizes full video, watch, mobile, tracking, reel and local redirect-wrapper URLs without fetch', () => {
    for (const input of ['https://facebook.com/page/videos/123/?tracking=1', 'http://m.facebook.com/watch/?v=123&x=1',
        'https://www.facebook.com/videos/123', 'https://www.facebook.com/watch/live/?v=123',
        'https://www.facebook.com/live/?v=123', 'https://www.facebook.com/video.php?v=123',
        `https://l.facebook.com/l.php?u=${encodeURIComponent(canonical('123'))}`]) {
        assert.equal(normalizeFacebookVideoUrl(input), canonical('123'));
    }
    assert.equal(normalizeFacebookVideoUrl('https://facebook.com/reel/123/?x=1'), 'https://www.facebook.com/reel/123');
});
test('rejects unsafe, malformed, share and short links without network resolution', () => {
    for (const input of ['javascript:alert(1)', 'https://facebook.com.evil.test/watch?v=123',
        'https://evil.test/facebook.com/videos/123', 'https://user:secret@facebook.com/watch?v=123',
        'https://facebook.com:444/watch?v=123', 'https://fb.watch/abc/', 'https://facebook.com/share/v/abc/',
        'https://facebook.com/watch?v=abc', 'https://facebook.com/page/videos/123/evil', '',
        'https://l.facebook.com/l.php?u=https%3A%2F%2F127.0.0.1%2Fvideos%2F123']) {
        assert.equal(normalizeFacebookVideoUrl(input), null, input);
    }
});
test('legacy KV shape and safe embed URLs for live and replay remain supported', () => {
    const cfg = parseLiveConfig(JSON.stringify({ latestVideoUrl: canonical('123'), updatedAt: '2026-11-02T19:00:00Z' }));
    assert.equal(cfg.latestVideoUrl, canonical('123'));
    assert.match(facebookEmbedSrc(cfg.latestVideoUrl), /plugins\/video.php/);
    assert.match(facebookEmbedSrc('https://facebook.com/reel/123'), /plugins\/post.php/);
    for (const raw of [null, 'broken', 'null', '[]', '{"latestVideoUrl":"javascript:alert(1)"}']) {
        assert.equal(parseLiveConfig(raw).latestVideoUrl, null);
    }
    assert.equal(facebookEmbedSrc('https://evil.test/videos/123'), null);
});
test('admin saves preserve manual fallback and explicitly restore Manual even for duplicate URLs', async () => {
    const kv = store();
    assert.equal((await POST(context(kv, { latestVideoUrl: 'https://facebook.com/watch?v=123' }))).status, 200);
    assert.equal((await (await GET(context(kv))).json()).config.latestVideoUrl, canonical('123'));
    await POST(context(kv, { latestVideoUrl: canonical('123') }));
    assert.deepEqual(kv.writes, [RAFFLE_LIVE_KEY, RAFFLE_LIVE_KEY]);
    assert.equal(JSON.parse(kv.data.get(RAFFLE_LIVE_KEY)).selectionMode, 'manual');
    await POST(context(kv, { latestVideoUrl: '' }));
    assert.equal(parseLiveConfig(kv.data.get(RAFFLE_LIVE_KEY)).latestVideoUrl, null);
    assert.equal(kv.data.has(RAFFLE_LIVE_KEY), true);
});
test('admin rejects malformed bodies and unsupported links without writes', async () => {
    const kv = store();
    for (const body of [null, [], {}, { latestVideoUrl: {} }, { latestVideoUrl: 'https://fb.watch/abc' }]) {
        assert.equal((await POST(context(kv, body))).status, 400);
    }
    assert.equal(kv.writes.length, 0);
    assert.equal((await GET({
        locals: {},
        request: new Request('https://example.test/api/admin/raffle/live')
    })).status, 500);
});
test('broadcast contract validates identity, availability, Page and raffle classification', () => {
    assert.deepEqual(validateBroadcast(broadcast()), broadcast());
    for (const b of [null, {}, { ...broadcast(), pageId: '999' }, { ...broadcast(), id: '999' },
        { ...broadcast(), status: 'scheduled' }, { ...broadcast(), isRaffle: false },
        { ...broadcast(), startedAt: 'yesterday' }, { ...broadcast(), startedAt: '2026-11-02T19:00:00' }]) {
        assert.equal(validateBroadcast(b), null);
    }
});
test('disabled automation and dormant scheduled Worker touch no source or store', async () => {
    assert.deepEqual(await pollBroadcasts({ source() { throw Error('must not call'); } }), { status: 'disabled' });
    await worker.scheduled();
    assert.deepEqual(await pollBroadcasts(options({ source: undefined })), { status: 'unverified-source' });
});
test('manual URL, cleared value and malformed legacy record all block automatic polling', async () => {
    for (const raw of [JSON.stringify({ latestVideoUrl: canonical('123') }), JSON.stringify({ latestVideoUrl: null }), 'bad']) {
        const kv = store([[RAFFLE_LIVE_KEY, raw]]);
        assert.deepEqual(await pollBroadcasts(options({ store: kv, source() { throw Error('must not call'); } })), { status: 'manual-override' });
        assert.equal(kv.writes.length, 0);
    }
});
test('new broadcast stages once; duplicate IDs, tracking and live-to-replay transition do not rewrite', async () => {
    const kv = store();
    assert.equal((await pollBroadcasts(options({ store: kv }))).status, 'updated');
    const replay = { ...broadcast('123', undefined, 'replay'), url: canonical('123') + '?tracking=1' };
    assert.equal((await pollBroadcasts(options({ store: kv, source: async () => ({ ok: true, broadcasts: [replay, replay] }) }))).status, 'unchanged');
    assert.deepEqual(kv.writes, [AUTOMATIC_KEY]);
    assert.equal(kv.data.has(RAFFLE_LIVE_KEY), false);
});
test('new recorded replay is selected, response order cannot regress to an older drawing', async () => {
    const kv = store([[AUTOMATIC_KEY, JSON.stringify(broadcast())]]);
    const replay = broadcast('456', '2026-11-03T19:00:00Z', 'replay');
    assert.equal((await pollBroadcasts(options({ store: kv, source: async () => ({ ok: true, broadcasts: [broadcast(), replay] }) }))).status, 'updated');
    assert.equal(JSON.parse(kv.data.get(AUTOMATIC_KEY)).id, '456');
    assert.equal((await pollBroadcasts(options({ store: kv }))).status, 'unchanged');
});
test('normalized token expiration, rate limit, API failures and unavailable videos preserve last good value', async () => {
    const kv = store([[AUTOMATIC_KEY, JSON.stringify(broadcast())]]);
    for (const reason of ['token-expired', 'rate-limited', 'api-failure', 'unavailable']) {
        assert.equal((await pollBroadcasts(options({ store: kv, source: async () => ({ ok: false, reason }) }))).status, reason);
    }
    assert.equal((await pollBroadcasts(options({ store: kv, source: async () => { throw Error('secret sentinel'); } }))).status, 'api-failure');
    assert.equal(kv.writes.length, 0);
});
test('empty, malformed, future and pre-fundraiser responses never clear or replace a selection', async () => {
    const kv = store();
    for (const [broadcasts, expected] of [[[], 'empty'], [null, 'invalid-response'], [[broadcast(), {}], 'invalid-response'],
        [[broadcast('123', '2026-11-20T00:00:00Z')], 'empty'], [[broadcast('123', '2026-10-31T20:00:00Z')], 'empty']]) {
        assert.equal((await pollBroadcasts(options({ store: kv, source: async () => ({ ok: true, broadcasts }) }))).status, expected);
    }
    assert.equal(kv.writes.length, 0);
});
test('five-minute default interval, configurable interval and Chicago fundraiser boundaries', async () => {
    const time = Date.parse('2026-11-03T20:00:00Z');
    assert.equal((await pollBroadcasts(options({ lastAttemptAt: time - 299000 }))).status, 'not-due');
    assert.equal((await pollBroadcasts(options({ lastAttemptAt: time - 300000 }))).status, 'updated');
    assert.equal((await pollBroadcasts(options({ pollIntervalSeconds: 600, lastAttemptAt: time - 300000 }))).status, 'not-due');
    assert.equal((await pollBroadcasts(options({ pollIntervalSeconds: 0 }))).status, 'disabled');
    for (const now of [new Date(Date.parse(FUNDRAISER_START) - 1), new Date(FUNDRAISER_END)]) {
        assert.equal((await pollBroadcasts(options({ now }))).status, 'outside-window');
    }
    assert.equal((await pollBroadcasts(options({ now: new Date(FUNDRAISER_START), source: async () => ({ ok: true, broadcasts: [] }) }))).status, 'empty');
});
test('storage errors and an override saved during discovery fail safely', async () => {
    assert.equal((await pollBroadcasts(options({ store: { async get() { throw Error('kv'); } } }))).status, 'storage-failure');
    const kv = store();
    const source = async () => { kv.data.set(RAFFLE_LIVE_KEY, '{}'); return { ok: true, broadcasts: [broadcast()] }; };
    assert.equal((await pollBroadcasts(options({ store: kv, source }))).status, 'manual-override');
    assert.equal(kv.writes.length, 0);
});

test('public live selection is read-only, uncached, resilient and ignores automatic staging', async () => {
    const kv = store([[RAFFLE_LIVE_KEY, JSON.stringify({ latestVideoUrl: canonical('123') })],
        [AUTOMATIC_KEY, JSON.stringify(broadcast('456'))]]);
    const response = await publicLiveGet(context(kv));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).config.latestVideoUrl, canonical('123'));
    kv.data.set(RAFFLE_LIVE_KEY, JSON.stringify({ latestVideoUrl: canonical('789') }));
    assert.equal((await (await publicLiveGet(context(kv))).json()).config.latestVideoUrl, canonical('789'));
    kv.data.set(RAFFLE_LIVE_KEY, JSON.stringify({ latestVideoUrl: null }));
    assert.equal((await (await publicLiveGet(context(kv))).json()).config.latestVideoUrl, null);
    assert.deepEqual(kv.writes, []);
    assert.equal((await publicLiveGet({ locals: {} })).status, 503);
    assert.equal((await publicLiveGet(context({ get() { throw Error('private failure'); } }))).status, 503);
});
