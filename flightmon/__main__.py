"""Command line.

  python -m flightmon check            validate config, show search volume estimate
  python -m flightmon run-once         one search cycle, then exit
  python -m flightmon loop             search cycles forever (no webhook server)
  python -m flightmon serve            webhook server + search loop (production)
  python -m flightmon status           recent deals and bookings
  python -m flightmon simulate CODE NAME buy|yes|skip   act like a text reply
"""
from __future__ import annotations

import argparse
import logging
import sys
import time

from .config import load_config
from .notify import make_notifier
from .planner import all_routes
from .providers import make_fare_provider
from .store import Store


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def cmd_check(cfg) -> None:
    cycles_per_day = 24 * 60 / cfg.interval_minutes
    per_month = cfg.searches_per_cycle * cycles_per_day * 30
    routes = len(all_routes(cfg))
    per_route_day = cfg.searches_per_cycle * cycles_per_day / max(routes, 1)
    print(f"Mode: {'DRY RUN' if cfg.dry_run else 'LIVE'}; booking "
          f"{'ENABLED' if cfg.booking_enabled and not cfg.dry_run else 'off'}; provider {cfg.provider}")
    print(f"Origins {cfg.origins}; {len(cfg.domestic)} domestic + {len(cfg.international)} "
          f"international destinations = {routes} routes")
    print(f"Rules: round trip, domestic < ${cfg.domestic_max_price:.0f}, international < "
          f"${cfg.international_max_price:.0f}, depart {cfg.min_days_out}-{cfg.max_days_out} days "
          f"out, trip {cfg.min_trip_days}-{cfg.max_trip_days} days")
    print(f"Every {cfg.interval_minutes} min x {cfg.searches_per_cycle} searches = "
          f"~{per_month:,.0f} searches/month; each route checked ~{per_route_day:.1f}x/day")
    print(f"Contacts: {', '.join(f'{c.name} ({c.phone or 'no phone set'})' for c in cfg.contacts)}")


def cmd_status(store: Store) -> None:
    print("Recent deals:")
    for d in store.recent_deals(15):
        flag = " FAKE" if d["is_fake"] else ""
        print(f"  {d['code']}  {d['origin']}->{d['destination']}  {d['depart_date']}..{d['return_date']}"
              f"  ${d['price']:.0f}{flag}  alerted={'yes' if d['alerted_at'] else 'no'}")
    print("Bookings:")
    for b in store.bookings(15):
        print(f"  deal#{b['deal_id']}  {b['traveler']}  {b['status']}  "
              f"{b['amount'] or ''} {b['currency'] or ''} {b['booking_reference'] or ''}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="flightmon")
    ap.add_argument("-c", "--config")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("check", "run-once", "loop", "serve", "status"):
        sub.add_parser(name)
    sim = sub.add_parser("simulate")
    sim.add_argument("code")
    sim.add_argument("name")
    sim.add_argument("verb", choices=["buy", "yes", "skip"])
    serve_args = sub.choices["serve"]
    serve_args.add_argument("--port", type=int, default=8080)
    args = ap.parse_args(argv)

    _setup_logging(args.verbose)
    cfg = load_config(args.config)

    if args.cmd == "check":
        cmd_check(cfg)
        return 0

    store = Store(cfg.db_path)
    if args.cmd == "status":
        cmd_status(store)
        return 0

    notifier = make_notifier(cfg)

    if args.cmd == "simulate":
        from .server import create_app
        contact = cfg.contact(args.name.upper())
        app = create_app(cfg, store, notifier, run_bookings_inline=True)
        if not cfg.dry_run:
            print("simulate only runs in dry_run mode", file=sys.stderr)
            return 2
        resp = app.test_client().post("/sms", data={
            "From": contact.phone, "Body": f"{args.verb} {args.code}"})
        print(resp.get_data(as_text=True))
        return 0

    provider = make_fare_provider(cfg)
    if args.cmd == "run-once":
        from .monitor import run_cycle
        run_cycle(cfg, store, provider, notifier)
        return 0
    if args.cmd == "loop":
        from .server import start_search_loop
        t = start_search_loop(cfg, store, provider, notifier)
        while t.is_alive():
            time.sleep(1)
        return 1
    if args.cmd == "serve":
        from .server import create_app, start_search_loop
        start_search_loop(cfg, store, provider, notifier)
        create_app(cfg, store, notifier).run(host="0.0.0.0", port=args.port)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
