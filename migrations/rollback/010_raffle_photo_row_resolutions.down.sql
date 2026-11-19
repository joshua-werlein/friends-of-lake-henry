-- Optional and destructive: it discards the administrator review audit. Older code ignores the table, so leaving it in place
-- is the preferred rollback. Published winners and raffle_photo_auto_rows are not affected by either choice.
DROP INDEX IF EXISTS idx_raffle_photo_row_resolutions_winner;
DROP TABLE IF EXISTS raffle_photo_row_resolutions;
