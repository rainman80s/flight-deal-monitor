/** Owner sign-in and buying from the website: every refusal path, and the happy path. */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { currentUser, loginLink, sessionCookie, verifyLoginLink } from "../src/auth";
import { contactByName } from "../src/config";
import { DuffelProvider, type DuffelOffer, viewOffer } from "../src/duffel";
import { bookOffer, type BookRequest } from "../src/purchase";
import { setup, TRAVELERS } from "./helpers";

const BASE = "https://flights.example.com";
const later = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

function offer(total = "180.00", over: Partial<DuffelOffer> = {}, passengers = 1): DuffelOffer {
  return {
    id: "off_abc123", live_mode: false, total_amount: total, total_currency: "USD", expires_at: "2030-01-01T00:00:00Z",
    owner: { name: "Duffel Airways", iata_code: "ZZ" },
    conditions: { refund_before_departure: { allowed: false }, change_before_departure: { allowed: true } },
    passenger_identity_documents_required: false,
    passengers: Array.from({ length: passengers }, (_, i) => ({ id: `pas_${i}` })),
    slices: [
      { duration: "PT2H30M", segments: [{ origin: { iata_code: "SEA" }, destination: { iata_code: "LAX" },
        departing_at: "2027-01-10T08:00:00", arriving_at: "2027-01-10T10:30:00",
        marketing_carrier: { iata_code: "ZZ" }, marketing_carrier_flight_number: "101" }] },
      { duration: "PT4H", segments: [
        { origin: { iata_code: "LAX" }, destination: { iata_code: "SFO" }, departing_at: "2027-01-14T09:00:00",
          arriving_at: "2027-01-14T10:30:00", marketing_carrier: { iata_code: "ZZ" }, marketing_carrier_flight_number: "202" },
        { origin: { iata_code: "SFO" }, destination: { iata_code: "SEA" }, departing_at: "2027-01-14T11:30:00",
          arriving_at: "2027-01-14T13:00:00", marketing_carrier: { iata_code: "ZZ" }, marketing_carrier_flight_number: "303" }] },
    ],
    ...over,
  };
}

/** A fake Duffel API. `current` is what GET /air/offers/:id returns. */
function fakeDuffel(current: () => DuffelOffer, opts: { orderFails?: boolean } = {}) {
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string).data : null;
    calls.push({ method: init.method ?? "GET", url, body });
    if (url.includes("/air/offer_requests")) return new Response(JSON.stringify({ data: { offers: [offer("250.00"), current()] } }), { status: 201 });
    if (url.includes("/air/offers/")) return new Response(JSON.stringify({ data: current() }));
    if (url.endsWith("/air/orders")) {
      if (opts.orderFails) return new Response(JSON.stringify({ errors: [{ title: "Airline error", message: "timeout" }] }), { status: 502 });
      return new Response(JSON.stringify({ data: { id: "ord_1", booking_reference: "ZZ7Q2X" } }), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, duffel: new DuffelProvider("duffel_test_x", "economy", 1, fetcher) };
}

const req = (over: Partial<BookRequest> = {}): BookRequest => ({
  offerId: "off_abc123", travelers: ["RAN"], expectedTotal: 180, origin: "SEA", destination: "LAX",
  departDate: "2027-01-10", returnDate: "2027-01-14", ...over,
});

const live = () => setup({ dryRun: false, bookingEnabled: true });

