/**
 * Website API (the static site lives in public/ and is served by Workers Assets).
 *
 *   GET  /api/meta                 airports, limits, mode, stats
 *   GET  /api/deals?origin=&kind=&max=&sort=&limit=   recent deals for Browse
 *   POST /api/subscribe            JSON {email, origins, domestic_max, international_max, website}
 *   GET  /u/confirm?id=&t=         confirmation page (button)   POST performs it
 *   GET  /u/unsubscribe?id=&t=     unsubscribe page (button)    POST performs it
 */
import type { Deps } from "./app";
import { type Config, isDomestic, kindOf } from "./config";
import { Budget, BudgetExceeded } from "./budget";
import { type CalendarDay, CheckStore } from "./checks";
import { addDays, daysBetween, localParts, utcDate } from "./dates";
import { rejectionReason } from "./rules";
import { escHtml, page } from "./html";
import { verifySubscriberToken } from "./links";
import { IgnavProvider } from "./ignav";
import { city, destCity, googleFlightsUrl } from "./messages";
import type { Deal } from "./models";
import { ResendEmailer } from "./notify";
import { currentUser, sameOrigin } from "./auth";
import { PriceHistory } from "./baselines";
import { defaultCategories, describe, loadSaved, resetCategories, saveCategories, toRaw, validateCat } from "./settings";
import { confirmationEmail, EMAIL_RE, SubscriberStore } from "./subscribers";

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

export function publicDeal(cfg: Config, d: Deal) {
  return {
    code: d.code,
    origin: d.origin, origin_city: city(d.origin),
    destination: d.destination, destination_city: destCity(d),
    depart_date: d.depart_date, return_date: d.return_date,
    trip_days: daysBetween(d.depart_date, d.return_date),
    price: d.price, currency: d.currency,
    kind: kindOf(cfg, d),
    airlines: JSON.parse(d.airlines) as string[],
    outbound_stops: d.outbound_stops, return_stops: d.return_stops,
    booking_url: d.booking_url,
    is_fake: !!d.is_fake,
    found_at: d.found_at,
    typical: d.typical_median ? { median: d.typical_median, low: d.typical_low, high: d.typical_high } : null,
    pinged: !!d.alerted_at,
    ping_reason: d.alerted_at ? d.ping_reason : null,
    /** Price from a price calendar or Google Explore, not yet an exact bookable quote. */
    estimate: d.provider === "ignav-calendar" || d.provider === "google-explore",
  };
}

const intIn = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null;
};

