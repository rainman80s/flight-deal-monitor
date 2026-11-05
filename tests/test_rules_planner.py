from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from flightmon.models import Fare
from flightmon.monitor import in_quiet_hours, run_cycle
from flightmon.planner import all_routes, plan_cycle
from flightmon.providers.mock import MockProvider
from flightmon.rules import cheapest_per_route, rejection_reason

TODAY = date(2026, 11, 5)


def fare(dest="LAX", price=90.0, out_days=40, length=5, origin="SEA", currency="USD"):
    d = TODAY + timedelta(days=out_days)
    return Fare("t", origin, dest, d, d + timedelta(days=length), price, currency)


def test_domestic_threshold(cfg):
    assert rejection_reason(cfg, fare("LAX", 99.99), TODAY) is None
    assert "domestic" in rejection_reason(cfg, fare("LAX", 100), TODAY)


def test_international_threshold(cfg):
    assert rejection_reason(cfg, fare("NRT", 299), TODAY) is None
    assert "international" in rejection_reason(cfg, fare("NRT", 300), TODAY)
    # A $150 international fare is fine; $150 domestic is not.
    assert rejection_reason(cfg, fare("NRT", 150), TODAY) is None
    assert rejection_reason(cfg, fare("LAX", 150), TODAY) is not None


def test_days_out(cfg):
    assert rejection_reason(cfg, fare(out_days=30), TODAY) is None
    assert "departs in 29" in rejection_reason(cfg, fare(out_days=29), TODAY)
    assert rejection_reason(cfg, fare(out_days=241), TODAY) is not None


def test_trip_length(cfg):
    assert rejection_reason(cfg, fare(length=14), TODAY) is None
    assert "15 days" in rejection_reason(cfg, fare(length=15), TODAY)
    assert rejection_reason(cfg, fare(length=1), TODAY) is not None


def test_unknown_destination_and_currency(cfg):
    assert "not in destination" in rejection_reason(cfg, fare("XXX", 50), TODAY)
    assert "currency" in rejection_reason(cfg, fare(currency="EUR", price=50), TODAY)


def test_cheapest_per_route():
    a, b, c = fare(price=95), fare(price=80), fare("NRT", 250)
    best = {f.route_key: f.price for f in cheapest_per_route([a, b, c])}
    assert best[a.route_key] == 80 and len(best) == 2


def test_planner_respects_rules_and_rotates(cfg):
    routes = set(all_routes(cfg))
    seen = set()
    for cycle in range(60):
        for q in plan_cycle(cfg, cycle, TODAY):
            assert (q.origin, q.destination) in routes
            days_out = (q.depart_date - TODAY).days
            assert cfg.min_days_out <= days_out <= cfg.max_days_out
            assert cfg.min_trip_days <= q.trip_days <= cfg.max_trip_days
            seen.add((q.origin, q.destination))
    assert seen == routes  # every route gets covered within a day or so of cycles
    assert {o for o, _ in routes} == {"SEA", "PDX"}


def test_quiet_hours(cfg):
    tz = ZoneInfo("America/Los_Angeles")
    assert in_quiet_hours(cfg, datetime(2026, 11, 5, 23, tzinfo=tz))
    assert in_quiet_hours(cfg, datetime(2026, 11, 5, 3, tzinfo=tz))
    assert not in_quiet_hours(cfg, datetime(2026, 11, 5, 8, tzinfo=tz))
    assert not in_quiet_hours(cfg, datetime(2026, 11, 5, 14, tzinfo=tz))


class FixedProvider:
    name = "fixed"

    def __init__(self, fares):
        self.fares = fares

    def search(self, q):
        return [f for f in self.fares]


def test_cycle_dedupes_and_realerts_on_drop(cfg, store, notifier):
    noon = datetime(2026, 11, 5, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
    p = FixedProvider([fare("LAX", 90)])
    r1 = run_cycle(cfg, store, p, notifier, now=noon)
    assert len(r1.deals) == 1
    calls = [s for s in notifier.sent if s[0] == "call"]
    texts = [s for s in notifier.sent if s[0] == "sms"]
    assert len(calls) == 2 and len(texts) == 2  # both people texted and called

    r2 = run_cycle(cfg, store, p, notifier, now=noon)
    assert len(r2.deals) == 0 and r2.suppressed == 1  # same deal, no repeat

    p.fares = [fare("LAX", 85)]  # only ~5.5% cheaper, under the 10% re-alert bar
    assert len(run_cycle(cfg, store, p, notifier, now=noon).deals) == 0
    p.fares = [fare("LAX", 80)]  # 11% cheaper than the alerted $90
    assert len(run_cycle(cfg, store, p, notifier, now=noon).deals) == 1


def test_cycle_quiet_hours_texts_only_and_call_cap(cfg, store, notifier):
    night = datetime(2026, 11, 5, 23, tzinfo=ZoneInfo("America/Los_Angeles"))
    p = FixedProvider([fare("LAX", 90), fare("DEN", 60), fare("NRT", 200)])
    r = run_cycle(cfg, store, p, notifier, now=night)
    assert len(r.deals) == 3
    assert not [s for s in notifier.sent if s[0] == "call"]

    notifier.sent.clear()
    noon = datetime(2026, 11, 6, 12, tzinfo=ZoneInfo("America/Los_Angeles"))
    p.fares = [fare("SFO", 70), fare("BOS", 50)]
    run_cycle(cfg, store, p, notifier, now=noon)
    calls = [s for s in notifier.sent if s[0] == "call"]
    assert len(calls) == 2  # max_calls_per_cycle=1 deal x 2 people
    assert len({c[2].split(":")[0] for c in calls}) == 1  # same deal for both people


def test_mock_fares_are_flagged(cfg, store, notifier):
    r = run_cycle(cfg, store, MockProvider(deal_rate=1.0), notifier,
                  now=datetime(2026, 11, 5, 12, tzinfo=ZoneInfo("America/Los_Angeles")))
    assert r.deals and all(d["is_fake"] for d in r.deals)
    assert all("FAKE TEST FARE" in s[2] for s in notifier.sent if s[0] == "sms")
