import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { discoverPosts, extractCandidates, verifyVideo, GRAPH_PAGE_ID, PUBLIC_PAGE_ID, GRAPH_VERSION, LIVE_CONTRACT, POST_FIELDS } from '../workers/facebook-live/graph.ts';
import { runPoll, STATE_KEY, VERIFICATION_KEY, verificationValid } from '../workers/facebook-live/poller.ts';
import worker from '../workers/facebook-live/index.ts';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { checkDeployment } from '../workers/facebook-live/check-deployment.mjs';

// Entirely simulated data and fetch. These are NOT captured or verified real Live responses.
const fixture = JSON.parse(await readFile(new URL('./fixtures/facebook-page-posts.json', import.meta.url), 'utf8'));
const clone = x => structuredClone(x);
const now = new Date('2026-11-02T00:05:00Z');
const marker = '#LakeHenryRaffle';
const candidate = extractCandidates(fixture.data, marker, now)[0];
const metadata = (id = candidate.videoId, extra = {}) => ({ id, from: { id: GRAPH_PAGE_ID }, live_status: id === candidate.videoId ? 'LIVE' : 'VOD', published: true, embeddable: true, ...extra });
const receipt = extra => JSON.stringify({ schemaVersion: 1, graphPageId: GRAPH_PAGE_ID, publicPageId: PUBLIC_PAGE_ID,
    apiVersion: GRAPH_VERSION, contract: LIVE_CONTRACT, verifiedVideoId: candidate.videoId,
    verifiedAt: '2026-11-02T00:00:00Z', expiresAt: '2026-12-01T06:00:00Z', ...extra });
function store(entries = []) {
    const data = new Map(entries), writes = [];
    return { data, writes, async get(key) { return data.get(key) ?? null; }, async put(key, value) { writes.push(key); data.set(key, value); } };
}
const envFor = kv => ({ CONFIG: kv, FB_AUTOMATION_ENABLED: 'true', FB_VIDEO_PROBE_ENABLED: 'true',
    FB_GRAPH_PAGE_ID: GRAPH_PAGE_ID, FB_PUBLIC_PAGE_ID: PUBLIC_PAGE_ID,
    FB_RAFFLE_MARKER: marker, FB_PAGE_ACCESS_TOKEN: 'SIMULATED_TEST_TOKEN', FB_ACCESS_REVISION: '1' });
function api({ posts = fixture, video = id => metadata(id), failure, identity = GRAPH_PAGE_ID } = {}) {
    const calls = [];
    const fetcher = async (input, init) => {
        const url = new URL(input);
        calls.push({ url, init });
        assert.equal(url.origin, 'https://graph.facebook.com');
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');
        assert.equal(init.headers.Authorization, 'Bearer SIMULATED_TEST_TOKEN');
        assert.equal(url.searchParams.has('access_token'), false);
        if (failure) return failure(url);
        const id = url.pathname.split('/').at(-1);
        return Response.json(id === GRAPH_PAGE_ID ? { id: identity } : id === 'published_posts'
            ? typeof posts === 'function' ? posts(url) : posts : video(id));
    };
    return { fetcher, calls };
}
const discover = options => discoverPosts({ token: 'SIMULATED_TEST_TOKEN', marker, now, ...options });

test('realistic Page posts produce candidates, never infer Live from caption/type/status_type', async () => {
    const mock = api();
    const result = await discover({ fetcher: mock.fetcher });
    assert.equal(result.ok, true);
    assert.equal(result.candidates, 2);
    assert.deepEqual(result.discoveries, []);
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[1].url.pathname, `/v26.0/${GRAPH_PAGE_ID}/published_posts`);
    assert.equal(mock.calls[1].url.searchParams.get('fields'), POST_FIELDS);
    assert.equal(mock.calls.some(c => c.url.pathname.includes('live_videos')), false);
});

