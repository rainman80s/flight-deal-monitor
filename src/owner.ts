/**
 * Owner-only routes: traveler profiles, and searching/booking real flights from the site.
 * (Sign-in for everyone lives in account.ts.)
 *
 *   GET  /api/profiles, PUT/DELETE /api/profiles/:name   traveler details for booking
 *   POST /api/logout
 *   POST /api/offers      {origin, destination, depart_date, return_date, travelers[]}
 *   POST /api/book        {offer_id, travelers[], expected_total, origin, destination, depart_date, return_date}
 *
 * Everything that changes state requires a same-origin request; /api/offers and
 * /api/book also require a signed-in contact.
 */
import type { Deps } from "./app";
import { clearCookie, currentUser, sameOrigin } from "./auth";
import type { Config } from "./config";
import { loadAllTravelers, ProfileStore, publicProfile, validateProfile } from "./profiles";
import { daysBetween, utcDate } from "./dates";
import { DuffelProvider, viewOffer } from "./duffel";
import { bookOffer } from "./purchase";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json",
    "Cache-Control": "no-store", ...headers } });

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function duffelFor(cfg: Config): DuffelProvider | null {
  const t = cfg.env.DUFFEL_ACCESS_TOKEN;
  return typeof t === "string" && t ? new DuffelProvider(t, cfg.cabinClass, cfg.maxConnections) : null;
}

async function travelerStatus(cfg: Config) {
  const t = await loadAllTravelers(cfg);
  return cfg.contacts.map((c) => ({ name: c.name, ready: !!t[c.name],
    passport: !!(t[c.name]?.passport_number && t[c.name]?.passport_expires_on && t[c.name]?.passport_country) }));
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try { return await req.json() as Record<string, unknown>; } catch { return null; }
}

/** What the site needs to know about a signed-in owner's booking setup (for /api/me). */
export async function ownerBooking(cfg: Config) {
  const duffel = duffelFor(cfg);
  return {
    enabled: cfg.bookingEnabled && !cfg.dryRun,
    duffel: !!duffel, test_mode: duffel?.testMode ?? null,
    travelers: await travelerStatus(cfg),
    spend_cap: cfg.dailySpendCap, max_price_increase_percent: cfg.maxPriceIncreasePercent,
  };
}

export async function ownerRoute(req: Request, url: URL, deps: Deps): Promise<Response | null> {
  const { cfg } = deps;
  const p = url.pathname;

  // ---- traveler profiles (Account page) ----
  if (p === "/api/profiles" && req.method === "GET") {
    const user = await currentUser(cfg, req);
    if (!user) return json({ ok: false, error: "Sign in first." }, 401);
    const store = new ProfileStore(cfg);
    const fromSecret = await loadAllTravelers(cfg);
    const people = await Promise.all(cfg.contacts.map(async (c) => {
      const saved = await store.get(c.name);
      const meta = await store.meta(c.name);
      return {
        name: c.name, is_you: c.name === user.name, can_sign_in: !!c.email,
        source: saved ? "account" : fromSecret[c.name] ? "secret" : null,
        profile: publicProfile(saved), updated_at: meta?.updated_at ?? null, updated_by: meta?.updated_by ?? null,
      };
    }));
    return json({ ok: true, travelers: people });
  }

  const prof = p.match(/^\/api\/profiles\/([A-Z0-9_]+)$/);
  if (prof && (req.method === "PUT" || req.method === "DELETE")) {
    if (!sameOrigin(cfg, req)) return json({ ok: false, error: "Bad origin." }, 403);
    const user = await currentUser(cfg, req);
    if (!user) return json({ ok: false, error: "Sign in first." }, 401);
    const contact = prof[1];
    if (!cfg.contacts.some((c) => c.name === contact)) return json({ ok: false, error: "Unknown traveler." }, 404);
    const store = new ProfileStore(cfg);
    if (req.method === "DELETE") {
      await store.remove(contact);
      return json({ ok: true });
    }
    const b = await body(req);
    if (!b) return json({ ok: false, error: "Bad request." }, 400);
    const v = validateProfile(b, await store.get(contact), utcDate(new Date()));
    if (!v.ok) return json({ ok: false, error: "Check the highlighted fields.", fields: v.errors }, 400);
    await store.save(contact, v.profile, user.name);
    return json({ ok: true, profile: publicProfile(v.profile) });
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


