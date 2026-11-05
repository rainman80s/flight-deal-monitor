"""Decide which searches to run each cycle.

Searching every origin x destination x date combo every 30 minutes would cost a
fortune, so each cycle runs a small slice and rotates. Over a day, every route
gets checked many times across a spread of departure dates and trip lengths.
"""
from __future__ import annotations

from datetime import date, timedelta

from .config import Config
from .models import SearchQuery


def all_routes(cfg: Config) -> list[tuple[str, str]]:
    dests = cfg.domestic + cfg.international
    return [(o, d) for d in dests for o in cfg.origins if o != d]


def plan_cycle(cfg: Config, cycle: int, today: date) -> list[SearchQuery]:
    routes = all_routes(cfg)
    if not routes:
        return []
    n = min(cfg.searches_per_cycle, len(routes))
    window = cfg.max_days_out - cfg.min_days_out
    lengths = cfg.trip_lengths_to_search
    queries = []
    for i in range(n):
        slot = cycle * n + i
        origin, dest = routes[slot % len(routes)]
        # Each full pass over the routes shifts dates and trip length, so the same
        # route gets a different date next time around.
        pass_no = slot // len(routes)
        offset = (pass_no * 17 + (slot % len(routes)) * 7) % (window + 1)
        depart = today + timedelta(days=cfg.min_days_out + offset)
        length = lengths[(pass_no + slot) % len(lengths)]
        ret = depart + timedelta(days=length)
        queries.append(SearchQuery(origin, dest, depart, ret))
    return queries
