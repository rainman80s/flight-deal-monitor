"""The money paths: every way a BUY can go, through calls and texts."""
from datetime import date, timedelta
from urllib.parse import urlencode

import pytest
from twilio.request_validator import RequestValidator

from flightmon import booking
from flightmon.models import Fare
from flightmon.server import create_app

BASE = "https://flights.example.com"


class FakeBooker:
    """Stands in for Duffel. Records what would have been purchased."""
    name = "fake"

    def __init__(self, price=90.0, available=True, fail_on_book=False):
        self.price, self.available, self.fail_on_book = price, available, fail_on_book
        self.orders = []

    def reprice(self, origin, destination, depart, ret, passengers):
        if not self.available:
            return None
        return ("off_1", self.price * passengers, "USD", [f"pas_{i}" for i in range(passengers)])

    def book(self, offer_id, amount, currency, passengers):
        if self.fail_on_book:
            raise RuntimeError("airline timeout")
        self.orders.append((offer_id, amount, currency, passengers))
        return "ord_1", "ABC123"


def real_deal(store, price=90.0, fake=False, dest="LAX"):
    d = date(2026, 12, 15)
    return store.add_deal(Fare("duffel", "SEA", dest, d, d + timedelta(days=5), price, "USD",
                               ["AS"], 0, 0, "off_0", None, "https://example/link", is_fake=fake))


@pytest.fixture
def live_cfg(make_cfg):
    return make_cfg(dry_run=False, booking_enabled=True)


def signed_post(client, path, data):
    sig = RequestValidator("test_auth_token").compute_signature(BASE + path, data)
    return client.post(path, data=data, headers={"X-Twilio-Signature": sig})


# ---------------- booking logic ----------------

def test_fake_fares_never_book(live_cfg, store, notifier):
    b = FakeBooker()
    msg = booking.execute_buy(live_cfg, store, notifier, real_deal(store, fake=True), "RAN", b)
    assert "FAKE" in msg and b.orders == []


def test_dry_run_never_books(make_cfg, store, notifier):
    cfg = make_cfg(dry_run=True, booking_enabled=True)
    b = FakeBooker()
    msg = booking.execute_buy(cfg, store, notifier, real_deal(store), "RAN", b)
    assert "DRY RUN" in msg and b.orders == []


def test_booking_disabled_sends_link(make_cfg, store, notifier):
    cfg = make_cfg(dry_run=False, booking_enabled=False)
    b = FakeBooker()
    msg = booking.execute_buy(cfg, store, notifier, real_deal(store), "RAN", b)
    assert "https://example/link" in msg and b.orders == []


def test_books_responder_only(live_cfg, store, notifier):
    b = FakeBooker(price=92)
    msg = booking.execute_buy(live_cfg, store, notifier, real_deal(store), "RAN", b)
    assert "BOOKED" in msg and "ABC123" in msg
    (_, amount, _, passengers), = b.orders
    assert amount == 92 and len(passengers) == 1
    assert passengers[0]["given_name"] == "Ran" and passengers[0]["id"] == "pas_0"


def test_both_mode_books_both_on_one_order(live_cfg, store, notifier):
    live_cfg.booking_mode = "both"
    b = FakeBooker(price=90)
    booking.execute_buy(live_cfg, store, notifier, real_deal(store), "BROCK", b)
    (_, amount, _, passengers), = b.orders
    assert amount == 180 and [p["given_name"] for p in passengers] == ["Ran", "Brock"]


def test_never_double_books(live_cfg, store, notifier):
    b = FakeBooker()
    deal = real_deal(store)
    booking.execute_buy(live_cfg, store, notifier, deal, "RAN", b)
    msg = booking.execute_buy(live_cfg, store, notifier, deal, "RAN", b)
    assert "already booked" in msg and len(b.orders) == 1


def test_refuses_price_jump(live_cfg, store, notifier):
    b = FakeBooker(price=95)  # alerted at 90, +5.6% > 5% allowance
    msg = booking.execute_buy(live_cfg, store, notifier, real_deal(store), "RAN", b)
    assert "Did NOT book" in msg and b.orders == []
    b.price = 94  # within 5%; the released claim allows a retry
    assert "BOOKED" in booking.execute_buy(live_cfg, store, notifier, store.deal(1), "RAN", b)


