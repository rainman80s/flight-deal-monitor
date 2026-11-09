-- Deals found by Google Explore can be to places outside the configured destination
-- lists, so a deal records whether it's domestic and the destination's display name.
ALTER TABLE deals ADD COLUMN kind TEXT;        -- domestic | international (NULL = from the lists)
ALTER TABLE deals ADD COLUMN dest_name TEXT;   -- e.g. "Los Angeles" (NULL = use the built-in name)
