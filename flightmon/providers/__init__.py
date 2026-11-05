from __future__ import annotations

from ..config import Config


def make_fare_provider(cfg: Config):
    if cfg.provider == "mock":
        from .mock import MockProvider
        return MockProvider()
    if cfg.provider == "duffel":
        from .duffel_provider import DuffelProvider
        return DuffelProvider(cfg.secret("DUFFEL_ACCESS_TOKEN"), cfg.cabin_class, cfg.max_connections)
    if cfg.provider == "ignav":
        from .ignav import IgnavProvider
        return IgnavProvider(cfg.secret("IGNAV_API_KEY"))
    raise ValueError(cfg.provider)


def make_booking_provider(cfg: Config):
    """Booking always goes through Duffel, whichever provider found the fare."""
    from .duffel_provider import DuffelProvider
    return DuffelProvider(cfg.secret("DUFFEL_ACCESS_TOKEN"), cfg.cabin_class, cfg.max_connections)
