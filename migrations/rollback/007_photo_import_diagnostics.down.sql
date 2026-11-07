-- Optional. Older code ignores these additions, so leaving them in place is the preferred rollback.
DROP TABLE IF EXISTS raffle_photo_auto_attempts;
ALTER TABLE raffle_photo_auto_posts DROP COLUMN publication_json;
ALTER TABLE raffle_photo_auto_posts DROP COLUMN publication_status;
ALTER TABLE raffle_photo_auto_posts DROP COLUMN last_error_at;
ALTER TABLE raffle_photo_auto_posts DROP COLUMN last_error_code;
