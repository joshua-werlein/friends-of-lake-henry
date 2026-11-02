-- Additive supplemental prizes only. Published events remain the main-prize source.
CREATE TABLE IF NOT EXISTS raffle_prize_supplements (
 id TEXT PRIMARY KEY,
 raffle_key TEXT NOT NULL,
 draw_date TEXT NOT NULL,
 category TEXT NOT NULL,
 position INTEGER CHECK(position IS NULL OR position BETWEEN 1 AND 3),
 description TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','rejected')),
 source_poster_key TEXT,
 source_hash TEXT,
 version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_raffle_prize_supplements_month ON raffle_prize_supplements(raffle_key,status,draw_date);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_raffle_prize_supplement_text
 ON raffle_prize_supplements(raffle_key,draw_date,category,coalesce(position,0),lower(trim(description))) WHERE status IN ('draft','approved');
CREATE UNIQUE INDEX IF NOT EXISTS uniq_raffle_prize_supplement_slot
 ON raffle_prize_supplements(raffle_key,draw_date,category,position) WHERE status='approved' AND position IS NOT NULL;
CREATE TABLE IF NOT EXISTS raffle_prize_review_log (
 id TEXT PRIMARY KEY,
 prize_id TEXT NOT NULL,
 action TEXT NOT NULL,
 before_json TEXT,
 after_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
