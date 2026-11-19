import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import sharp from 'sharp';

const routes = JSON.parse(await readFile('dist/_routes.json', 'utf8'));
assert.ok(routes.include.includes('/*'));
assert.ok(routes.exclude.includes('/_image'));
assert.ok(routes.exclude.includes('/_image/*'));
const files = (await readdir('dist/_worker.js', { recursive: true }))
    .filter(file => /\.(mjs|js)$/.test(file));
for (const file of files) {
    assert.doesNotMatch(file, /(?:[/\\]image-endpoint_|sharp_)/);
    const source = await readFile(`dist/_worker.js/${file}`, 'utf8');
    assert.doesNotMatch(source, /@astrojs\/cloudflare\/dist\/entrypoints\/image-endpoint|astro\/dist\/assets\/endpoint\/generic|import\(['"]sharp['"]\)/);
}

const verifiedTokens = [];
let sentMessages = 0;
async function outboundService(request) {
    if (request.method === 'POST' && request.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
        const token = new URLSearchParams(await request.text()).get('response');
        verifiedTokens.push(token);
        return Response.json({ success: token === 'accepted' });
    }
    if (request.method === 'POST' && request.url === 'https://api.resend.com/emails') {
        sentMessages++;
        return Response.json({ id: 'fixture-email' });
    }
    throw new Error(`Unexpected outbound request: ${request.method} ${request.url}`);
}

const mf = new Miniflare({
    modules: ['index.js', ...files.filter(file => file !== 'index.js')]
        .map(file => ({ type: 'ESModule', path: `dist/_worker.js/${file}` })),
    modulesRoot: 'dist/_worker.js', scriptPath: 'dist/_worker.js/index.js',
    compatibilityDate: '2025-09-15', compatibilityFlags: ['nodejs_compat', 'disable_nodejs_process_v2'],
    d1Databases: ['DB'], kvNamespaces: ['CONFIG', 'SESSION'], r2Buckets: ['PHOTOS_BUCKET'],
    d1Persist: false, kvPersist: false, r2Persist: false, outboundService,
    bindings: {
        ADMIN_USERNAME: 'fixture', ADMIN_PASSWORD: 'fixture-only', TURNSTILE_SECRET: 'fixture-only',
        RESEND_API_KEY: 'fixture-only', FROM_EMAIL: 'from@example.test', TO_EMAIL: 'to@example.test',
    },
    serviceBindings: { ASSETS: () => new Response('fixture asset', { status: 404 }) },
});

try {
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('PHOTOS_BUCKET');
    const kv = await mf.getKVNamespace('SESSION');
    // Match the release's history fixtures. Migration 002 expects legacy donor columns.
    const fixtureMigrations = (await readdir('migrations')).filter(file => /^(001|00[3-8]|010)_.*\.sql$/.test(file));
    fixtureMigrations.splice(1, 0, 'migrations/00x_raffle_poster.sql');
    for (const file of fixtureMigrations) {
        const sql = (await readFile(`migrations/${file}`, 'utf8')).replace(/--[^\n]*/g, '');
        for (const statement of sql.split(';').filter(statement => statement.trim())) {
            await db.prepare(statement).run();
        }
    }

    const origin = 'https://fixture.test';
    const request = (path, options) => mf.dispatchFetch(`${origin}${path}`, { redirect: 'manual', ...options });
    const post = async (path, body, cookie, requestOrigin = origin) => {
        const encoded = new Request(`${origin}${path}`, { method: 'POST', body });
        const headers = new Headers(encoded.headers);
        headers.set('origin', requestOrigin);
        if (cookie) headers.set('cookie', cookie);
        return request(path, { method: 'POST', headers, body: await encoded.arrayBuffer() });
    };
    const getWithCookie = (path, cookie) => request(path, { headers: { cookie } });
    const location = response => response.headers.get('location');

    for (const path of ['/', '/photos', '/photos/submit', '/events', '/raffle', '/contact']) {
        const response = await request(path);
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    }
    for (const path of ['/_image', '/_image?href=/favicon.svg']) {
        assert.equal((await request(path)).status, 404, path);
    }
    assert.equal((await request('/admin')).status, 302);
    const normalizedAdmin = await request('/admin/');
    assert.equal(normalizedAdmin.status, 301);
    assert.equal(new URL(location(normalizedAdmin), origin).pathname, '/admin');
    const login = await post('/api/admin/login', new URLSearchParams({ username: 'fixture', password: 'fixture-only' }));
    const sessionHeader = login.headers.getSetCookie().find(value => value.startsWith('admin_session='));
    assert.match(sessionHeader, /HttpOnly; Secure; SameSite=Strict; Max-Age=28800/);
    const cookie = sessionHeader.split(';')[0];
    const sessionId = cookie.split('=')[1];
    assert.equal((await kv.get(`admin_sess:${sessionId}`, 'json')).role, 'admin');
    const admin = await getWithCookie('/admin/raffle/photo-imports', cookie);
    assert.equal(admin.status, 200);
    assert.equal(admin.headers.get('cache-control'), 'no-store');

    const image = sharp({ create: { width: 8, height: 8, channels: 3, background: '#557744' } });
    const avif = await image.clone().avif().toBuffer();
    const jpeg = await image.clone().jpeg().toBuffer();
    const upload = (token, bytes, type) => {
        const form = new FormData();
        form.set('category', 'Scenery');
        form.set('alt', 'Fixture photo');
        if (token) form.set('cf-turnstile-response', token);
        form.set('photo', new File([bytes], 'fixture-image', { type }));
        return post('/api/photos/submit', form);
    };
    assert.match(location(await upload('', avif, 'image/avif')), /err=captcha$/);
    assert.match(location(await upload('rejected', avif, 'image/avif')), /err=captcha$/);
    assert.match(location(await upload('accepted', Buffer.alloc(8 * 1024 * 1024 + 1), 'image/jpeg')), /err=size$/);
    assert.match(location(await upload('accepted', avif, 'image/avif')), /submitted=1$/);
    assert.match(location(await upload('accepted', jpeg, 'image/jpeg')), /err=rate$/);

    const pending = await db.prepare("SELECT id, r2_key FROM photos WHERE status = 'pending'").first();
    const publicPath = `/api/photos/file?id=${pending.id}`;
    const privatePath = `/api/admin/photos/file?id=${pending.id}`;
    assert.equal((await request(publicPath)).status, 404);
    assert.equal((await request(privatePath)).status, 401);

    async function expectImage(response, mime, bytes, cache) {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), mime);
        assert.equal(response.headers.get('cache-control'), cache);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }

    await expectImage(await getWithCookie(privatePath, cookie), 'image/avif', avif, 'no-store');
    const action = (name, id, requestOrigin) => post(`/api/admin/photos/${name}`,
        new URLSearchParams({ id, category: 'Scenery', alt: 'Fixture photo' }), cookie, requestOrigin);
    assert.equal((await action('approve', pending.id, 'https://other.test')).status, 403);
    assert.match(location(await action('approve', pending.id)), /ok=approved$/);
    assert.equal(await bucket.head(pending.r2_key), null);
    await expectImage(await request(publicPath), 'image/avif', avif, 'public, max-age=3600');
    assert.match(await (await request('/photos')).text(), new RegExp(pending.id));
    assert.match(location(await action('delete', pending.id)), /ok=deleted$/);
    assert.equal((await request(publicPath)).status, 404);

    for (const key of (await kv.list({ prefix: 'throttle:photo_submit:' })).keys) await kv.delete(key.name);
    assert.match(location(await upload('accepted', jpeg, 'image/jpeg')), /submitted=1$/);
    const rejected = await db.prepare("SELECT id, r2_key FROM photos WHERE status = 'pending'").first();
    assert.match(location(await action('reject', rejected.id)), /ok=rejected$/);
    assert.equal(await bucket.head(rejected.r2_key), null);

    await bucket.put('fixture-poster.jpg', Uint8Array.from(jpeg).buffer, { httpMetadata: { contentType: 'image/jpeg' } });
    await db.prepare("INSERT INTO events (id,title,kind,status,date_start,poster_key) VALUES ('fixture-event','Fixture Event','Event','published','2026-11-01T23:00:00Z','fixture-poster.jpg')").run();
    await db.prepare("INSERT INTO raffle_months (month_key,title,poster_key) VALUES ('2026-11','Fixture Raffle','fixture-poster.jpg')").run();
    for (const path of ['/api/events/poster?id=fixture-event', '/api/raffle/poster?month=2026-11']) {
        const response = await request(path);
        assert.ok(response.headers.get('etag'), path);
        await expectImage(response, 'image/jpeg', jpeg, 'public, max-age=86400');
    }
    const contact = new URLSearchParams({ name: 'Fixture', email: 'fixture@example.test', message: 'Fixture contact message' });
    assert.match(location(await post('/api/contact', contact)), /err=captcha$/);
    contact.set('cf-turnstile-response', 'accepted');
    assert.match(location(await post('/api/contact', contact)), /sent=1$/);
    assert.deepEqual(verifiedTokens, ['rejected', 'accepted', 'accepted', 'accepted', 'accepted']);
    assert.equal(sentMessages, 1);
    await post('/api/admin/logout', new URLSearchParams(), cookie);
    assert.equal(await kv.get(`admin_sess:${sessionId}`), null);
    assert.equal((await getWithCookie(privatePath, cookie)).status, 401);
    console.log('Built Pages security smoke passed with fixture D1/KV/R2 and mocked outbound requests.');
} finally {
    await mf.dispose();
}
