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
 *   0 published only · 1 held, unresolved · 2 held, resolved · 3 rejected, unresolved · 4 rejected, resolved
 *   5 whole-photo rejection, no rows · 6 partial: published + held unresolved · 7 outside-window only
 *   8 processing failure, no rows · 9 whole-photo rejection, no rows, already marked handled (photo-level resolution, row 0)
 */
const NO_ROWS = [5, 8, 9];
const hasRows = s => !NO_ROWS.includes(s.shape);
async function seed(DB, count, rowsPerPhoto = 3, { resolutions = true } = {}) {
    const shapes = [], imports = [], rows = [], resolved = [], handled = [];
    for (let i = 0; i < count; i++) {
        const photoId = String(900000000000000 + i), postId = `144051422124740_${800000000000000 + i}`, shape = i % 10;
        const created = new Date(Date.UTC(2025, 0, 1) + i * 3600_000).toISOString();
        const day = `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`;
        const status = ['published', 'held', 'published', 'rejected', 'published', 'rejected', 'partial', 'duplicate', 'failed', 'rejected'][shape];
        const reasons = shape === 5 || shape === 9 ? ['extraction passes disagree about whether this is a winner announcement'] : shape === 8 ? ['ai-unavailable'] : [];
        imports.push([photoId, postId, status, created, JSON.stringify(reasons)]);
        const outcomes = NO_ROWS.includes(shape) ? [] : Array.from({ length: rowsPerPhoto }, (_, n) =>
            shape === 0 ? 'inserted' : shape === 1 || shape === 2 ? (n === 0 ? 'held' : 'inserted') : shape === 3 || shape === 4 ? 'rejected'
            : shape === 6 ? (n === 0 ? 'held' : 'inserted') : 'outside-window');
        outcomes.forEach((outcome, n) => rows.push([photoId, n + 1, outcome, outcome === 'inserted' ? MAIN : null,
            JSON.stringify([outcome === 'inserted' ? 'all 2 extraction passes agree' : 'name differs from the name printed in the cell']), JSON.stringify(row(day, `Winner${i}x${n} Lake`, 100 + n))]));
        if (resolutions && (shape === 2 || shape === 4)) outcomes.forEach((outcome, n) => { if (outcome === 'held' || outcome === 'rejected') resolved.push([photoId, n + 1, outcome]); });
        if (resolutions && shape === 9) handled.push([photoId, new Date(Date.parse(created) + 1800_000).toISOString()]);
        shapes.push({ photoId, postId, shape, created, day, needs: shape === 1 || shape === 3 || shape === 6, issue: shape === 5 || shape === 8 || (shape === 9 && !resolutions) });
    }
    // One statement per table (rows passed as one JSON parameter): thousands of single inserts overwhelm Miniflare's local bridge
    // when the whole suite runs in parallel, and D1 allows at most 100 bound parameters per statement.
    const statements = [DB.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status, created_at, updated_at, reasons_json)
            SELECT value->>0, value->>1, value->>2, value->>3, value->>3, value->>4 FROM json_each(?)`).bind(JSON.stringify(imports)),
        DB.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json)
            SELECT value->>0, value->>1, value->>2, NULL, value->>3, value->>4, value->>5 FROM json_each(?)`).bind(JSON.stringify(rows))];
    if (resolved.length) statements.push(DB.prepare(`INSERT INTO raffle_photo_row_resolutions (photo_id, row_number, action, final_status, original_outcome, original_row_json, actor)
            SELECT value->>0, value->>1, 'resolve', 'resolved', value->>2, '{}', 'admin:test' FROM json_each(?)`).bind(JSON.stringify(resolved)));
    if (handled.length) statements.push(DB.prepare(`INSERT INTO raffle_photo_row_resolutions (photo_id, row_number, action, final_status, original_outcome, original_row_json, note, actor, created_at)
            SELECT value->>0, 0, 'resolve', 'resolved', 'rejected', '{}', 'Winners entered manually', 'admin:test', value->>1 FROM json_each(?)`).bind(JSON.stringify(handled)));
    await DB.batch(statements);
    return shapes;
}

