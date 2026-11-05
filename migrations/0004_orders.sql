-- Purchases made from the website's booking sheet (offer-based, one row per Duffel offer).
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    offer_id TEXT UNIQUE NOT NULL,        -- never book the same offer twice
    requested_by TEXT NOT NULL,           -- contact name that pressed Buy
    travelers TEXT NOT NULL,              -- JSON array of contact names
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    depart_date TEXT NOT NULL,
    return_date TEXT NOT NULL,
    status TEXT NOT NULL,                 -- pending, booked, failed
    amount REAL,
    currency TEXT,
    test_mode INTEGER NOT NULL,
    duffel_order_id TEXT,
    booking_reference TEXT,
    detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at);
