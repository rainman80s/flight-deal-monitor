"""One search cycle: plan -> search -> filter -> dedupe -> alert."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date, datetime
from zoneinfo import ZoneInfo

from . import messages
from .config import Config
from .planner import plan_cycle
from .rules import cheapest_per_route, rejection_reason
from .store import Store

log = logging.getLogger(__name__)


@dataclass
class CycleResult:
    cycle: int
    searches: int = 0
    errors: int = 0
    fares_seen: int = 0
    deals: list = field(default_factory=list)       # deal rows alerted this cycle
    suppressed: int = 0                              # deals already alerted at this price


def in_quiet_hours(cfg: Config, now: datetime) -> bool:
    h = now.astimezone(ZoneInfo(cfg.timezone)).hour
    s, e = cfg.quiet_hours_start, cfg.quiet_hours_end
    if s == e:
        return False
    return (s <= h or h < e) if s > e else (s <= h < e)


def alert(cfg: Config, store: Store, notifier, deal, call: bool) -> None:
    kind = "domestic" if cfg.is_domestic(deal["destination"]) else "international"
    body = messages.deal_text(deal, kind, cfg.max_price_for(deal["destination"]),
                              cfg.booking_enabled and not cfg.dry_run)
    for c in cfg.contacts:
        try:
            notifier.sms(c.phone, body)
        except Exception:
            log.exception("text to %s failed", c.name)
        if call:
            try:
                notifier.call(c.phone, deal["code"], c.name)
            except Exception:
                log.exception("call to %s failed", c.name)
    store.mark_alerted(deal["id"])


def run_cycle(cfg: Config, store: Store, provider, notifier,
              now: datetime | None = None) -> CycleResult:
    now = now or datetime.now(ZoneInfo(cfg.timezone))
    today: date = now.astimezone(ZoneInfo(cfg.timezone)).date()
    cycle = store.next_cycle()
    result = CycleResult(cycle=cycle)

    fares = []
    for q in plan_cycle(cfg, cycle, today):
        result.searches += 1
        try:
            found = provider.search(q)
        except NotImplementedError:
            raise
        except Exception as e:
            result.errors += 1
            log.warning("search %s-%s %s/%s failed: %s", q.origin, q.destination,
                        q.depart_date, q.return_date, e)
            continue
        result.fares_seen += len(found)
        fares.extend(found)

    candidates = []
    for f in cheapest_per_route(fares):
        reason = rejection_reason(cfg, f, today)
        if reason:
            log.debug("reject %s $%.0f: %s", f.route_key, f.price, reason)
            continue
        if not store.should_alert(f, cfg.realert_drop_percent):
            result.suppressed += 1
            continue
        candidates.append(f)

    # Best deals first: lowest price relative to that destination's limit.
    candidates.sort(key=lambda f: f.price / cfg.max_price_for(f.destination))
    quiet = in_quiet_hours(cfg, now)
    for i, f in enumerate(candidates[: cfg.max_texts_per_cycle]):
        deal = store.add_deal(f)
        call = (not quiet) and i < cfg.max_calls_per_cycle
        alert(cfg, store, notifier, deal, call=call)
        result.deals.append(store.deal(deal["id"]))
    for f in candidates[cfg.max_texts_per_cycle:]:
        store.add_deal(f)  # logged, not alerted; may alert on a later cycle

    log.info("cycle %d: %d searches (%d errors), %d fares, %d alerted, %d already-known",
             cycle, result.searches, result.errors, result.fares_seen, len(result.deals),
             result.suppressed)
    return result
