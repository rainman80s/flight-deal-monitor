/** On-site route search and "recently checked": caching and request limits. */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { Budget } from "../src/budget";
import { CheckStore } from "../src/checks";
import { IgnavProvider } from "../src/ignav";
import { runCycle } from "../src/monitor";
import { setup } from "./helpers";

const BASE = "https://flights.example.com";
const nextMonth = (() => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
})();

function harness(opts: { fail?: boolean; daily?: number } = {}) {
  const ctx = setup({ dryRun: false });
  ctx.cfg.siteSearchesPerVisitor = 2;
  ctx.cfg.siteSearchesPerDay = 3;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, body });
    if (opts.fail) return new Response(JSON.stringify({ error: { code: "upstream", message: "down" } }), { status: 503 });
    const start = body.departure_date_range.start as string;
    const days = Array.from({ length: 3 }, (_, i) => {
      const d = new Date(`${start}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      const iso = d.toISOString().slice(0, 10);
      return { departure_date: iso, return_date: iso, price: i === 1 ? null : { amount: 200 + i * 50, currency: "USD", status: "unverified" } };
    });
    return new Response(JSON.stringify({ origin: body.origin, destination: body.destination, dates: days }));
  }) as unknown as typeof fetch;
  const budget = new Budget(ctx.cfg.env.DB, "ignav", opts.daily ?? 45, 950);
  const provider = new IgnavProvider("k", "economy", 1, null, fetcher, budget, 2);
  const deps = { ...ctx, fareProvider: () => provider, background: () => {} };
  const search = async (body: Record<string, unknown>, ip = "1.1.1.1") => {
    const res = await handle(new Request(`${BASE}/api/search`, { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip } }), deps);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { ...ctx, calls, search, budget, deps, provider };
}

const q = { origin: "SEA", destination: "NRT", month: nextMonth, stay_days: 7 };

describe("route search", () => {
  it("prices a month with one request and returns per-date Google Flights links", async () => {
    const h = harness();
    const r = await h.search(q);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, cached: false, destination_city: "Tokyo Narita", limit: 300, stay_days: 7 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("https://ignav.com/api/fares/cheapest-dates");
    expect(h.calls[0].body).toMatchObject({ origin: "SEA", destination: "NRT", stay_days: 7,
      departure_date_range: { start: `${nextMonth}-01` } });
    const days = r.body.days as { d: string; p: number | null; url: string }[];
    expect(days.map((x) => x.p)).toEqual([200, null, 300]);
    expect(days[0].url).toContain("google.com/travel/flights");
  });

  it("repeat searches reuse the saved result for free", async () => {
    const h = harness();
    await h.search(q);
    const again = await h.search(q, "2.2.2.2");
    expect(again.body.cached).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect((await h.budget.usage()).today).toBe(1);
  });

  it("limits searches per visitor and per site", async () => {
    const h = harness();
    expect((await h.search({ ...q, stay_days: 3 })).status).toBe(200);
    expect((await h.search({ ...q, stay_days: 4 })).status).toBe(200);
    const third = await h.search({ ...q, stay_days: 5 });          // visitor limit 2
    expect(third.status).toBe(429);
    expect(third.body.error).toMatch(/today's 2 live searches/);
    expect((await h.search({ ...q, stay_days: 6 }, "9.9.9.9")).status).toBe(200); // site total now 3
    const site = await h.search({ ...q, stay_days: 8 }, "8.8.8.8");
    expect(site.status).toBe(429);
    expect(site.body.error).toMatch(/site has used today's/);
    expect(h.calls).toHaveLength(3);
  });

  it("a failed search doesn't count against the visitor or site", async () => {
    const h = harness({ fail: true });
    for (let i = 0; i < 3; i++) expect((await h.search({ ...q, stay_days: 3 + i })).status).toBe(502);
    expect(h.calls).toHaveLength(3); // visitor limit (2) never tripped: refunds worked
  });

  it("stops before calling Ignav when the global budget is spent", async () => {
    const h = harness({ daily: 0 });
    const r = await h.search(q);
    expect(r.status).toBe(429);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects bad input without spending anything", async () => {
    const h = harness();
    for (const bad of [{ ...q, origin: "JFK" }, { ...q, destination: "XXX" }, { ...q, month: "2020-01" },
      { ...q, month: "nope" }, { ...q, stay_days: 40 }]) {
      expect((await h.search(bad)).status).toBe(400);
    }
    expect(h.calls).toHaveLength(0);
  });
});

describe("recently checked", () => {
  it("background scans are saved and listed with the cheapest fare", async () => {
    const h = harness();
    h.cfg.calendarPerRun = 1;
    await runCycle(h.cfg, h.store, h.provider, h.notifier, new Date("2026-11-05T20:00:00Z"));
    const res = await handle(new Request(`${BASE}/api/checks`), h.deps);
    const checks = (await res.json() as { checks: Record<string, unknown>[] }).checks;
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ origin: "SEA", cheapest: 200, stay_days: 4, window_start: "2026-12-05",
      window_end: "2027-01-04", limit: expect.any(Number) });
    // Site searches aren't listed as background checks.
    await h.search(q);
    expect(await new CheckStore(h.cfg.env.DB).count()).toBe(1);
  });
});
