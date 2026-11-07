-- Rollback for 008. Removes only alert bookkeeping; no winner, photo or queue data is affected.
-- Preferred rollback is to leave these tables in place (older code ignores them; dropping loses deduplication history).
-- Disable alerts (ALERTS_ENABLED=false) or deploy the previous photo Worker first.
DROP TABLE IF EXISTS ops_webhook_receipts;
DROP INDEX IF EXISTS idx_ops_alert_incidents_active;
DROP TABLE IF EXISTS ops_alert_incidents;
