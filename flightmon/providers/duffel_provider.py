"""Duffel adapter: search (offer requests) and booking (orders).

Uses the official duffel-api SDK. Booking pays from your pre-funded Duffel
balance (payment type "balance"); Duffel does not charge a card from this code.
Use a test token (duffel_test_...) until you trust it: test mode books fake
airline "Duffel Airways" with no real money.

Cost note: Duffel charges an excess-search fee if searches greatly outnumber
bookings (reported ~1,500:1). For high-volume monitoring, search with a cheaper
provider and use Duffel only for re-pricing and booking.
"""
from __future__ import annotations

import logging
from datetime import date

from ..models import Fare, SearchQuery
from .base import google_flights_url

log = logging.getLogger(__name__)


def _client(token: str):
    from duffel_api import Duffel
    return Duffel(access_token=token)


def _slices(origin: str, destination: str, depart: str, ret: str) -> list[dict]:
    return [
        {"origin": origin, "destination": destination, "departure_date": depart},
        {"origin": destination, "destination": origin, "departure_date": ret},
    ]


class DuffelProvider:
    name = "duffel"

    def __init__(self, token: str, cabin_class: str = "economy", max_connections: int = 1):
        self.token = token
        self.cabin_class = cabin_class
        self.max_connections = max_connections
        self._duffel = None

    @property
    def duffel(self):
        if self._duffel is None:
            self._duffel = _client(self.token)
        return self._duffel

    def _offers(self, origin, destination, depart, ret, passengers=1):
        req = (self.duffel.offer_requests.create()
               .passengers([{"type": "adult"} for _ in range(passengers)])
               .slices(_slices(origin, destination, depart, ret))
               .cabin_class(self.cabin_class)
               .max_connections(self.max_connections)
               .return_offers()
               .execute())
        return list(req.offers or [])

    # --- FareProvider ---
    def search(self, q: SearchQuery) -> list[Fare]:
        offers = self._offers(q.origin, q.destination, q.depart_date.isoformat(),
                              q.return_date.isoformat())
        fares = []
        for o in offers:
            try:
                out, back = o.slices[0], o.slices[1]
                carriers = sorted({s.marketing_carrier.iata_code or s.marketing_carrier.name
                                   for sl in o.slices for s in sl.segments})
                fares.append(Fare(
                    provider=self.name, origin=q.origin, destination=q.destination,
                    depart_date=q.depart_date, return_date=q.return_date,
                    price=float(o.total_amount), currency=o.total_currency,
                    airlines=carriers,
                    outbound_stops=len(out.segments) - 1, return_stops=len(back.segments) - 1,
                    offer_id=o.id, expires_at=o.expires_at,
                    booking_url=google_flights_url(q.origin, q.destination,
                                                   q.depart_date.isoformat(), q.return_date.isoformat()),
                ))
            except (AttributeError, IndexError, TypeError, ValueError) as e:
                log.warning("skipping unparseable Duffel offer %s: %s", getattr(o, "id", "?"), e)
        return fares

    # --- BookingProvider ---
    def reprice(self, origin, destination, depart, ret, passengers):
        """Always search fresh: offers expire (~30 min) and alerts may be older."""
        offers = self._offers(origin, destination, depart, ret, passengers)
        if not offers:
            return None
        best = min(offers, key=lambda o: float(o.total_amount))
        return best.id, float(best.total_amount), best.total_currency, [p.id for p in best.passengers]

    def book(self, offer_id, amount, currency, passengers):
        order = (self.duffel.orders.create()
                 .selected_offers([offer_id])
                 .passengers(passengers)
                 .payments([{"type": "balance", "amount": f"{amount:.2f}", "currency": currency}])
                 .execute())
        return order.id, order.booking_reference
