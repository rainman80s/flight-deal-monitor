"""Sending texts and placing calls. Dry run prints instead of contacting anyone."""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)


class ConsoleNotifier:
    """Used in dry run. Records everything so tests can inspect it."""

    def __init__(self):
        self.sent: list[tuple[str, str, str]] = []  # (kind, to, body)

    def sms(self, to: str, body: str) -> None:
        self.sent.append(("sms", to, body))
        log.info("[DRY RUN] text to %s:\n%s", to, body)

    def call(self, to: str, deal_code: str, contact: str) -> None:
        self.sent.append(("call", to, f"{deal_code}:{contact}"))
        log.info("[DRY RUN] would call %s (%s) about deal %s", to, contact, deal_code)


class TwilioNotifier:
    def __init__(self, account_sid: str, auth_token: str, from_number: str, public_base_url: str):
        from twilio.rest import Client
        self.client = Client(account_sid, auth_token)
        self.from_number = from_number
        self.base = public_base_url.rstrip("/")

    def sms(self, to: str, body: str) -> None:
        msg = self.client.messages.create(to=to, from_=self.from_number, body=body)
        log.info("texted %s (sid %s)", to, msg.sid)

    def call(self, to: str, deal_code: str, contact: str) -> None:
        call = self.client.calls.create(
            to=to, from_=self.from_number,
            url=f"{self.base}/voice/deal/{deal_code}?who={contact}",
            method="POST",
            timeout=30,  # ring ~30s before giving up
        )
        log.info("calling %s about %s (sid %s)", to, deal_code, call.sid)


def make_notifier(cfg):
    if cfg.dry_run:
        return ConsoleNotifier()
    return TwilioNotifier(cfg.secret("TWILIO_ACCOUNT_SID"), cfg.secret("TWILIO_AUTH_TOKEN"),
                          cfg.secret("TWILIO_FROM_NUMBER"), cfg.secret("PUBLIC_BASE_URL"))
