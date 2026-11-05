from __future__ import annotations

from pathlib import Path

import pytest

from flightmon.config import load_config
from flightmon.notify import ConsoleNotifier
from flightmon.store import Store

ROOT = Path(__file__).resolve().parent.parent

ENV = {
    "CONTACT_RAN_PHONE": "+12065550111",
    "CONTACT_BROCK_PHONE": "+12065550122",
    "TWILIO_AUTH_TOKEN": "test_auth_token",
    "TWILIO_ACCOUNT_SID": "ACtest",
    "TWILIO_FROM_NUMBER": "+12065550100",
    "PUBLIC_BASE_URL": "https://flights.example.com",
    "DUFFEL_ACCESS_TOKEN": "duffel_test_x",
}

TRAVELERS = """
[RAN]
title = "mr"
given_name = "Ran"
family_name = "Test"
born_on = "1995-01-31"
gender = "m"
email = "ran@example.com"
phone_number = "+12065550111"

[BROCK]
title = "mr"
given_name = "Brock"
family_name = "Test"
born_on = "1995-02-28"
gender = "m"
email = "brock@example.com"
phone_number = "+12065550122"
"""


@pytest.fixture
def make_cfg(tmp_path):
    def _make(**overrides):
        trav = tmp_path / "travelers.toml"
        trav.write_text(TRAVELERS)
        env = dict(ENV, FLIGHTMON_TRAVELERS=str(trav), FLIGHTMON_DB=":memory:")
        cfg = load_config(str(ROOT / "config.example.toml"), env=env)
        for k, v in overrides.items():
            setattr(cfg, k, v)
        return cfg
    return _make


@pytest.fixture
def cfg(make_cfg):
    return make_cfg()


@pytest.fixture
def store():
    return Store(":memory:")


@pytest.fixture
def notifier():
    return ConsoleNotifier()
