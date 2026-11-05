-- INTEGER affinity discards leading zeros. Keep numeric identity and an optional exact manual label.
ALTER TABLE raffle_winners ADD COLUMN ticket_number_text TEXT;
