/**
 * Owner-only routes: sign-in, and searching/booking real flights from the site.
 *
 *   GET  /api/me          who is signed in, and whether booking is set up
 *   POST /api/login       {email}: email a sign-in link to a configured contact
 *   GET  /u/login         sign-in page (button);  POST /u/login signs in (sets cookie)
 *   POST /api/logout
 *   POST /api/offers      {origin, destination, depart_date, return_date, travelers[]}
 *   POST /api/book        {offer_id, travelers[], expected_total, origin, destination, depart_date, return_date}
 *
 * Everything that changes state requires a same-origin request; /api/offers and
 * /api/book also require a signed-in contact.
 */
import type { Deps } from "./app";
import { clearCookie, contactByEmail, currentUser, loginLink, sameOrigin, sessionCookie, verifyLoginLink } from "./auth";
import { Budget } from "./budget";
import { type Config, loadTravelers } from "./config";
import { daysBetween, utcDate } from "./dates";
import { DuffelProvider, viewOffer } from "./duffel";
import { escHtml, page } from "./html";
import { ResendEmailer } from "./notify";
import { bookOffer } from "./purchase";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json",
    "Cache-Control": "no-store", ...headers } });

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function duffelFor(cfg: Config): DuffelProvider | null {
  const t = cfg.env.DUFFEL_ACCESS_TOKEN;
  return typeof t === "string" && t ? new DuffelProvider(t, cfg.cabinClass, cfg.maxConnections) : null;
}

function travelerStatus(cfg: Config) {
  try {
    const t = loadTravelers(cfg);
    return cfg.contacts.map((c) => ({ name: c.name, ready: !!t[c.name],
      passport: !!(t[c.name]?.passport_number && t[c.name]?.passport_expires_on && t[c.name]?.passport_country) }));
  } catch {
    return cfg.contacts.map((c) => ({ name: c.name, ready: false, passport: false }));
  }
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try { return await req.json() as Record<string, unknown>; } catch { return null; }
}

