-- Member accounts: anyone who signs in with a verified email. Owners stay in config
-- (alerts.contacts) and never get a row here. Alert settings stay in subscribers,
-- matched by email.
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    session_version INTEGER NOT NULL DEFAULT 1   -- bump to sign out every device
);

-- Sign-in links already used (so each works once). Rows are deleted after they expire.
CREATE TABLE IF NOT EXISTS used_links (
    sig TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL                  -- unix seconds
);
