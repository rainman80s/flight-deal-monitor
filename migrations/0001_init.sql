CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    route_key TEXT NOT NULL,
    provider TEXT NOT NULL,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    depart_date TEXT NOT NULL,
    return_date TEXT NOT NULL,
    price REAL NOT NULL,
    currency TEXT NOT NULL,
    airlines TEXT NOT NULL,
    outbound_stops INTEGER NOT NULL,
    return_stops INTEGER NOT NULL,
    offer_id TEXT,
    booking_url TEXT,
    is_fake INTEGER NOT NULL,
    found_at TEXT NOT NULL,
    alerted_at TEXT
);
CREATE INDEX IF NOT EXISTS deals_route ON deals(route_key);

CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    contact TEXT NOT NULL,
    answer TEXT NOT NULL,      -- buy_requested, confirmed, cancelled, skip
    channel TEXT NOT NULL,     -- call, sms
    at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    traveler TEXT NOT NULL,
    status TEXT NOT NULL,      -- pending, booked, failed, link_sent, dry_run
    amount REAL,
    currency TEXT,
    provider_order_id TEXT,
    booking_reference TEXT,
    detail TEXT,
    at TEXT NOT NULL,
    UNIQUE(deal_id, traveler)
);
