# Flight Deal Monitor (Fare Radar)

Live site: https://flight-deal-monitor.ranenbothel.workers.dev

A Cloudflare Worker that watches round-trip fares from **Seattle (SEA)** and **Portland (PDX)**.
When a fare beats your rules, it texts and calls Ran and Brock. Either of you can answer
"buy" by keypad or text.

**Default rules** (in `config.json`):

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
| Rules, rotating search planner, dedupe, deal log (D1) | ✅ built + tested |
| **Email alerts (Resend) with signed Buy/Skip buttons** | ✅ built, tested, **live** (test email delivered) |
| Texts + calls (Twilio), optional, off by default | ✅ built + tested; signature check verified against Twilio's official SDK |
| Booking via Duffel, with safety rails | ✅ built + tested with a fake booker; **not yet run against a real Duffel account** |
| Duffel fare search | ✅ built; request shape tested; not yet run live |
| Local end-to-end on Cloudflare's runtime (`wrangler dev`) | ✅ cron, admin, call script, simulated buy |
| Ignav fare search (real fares, cheap at volume) | ✅ built from Ignav's OpenAPI spec + tested; endpoint verified live; **needs your `IGNAV_API_KEY`** |
| Website: Browse deals + Sign up for alerts (liquid-glass UI) | ✅ live at the Worker's URL; double opt-in, unsubscribe, per-IP throttle |
| Amex points comparison | ⏳ stage 2 |

Everything ships in **dry-run mode**. Dry run searches with fake fares (labelled
`[FAKE TEST FARE]`), logs alerts instead of calling anyone, and never buys.

## How it runs on Cloudflare

| Piece | Cloudflare feature |
|---|---|
| Search every 30 min | Cron Trigger (`wrangler.toml` → `[triggers]`) |
| Deals, responses, bookings | D1 database |
| Twilio callbacks + admin | The Worker's HTTP handler (`src/app.ts`) |
| Booking after a keypress | `ctx.waitUntil`, so Twilio gets its answer immediately |
| Keys, phone numbers, passenger details | Worker secrets |

## How a deal plays out

1. Every 30 minutes, ~10 searches rotate through all 108 origin × destination routes
   with different dates and trip lengths.
2. A fare that passes the rules and is new (or has dropped 10%+ since its last alert)
   gets an **email** with **Buy** and **Skip** buttons. The links are signed per deal and
   person. Opening one shows a confirmation page, and the action only happens when you
   press its button (mail scanners prefetch links).
3. Optional, if `alerts.channels` includes `sms`/`call` and Twilio is set up: a text to each
   person, and a call about the best deal (not 10pm–8am). On the call, press **1** to buy
   (then **9** to confirm), **2** to skip, **3** to repeat. By text, reply `BUY K7Q2`, then `YES K7Q2`.
4. **On a confirmed buy:**
   - With booking off (the default), you get a pre-filled booking link.
   - With booking on, it re-checks the live price, refuses if the fare rose more than 5%,
     refuses if it would exceed the daily spend cap, books through Duffel, and texts the
     airline confirmation code.
   - Each deal can only be booked once per person.

`booking.mode = "responder"` books only the person who said buy. `"both"` puts you both
on one order and the same flights.

## Develop

```bash
npm install --legacy-peer-deps
npm test                       # 36 tests
npm run check                  # type-check
printf 'ADMIN_TOKEN=local\nCONTACT_RAN_PHONE=+12065550111\nCONTACT_BROCK_PHONE=+12065550122\n' > .dev.vars
npm run db:migrate:local
npm run dev                    # http://localhost:8787
curl -X POST -H "Authorization: Bearer local" localhost:8787/admin/run     # one cycle now
curl -H "Authorization: Bearer local" localhost:8787/admin/status          # deals + bookings
curl -X POST -H "Authorization: Bearer local" "localhost:8787/admin/simulate?code=K7Q2&who=ran&verb=buy"
curl -X POST -H "Authorization: Bearer local" localhost:8787/admin/test-email   # email latest deal (needs RESEND_API_KEY)
```

Deploying: see [DEPLOY.md](DEPLOY.md).

## Search: Google Explore + Ignav, alternating

A run happens every hour (cron `7 * * * *`):

