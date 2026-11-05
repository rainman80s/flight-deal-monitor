from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime


@dataclass(frozen=True)
class SearchQuery:
    origin: str
    destination: str
    depart_date: date
    return_date: date

    @property
    def trip_days(self) -> int:
        return (self.return_date - self.depart_date).days


@dataclass
class Fare:
    """One round-trip fare, per person."""
    provider: str
    origin: str
    destination: str
    depart_date: date
    return_date: date
    price: float
    currency: str
    airlines: list[str] = field(default_factory=list)
    outbound_stops: int = 0
    return_stops: int = 0
    offer_id: str | None = None          # provider's id, used to re-price/book
    expires_at: datetime | None = None
    booking_url: str | None = None
    is_fake: bool = False                # True for mock-provider data

    @property
    def trip_days(self) -> int:
        return (self.return_date - self.depart_date).days

    @property
    def route_key(self) -> str:
        return f"{self.origin}-{self.destination}-{self.depart_date}-{self.return_date}"
