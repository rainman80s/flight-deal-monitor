"""Fake fares for dry runs and tests. Every fare it returns is marked is_fake=True,
and alerts built from it say FAKE TEST FARE so nobody mistakes it for a real deal."""
from __future__ import annotations

import hashlib

from ..models import Fare, SearchQuery
from .base import google_flights_url

AIRLINES = ["AS", "DL", "UA", "AA", "WN", "F9", "NK", "B6", "HA", "WS"]


class MockProvider:
    name = "mock"

    def __init__(self, deal_rate: float = 0.08):
        # Roughly this share of searches turn up a fare cheap enough to alert on.
        self.deal_rate = deal_rate

    def search(self, q: SearchQuery) -> list[Fare]:
        seed = int(hashlib.sha256(
            f"{q.origin}{q.destination}{q.depart_date}{q.return_date}".encode()).hexdigest(), 16)
        roll = (seed % 1000) / 1000
        intl = q.destination not in _DOMESTIC_HINT
        base = 320 + seed % 900 if intl else 115 + seed % 330
        if roll < self.deal_rate:
            base = (210 + seed % 85) if intl else (62 + seed % 35)
        fares = []
        for i in range(3):
            fares.append(Fare(
                provider=self.name, origin=q.origin, destination=q.destination,
                depart_date=q.depart_date, return_date=q.return_date,
                price=float(base + i * 23), currency="USD",
                airlines=[AIRLINES[(seed >> (i * 4)) % len(AIRLINES)]],
                outbound_stops=(seed >> 8) % 2, return_stops=(seed >> 9) % 2,
                offer_id=f"mock_{seed % 10**8}_{i}",
                booking_url=google_flights_url(q.origin, q.destination,
                                               q.depart_date.isoformat(), q.return_date.isoformat()),
                is_fake=True,
            ))
        return fares


_DOMESTIC_HINT = {
    "LAX", "SFO", "SAN", "LAS", "PHX", "DEN", "SLC", "ANC", "HNL", "OGG", "DFW", "AUS", "ORD",
    "MSP", "ATL", "MIA", "MCO", "BOS", "JFK", "EWR", "DCA", "MSY", "BNA", "SJC", "SMF", "BOI",
    "SEA", "PDX",
}