test('metadata probe requires positive ownership, explicit Live state and public embed eligibility', async () => {
    const mock = api();
    const result = await discover({ fetcher: mock.fetcher, probeVideoMetadata: true });
    assert.equal(result.ok, true);
    assert.equal(result.discoveries.length, 1);
    assert.equal(result.discoveries[0].url, `https://www.facebook.com/${PUBLIC_PAGE_ID}/videos/${candidate.videoId}/`);
    for (const changes of [{ live_status: 'VOD' }, { live_status: 'live' }, { live_status: null },
        { from: { id: PUBLIC_PAGE_ID } }, { from: { id: '999' } }, { from: null },
        { id: '999' }, { published: false }, { embeddable: false }, { embeddable: undefined }]) {
        assert.equal(verifyVideo(candidate, metadata(candidate.videoId, changes)), null);
    }
    assert.equal(verifyVideo(candidate, metadata(candidate.videoId, { live_status: 'LIVE_STOPPED' })).status, 'replay');
});

test('rejects unrelated, foreign-page, future, invalid-date, reel, share and foreign-host candidates', () => {
    const original = fixture.data[0];
    const variants = [
        { message: 'ordinary live raffle drawing' },
        { message: `${marker}2026` }, { message: `prefix${marker}` }, { id: '999_123' },
        { created_time: '2026-11-20T18:00:00-0600' }, { created_time: '2026-11-31T18:00:00-0600' },
        { attachments: { data: [{ type: 'photo', target: { id: candidate.videoId, url: `https://facebook.com/watch?v=${candidate.videoId}` } }] } },
        ...[`https://facebook.com/reel/${candidate.videoId}`, 'https://facebook.com/share/v/abc',
            `https://evil.test/videos/${candidate.videoId}`, 'https://facebook.com/groups/123/posts/456'].map(url => ({ attachments: { data: [{ type: 'video_inline', target: { id: candidate.videoId, url } }] } })),
    ];
    for (const changes of variants) assert.equal(extractCandidates([{ ...original, ...changes }], marker, now).length, 0);
    const nested = clone(original);
    nested.attachments = { data: [{ type: 'album', subattachments: original.attachments }] };
    assert.equal(extractCandidates([original, nested], marker, now).length, 1);
});

test('rebuilds bounded pagination from cursors, never sends token to a paging URL', async () => {
    const mock = api({ posts: url => url.searchParams.has('after') ? fixture : { data: [], paging: {
        next: 'https://evil.test/steal?access_token=DO_NOT_FOLLOW', cursors: { after: 'SAFE_CURSOR' } } } });
    const result = await discover({ fetcher: mock.fetcher });
    assert.equal(result.ok, true);
    assert.equal(mock.calls.length, 3);
    assert.equal(mock.calls[2].url.searchParams.get('after'), 'SAFE_CURSOR');
    const looping = api({ posts: { data: [], paging: { next: 'anything', cursors: { after: 'repeat' } } } });
    assert.deepEqual(await discover({ fetcher: looping.fetcher }), { ok: false, reason: 'invalid-response' });
    const endless = api({ posts: url => ({ data: [], paging: { next: 'anything', cursors: { after: (url.searchParams.get('after') ?? '') + 'a' } } }) });
    assert.equal((await discover({ fetcher: endless.fetcher })).ok, true);
    assert.equal(endless.calls.length, 4); // identity plus maximum three post pages
});

test('normalizes Graph permission, expired-token, rate-limit and unsupported-field errors without leaks', async () => {
    for (const [code, reason] of [[10, 'permission-denied'], [200, 'permission-denied'], [283, 'permission-denied'],
        [190, 'token-expired'], [4, 'rate-limited'], [17, 'rate-limited'], [613, 'rate-limited'], [80001, 'rate-limited'], [100, 'unsupported-contract']]) {
        const mock = api({ failure: () => Response.json({ error: { code, message: 'SIMULATED_TEST_TOKEN private message', fbtrace_id: 'private' } }, { status: 400 }) });
        const result = await discover({ fetcher: mock.fetcher });
        assert.deepEqual(result, { ok: false, reason });
        assert.equal(JSON.stringify(result).includes('SIMULATED_TEST_TOKEN'), false);
    }
    const http429 = api({ failure: () => new Response('Not JSON', { status: 429, headers: { 'Retry-After': '1200' } }) });
    assert.deepEqual(await discover({ fetcher: http429.fetcher }), { ok: false, reason: 'rate-limited', retryAfterSeconds: 1200 });
    assert.deepEqual(await discover({ fetcher: async () => { throw Error('SIMULATED_TEST_TOKEN'); } }), { ok: false, reason: 'api-failure' });
});

