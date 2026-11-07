-- Additive: email-alert bookkeeping for the winner-photo Worker. No existing table or column changes.
-- One row per stable incident ID. record_json holds the full incident, including the frozen email envelope
-- (idempotency key + exact payload) that is stored BEFORE any send, and a short delivery ledger.
-- Written only when an incident opens, is planned for delivery, is delivered, recovers or closes.
CREATE TABLE IF NOT EXISTS ops_alert_incidents (
    incident_id TEXT PRIMARY KEY,
    system TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','recovering','resolved')),
    first_seen_at TEXT NOT NULL,
    notified_at TEXT,
    next_delivery_at TEXT,
    record_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_ops_alert_incidents_active ON ops_alert_incidents(system, status, first_seen_at);
-- Signed-webhook receipt per Facebook post, independent of which path (webhook, poll, admin) queued the post.
-- Written only while ALERT_WEBHOOK_DELIVERY_ENABLED=true. The 'tracking-start' row marks when recording began.
CREATE TABLE IF NOT EXISTS ops_webhook_receipts (
    post_id TEXT PRIMARY KEY,
    first_received_at TEXT NOT NULL
);
