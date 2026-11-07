import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

// Isolated replay against an in-memory D1. Nothing here can reach a remote database.
const read = name => readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
const statements = sql => sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
const MIGRATED_COLUMNS = 'rowid AS rid, id, raffle_key, draw_date, ticket_number, typeof(ticket_number) AS ticket_type, winner_name, town, created_at, prize, ticket_number_text';
const all = async db => (await db.prepare(`SELECT ${MIGRATED_COLUMNS} FROM raffle_winners ORDER BY rowid`).all()).results;
const ADD = `INSERT INTO raffle_winners (id,raffle_key,draw_date,ticket_number,winner_name,town,created_at,prize,ticket_number_text) VALUES (?,?,?,?,?,?,?,?,?)`;

async function legacyDatabase(t) {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    for (const statement of statements(await read('001_schema.sql'))) await DB.prepare(statement).run();
    for (const statement of statements(await read('004_raffle_photo_autopublish.sql'))) await DB.prepare(statement).run();
    // Every historical winner from the tracked known-good dump.
    const dump = await readFile(new URL('../folh-db-known-good-2025-12-26.sql', import.meta.url), 'utf8');
    const historical = dump.split(/\r?\n/).filter(line => line.startsWith('INSERT INTO "raffle_winners"'));
    assert.equal(historical.length, 30);
    for (const line of historical) await DB.prepare(line).run();
    for (const statement of statements(await read('005_winner_ticket_text.sql'))) await DB.prepare(statement).run();
    // The record shapes production has accumulated since: leading zero, blank town, legacy 3rd, no prize, unknown place.
    for (const row of [
        ['2026-11-2026-11-03-47', '2026-11', '2026-11-03', 47, 'Kerry & Jeff Jacobson', 'Monona, WI', '2026-11-04T01:00:00.000Z', '2nd place — Gift card: $100 gift certificate from Safe & Secure Firearms', null],
        ['2026-11-2026-11-05-50', '2026-11', '2026-11-05', 50, 'Brent Janzen', 'Blair, WI', '2026-11-06T01:00:00.000Z', '2nd place — $100 gift certificate from Safe & Secure Firearms', '050'],
        ['2026-11-2026-11-04-226', '2026-11', '2026-11-04', 226, 'Jim Wilber', '', '2026-11-05T01:00:00.000Z', '1st place — Firearm: Henry Big Boy All Weather 44 Mag', null],
        ['2026-02-2026-02-01-9', '2026-02', '2026-02-01', 9, 'Legacy Third', 'Osseo', '2026-02-02T01:00:00.000Z', '3rd place — Legacy prize', null],
        ['2026-02-2026-02-02-10', '2026-02', '2026-02-02', 10, 'Plain Bonus Text', 'Osseo', '2026-02-03T01:00:00.000Z', 'Bonus knife', null],
    ]) await DB.prepare(ADD).bind(...row).run();
    return DB;
}
const migrate = async db => { for (const s of statements(await read('006_bonus_winner_tickets.sql'))) await db.prepare(s).run(); };
const events = JSON.parse(await readFile(new URL('./fixtures/november-2026-published-raffle-events.json', import.meta.url))).events;
const seedEvents = async db => { for (const e of events) await db.prepare('INSERT INTO events(id,title,kind,status,date_start,summary) VALUES(?,?,?,?,?,?)').bind(e.id, e.title, e.kind, e.status, e.date_start, e.summary).run(); };
const SLOTTED = `INSERT INTO raffle_winners (id,raffle_key,draw_date,ticket_number,winner_name,town,created_at,prize,ticket_number_text,prize_slot_id) VALUES (?,?,?,?,?,?,?,?,?,?)`;
const indexes = async db => (await db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='raffle_winners' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()).results.map(r => r.name);

