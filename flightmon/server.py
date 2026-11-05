"""Webhook server Twilio talks to (call keypad answers and text replies),
plus the background search loop.

Routes:
  POST /voice/deal/<code>?who=NAME     call script: deal details + "press 1 / 2"
  POST /voice/answer/<code>?who=NAME   handles the keypress
  POST /voice/confirm/<code>?who=NAME  handles the "press 9 to confirm" step
  POST /sms                            inbound texts: BUY <code>, YES <code>, SKIP <code>
  GET  /health
"""
from __future__ import annotations

import logging
import threading
import time
from functools import wraps

from flask import Flask, Response, abort, request
from twilio.twiml.messaging_response import MessagingResponse
from twilio.twiml.voice_response import Gather, VoiceResponse

from . import booking, messages
from .config import Config
from .store import Store

log = logging.getLogger(__name__)
VOICE = "Polly.Joanna"


def create_app(cfg: Config, store: Store, notifier, booking_provider=None,
               run_bookings_inline: bool = False) -> Flask:
    app = Flask(__name__)
    validator = None
    if not cfg.dry_run:
        from twilio.request_validator import RequestValidator
        validator = RequestValidator(cfg.secret("TWILIO_AUTH_TOKEN"))
    base = cfg.env.get("PUBLIC_BASE_URL", "").rstrip("/")

    def twilio_only(fn):
        """Reject requests not signed by Twilio (live mode only)."""
        @wraps(fn)
        def wrapper(*a, **kw):
            if validator is not None:
                url = base + request.full_path.rstrip("?")
                sig = request.headers.get("X-Twilio-Signature", "")
                if not validator.validate(url, request.form.to_dict(), sig):
                    log.warning("rejected unsigned request to %s", request.path)
                    abort(403)
            return fn(*a, **kw)
        return wrapper

    def twiml(resp) -> Response:
        return Response(str(resp), mimetype="text/xml")

    def lookup(code: str):
        deal = store.deal_by_code(code)
        if deal is None:
            abort(404)
        return deal

    def who_param() -> str:
        who = request.args.get("who", "")
        try:
            cfg.contact(who)
        except KeyError:
            abort(400)
        return who

    def start_booking(deal, who: str):
        def job():
            try:
                booking.execute_buy(cfg, store, notifier, deal, who, booking_provider)
            except Exception:
                log.exception("booking job crashed")
        if run_bookings_inline:
            job()
        else:
            threading.Thread(target=job, daemon=True).start()

    # ---------------- voice ----------------
    @app.post("/voice/deal/<code>")
    @twilio_only
    def voice_deal(code):
        deal, who = lookup(code), who_param()
        r = VoiceResponse()
        g = Gather(num_digits=1, action=f"/voice/answer/{deal['code']}?who={who}",
                   method="POST", timeout=8)
        g.say(messages.deal_speech(deal), voice=VOICE)
        g.pause(length=1)
        g.say("Press 1 to buy. Press 2 to skip. Press 3 to hear that again.", voice=VOICE)
        r.append(g)
        r.say("No answer received. The details are in your texts. Goodbye.", voice=VOICE)
        return twiml(r)

    @app.post("/voice/answer/<code>")
    @twilio_only
    def voice_answer(code):
        deal, who = lookup(code), who_param()
        digit = request.form.get("Digits", "")
        r = VoiceResponse()
        if digit == "1":
            if booking.needs_confirmation(cfg, deal):
                booking.request_buy(cfg, store, notifier, deal, who, "call")
                travelers = booking.travelers_for(cfg, who)
                total = booking.max_total(cfg, deal, travelers)
                g = Gather(num_digits=1, action=f"/voice/confirm/{deal['code']}?who={who}",
                           method="POST", timeout=10)
                g.say(f"To confirm buying this ticket for {' and '.join(travelers).lower()}, "
                      f"at up to {total:.0f} dollars total, which is likely nonrefundable, "
                      f"press 9. Press any other key to cancel.", voice=VOICE)
                r.append(g)
                r.say("Not confirmed. Nothing was purchased. Goodbye.", voice=VOICE)
            else:
                store.add_response(deal["id"], who, "buy_requested", "call")
                start_booking(deal, who)
                r.say("Got it. I'm texting you the details now. Goodbye.", voice=VOICE)
        elif digit == "2":
            store.add_response(deal["id"], who, "skip", "call")
            r.say("Skipped. Goodbye.", voice=VOICE)
        else:
            r.redirect(f"/voice/deal/{deal['code']}?who={who}", method="POST")
        return twiml(r)

    @app.post("/voice/confirm/<code>")
    @twilio_only
    def voice_confirm(code):
        deal, who = lookup(code), who_param()
        r = VoiceResponse()
        if request.form.get("Digits") == "9":
            store.add_response(deal["id"], who, "confirmed", "call")
            start_booking(deal, who)
            r.say("Confirmed. Checking the price and booking now. You'll get a text with the "
                  "result in a minute. Goodbye.", voice=VOICE)
        else:
            store.add_response(deal["id"], who, "cancelled", "call")
            r.say("Cancelled. Nothing was purchased. Goodbye.", voice=VOICE)
        return twiml(r)

    # ---------------- sms ----------------
    @app.post("/sms")
    @twilio_only
    def sms():
        from_ = request.form.get("From", "")
        body = (request.form.get("Body") or "").strip().upper().split()
        contact = cfg.contact_by_phone(from_)
        r = MessagingResponse()
        if contact is None:
            return twiml(r)  # ignore strangers silently
        if len(body) != 2 or body[0] not in ("BUY", "YES", "SKIP"):
            r.message("Reply BUY <code>, YES <code> or SKIP <code>, e.g. BUY K7Q2.")
            return twiml(r)
        verb, code = body
        deal = store.deal_by_code(code)
        if deal is None:
            r.message(f"No deal with code {code}.")
            return twiml(r)
        who = contact.name
        if verb == "SKIP":
            store.add_response(deal["id"], who, "skip", "sms")
            r.message(f"Skipped {code}.")
        elif verb == "BUY":
            if booking.needs_confirmation(cfg, deal):
                r.message(booking.request_buy(cfg, store, notifier, deal, who, "sms"))
            else:
                store.add_response(deal["id"], who, "buy_requested", "sms")
                start_booking(deal, who)
        else:  # YES
            if not booking.needs_confirmation(cfg, deal):
                r.message(f"Nothing to confirm for {code}.")
            elif store.latest_response(deal["id"], who) != "buy_requested":
                r.message(f"Reply BUY {code} first.")
            else:
                store.add_response(deal["id"], who, "confirmed", "sms")
                start_booking(deal, who)
                r.message(f"Confirmed {code}. Re-checking the price and booking now...")
        return twiml(r)

    @app.get("/health")
    def health():
        return {"ok": True, "dry_run": cfg.dry_run, "booking_enabled": cfg.booking_enabled,
                "cycle": store.get_state("cycle", "0")}

    return app


def start_search_loop(cfg: Config, store: Store, provider, notifier) -> threading.Thread:
    from .monitor import run_cycle

    def loop():
        while True:
            started = time.monotonic()
            try:
                run_cycle(cfg, store, provider, notifier)
            except NotImplementedError as e:
                log.error("%s; search loop stopped", e)
                return
            except Exception:
                log.exception("cycle crashed; will retry next interval")
            elapsed = time.monotonic() - started
            time.sleep(max(5, cfg.interval_minutes * 60 - elapsed))

    t = threading.Thread(target=loop, daemon=True, name="search-loop")
    t.start()
    return t
