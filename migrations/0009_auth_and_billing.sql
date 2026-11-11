-- Real accounts: passwords, Google/Apple sign-in, server-side sessions, subscriptions,
-- and per-user rules and alerts.
--
-- Personal data is never stored in the clear:
--   email_enc / name_enc   AES-256-GCM, key derived from LINK_SECRET (bound to the row's purpose)
--   email_index            HMAC-SHA256 of the lowercased email, for lookups without decrypting
--   password_hash          PBKDF2-SHA256, per-user salt, plus a server-side pepper
--   session/token ids      only their SHA-256 is stored; the raw value lives in the cookie or email link

-- The magic-link-only accounts and free email sign-ups from before are replaced. (At the time of
-- this migration there were no accounts and no confirmed sign-ups.)
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS used_links;
DROP TABLE IF EXISTS subscribers;
DROP TABLE IF EXISTS signup_attempts;

CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email_index TEXT UNIQUE NOT NULL,
    email_enc TEXT NOT NULL,
    name_enc TEXT,
    password_hash TEXT,                       -- NULL for Google/Apple-only accounts
    role TEXT NOT NULL DEFAULT 'member',      -- member | admin
    contact TEXT,                             -- admins: the config contact (RAN, BROCK) for booking
    email_verified INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,  -- unix seconds
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    password_changed_at TEXT,
    -- billing (Stripe)
    stripe_customer_id TEXT UNIQUE,
    subscription_id TEXT,
    subscription_status TEXT,                 -- active, trialing, past_due, canceled, ...
    current_period_end INTEGER,               -- unix seconds
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    -- personal settings
    alerts_on INTEGER NOT NULL DEFAULT 1,
    origins TEXT NOT NULL DEFAULT '["SEA","PDX"]',
    rules TEXT                                -- JSON categories; NULL = the site defaults
);

CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

-- One-time tokens sent by email: verify an address, reset a password.
CREATE TABLE auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,                    -- verify | reset
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id, purpose);

-- Google / Apple sign-ins linked to an account.
CREATE TABLE identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

-- Which deals each person has already been emailed about.
CREATE TABLE user_alerts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    deal_id INTEGER NOT NULL,
    sent_at TEXT NOT NULL,
    PRIMARY KEY (user_id, deal_id)
);
CREATE INDEX user_alerts_time ON user_alerts(user_id, sent_at);

-- Stripe webhook events already handled (Stripe can deliver the same event more than once).
CREATE TABLE stripe_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at TEXT NOT NULL
);
