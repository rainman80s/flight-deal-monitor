"""The deal rules. A fare is a deal only if every check passes."""
from __future__ import annotations

from datetime import date

from .config import Config
from .models import Fare


def rejection_reason(cfg: Config, fare: Fare, today: date) -> str | None:
    """Return why a fare is NOT a deal, or None if it is one."""
    if fare.currency != cfg.currency:
        return f"currency {fare.currency} != {cfg.currency}"
    days_out = (fare.depart_date - today).days
    if days_out < cfg.min_days_out:
        return f"departs in {days_out} days (< {cfg.min_days_out})"
    if days_out > cfg.max_days_out:
        return f"departs in {days_out} days (> {cfg.max_days_out})"
    if fare.trip_days > cfg.max_trip_days:
        return f"trip is {fare.trip_days} days (> {cfg.max_trip_days})"
    if fare.trip_days < cfg.min_trip_days:
        return f"trip is {fare.trip_days} days (< {cfg.min_trip_days})"
    if fare.destination not in cfg.domestic and fare.destination not in cfg.international:
        return f"{fare.destination} not in destination lists"
    limit = cfg.max_price_for(fare.destination)
    if fare.price >= limit:
        kind = "domestic" if cfg.is_domestic(fare.destination) else "international"
        return f"${fare.price:.0f} not under {kind} limit ${limit:.0f}"
    return None


def is_deal(cfg: Config, fare: Fare, today: date) -> bool:
    return rejection_reason(cfg, fare, today) is None


def cheapest_per_route(fares: list[Fare]) -> list[Fare]:
    best: dict[str, Fare] = {}
    for f in fares:
        if f.route_key not in best or f.price < best[f.route_key].price:
            best[f.route_key] = f
    return list(best.values())
