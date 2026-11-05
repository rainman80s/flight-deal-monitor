-- Passenger details entered on the Account page, one row per contact.
-- `data` is AES-GCM encrypted JSON (key derived from LINK_SECRET); never stored in the clear.
CREATE TABLE IF NOT EXISTS traveler_profiles (
    contact TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL
);
