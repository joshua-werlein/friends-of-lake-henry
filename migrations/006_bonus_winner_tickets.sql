-- Allows a winner with no published ticket and gives each winner a stable approved prize slot. SQLite cannot drop NOT NULL
-- in place, so raffle_winners is rebuilt. Every existing column value and rowid is copied unchanged and no winner is added,
-- edited or removed. prize_slot_id is new and is filled only for November 2026 rows naming exactly one calendar prize.
-- Run the preflight in docs/raffle-winner-repair-2026-11-06.md first. Safe to re-run only if it failed before the DROP.
DROP TABLE IF EXISTS raffle_winners_rebuild;
DROP TABLE IF EXISTS raffle_winners_rebuild_guard;
CREATE TABLE raffle_winners_rebuild (
    id TEXT PRIMARY KEY,
    raffle_key TEXT NOT NULL,
    draw_date TEXT NOT NULL,
    ticket_number INTEGER,
    winner_name TEXT NOT NULL,
    town TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    prize TEXT,
    ticket_number_text TEXT,
    prize_slot_id TEXT,
    -- IS NOT NULL matters: a NULL comparison would make this CHECK pass.
    CHECK (ticket_number IS NOT NULL OR (ticket_number_text IS NULL AND prize_slot_id IS NOT NULL AND prize IS NOT NULL AND length(trim(prize))>0))
);
INSERT INTO raffle_winners_rebuild (rowid, id, raffle_key, draw_date, ticket_number, winner_name, town, created_at, prize, ticket_number_text)
    SELECT rowid, id, raffle_key, draw_date, ticket_number, winner_name, town, created_at, prize, ticket_number_text FROM raffle_winners ORDER BY rowid;
-- Aborts before the DROP unless every row copied exactly.
CREATE TABLE raffle_winners_rebuild_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO raffle_winners_rebuild_guard (ok) SELECT
    (SELECT count(*) FROM raffle_winners) = (SELECT count(*) FROM raffle_winners_rebuild)
    AND NOT EXISTS (SELECT 1 FROM raffle_winners o LEFT JOIN raffle_winners_rebuild n ON n.rowid = o.rowid
        WHERE n.id IS NOT o.id OR n.raffle_key IS NOT o.raffle_key OR n.draw_date IS NOT o.draw_date OR n.ticket_number IS NOT o.ticket_number
            OR n.winner_name IS NOT o.winner_name OR n.town IS NOT o.town OR n.created_at IS NOT o.created_at OR n.prize IS NOT o.prize
            OR n.ticket_number_text IS NOT o.ticket_number_text);
DROP TABLE raffle_winners_rebuild_guard;
DROP TABLE raffle_winners;
ALTER TABLE raffle_winners_rebuild RENAME TO raffle_winners;
CREATE INDEX idx_raffle_winners_raffle_date ON raffle_winners(raffle_key, draw_date);
-- NULL tickets are distinct here, so this keeps protecting numbered tickets exactly as before.
CREATE UNIQUE INDEX uniq_raffle_day_ticket ON raffle_winners (raffle_key, draw_date, ticket_number);
-- One winner per approved prize slot, with or without a ticket, whatever the prize text's punctuation.
CREATE UNIQUE INDEX uniq_raffle_winner_prize_slot ON raffle_winners (prize_slot_id) WHERE prize_slot_id IS NOT NULL;
-- Prior values of every admin correction, including a ticket being cleared. Append-only and not exposed publicly.
CREATE TABLE IF NOT EXISTS raffle_winner_corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    winner_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('update','prize','delete')),
    before_json TEXT NOT NULL,
    after_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Mirrors the published calendar in src/lib/server/raffle-prizes.ts (a test compares them). A row naming no prize or several stays NULL.
-- Two winners naming one prize abort this migration by design: the preflight lists them so they are resolved first.
WITH events_local AS (
    SELECT id, title, summary, CASE WHEN length(date_start)=10 THEN date_start ELSE date(date_start,'-6 hours') END AS day
    FROM events WHERE status='published' AND lower(kind)='raffle' AND is_tbd=0 AND (date_start LIKE '2026-11-%' OR date_start LIKE '2026-12-01T%')
), slots AS (
    SELECT 'event:'||id AS slot, day, substr(title, instr(title,' - ')+3) AS description FROM events_local WHERE title LIKE 'Day % - %'
    UNION ALL SELECT 'daily:'||day||':0', day, '$100 gift certificate from Safe & Secure Firearms' FROM events_local
    UNION ALL SELECT 'event-bonus:'||id, day, trim(substr(summary, instr(lower(summary),'2nd drawing:')+12)) FROM events_local WHERE instr(lower(summary),'2nd drawing:')>0
), matched AS (
    SELECT w.id, min(s.slot) AS slot FROM raffle_winners w JOIN slots s ON s.day=w.draw_date
        AND substr(replace(replace(replace(lower(w.prize),'-',' '),',',''),'.',''), -length(replace(replace(replace(lower(s.description),'-',' '),',',''),'.','')))
            = replace(replace(replace(lower(s.description),'-',' '),',',''),'.','')
    WHERE w.raffle_key='2026-11' GROUP BY w.id HAVING count(*)=1
)
UPDATE raffle_winners SET prize_slot_id = (SELECT slot FROM matched WHERE matched.id = raffle_winners.id) WHERE id IN (SELECT id FROM matched);