test('fails closed on malformed/oversized JSON, wrong Graph identity and metadata field errors', async () => {
    for (const response of [new Response('invalid'), Response.json([]), new Response('x'.repeat(512 * 1024 + 1)),
        new Response('{}', { headers: { 'Content-Length': String(512 * 1024 + 1) } })]) {
        assert.deepEqual(await discover({ fetcher: async () => response }), { ok: false, reason: 'invalid-response' });
    }
    assert.deepEqual(await discover({ fetcher: api({ identity: PUBLIC_PAGE_ID }).fetcher }), { ok: false, reason: 'identity-mismatch' });
    const mock = api({ video: () => ({ error: { code: 100, message: 'Field unsupported' } }) });
    assert.deepEqual(await discover({ fetcher: mock.fetcher, probeVideoMetadata: true }), { ok: false, reason: 'unsupported-contract' });
});

test('disabled Worker, no public trigger, missing token/config and fundraiser window never call Graph', async () => {
    const kv = store();
    const deps = { now, fetcher() { throw Error('must not call'); } };
    assert.equal((await runPoll()).status, 'disabled');
    await worker.scheduled();
    assert.equal(worker.fetch().status, 404);
    assert.equal((await runPoll({ ...envFor(kv), FB_PAGE_ACCESS_TOKEN: undefined }, deps)).status, 'missing-token');
    assert.equal((await runPoll({ ...envFor(kv), FB_GRAPH_PAGE_ID: PUBLIC_PAGE_ID }, deps)).status, 'configuration-error');
    assert.equal((await runPoll({ ...envFor(kv), FB_POLL_INTERVAL_SECONDS: '1' }, deps)).status, 'configuration-error');
    for (const outside of ['2026-11-01T04:59:59Z', '2026-12-01T06:00:00Z']) {
        assert.equal((await runPoll(envFor(kv), { ...deps, now: new Date(outside) })).status, 'outside-window');
    }
    assert.deepEqual(kv.writes, []);
});

test('without real-broadcast verification, observations/probes cannot stage a discovery', async () => {
    for (const probe of ['false', 'true']) {
        const kv = store();
        const mock = api();
        const result = await runPoll({ ...envFor(kv), FB_VIDEO_PROBE_ENABLED: probe }, { now, fetcher: mock.fetcher });
        assert.equal(result.status, probe === 'true' ? 'verification-required' : 'candidates-only');
        assert.equal(kv.data.has('raffle_live_automatic'), false);
        assert.equal(kv.writes.every(k => k === STATE_KEY), true);
    }
    assert.equal(verificationValid(receipt({ apiVersion: 'v25.0' }), now), false);
    assert.equal(verificationValid(receipt({ graphPageId: PUBLIC_PAGE_ID }), now), false);
    assert.equal(verificationValid(receipt({ expiresAt: now.toISOString() }), now), false);
    assert.equal(verificationValid(receipt({ verifiedAt: '2026-11-20T00:00:00Z' }), now), false);
});

