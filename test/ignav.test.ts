/** Ignav adapter, against payloads shaped like Ignav's documented examples. */
import { describe, expect, it } from "vitest";
import { IgnavProvider } from "../src/ignav";
import { runCycle } from "../src/monitor";
import { setup } from "./helpers";

const seg = (code: string, from: string, to: string) => ({
  marketing_carrier_code: code, flight_number: "100", operating_carrier_name: "X", departure_airport: from,
  departure_time_local: "2027-01-10T06:00:00", departure_timezone: null, departure_time_utc: null,
  arrival_airport: to, arrival_time_local: "2027-01-10T09:00:00", arrival_timezone: null, arrival_time_utc: null,
  duration_minutes: 180, aircraft: null,
});

const RESPONSE = {
  origin: "SEA", destination: "LAX", departure_date: "2027-01-10", return_date: "2027-01-15",
  observed_at: "2026-11-05T20:00:00Z",
  itineraries: [
    { ignav_id: "ig_1", price: { amount: 89, currency: "USD", status: "verified" },
      outbound: { carrier: "Alaska", segments: [seg("AS", "SEA", "LAX")] },
      inbound: { carrier: "Delta", segments: [seg("DL", "LAX", "SLC"), seg("DL", "SLC", "SEA")] } },
    { ignav_id: "ig_2", price: { amount: 0, currency: "USD", status: "unverified" },   // placeholder: skip
      outbound: { segments: [] }, inbound: { segments: [] } },
    { ignav_id: "ig_3", price: { amount: 120, currency: "USD", status: "verified" },
      outbound: { segments: [seg("AS", "SEA", "LAX")] }, inbound: null },               // one-way: skip
  ],
};

function fakeFetch(calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[],
                   respond: (url: string) => Response) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
    return respond(url);
  }) as unknown as typeof fetch;
}

const q = { origin: "SEA", destination: "LAX", departDate: "2027-01-10", returnDate: "2027-01-15" };

describe("ignav", () => {
  it("builds the documented round-trip request and maps itineraries", async () => {
    const calls: Parameters<typeof fakeFetch>[0] = [];
    const p = new IgnavProvider("ig_key", "economy", 1, 300,
      fakeFetch(calls, () => new Response(JSON.stringify(RESPONSE))));
    const fares = await p.search(q);
    expect(calls[0].url).toBe("https://ignav.com/api/fares/round-trip");
    expect(calls[0].headers["X-Api-Key"]).toBe("ig_key");
    expect(calls[0].body).toEqual({ origin: "SEA", destination: "LAX", departure_date: "2027-01-10",
      return_date: "2027-01-15", adults: 1, cabin_class: "economy", max_stops: 1, market: "US", max_price: 300 });
    expect(fares).toHaveLength(1);
    expect(fares[0]).toMatchObject({ provider: "ignav", price: 89, currency: "USD", airlines: ["AS", "DL"],
      outboundStops: 0, returnStops: 1, offerId: "ig_1", isFake: false });
  });

  it("surfaces Ignav error bodies", async () => {
    const p = new IgnavProvider("bad", "economy", 1, null, fakeFetch([], () =>
      new Response(JSON.stringify({ error: { type: "auth", code: "invalid_api_key", message: "Invalid API key" } }),
        { status: 401 })));
    await expect(p.search(q)).rejects.toThrow(/401: invalid_api_key Invalid API key/);
  });

  it("prefers airline-direct booking links", async () => {
    const calls: Parameters<typeof fakeFetch>[0] = [];
    const p = new IgnavProvider("k", "economy", 1, null, fakeFetch(calls, () => new Response(JSON.stringify({
      itinerary: {}, booking_options: [
        { legs: [], links: [{ provider_name: "OTA", provider_type: "third_party", url: "https://ota.example/x" }] },
        { legs: [], links: [{ provider_name: "Alaska", provider_type: "airline", url: "https://alaskaair.com/book" }] },
      ] }))));
    expect(await p.bookingLink("ig_1")).toBe("https://alaskaair.com/book");
    expect(calls[0]).toMatchObject({ url: "https://ignav.com/api/fares/booking-links", body: { ignav_id: "ig_1" } });
  });

  it("alerts use the airline booking link", async () => {
    const { cfg, store, notifier } = setup({ dryRun: false });
    const p = new IgnavProvider("k", "economy", 1, null, fakeFetch([], (url) => url.endsWith("/booking-links")
      ? new Response(JSON.stringify({ booking_options: [{ links: [{ provider_name: "AS", provider_type: "airline",
          url: "https://alaskaair.com/book" }] }] }))
      : new Response(JSON.stringify(url.endsWith("round-trip") ? { ...RESPONSE, itineraries: [RESPONSE.itineraries[0]] }
        : {}))));
    // Only one query so we get exactly one fare.
    cfg.searchesPerCycle = 1;
    const r = await runCycle(cfg, store, { name: "ignav", search: () => p.search({ ...q, departDate: "2026-12-15",
      returnDate: "2026-12-20" }), bookingLink: (id) => p.bookingLink(id) }, notifier, new Date("2026-11-05T20:00:00Z"));
    expect(r.deals).toHaveLength(1);
    expect(r.deals[0].booking_url).toBe("https://alaskaair.com/book");
  });
});

// ---------------- budget + calendar ----------------
import { Budget, BudgetExceeded } from "../src/budget";
import { calendarWindows, planCalendar } from "../src/planner";
import { fakeD1, makeCfg } from "./helpers";

