-- A deal is hidden once a later price check for the same trip finds it noticeably more expensive.
ALTER TABLE deals ADD COLUMN superseded_at TEXT;
CREATE INDEX IF NOT EXISTS deals_found ON deals(found_at);
