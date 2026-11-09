/** Google Explore (SerpApi): parsing, alternating with Ignav, confirming hits, budgets. */
import { describe, expect, it } from "vitest";
import { Budget } from "../src/budget";
import { IgnavProvider } from "../src/ignav";
import { runCycle } from "../src/monitor";
import { ExploreClient, type ExploreDestination, exploreFares, serpApiKey } from "../src/serpapi";
import { setup } from "./helpers";

const NOON = new Date("2026-11-09T20:00:00Z"); // today in Pacific: 2026-11-09

// Shaped like SerpApi's documented example.
const dest = (code: string, price: number, over: Partial<ExploreDestination> = {}): ExploreDestination => ({
  name: code === "LAX" ? "Los Angeles" : code === "OAK" ? "Oakland" : "Tokyo", country: code === "NRT" ? "Japan" : "United States",
  destination_airport: { code }, start_date: "2026-12-12", end_date: "2026-12-19", flight_price: price,
  flight_duration: 165, number_of_stops: 0, airline: "Frontier", airline_code: "F9",
  link: "https://www.google.com/travel/explore?tfs=abc", ...over,
});

function fakeSerp(dests: ExploreDestination[], calls: string[] = []) {
  return (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ destinations: dests }));
  }) as unknown as typeof fetch;
}

/** Ignav that answers exact searches with a given price per destination. */
function fakeIgnav(prices: Record<string, number | null>, calls: string[] = []) {
  return (async (url: string, init: RequestInit) => {
    const b = JSON.parse(init.body as string);
    calls.push(`${url.split("/api")[1]} ${b.destination}`);
    const p = prices[b.destination];
    const seg = { marketing_carrier_code: "F9" };
    return new Response(JSON.stringify({ itineraries: p === null || p === undefined ? [] : [{ ignav_id: `ig_${b.destination}`,
      price: { amount: p, currency: "USD", status: "verified" }, outbound: { segments: [seg] }, inbound: { segments: [seg] } }] }));
  }) as unknown as typeof fetch;
}

describe("exploreFares", () => {
  it("parses destinations, labels domestic by country, keeps Google's names and links", () => {
    const f = exploreFares("SEA", [dest("LAX", 66), dest("NRT", 280), dest("OAK", 59),
      { name: "Nowhere" }, dest("SEA", 10), dest("BOS", 0)]);
    expect(f.map((x) => x.destination)).toEqual(["LAX", "NRT", "OAK"]);
    expect(f[0]).toMatchObject({ origin: "SEA", price: 66, departDate: "2026-12-12", returnDate: "2026-12-19",
      kind: "domestic", destName: "Los Angeles", airlines: ["F9"], provider: "google-explore",
      bookingUrl: "https://www.google.com/travel/explore?tfs=abc" });
    expect(f[1].kind).toBe("international");
  });

  it("sends the documented request", async () => {
    const calls: string[] = [];
    await new ExploreClient("sk", undefined, fakeSerp([], calls)).explore("SEA", { travelDuration: 2, stops: 2 });
    const q = new URL(calls[0]).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ engine: "google_travel_explore", departure_id: "SEA", type: "1",
      travel_duration: "2", month: "0", stops: "2", currency: "USD", travel_mode: "1", api_key: "sk" });
  });

  it("reads the key under any of its names", () => {
    expect(serpApiKey({ "serpapi-key": "a" })).toBe("a");
    expect(serpApiKey({ SERPAPI_KEY: "b" })).toBe("b");
    expect(serpApiKey({})).toBeNull();
  });
});

