import { describe, expect, it } from "vitest";
import { addDays } from "../src/dates";
import type { Fare, FareProvider } from "../src/models";
import { inQuietHours, runCycle } from "../src/monitor";
import { allRoutes, planCycle } from "../src/planner";
import { MockProvider } from "../src/providers";
import { cheapestPerRoute, rejectionReason } from "../src/rules";
import { daysBetween } from "../src/dates";
import { makeCfg, setup } from "./helpers";

const TODAY = "2026-11-05";
// Noon / 11pm Pacific on TODAY (PST = UTC-8).
const NOON = new Date("2026-11-05T20:00:00Z");
const NIGHT = new Date("2026-11-06T07:00:00Z");

function fare(dest = "LAX", price = 90, outDays = 40, length = 5, extra: Partial<Fare> = {}): Fare {
  const d = addDays(TODAY, outDays);
  return { provider: "t", origin: "SEA", destination: dest, departDate: d, returnDate: addDays(d, length),
           price, currency: "USD", airlines: ["AS"], outboundStops: 0, returnStops: 0, offerId: null,
           bookingUrl: null, isFake: false, ...extra };
}

describe("rules", () => {
  const cfg = makeCfg();
  it("domestic threshold", () => {
    expect(rejectionReason(cfg, fare("LAX", 99.99), TODAY)).toBeNull();
    expect(rejectionReason(cfg, fare("LAX", 100), TODAY)).toMatch(/domestic/);
  });
  it("international threshold", () => {
    expect(rejectionReason(cfg, fare("NRT", 299), TODAY)).toBeNull();
    expect(rejectionReason(cfg, fare("NRT", 300), TODAY)).toMatch(/international/);
    expect(rejectionReason(cfg, fare("NRT", 150), TODAY)).toBeNull();
    expect(rejectionReason(cfg, fare("LAX", 150), TODAY)).not.toBeNull();
  });
  it("days out", () => {
    expect(rejectionReason(cfg, fare("LAX", 90, 30), TODAY)).toBeNull();
    expect(rejectionReason(cfg, fare("LAX", 90, 29), TODAY)).toMatch(/departs in 29/);
    expect(rejectionReason(cfg, fare("LAX", 90, 241), TODAY)).not.toBeNull();
  });
  it("trip length", () => {
    expect(rejectionReason(cfg, fare("LAX", 90, 40, 14), TODAY)).toBeNull();
    expect(rejectionReason(cfg, fare("LAX", 90, 40, 15), TODAY)).toMatch(/15 days/);
    expect(rejectionReason(cfg, fare("LAX", 90, 40, 1), TODAY)).not.toBeNull();
  });
  it("unknown destination and currency", () => {
    expect(rejectionReason(cfg, fare("XXX", 50), TODAY)).toMatch(/not in destination/);
    expect(rejectionReason(cfg, fare("LAX", 50, 40, 5, { currency: "EUR" }), TODAY)).toMatch(/currency/);
  });
  it("cheapest per route", () => {
    const best = cheapestPerRoute([fare("LAX", 95), fare("LAX", 80), fare("NRT", 250)]);
    expect(best.map((f) => f.price).sort()).toEqual([250, 80]);
  });
});

describe("planner", () => {
  it("stays inside the rules and covers every route", () => {
    const cfg = makeCfg();
    const routes = new Set(allRoutes(cfg).map((r) => r.join("-")));
    const seen = new Set<string>();
    for (let c = 0; c < 60; c++) {
      for (const q of planCycle(cfg, c, TODAY)) {
        const out = daysBetween(TODAY, q.departDate);
        const trip = daysBetween(q.departDate, q.returnDate);
        expect(out).toBeGreaterThanOrEqual(cfg.minDaysOut);
        expect(out).toBeLessThanOrEqual(cfg.maxDaysOut);
        expect(trip).toBeGreaterThanOrEqual(cfg.minTripDays);
        expect(trip).toBeLessThanOrEqual(cfg.maxTripDays);
        seen.add(`${q.origin}-${q.destination}`);
      }
    }
    expect(seen).toEqual(routes);
    expect(routes.size).toBe(108);
  });
});