export async function ownerRoute(req: Request, url: URL, deps: Deps): Promise<Response | null> {
  const { cfg } = deps;
  const p = url.pathname;

  if (p === "/api/me" && req.method === "GET") {
    const user = await currentUser(cfg, req);
    if (!user) return json({ signed_in: false });
    const duffel = duffelFor(cfg);
    return json({
      signed_in: true, name: user.name,
      booking: {
        enabled: cfg.bookingEnabled && !cfg.dryRun,
        duffel: !!duffel, test_mode: duffel?.testMode ?? null,
        travelers: travelerStatus(cfg),
        spend_cap: cfg.dailySpendCap, max_price_increase_percent: cfg.maxPriceIncreasePercent,
      },
    });
  }

  if (p === "/api/login" && req.method === "POST") {
    if (!sameOrigin(cfg, req)) return json({ ok: false, error: "Bad origin." }, 403);
    const b = await body(req);
    const email = String(b?.email ?? "");
    const ip = req.headers.get("CF-Connecting-IP") ?? "local";
    const limiter = new Budget(cfg.env.DB, `login_${ip.replace(/[^0-9a-f:.]/gi, "")}`, 5, Number.MAX_SAFE_INTEGER);
    try { await limiter.take(); } catch { return json({ ok: false, error: "Too many attempts. Try again tomorrow." }, 429); }
    const c = contactByEmail(cfg, email);
    if (c && typeof cfg.env.RESEND_API_KEY === "string" && cfg.env.RESEND_API_KEY) {
      try {
        const link = await loginLink(cfg, c);
        await new ResendEmailer(cfg.env.RESEND_API_KEY, String(cfg.env.EMAIL_FROM ?? cfg.emailFrom)).send(c.email, {
          subject: "Your Fare Radar sign-in link",
          text: `Sign in to book flights on Fare Radar (link works for 20 minutes):\n${link}\n\nDidn't ask for this? Ignore it.`,
          html: `<div style="font-family:-apple-system,system-ui,sans-serif;font-size:15px;line-height:1.5">`
            + `<p>Sign in to book flights on Fare Radar. The link works for 20 minutes.</p>`
            + `<p><a href="${escHtml(link)}" style="display:inline-block;padding:11px 22px;border-radius:999px;`
            + `background:#0a7cff;color:#fff;text-decoration:none;font-weight:600">Sign in</a></p>`
            + `<p style="color:#666;font-size:13px">Didn't ask for this? Ignore it.</p></div>`,
        });
      } catch (e) { console.error("login email failed", e); }
    }
    // Same answer either way, so the form doesn't reveal which emails can sign in.
    return json({ ok: true });
  }

  if (p === "/u/login" && (req.method === "GET" || req.method === "POST")) {
    const params = req.method === "POST" ? new URLSearchParams(await req.text()) : url.searchParams;
    const n = params.get("n") ?? "", x = params.get("x") ?? "", t = params.get("t") ?? "";
    const c = await verifyLoginLink(cfg, n, x, t);
    if (!c) {
      return page("Link expired", "<h2>That sign-in link has expired or isn't valid.</h2>"
        + "<p>Request a new one from the site.</p>", 403);
    }
    if (req.method === "GET") {
      const hidden = ["n", "x", "t"].map((k) => `<input type=hidden name=${k} value="${escHtml(params.get(k) ?? "")}">`).join("");
      return page("Sign in", `<h2>Sign in to Fare Radar</h2><p>As <b>${escHtml(c.name.toLowerCase())}</b>, on this device.</p>`
        + `<form method=post>${hidden}<button class=primary>Sign in</button></form>`);
    }
    return new Response(null, { status: 303, headers: { Location: "/#browse", "Set-Cookie": await sessionCookie(cfg, c) } });
  }

  if (p === "/api/logout" && req.method === "POST") {
    if (!sameOrigin(cfg, req)) return json({ ok: false }, 403);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  if ((p === "/api/offers" || p === "/api/book") && req.method === "POST") {
    if (!sameOrigin(cfg, req)) return json({ ok: false, error: "Bad origin." }, 403);
    const user = await currentUser(cfg, req);
    if (!user) return json({ ok: false, error: "Sign in to book." }, 401);
    const duffel = duffelFor(cfg);
    if (!duffel) return json({ ok: false, error: "Booking isn't set up yet: add the DUFFEL_ACCESS_TOKEN secret." }, 503);
    const b = await body(req);
    if (!b) return json({ ok: false, error: "Bad request." }, 400);

    const origin = String(b.origin ?? "").toUpperCase();
    const destination = String(b.destination ?? "").toUpperCase();
    const depart = String(b.depart_date ?? ""), ret = String(b.return_date ?? "");
    const travelers = Array.isArray(b.travelers) ? b.travelers.map((t) => String(t).toUpperCase()) : [];
    if (!cfg.origins.includes(origin) && !cfg.origins.includes(destination)) {
      return json({ ok: false, error: "Trips must start from one of the home airports." }, 400);
    }
    if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination) || origin === destination) {
      return json({ ok: false, error: "Pick two different airports." }, 400);
    }
    const today = utcDate(new Date());
    if (!ISO.test(depart) || !ISO.test(ret) || depart <= today || ret <= depart || daysBetween(today, depart) > 330
        || daysBetween(depart, ret) > 60) {
      return json({ ok: false, error: "Pick a departure after today and a return after that." }, 400);
    }
    if (!travelers.length || travelers.length > cfg.contacts.length
        || travelers.some((t) => !cfg.contacts.find((c) => c.name === t))) {
      return json({ ok: false, error: "Pick who's flying." }, 400);
    }

    if (p === "/api/offers") {
      try {
        const offers = await duffel.listOffers(origin, destination, depart, ret, travelers.length);
        return json({ ok: true, test_mode: duffel.testMode, offers: offers.map(viewOffer) });
      } catch (e) {
        console.error("offers failed", e);
        return json({ ok: false, error: `The airline search didn't respond (${(e as Error).message}).` }, 502);
      }
    }

    const offerId = String(b.offer_id ?? "");
    const expected = Number(b.expected_total);
    if (!/^off_[A-Za-z0-9]+$/.test(offerId) || !Number.isFinite(expected) || expected <= 0) {
      return json({ ok: false, error: "Pick a flight first." }, 400);
    }
    const r = await bookOffer(cfg, deps.store, deps.notifier, duffel, user, {
      offerId, travelers, expectedTotal: expected, origin, destination, departDate: depart, returnDate: ret,
    });
    return json(r, r.ok ? 200 : 409);
  }

  return null;
}


