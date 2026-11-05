"""Ignav fare-search adapter: NOT IMPLEMENTED YET.

Ignav is the cheaper option for high-volume searching (reported: 1,000 free
requests, then about $2 per 1,000). Its API docs couldn't be reached from the
environment this was built in, so the request/response mapping hasn't been written.
It is left unimplemented on purpose, with no guessed field names.

To finish: read Ignav's round-trip fare endpoint docs, then implement search() to
map one SearchQuery to their request and their response to a list[Fare]
(per-person round-trip price). Ignav does not ticket, so booking still goes
through Duffel (see booking.py).
"""
from __future__ import annotations

from ..models import Fare, SearchQuery


class IgnavProvider:
    name = "ignav"

    def __init__(self, api_key: str):
        self.api_key = api_key

    def search(self, q: SearchQuery) -> list[Fare]:
        raise NotImplementedError(
            "Ignav adapter not written yet (docs were unreachable at build time). "
            "Use provider = 'duffel' or 'mock' for now; see flightmon/providers/ignav.py.")