describe("quiet hours (Pacific)", () => {
  const cfg = makeCfg();
  it("10pm-8am is quiet", () => {
    expect(inQuietHours(cfg, NIGHT)).toBe(true);                               // 11pm
    expect(inQuietHours(cfg, new Date("2026-11-05T11:00:00Z"))).toBe(true);    // 3am
    expect(inQuietHours(cfg, new Date("2026-11-05T16:00:00Z"))).toBe(false);   // 8am
    expect(inQuietHours(cfg, NOON)).toBe(false);
  });
});

class Fixed implements FareProvider {
  name = "fixed";
  constructor(public fares: Fare[]) {}
  async search() { return this.fares; }
}

describe("search cycle", () => {
  it("texts and calls both people, then dedupes, re-alerting only on a 10% drop", async () => {
    const { cfg, store, notifier } = setup();
    const p = new Fixed([fare("LAX", 90)]);
    expect((await runCycle(cfg, store, p, notifier, NOON)).deals).toHaveLength(1);
    expect(notifier.sent.filter((s) => s.kind === "sms")).toHaveLength(2);
    expect(notifier.sent.filter((s) => s.kind === "call")).toHaveLength(2);

    const again = await runCycle(cfg, store, p, notifier, NOON);
    expect(again.deals).toHaveLength(0);
    expect(again.suppressed).toBe(1);

    p.fares = [fare("LAX", 85)]; // ~5.5% cheaper: not enough
    expect((await runCycle(cfg, store, p, notifier, NOON)).deals).toHaveLength(0);
    p.fares = [fare("LAX", 80)]; // 11% cheaper
    expect((await runCycle(cfg, store, p, notifier, NOON)).deals).toHaveLength(1);
  });

  it("texts only during quiet hours; one deal gets calls per cycle", async () => {
    const { cfg, store, notifier } = setup();
    const p = new Fixed([fare("LAX", 90), fare("DEN", 60), fare("NRT", 200)]);
    expect((await runCycle(cfg, store, p, notifier, NIGHT)).deals).toHaveLength(3);
    expect(notifier.sent.some((s) => s.kind === "call")).toBe(false);

    notifier.sent = [];
    p.fares = [fare("SFO", 70), fare("BOS", 50)];
    await runCycle(cfg, store, p, notifier, NOON);
    const calls = notifier.sent.filter((s) => s.kind === "call");
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.body.split(":")[0])).size).toBe(1);
  });

  it("caps texts per cycle; extra deals are logged and alerted later", async () => {
    const { cfg, store, notifier } = setup({ maxTextsPerCycle: 1 });
    const p = new Fixed([fare("LAX", 90), fare("DEN", 60)]);
    expect((await runCycle(cfg, store, p, notifier, NOON)).deals.map((d) => d.destination)).toEqual(["DEN"]);
    expect((await runCycle(cfg, store, p, notifier, NOON)).deals.map((d) => d.destination)).toEqual(["LAX"]);
  });

  it("one failing search doesn't sink the cycle", async () => {
    const { cfg, store, notifier } = setup();
    let n = 0;
    const flaky: FareProvider = { name: "flaky", search: async () => {
      if (n++ === 0) throw new Error("timeout");
      return [fare("LAX", 90)];
    } };
    const r = await runCycle(cfg, store, flaky, notifier, NOON);
    expect(r.errors).toBe(1);
    expect(r.deals).toHaveLength(1);
  });

  it("mock fares are flagged FAKE", async () => {
    const { cfg, store, notifier } = setup();
    const r = await runCycle(cfg, store, new MockProvider(cfg, 1), notifier, NOON);
    expect(r.deals.length).toBeGreaterThan(0);
    expect(r.deals.every((d) => d.is_fake === 1)).toBe(true);
    expect(notifier.sent.filter((s) => s.kind === "sms").every((s) => s.body.includes("FAKE TEST FARE"))).toBe(true);
  });
});
