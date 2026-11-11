-- Which places a member wants alerts for (JSON array of airport codes; NULL = everywhere),
-- and whether to skip fares with stops.
ALTER TABLE users ADD COLUMN destinations TEXT;
ALTER TABLE users ADD COLUMN nonstop_only INTEGER NOT NULL DEFAULT 0;
