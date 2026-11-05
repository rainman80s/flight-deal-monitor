"""What the texts and calls say."""
from __future__ import annotations

import json
from datetime import date

CITY = {
    "SEA": "Seattle", "PDX": "Portland", "LAX": "Los Angeles", "SFO": "San Francisco",
    "SAN": "San Diego", "LAS": "Las Vegas", "PHX": "Phoenix", "DEN": "Denver",
    "SLC": "Salt Lake City", "ANC": "Anchorage", "HNL": "Honolulu", "OGG": "Maui",
    "DFW": "Dallas", "AUS": "Austin", "ORD": "Chicago", "MSP": "Minneapolis",
    "ATL": "Atlanta", "MIA": "Miami", "MCO": "Orlando", "BOS": "Boston",
    "JFK": "New York J F K", "EWR": "Newark", "DCA": "Washington D C", "MSY": "New Orleans",
    "BNA": "Nashville", "SJC": "San Jose", "SMF": "Sacramento", "BOI": "Boise",
    "YVR": "Vancouver", "MEX": "Mexico City", "CUN": "Cancun", "SJD": "Los Cabos",
    "PVR": "Puerto Vallarta", "GDL": "Guadalajara", "LIR": "Liberia Costa Rica",
    "SJO": "San Jose Costa Rica", "NRT": "Tokyo Narita", "HND": "Tokyo Haneda",
    "KIX": "Osaka", "ICN": "Seoul", "TPE": "Taipei", "MNL": "Manila", "BKK": "Bangkok",
    "SIN": "Singapore", "LHR": "London Heathrow", "DUB": "Dublin", "KEF": "Reykjavik",
    "CDG": "Paris", "AMS": "Amsterdam", "FRA": "Frankfurt", "MAD": "Madrid",
    "BCN": "Barcelona", "LIS": "Lisbon", "FCO": "Rome", "SYD": "Sydney", "AKL": "Auckland",
}


def city(code: str) -> str:
    return CITY.get(code, " ".join(code))


def _d(s: str) -> date:
    return date.fromisoformat(s)


def _short(s: str) -> str:
    d = _d(s)
    return f"{d:%a %b} {d.day}"


def _spoken(s: str) -> str:
    d = _d(s)
    return f"{d:%A, %B} {d.day}"


def _stops(n: int) -> str:
    return "nonstop" if n == 0 else f"{n} stop" + ("s" if n > 1 else "")


def trip_days(deal) -> int:
    return (_d(deal["return_date"]) - _d(deal["depart_date"])).days


def deal_text(deal, kind: str, limit: float, booking_enabled: bool) -> str:
    fake = "[FAKE TEST FARE] " if deal["is_fake"] else ""
    airlines = ", ".join(json.loads(deal["airlines"])) or "?"
    action = "book it" if booking_enabled else "get the booking link"
    return (
        f"{fake}Flight deal: {deal['origin']}→{deal['destination']} ({city(deal['destination'])}) "
        f"${deal['price']:.0f} round trip ({kind}, under ${limit:.0f}).\n"
        f"{_short(deal['depart_date'])} → {_short(deal['return_date'])} ({trip_days(deal)} days), "
        f"out {_stops(deal['outbound_stops'])}, back {_stops(deal['return_stops'])}, {airlines}.\n"
        f"Reply BUY {deal['code']} to {action}, or SKIP {deal['code']}."
    )


def deal_speech(deal) -> str:
    fake = "This is a fake test fare. " if deal["is_fake"] else ""
    return (
        f"{fake}Flight deal. {city(deal['origin'])} to {city(deal['destination'])}, round trip, "
        f"{deal['price']:.0f} dollars. Leaving {_spoken(deal['depart_date'])}, "
        f"returning {_spoken(deal['return_date'])}. That's {trip_days(deal)} days."
    )


def confirm_text(deal, travelers: list[str], max_total: float) -> str:
    who = " and ".join(t.title() for t in travelers)
    return (f"Confirm: buy {deal['origin']}→{deal['destination']} {_short(deal['depart_date'])}–"
            f"{_short(deal['return_date'])} for {who}, up to ${max_total:.0f} total. "
            f"Likely NONREFUNDABLE. Reply YES {deal['code']} to purchase.")
