"""What happens after someone says BUY and then confirms.

Safety rails, in order:
  1. Fake (mock) fares are never booked.
  2. dry_run -> log what would happen, book nothing.
  3. booking_enabled = false -> text the booking link instead.
  4. One booking per (deal, traveler), enforced by the database, so a double
     press or a duplicate webhook can't double-book.
  5. Fresh re-price right before paying; refuse if the price rose more than
     max_price_increase_percent over the alerted price.
  6. Daily spend cap.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone

from . import messages
from .config import Config, load_travelers
from .store import Store

log = logging.getLogger(__name__)


def travelers_for(cfg: Config, responder: str) -> list[str]:
    return [c.name for c in cfg.contacts] if cfg.booking_mode == "both" else [responder]


def max_total(cfg: Config, deal, travelers: list[str]) -> float:
    return deal["price"] * len(travelers) * (1 + cfg.max_price_increase_percent / 100)


def _tell(cfg: Config, notifier, names: list[str], body: str) -> None:
    for n in names:
        try:
            notifier.sms(cfg.contact(n).phone, body)
        except Exception:
            log.exception("failed to text %s", n)


def link_text(deal) -> str:
    return (f"Book {deal['origin']}→{deal['destination']} "
            f"{deal['depart_date']} to {deal['return_date']} here (price may have moved): "
            f"{deal['booking_url']}")


def execute_buy(cfg: Config, store: Store, notifier, deal, responder: str,
                booking_provider=None, today: date | None = None) -> str:
    """Run after a confirmed BUY. Returns a short status string (also texted out)."""
    today = today or datetime.now(timezone.utc).date()  # spend cap day is UTC
    travelers = travelers_for(cfg, responder)
    notify_who = sorted(set(travelers) | {responder})

    if deal["is_fake"]:
        status = f"Deal {deal['code']} is a FAKE TEST FARE; nothing booked."
        for t in travelers:
            if store.claim_booking(deal["id"], t):
                store.finish_booking(deal["id"], t, "dry_run", detail="fake fare")
        _tell(cfg, notifier, [responder], status)
        return status

    if cfg.dry_run:
        status = (f"[DRY RUN] Would book {deal['code']} for {', '.join(travelers)} "
                  f"(up to ${max_total(cfg, deal, travelers):.0f}). Nothing purchased.")
        for t in travelers:
            if store.claim_booking(deal["id"], t):
                store.finish_booking(deal["id"], t, "dry_run")
        _tell(cfg, notifier, [responder], status)
        return status

    if not cfg.booking_enabled:
        for t in travelers:
            if store.claim_booking(deal["id"], t):
                store.finish_booking(deal["id"], t, "link_sent")
        status = link_text(deal)
        _tell(cfg, notifier, [responder], status)
        return status

    # --- real purchase path ---
    claimed = [t for t in travelers if store.claim_booking(deal["id"], t)]
    if len(claimed) != len(travelers):
        for t in claimed:
            store.release_booking(deal["id"], t)
        status = f"Deal {deal['code']} is already booked (or being booked) for {', '.join(travelers)}."
        _tell(cfg, notifier, [responder], status)
        return status

    def abort(reason: str) -> str:
        for t in travelers:
            store.release_booking(deal["id"], t)
        msg = f"Did NOT book {deal['code']}: {reason}"
        _tell(cfg, notifier, notify_who, msg)
        return msg

    try:
        people = load_travelers(cfg.travelers_path)
        missing = [t for t in travelers if t not in people]
        if missing:
            return abort(f"no passenger details for {missing} in travelers.toml")
        if booking_provider is None:
            from .providers import make_booking_provider
            booking_provider = make_booking_provider(cfg)

        fresh = booking_provider.reprice(deal["origin"], deal["destination"], deal["depart_date"],
                                         deal["return_date"], len(travelers))
    except Exception as e:  # nothing has been paid yet, safe to release
        log.exception("pre-booking step failed")
        return abort(f"error before purchase ({e})")

    if fresh is None:
        return abort("fare is no longer available.")
    offer_id, total, currency, passenger_ids = fresh
    if currency != deal["currency"]:
        return abort(f"fresh price is in {currency}, expected {deal['currency']}.")
    ceiling = max_total(cfg, deal, travelers)
    if total > ceiling:
        return abort(f"price is now ${total:.0f} total, over the ${ceiling:.0f} limit.")
    spent = store.spent_on(today)
    if spent + total > cfg.daily_spend_cap:
        return abort(f"would exceed daily spend cap (${spent:.0f} spent + ${total:.0f} > "
                     f"${cfg.daily_spend_cap:.0f}).")
    if len(passenger_ids) != len(travelers):
        return abort("offer passenger count mismatch.")

    passengers = []
    for pid, name in zip(passenger_ids, travelers):
        p = people[name]
        passengers.append({"id": pid, "title": p["title"], "given_name": p["given_name"],
                           "family_name": p["family_name"], "born_on": p["born_on"],
                           "gender": p["gender"], "email": p["email"],
                           "phone_number": p["phone_number"]})
    per_person = total / len(travelers)
    try:
        order_id, ref = booking_provider.book(offer_id, total, currency, passengers)
    except Exception as e:
        # The request reached the airline side; we can't be sure it failed cleanly.
        # Keep the claim (status failed) so it is NOT retried automatically.
        log.exception("booking call failed")
        for t in travelers:
            store.finish_booking(deal["id"], t, "failed", per_person, currency, detail=str(e)[:500])
        msg = (f"Booking {deal['code']} FAILED or is uncertain ({e}). Check the Duffel dashboard "
               f"before retrying.")
        _tell(cfg, notifier, notify_who, msg)
        return msg

    for t in travelers:
        store.finish_booking(deal["id"], t, "booked", per_person, currency, order_id, ref)
    msg = (f"BOOKED {deal['origin']}→{deal['destination']} {deal['depart_date']} to "
           f"{deal['return_date']} for {', '.join(travelers)}: ${total:.2f} {currency}. "
           f"Airline confirmation {ref}.")
    _tell(cfg, notifier, notify_who, msg)
    return msg


def request_buy(cfg: Config, store: Store, notifier, deal, responder: str, channel: str) -> str:
    """First step (BUY). Records intent; asks for confirmation when a real purchase would happen."""
    store.add_response(deal["id"], responder, "buy_requested", channel)
    travelers = travelers_for(cfg, responder)
    return messages.confirm_text(deal, travelers, max_total(cfg, deal, travelers))


def needs_confirmation(cfg: Config, deal) -> bool:
    """Only a real purchase needs the second YES step."""
    return cfg.booking_enabled and not cfg.dry_run and not deal["is_fake"]
