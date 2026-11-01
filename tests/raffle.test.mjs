import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { GET as eventsGet } from '../src/pages/api/events/month.ts';
import { POST as donorPost } from '../src/pages/api/admin/donors/index.ts';
import { GET as photoGet } from '../src/pages/api/photos/file.ts';
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
    await t.test('three prizes on Sunday and Thanksgiving, two on Monday, legacy prizes preserved', async () => {
        for (const date of ['2026-11-08', '2026-11-26', '2026-11-09']) {
            for (const place of (date.endsWith('09') ? [2, 1] : [3, 1, 2])) {
                const label = `${place}${place === 1 ? 'st' : place === 2 ? 'nd' : 'rd'} place — Test prize`;
                assert.equal((await post({ drawDate: date, ticketNumber: 100 + place, name: 'Test Winner', town: 'Blair', prize: label })).status, 200);
            }
        }
        const data = await month(monthKey);
        for (const date of ['2026-11-08', '2026-11-26', '2026-11-09']) {
            const winners = data.winners.filter(w => w.drawDate === date);
            assert.deepEqual(winners.map(w => w.prize.slice(0, 3)), date.endsWith('09') ? ['1st', '2nd'] : ['1st', '2nd', '3rd']);
        }
        assert.equal(data.winners.find(w => w.drawDate === '2026-11-01').prize, null);
        const admin = await (await adminGet(ctx('/api/admin/raffle/winners?raffleKey=2026-11'))).json();
        assert.deepEqual(admin.winners.map(w => w.prize), data.winners.map(w => w.prize));
        assert.equal((await post({ drawDate: '2026-11-01', ticketNumber: 1.5, name: 'Test Winner', town: 'Blair' })).status, 400);
    });

    await t.test('event listing, donor entry and approved photo serving remain functional', async () => {
        await DB.prepare("INSERT INTO events (id,title,kind,status,date_start) VALUES ('event-test','Test event','Event','published','2026-11-01T23:00:00Z')").run();
        const events = await (await eventsGet(ctx('/api/events/month?month=2026-11'))).json();
        assert.equal(events.monthEvents[0].title, 'Test event');
        const donor = ctx('/api/admin/donors');
        donor.request = new Request(donor.url, { method: 'POST', body: new URLSearchParams({ name: 'Test donor', amount: '25.50' }) });
        assert.match((await donorPost(donor)).headers.get('location'), /ok=1/);
        assert.equal((await DB.prepare('SELECT amount_cents FROM donors').first()).amount_cents, 2550);
        await PHOTOS_BUCKET.put('approved/test.png', new Uint8Array([137, 80, 78, 71]), { httpMetadata: { contentType: 'image/png' } });
        await DB.prepare("INSERT INTO photos (id,status,r2_key,content_type,category,alt,submitted_at) VALUES ('photo-test','approved','approved/test.png','image/png','lake','Test photo','2026-11-01')").run();
        const photo = await photoGet(ctx('/api/photos/file?id=photo-test'));
        assert.equal(photo.status, 200);
        assert.equal(photo.headers.get('content-type'), 'image/png');
        await DB.prepare("UPDATE photos SET status = 'pending' WHERE id = 'photo-test'").run();
        assert.equal((await photoGet(ctx('/api/photos/file?id=photo-test'))).status, 404);
    });

});
