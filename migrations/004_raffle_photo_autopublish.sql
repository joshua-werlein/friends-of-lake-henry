-- Additive tables for unattended Facebook winner-photo publication. Does not alter raffle_winners or any existing table.
-- One row per Facebook post seen by the webhook, the polling fallback or an admin requeue (durable work queue).
CREATE TABLE IF NOT EXISTS raffle_photo_auto_posts (
    post_id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK(source IN ('webhook','poll','admin')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retry','done','ignored','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    locked_until TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_raffle_photo_auto_posts_due ON raffle_photo_auto_posts(status, next_attempt_at);
-- One row per Facebook photo. Any status except 'failed' is final, so a photo is never extracted or published twice.
CREATE TABLE IF NOT EXISTS raffle_photo_auto_imports (
    photo_id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('published','partial','duplicate','rejected','ignored','held','failed')),
    image_sha256 TEXT,
    image_width INTEGER,
    image_height INTEGER,
    model TEXT,
    extraction_json TEXT NOT NULL DEFAULT '[]',
    reasons_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_raffle_photo_auto_imports_recent ON raffle_photo_auto_imports(created_at DESC);
-- Immutable per-row audit: what was read, what happened and why. winner_id is a plain reference so an admin
-- can still edit or delete a published winner afterwards.
CREATE TABLE IF NOT EXISTS raffle_photo_auto_rows (
    photo_id TEXT NOT NULL,
    row_number INTEGER NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('inserted','duplicate','rejected','outside-window','held')),
    winner_id TEXT,
    prize TEXT,
    reasons_json TEXT NOT NULL DEFAULT '[]',
    row_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(photo_id, row_number)
);