test('verified simulation stages only automatic key, preserving manual URL, deliberate blank and malformed records', async () => {
    for (const manual of [JSON.stringify({ latestVideoUrl: 'manual', updatedAt: 'keep' }), '{"latestVideoUrl":null}', 'malformed']) {
        const kv = store([['raffle_live', manual], [VERIFICATION_KEY, receipt()]]);
        assert.equal((await runPoll(envFor(kv), { now, fetcher: api().fetcher })).status, 'staged');
        const stage = JSON.parse(kv.data.get('raffle_live_automatic'));
        assert.equal(stage.schemaVersion, 2);
        assert.equal(stage.graphPageId, GRAPH_PAGE_ID);
        assert.equal(stage.publicPageId, PUBLIC_PAGE_ID);
        assert.equal(stage.publishedAt, candidate.publishedAt);
        assert.equal('startedAt' in stage, false); // Post publication is NOT broadcast start time.
        assert.equal(kv.data.get('raffle_live'), manual);
        assert.equal(kv.writes.includes('raffle_live'), false);
        assert.equal(JSON.stringify([...kv.data]).includes('SIMULATED_TEST_TOKEN'), false);
    }
});

test('five-minute state, duplicate writes, live-to-replay transition and stale response protection', async () => {
    const kv = store([[VERIFICATION_KEY, receipt()]]), env = envFor(kv);
    assert.equal((await runPoll(env, { now, fetcher: api().fetcher })).status, 'staged');
    assert.equal((await runPoll(env, { now, fetcher() { throw Error('must not call'); } })).status, 'not-due');
    const later = minutes => new Date(now.getTime() + minutes * 60000);
    assert.equal((await runPoll(env, { now: later(5), fetcher: api().fetcher })).status, 'unchanged');
    assert.equal(kv.writes.filter(k => k === 'raffle_live_automatic').length, 1);
    const replay = api({ video: id => metadata(id, { live_status: id === candidate.videoId ? 'LIVE_STOPPED' : 'VOD' }) });
    assert.equal((await runPoll(env, { now: later(10), fetcher: replay.fetcher })).status, 'staged');
    assert.equal(JSON.parse(kv.data.get('raffle_live_automatic')).status, 'replay');
    assert.equal((await runPoll(env, { now: later(15), fetcher: api().fetcher })).status, 'unchanged');
    const old = clone(fixture); old.data[0].created_time = '2026-10-30T18:00:00-0500';
    assert.equal((await runPoll(env, { now: later(20), fetcher: api({ posts: old }).fetcher })).status, 'no-verified-live');
    assert.equal(JSON.parse(kv.data.get('raffle_live_automatic')).status, 'replay');
});

test('permissions/expiry pause until access revision changes; rate limits persist Retry-After backoff', async () => {
    const kv = store([[VERIFICATION_KEY, receipt()]]), env = envFor(kv);
    const denied = api({ failure: () => Response.json({ error: { code: 190 } }, { status: 400 }) });
    assert.equal((await runPoll(env, { now, fetcher: denied.fetcher })).status, 'token-expired');
    assert.equal((await runPoll(env, { now: new Date(now.getTime() + 86400000), fetcher() { throw Error('must not call'); } })).status, 'access-paused');
    assert.equal((await runPoll({ ...env, FB_ACCESS_REVISION: '2' }, { now, fetcher: api().fetcher })).status, 'staged');
    const rateStore = store();
    const limited = api({ failure: () => Response.json({ error: { code: 80001 } }, { status: 429, headers: { 'Retry-After': '1800' } }) });
    assert.equal((await runPoll(envFor(rateStore), { now, fetcher: limited.fetcher, random: () => 0 })).status, 'rate-limited');
    assert.equal(JSON.parse(rateStore.data.get(STATE_KEY)).nextAttemptAt, now.getTime() + 1800000);
    assert.equal((await runPoll(envFor(rateStore), { now: new Date(now.getTime() + 300000), fetcher() { throw Error('must not call'); } })).status, 'not-due');
});

