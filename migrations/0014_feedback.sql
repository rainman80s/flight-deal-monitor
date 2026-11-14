-- Feedback from beta testers (and owners), read on the Admin page. The message is encrypted at rest.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- bug | idea | other
  page TEXT,                       -- where they were on the site, e.g. "browse", "signup"
  message_enc TEXT NOT NULL,
  device TEXT,                     -- "iPhone · Safari" style hint, no full user agent
  status TEXT NOT NULL DEFAULT 'new', -- new | done
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_status ON feedback(status, id);
