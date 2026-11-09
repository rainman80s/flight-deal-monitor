-- Editable deal rules (the Logic panel). One JSON row per key; missing keys use config.json.
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);

-- Every round-trip price seen (calendar checks, Google Explore, site searches), used to learn
-- what's normal for each route so "good deal" can mean "cheap for this city".
CREATE TABLE IF NOT EXISTS price_obs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    depart_date TEXT NOT NULL,
    trip_days INTEGER NOT NULL,
    price REAL NOT NULL,
    source TEXT NOT NULL,            -- calendar | explore | search
    observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS price_obs_route ON price_obs(destination, origin, observed_at);
CREATE INDEX IF NOT EXISTS price_obs_time ON price_obs(observed_at);

-- What was "usual" for the route when a deal was found, and whether it was good enough to ping.
ALTER TABLE deals ADD COLUMN typical_low REAL;
ALTER TABLE deals ADD COLUMN typical_high REAL;
ALTER TABLE deals ADD COLUMN typical_median REAL;
ALTER TABLE deals ADD COLUMN ping_reason TEXT;   -- NULL = shown only, not pinged