- **Every 3rd run, Google Explore** via SerpApi (secret `SERPAPI_KEY`): one request returns
  Google Flights' cheapest round trip from one home airport to *every* destination
  (next 6 months, 1-week trips), alternating SEA and PDX. Hits under the limit are confirmed
  with one Ignav exact search (up to 3 per run); if Ignav can't confirm (request limit), the
  Google price is used. Explore can find places outside the configured lists: US destinations
  use the domestic limit, everything else the international one.
- **The other runs, Ignav route checks** (secret `ignav-key`): one calendar request prices a
  route for 31 departure dates at one trip length (4, 7 or 10 days), 30-150 days out.

Budgets enforced in code (D1-backed; a run stops before calling an API once a cap is hit):

| Source | Per day | Overall | Fits |
|---|---|---|---|
| SerpApi | 9 | 245 per month | the Free plan (250/month) |
| Ignav | 45 | 950 total | the free 1,000, then about $2 per 1,000 |

Without a SerpApi key, Explore runs are skipped and every run is an Ignav check.
`/admin/status` shows usage; `POST /admin/run?mode=explore` forces an Explore run.

## Buying from the site

Only the configured contacts can buy. They sign in with a one-time email link
(`Sign in` in the nav), which sets a signed 30-day cookie. Once signed in, every price on
the page gets a **Buy** button that opens a booking sheet:

1. Pick dates and who's flying, then **Find flights**: real bookable offers from Duffel
   (times, stops, airline, refund/change rules).
2. Pick one; a confirm panel shows the total and terms.
3. **Buy**: the server re-fetches the offer and refuses if the price rose more than
   `max_price_increase_percent`, if it would pass `daily_spend_cap` (real money only), or if
   that offer was already booked. Then it books via Duffel (paid from your Duffel balance)
   and emails the airline confirmation.

Setup:

- **Traveler details:** sign in and open **Account** (top right). Fill in each traveler
  (names exactly as on ID; passport optional, needed for most international flights). Saved
  details are encrypted in D1 (AES-GCM, key derived from `LINK_SECRET`, so don't rotate that
  secret or saved details become unreadable). A `TRAVELERS_JSON` secret still works as a fallback.
- **`DUFFEL_ACCESS_TOKEN`** (Cloudflare secret): start with a test token (`duffel_test_…`).
  Test mode books fake flights and the site labels it clearly.
- **`CONTACT_BROCK_EMAIL`** (optional secret) lets Brock sign in and book himself. You can
  book for him either way.

## Website

`public/` holds a small static site (no build step) bundled into the Worker:

- **Browse**: recent deals with filters (airport, domestic/international, max price, sort). A
  banner says "Demo data" while fares come from the mock provider.
- **Sign up**: email, home airports and price limits. A confirmation email (double opt-in)
  activates alerts. Every alert has a one-tap unsubscribe. Subscribers get a booking link;
  only the configured contacts get Buy buttons.
- Until a sending domain is verified in Resend, Resend only delivers to the account
  owner's address, so other people's confirmation emails fail with a clear message.

## Costs to know

- **Cloudflare:** the free plan may work for dry runs. Use **Workers Paid ($5/mo)**
  before going live with Duffel. The free plan's per-run CPU limit is very low, Duffel
  search responses can be large to parse, and the paid plan also allows more outbound
  calls per run.
- **Duffel:** reportedly ~$3 per booking + 1%. It also charges an *excess search* fee
  when searches greatly outnumber bookings (reported ~1,500:1). The default setup is
  ~14,400 searches/month, so for steady monitoring, search with Ignav once that adapter
  exists and keep Duffel for booking.
- **Twilio:** a number is ~$1–2/mo, plus cents per call and text. US texting needs A2P
  10DLC registration first.

These figures come from third-party sources and change; check each pricing page.

## Layout

```
config.json        rules, routes, alert + booking settings (edit, then redeploy)
wrangler.toml      Worker, cron schedule, D1 binding
migrations/        D1 schema
src/
  index.ts         Worker entry: fetch + scheduled
  app.ts           routes: Twilio webhooks, admin
  monitor.ts       one cycle: search → filter → dedupe → alert
  planner.ts       which searches to run each cycle
  rules.ts         the deal rules
  booking.ts       buy flow + safety rails
  store.ts         D1 queries
  twilio.ts        texts, calls, TwiML, signature check
  duffel.ts        Duffel search + booking
  providers.ts     mock, Ignav (stub), factories
  messages.ts      text and call wording
test/              vitest suite (D1 stand-in on node:sqlite)
```
