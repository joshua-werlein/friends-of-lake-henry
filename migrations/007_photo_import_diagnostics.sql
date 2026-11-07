-- Additive diagnostics for the winner-photo importer. No winner data is touched and no existing column changes.
-- error_code remains the current failure. last_error_* survive a later success or requeue.
ALTER TABLE raffle_photo_auto_posts ADD COLUMN last_error_code TEXT;
ALTER TABLE raffle_photo_auto_posts ADD COLUMN last_error_at TEXT;
-- status says the queue finished. publication_status says what that run actually did to winners.
ALTER TABLE raffle_photo_auto_posts ADD COLUMN publication_status TEXT;
ALTER TABLE raffle_photo_auto_posts ADD COLUMN publication_json TEXT;
-- Sanitized per-attempt, per-pass and per-row history: counts and reason codes, never names, URLs or tokens.
CREATE TABLE IF NOT EXISTS raffle_photo_auto_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id TEXT NOT NULL,
    photo_id TEXT,
    attempt INTEGER,
    stage TEXT NOT NULL CHECK(stage IN ('post','photo','pass','row')),
    pass_number INTEGER,
    row_number INTEGER,
    outcome TEXT NOT NULL,
    code TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_raffle_photo_auto_attempts_post ON raffle_photo_auto_attempts(post_id, id DESC);
