/**
 * Website API (the static site in public/ is bundled into the Worker, see static.ts).
 *
 *   GET  /api/meta                 airports, site rules, sign-in options, billing, live stats
 *   GET  /api/deals?origin=&kind=&max=&sort=&limit=   deals (a member sees them through their own rules)
 *   GET  /api/deal?code=           one deal, for shared links
 *   GET  /api/logic, PUT (admins)  site default rules;  GET /api/baselines   learned prices (members)
 *   POST /api/search               month price calendar for one route (members)
 *   GET|POST /u/unsubscribe?u=&t=  stop alerts from an email (also one-click from mail apps)
 *   POST /api/contact              JSON {name, email, message, website}: emails the owner, reply-to the sender
 */
import type { Deps } from "./app";
import { type Config, isDomestic, kindOf } from "./config";
import { Budget, BudgetExceeded, visitorLimit, visitorTag } from "./budget";
import { type CalendarDay, CheckStore } from "./checks";
import { addDays, daysBetween, localParts, utcDate } from "./dates";
import { rejectionReason } from "./rules";
import { escHtml, page } from "./html";
import { IgnavProvider } from "./ignav";
import { city, destCity, googleFlightsUrl, trustedBookingUrl } from "./messages";
import type { Deal } from "./models";
import { ResendEmailer } from "./notify";
import { paywall } from "./account";
import { verifyUnsubscribe } from "./alerts";
import { currentSession, currentUser, readCookie, sameOrigin, SESSION_COOKIE } from "./auth";
import { PRICE_CENTS, proLaunched, stripeEnabled, TRIAL_DAYS } from "./billing";
import { EMAIL_RE } from "./crypto";
import { providersEnabled } from "./oauth";
import { entitled, UserStore } from "./users";
import { pingReason, PriceHistory } from "./baselines";
import { defaultCategories, describe, loadSaved, personalCategories, resetCategories, saveCategories, toRaw, validateCat } from "./settings";

/**
 * Real numbers for the homepage, straight from our own records (never padded): deals found in the
 * last 30 days, how far below the route's usual price the worthwhile ones were, and routes tracked.
 */
async function siteStats(cfg: Config) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 19);
  const r = await cfg.env.DB.prepare(
    `SELECT COUNT(*) AS deals,
            AVG(CASE WHEN typical_median > 0 AND price < typical_median THEN 1.0 - price / typical_median END) AS below,
            COUNT(DISTINCT origin || destination) AS routes
     FROM deals WHERE is_fake = 0 AND found_at >= ?`,
  ).bind(since).first<{ deals: number; below: number | null; routes: number }>();
  const tracked = await cfg.env.DB.prepare("SELECT COUNT(DISTINCT origin || destination) AS n FROM price_obs")
    .first<{ n: number }>();
  return {
    deals_30d: Number(r?.deals ?? 0),
    routes_with_deals_30d: Number(r?.routes ?? 0),
    avg_below_usual_pct: r?.below != null ? Math.round(r.below * 100) : null,
    routes_tracked: Number(tracked?.n ?? 0),
    destinations: cfg.domestic.length + cfg.international.length,
  };
}

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

