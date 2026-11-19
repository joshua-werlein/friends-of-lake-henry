import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { GET as importsGet, POST as importsPost } from '../src/pages/api/admin/raffle/photo-imports.ts';
import { POST as winnersPost } from '../src/pages/api/admin/raffle/winners.ts';
import { GET as publicMonth } from '../src/pages/api/raffle/month.ts';
import { photoFinalStatus } from '../src/lib/server/raffle-photo-autopublish.ts';
import { onRequest } from '../src/middleware.ts';

// Administrator review of held/rejected winner-photo rows. Local Miniflare D1 only: no network, no Workers AI, no remote database.
const events = JSON.parse(await readFile(new URL('./fixtures/november-2026-published-raffle-events.json', import.meta.url))).events;
const BASE = ['001_schema.sql', 'migrations/00x_raffle_poster.sql', '003_raffle_prize_supplements.sql', '009_raffle_season_calendar.sql', '004_raffle_photo_autopublish.sql',
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
const MAIN = '1st place — Colt Python 357 Mag 8" SS', GIFT = '2nd place — $100 gift certificate from Safe & Secure Firearms';
const MAIN_SLOT = 'event:2026-11-16-day-16-colt-python-357-mag-8-ss', GIFT_SLOT = 'daily:2026-11-16:0';
const PHOTO = '122336394524073310', POST_ID = '144051422124740_122336394554073310';
const draft = (extra = {}) => ({ drawDate: '2026-11-16', position: null, ticketNumber: '797', ticketStatus: 'readable', name: 'JJ Demaske', town: 'Melrose, WI',
    townStatus: 'readable', prize: 'Firearm', notes: '', cellText: '797 -JJ Demaske, Melrose, WI', ...extra });
/** Stores a photo the importer decided as held, with its rows exactly as writeDecision records them. */
async function heldPhoto(DB, rows, photoId = PHOTO, status = 'held') {
    await DB.prepare(`INSERT INTO raffle_photo_auto_imports (photo_id, post_id, status, extraction_json, reasons_json) VALUES (?,?,?,?,?)`)
        .bind(photoId, POST_ID, status, '[]', '[]').run();
    for (const [i, r] of rows.entries()) await DB.prepare(`INSERT INTO raffle_photo_auto_rows (photo_id, row_number, outcome, winner_id, prize, reasons_json, row_json) VALUES (?,?,?,?,?,?,?)`)
        .bind(photoId, i + 1, r.outcome ?? 'held', r.winnerId ?? null, r.prize ?? null, JSON.stringify(r.reasons ?? ['name differs from the name printed in the cell']), JSON.stringify(r.row)).run();
}
const SESSION = 'local-test-session-id';
const locals = DB => ({ runtime: { env: { DB } } });
const review = (DB, body) => importsPost({ locals: locals(DB), request: new Request('https://example.test/api/admin/raffle/photo-imports',
    { method: 'POST', headers: { cookie: `admin_session=${SESSION}` }, body: JSON.stringify(body) }) });
const load = async DB => { const res = await importsGet({ locals: locals(DB) }); assert.equal(res.status, 200); return res.json(); };
const rowOf = async (DB, n = 1, photoId = PHOTO) => (await load(DB)).imports.find(i => i.photoId === photoId).rows.find(r => r.rowNumber === n);
const winners = async DB => (await DB.prepare('SELECT * FROM raffle_winners ORDER BY id').all()).results;
const resolutions = async DB => (await DB.prepare('SELECT * FROM raffle_photo_row_resolutions ORDER BY id').all()).results;
const publicWinners = async DB => (await (await publicMonth({ locals: locals(DB), request: new Request('https://example.test/api/raffle/month?month=2026-11') })).json()).winners;

test('Approve publishes the stored AI values once, with the audit, and the public winners list shows it immediately', async t => {
    const DB = await database(t);
    await heldPhoto(DB, [{ row: draft({ ticketNumber: '801', name: 'Pat Doe', town: 'Blair, WI', cellText: '801 -Pat Doe, Blair, WI' }), prize: MAIN }]);
    const r = await rowOf(DB);
    assert.equal(r.resolution, null);
    assert.match(r.version, /^[0-9a-f]{64}$/);
    assert.deepEqual(r.matches, []);
    const data = await load(DB);
    assert.equal(data.review.available, true);
    assert.deepEqual(data.review.slots['2026-11-16'].map(s => [s.id, s.prize]), [[MAIN_SLOT, MAIN], [GIFT_SLOT, GIFT]]);

    const res = await review(DB, { action: 'approve', photoId: PHOTO, rowNumber: 1, version: r.version });
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const [w] = await winners(DB);
    assert.deepEqual([w.id, w.raffle_key, w.draw_date, w.ticket_number, w.ticket_number_text, w.winner_name, w.town, w.prize, w.prize_slot_id],
        ['2026-11-2026-11-16-801', '2026-11', '2026-11-16', 801, '801', 'Pat Doe', 'Blair, WI', MAIN, MAIN_SLOT]);
    assert.ok((await publicWinners(DB)).some(p => p.name === 'Pat Doe' && p.drawDate === '2026-11-16'));
    const [a] = await resolutions(DB);
    assert.equal(a.action, 'approve'); assert.equal(a.final_status, 'published'); assert.equal(a.winner_id, w.id);
    assert.equal(a.original_outcome, 'held'); assert.equal(JSON.parse(a.original_row_json).cellText, '801 -Pat Doe, Blair, WI');
    assert.deepEqual(JSON.parse(a.original_reasons_json), ['name differs from the name printed in the cell']);
    assert.deepEqual(JSON.parse(a.corrections_json), {});
    assert.equal(a.actor, 'admin:' + createHash('sha256').update(SESSION).digest('hex').slice(0, 12));
    assert.ok(!a.actor.includes(SESSION));
    const after = await rowOf(DB);
    assert.equal(after.outcome, 'inserted'); assert.equal(after.winnerId, w.id);
    assert.equal(after.row.cellText, '801 -Pat Doe, Blair, WI'); // the original extraction is kept
    assert.equal(after.reasons[0], 'published by an administrator after review (approve)');
    assert.equal(after.resolution.finalStatus, 'published');
    assert.equal((await DB.prepare('SELECT status FROM raffle_photo_auto_imports WHERE photo_id=?').bind(PHOTO).first()).status, 'published');
    // A decided photo is never reprocessed by the importer, so the review cannot be undone by a requeue.
    assert.equal(await photoFinalStatus(DB, PHOTO), 'published');

    // Repeated click with the same page state, and a fresh read of the resolved row: nothing more is published.
    for (const version of [r.version, after.version]) {
        const again = await review(DB, { action: 'approve', photoId: PHOTO, rowNumber: 1, version });
        assert.equal(again.status, 409);
    }
    const edit = await review(DB, { action: 'edit', photoId: PHOTO, rowNumber: 1, version: after.version,
        winner: { drawDate: '2026-11-16', ticketNumber: '802', name: 'Other', town: '', slotId: GIFT_SLOT } });
    assert.equal(edit.status, 409);
    assert.equal((await winners(DB)).length, 1);
    assert.equal((await resolutions(DB)).length, 1);
});

test('concurrent approvals of one row publish exactly one winner', async t => {
    const DB = await database(t);
    await heldPhoto(DB, [{ row: draft({ ticketNumber: '801', name: 'Pat Doe' }), prize: MAIN }]);
    const { version } = await rowOf(DB);
    const results = await Promise.all(Array.from({ length: 5 }, () => review(DB, { action: 'approve', photoId: PHOTO, rowNumber: 1, version })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409, 409, 409]);
    assert.equal((await winners(DB)).length, 1);
    assert.equal((await resolutions(DB)).length, 1);
});

test('stale page state, malformed requests and a missing migration publish nothing', async t => {
    const DB = await database(t);
    await heldPhoto(DB, [{ row: draft({ ticketNumber: '801', name: 'Pat Doe' }), prize: MAIN }]);
    const { version } = await rowOf(DB);
    // The importer or another admin changed the row after the page loaded.
    await DB.prepare(`UPDATE raffle_photo_auto_rows SET reasons_json='["changed"]' WHERE photo_id=?`).bind(PHOTO).run();
    assert.equal((await review(DB, { action: 'approve', photoId: PHOTO, rowNumber: 1, version })).status, 409);
    for (const body of [{ action: 'approve', photoId: PHOTO, rowNumber: 1, version: 'x' }, { action: 'approve', photoId: 'abc', rowNumber: 1, version },
        { action: 'approve', photoId: PHOTO, rowNumber: 0, version }, { action: 'approve', photoId: PHOTO, rowNumber: '1', version }])
        assert.equal((await review(DB, body)).status, 400, JSON.stringify(body));
    assert.equal((await review(DB, { action: 'approve', photoId: PHOTO, rowNumber: 9, version })).status, 404);
    assert.equal((await winners(DB)).length, 0);

    const old = await database(t, { review: false });
    await heldPhoto(old, [{ row: draft(), prize: MAIN }]);
    const data = await load(old);
    assert.equal(data.review.available, false); // the page still loads and shows the rows
    const res = await review(old, { action: 'approve', photoId: PHOTO, rowNumber: 1, version: data.imports[0].rows[0].version });
    assert.equal(res.status, 503);
    assert.equal((await winners(old)).length, 0);
});

test('November 16: JJ Demaske, already entered by hand, is detected, cannot be published again and is marked resolved without touching the winner', async t => {
    const DB = await database(t);
    // The manual correction already on the website.
    assert.equal((await winnersPost({ locals: locals(DB), request: new Request('https://example.test/api/admin/raffle/winners', { method: 'POST',
        body: JSON.stringify({ drawDate: '2026-11-16', ticketNumber: '797', name: 'JJ Demaske', town: 'Melrose, WI', prize: MAIN }) }) })).status, 200);
    await heldPhoto(DB, [{ row: draft(), prize: MAIN }, { row: draft({ ticketNumber: '', ticketStatus: 'blank', name: '', town: '', cellText: '', prize: GIFT }), prize: null,
        reasons: ['no winner was read for this approved prize; enter it from the post if it was drawn: $100 gift certificate from Safe & Secure Firearms'] }]);
    const before = await winners(DB);
    const r = await rowOf(DB);
    assert.deepEqual(r.matches.map(m => [m.id, m.by]), [['2026-11-2026-11-16-797', ['same ticket', 'same name', 'same prize']]]);

    // Approve and every edit that would duplicate the stored winner are refused and name the conflict.
    const approve = await review(DB, { action: 'approve', photoId: PHOTO, rowNumber: 1, version: r.version });
    assert.equal(approve.status, 409);
    assert.equal((await approve.json()).conflicts[0].id, '2026-11-2026-11-16-797');
    for (const winner of [{ ticketNumber: '798', name: 'JJ Demaske', slotId: GIFT_SLOT }, { ticketNumber: '797', name: 'J. J. Demaske', slotId: GIFT_SLOT },
        { ticketNumber: '799', name: 'Somebody Else', slotId: MAIN_SLOT }]) {
        const res = await review(DB, { action: 'edit', photoId: PHOTO, rowNumber: 1, version: r.version, winner: { drawDate: '2026-11-16', town: 'Melrose, WI', ...winner } });
        assert.equal(res.status, 409, JSON.stringify(winner)); // same name, same ticket, the main prize already awarded: never reassigned
    }
    assert.deepEqual(await winners(DB), before);

    // Resolving needs a stored winner or an explanation.
    assert.equal((await review(DB, { action: 'resolve', photoId: PHOTO, rowNumber: 1, version: r.version })).status, 400);
    assert.equal((await review(DB, { action: 'resolve', photoId: PHOTO, rowNumber: 1, version: r.version, winnerId: '2026-11-2026-11-16-999' })).status, 409);
    const res = await review(DB, { action: 'resolve', photoId: PHOTO, rowNumber: 1, version: r.version, winnerId: '2026-11-2026-11-16-797', note: 'Corrected by hand on Nov 16' });
    assert.equal(res.status, 200);
    assert.deepEqual(await winners(DB), before); // the winner is linked, never changed or duplicated
    const [a] = await resolutions(DB);
    assert.deepEqual([a.action, a.final_status, a.winner_id, a.note, a.published_json], ['resolve', 'resolved', '2026-11-2026-11-16-797', 'Corrected by hand on Nov 16', null]);
    assert.equal(JSON.parse(a.original_row_json).cellText, '797 -JJ Demaske, Melrose, WI');
    const resolved = await rowOf(DB);
    assert.equal(resolved.outcome, 'held'); // the importer's own record stays as it decided
    assert.equal(resolved.resolution.finalStatus, 'resolved');
    // The photo still has the unrelated missing gift-card row, so it stays held; resolved rows cannot be published or resolved again.
    assert.equal((await DB.prepare('SELECT status FROM raffle_photo_auto_imports WHERE photo_id=?').bind(PHOTO).first()).status, 'held');
    for (const body of [{ action: 'approve' }, { action: 'resolve', winnerId: '2026-11-2026-11-16-797' },
        { action: 'edit', winner: { drawDate: '2026-11-16', ticketNumber: '850', name: 'New Name', town: '', slotId: GIFT_SLOT } }])
        assert.equal((await review(DB, { ...body, photoId: PHOTO, rowNumber: 1, version: resolved.version })).status, 409, body.action);
    assert.deepEqual(await winners(DB), before);
    assert.equal((await resolutions(DB)).length, 1);

    // The gift-card placeholder has no name or prize: Approve is refused, and it can be resolved with a note.
    const gift = await rowOf(DB, 2);
    assert.equal((await review(DB, { action: 'approve', photoId: PHOTO, rowNumber: 2, version: gift.version })).status, 400);
    assert.equal((await review(DB, { action: 'resolve', photoId: PHOTO, rowNumber: 2, version: gift.version, note: 'Gift card winner checked on the post' })).status, 200);
    assert.equal((await DB.prepare('SELECT status FROM raffle_photo_auto_imports WHERE photo_id=?').bind(PHOTO).first()).status, 'duplicate');
});

test('Edit publishes corrected values through manual-entry validation, records each correction and never reassigns a prize', async t => {
    const DB = await database(t);
    await heldPhoto(DB, [{ row: draft({ ticketNumber: '0412', name: 'Jon Smth', town: 'Blar, WI', prize: 'Gift', cellText: '0412-Jon Smth, Blar, WI' }), prize: null, outcome: 'rejected',
        reasons: ['prize could not be matched'] }]);
    const r = await rowOf(DB);
    const edit = winner => review(DB, { action: 'edit', photoId: PHOTO, rowNumber: 1, version: r.version, winner: { drawDate: '2026-11-16', ticketNumber: '0412', name: 'Jon Smith', town: 'Blair, WI', ...winner } });
    // Server-side validation, with manual entry's messages.
    for (const [winner, error] of [[{ slotId: '' }, /Select the approved prize/], [{ slotId: 'daily:2026-11-15:0' }, /not an approved prize for the selected date/],
        [{ slotId: GIFT_SLOT, drawDate: '2026-02-30' }, /valid date/], [{ slotId: GIFT_SLOT, ticketNumber: '12a' }, /positive whole number/],
        [{ slotId: GIFT_SLOT, name: 'J' }, /name required/], [{ slotId: GIFT_SLOT, ticketNumber: '' }, /confirm the official announcement published no ticket/],
        [{ slotId: GIFT_SLOT, town: 'x'.repeat(201) }, /too long/]]) {
        const res = await edit(winner);
        assert.equal(res.status, 400, JSON.stringify(winner));
        assert.match((await res.json()).error, error);
    }
    assert.equal((await review(DB, { action: 'edit', photoId: PHOTO, rowNumber: 1, version: r.version })).status, 400);
    assert.equal((await winners(DB)).length, 0);
    // The gift card already has a winner from another photo: it is not reassigned.
    await DB.prepare(`INSERT INTO raffle_winners (id, raffle_key, draw_date, ticket_number, winner_name, town, prize, ticket_number_text, prize_slot_id) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind('2026-11-2026-11-16-500', '2026-11', '2026-11-16', 500, 'Gift Winner', 'Osseo, WI', GIFT, '500', GIFT_SLOT).run();
    const taken = await edit({ slotId: GIFT_SLOT });
    assert.equal(taken.status, 409);
    assert.equal((await taken.json()).conflicts[0].id, '2026-11-2026-11-16-500');
    assert.equal((await winners(DB)).length, 1);

    const ok = await edit({ slotId: MAIN_SLOT });
    assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
    const w = (await winners(DB)).find(v => v.id === '2026-11-2026-11-16-412');
    assert.deepEqual([w.ticket_number, w.ticket_number_text, w.winner_name, w.town, w.prize, w.prize_slot_id], [412, '0412', 'Jon Smith', 'Blair, WI', MAIN, MAIN_SLOT]);
    const [a] = await resolutions(DB);
    assert.equal(a.action, 'edit'); assert.equal(a.original_outcome, 'rejected');
    assert.deepEqual(JSON.parse(a.corrections_json), { name: { from: 'Jon Smth', to: 'Jon Smith' }, town: { from: 'Blar, WI', to: 'Blair, WI' }, prize: { from: null, to: MAIN } });
    assert.equal(JSON.parse(a.published_json).prizeSlotId, MAIN_SLOT);
    assert.equal(JSON.parse(a.original_row_json).name, 'Jon Smth');
    assert.ok((await publicWinners(DB)).some(p => p.name === 'Jon Smith'));
    assert.equal((await DB.prepare('SELECT status FROM raffle_photo_auto_imports WHERE photo_id=?').bind(PHOTO).first()).status, 'published');
});

test('a winner without a ticket is published only with explicit confirmation and an approved place', async t => {
    const DB = await database(t);
    await heldPhoto(DB, [{ row: draft({ ticketNumber: '', ticketStatus: 'blank', name: 'No Ticket', town: 'Hixton, WI', prize: 'Gift Card', cellText: 'No Ticket, Hixton, WI' }), prize: GIFT }]);
    const { version } = await rowOf(DB);
    const unconfirmed = await review(DB, { action: 'approve', photoId: PHOTO, rowNumber: 1, version });
    assert.equal(unconfirmed.status, 400);
    assert.equal((await review(DB, { action: 'approve', photoId: PHOTO, rowNumber: 1, version, ticketMissingVerified: true })).status, 200);
    const [w] = await winners(DB);
    assert.deepEqual([w.ticket_number, w.ticket_number_text, w.prize_slot_id, w.prize], [null, null, GIFT_SLOT, GIFT]);
});

test('review actions keep authentication and cross-origin protections', async () => {
    const url = new URL('https://example.test/api/admin/raffle/photo-imports');
    const body = JSON.stringify({ action: 'approve', photoId: PHOTO, rowNumber: 1, version: 'a'.repeat(64) });
    for (const [headers, status] of [[{}, 403], [{ Origin: 'https://foreign.test' }, 403], [{ Referer: 'https://foreign.test/admin' }, 403], [{ Origin: url.origin }, 401]]) {
        const response = await onRequest({ url, locals: { runtime: { env: { SESSION: { get: async () => null } } } }, request: new Request(url, { method: 'POST', headers, body }) },
            () => { throw Error('unauthorized handler reached'); });
        assert.equal(response.status, status);
    }
    // A non-admin session is refused too.
    const response = await onRequest({ url, locals: { runtime: { env: { SESSION: { get: async () => JSON.stringify({ role: 'viewer' }) } } } },
        request: new Request(url, { method: 'POST', headers: { Origin: url.origin, cookie: 'admin_session=x' }, body }) }, () => { throw Error('non-admin handler reached'); });
    assert.equal(response.status, 401);
});

test('migration 010 is additive: existing data and the importer are untouched and it can be re-run', async t => {
    const DB = await database(t, { review: false });
    await heldPhoto(DB, [{ row: draft(), prize: MAIN }]);
    await DB.prepare(`INSERT INTO raffle_winners (id, raffle_key, draw_date, ticket_number, winner_name, town, prize, ticket_number_text) VALUES ('w1','2026-11','2026-11-02',118,'Art','Galesville','1st place','118')`).run();
    const snapshot = async () => {
        const tables = (await DB.prepare(`SELECT name, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'raffle_photo_row_resolutions%' AND name NOT LIKE 'idx_raffle_photo_row_resolutions%' AND name NOT LIKE 'sqlite_%' AND substr(name,1,4)<>'_cf_' ORDER BY name`).all()).results;
        const data = {};
        for (const { name } of tables.filter(v => v.sql?.startsWith('CREATE TABLE'))) data[name] = (await DB.prepare(`SELECT * FROM "${name}"`).all()).results;
        return { tables, data };
    };
    const before = await snapshot();
    await run(DB, '010_raffle_photo_row_resolutions.sql');
    await run(DB, '010_raffle_photo_row_resolutions.sql');
    assert.deepEqual(await snapshot(), before);
    const cols = (await DB.prepare(`PRAGMA table_info(raffle_photo_row_resolutions)`).all()).results.map(c => c.name);
    assert.deepEqual(cols, ['id', 'photo_id', 'row_number', 'action', 'final_status', 'original_outcome', 'original_row_json', 'original_reasons_json', 'original_prize',
        'published_json', 'corrections_json', 'winner_id', 'note', 'actor', 'created_at']);
    // The rollback removes only the new table.
    await run(DB, 'rollback/010_raffle_photo_row_resolutions.down.sql');
    assert.deepEqual(await snapshot(), before);
});