def test_refuses_when_gone(live_cfg, store, notifier):
    msg = booking.execute_buy(live_cfg, store, notifier, real_deal(store), "RAN",
                              FakeBooker(available=False))
    assert "no longer available" in msg


def test_daily_spend_cap(live_cfg, store, notifier):
    live_cfg.daily_spend_cap = 150
    b = FakeBooker(price=90)
    assert "BOOKED" in booking.execute_buy(live_cfg, store, notifier, real_deal(store), "RAN", b)
    msg = booking.execute_buy(live_cfg, store, notifier, real_deal(store, dest="SFO"), "RAN", b)
    assert "daily spend cap" in msg and len(b.orders) == 1


def test_failed_book_is_not_retried(live_cfg, store, notifier):
    b = FakeBooker(fail_on_book=True)
    deal = real_deal(store)
    assert "FAILED" in booking.execute_buy(live_cfg, store, notifier, deal, "RAN", b)
    b.fail_on_book = False
    assert "already booked" in booking.execute_buy(live_cfg, store, notifier, deal, "RAN", b)
    assert b.orders == []


def test_missing_traveler_details(live_cfg, store, notifier, tmp_path):
    live_cfg.travelers_path = str(tmp_path / "nope.toml")
    msg = booking.execute_buy(live_cfg, store, notifier, real_deal(store), "RAN", FakeBooker())
    assert "Did NOT book" in msg


# ---------------- webhooks ----------------

@pytest.fixture
def app_client(live_cfg, store, notifier):
    b = FakeBooker()
    app = create_app(live_cfg, store, notifier, booking_provider=b, run_bookings_inline=True)
    return app.test_client(), b


def test_rejects_unsigned_requests(app_client, store):
    client, _ = app_client
    deal = real_deal(store)
    assert client.post(f"/voice/deal/{deal['code']}?who=RAN").status_code == 403
    assert client.post("/sms", data={"From": "+12065550111", "Body": "BUY X"}).status_code == 403


def test_call_flow_press_1_then_9_books(app_client, store):
    client, b = app_client
    code = real_deal(store)["code"]
    r = signed_post(client, f"/voice/deal/{code}?who=RAN", {})
    assert b"<Gather" in r.data and b"Seattle to Los Angeles" in r.data
    r = signed_post(client, f"/voice/answer/{code}?who=RAN", {"Digits": "1"})
    assert b"press 9" in r.data and b.orders == []  # asks to confirm, nothing bought yet
    r = signed_post(client, f"/voice/confirm/{code}?who=RAN", {"Digits": "9"})
    assert b"Confirmed" in r.data and len(b.orders) == 1


def test_call_flow_confirm_other_key_cancels(app_client, store):
    client, b = app_client
    code = real_deal(store)["code"]
    signed_post(client, f"/voice/answer/{code}?who=RAN", {"Digits": "1"})
    r = signed_post(client, f"/voice/confirm/{code}?who=RAN", {"Digits": "5"})
    assert b"Cancelled" in r.data and b.orders == []


def test_call_skip(app_client, store):
    client, b = app_client
    code = real_deal(store)["code"]
    r = signed_post(client, f"/voice/answer/{code}?who=RAN", {"Digits": "2"})
    assert b"Skipped" in r.data and b.orders == []


def test_sms_buy_then_yes_books(app_client, store):
    client, b = app_client
    code = real_deal(store)["code"]
    r = signed_post(client, "/sms", {"From": "+12065550122", "Body": f"buy {code}"})
    assert b"Reply YES" in r.data and b.orders == []
    r = signed_post(client, "/sms", {"From": "+12065550122", "Body": f"YES {code}"})
    assert len(b.orders) == 1 and b.orders[0][3][0]["given_name"] == "Brock"


def test_sms_yes_without_buy_does_nothing(app_client, store):
    client, b = app_client
    code = real_deal(store)["code"]
    r = signed_post(client, "/sms", {"From": "+12065550122", "Body": f"YES {code}"})
    assert b"BUY" in r.data and b.orders == []


def test_sms_from_stranger_ignored(app_client, store):
    client, b = app_client
    code = real_deal(store)["code"]
    signed_post(client, "/sms", {"From": "+15555550000", "Body": f"BUY {code}"})
    r = signed_post(client, "/sms", {"From": "+15555550000", "Body": f"YES {code}"})
    assert b"<Message>" not in r.data and b.orders == []