test('storage failures/corrupt staged data preserve manual and previous stage; no credential leakage', async () => {
    assert.equal((await runPoll(envFor({ async get() { throw Error('private'); } }), { now })).status, 'storage-or-state-failure');
    const kv = store([[VERIFICATION_KEY, receipt()], ['raffle_live_automatic', 'malformed'], ['raffle_live', 'manual']]);
    assert.equal((await runPoll(envFor(kv), { now, fetcher: api().fetcher })).status, 'storage-or-state-failure');
    assert.equal(kv.data.get('raffle_live_automatic'), 'malformed');
    assert.equal(kv.data.get('raffle_live'), 'manual');
    const broken = store(); broken.put = async () => { throw Error('private'); };
    const mock = api();
    assert.equal((await runPoll(envFor(broken), { now, fetcher: mock.fetcher })).status, 'storage-or-state-failure');
    assert.equal(mock.calls.length, 0);
});

test('isolated manifest has no account, active Cron, public route, production IDs or secret value', async () => {
    const config = JSON.parse(await readFile(new URL('../workers/facebook-live/wrangler.json', import.meta.url), 'utf8'));
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert.deepEqual(config.triggers.crons, []);
    assert.equal(config.vars.FB_AUTOMATION_ENABLED, 'false');
    assert.equal(config.vars.FB_VIDEO_PROBE_ENABLED, 'false');
    for (const key of ['account_id', 'routes', 'd1_databases', 'r2_buckets', 'env']) assert.equal(key in config, false);
    assert.equal('FB_PAGE_ACCESS_TOKEN' in config.vars, false);
    assert.deepEqual(config.kv_namespaces, [{ binding: 'CONFIG', id: '0'.repeat(32) }]);
});

test('offline deployment preflight rejects placeholder, existing account/binding and enabled Cron', async () => {
    const config = JSON.parse(await readFile(new URL('../workers/facebook-live/wrangler.json', import.meta.url), 'utf8'));
    assert.throws(() => checkDeployment(config, undefined));
    assert.throws(() => checkDeployment(config, 'aa86268490e681cccb3a41a62093e2aa'));
    const ready = { ...config, account_id: '1'.repeat(32), kv_namespaces: [{ binding: 'CONFIG', id: '2'.repeat(32) }] };
    assert.equal(checkDeployment(ready, '1'.repeat(32)), true);
    assert.throws(() => checkDeployment({ ...ready, kv_namespaces: config.kv_namespaces }, '1'.repeat(32)));
    assert.throws(() => checkDeployment({ ...ready, kv_namespaces: [{ binding: 'CONFIG', id: 'b70df87ff3db4230a621d4a39ab24ff7' }] }, '1'.repeat(32)));
    assert.throws(() => checkDeployment({ ...ready, triggers: { crons: ['*/5 * * * *'] } }, '1'.repeat(32)));
});

test('explicit existing-approved profile pins existing account and production CONFIG while retaining disabled-only guard', async () => {
    const config = JSON.parse(await readFile(new URL('../workers/facebook-live/wrangler.existing-account.json', import.meta.url), 'utf8'));
    const account = 'aa86268490e681cccb3a41a62093e2aa';
    assert.equal(checkDeployment(config, account, 'existing-approved'), true);
    assert.throws(() => checkDeployment(config, account));
    assert.throws(() => checkDeployment(config, '1'.repeat(32), 'existing-approved'));
    for (const change of [{ account_id: '1'.repeat(32) }, { kv_namespaces: [{ binding: 'CONFIG', id: '2'.repeat(32) }] },
        { triggers: { crons: ['*/5 * * * *'] } }, { routes: ['example.test/*'] },
        { vars: { ...config.vars, FB_AUTOMATION_ENABLED: 'true' } },
        { vars: { ...config.vars, FB_VIDEO_PROBE_ENABLED: 'true' } },
        { vars: { ...config.vars, FB_PAGE_ACCESS_TOKEN: 'FORBIDDEN_SIMULATION' } }]) {
        assert.throws(() => checkDeployment({ ...config, ...change }, account, 'existing-approved'));
    }
});

