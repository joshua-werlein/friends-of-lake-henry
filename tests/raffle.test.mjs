import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { GET as adminGet, POST as winnersPost } from '../src/pages/api/admin/raffle/winners.ts';
import { GET as monthGet } from '../src/pages/api/raffle/month.ts';
import { GET as posterGet } from '../src/pages/api/raffle/poster.ts';
import { POST as posterPost } from '../src/pages/api/admin/raffle/poster.ts';

test('November title, poster, winner and history workflow against local D1/R2', async t => {
    // Isolated in-memory emulator. No Wrangler config, accounts, remote bindings or production data.
    const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("test"); } }',
        d1Databases: ['DB'], r2Buckets: ['PHOTOS_BUCKET'], d1Persist: false, r2Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    const PHOTOS_BUCKET = await mf.getR2Bucket('PHOTOS_BUCKET');
    for (const file of ['../migrations/001_schema.sql', '../migrations/migrations/00x_raffle_poster.sql']) {
        const sql = (await readFile(new URL(file, import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');
        for (const statement of sql.split(';').filter(s => s.trim())) await DB.prepare(statement).run();
    }
    const locals = { runtime: { env: { DB, PHOTOS_BUCKET } } };
    const ctx = (path, body) => ({ locals, url: new URL('https://example.test' + path),
        request: new Request('https://example.test' + path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const post = body => winnersPost(ctx('/api/admin/raffle/winners', body));
    const month = async key => (await monthGet(ctx('/api/raffle/month?month=' + key))).json();

    const monthKey = '2026-11';
    const form = new FormData();
    form.set('monthKey', monthKey);
    form.set('alt', 'November 2026 fundraiser poster');
    form.set('poster', new File([new Uint8Array([137, 80, 78, 71])], 'poster.png', { type: 'image/png' }));
    const uploadContext = ctx('/api/admin/raffle/poster');
    uploadContext.request = new Request(uploadContext.url, { method: 'POST', body: form });
    assert.match((await posterPost(uploadContext)).headers.get('location'), /ok=poster/);
    await DB.prepare('UPDATE raffle_months SET rules_json = ? WHERE month_key = ?').bind('["Keep rules"]', monthKey).run();
    assert.equal((await post({ action: 'setMeta', raffleKey: monthKey, title: 'November fundraiser' })).status, 200);
    const before = await DB.prepare('SELECT * FROM raffle_months WHERE month_key = ?').bind(monthKey).first();

    await t.test('regression: clearing title preserves poster, rules and creation time', async () => {
        assert.equal((await post({ action: 'setMeta', raffleKey: monthKey, title: '  ' })).status, 200);
        const after = await DB.prepare('SELECT * FROM raffle_months WHERE month_key = ?').bind(monthKey).first();
        assert.ok(after);
        assert.equal(after.title, '');
        for (const key of ['poster_key', 'poster_alt', 'rules_json', 'created_at']) assert.equal(after[key], before[key]);
        const publicMonth = await month(monthKey);
        assert.equal(publicMonth.raffleTitle, null);
        assert.equal(publicMonth.rafflePosterUrl, '/api/raffle/poster?month=2026-11');
        const image = await posterGet(ctx('/api/raffle/poster?month=2026-11'));
        assert.equal(image.status, 200);
        assert.equal(image.headers.get('content-type'), 'image/png');
        assert.equal((await image.arrayBuffer()).byteLength, 4);
    });
    await t.test('clearing nonexistent month does not create it; setting title keeps poster', async () => {
        await post({ action: 'setMeta', raffleKey: '2026-10', title: '' });
        assert.equal(await DB.prepare('SELECT * FROM raffle_months WHERE month_key = ?').bind('2026-10').first(), null);
        await post({ action: 'setMeta', raffleKey: monthKey, title: 'November 2026' });
        assert.equal((await month(monthKey)).rafflePosterAlt, 'November 2026 fundraiser poster');
    });
    await t.test('daily entries, duplicate protection, old history and month navigation', async () => {
        const winner = { drawDate: '2026-11-01', ticketNumber: 42, name: 'Test Winner', town: 'Blair' };
        assert.equal((await post(winner)).status, 200);
        assert.equal((await post(winner)).status, 409);
        assert.equal((await post({ ...winner, drawDate: '2026-11-02' })).status, 200);
        assert.equal((await post({ ...winner, drawDate: '2025-11-01' })).status, 200);
        assert.equal((await post({ ...winner, drawDate: '2026-11-31' })).status, 400);
        const data = await month(monthKey);
        assert.deepEqual(data.winners.map(w => w.drawDate), ['2026-11-02', '2026-11-01']);
        assert.equal(data.prevMonthKey, '2026-10');
        assert.equal(data.nextMonthKey, '2026-12');
        assert.ok(data.months.some(m => m.key === '2025-11'));
        assert.ok(data.months.some(m => m.key === monthKey));
        const admin = await (await adminGet(ctx('/api/admin/raffle/winners?raffleKey=2026-11&includeMeta=1'))).json();
        assert.equal(admin.meta.title, 'November 2026');
        assert.equal(admin.winners.length, 2);
        assert.equal((await month('2025-11')).winners.length, 1);
    });
});
