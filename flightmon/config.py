"""Load config.toml + environment secrets into one typed object."""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Contact:
    name: str
    phone: str


@dataclass
class Config:
    dry_run: bool
    booking_enabled: bool

    provider: str
    origins: list[str]
    currency: str
    cabin_class: str
    max_connections: int
    interval_minutes: int
    searches_per_cycle: int

    domestic_max_price: float
    international_max_price: float
    min_days_out: int
    max_days_out: int
    min_trip_days: int
    max_trip_days: int
    trip_lengths_to_search: list[int]

    domestic: list[str]
    international: list[str]

    timezone: str
    quiet_hours_start: int
    quiet_hours_end: int
    realert_drop_percent: float
    max_calls_per_cycle: int
    max_texts_per_cycle: int
    contacts: list[Contact]

    booking_mode: str
    max_price_increase_percent: float
    daily_spend_cap: float

    db_path: str
    travelers_path: str
    env: dict[str, str] = field(default_factory=dict)

    def secret(self, key: str) -> str:
        val = self.env.get(key, "")
        if not val:
            raise RuntimeError(f"Missing required setting {key} (set it in .env)")
        return val

    def is_domestic(self, iata: str) -> bool:
        return iata in self.domestic

    def max_price_for(self, destination: str) -> float:
        return self.domestic_max_price if self.is_domestic(destination) else self.international_max_price

    def contact(self, name: str) -> Contact:
        for c in self.contacts:
            if c.name == name:
                return c
        raise KeyError(name)

    def contact_by_phone(self, phone: str) -> Contact | None:
        for c in self.contacts:
            if c.phone == phone:
                return c
        return None

    def validate(self) -> None:
        problems = []
        if self.booking_mode not in ("responder", "both"):
            problems.append("booking.mode must be 'responder' or 'both'")
        if self.min_days_out >= self.max_days_out:
            problems.append("rules.min_days_out must be less than rules.max_days_out")
        if self.provider not in ("mock", "duffel", "ignav"):
            problems.append("search.provider must be mock, duffel or ignav")
        overlap = set(self.domestic) & set(self.international)
        if overlap:
            problems.append(f"destinations in both lists: {sorted(overlap)}")
        bad_lengths = [n for n in self.trip_lengths_to_search
                       if not self.min_trip_days <= n <= self.max_trip_days]
        if bad_lengths:
            problems.append(f"trip_lengths_to_search outside min/max trip days: {bad_lengths}")
        if not self.dry_run:
            for c in self.contacts:
                if not c.phone.startswith("+"):
                    problems.append(f"CONTACT_{c.name}_PHONE must be E.164, e.g. +12065550111")
        if problems:
            raise ValueError("Config problems:\n  - " + "\n  - ".join(problems))


def load_dotenv(path: str | Path = ".env") -> dict[str, str]:
    """Tiny .env reader (KEY=VALUE lines). Real environment variables win."""
    values: dict[str, str] = {}
    p = Path(path)
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip().strip('"').strip("'")
    values.update({k: v for k, v in os.environ.items()})
    return values


def load_config(config_path: str | None = None, env: dict[str, str] | None = None) -> Config:
    env = load_dotenv() if env is None else env
    path = config_path or env.get("FLIGHTMON_CONFIG", "config.toml")
    with open(path, "rb") as f:
        raw = tomllib.load(f)

    mode, search, rules = raw["mode"], raw["search"], raw["rules"]
    dests, alerts, booking = raw["destinations"], raw["alerts"], raw["booking"]

    contacts = [Contact(name=n, phone=env.get(f"CONTACT_{n}_PHONE", "")) for n in alerts["contacts"]]

    cfg = Config(
        dry_run=bool(mode.get("dry_run", True)),
        booking_enabled=bool(mode.get("booking_enabled", False)),
        provider=search.get("provider", "mock"),
        origins=[o.upper() for o in search["origins"]],
        currency=search.get("currency", "USD"),
        cabin_class=search.get("cabin_class", "economy"),
        max_connections=int(search.get("max_connections", 1)),
        interval_minutes=int(search.get("interval_minutes", 30)),
        searches_per_cycle=int(search.get("searches_per_cycle", 10)),
        domestic_max_price=float(rules["domestic_max_price"]),
        international_max_price=float(rules["international_max_price"]),
        min_days_out=int(rules["min_days_out"]),
        max_days_out=int(rules.get("max_days_out", 240)),
        min_trip_days=int(rules.get("min_trip_days", 2)),
        max_trip_days=int(rules["max_trip_days"]),
        trip_lengths_to_search=[int(x) for x in rules.get("trip_lengths_to_search", [3, 7, 14])],
        domestic=[d.upper() for d in dests["domestic"]],
        international=[d.upper() for d in dests["international"]],
        timezone=alerts.get("timezone", "America/Los_Angeles"),
        quiet_hours_start=int(alerts.get("quiet_hours_start", 22)),
        quiet_hours_end=int(alerts.get("quiet_hours_end", 8)),
        realert_drop_percent=float(alerts.get("realert_drop_percent", 10)),
        max_calls_per_cycle=int(alerts.get("max_calls_per_cycle", 1)),
        max_texts_per_cycle=int(alerts.get("max_texts_per_cycle", 5)),
        contacts=contacts,
        booking_mode=booking.get("mode", "responder"),
        max_price_increase_percent=float(booking.get("max_price_increase_percent", 5)),
        daily_spend_cap=float(booking.get("daily_spend_cap", 700)),
        db_path=env.get("FLIGHTMON_DB", "data/flightmon.sqlite3"),
        travelers_path=env.get("FLIGHTMON_TRAVELERS", "travelers.toml"),
        env=env,
    )
    cfg.validate()
    return cfg


def load_travelers(path: str) -> dict[str, dict]:
    p = Path(path)
    if not p.exists():
        raise RuntimeError(f"Booking needs {path} with passenger details (see travelers.example.toml)")
    with open(p, "rb") as f:
        data = tomllib.load(f)
    required = {"title", "given_name", "family_name", "born_on", "gender", "email", "phone_number"}
    for name, t in data.items():
        missing = required - set(t)
        if missing:
            raise RuntimeError(f"travelers.toml [{name}] missing {sorted(missing)}")
    return data
