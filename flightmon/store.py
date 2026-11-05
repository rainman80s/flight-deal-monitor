"""SQLite storage: deals log, dedupe, pending confirmations, bookings."""
from __future__ import annotations

import json
import secrets
import sqlite3
import threading
from datetime import date, datetime, timezone
from pathlib import Path

from .models import Fare

SCHEMA = """
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,           -- short code people text back, e.g. K7Q2
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
    answer TEXT NOT NULL,                -- buy_requested, confirmed, skip
    channel TEXT NOT NULL,               -- call, sms, cli
    at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deal_id INTEGER NOT NULL REFERENCES deals(id),
    traveler TEXT NOT NULL,
    status TEXT NOT NULL,                -- pending, booked, failed, link_sent, dry_run
    amount REAL,
    currency TEXT,
    provider_order_id TEXT,
    booking_reference TEXT,
    detail TEXT,
    at TEXT NOT NULL,
    UNIQUE(deal_id, traveler)
);
"""

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I/L confusion


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.executescript(SCHEMA)
            self._db.commit()

    # --- generic state ---
    def get_state(self, key: str, default: str | None = None) -> str | None:
        row = self._db.execute("SELECT value FROM state WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def set_state(self, key: str, value: str) -> None:
        with self._lock:
            self._db.execute("INSERT INTO state(key,value) VALUES(?,?) "
                             "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))
            self._db.commit()

    def next_cycle(self) -> int:
        n = int(self.get_state("cycle", "0"))
        self.set_state("cycle", str(n + 1))
        return n

    # --- deals ---
    def last_alerted_price(self, route_key: str) -> float | None:
        row = self._db.execute(
            "SELECT price FROM deals WHERE route_key=? AND alerted_at IS NOT NULL "
            "ORDER BY id DESC LIMIT 1", (route_key,)).fetchone()
        return row["price"] if row else None

    def should_alert(self, fare: Fare, realert_drop_percent: float) -> bool:
        last = self.last_alerted_price(fare.route_key)
        if last is None:
            return True
        return fare.price <= last * (1 - realert_drop_percent / 100)

    def add_deal(self, fare: Fare) -> sqlite3.Row:
        with self._lock:
            while True:
                code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(4))
                if not self._db.execute("SELECT 1 FROM deals WHERE code=?", (code,)).fetchone():
                    break
            cur = self._db.execute(
                "INSERT INTO deals(code,route_key,provider,origin,destination,depart_date,return_date,"
                "price,currency,airlines,outbound_stops,return_stops,offer_id,booking_url,is_fake,found_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (code, fare.route_key, fare.provider, fare.origin, fare.destination,
                 fare.depart_date.isoformat(), fare.return_date.isoformat(), fare.price, fare.currency,
                 json.dumps(fare.airlines), fare.outbound_stops, fare.return_stops, fare.offer_id,
                 fare.booking_url, int(fare.is_fake), _now()))
            self._db.commit()
        return self.deal(cur.lastrowid)

    def mark_alerted(self, deal_id: int) -> None:
        with self._lock:
            self._db.execute("UPDATE deals SET alerted_at=? WHERE id=?", (_now(), deal_id))
            self._db.commit()

    def deal(self, deal_id: int) -> sqlite3.Row | None:
        return self._db.execute("SELECT * FROM deals WHERE id=?", (deal_id,)).fetchone()

    def deal_by_code(self, code: str) -> sqlite3.Row | None:
        return self._db.execute("SELECT * FROM deals WHERE code=?", (code.upper(),)).fetchone()

    def recent_deals(self, limit: int = 20) -> list[sqlite3.Row]:
        return self._db.execute("SELECT * FROM deals ORDER BY id DESC LIMIT ?", (limit,)).fetchall()

    # --- responses ---
    def add_response(self, deal_id: int, contact: str, answer: str, channel: str) -> None:
        with self._lock:
            self._db.execute("INSERT INTO responses(deal_id,contact,answer,channel,at) VALUES(?,?,?,?,?)",
                             (deal_id, contact, answer, channel, _now()))
            self._db.commit()

    def latest_response(self, deal_id: int, contact: str) -> str | None:
        row = self._db.execute("SELECT answer FROM responses WHERE deal_id=? AND contact=? "
                               "ORDER BY id DESC LIMIT 1", (deal_id, contact)).fetchone()
        return row["answer"] if row else None

    # --- bookings ---
    def claim_booking(self, deal_id: int, traveler: str) -> bool:
        """Reserve the (deal, traveler) slot. False if one already exists -> never double-book."""
        with self._lock:
            try:
                self._db.execute("INSERT INTO bookings(deal_id,traveler,status,at) VALUES(?,?,?,?)",
                                 (deal_id, traveler, "pending", _now()))
                self._db.commit()
                return True
            except sqlite3.IntegrityError:
                return False

    def finish_booking(self, deal_id: int, traveler: str, status: str, amount: float | None = None,
                       currency: str | None = None, order_id: str | None = None,
                       reference: str | None = None, detail: str | None = None) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE bookings SET status=?,amount=?,currency=?,provider_order_id=?,"
                "booking_reference=?,detail=?,at=? WHERE deal_id=? AND traveler=?",
                (status, amount, currency, order_id, reference, detail, _now(), deal_id, traveler))
            self._db.commit()

    def release_booking(self, deal_id: int, traveler: str) -> None:
        """Remove a claim that never reached the airline, so it can be retried."""
        with self._lock:
            self._db.execute("DELETE FROM bookings WHERE deal_id=? AND traveler=? AND status='pending'",
                             (deal_id, traveler))
            self._db.commit()

    def spent_on(self, day: date) -> float:
        row = self._db.execute(
            "SELECT COALESCE(SUM(amount),0) AS s FROM bookings WHERE status IN ('booked','pending') "
            "AND substr(at,1,10)=?", (day.isoformat(),)).fetchone()
        return float(row["s"])

    def bookings(self, limit: int = 20) -> list[sqlite3.Row]:
        return self._db.execute("SELECT * FROM bookings ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
