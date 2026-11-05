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
import { type Config, isDomestic } from "./config";
import { daysBetween } from "./dates";
import { escHtml, page } from "./html";
import { verifySubscriberToken } from "./links";
import { city } from "./messages";
import type { Deal } from "./models";
import { ResendEmailer } from "./notify";
import { confirmationEmail, EMAIL_RE, SubscriberStore } from "./subscribers";

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

export function publicDeal(cfg: Config, d: Deal) {
  return {
    code: d.code,
    origin: d.origin, origin_city: city(d.origin),
    destination: d.destination, destination_city: city(d.destination),
    depart_date: d.depart_date, return_date: d.return_date,
    trip_days: daysBetween(d.depart_date, d.return_date),
    price: d.price, currency: d.currency,
    kind: isDomestic(cfg, d.destination) ? "domestic" : "international",
    airlines: JSON.parse(d.airlines) as string[],
    outbound_stops: d.outbound_stops, return_stops: d.return_stops,
    booking_url: d.booking_url,
    is_fake: !!d.is_fake,
    found_at: d.found_at,
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
    const sort = url.searchParams.get("sort") === "price" ? "price" : "recent";
    const demo = cfg.dryRun || cfg.provider === "mock";
    // Once live search is on, old test fares disappear from the site.
    let deals = (await store.recentDeals(300)).filter((d) => demo || !d.is_fake).map((d) => publicDeal(cfg, d));
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