test('Needs review, Issues, Completed and All split the history; whole-photo problems are not Completed until handled', async t => {
    const DB = await database(t);
    const shapes = await seed(DB, 40);
    const needs = shapes.filter(s => s.needs).map(s => s.photoId), issues = shapes.filter(s => s.issue).map(s => s.photoId);
    const done = shapes.filter(s => !s.needs && !s.issue).map(s => s.photoId);
    const page = await summary(DB, { pageSize: '50' }); // default filter
    assert.equal(page.filter, 'needs-review');
    assert.deepEqual(page.counts, { 'needs-review': needs.length, issues: issues.length, completed: done.length, all: 40 });
    assert.equal(needs.length + issues.length + done.length, 40);
    assert.deepEqual(page.photos.map(p => p.photoId).sort(), [...needs].sort());
    assert.ok(page.photos.every(p => p.unresolved > 0 && p.category === 'needs-review'));
    // Issues: whole-photo rejections and processing failures with no winner rows, not yet handled.
    const open = await summary(DB, { filter: 'issues', pageSize: '50' });
    assert.deepEqual(open.photos.map(p => p.photoId).sort(), [...issues].sort());
    assert.ok(open.photos.every(p => p.rows === 0 && p.issue === 1 && p.handled === 0 && ['rejected', 'failed'].includes(p.status)));
    assert.deepEqual([...new Set(open.photos.map(p => p.status))].sort(), ['failed', 'rejected']);
    assert.equal(open.handledIssues, shapes.filter(s => s.shape === 9).length);
    // Completed: published, duplicate, resolved rows, outside-window rows and handled issues.
    const completed = await summary(DB, { filter: 'completed', pageSize: '50' });
    assert.deepEqual(completed.photos.map(p => p.photoId).sort(), [...done].sort());
    assert.ok(completed.photos.every(p => p.unresolved === 0 && p.category === 'completed'));
    const byId = Object.fromEntries(completed.photos.map(p => [p.photoId, p]));
    const resolvedHeld = shapes.find(s => s.shape === 2), handledIssue = shapes.find(s => s.shape === 9), outside = shapes.find(s => s.shape === 7);
    assert.deepEqual([byId[resolvedHeld.photoId].resolved, byId[resolvedHeld.photoId].unresolved, byId[resolvedHeld.photoId].published], [1, 0, 2]);
    // A historic, manually handled rejection is distinguishable from an outstanding one: same status and reasons, but handled.
    assert.deepEqual([byId[handledIssue.photoId].status, byId[handledIssue.photoId].rows, byId[handledIssue.photoId].issue, byId[handledIssue.photoId].handled],
        ['rejected', 0, 1, 1]);
    assert.deepEqual(byId[handledIssue.photoId].reasons, ['extraction passes disagree about whether this is a winner announcement']);
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
    const expectDay = day => shapes.filter(s => hasRows(s) && s.day === day).map(s => s.photoId).sort();
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: target.day, pageSize: '50' })), expectDay(target.day));
    const [, mm, dd] = target.day.split('-');
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: `${Number(mm)}/${Number(dd)}`, pageSize: '50' })), expectDay(target.day));
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: `${mm}/${dd}/2026`, pageSize: '50' })), expectDay(target.day));
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: `${mm}/${dd}/2025`, pageSize: '50' })), []);
    const month = target.day.slice(0, 7);
    assert.deepEqual(ids(await summary(DB, { filter: 'all', q: month, pageSize: '50' })), shapes.filter(s => hasRows(s) && s.day.startsWith(month)).map(s => s.photoId).sort());
    // Counts follow the search; filters still apply.
    const searched = await summary(DB, { filter: 'all', q: 'winner1' });
    const matching = shapes.filter(s => hasRows(s) && /^1/.test(String(shapes.indexOf(s))));
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
    // Nothing can have been handled either: every whole-photo problem is an open issue.
    assert.equal(body.counts.issues, shapes.filter(s => NO_ROWS.includes(s.shape)).length);
    const detail = (await get(DB, { view: 'photo', photoId: shapes[1].photoId })).body;
    assert.equal(detail.review.available, false);
    const issue = (await get(DB, { view: 'photo', photoId: shapes[5].photoId })).body;
    assert.deepEqual([issue.issue.handled, issue.issue.handlings], [false, []]);
    assert.equal((await post(DB, { action: 'resolve-photo', photoId: shapes[5].photoId, version: issue.photo.version, note: 'Entered by hand' })).status, 503);
});

