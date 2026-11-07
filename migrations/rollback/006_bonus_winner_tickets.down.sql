-- Restores NOT NULL and removes prize slots. Refuses to run while any ticketless winner exists: never invent a ticket to make a
-- rollback pass. Rolling back code does NOT require this script, and the release runbook keeps newly entered winners by leaving the
-- schema in place. raffle_winner_corrections is deliberately kept because it is evidence.
DROP TABLE IF EXISTS raffle_winners_rollback;
DROP TABLE IF EXISTS raffle_winners_rollback_guard;
CREATE TABLE raffle_winners_rollback_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO raffle_winners_rollback_guard (ok) SELECT NOT EXISTS (SELECT 1 FROM raffle_winners WHERE ticket_number IS NULL);
CREATE TABLE raffle_winners_rollback (
    id TEXT PRIMARY KEY,
    raffle_key TEXT NOT NULL,
    draw_date TEXT NOT NULL,
    ticket_number INTEGER NOT NULL,
    winner_name TEXT NOT NULL,
    town TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    prize TEXT,
    ticket_number_text TEXT
);
INSERT INTO raffle_winners_rollback (rowid, id, raffle_key, draw_date, ticket_number, winner_name, town, created_at, prize, ticket_number_text)
    SELECT rowid, id, raffle_key, draw_date, ticket_number, winner_name, town, created_at, prize, ticket_number_text FROM raffle_winners ORDER BY rowid;
DELETE FROM raffle_winners_rollback_guard;
INSERT INTO raffle_winners_rollback_guard (ok) SELECT (SELECT count(*) FROM raffle_winners) = (SELECT count(*) FROM raffle_winners_rollback);
DROP TABLE raffle_winners_rollback_guard;
DROP TABLE raffle_winners;
ALTER TABLE raffle_winners_rollback RENAME TO raffle_winners;
CREATE INDEX idx_raffle_winners_raffle_date ON raffle_winners(raffle_key, draw_date);
CREATE UNIQUE INDEX uniq_raffle_day_ticket ON raffle_winners (raffle_key, draw_date, ticket_number);
