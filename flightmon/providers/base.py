from __future__ import annotations

from typing import Protocol

from ..models import Fare, SearchQuery


class FareProvider(Protocol):
    name: str

    def search(self, q: SearchQuery) -> list[Fare]:
        """Return round-trip fares (per person) for exactly these dates."""
        ...


class BookingProvider(Protocol):
    name: str

    def reprice(self, origin: str, destination: str, depart: str, ret: str,
                passengers: int) -> tuple[str, float, str, list[str]] | None:
        """Fresh bookable offer for these exact dates.
        Returns (offer_id, total_price_for_all_passengers, currency, passenger_ids) or None."""
        ...

    def book(self, offer_id: str, amount: float, currency: str,
             passengers: list[dict]) -> tuple[str, str]:
        """Pay for and ticket the offer. Returns (order_id, airline_booking_reference)."""
        ...


def google_flights_url(origin: str, destination: str, depart: str, ret: str) -> str:
    """A pre-filled Google Flights search, used as the 'go book it yourself' link."""
    from urllib.parse import quote
    q = f"Flights from {origin} to {destination} on {depart} through {ret}"
    return f"https://www.google.com/travel/flights?q={quote(q)}"