/** How long a found fare stays on the boards without being seen again. */
export const FRESH_HOURS = 48;

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
    booking_url: trustedBookingUrl(d),
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
  const p = url.pathname;

  if (p === "/api/meta" && req.method === "GET") {
    return json({
      origins: cfg.origins.map((o) => ({ code: o, city: city(o) })),
      domestic_max: cfg.domesticMaxPrice, international_max: cfg.internationalMaxPrice,
      min_days_out: cfg.minDaysOut, max_days_out: cfg.maxDaysOut, max_trip_days: cfg.maxTripDays,
      runs_per_day: cfg.runsPerDay,
      destinations: cfg.domestic.length + cfg.international.length,
      demo: cfg.dryRun || cfg.provider === "mock",
      destination_list: [...cfg.domestic.map((c) => ({ code: c, city: city(c), kind: "domestic" })),
        ...cfg.international.map((c) => ({ code: c, city: city(c), kind: "international" }))],
      search: {
        enabled: cfg.provider === "ignav",
        left_today: Math.max(0, cfg.siteSearchesPerDay - (await siteSearchBudget(cfg).usage()).today),
        per_day: cfg.siteSearchesPerDay,
        cache_hours: cfg.searchCacheHours,
      },
      auth: { providers: providersEnabled(cfg) },
      rules: { domestic: toRaw(cfg.cats.domestic), international: toRaw(cfg.cats.international) },
      billing: { enabled: stripeEnabled(cfg) && proLaunched(cfg), launched: proLaunched(cfg), price: `$${PRICE_CENTS / 100}/month`, trial_days: TRIAL_DAYS },
      stats: await siteStats(cfg),
      last_checked_at: await store.getState("last_cycle_at"),
    }, 200, { "Cache-Control": "public, max-age=60" });
  }

  // One deal, for shared links (#deal=CODE). Old (30+ days) and test fares aren't shared.
  if (p === "/api/deal" && req.method === "GET") {
    const code = (url.searchParams.get("code") ?? "").toUpperCase();
    if (!/^[A-Z0-9]{2,24}$/.test(code)) return json({ ok: false, error: "Not found." }, 404);
    const d = await store.dealByCode(code);
    const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 19);
    if (!d || d.is_fake || d.found_at < monthAgo) return json({ ok: false, error: "That deal has expired." }, 404);
    return json({ ok: true, deal: publicDeal(cfg, d), stale: !!d.superseded_at || d.found_at < new Date(Date.now() - FRESH_HOURS * 3600_000).toISOString().slice(0, 19) },
      200, { "Cache-Control": "public, max-age=300" });
  }

  if (p === "/api/deals" && req.method === "GET") {
    const origin = (url.searchParams.get("origin") ?? "").toUpperCase();
    const kind = url.searchParams.get("kind") ?? "";
    const max = intIn(url.searchParams.get("max"), 1, 100000);
    const limit = intIn(url.searchParams.get("limit"), 1, 100) ?? 60;
    const sortParam = url.searchParams.get("sort");
    const sort = sortParam === "price" || sortParam === "value" ? sortParam : "recent";
    const demo = cfg.dryRun || cfg.provider === "mock";
    // Visitors all see the same boards, so their answer is cached at the edge for a minute. That
    // keeps a busy day from turning into a database read per page view.
    const anon = !readCookie(req, SESSION_COOKIE);
    const edge = anon && typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : null;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    if (edge) {
      const hit = await edge.match(cacheKey).catch(() => undefined);
      if (hit) return hit;
    }

    // Members see the deals through their own rules (which deals show, and which count as a ping).
    // Visitors and members without a subscription see the site defaults.
    const s = await currentSession(cfg, req);
    const personal = s && entitled(s.user) && s.user.rules ? personalCategories(cfg, s.user.rules) : null;
    const cats = personal ?? cfg.cats;
    const view = { ...cfg, cats } as Config;
    const baselines = personal ? new Map((await new PriceHistory(cfg.env.DB).all())
      .map((b) => [`${b.origin}${b.destination}`, b])) : null;

    // Only deals that still fit the rules, were found in the last 48 hours, and haven't since been
    // seen at a higher price. Cheap fares move fast; an old price is a promise we can't keep.
    const today = localParts(new Date(), cfg.timezone).date;
    const freshSince = new Date(Date.now() - FRESH_HOURS * 3600_000).toISOString();
    const stillValid = (d: Deal) => d.found_at >= freshSince.slice(0, 19) && !d.superseded_at && !rejectionReason(view, {
      provider: d.provider, origin: d.origin, destination: d.destination, departDate: d.depart_date,
      returnDate: d.return_date, price: d.price, currency: d.currency, airlines: [], outboundStops: 0, returnStops: 0,
      offerId: null, bookingUrl: null, isFake: !!d.is_fake, kind: d.kind ?? undefined }, today);
    let deals = (await store.recentDeals(400)).filter((d) => (demo || !d.is_fake) && stillValid(d)).map((d) => {
      const pd = publicDeal(cfg, d);
      if (!personal) return pd;
      const rule = cats[pd.kind].alert;
      const b = baselines!.get(`${d.origin}${d.destination}`);
      const base = b && b.samples >= rule.minSamples ? { ...b, pooled: false } : null;
      const why = pingReason(d.price, rule, base);
      return { ...pd, pinged: !!why, ping_reason: why,
        typical: base ? { median: base.median, low: base.low, high: base.high } : pd.typical };
    });
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
    const score = (d: ReturnType<typeof publicDeal>) => d.price / (d.typical?.median ?? cats[d.kind].showUnder);
    if (sort === "value") deals.sort((a, b) => Number(b.pinged) - Number(a.pinged) || score(a) - score(b));
    if (edge) {
      const res = json({ deals: deals.slice(0, limit), personal: false }, 200, { "Cache-Control": "public, max-age=60" });
      deps.background(edge.put(cacheKey, res.clone()).catch(() => {}));
      return res;
    }
    return json({ deals: deals.slice(0, limit), personal: !!personal }, 200, { "Cache-Control": "private, no-cache", Vary: "Cookie" });
  }

  // ---- Contact form: emails the owner, never shows their address ----
  if (p === "/api/contact" && req.method === "POST") {
    if (!sameOrigin(cfg, req)) return json({ ok: false, error: "Bad origin." }, 403);
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request." }, 400); }
    if (body.website) return json({ ok: true }); // honeypot: pretend success
    const name = String(body.name ?? "").trim().slice(0, 80);
    const email = String(body.email ?? "").trim().toLowerCase();
    const message = String(body.message ?? "").trim();
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "That email doesn't look right." }, 400);
    if (message.length < 5) return json({ ok: false, error: "Write a message first." }, 400);
    if (message.length > 4000) return json({ ok: false, error: "Keep it under 4,000 characters." }, 400);

    const owner = cfg.contacts.find((c) => c.email);
    const key = cfg.env.RESEND_API_KEY;
    if (!owner || !key) return json({ ok: false, error: "Messages aren't set up on this site yet." }, 503);
    const tag = await visitorTag(String(cfg.env.LINK_SECRET ?? ""), req.headers.get("CF-Connecting-IP") ?? "local");
    try {
      await visitorLimit(cfg.env.DB, "contact", tag, 3).take();
      await new Budget(cfg.env.DB, "contact", 20, Number.MAX_SAFE_INTEGER).take();
    } catch (e) {
      if (e instanceof BudgetExceeded) return json({ ok: false, error: "Too many messages today. Try again tomorrow." }, 429);
      throw e;
    }
    const who = name ? `${name} <${email}>` : email;
    try {
      await new ResendEmailer(key, String(cfg.env.EMAIL_FROM ?? cfg.emailFrom)).send(owner.email, {
        subject: `Fare Radar message from ${name || email}`,
        text: `From: ${who}\n\n${message}\n\n(Reply to this email to answer them.)`,
        html: `<div style="font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.55;max-width:560px">`
          + `<p style="color:#666;margin:0 0 12px">Sent from the Fare Radar contact form by <b>${escHtml(who)}</b>. `
          + `Reply to this email to answer them.</p>`
          + `<div style="white-space:pre-wrap;padding:14px 16px;border-radius:10px;background:#f4f2ea">${escHtml(message)}</div></div>`,
        replyTo: email,
      });
    } catch (e) {
      console.error("contact email failed", e);
      return json({ ok: false, error: "We couldn't send that. Try again in a bit." }, 502);
    }
    return json({ ok: true });
  }

  // ---- Logic: everyone's own rules live at /api/account/rules. These are the site defaults:
  // what visitors see, what the hourly search uses, and what new members start from. Admins only.
  if (p === "/api/logic" && req.method === "GET") {
    const s = await currentSession(cfg, req);
    if (!s) return json({ ok: false, code: "sign_in_required", error: "Sign in to see the logic." }, 401);
    if (!entitled(s.user)) return paywall();
    const saved = await loadSaved(cfg.env.DB);
    return json({
      categories: { domestic: toRaw(cfg.cats.domestic), international: toRaw(cfg.cats.international) },
      defaults: { domestic: toRaw(defaultCategories().domestic), international: toRaw(defaultCategories().international) },
      summaries: { domestic: describe("domestic", cfg.cats.domestic), international: describe("international", cfg.cats.international) },
      customized: Object.keys(saved.cats).length > 0, updated_at: saved.updated_at, updated_by: saved.updated_by,
      can_edit: !!(await currentUser(cfg, req)),
    });
  }

  if (p === "/api/logic" && req.method === "PUT") {
    const user = await currentUser(cfg, req);
    if (!user) return json({ ok: false, error: "Only admins can change the site defaults." }, 403);
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
    if (!(await currentUser(cfg, req))) return json({ ok: false, error: "Only admins can change the site defaults." }, 403);
    await resetCategories(cfg.env.DB);
    return json({ ok: true });
  }

  if (p === "/api/baselines" && req.method === "GET") {
    const s = await currentSession(cfg, req);
    if (!s) return json({ ok: false, code: "sign_in_required", error: "Sign in first." }, 401);
    if (!entitled(s.user)) return paywall();
    const rows = (await new PriceHistory(cfg.env.DB).all()).map((b) => ({
      ...b, destination_city: city(b.destination), kind: kindOf(cfg, b),
    }));
    rows.sort((a, b) => a.destination_city.localeCompare(b.destination_city) || a.origin.localeCompare(b.origin));
    return json({ routes: rows }, 200, { "Cache-Control": "private, max-age=120" });
  }

  if (p === "/api/search" && req.method === "POST") {
    const s = await currentSession(cfg, req);
    if (!s) return json({ ok: false, code: "sign_in_required", error: "Sign in to check a route." }, 401);
    if (!entitled(s.user)) return paywall();
    return siteSearch(req, deps);
  }

  // Free email sign-ups were replaced by member alerts.
  if (p === "/api/subscribe") {
    return json({ ok: false, code: "subscription_required",
      error: "Deal alerts are part of a Fare Radar membership now. Create an account to get them." }, 410);
  }

  // One-tap "stop alerts" from an email. GET shows a button; POST (the button, or a mail app's
  // RFC 8058 one-click with "List-Unsubscribe=One-Click") turns alerts off.
  if (p === "/u/unsubscribe" && (req.method === "GET" || req.method === "POST")) {
    const params = new URLSearchParams(url.searchParams);
    if (req.method === "POST") for (const [k, v] of new URLSearchParams(await req.text())) params.set(k, v);
    const id = Number(params.get("u")), t = params.get("t") ?? "";
    if (!(await verifyUnsubscribe(cfg, id, t))) {
      return page("Link not valid", "<h2>That link isn't valid anymore.</h2><p>You can turn alerts off on your "
        + "<a href=\"/#account\">Account page</a>.</p>", 400);
    }
    if (req.method === "GET") {
      return page("Stop alerts", "<h2>Stop deal alerts?</h2><p>You can turn them back on from your Account page.</p>"
        + `<form method=post><input type=hidden name=u value="${id}"><input type=hidden name=t value="${escHtml(t)}">`
        + "<button class=skip>Stop alerts</button></form>");
    }
    const users = UserStore.for(cfg);
    const u = await users.byId(id);
    if (u) await users.setAlerts(u.id, false, u.origins);
    return page("Alerts off", "<h2>Alerts are off.</h2><p>You won't get deal emails. Turn them back on any time "
      + "from your <a href=\"/#account\">Account page</a>.</p>");
  }
  if (p === "/u/confirm") {
    return page("Alerts moved", "<h2>Deal alerts are now part of membership.</h2><p>Create an account on the site "
      + "to get alerts with your own rules.</p>");
  }

  return null;
}

// ---------------- on-site fare search ----------------

/** Live searches the whole site may make per day (on top of the global Ignav budget). */
export const siteSearchBudget = (cfg: Config) =>
  new Budget(cfg.env.DB, "site_search", cfg.siteSearchesPerDay, Number.MAX_SAFE_INTEGER);

async function visitorBudget(cfg: Config, ip: string) {
  // Store a short hash, not the raw IP.
  const tag = await visitorTag(String(cfg.env.LINK_SECRET ?? ""), ip);
  return visitorLimit(cfg.env.DB, "search", tag, cfg.siteSearchesPerVisitor);
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