export async function siteRoute(req: Request, url: URL, deps: Deps): Promise<Response | null> {
  const { cfg, store } = deps;
  const subs = deps.subs ?? new SubscriberStore(cfg.env.DB);
  const p = url.pathname;

  if (p === "/api/meta" && req.method === "GET") {
    return json({
      origins: cfg.origins.map((o) => ({ code: o, city: city(o) })),
      domestic_max: cfg.domesticMaxPrice, international_max: cfg.internationalMaxPrice,
      min_days_out: cfg.minDaysOut, max_days_out: cfg.maxDaysOut, max_trip_days: cfg.maxTripDays,
      runs_per_day: cfg.runsPerDay,
      destinations: cfg.domestic.length + cfg.international.length,
      demo: cfg.dryRun || cfg.provider === "mock",
      subscribers: (await subs.counts()).active,
      destination_list: [...cfg.domestic.map((c) => ({ code: c, city: city(c), kind: "domestic" })),
        ...cfg.international.map((c) => ({ code: c, city: city(c), kind: "international" }))],
      search: {
        enabled: cfg.provider === "ignav",
        left_today: Math.max(0, cfg.siteSearchesPerDay - (await siteSearchBudget(cfg).usage()).today),
        per_day: cfg.siteSearchesPerDay,
        cache_hours: cfg.searchCacheHours,
      },
      checks_total: await new CheckStore(cfg.env.DB).count(),
      cycle: Number(await store.getState("cycle") ?? 0),
      last_checked_at: await store.getState("last_cycle_at"),
      searches_per_cycle: cfg.searchesPerCycle,
      routes: cfg.origins.length * (cfg.domestic.length + cfg.international.length),
    });
  }

  if (p === "/api/deals" && req.method === "GET") {
    const origin = (url.searchParams.get("origin") ?? "").toUpperCase();
    const kind = url.searchParams.get("kind") ?? "";
    const max = intIn(url.searchParams.get("max"), 1, 100000);
    const limit = intIn(url.searchParams.get("limit"), 1, 100) ?? 60;
    const sortParam = url.searchParams.get("sort");
    const sort = sortParam === "price" || sortParam === "value" ? sortParam : "recent";
    const demo = cfg.dryRun || cfg.provider === "mock";
    // Once live search is on, old test fares disappear from the site.
    // Only deals that still fit today's rules (the Logic panel can change them) and were seen in
    // the last week; older prices have likely moved.
    const today = localParts(new Date(), cfg.timezone).date;
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const stillValid = (d: Deal) => d.found_at >= weekAgo.slice(0, 19) && !rejectionReason(cfg, {
      provider: d.provider, origin: d.origin, destination: d.destination, departDate: d.depart_date,
      returnDate: d.return_date, price: d.price, currency: d.currency, airlines: [], outboundStops: 0, returnStops: 0,
      offerId: null, bookingUrl: null, isFake: !!d.is_fake, kind: d.kind ?? undefined }, today);
    let deals = (await store.recentDeals(400)).filter((d) => (demo || !d.is_fake) && stillValid(d))
      .map((d) => publicDeal(cfg, d));
    if (cfg.origins.includes(origin)) deals = deals.filter((d) => d.origin === origin);
    if (kind === "domestic" || kind === "international") deals = deals.filter((d) => d.kind === kind);
    if (max) deals = deals.filter((d) => d.price <= max);
    // One card per route+dates: keep the newest sighting.
    const seen = new Set<string>();
    deals = deals.filter((d) => {
      const k = `${d.origin}${d.destination}${d.depart_date}${d.return_date}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (sort === "price") deals.sort((a, b) => a.price - b.price);
    // Best value: pinged first, then furthest below the route's usual price (or below the show limit).
    const score = (d: ReturnType<typeof publicDeal>) => d.price / (d.typical?.median ?? cfg.cats[d.kind].showUnder);
    if (sort === "value") deals.sort((a, b) => Number(b.pinged) - Number(a.pinged) || score(a) - score(b));
    return json({ deals: deals.slice(0, limit) }, 200, { "Cache-Control": "public, max-age=60" });
  }

  if (p === "/api/subscribe" && req.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }
    if (body.website) return json({ ok: true, status: "check_email" }); // honeypot: pretend success

    const email = String(body.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "That email doesn't look right." }, 400);
    const origins = Array.isArray(body.origins)
      ? [...new Set(body.origins.map((o) => String(o).toUpperCase()))].filter((o) => cfg.origins.includes(o))
      : [];
    if (!origins.length) return json({ ok: false, error: "Pick at least one home airport." }, 400);
    const dom = intIn(body.domestic_max ?? cfg.domesticMaxPrice, 20, cfg.domesticMaxPrice);
    const intl = intIn(body.international_max ?? cfg.internationalMaxPrice, 50, cfg.internationalMaxPrice);
    if (dom === null || intl === null) {
      return json({ ok: false, error: `Limits must be up to $${cfg.domesticMaxPrice} domestic `
        + `and $${cfg.internationalMaxPrice} international.` }, 400);
    }

    const ip = req.headers.get("CF-Connecting-IP") ?? "local";
    if (await subs.throttled(ip)) return json({ ok: false, error: "Too many sign-ups. Try again in an hour." }, 429);

    const s = await subs.upsert(email, origins, dom, intl);
    if (s.status === "active") return json({ ok: true, status: "updated" });

    const key = cfg.env.RESEND_API_KEY;
    if (!key) return json({ ok: false, error: "Email isn't set up on this site yet." }, 503);
    try {
      await new ResendEmailer(key, String(cfg.env.EMAIL_FROM ?? cfg.emailFrom))
        .send(s.email, await confirmationEmail(cfg, s));
    } catch (e) {
      console.error("confirmation email failed", e);
      return json({ ok: false, error: "We couldn't send the confirmation email. The site may only be able to "
        + "email its owner until a sending domain is set up." }, 502);
    }
    return json({ ok: true, status: "check_email" });
  }

  // ---- Logic panel ----
  if (p === "/api/logic" && req.method === "GET") {
    const saved = await loadSaved(cfg.env.DB);
    const defs = defaultCategories();
    const user = await currentUser(cfg, req);
    return json({
      categories: { domestic: toRaw(cfg.cats.domestic), international: toRaw(cfg.cats.international) },
      defaults: { domestic: toRaw(defs.domestic), international: toRaw(defs.international) },
      summaries: { domestic: describe("domestic", cfg.cats.domestic), international: describe("international", cfg.cats.international) },
      customized: Object.keys(saved.cats).length > 0, updated_at: saved.updated_at, updated_by: saved.updated_by,
      can_edit: !!user,
    });
  }

  if (p === "/api/logic" && req.method === "PUT") {
    if (!sameOrigin(cfg, req)) return json({ ok: false, error: "Bad origin." }, 403);
    const user = await currentUser(cfg, req);
    if (!user) return json({ ok: false, error: "Sign in to change the logic." }, 401);
    let b: Record<string, unknown>;
    try { b = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }
    const dom = validateCat(b.domestic), intl = validateCat(b.international);
    if (!dom.ok || !intl.ok) {
      return json({ ok: false, error: "Some values need fixing.", fields: {
        domestic: dom.ok ? {} : dom.errors, international: intl.ok ? {} : intl.errors } }, 400);
    }
    const cats = { domestic: dom.rules, international: intl.rules };
    await saveCategories(cfg.env.DB, cats, user.name);
    return json({ ok: true, summaries: { domestic: describe("domestic", cats.domestic),
      international: describe("international", cats.international) } });
  }

  if (p === "/api/logic/reset" && req.method === "POST") {
    if (!sameOrigin(cfg, req)) return json({ ok: false, error: "Bad origin." }, 403);
    if (!(await currentUser(cfg, req))) return json({ ok: false, error: "Sign in to change the logic." }, 401);
    await resetCategories(cfg.env.DB);
    return json({ ok: true });
  }

  if (p === "/api/baselines" && req.method === "GET") {
    const rows = (await new PriceHistory(cfg.env.DB).all()).map((b) => ({
      ...b, destination_city: city(b.destination), kind: kindOf(cfg, b),
    }));
    rows.sort((a, b) => a.destination_city.localeCompare(b.destination_city) || a.origin.localeCompare(b.origin));
    return json({ routes: rows }, 200, { "Cache-Control": "public, max-age=120" });
  }

  if (p === "/api/checks" && req.method === "GET") {
    const limit = intIn(url.searchParams.get("limit"), 1, 50) ?? 12;
    const checks = (await new CheckStore(cfg.env.DB).recent(limit)).map((c) => ({
      origin: c.origin, origin_city: city(c.origin), destination: c.destination, destination_city: city(c.destination),
      kind: isDomestic(cfg, c.destination) ? "domestic" : "international",
      window_start: c.window_start, window_end: addDays(c.window_start, c.window_days - 1), stay_days: c.stay_days,
      cheapest: c.cheapest, cheapest_date: c.cheapest_date,
      cheapest_return: c.cheapest_date ? addDays(c.cheapest_date, c.stay_days) : null,
      limit: c.price_limit, checked_at: c.checked_at,
    }));
    return json({ checks }, 200, { "Cache-Control": "public, max-age=60" });
  }

  if (p === "/api/search" && req.method === "POST") return siteSearch(req, deps);

  const sub = p.match(/^\/u\/(confirm|unsubscribe)$/);
  if (sub && (req.method === "GET" || req.method === "POST")) {
    const purpose = sub[1] as "confirm" | "unsubscribe";
    const params = req.method === "POST" ? new URLSearchParams(await req.text()) : url.searchParams;
    const id = Number(params.get("id")), t = params.get("t") ?? "";
    if (!(await verifySubscriberToken(cfg, id, purpose, t))) {
      return page("Invalid link", "<h2>That link isn't valid.</h2><p class=muted>It may be incomplete or altered.</p>", 403);
    }
    const s = await subs.byId(id);
    if (!s) return page("Not found", "<h2>We couldn't find that sign-up.</h2>", 404);
    const hidden = `<input type=hidden name=id value="${s.id}"><input type=hidden name=t value="${escHtml(t)}">`;

    if (req.method === "GET") {
      return purpose === "confirm"
        ? page("Confirm alerts", `<h2>Confirm deal alerts</h2><p>For <b>${escHtml(s.email)}</b>.</p>`
          + `<form method=post>${hidden}<button class=primary>Confirm</button></form>`)
        : page("Unsubscribe", `<h2>Stop deal alerts?</h2><p>For <b>${escHtml(s.email)}</b>.</p>`
          + `<form method=post>${hidden}<button class=skip>Unsubscribe</button></form>`);
    }
    if (purpose === "confirm") {
      if (s.status !== "unsubscribed") await subs.setStatus(s.id, "active");
      return page("You're in", s.status === "unsubscribed"
        ? "<h2>You're unsubscribed.</h2><p>Sign up again on the site to restart alerts.</p>"
        : "<h2>You're in ✈︎</h2><p>We'll email you when a fare beats your limits.</p>");
    }
    await subs.setStatus(s.id, "unsubscribed");
    return page("Unsubscribed", "<h2>Unsubscribed.</h2><p>You won't get any more deal emails.</p>");
  }

  return null;
}

// ---------------- on-site fare search ----------------

/** Live searches the whole site may make per day (on top of the global Ignav budget). */
export const siteSearchBudget = (cfg: Config) =>
  new Budget(cfg.env.DB, "site_search", cfg.siteSearchesPerDay, Number.MAX_SAFE_INTEGER);

async function visitorBudget(cfg: Config, ip: string) {
  // Store a short hash, not the raw IP.
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${String(cfg.env.LINK_SECRET ?? "")}`));
  const tag = [...new Uint8Array(h).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Budget(cfg.env.DB, `visitor_search_${tag}`, cfg.siteSearchesPerVisitor, Number.MAX_SAFE_INTEGER);
}

const lastOfMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

async function siteSearch(req: Request, deps: Deps): Promise<Response> {
  const { cfg } = deps;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }

  const origin = String(body.origin ?? "").toUpperCase();
  const destination = String(body.destination ?? "").toUpperCase();
  const month = String(body.month ?? "");
  const stay = intIn(body.stay_days, 1, cfg.maxTripDays);
  if (!cfg.origins.includes(origin)) return json({ ok: false, error: "Pick Seattle or Portland." }, 400);
  if (![...cfg.domestic, ...cfg.international].includes(destination)) {
    return json({ ok: false, error: "Pick a destination from the list." }, 400);
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json({ ok: false, error: "Pick a month." }, 400);
  if (stay === null) return json({ ok: false, error: `Trip length must be 1 to ${cfg.maxTripDays} days.` }, 400);

  const today = utcDate(new Date());
  const first = `${month}-01`;
  const start = first > today ? first : addDays(today, 1);
  const end = lastOfMonth(month);
  if (start > end) return json({ ok: false, error: "That month has already passed." }, 400);
  if (daysBetween(today, start) > 330) return json({ ok: false, error: "Fares aren't published that far out yet." }, 400);
  const windowDays = daysBetween(start, end) + 1;
  const limit = isDomestic(cfg, destination) ? cfg.domesticMaxPrice : cfg.internationalMaxPrice;
  const store = new CheckStore(cfg.env.DB);
  const reply = (days: CalendarDay[], checkedAt: string, cached: boolean, left: number) => json({
    ok: true, cached, checked_at: checkedAt, origin, destination, origin_city: city(origin),
    destination_city: city(destination), stay_days: stay, limit, searches_left_today: left,
    days: days.map((x) => ({ ...x, url: googleFlightsUrl(origin, destination, x.d, x.r ?? addDays(x.d, stay)) })),
  });
  const siteBudget = siteSearchBudget(cfg);
  const leftToday = async () => Math.max(0, cfg.siteSearchesPerDay - (await siteBudget.usage()).today);

  // Recent identical search (by anyone): free.
  const hit = await store.fresh(origin, destination, start, windowDays, stay, cfg.searchCacheHours);
  if (hit) return reply(JSON.parse(hit.dates), hit.checked_at, true, await leftToday());

  const provider = deps.fareProvider();
  if (!(provider instanceof IgnavProvider)) {
    return json({ ok: false, error: "Live search isn't switched on yet." }, 503);
  }
  const visitor = await visitorBudget(cfg, req.headers.get("CF-Connecting-IP") ?? "local");
  try { await visitor.take(); } catch {
    return json({ ok: false, error: `You've used today's ${cfg.siteSearchesPerVisitor} live searches. `
      + "Recent results still load instantly." }, 429);
  }
  try { await siteBudget.take(); } catch {
    await visitor.refund();
    return json({ ok: false, error: "The site has used today's live searches. Try again tomorrow." }, 429);
  }
  try {
    const days = await provider.calendarDays(origin, destination, start, windowDays, stay);
    await store.save({ origin, destination, windowStart: start, windowDays, stayDays: stay, days, limit,
      source: "search" });
    try { await new PriceHistory(cfg.env.DB).recordCalendar(origin, destination, stay, days, "search"); }
    catch (e) { console.error("saving search prices failed", e); }
    return reply(days, new Date().toISOString(), false, await leftToday());
  } catch (e) {
    await visitor.refund();
    await siteBudget.refund();
    if (e instanceof BudgetExceeded) {
      return json({ ok: false, error: "Today's search budget is used up. Try again tomorrow." }, 429);
    }
    console.error("site search failed", e);
    return json({ ok: false, error: "The fare search didn't respond. Try again in a minute." }, 502);
  }
}
