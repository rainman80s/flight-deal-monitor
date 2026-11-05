-- People who signed up on the website for deal emails.
CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    origins TEXT NOT NULL,                 -- JSON array, e.g. ["SEA","PDX"]
    domestic_max REAL NOT NULL,
    international_max REAL NOT NULL,
    status TEXT NOT NULL,                  -- pending, active, unsubscribed
    created_at TEXT NOT NULL,
    confirmed_at TEXT,
    last_emailed_at TEXT
);

-- Per-IP signup attempts, for simple abuse throttling.
CREATE TABLE IF NOT EXISTS signup_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signup_attempts_ip ON signup_attempts(ip, at);
