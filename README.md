# Flight Deal Monitor

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
| Texts + calls (Twilio), keypad and text-reply handling | ✅ built + tested; signature check verified against Twilio's official SDK |
| Booking via Duffel, with safety rails | ✅ built + tested with a fake booker; **not yet run against a real Duffel account** |
| Duffel fare search | ✅ built; request shape tested; not yet run live |
| Local end-to-end on Cloudflare's runtime (`wrangler dev`) | ✅ cron, admin, call script, simulated buy |
| Ignav fare search (the cheaper option for high volume) | ⏳ not written yet: docs were unreachable from the build environment |
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
   gets a **text** to both of you. The best deal of the cycle also gets a **call**.
   Between 10pm and 8am Pacific it's texts only.
3. **On the call:** press **1** to buy (then **9** to confirm), **2** to skip, **3** to repeat.
   **By text:** reply `BUY K7Q2`, then `YES K7Q2`.
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
```

Deploying: see [DEPLOY.md](DEPLOY.md).

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