describe("request budget", () => {
  it("enforces daily and all-time caps, and resets daily", async () => {
    const db = fakeD1();
    let now = new Date("2026-11-05T12:00:00Z");
    const b = new Budget(db, "ignav", 3, 5, () => now);
    for (let i = 0; i < 3; i++) await b.take();
    await expect(b.take()).rejects.toThrow(BudgetExceeded);
    expect(await b.usage()).toMatchObject({ today: 3, total: 3 });   // refused take isn't counted
    now = new Date("2026-11-06T12:00:00Z");
    await b.take(); await b.take();
    await expect(b.take()).rejects.toThrow(/all-time limit of 5/);
    expect(await b.usage()).toMatchObject({ today: 2, total: 5 });
  });
});

describe("calendar plan", () => {
  it("covers 30-150 days out in 31-day windows, rotating routes and trip lengths", () => {
    const cfg = makeCfg();
    expect(calendarWindows(cfg)).toEqual([
      { offset: 30, days: 31 }, { offset: 61, days: 31 }, { offset: 92, days: 31 }, { offset: 123, days: 28 }]);
    const runs = Array.from({ length: 6 }, (_, c) => planCalendar(cfg, c, "2026-11-05", 2)).flat();
    expect(runs).toHaveLength(12);
    expect(new Set(runs.map((q) => `${q.origin}-${q.destination}`)).size).toBe(12); // no route twice early on
    expect(runs[0]).toMatchObject({ departDate: "2026-12-05", windowDays: 31, stayDays: 4 });
    const all = Array.from({ length: 1000 }, (_, c) => planCalendar(cfg, c, "2026-11-05", 2)).flat();
    const combos = new Set(all.map((q) => `${q.origin}${q.destination}${q.departDate}${q.stayDays}`));
    expect(combos.size).toBe(108 * 4 * 3); // every route x window x trip length comes up
    expect(all.every((q) => q.maxPrice === (cfg.domestic.includes(q.destination) ? 100 : 300))).toBe(true);
  });
});

describe("calendar search", () => {
  const cal = (dates: unknown[]) => ({ origin: "SEA", destination: "LAX", dates });
  const cq = { origin: "SEA", destination: "LAX", departDate: "2026-12-05", returnDate: "2026-12-09",
               windowDays: 31, stayDays: 4, maxPrice: 100 };

  it("one calendar request, then one exact search for the cheapest date under the limit", async () => {
    const calls: Parameters<typeof fakeFetch>[0] = [];
    const p = new IgnavProvider("k", "economy", 1, null, fakeFetch(calls, (url) => url.endsWith("cheapest-dates")
      ? new Response(JSON.stringify(cal([
          { departure_date: "2026-12-05", return_date: "2026-12-09", price: { amount: 140, currency: "USD", status: "unverified" } },
          { departure_date: "2026-12-12", return_date: "2026-12-16", price: { amount: 79, currency: "USD", status: "unverified" } },
          { departure_date: "2026-12-19", return_date: "2026-12-23", price: { amount: 92, currency: "USD", status: "unverified" } },
          { departure_date: "2026-12-26", return_date: "2026-12-30", price: null }])))
      : new Response(JSON.stringify(RESPONSE))));
    const fares = await p.search(cq);
    expect(calls.map((c) => c.url.split("/api")[1])).toEqual(["/fares/cheapest-dates", "/fares/round-trip"]);
    expect(calls[0].body).toMatchObject({ departure_date_range: { start: "2026-12-05", end: "2027-01-04" },
      stay_days: 4 });
    expect(calls[0].body).not.toHaveProperty("max_price");
    expect(calls[1].body).toMatchObject({ departure_date: "2026-12-12", return_date: "2026-12-16" });
    expect(fares[0]).toMatchObject({ departDate: "2026-12-12", returnDate: "2026-12-16", price: 89 });
  });

  it("spends nothing more when no date is under the limit", async () => {
    const calls: Parameters<typeof fakeFetch>[0] = [];
    const p = new IgnavProvider("k", "economy", 1, null, fakeFetch(calls, () => new Response(JSON.stringify(cal([
      { departure_date: "2026-12-05", price: { amount: 150, currency: "USD", status: "unverified" } }])))));
    expect(await p.search(cq)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("caps exact verifications per run", async () => {
    const calls: Parameters<typeof fakeFetch>[0] = [];
    const p = new IgnavProvider("k", "economy", 1, null, fakeFetch(calls, (url) => url.endsWith("cheapest-dates")
      ? new Response(JSON.stringify(cal([{ departure_date: "2026-12-12", return_date: "2026-12-16",
          price: { amount: 79, currency: "USD", status: "unverified" } }])))
      : new Response(JSON.stringify(RESPONSE))), undefined, 1);
    await p.search(cq);
    await p.search(cq);
    expect(calls.map((c) => c.url.split("/api")[1])).toEqual(
      ["/fares/cheapest-dates", "/fares/round-trip", "/fares/cheapest-dates"]);
  });

  it("a run stops cleanly when the budget is used up, without calling Ignav", async () => {
    const { cfg, store, notifier } = setup({ dryRun: false });
    const calls: Parameters<typeof fakeFetch>[0] = [];
    const budget = new Budget(cfg.env.DB, "ignav", 1, 950);
    const p = new IgnavProvider("k", "economy", 1, null, fakeFetch(calls, () => new Response(JSON.stringify(cal([])))),
      budget, 2);
    cfg.calendarPerRun = 3;
    const r = await runCycle(cfg, store, p, notifier, new Date("2026-11-05T20:00:00Z"));
    expect(calls).toHaveLength(1);
    expect(r.budgetStopped).toMatch(/today's limit of 1/);
    expect(r.errors).toBe(0);
  });
});
