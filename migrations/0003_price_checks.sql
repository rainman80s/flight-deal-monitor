-- Every calendar price check (background scans and on-site searches), kept so the site can
-- show what was checked and reuse recent results instead of spending another request.
CREATE TABLE IF NOT EXISTS price_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    window_start TEXT NOT NULL,     -- first departure date checked (YYYY-MM-DD)
    window_days INTEGER NOT NULL,
    stay_days INTEGER NOT NULL,
    dates TEXT NOT NULL,            -- JSON [{d: depart, r: return, p: price|null}]
    cheapest REAL,
    cheapest_date TEXT,
    price_limit REAL,
    source TEXT NOT NULL,           -- scan | search
    checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS price_checks_lookup
    ON price_checks(origin, destination, window_start, window_days, stay_days, checked_at);
CREATE INDEX IF NOT EXISTS price_checks_recent ON price_checks(checked_at);
