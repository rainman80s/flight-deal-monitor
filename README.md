# Flight Deal Monitor

Watches round-trip fares from **Seattle (SEA)** and **Portland (PDX)**. When a fare
beats your rules, it texts and calls Ran and Brock. Either of you can answer
"buy" by keypad or text.

**Default rules** (in `config.toml`):

| Rule | Value |
|---|---|
| Domestic round trip | under **$100** per person |
| International round trip | under **$300** per person |
| Departure | at least **30 days** out (and no more than 240) |
| Trip length | **2–14 days** |
| Domestic vs. international | decided by which destination list the airport is in |

## Status

| Piece | State |
|---|---|
| Rules, rotating search planner, dedupe, deal log (SQLite) | ✅ built + tested |
| Texts + calls (Twilio), keypad and text-reply handling | ✅ built + tested against Twilio's SDK |
| Booking via Duffel, with safety rails | ✅ built + tested with a fake booker; **not yet run against a real Duffel account** |
| Duffel fare search | ✅ built; request format checked against the official SDK; not yet run live |
| Ignav fare search (the cheaper option for high volume) | ⏳ not written yet: docs were unreachable from the build environment |
| Amex points comparison | ⏳ stage 2 |

Everything ships in **dry-run mode**. Dry run searches with fake fares (clearly labelled
`[FAKE TEST FARE]`), prints alerts instead of calling anyone, and never buys.

## How a deal plays out

1. Every 30 min (configurable), the monitor runs ~10 searches, rotating through all
   108 origin × destination routes with different dates and trip lengths.
2. If a fare passes the rules and you haven't been alerted on it before (or it has dropped
   10%+ since the last alert), both of you get a **text**. The best deal of that cycle
   also gets a **phone call**. No calls between 10pm and 8am; texts only then.
3. **On the call:** press **1** to buy, **2** to skip, **3** to repeat. If you press 1 and a
   real purchase is possible, it asks you to press **9** to confirm.
   **By text:** reply `BUY K7Q2`, then `YES K7Q2`.
4. **On a confirmed buy:**
   - With booking off (the default), you get a pre-filled booking link.
   - With booking on, it re-checks the live price, refuses if the fare rose more than 5%,
     refuses if it would exceed the daily spend cap, books through Duffel, and texts you
     the airline confirmation code.
   - Each deal can only be booked once per person, so a double press can't double-book.

`booking.mode = "responder"` books only the person who said buy. `"both"` puts you both
on the same order and flights.

## Run it locally

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
cp config.example.toml config.toml && cp .env.example .env
python -m flightmon check        # shows rules + monthly search volume
python -m flightmon run-once     # one dry-run cycle
python -m flightmon status       # deals found so far
python -m flightmon simulate <CODE> RAN buy   # pretend Ran texted BUY <CODE>
python -m pytest -q
```

## Going live, in stages

1. **Texts only:** set `dry_run = false` with Twilio keys and `provider = "duffel"` (test
   token). Leave `booking_enabled = false`. Pressing buy sends a link.
2. **Test bookings:** use a Duffel *test* token (`duffel_test_...`) and set
   `booking_enabled = true`. Test mode books fake flights, so no money moves.
3. **Real bookings:** switch to a live Duffel token, fund your Duffel balance (bookings are
   paid from that balance, not a card), and fill in `travelers.toml` with names exactly
   as on your IDs.

See [DEPLOY.md](DEPLOY.md) for the server setup.

## Costs to know

- **Search volume:** `python -m flightmon check` prints it. The default is ~14,400
  searches/month.
- **Duffel:** reportedly ~$3 per booking + 1%. It also charges an *excess search* fee
  when searches greatly outnumber bookings (reported ~1,500:1). At the default volume
  with few bookings, you'd hit that, so for steady monitoring use Duffel only for
  booking and search with Ignav once that adapter exists.
- **Twilio:** a number is ~$1–2/month, plus a few cents per call and text. US numbers
  need A2P 10DLC registration before texting works reliably.

Check current pricing on each site; these figures are from third-party sources.

## Layout

```
flightmon/
  config.py      config.toml + .env loading and validation
  planner.py     which searches to run each cycle
  rules.py       the deal rules
  monitor.py     one cycle: search → filter → dedupe → alert
  store.py       SQLite: deals, responses, bookings
  messages.py    text and call wording
  notify.py      Twilio (live) / console (dry run)
  booking.py     buy flow + safety rails
  server.py      Twilio webhooks + background search loop
  providers/     mock, duffel, ignav (stub)
```