describe("bookOffer", () => {
  it("books, records, and emails the confirmation", async () => {
    const { cfg, store, notifier } = live();
    const { calls, duffel } = fakeDuffel(() => offer());
    const r = await bookOffer(cfg, store, notifier, duffel, contactByName(cfg, "RAN")!, req());
    expect(r).toMatchObject({ ok: true, reference: "ZZ7Q2X", total: 180, test_mode: true });
    const order = calls.find((c) => c.url.endsWith("/air/orders"))!;
    expect(order.body).toMatchObject({ type: "instant", selected_offers: ["off_abc123"],
      payments: [{ type: "balance", amount: "180.00", currency: "USD" }],
      passengers: [{ id: "pas_0", given_name: "Ran", family_name: "Test", born_on: "1995-01-31" }] });
    expect(notifier.sent.find((m) => m.kind === "email")!.email!.subject).toMatch(/\[TEST\] Flight booked/);
  });

  it("refuses when purchasing is off or the site is in dry run", async () => {
    const { duffel, calls } = fakeDuffel(() => offer());
    for (const o of [{ dryRun: true, bookingEnabled: true }, { dryRun: false, bookingEnabled: false }]) {
      const { cfg, store, notifier } = setup(o);
      expect((await bookOffer(cfg, store, notifier, duffel, contactByName(cfg, "RAN")!, req())).ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a price jump over 5% and never pays", async () => {
    const { cfg, store, notifier } = live();
    const { calls, duffel } = fakeDuffel(() => offer("190.00"));
    const r = await bookOffer(cfg, store, notifier, duffel, contactByName(cfg, "RAN")!, req());
    expect(r.message).toMatch(/now \$190\.00, up from \$180\.00/);
    expect(calls.some((c) => c.url.endsWith("/air/orders"))).toBe(false);
  });

  it("never books the same offer twice", async () => {
    const { cfg, store, notifier } = live();
    const { calls, duffel } = fakeDuffel(() => offer());
    await bookOffer(cfg, store, notifier, duffel, contactByName(cfg, "RAN")!, req());
    const again = await bookOffer(cfg, store, notifier, duffel, contactByName(cfg, "RAN")!, req());
    expect(again.message).toMatch(/already been booked/);
    expect(calls.filter((c) => c.url.endsWith("/air/orders"))).toHaveLength(1);
  });

  it("a failed purchase is recorded and not retried automatically", async () => {
    const { cfg, store, notifier } = live();
    const { calls, duffel } = fakeDuffel(() => offer(), { orderFails: true });
    expect((await bookOffer(cfg, store, notifier, duffel, contactByName(cfg, "RAN")!, req())).message).toMatch(/FAILED or is uncertain/);
    expect((await bookOffer(cfg, store, notifier, duffel, contactByName(cfg, "RAN")!, req())).message).toMatch(/already been booked/);
    expect(calls.filter((c) => c.url.endsWith("/air/orders"))).toHaveLength(1);
  });

  it("enforces the daily spend cap for real money, not for test bookings", async () => {
    const { cfg, store, notifier } = live();
    cfg.dailySpendCap = 150;
    const test = fakeDuffel(() => offer());
    expect((await bookOffer(cfg, store, notifier, test.duffel, contactByName(cfg, "RAN")!, req())).ok).toBe(true);
    const real = fakeDuffel(() => offer("180.00", { id: "off_live1", live_mode: true }));
    const liveDuffel = new DuffelProvider("duffel_live_x", "economy", 1,
      (real.duffel as unknown as { fetcher: typeof fetch }).fetcher);
    const r = await bookOffer(cfg, store, notifier, liveDuffel, contactByName(cfg, "RAN")!, req({ offerId: "off_live1" }));
    expect(r.message).toMatch(/spending cap of \$150/);
  });

  it("books both travelers on one order when asked", async () => {
    const { cfg, store, notifier } = live();
    const { calls, duffel } = fakeDuffel(() => offer("360.00", {}, 2));
    const r = await bookOffer(cfg, store, notifier, duffel, contactByName(cfg, "BROCK")!,
      req({ travelers: ["RAN", "BROCK"], expectedTotal: 360 }));
    expect(r.ok).toBe(true);
    const order = calls.find((c) => c.url.endsWith("/air/orders"))!;
    expect((order.body!.passengers as { given_name: string }[]).map((p) => p.given_name)).toEqual(["Ran", "Brock"]);
  });

  it("refuses when the traveler count doesn't match the fare", async () => {
    const { cfg, store, notifier } = live();
    const { duffel } = fakeDuffel(() => offer());
    const r = await bookOffer(cfg, store, notifier, duffel, contactByName(cfg, "RAN")!,
      req({ travelers: ["RAN", "BROCK"], expectedTotal: 360 }));
    expect(r.message).toMatch(/different number of travelers/);
  });

  it("asks for passport details when the airline requires them, and sends them when present", async () => {
    const { cfg, store, notifier } = live();
    const { duffel } = fakeDuffel(() => offer("180.00", { passenger_identity_documents_required: true }));
    expect((await bookOffer(cfg, store, notifier, duffel, contactByName(cfg, "RAN")!, req())).message)
      .toMatch(/needs passport details for RAN/);
    cfg.env.TRAVELERS_JSON = JSON.stringify({ ...TRAVELERS, RAN: { ...TRAVELERS.RAN, passport_number: "X1234567",
      passport_expires_on: "2031-05-01", passport_country: "US" } });
    const ok = fakeDuffel(() => offer("180.00", { id: "off_pp1", passenger_identity_documents_required: true }));
    expect((await bookOffer(cfg, store, notifier, ok.duffel, contactByName(cfg, "RAN")!, req({ offerId: "off_pp1" }))).ok).toBe(true);
    const sent = ok.calls.find((c) => c.url.endsWith("/air/orders"))!.body!.passengers as Record<string, unknown>[];
    expect(sent[0].identity_documents).toEqual([{ type: "passport", unique_identifier: "X1234567",
      expires_on: "2031-05-01", issuing_country_code: "US" }]);
  });
});

describe("offer view", () => {
  it("summarizes slices, stops, flights and fare rules", () => {
    expect(viewOffer(offer())).toMatchObject({ total: 180, airline: "Duffel Airways", refundable: false, changeable: true,
      test_mode: true, slices: [{ from: "SEA", to: "LAX", stops: 0, flights: ["ZZ101"] },
        { from: "LAX", to: "SEA", stops: 1, flights: ["ZZ202", "ZZ303"] }] });
  });
});

describe("sign-in", () => {
  it("login links and sessions verify, and reject tampering and expiry", async () => {
    const { cfg } = setup();
    const ran = contactByName(cfg, "RAN")!;
    const u = new URL(await loginLink(cfg, ran));
    const [n, x, t] = ["n", "x", "t"].map((k) => u.searchParams.get(k)!);
    expect(await verifyLoginLink(cfg, n, x, t)).toMatchObject({ name: "RAN" });
    expect(await verifyLoginLink(cfg, "BROCK", x, t)).toBeNull();
    expect(await verifyLoginLink(cfg, n, x, t, Date.now() + 21 * 60000)).toBeNull();

    const cookie = (await sessionCookie(cfg, ran)).split(";")[0];
    expect(cookie).toMatch(/^fr_session=RAN\./);
    const r = (c: string) => new Request(BASE, { headers: { Cookie: c } });
    expect(await currentUser(cfg, r(cookie))).toMatchObject({ name: "RAN" });
    expect(await currentUser(cfg, r(cookie.replace("RAN.", "BROCK.")))).toBeNull();
    expect(await currentUser(cfg, r(""))).toBeNull();
  });
});

describe("booking endpoints", () => {
  function site(over = {}) {
    const ctx = setup({ dryRun: false, bookingEnabled: true, ...over });
    const deps = { ...ctx, fareProvider: () => { throw new Error("unused"); }, background: () => {} };
    const call = async (path: string, b: unknown, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(BASE + path, { method: "POST", body: JSON.stringify(b),
        headers: { "Content-Type": "application/json", Origin: BASE, ...headers } }), deps);
      return { status: res.status, body: await res.json() as Record<string, unknown>, headers: res.headers };
    };
    return { ...ctx, call };
  }
  const trip = { origin: "SEA", destination: "LAX", depart_date: later(40), return_date: later(44), travelers: ["RAN"] };

  it("require sign-in and a same-origin request", async () => {
    const s = site();
    expect((await s.call("/api/offers", trip)).status).toBe(401);
    const cookie = (await sessionCookie(s.cfg, contactByName(s.cfg, "RAN")!)).split(";")[0];
    expect((await s.call("/api/offers", trip, { Cookie: cookie, Origin: "https://evil.example" })).status).toBe(403);
    expect((await s.call("/api/book", { ...trip, offer_id: "off_1", expected_total: 100 },
      { Cookie: cookie, Origin: "https://evil.example" })).status).toBe(403);
  });

  it("explain when Duffel isn't set up", async () => {
    const s = site();
    s.cfg.env.DUFFEL_ACCESS_TOKEN = undefined;
    const cookie = (await sessionCookie(s.cfg, contactByName(s.cfg, "RAN")!)).split(";")[0];
    const r = await s.call("/api/offers", trip, { Cookie: cookie });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/DUFFEL_ACCESS_TOKEN/);
  });

  it("validate dates and travelers", async () => {
    const s = site();
    const cookie = (await sessionCookie(s.cfg, contactByName(s.cfg, "RAN")!)).split(";")[0];
    for (const bad of [{ ...trip, return_date: trip.depart_date }, { ...trip, depart_date: "2020-01-01" },
      { ...trip, travelers: ["MALLORY"] }, { ...trip, travelers: [] }, { ...trip, origin: "JFK", destination: "LAX" }]) {
      expect((await s.call("/api/offers", bad, { Cookie: cookie })).status).toBe(400);
    }
  });

  it("login always gives the same answer", async () => {
    const s = site();
    const sent: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string).to[0]);
      return new Response(JSON.stringify({ id: "e1" }));
    }) as typeof fetch;
    let a, b;
    try {
      a = await s.call("/api/login", { email: "ran@example.com" });
      b = await s.call("/api/login", { email: "stranger@example.com" });
    } finally { globalThis.fetch = real; }
    // Anyone can have an account now, so everyone gets a link, and the reply doesn't
    // reveal which emails belong to owners.
    expect(a.body).toEqual({ ok: true });
    expect(b.body).toEqual({ ok: true });
    expect(sent).toEqual(["ran@example.com", "stranger@example.com"]);
  });

  it("login reply is identical for owners and strangers even without email set up", async () => {
    const s = site();
    s.cfg.env.RESEND_API_KEY = undefined;
    const a = await s.call("/api/login", { email: "ran@example.com" });
    const b = await s.call("/api/login", { email: "stranger@example.com" });
    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });
});