test('Issues: paging, search, context, Mark handled with audit, and reopening after a later failure', async t => {
    const DB = await database(t);
    const shapes = await seed(DB, 120);
    const open = shapes.filter(s => s.issue);
    // Paging over the Issues filter only.
    const seen = [];
    for (let page = 1; ; page++) {
        const body = await summary(DB, { filter: 'issues', page: String(page), pageSize: '5' });
        assert.equal(body.total, open.length);
        assert.ok(body.photos.every(p => p.category === 'issues'));
        seen.push(...body.photos.map(p => p.photoId));
        if (page >= body.pages) break;
    }
    assert.deepEqual(seen, [...open].sort((a, b) => b.created.localeCompare(a.created)).map(s => s.photoId));
    // Search: a photo with no rows is found by its ID and by its announcement date (America/Chicago).
    const failed = shapes.find((s, i) => s.shape === 8 && new Date(s.created).getUTCHours() >= 7);
    assert.deepEqual((await summary(DB, { filter: 'issues', q: failed.photoId })).photos.map(p => p.photoId), [failed.photoId]);
    const announced = failed.created.slice(0, 10);
    const byDate = await summary(DB, { filter: 'issues', q: announced, pageSize: '50' });
    assert.ok(byDate.photos.some(p => p.photoId === failed.photoId), announced);
    assert.ok(byDate.photos.every(p => p.createdAt.startsWith(announced) || p.createdAt.startsWith(new Date(Date.parse(announced) + 86400000).toISOString().slice(0, 10))));
    // Context for deciding: post queue state and the winners already stored for the dates the announcement could cover.
    await DB.prepare(`INSERT INTO raffle_photo_auto_posts (post_id, source, status, attempts, last_error_code, last_error_at) VALUES (?,?,?,?,?,?)`)
        .bind(failed.postId, 'poll', 'retry', 3, 'ai-unavailable', failed.created).run();
    const window = (await get(DB, { view: 'photo', photoId: failed.photoId })).body.issue.window;
    await DB.prepare(`INSERT INTO raffle_winners (id, raffle_key, draw_date, ticket_number, winner_name, town, prize, ticket_number_text) VALUES (?,?,?,?,?,?,?,?)`)
        .bind(`w-${window[2]}`, window[2].slice(0, 7), window[2], 5, 'Manual Entry', 'Blair, WI', '1st place — Prize', '5').run();
    const detail = (await get(DB, { view: 'photo', photoId: failed.photoId })).body;
    assert.equal(detail.issue.window.length, 3);
    assert.deepEqual(detail.issue.storedWinners.map(w => w.name), ['Manual Entry']);
    assert.deepEqual([detail.post.status, detail.post.attempts, detail.post.lastErrorCode], ['retry', 3, 'ai-unavailable']);
    assert.equal((await summary(DB, { filter: 'issues', q: failed.photoId })).photos[0].postStatus, 'retry');
    assert.deepEqual([detail.issue.handled, detail.rows.length, detail.photo.status], [false, 0, 'failed']);
    // Mark handled: a note is required, stale pages and photos with winner rows are refused.
    const handle = body => post(DB, { action: 'resolve-photo', photoId: failed.photoId, version: detail.photo.version, ...body });
    assert.equal((await handle({ note: '' })).status, 400);
    assert.equal((await handle({ note: 'checked', version: 'a'.repeat(64) })).status, 409);
    assert.equal((await handle({ note: 'checked', photoId: '1' })).status, 404);
    const withRows = (await get(DB, { view: 'photo', photoId: shapes.find(s => s.shape === 3).photoId })).body;
    assert.equal((await post(DB, { action: 'resolve-photo', photoId: withRows.photo.photoId, version: withRows.photo.version, note: 'checked' })).status, 409);
    const published = (await get(DB, { view: 'photo', photoId: shapes.find(s => s.shape === 0).photoId })).body;
    assert.equal((await post(DB, { action: 'resolve-photo', photoId: published.photo.photoId, version: published.photo.version, note: 'checked' })).status, 409);
    // Concurrent handling records exactly once.
    const before = await summary(DB, { filter: 'issues' });
    const results = await Promise.all([1, 2, 3].map(() => handle({ note: 'Winners entered manually in raffle admin' })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409]);
    const audit = (await DB.prepare(`SELECT row_number AS n, action, final_status AS status, original_outcome AS outcome, original_reasons_json AS reasons, note, actor
        FROM raffle_photo_row_resolutions WHERE photo_id=?`).bind(failed.photoId).all()).results;
    assert.deepEqual(audit, [{ n: 0, action: 'resolve', status: 'resolved', outcome: 'failed', reasons: '["ai-unavailable"]', note: 'Winners entered manually in raffle admin', actor: audit[0].actor }]);
    assert.match(audit[0].actor, /^admin:[0-9a-f]{12}$/);
    // The photo keeps its importer record and moves from Issues to Completed as a handled issue; counts follow.
    const photo = await DB.prepare('SELECT status, reasons_json AS reasons FROM raffle_photo_auto_imports WHERE photo_id=?').bind(failed.photoId).first();
    assert.deepEqual(photo, { status: 'failed', reasons: '["ai-unavailable"]' });
    const after = await summary(DB, { filter: 'issues' });
    assert.equal(after.counts.issues, before.counts.issues - 1);
    assert.equal(after.counts.completed, before.counts.completed + 1);
    assert.equal(after.handledIssues, before.handledIssues + 1);
    const done = (await summary(DB, { filter: 'completed', q: failed.photoId })).photos[0];
    assert.deepEqual([done.category, done.issue, done.handled], ['completed', 1, 1]);
    assert.equal((await handle({ note: 'again' })).status, 409);
    // A later failure (the importer rewrites the photo) reopens the issue; handling it again keeps both records.
    await DB.prepare(`UPDATE raffle_photo_auto_imports SET reasons_json='["download-failed"]', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 second') WHERE photo_id=?`).bind(failed.photoId).run();
    const reopened = (await get(DB, { view: 'photo', photoId: failed.photoId })).body;
    assert.deepEqual([reopened.issue.handled, reopened.issue.handlings.length], [false, 1]);
    assert.equal((await summary(DB, { filter: 'issues', q: failed.photoId })).photos[0].category, 'issues');
    assert.equal((await post(DB, { action: 'resolve-photo', photoId: failed.photoId, version: reopened.photo.version, note: 'Second failure checked' })).status, 200);
    assert.deepEqual((await DB.prepare('SELECT row_number AS n FROM raffle_photo_row_resolutions WHERE photo_id=? ORDER BY n DESC').bind(failed.photoId).all()).results.map(r => r.n), [0, -1]);
    // Row review never touches photo-level records (row numbers start at 1).
    assert.equal((await post(DB, { action: 'resolve', photoId: failed.photoId, rowNumber: 0, version: reopened.photo.version, note: 'x' })).status, 400);
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
