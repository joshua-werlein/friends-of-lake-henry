-- Additive audit of administrator review of held or rejected winner-photo rows (Admin > Raffle > Photo imports).
-- No existing table or column changes; no winner data is touched. Requires 004 only and does not depend on 009, so it applies to
-- the 001-008 schema of the existing production account and of the staged nonprofit account. Older code ignores this table.
-- One resolution per photo row: the UNIQUE constraint makes a repeated or concurrent approval fail instead of publishing twice.
-- The original extraction (row, reasons, outcome, prize) is copied here before the review changes raffle_photo_auto_rows.
CREATE TABLE IF NOT EXISTS raffle_photo_row_resolutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id TEXT NOT NULL,
    row_number INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('approve','edit','resolve')),
    final_status TEXT NOT NULL CHECK(final_status IN ('published','resolved')),
    original_outcome TEXT NOT NULL,
    original_row_json TEXT NOT NULL,
    original_reasons_json TEXT NOT NULL DEFAULT '[]',
    original_prize TEXT,
    published_json TEXT,
    corrections_json TEXT NOT NULL DEFAULT '{}',
    winner_id TEXT,
    note TEXT,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(photo_id, row_number)
);
CREATE INDEX IF NOT EXISTS idx_raffle_photo_row_resolutions_winner ON raffle_photo_row_resolutions(winner_id);
