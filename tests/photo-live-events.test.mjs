// Release B, Photo Worker side: the signed webhook forwards sanitized Live/video facts to the Live Worker.
// Photo queueing, extraction and deduplication are untouched; these tests pin the forwarding contract only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { webhookLiveEvents, liveEventSummary, webhookLiveHint, webhookPostIds, LIVE_EVENT_LIMIT } from '../workers/facebook-photos/webhook.ts';

const contract = JSON.parse(readFileSync(new URL('./fixtures/live-webhook-events.json', import.meta.url), 'utf8'));
const SECRET = 'test-only-app-secret';
// The real Photo Worker in workerd. ?mode= picks the Live binding stub: new (records args), old (one-arg notify), fail.
let mf;
async function photoWorker(t) {
    if (mf) return mf;
    const bundle = await build({ stdin: { resolveDir: process.cwd(), sourcefile: 'photo-live-events-wrapper.ts', contents: `
        import photos from './workers/facebook-photos/index.ts';
        export default { async fetch(request, _env, ctx) {
            const mode = new URL(request.url).searchParams.get('mode') ?? 'new';
            const logs = [], calls = [], log = console.log; console.log = line => logs.push(String(line));
            const live = mode === 'old' ? { async notify(id) { calls.push([id]); return { accepted: true }; } }
                : mode === 'fail' ? { async notify() { throw Error('unavailable'); } }
                : { async notify(...args) { calls.push(args); return { accepted: true }; } };
            try {
                const forwarded = new Request('https://test/facebook/webhook', { method: 'POST', body: await request.text(), headers: request.headers });
                const response = await photos.fetch(forwarded, { FB_APP_SECRET: ${JSON.stringify(SECRET)}, FACEBOOK_LIVE: live }, ctx);
                return Response.json({ status: response.status, calls, logs });
            } finally { console.log = log; }
        } };` }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], write: false });
    mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-09-15' });
    t.after(() => { mf?.dispose(); mf = undefined; });
    return mf;
}
const send = async (t, payload, mode = 'new', signature) => { const body = JSON.stringify(payload);
    const sig = signature ?? 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
    return (await (await photoWorker(t)).dispatchFetch('https://test/?mode=' + mode, { method: 'POST', body, headers: { 'x-hub-signature-256': sig } })).json(); };

test('sanitized facts match the shared contract: IDs, codes and key names only', () => {
    const facts = webhookLiveEvents(contract.payload);
    assert.deepEqual(facts, contract.facts);
    const text = JSON.stringify(facts) + liveEventSummary(facts);
    for (const secret of ['PRIVATE CAPTION TEXT', 'Friends of Lake Henry', 'reel/1467167912212118', '<script>', '5555'])
        assert.ok(!text.includes(secret), secret);
    // Unchanged existing parsers: the photo post is still the only queued post, and the payload is still a Live hint.
    assert.deepEqual(webhookPostIds(contract.payload), ['144051422124740_122337900314073310']);
    assert.equal(webhookLiveHint(contract.payload), true);
});

test('fact list is bounded and ignores malformed, foreign and non-video changes', () => {
    const many = { object: 'page', entry: [{ id: '144051422124740', changes: Array.from({ length: 40 }, (_, i) => ({ field: 'live_videos', value: { id: String(1000 + i), status: 'live' } })) }] };
    assert.equal(webhookLiveEvents(many).length, LIVE_EVENT_LIMIT);
    for (const bad of [null, {}, { object: 'user', entry: [] }, { object: 'page', entry: [{ id: '144051422124740', changes: [{ field: 'feed', value: { item: 'photo', verb: 'add' } }, { field: 'feed', value: { item: 'video', verb: 'remove' } }, { field: 'live_videos', value: [] }] }] }])
        assert.deepEqual(webhookLiveEvents(bad), []);
    // A Graph-style numeric id is accepted; a public-Page-id post is normalized to the Graph Page id.
    const facts = webhookLiveEvents({ object: 'page', entry: [{ id: '61552199315213', changes: [{ field: 'feed', value: { item: 'video', verb: 'edited', video_id: 42, post_id: '61552199315213_77' } }] }] });
    assert.deepEqual(facts, [{ field: 'feed', item: 'video', verb: 'edited', videoId: '42', postId: '144051422124740_77', keys: ['item', 'post_id', 'verb', 'video_id'] }]);
});

test('signed webhook forwards the body hash and facts; logs carry no caption text', async t => {
    const payload = { object: 'page', entry: [{ ...contract.payload.entry[0], changes: contract.payload.entry[0].changes.filter(c => c.value.item !== 'photo') }] };
    const r = await send(t, payload);
    assert.equal(r.status, 200);
    assert.equal(r.calls.length, 1);
    assert.match(r.calls[0][0], /^[a-f0-9]{64}$/);
    assert.deepEqual(r.calls[0][1], webhookLiveEvents(payload));
    assert.equal(r.calls[0][1][0].id, '1467167912212118');
    const line = r.logs.find(l => l.includes('"webhook-live-events"'));
    assert.ok(line); assert.ok(line.includes('live_videos:::live:1467167912212118::id+status'), line);
    assert.ok(!r.logs.join(' ').includes('PRIVATE CAPTION TEXT'));
});

test('an older Live Worker that ignores the facts still works; a failed handoff still asks Meta to redeliver; bad signatures forward nothing', async t => {
    const payload = { object: 'page', entry: [{ id: '144051422124740', changes: [contract.payload.entry[0].changes[0]] }] };
    const old = await send(t, payload, 'old');
    assert.equal(old.status, 200); assert.equal(old.calls.length, 1); assert.match(old.calls[0][0], /^[a-f0-9]{64}$/);
    assert.equal((await send(t, payload, 'fail')).status, 503);
    const bad = await send(t, payload, 'new', 'sha256=' + '0'.repeat(64));
    assert.equal(bad.status, 403); assert.equal(bad.calls.length, 0);
});
