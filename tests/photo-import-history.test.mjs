import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { GET as importsGet, POST as importsPost } from '../src/pages/api/admin/raffle/photo-imports.ts';
import { GET as publicMonth } from '../src/pages/api/raffle/month.ts';
import { searchCondition } from '../src/lib/server/raffle-photo-history.ts';

// Paged Photo imports history. Local Miniflare D1 only: no network, no Workers AI, no remote database.
const events = JSON.parse(await readFile(new URL('./fixtures/november-2026-published-raffle-events.json', import.meta.url))).events;
const BASE = ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '004_raffle_photo_autopublish.sql',
    '005_winner_ticket_text.sql', '006_bonus_winner_tickets.sql', '007_photo_import_diagnostics.sql', '008_ops_alert_incidents.sql'];
const run = async (DB, file) => {
    const sql = (await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');
    for (const statement of sql.split(';').filter(v => v.trim())) await DB.prepare(statement).run();
};
async function database(t, { review = true } = {}) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    for (const file of BASE) await run(DB, file);
    if (review) await run(DB, '010_raffle_photo_row_resolutions.sql');
    for (const e of events) await DB.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id, e.title, e.kind, e.status, e.date_start, e.summary).run();
    return DB;
}
const locals = DB => ({ runtime: { env: { DB } } });
const get = async (DB, params) => {
    const url = new URL('https://example.test/api/admin/raffle/photo-imports'); for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const res = await importsGet({ locals: locals(DB), url, request: new Request(url) });
    return { status: res.status, body: await res.json() };
};
const summary = async (DB, params = {}) => { const r = await get(DB, { view: 'summary', ...params }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const post = (DB, body) => importsPost({ locals: locals(DB), request: new Request('https://example.test/api/admin/raffle/photo-imports',
    { method: 'POST', headers: { cookie: 'admin_session=history-test' }, body: JSON.stringify(body) }) });
const MAIN = '1st place — Colt Python 357 Mag 8" SS';
const row = (drawDate, name, ticket, extra = {}) => ({ drawDate, position: null, ticketNumber: String(ticket), ticketStatus: 'readable', name, town: 'Blair, WI',
    townStatus: 'readable', prize: 'Firearm', notes: '', cellText: `${ticket} - ${name}, Blair, WI`, ...extra });

/**
 * Seeds `count` photos, newest first by created_at, cycling through every history shape:
 *   0 published only · 1 held, unresolved · 2 held, resolved · 3 rejected, unresolved · 4 rejected, resolved · 5 image-level rejection, no rows
 *   6 partial: published + held unresolved · 7 outside-window only
 */
async function seed(DB, count, rowsPerPhoto = 3, { resolutions = true } = {}) {
    const shapes = [], imports = [], rows = [], resolved = [];
    for (let i = 0; i < count; i++) {
        const photoId = String(900000000000000 + i), postId = `144051422124740_${800000000000000 + i}`, shape = i % 8;
        const created = new Date(Date.UTC(2025, 0, 1) + i * 3600_000).toISOString();
        const day = `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
        const status = ['published', 'held', 'published', 'rejected', 'published', 'rejected', 'partial', 'duplicate'][shape];
        imports.push([photoId, postId, status, created, JSON.stringify(shape === 5 ? ['extraction passes disagree about whether this is a winner announcement'] : [])]);
        const outcomes = shape === 5 ? [] : Array.from({ length: rowsPerPhoto }, (_, n) =>
            shape === 0 ? 'inserted' : shape === 1 || shape === 2 ? (n === 0 ? 'held' : 'inserted') : shape === 3 || shape === 4 ? 'rejected'
            : shape === 6 ? (n === 0 ? 'held' : 'inserted') : 'outside-window');
        outcomes.forEach((outcome, n) => rows.push([photoId, n + 1, outcome, outcome === 'inserted' ? MAIN : null,
            JSON.stringify([outcome === 'inserted' ? 'all 2 extraction passes agree' : 'name differs from the name printed in the cell']), JSON.stringify(row(day, `Winner${i}x${n} Lake`, 100 + n))]));
        if (resolutions && (shape === 2 || shape === 4)) outcomes.forEach((outcome, n) => { if (outcome === 'held' || outcome === 'rejected') resolved.push([photoId, n + 1, outcome]); });
        shapes.push({ photoId, shape, created, day, needs: shape === 1 || shape === 3 || shape === 6 });
    }
    // One statement per table (rows passed as one JSON parameter): thousands of single inserts overwhelm Miniflare's local bridge
    // when the whole suite runs in parallel, and D1 allows at most 100 bound parameters per statement.
    const statements = [DB.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status, created_at, reasons_json)
            SELECT value->>0, value->>1, value->>2, value->>3, value->>4 FROM json_each(?)`).bind(JSON.stringify(imports)),
        DB.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json)
            SELECT value->>0, value->>1, value->>2, NULL, value->>3, value->>4, value->>5 FROM json_each(?)`).bind(JSON.stringify(rows))];
    if (resolved.length) statements.push(DB.prepare(`INSERT INTO raffle_photo_row_resolutions (photo_id, row_number, action, final_status, original_outcome, original_row_json, actor)
            SELECT value->>0, value->>1, 'resolve', 'resolved', value->>2, '{}', 'admin:test' FROM json_each(?)`).bind(JSON.stringify(resolved)));
    await DB.batch(statements);
    return shapes;
}

test('Needs review lists only photos with unresolved held or rejected rows; resolved and historical outcomes are Completed', async t => {
    const DB = await database(t);
    const shapes = await seed(DB, 40);
    const needs = shapes.filter(s => s.needs).map(s => s.photoId), done = shapes.filter(s => !s.needs).map(s => s.photoId);
    const page = await summary(DB, { pageSize: '50' }); // default filter
    assert.equal(page.filter, 'needs-review');
    assert.deepEqual(page.counts, { 'needs-review': needs.length, completed: done.length, all: 40 });
    assert.deepEqual(page.photos.map(p => p.photoId).sort(), [...needs].sort());
    assert.ok(page.photos.every(p => p.unresolved > 0));
    const completed = await summary(DB, { filter: 'completed', pageSize: '50' });
    assert.deepEqual(completed.photos.map(p => p.photoId).sort(), [...done].sort());
    assert.ok(completed.photos.every(p => p.unresolved === 0));
    // A photo whose held row was resolved, an image-level rejection with no rows and outside-window rows are history, not open work.
    const byId = Object.fromEntries(completed.photos.map(p => [p.photoId, p]));
    const resolvedHeld = shapes.find(s => s.shape === 2), imageLevel = shapes.find(s => s.shape === 5), outside = shapes.find(s => s.shape === 7);
    assert.deepEqual([byId[resolvedHeld.photoId].resolved, byId[resolvedHeld.photoId].unresolved, byId[resolvedHeld.photoId].published], [1, 0, 2]);
    assert.deepEqual([byId[imageLevel.photoId].rows, byId[imageLevel.photoId].status], [0, 'rejected']);
    assert.deepEqual(byId[imageLevel.photoId].reasons, ['extraction passes disagree about whether this is a winner announcement']);
    assert.equal(byId[outside.photoId].unresolved, 0);
    const partial = page.photos.find(p => p.photoId === shapes.find(s => s.shape === 6).photoId);
    assert.deepEqual([partial.published, partial.unresolved, partial.rows], [2, 1, 3]);
    const all = await summary(DB, { filter: 'all', pageSize: '50' });
    assert.equal(all.photos.length, 40);
    // Newest first.
    assert.deepEqual(all.photos.map(p => p.createdAt), [...all.photos.map(p => p.createdAt)].sort().reverse());
});

test('server-side pagination covers substantial history exactly once, newest first, and clamps out-of-range pages', async t => {
    const DB = await database(t);
    const shapes = await seed(DB, 400, 6); // 400 photos, about 2,100 rows
    const seen = [];
    let first;
    for (let page = 1; ; page++) {
        const body = await summary(DB, { filter: 'all', page: String(page) });
        first ??= body;
        assert.ok(body.photos.length <= 20);
        seen.push(...body.photos.map(p => p.photoId));
        if (page >= body.pages) break;
    }
    assert.equal(first.pages, 20);
    assert.equal(first.photos.length, 20); // only one page of summaries is sent
    assert.ok(!('rows' in first.photos[0] && Array.isArray(first.photos[0].rows)), 'summaries carry counts, not row bodies');
    assert.equal(seen.length, 400);
    assert.equal(new Set(seen).size, 400);
    assert.deepEqual(seen, [...shapes].sort((a, b) => b.created.localeCompare(a.created)).map(s => s.photoId));
    const needsTotal = shapes.filter(s => s.needs).length;
    const lastNeeds = await summary(DB, { page: '999' });
    assert.equal(lastNeeds.page, lastNeeds.pages);
    assert.equal(lastNeeds.total, needsTotal);
    assert.equal((await summary(DB, { page: '-3' })).page, 1);
    assert.equal((await summary(DB, { pageSize: '5000' })).pageSize, 50);
    assert.equal((await summary(DB, { filter: 'nonsense' })).filter, 'needs-review');
});

test('search matches dates, winner names and photo IDs, combines with filters and treats wildcards literally', async t => {
    const DB = await database(t);
    const shapes = await seed(DB, 48);
    const ids = body => body.photos.map(p => p.photoId).sort();
    // Photo ID fragment.
    const target = shapes[17];
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: target.photoId.slice(-6) })), [target.photoId]);
    // Winner name, case-insensitive, any part.
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: 'winner17x2' })), [target.photoId]);
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: `WINNER17X` })), [target.photoId]);
    // Dates: exact ISO date, month, and month/day with or without a year.
    const expectDay = day => shapes.filter(s => s.shape !== 5 && s.day === day).map(s => s.photoId).sort();
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: target.day, pageSize: '50' })), expectDay(target.day));
    const [, mm, dd] = target.day.split('-');
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: `${Number(mm)}/${Number(dd)}`, pageSize: '50' })), expectDay(target.day));
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: `${mm}/${dd}/2026`, pageSize: '50' })), expectDay(target.day));
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: `${mm}/${dd}/2025`, pageSize: '50' })), []);
    const month = target.day.slice(0, 7);
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: month, pageSize: '50' })), shapes.filter(s => s.shape !== 5 && s.day.startsWith(month)).map(s => s.photoId).sort());
    // Counts follow the search; filters still apply.
    const searched = await summary(DB, { filter: 'all', q: 'winner1' });
    const matching = shapes.filter(s => s.shape !== 5 && /^1/.test(String(shapes.indexOf(s))));
    assert.equal(searched.counts.all, matching.length);
    assert.equal(searched.counts['needs-review'], matching.filter(s => s.needs).length);
    assert.ok((await summary(DB, { q: 'winner1', pageSize: '50' })).photos.every(p => p.unresolved > 0));
    // LIKE wildcards are literal: no ID or name contains "%" or "\", and "_" matches only the real underscore in every post ID.
    for (const q of ['%', '\\', 'Winner%', 'Winner_7']) assert.equal((await summary(DB, { filter: 'all', q })).total, 0, q);
    assert.equal((await summary(DB, { filter: 'all', q: '_' })).total, 48);
    assert.equal((await summary(DB, { filter: 'all', q: '740_' })).total, 48);
    assert.equal(searchCondition('   '), null);
    // D1 refuses LIKE patterns over 50 bytes; long, all-escape and multi-byte searches are shortened to fit instead of failing.
    assert.equal((await summary(DB, { filter: 'all', q: 'x'.repeat(500) })).q.length, 48);
    for (const q of ['x'.repeat(48), '%'.repeat(48), '\\'.repeat(48), 'é'.repeat(48), '漢'.repeat(48), `Winner17x2 Lake ${'y'.repeat(40)}`])
        assert.equal((await summary(DB, { filter: 'all', q })).total, 0, q.slice(0, 8));
    const long = searchCondition('%'.repeat(48));
    assert.ok(long.binds.every(b => new TextEncoder().encode(b).length <= 50));
});

test('expanding a photo loads its rows and review history; reviews move it out of Needs review without touching history', async t => {
    const DB = await database(t);
    const shapes = await seed(DB, 16);
    const resolved = shapes.find(s => s.shape === 2), held = shapes.find(s => s.shape === 1);
    const detail = (await get(DB, { view: 'photo', photoId: resolved.photoId })).body;
    assert.equal(detail.ok, true);
    assert.equal(detail.photo.photoId, resolved.photoId);
    assert.equal(detail.rows.length, 3);
    assert.equal(detail.rows[0].resolution.finalStatus, 'resolved');
    assert.equal(detail.rows[0].resolution.originalOutcome, 'held');
    assert.match(detail.rows[0].version, /^[0-9a-f]{64}$/);
    assert.equal(detail.review.available, true);
    assert.ok(Array.isArray(detail.review.slots['2026-02-02'] ?? []));
    assert.equal((await get(DB, { view: 'photo', photoId: '123' })).status, 404);
    assert.equal((await get(DB, { view: 'photo', photoId: 'abc' })).status, 400);
    assert.equal((await get(DB, { view: 'nope' })).status, 400);

    // Mark resolved through the existing review action: the photo leaves Needs review and joins Completed.
    const before = await summary(DB, { pageSize: '50' });
    assert.ok(before.photos.some(p => p.photoId === held.photoId));
    const open = (await get(DB, { view: 'photo', photoId: held.photoId })).body.rows.find(r => r.outcome === 'held');
    const res = await post(DB, { action: 'resolve', photoId: held.photoId, rowNumber: open.rowNumber, version: open.version, note: 'Checked the post' });
    assert.equal(res.status, 200);
    const after = await summary(DB, { pageSize: '50' });
    assert.ok(!after.photos.some(p => p.photoId === held.photoId));
    assert.equal(after.counts['needs-review'], before.counts['needs-review'] - 1);
    assert.equal(after.counts.completed, before.counts.completed + 1);
    const moved = (await summary(DB, { filter: 'completed', q: held.photoId })).photos[0];
    assert.deepEqual([moved.unresolved, moved.resolved], [0, 1]);
    // The original rows and reasons are still there.
    const kept = (await get(DB, { view: 'photo', photoId: held.photoId })).body.rows.find(r => r.rowNumber === open.rowNumber);
    assert.deepEqual([kept.outcome, kept.reasons, kept.resolution.note], ['held', ['name differs from the name printed in the cell'], 'Checked the post']);
    // A repeated resolve is refused; no second audit row.
    assert.equal((await post(DB, { action: 'resolve', photoId: held.photoId, rowNumber: open.rowNumber, version: open.version, note: 'again' })).status, 409);
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM raffle_photo_row_resolutions WHERE photo_id=?').bind(held.photoId).first()).n, 1);
});

test('Approve from the history view publishes once, appears publicly and moves the photo to Completed', async t => {
    const DB = await database(t);
    await DB.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status) VALUES ('700','144051422124740_701','held')`).run();
    await DB.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, prize, reasons_json, row_json) VALUES ('700',1,'held',?,?,?)`)
        .bind(MAIN, JSON.stringify(['model flagged uncertainty: faint ticket']), JSON.stringify(row('2026-11-16', 'Pat Doe', 801))).run();
    assert.equal((await summary(DB)).counts['needs-review'], 1);
    const r = (await get(DB, { view: 'photo', photoId: '700' })).body.rows[0];
    const results = await Promise.all([1, 2, 3].map(() => post(DB, { action: 'approve', photoId: '700', rowNumber: 1, version: r.version })));
    assert.deepEqual(results.map(x => x.status).sort(), [200, 409, 409]);
    assert.equal((await DB.prepare('SELECT count(*) AS n FROM raffle_winners').first()).n, 1);
    const pub = await (await publicMonth({ locals: locals(DB), request: new Request('https://example.test/api/raffle/month?month=2026-11') })).json();
    assert.deepEqual(pub.winners.map(w => w.name), ['Pat Doe']);
    const s = await summary(DB, { filter: 'completed' });
    assert.deepEqual(s.photos.map(p => [p.photoId, p.published, p.unresolved, p.resolved]), [['700', 1, 0, 1]]);
    assert.equal(s.counts['needs-review'], 0);
});

test('without migration 010 the history still loads and every held or rejected row is outstanding', async t => {
    const DB = await database(t, { review: false });
    const shapes = await seed(DB, 16, 3, { resolutions: false });
    const body = await summary(DB, { pageSize: '50' });
    assert.equal(body.reviewAvailable, false);
    assert.equal(body.counts['needs-review'], shapes.filter(s => [1, 2, 3, 4, 6].includes(s.shape)).length);
    const detail = (await get(DB, { view: 'photo', photoId: shapes[1].photoId })).body;
    assert.equal(detail.review.available, false);
});

test('posts view is bounded and the full log keeps its existing shape', async t => {
    const DB = await database(t);
    for (let i = 0; i < 45; i++) await DB.prepare(`INSERT INTO raffle_photo_auto_posts (post_id, source, status, created_at) VALUES (?,?,?,?)`)
        .bind(`144051422124740_${i}`, 'poll', 'done', new Date(Date.UTC(2026, 10, 1) + i * 60000).toISOString()).run();
    await seed(DB, 3);
    const posts = (await get(DB, { view: 'posts' })).body;
    assert.equal(posts.posts.length, 40);
    assert.equal(posts.posts[0].postId, '144051422124740_44');
    const legacy = (await get(DB)).body;
    assert.deepEqual(Object.keys(legacy).sort(), ['attempts', 'imports', 'ok', 'posts', 'review']);
    assert.equal(legacy.imports.length, 3);
    assert.ok(Array.isArray(legacy.imports[0].rows));
});