test('006 preserves every winner, rowid, date, ticket type and label, and adds no row', async t => {
    const DB = await legacyDatabase(t), before = await all(DB);
    assert.equal(before.length, 35);
    await migrate(DB);
    assert.deepEqual(await all(DB), before);
    assert.deepEqual(await indexes(DB), ['idx_raffle_winners_raffle_date', 'uniq_raffle_day_ticket', 'uniq_raffle_winner_prize_slot']);
    assert.ok(!(await DB.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'raffle_winners_rebuild%'`).first()));
    assert.equal((await DB.prepare(`SELECT ticket_number_text FROM raffle_winners WHERE winner_name='Brent Janzen' AND draw_date='2026-11-05'`).first()).ticket_number_text, '050');
    // Old writers keep working, so the schema can go first with old code still running.
    await DB.prepare(`INSERT INTO raffle_winners (id, raffle_key, draw_date, ticket_number, winner_name, town, prize, ticket_number_text) VALUES ('old-writer','2026-11','2026-11-09',5,'Old Writer','Blair','1st place',NULL)`).run();
});

test('schema allows a missing ticket only with an approved slot, and enforces one winner per slot', async t => {
    const DB = await legacyDatabase(t);
    await migrate(DB);
    const at = '2026-11-07T01:00:00.000Z', row = (id, ticket, slot, prize = '2nd place — Gift', label = null, day = '2026-11-06') => DB.prepare(SLOTTED).bind(id, '2026-11', day, ticket, 'Someone', '', at, prize, label, slot).run();
    await assert.rejects(row('no-slot', null, null), /CHECK/);
    await assert.rejects(row('no-prize', null, 'daily:2026-11-06:0', null), /CHECK/);
    await assert.rejects(row('blank-prize', null, 'daily:2026-11-06:0', '   '), /CHECK/);
    await assert.rejects(row('label-only', null, 'daily:2026-11-06:0', '2nd place — Gift', '0'), /CHECK/); // No label without a ticket.
    await row('gift', null, 'daily:2026-11-06:0');
    // Ticket presence and punctuation cannot open the slot again.
    await assert.rejects(row('again', null, 'daily:2026-11-06:0'), /UNIQUE/);
    await assert.rejects(row('ticketed', 77, 'daily:2026-11-06:0', '2nd place -- GIFT!'), /UNIQUE/);
    // Distinct slots coexist, including two bonus drawings with identical text.
    await row('bonus-1', null, 'event-bonus:x', 'Bonus — Same');
    await row('bonus-2', null, 'event-bonus:x:2', 'Bonus — Same');
    await row('next-day', null, 'daily:2026-11-07:0', '2nd place — Gift', null, '2026-11-07');
    await assert.rejects(DB.prepare(ADD).bind('dup-ticket', '2026-11', '2026-11-05', 50, 'Other', '', at, '1st place', '50').run(), /UNIQUE/);
    // Adding a verified ticket later updates the same record and its slot stays taken. Clearing a slot from a ticketless row is refused.
    assert.equal((await DB.prepare(`UPDATE raffle_winners SET ticket_number=321, ticket_number_text='0321' WHERE id='gift'`).run()).meta.changes, 1);
    await assert.rejects(row('slot-still-held', null, 'daily:2026-11-06:0'), /UNIQUE/);
    await assert.rejects(DB.prepare(`UPDATE raffle_winners SET prize_slot_id=NULL WHERE id='bonus-1'`).run(), /CHECK/);
    assert.equal((await DB.prepare(`SELECT count(*) AS n FROM raffle_winner_corrections`).first()).n, 0);
});

test('slot backfill agrees with the application calendar on every November day and never edits a stored value', async t => {
    const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response()}}', d1Databases: ['DB'], d1Persist: false });
    t.after(() => mf.dispose());
    const DB = await mf.getD1Database('DB');
    for (const name of ['001_schema.sql', '003_raffle_prize_supplements.sql', '005_winner_ticket_text.sql']) for (const s of statements(await read(name))) await DB.prepare(s).run();
    await seedEvents(DB);
    const { prizeSchedule, matchApprovedSlot } = await import('../src/lib/server/raffle-prizes.ts');
    const schedule = await prizeSchedule(DB, '2026-11');
    let ticket = 1;
    const expected = new Map();
    for (const p of schedule) {
        const id = 'w' + ticket;
        // Stored text varies the way production does: place prefix, category prefix, and punctuation.
        const label = p.category === 'Main prize' ? `1st place — Firearm: ${p.description.replace('Auto Ordnance', 'Auto-Ordnance').replace(' 45 ACP', ', .45 ACP')}` : p.category === 'Gift card' ? `2nd place — ${p.description}.` : `2nd place — ${p.description}`;
        await DB.prepare(ADD).bind(id, '2026-11', p.drawDate, ticket++, 'N', '', '2026-11-20T00:00:00.000Z', label, null).run();
        expected.set(id, p.id);
    }
    await DB.prepare(ADD).bind('custom', '2026-11', '2026-11-06', 9001, 'N', '', '2026-11-20T00:00:00.000Z', '1st place — Donated Prize', null).run();
    await DB.prepare(ADD).bind('older-year', '2025-11', '2025-11-06', 9002, 'N', '', '2025-11-20T00:00:00.000Z', '$100 gift certificate from Safe & Secure Firearms', null).run();
    await DB.prepare(ADD).bind('unknown-prize', '2026-11', '2026-11-07', 9003, 'N', '', '2026-11-20T00:00:00.000Z', null, null).run();
    const before = await all(DB);
    await migrate(DB);
    assert.deepEqual(await all(DB), before);
    const slots = new Map((await DB.prepare('SELECT id, prize_slot_id AS slot FROM raffle_winners').all()).results.map(r => [r.id, r.slot]));
    for (const [id, slot] of expected) assert.equal(slots.get(id), slot, id);
    for (const id of ['custom', 'older-year', 'unknown-prize']) assert.equal(slots.get(id), null, id);
    assert.equal(matchApprovedSlot(schedule, '2026-11-06', '$100 Gift Certificate from Safe & Secure Firearms.').id, 'daily:2026-11-06:0');
});

test('a batch that cannot complete leaves the original table untouched', async t => {
    const DB = await legacyDatabase(t);
    await seedEvents(DB);
    // Two winners naming one approved prize make the backfill fail after the DROP.
    await DB.prepare(ADD).bind('dup-a', '2026-11', '2026-11-06', 1, 'A', '', '2026-11-07T00:00:00.000Z', '2nd place — $100 gift certificate from Safe & Secure Firearms', null).run();
    await DB.prepare(ADD).bind('dup-b', '2026-11', '2026-11-06', 2, 'B', '', '2026-11-07T00:00:00.000Z', '$100 gift certificate from Safe & Secure Firearms', null).run();
    const before = await all(DB);
    const batch = statements(await read('006_bonus_winner_tickets.sql')).map(s => DB.prepare(s));
    await assert.rejects(DB.batch(batch), /UNIQUE/);
    assert.deepEqual(await all(DB), before);
    assert.deepEqual(await indexes(DB), ['idx_raffle_winners_raffle_date', 'uniq_raffle_day_ticket']);
});

test('the copy guard aborts before the DROP if a row does not copy', async t => {
    const DB = await legacyDatabase(t), before = await all(DB);
    const source = statements(await read('006_bonus_winner_tickets.sql'));
    const copy = source.findIndex(s => s.startsWith('INSERT INTO raffle_winners_rebuild ('));
    const damaged = source.map((s, i) => i === copy ? s.replace('FROM raffle_winners ORDER BY rowid', "FROM raffle_winners WHERE id<>'2025-11-01-66' ORDER BY rowid") : s);
    await assert.rejects(DB.batch(damaged.map(s => DB.prepare(s))), /CHECK/);
    assert.deepEqual(await all(DB), before);
});

test('rollback refuses to run while a ticketless winner exists, then restores NOT NULL without data loss', async t => {
    const DB = await legacyDatabase(t);
    await migrate(DB);
    const down = statements(await read('rollback/006_bonus_winner_tickets.down.sql')).map(s => DB.prepare(s));
    await DB.prepare(SLOTTED).bind('ticketless', '2026-11', '2026-11-06', null, 'Lyle Schlomer', '', '2026-11-07T01:00:00.000Z', '2nd place — Gift', null, 'daily:2026-11-06:0').run();
    const withBonus = await all(DB);
    await assert.rejects(DB.batch(down), /CHECK/);
    assert.deepEqual(await all(DB), withBonus);
    // A verified ticket resolves it without deleting the record. Never fabricate one in production to pass this guard.
    await DB.prepare(`UPDATE raffle_winners SET ticket_number=321, ticket_number_text='321' WHERE id='ticketless'`).run();
    const ready = await all(DB);
    await DB.batch(statements(await read('rollback/006_bonus_winner_tickets.down.sql')).map(s => DB.prepare(s)));
    assert.deepEqual(await all(DB), ready);
    await assert.rejects(DB.prepare(ADD).bind('n', '2026-11', '2026-11-07', null, 'N', '', '2026-11-08T00:00:00.000Z', 'Bonus — X', null).run(), /NOT NULL/);
    assert.ok(await DB.prepare(`SELECT 1 FROM sqlite_master WHERE name='raffle_winner_corrections'`).first()); // Evidence stays.
    assert.deepEqual(await indexes(DB), ['idx_raffle_winners_raffle_date', 'uniq_raffle_day_ticket']);
    // Forward again.
    await migrate(DB);
    assert.deepEqual(await all(DB), ready);
});

test('007 is additive and its rollback leaves the queue intact', async t => {
    const DB = await legacyDatabase(t);
    await DB.prepare(`INSERT INTO raffle_photo_auto_posts (post_id, source, status, error_code) VALUES ('1_2','webhook','done',NULL)`).run();
    const queue = () => DB.prepare(`SELECT post_id, source, status, attempts, error_code FROM raffle_photo_auto_posts`).all().then(r => r.results);
    const before = await queue();
    for (const s of statements(await read('007_photo_import_diagnostics.sql'))) await DB.prepare(s).run();
    assert.deepEqual(await queue(), before);
    await DB.prepare(`INSERT INTO raffle_photo_auto_attempts (post_id, stage, outcome) VALUES ('1_2','post','done')`).run();
    await assert.rejects(DB.prepare(`INSERT INTO raffle_photo_auto_attempts (post_id, stage, outcome) VALUES ('1_2','nope','done')`).run(), /CHECK/);
    for (const s of statements(await read('rollback/007_photo_import_diagnostics.down.sql'))) await DB.prepare(s).run();
    assert.deepEqual(await queue(), before);
});