test('future-year season can poll with the reusable hashtag; invalid/outside seasons never call Graph', async () => {
    const season = { FB_SEASON_START: '2027-11-01T00:00:00-05:00', FB_SEASON_END: '2027-12-01T00:00:00-06:00' };
    const posts = clone(fixture);
    for (const post of posts.data) if (post.created_time) post.created_time = post.created_time.replace('2026-', '2027-');
    const kv = store([[VERIFICATION_KEY, receipt({ verifiedAt: '2027-11-02T00:00:00Z', expiresAt: '2027-12-01T06:00:00Z' })]]);
    const futureNow = new Date('2027-11-02T00:05:00Z');
    assert.equal((await runPoll({ ...envFor(kv), ...season }, { now: futureNow, fetcher: api({ posts }).fetcher })).status, 'staged');
    assert.equal((await runPoll({ ...envFor(store()), ...season, FB_SEASON_START: 'bad' }, { now, fetcher() { throw Error('must not call'); } })).status, 'configuration-error');
    assert.equal((await runPoll({ ...envFor(store()), ...season }, { now, fetcher() { throw Error('must not call'); } })).status, 'outside-window');
});

test('repeated verified Live renews health without changing selection timestamp, and permission loss disables health', async () => {
    const kv = store([[VERIFICATION_KEY, receipt()]]), env = envFor(kv);
    await runPoll(env, { now, fetcher: api().fetcher });
    const first = kv.data.get('raffle_live_automatic');
    const later = new Date(now.getTime() + 15 * 60000);
    assert.equal((await runPoll(env, { now: later, fetcher: api().fetcher })).status, 'unchanged');
    assert.equal(kv.data.get('raffle_live_automatic'), first);
    assert.equal(JSON.parse(kv.data.get(STATE_KEY)).lastVerifiedAt, later.toISOString());
    const denied = api({ failure: () => Response.json({ error: { code: 10 } }, { status: 400 }) });
    await runPoll(env, { now: new Date(later.getTime() + 300000), fetcher: denied.fetcher });
    assert.equal(JSON.parse(kv.data.get(STATE_KEY)).paused, true);
    assert.equal(kv.data.get('raffle_live_automatic'), first);
});

test('a manual save racing discovery survives, and a newer staged drawing cannot be replaced by an older one', async () => {
    const kv = store([[VERIFICATION_KEY, receipt()], ['raffle_live', 'original']]);
    const mock = api();
    const racingFetch = async (url, init) => {
        if (new URL(url).pathname.endsWith('/published_posts')) kv.data.set('raffle_live', 'manual override during poll');
        return mock.fetcher(url, init);
    };
    assert.equal((await runPoll(envFor(kv), { now, fetcher: racingFetch })).status, 'staged');
    assert.equal(kv.data.get('raffle_live'), 'manual override during poll');
    const newer = JSON.parse(kv.data.get('raffle_live_automatic'));
    newer.id = newer.videoId = '730000000000099';
    newer.url = `https://www.facebook.com/${PUBLIC_PAGE_ID}/videos/${newer.id}/`;
    newer.publishedAt = '2026-11-02T00:04:00Z';
    kv.data.set('raffle_live_automatic', JSON.stringify(newer));
    assert.equal((await runPoll(envFor(kv), { now: new Date(now.getTime() + 300000), fetcher: api().fetcher })).status, 'unchanged');
    assert.equal(JSON.parse(kv.data.get('raffle_live_automatic')).id, newer.id);
});

test('bundled Worker runs in workerd; disabled scheduled entry is inert and HTTP cannot trigger polling', async t => {
    const compiled = await build({ stdin: { contents: `import worker from './workers/facebook-live/index.ts';
        export default { async fetch(request, env) { await worker.scheduled({}, env); return worker.fetch(); } };`,
        resolveDir: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') },
        bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
    const mf = new Miniflare({ modules: true, script: compiled.outputFiles[0].text,
        kvNamespaces: ['CONFIG'], kvPersist: false, bindings: { FB_AUTOMATION_ENABLED: 'false' } });
    t.after(() => mf.dispose());
    assert.equal((await mf.dispatchFetch('https://example.test/run', { method: 'POST' })).status, 404);
    const kv = await mf.getKVNamespace('CONFIG');
    assert.deepEqual((await kv.list()).keys, []);
});
