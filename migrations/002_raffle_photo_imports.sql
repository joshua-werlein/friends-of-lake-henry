-- Additive, review-only import staging. Does not modify existing raffle_winners or their indexes.
CREATE TABLE IF NOT EXISTS raffle_photo_imports (
    id TEXT PRIMARY KEY,
    photo_id TEXT NOT NULL UNIQUE,
    post_id TEXT,
    source_url TEXT NOT NULL,
    month_hint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('processing','pending','approved','rejected','failed')),
    image_key TEXT,
    image_sha256 TEXT,
    image_mime TEXT,
    image_width INTEGER,
    image_height INTEGER,
    model TEXT,
    extraction_json TEXT NOT NULL DEFAULT '{}',
    rows_json TEXT NOT NULL DEFAULT '[]',
    approved_rows_json TEXT NOT NULL DEFAULT '[]',
    error_code TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 1,
    review_nonce TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_raffle_photo_imports_status ON raffle_photo_imports(status, created_at DESC);
CREATE TABLE IF NOT EXISTS raffle_photo_import_rows (
    import_id TEXT NOT NULL REFERENCES raffle_photo_imports(id),
    row_number INTEGER NOT NULL,
    review_nonce TEXT NOT NULL,
    winner_id TEXT REFERENCES raffle_winners(id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    draw_date TEXT NOT NULL,
    ticket_number INTEGER NOT NULL,
    winner_name TEXT NOT NULL,
    town TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('insert','fill')),
    PRIMARY KEY(import_id, row_number)
);
-- Abort the entire approval transaction if a concurrent change or duplicate prevented
-- insertion/fill. The original winner values and pending draft survive a rollback.
CREATE TRIGGER IF NOT EXISTS raffle_photo_import_row_check
BEFORE INSERT ON raffle_photo_import_rows
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM raffle_photo_imports WHERE id=NEW.import_id
        AND status='approved' AND review_nonce=NEW.review_nonce
    ) THEN RAISE(ABORT, 'Import approval changed') END;
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM raffle_winners WHERE id=NEW.winner_id
        AND draw_date=NEW.draw_date AND ticket_number=NEW.ticket_number
        AND winner_name=NEW.winner_name AND town=NEW.town
    ) THEN RAISE(ABORT, 'Winner conflict or concurrent change') END;
END;