describe("explore runs", () => {
  function harness(dests: ExploreDestination[], ignavPrices: Record<string, number | null>, ignavDaily = 45) {
    const ctx = setup({ dryRun: false });
    ctx.cfg.calendarPerRun = 1;
    const serpCalls: string[] = [], ignavCalls: string[] = [];
    const ignav = new IgnavProvider("k", "economy", 1, null, fakeIgnav(ignavPrices, ignavCalls),
      new Budget(ctx.cfg.env.DB, "ignav", ignavDaily, 950), 2);
    const explore = { client: new ExploreClient("sk", new Budget(ctx.cfg.env.DB, "serpapi_2026-11", 9, 245),
      fakeSerp(dests, serpCalls)), every: 3 };
    return { ...ctx, ignav, explore, serpCalls, ignavCalls };
  }

  it("alternates: every 3rd run is Explore, alternating SEA and PDX", async () => {
    const h = harness([], {});
    const modes = [];
    for (let i = 0; i < 7; i++) modes.push((await runCycle(h.cfg, h.store, h.ignav, h.notifier, NOON, undefined, h.explore)).mode);
    expect(modes).toEqual(["explore", "scan", "scan", "explore", "scan", "scan", "explore"]);
    expect(h.serpCalls.map((u) => new URL(u).searchParams.get("departure_id"))).toEqual(["SEA", "PDX", "SEA"]);
  });

  it("confirms hits with Ignav and alerts on confirmed ones, including places outside the lists", async () => {
    const h = harness([dest("LAX", 66), dest("OAK", 59), dest("NRT", 280), dest("DEN", 140)],
      { LAX: 66, OAK: 120, NRT: 279 });
    const r = await runCycle(h.cfg, h.store, h.ignav, h.notifier, NOON, undefined, h.explore);
    expect(r.mode).toBe("explore");
    // DEN ($140) isn't under $100, so it's never confirmed; OAK rose to $120 on confirmation.
    expect(h.ignavCalls.filter((c) => c.startsWith("/fares/round-trip")).map((c) => c.split(" ")[1]).sort()).toEqual(["LAX", "NRT", "OAK"]);
    expect(r.deals.map((d) => [d.destination, d.price, d.kind]).sort()).toEqual([["LAX", 66, "domestic"], ["NRT", 279, "international"]]);
    expect(r.notes!.join("\n")).toMatch(/OAK.*confirmed at \$120/); // then dropped: over the $100 limit
    const email = h.notifier.sent.find((m) => m.kind === "email" && m.email!.subject.includes("Los Angeles"));
    expect(email).toBeTruthy();
  });

  it("uses Google's price when Ignav can't confirm (request limit)", async () => {
    const h = harness([dest("OAK", 59)], { OAK: 59 }, 0);
    const r = await runCycle(h.cfg, h.store, h.ignav, h.notifier, NOON, undefined, h.explore);
    expect(r.deals).toHaveLength(1);
    expect(r.deals[0]).toMatchObject({ destination: "OAK", price: 59, provider: "google-explore", dest_name: "Oakland",
      kind: "domestic", booking_url: "https://www.google.com/travel/explore?tfs=abc" });
    expect(r.notes!.join("\n")).toMatch(/couldn't confirm \(request limit\)/);
  });

  it("respects the rules: too soon or too long trips never alert", async () => {
    const h = harness([dest("LAX", 66, { start_date: "2026-11-20", end_date: "2026-11-27" }),
      dest("SFO", 70, { start_date: "2026-12-12", end_date: "2027-01-02" })], { LAX: 66, SFO: 70 });
    const r = await runCycle(h.cfg, h.store, h.ignav, h.notifier, NOON, undefined, h.explore);
    expect(r.deals).toHaveLength(0);
    expect(h.ignavCalls).toHaveLength(0);
  });

  it("stops at the SerpApi daily limit without calling it", async () => {
    const h = harness([dest("LAX", 66)], { LAX: 66 });
    h.explore.client = new ExploreClient("sk", new Budget(h.cfg.env.DB, "serpapi_x", 0, 245), fakeSerp([], h.serpCalls));
    const r = await runCycle(h.cfg, h.store, h.ignav, h.notifier, NOON, undefined, h.explore);
    expect(h.serpCalls).toHaveLength(0);
    expect(r.budgetStopped).toMatch(/today's limit/);
  });
});
