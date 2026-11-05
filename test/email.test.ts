/** Email alerts and the signed Buy/Skip buttons. */
import { describe, expect, it } from "vitest";
import raw from "../config.json";
import { handle } from "../src/app";
import { buildConfig, type RawConfig } from "../src/config";
import { actionUrl } from "../src/links";
import type { BookingProvider, Fare } from "../src/models";
import { runCycle } from "../src/monitor";
import { ResendEmailer } from "../src/notify";
import { setup, testEnv } from "./helpers";

const NOON = new Date("2026-11-05T20:00:00Z");

const fare = (dest = "LAX", price = 90): Fare => ({
  provider: "t", origin: "SEA", destination: dest, departDate: "2026-12-15", returnDate: "2026-12-20",
  price, currency: "USD", airlines: ["AS"], outboundStops: 0, returnStops: 1, offerId: null,
  bookingUrl: "https://www.google.com/travel/flights?q=x", isFake: false,
});

class Booker implements BookingProvider {
  orders = 0;
  async reprice(_o: string, _d: string, _a: string, _b: string, n: number) {
    return { offerId: "off", total: 90 * n, currency: "USD", passengerIds: Array.from({ length: n }, (_, i) => `p${i}`) };
  }
  async book() { this.orders++; return { orderId: "ord", reference: "REF123" }; }
}

function harness(overrides = {}) {
  const ctx = setup(overrides);
  const booker = new Booker();
  const deps = { ...ctx, bookingProvider: booker, fareProvider: () => { throw new Error("unused"); },
                 background: () => {} };
  const go = async (url: string, init?: RequestInit) => {
    const res = await handle(new Request(url, init), deps);
    return { status: res.status, body: await res.text() };
  };
  const post = (url: string) => {
    const u = new URL(url);
    return go(`${u.origin}${u.pathname}`, { method: "POST", body: u.searchParams,
      headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  };
  return { ...ctx, booker, go, post };
}

describe("email alerts", () => {
  it("emails only contacts with an address, with working signed links", async () => {
    const h = harness({ dryRun: false });
    const r = await runCycle(h.cfg, h.store, { name: "f", search: async () => [fare()] }, h.notifier, NOON);
    expect(r.deals).toHaveLength(1);
    const emails = h.notifier.sent.filter((s) => s.kind === "email");
    expect(emails.map((e) => e.to)).toEqual(["ran@example.com"]); // Brock has no email set
    expect(h.notifier.sent.some((s) => s.kind !== "email")).toBe(false); // no texts/calls by default
    const { subject, html, text } = emails[0].email!;
    expect(subject).toContain("Seattle → Los Angeles $90");
    expect(html).toContain(">Buy</a>");
    const buy = text.match(/Buy: (\S+)/)![1];
    expect(buy).toBe(await actionUrl(h.cfg, r.deals[0].code, "RAN", "buy"));
    expect((await h.go(buy)).status).toBe(200);
  });

  it("fake fares are labelled in email", async () => {
    const h = harness({ dryRun: false });
    await runCycle(h.cfg, h.store, { name: "f", search: async () => [{ ...fare(), isFake: true }] }, h.notifier, NOON);
    expect(h.notifier.sent[0].email!.subject).toMatch(/^\[FAKE TEST FARE\]/);
  });
});

describe("email buttons", () => {
  it("GET never acts; POST buys after confirmation", async () => {
    const h = harness({ dryRun: false, bookingEnabled: true });
    const d = await h.store.addDeal(fare());
    const url = await actionUrl(h.cfg, d.code, "RAN", "buy");
    const view = await h.go(url);
    expect(view.body).toContain("Confirm purchase");
    expect(view.body).toContain("nonrefundable");
    expect(h.booker.orders).toBe(0);
    const done = await h.post(url);
    expect(done.body).toContain("BOOKED");
    expect(h.booker.orders).toBe(1);
    expect((await h.post(url)).body).toContain("already booked"); // double-click safe
    expect(h.booker.orders).toBe(1);
  });

  it("with booking off, Buy returns the booking link", async () => {
    const h = harness({ dryRun: false, bookingEnabled: false });
    const d = await h.store.addDeal(fare());
    const done = await h.post(await actionUrl(h.cfg, d.code, "RAN", "buy"));
    expect(done.body).toContain('<a href="https://www.google.com/travel/flights');
    expect(h.booker.orders).toBe(0);
  });

  it("skip records the answer", async () => {
    const h = harness({ dryRun: false });
    const d = await h.store.addDeal(fare());
    const url = await actionUrl(h.cfg, d.code, "RAN", "skip");
    expect((await h.go(url)).body).toContain("Skip this deal");
    expect(await h.store.latestResponse(d.id, "RAN")).toBeNull();
    expect((await h.post(url)).body).toContain("Skipped");
    expect(await h.store.latestResponse(d.id, "RAN")).toBe("skip");
  });

  it("rejects forged or altered links", async () => {
    const h = harness({ dryRun: false, bookingEnabled: true });
    const d = await h.store.addDeal(fare());
    const skip = await actionUrl(h.cfg, d.code, "RAN", "skip");
    const asBuy = skip.replace("a=skip", "a=buy");                 // reuse a skip token for buy
    const asBrock = (await actionUrl(h.cfg, d.code, "RAN", "buy")).replace("who=RAN", "who=BROCK");
    const noToken = (await actionUrl(h.cfg, d.code, "RAN", "buy")).replace(/&t=.*/, "");
    for (const u of [asBuy, asBrock, noToken]) {
      expect((await h.go(u)).status).toBe(403);
      expect((await h.post(u)).status).toBe(403);
    }
    expect(h.booker.orders).toBe(0);
  });
});

describe("config", () => {
  it("live mode needs at least one reachable contact", () => {
    const env = testEnv();
    delete env.CONTACT_RAN_EMAIL;
    expect(() => buildConfig(env, { ...structuredClone(raw), mode: { dry_run: false, booking_enabled: false } } as RawConfig))
      .toThrow(/no contact can be reached/);
  });
});

describe("resend", () => {
  it("sends the expected payload", async () => {
    let call: { url: string; init: RequestInit } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      call = { url, init };
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    await new ResendEmailer("re_key", "Flight Deals <onboarding@resend.dev>", fetcher)
      .send("ran@example.com", { subject: "S", text: "T", html: "<p>H</p>" });
    expect(call!.url).toBe("https://api.resend.com/emails");
    expect((call!.init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    expect(JSON.parse(call!.init.body as string)).toEqual({
      from: "Flight Deals <onboarding@resend.dev>", to: ["ran@example.com"], subject: "S", text: "T", html: "<p>H</p>",
    });
  });

  it("surfaces errors", async () => {
    const fetcher = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    await expect(new ResendEmailer("x", "y", fetcher).send("a@b.c", { subject: "", text: "", html: "" }))
      .rejects.toThrow(/401/);
  });
});
