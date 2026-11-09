/** Logic panel rules, per-city "usual price" learning, and the settings API. */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { sessionCookie } from "../src/auth";
import { pingReason, PriceHistory, summarize } from "../src/baselines";
import { contactByName } from "../src/config";
import type { Fare } from "../src/models";
import { runCycle } from "../src/monitor";
import { rejectionReason } from "../src/rules";
import { applySettings, defaultCategories, describe as describeRules, toRaw, validateCat } from "../src/settings";
import { makeCfg, setup } from "./helpers";

const TODAY = "2026-11-09";
const NOON = new Date("2026-11-09T20:00:00Z");
const fare = (dest: string, price: number, depart: string, ret: string, over: Partial<Fare> = {}): Fare => ({
  provider: "ignav", origin: "SEA", destination: dest, departDate: depart, returnDate: ret, price, currency: "USD",
  airlines: ["AS"], outboundStops: 0, returnStops: 0, offerId: null, bookingUrl: null, isFake: false, ...over,
});

describe("default rules (your spec)", () => {
  const cfg = makeCfg({ cats: defaultCategories() });

  it("international: 20+ days out, more than 4 days long, shown and pinged under $500", () => {
    expect(rejectionReason(cfg, fare("NRT", 499, "2026-11-29", "2026-12-04"), TODAY)).toBeNull();     // 20 days, 5-day trip
    expect(rejectionReason(cfg, fare("NRT", 499, "2026-11-28", "2026-12-04"), TODAY)).toMatch(/needs 20\+/);
    expect(rejectionReason(cfg, fare("NRT", 499, "2026-12-10", "2026-12-14"), TODAY)).toMatch(/4 days.*needs 5\+/);
    expect(rejectionReason(cfg, fare("NRT", 500, "2026-12-10", "2026-12-17"), TODAY)).toMatch(/limit \$500/);
    expect(pingReason(450, cfg.cats.international.alert, null)).toBe("under $500");
  });

  it("domestic: anything 2+ days out under $200 is shown", () => {
    expect(rejectionReason(cfg, fare("LAX", 199, "2026-11-11", "2026-11-14"), TODAY)).toBeNull();
    expect(rejectionReason(cfg, fare("LAX", 199, "2026-11-10", "2026-11-14"), TODAY)).toMatch(/needs 2\+/);
    expect(rejectionReason(cfg, fare("LAX", 200, "2026-11-20", "2026-11-24"), TODAY)).toMatch(/limit \$200/);
  });

  it("domestic pings by city: 30% under that route's usual price", () => {
    const rule = cfg.cats.domestic.alert;
    const la = summarize([90, 120, 150, 170, 180, 200, 230, 250]);           // LA: usually cheap
    const ny = summarize([300, 340, 380, 400, 420, 450, 480, 500]);          // NY: usually pricey
    expect(pingReason(110, rule, la)).toMatch(/below the usual \$175/);      // 37% under LA's usual
    expect(pingReason(140, rule, la)).toBeNull();                            // cheap-ish, but normal for LA
    expect(pingReason(180, rule, ny)).toMatch(/56% below the usual \$410/);  // shown and pinged for NY
    // Still learning a route: fall back to "under $100".
    expect(pingReason(95, rule, null)).toMatch(/under \$100 \(still learning/);
    expect(pingReason(120, rule, null)).toBeNull();
  });

  it("summaries read naturally", () => {
    expect(describeRules("international", cfg.cats.international)).toBe(
      "Trips abroad: show round trips leaving 20 to 180 days from now, 5 to 21 days long, under $500; "
      + "ping when a fare is under $500.");
    expect(describeRules("domestic", cfg.cats.domestic)).toMatch(/ping when a fare is at least 30% below that route's usual price/);
  });
});

describe("validateCat", () => {
  const good = toRaw(defaultCategories().domestic);
  it("accepts good input and explains bad input", () => {
    expect(validateCat(good).ok).toBe(true);
    const bad = validateCat({ ...good, min_days_out: 50, max_days_out: 40, min_trip_days: 9, max_trip_days: 3,
      alert: { ...good.alert, under: 900, mode: "nope" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors).sort()).toEqual(["alert.mode", "alert.under", "max_days_out", "max_trip_days"]);
      expect(bad.errors["alert.under"]).toMatch(/can't be above the show-under price/);
    }
  });
});

describe("price history", () => {
  it("learns per route, pools SEA+PDX when one airport is thin, and needs enough samples", async () => {
    const { cfg } = setup();
    const h = new PriceHistory(cfg.env.DB);
    const days = (prices: number[]) => prices.map((p, i) => ({ d: `2026-12-${String(i + 1).padStart(2, "0")}`, r: null, p }));
    await h.recordCalendar("SEA", "LAX", 7, days([150, 160, 170, 180, 190, 200, 210, 220, 230]), "calendar", NOON);
    await h.recordCalendar("PDX", "JFK", 7, days([380, 400, 420]), "calendar", NOON);
    await h.recordCalendar("SEA", "JFK", 7, days([390, 410, 430, 450, 470]), "calendar", NOON);
    expect(await h.baseline("SEA", "LAX", 8, NOON)).toMatchObject({ median: 190, low: 170, high: 210, samples: 9, pooled: false });
    expect(await h.baseline("SEA", "JFK", 8, NOON)).toMatchObject({ samples: 8, pooled: true, median: 415 });
    expect(await h.baseline("SEA", "MIA", 8, NOON)).toBeNull();
    // Old observations age out of the 60-day window.
    expect(await h.baseline("SEA", "LAX", 8, new Date("2027-02-15T00:00:00Z"))).toBeNull();
  });
});

describe("runs with the new rules", () => {
  it("shows cheap-but-normal fares without pinging, and pings what's cheap for that city", async () => {
    const { cfg, store, notifier } = setup({ dryRun: false, cats: defaultCategories() });
    const h = new PriceHistory(cfg.env.DB);
    const month = (base: number) => Array.from({ length: 20 }, (_, i) => ({ d: `2026-12-${String(i + 1).padStart(2, "0")}`,
      r: null, p: base + (i % 5) * 20 }));
    await h.recordCalendar("SEA", "LAX", 7, month(150), "calendar", NOON);  // LA usually ~$150-230
    await h.recordCalendar("SEA", "JFK", 7, month(380), "calendar", NOON);  // NY usually ~$380-460
    const p = { name: "fixed", search: async () => [
      fare("LAX", 140, "2026-12-03", "2026-12-10"),   // under $200: shown; normal for LA: no ping
      fare("JFK", 190, "2026-12-03", "2026-12-10"),   // under $200 and ~50% below NY's usual: ping
      fare("NRT", 480, "2026-12-03", "2026-12-10"),   // international under $500: ping
      fare("CDG", 520, "2026-12-03", "2026-12-10"),   // over $500: hidden
    ] };
    const r = await runCycle(cfg, store, p, notifier, NOON);
    expect(r.shown).toBe(3);
    expect(r.deals.map((d) => d.destination).sort()).toEqual(["JFK", "NRT"]);
    const jfk = r.deals.find((d) => d.destination === "JFK")!;
    expect(jfk.ping_reason).toMatch(/below the usual/);
    expect(jfk.typical_median).toBeGreaterThan(380);
    const email = notifier.sent.find((m) => m.kind === "email" && m.email!.subject.includes("New York"))!;
    expect(email.email!.html).toMatch(/below the usual/);
  });

  it("the same shown-only fare isn't saved twice in a day", async () => {
    const { cfg, store, notifier } = setup({ dryRun: false, cats: defaultCategories() });
    const h = new PriceHistory(cfg.env.DB);
    await h.recordCalendar("SEA", "LAX", 7, Array.from({ length: 10 }, (_, i) => ({ d: `2026-12-0${i % 9 + 1}`, r: null, p: 140 })), "calendar", NOON);
    const p = { name: "fixed", search: async () => [fare("LAX", 140, "2026-12-03", "2026-12-10")] };
    expect((await runCycle(cfg, store, p, notifier, NOON)).shown).toBe(1);
    const again = await runCycle(cfg, store, p, notifier, NOON);
    expect(again.shown).toBe(0);
    expect(again.suppressed).toBe(1);
  });
});

describe("logic API", () => {
  const BASE = "https://flights.example.com";
  function site() {
    const ctx = setup({ cats: defaultCategories() });
    const deps = { ...ctx, fareProvider: () => { throw new Error("unused"); }, background: () => {} };
    const call = async (method: string, path: string, b?: unknown, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(BASE + path, { method, body: b === undefined ? undefined : JSON.stringify(b),
        headers: { "Content-Type": "application/json", Origin: BASE, ...headers } }), deps);
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };
    return { ...ctx, call };
  }

  it("anyone can read; only a signed-in owner can save, and saved rules apply", async () => {
    const s = site();
    const read = await s.call("GET", "/api/logic");
    expect(read.body).toMatchObject({ can_edit: false, customized: false });
    const cats = read.body.categories as Record<string, ReturnType<typeof toRaw>>;
    const next = { ...cats, international: { ...cats.international, min_days_out: 14, show_under: 600,
      alert: { ...cats.international.alert, under: 450 } } };
    expect((await s.call("PUT", "/api/logic", next)).status).toBe(401);
    const cookie = (await sessionCookie(s.cfg, contactByName(s.cfg, "RAN")!)).split(";")[0];
    expect((await s.call("PUT", "/api/logic", next, { Cookie: cookie, Origin: "https://evil.example" })).status).toBe(403);
    const saved = await s.call("PUT", "/api/logic", next, { Cookie: cookie });
    expect(saved.body.ok).toBe(true);

    const cfg = makeCfg({ cats: defaultCategories() }, s.cfg.env);
    await applySettings(cfg);
    expect(cfg.cats.international).toMatchObject({ minDaysOut: 14, showUnder: 600, alert: { under: 450 } });
    expect(cfg.cats.domestic.showUnder).toBe(200);

    const bad = await s.call("PUT", "/api/logic", { ...next, domestic: { ...cats.domestic, max_trip_days: 0 } }, { Cookie: cookie });
    expect(bad.status).toBe(400);
    expect((bad.body.fields as Record<string, Record<string, string>>).domestic).toHaveProperty("max_trip_days");

    expect((await s.call("POST", "/api/logic/reset", {}, { Cookie: cookie })).body.ok).toBe(true);
    const cfg2 = makeCfg({ cats: defaultCategories() }, s.cfg.env);
    await applySettings(cfg2);
    expect(cfg2.cats.international.minDaysOut).toBe(20);
  });

  it("baselines endpoint lists what's been learned", async () => {
    const s = site();
    await new PriceHistory(s.cfg.env.DB).recordCalendar("SEA", "LAX", 7,
      [{ d: "2026-12-01", r: null, p: 120 }, { d: "2026-12-02", r: null, p: 180 }], "calendar");
    const r = await s.call("GET", "/api/baselines");
    expect((r.body.routes as Record<string, unknown>[])[0]).toMatchObject({ origin: "SEA", destination: "LAX",
      destination_city: "Los Angeles", kind: "domestic", samples: 2, median: 150 });
  });
});
