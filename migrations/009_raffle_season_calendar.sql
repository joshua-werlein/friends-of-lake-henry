-- Additive only: per-month prize-calendar review and recurring (every drawing day) prizes, replacing the
-- November 2026 constants in code. Existing tables, rows and ids are unchanged; old code ignores these columns.
ALTER TABLE raffle_months ADD COLUMN calendar_status TEXT NOT NULL DEFAULT 'draft' CHECK(calendar_status IN ('draft','approved'));
ALTER TABLE raffle_months ADD COLUMN calendar_approved_at TEXT;
-- Winner-table column heading that names the day's published main prize (November 2026: "Firearm").
ALTER TABLE raffle_months ADD COLUMN main_prize_heading TEXT;
CREATE TABLE IF NOT EXISTS raffle_recurring_prizes (
 id TEXT PRIMARY KEY,
 raffle_key TEXT NOT NULL,
 slot INTEGER NOT NULL CHECK(slot >= 0),
 category TEXT NOT NULL,
 position INTEGER CHECK(position IS NULL OR position BETWEEN 2 AND 3),
 description TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected')),
 source_poster_key TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- slot is part of the stored winner prize_slot_id (daily:<date>:<slot>) and is never reused within a month.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_raffle_recurring_slot ON raffle_recurring_prizes(raffle_key, slot);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_raffle_recurring_text ON raffle_recurring_prizes(raffle_key, lower(trim(description))) WHERE status IN ('draft','approved');
-- November 2026: the daily gift certificate printed on the verified poster (formerly DAILY_PRIZES), already reviewed.
INSERT OR IGNORE INTO raffle_recurring_prizes (id, raffle_key, slot, category, position, description, notes, status)
 VALUES ('recurring-2026-11-0', '2026-11', 0, 'Gift card', 2, '$100 gift certificate from Safe & Secure Firearms', 'Printed daily on the verified raffle poster.', 'approved');
INSERT OR IGNORE INTO raffle_months (month_key, title) VALUES ('2026-11', '');
UPDATE raffle_months SET calendar_status = 'approved', calendar_approved_at = '2026-11-01T06:00:00.000Z', main_prize_heading = 'Firearm'
 WHERE month_key = '2026-11';
