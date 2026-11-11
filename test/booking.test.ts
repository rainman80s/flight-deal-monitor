/** The money paths: every way a BUY can go, through calls and texts. */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { executeBuy } from "../src/booking";
import { DuffelProvider } from "../src/duffel";
import type { BookingProvider, Deal } from "../src/models";
import type { Store } from "../src/store";
import { twilioSignature } from "../src/twilio";
import { setup } from "./helpers";

const BASE = "https://flights.example.com";

class FakeBooker implements BookingProvider {
  orders: { offerId: string; amount: number; passengers: Record<string, string>[] }[] = [];
  constructor(public price = 90, public available = true, public failOnBook = false) {}
  async reprice(_o: string, _d: string, _a: string, _b: string, passengers: number) {
    if (!this.available) return null;
    return { offerId: "off_1", total: this.price * passengers, currency: "USD",
             passengerIds: Array.from({ length: passengers }, (_, i) => `pas_${i}`) };
  }
  async book(offerId: string, amount: number, _c: string, passengers: Record<string, string>[]) {
    if (this.failOnBook) throw new Error("airline timeout");
    this.orders.push({ offerId, amount, passengers });
    return { orderId: "ord_1", reference: "ABC123" };
  }
}

function addDeal(store: Store, { price = 90, fake = false, dest = "LAX" } = {}): Promise<Deal> {
  return store.addDeal({ provider: "duffel", origin: "SEA", destination: dest, departDate: "2026-12-15",
    returnDate: "2026-12-20", price, currency: "USD", airlines: ["AS"], outboundStops: 0, returnStops: 0,
    offerId: "off_0", bookingUrl: "https://example/link", isFake: fake });
}

const live = () => setup({ dryRun: false, bookingEnabled: true });

describe("booking rails", () => {
  it("never books fake fares", async () => {
    const { cfg, store, notifier } = live();
    const b = new FakeBooker();
    expect(await executeBuy(cfg, store, notifier, await addDeal(store, { fake: true }), "RAN", b)).toMatch(/FAKE/);
    expect(b.orders).toHaveLength(0);
  });

  it("never books in dry run", async () => {
    const { cfg, store, notifier } = setup({ dryRun: true, bookingEnabled: true });
    const b = new FakeBooker();
    expect(await executeBuy(cfg, store, notifier, await addDeal(store), "RAN", b)).toMatch(/DRY RUN/);
    expect(b.orders).toHaveLength(0);
  });

  it("sends a link when booking is off", async () => {
    const { cfg, store, notifier } = setup({ dryRun: false, bookingEnabled: false });
    const b = new FakeBooker();
    expect(await executeBuy(cfg, store, notifier, await addDeal(store), "RAN", b)).toContain("https://example/link");
    expect(b.orders).toHaveLength(0);
  });

  it("books only the responder by default", async () => {
    const { cfg, store, notifier } = live();
    const b = new FakeBooker(92);
    const msg = await executeBuy(cfg, store, notifier, await addDeal(store), "RAN", b);
    expect(msg).toMatch(/BOOKED.*ABC123/);
    expect(b.orders).toHaveLength(1);
    expect(b.orders[0].amount).toBe(92);
    expect(b.orders[0].passengers).toEqual([expect.objectContaining({ id: "pas_0", given_name: "Ran" })]);
  });

  it("'both' mode puts both people on one order", async () => {
    const { cfg, store, notifier } = live();
    cfg.bookingMode = "both";
    const b = new FakeBooker(90);
    await executeBuy(cfg, store, notifier, await addDeal(store), "BROCK", b);
    expect(b.orders[0].amount).toBe(180);
    expect(b.orders[0].passengers.map((p) => p.given_name)).toEqual(["Ran", "Brock"]);
  });

  it("never double-books", async () => {
    const { cfg, store, notifier } = live();
    const b = new FakeBooker();
    const d = await addDeal(store);
    await executeBuy(cfg, store, notifier, d, "RAN", b);
    expect(await executeBuy(cfg, store, notifier, d, "RAN", b)).toMatch(/already booked/);
    expect(b.orders).toHaveLength(1);
  });

  it("refuses a price jump over 5%, then allows a retry within it", async () => {
    const { cfg, store, notifier } = live();
    const b = new FakeBooker(95);
    const d = await addDeal(store);
    expect(await executeBuy(cfg, store, notifier, d, "RAN", b)).toMatch(/Did NOT book.*over/);
    b.price = 94;
    expect(await executeBuy(cfg, store, notifier, d, "RAN", b)).toMatch(/BOOKED/);
  });

  it("refuses when the fare is gone", async () => {
    const { cfg, store, notifier } = live();
    expect(await executeBuy(cfg, store, notifier, await addDeal(store), "RAN", new FakeBooker(90, false)))
      .toMatch(/no longer available/);
  });

  it("enforces the daily spend cap", async () => {
    const { cfg, store, notifier } = live();
    cfg.dailySpendCap = 150;
    const b = new FakeBooker(90);
    expect(await executeBuy(cfg, store, notifier, await addDeal(store), "RAN", b)).toMatch(/BOOKED/);
    expect(await executeBuy(cfg, store, notifier, await addDeal(store, { dest: "SFO" }), "RAN", b))
      .toMatch(/daily spend cap/);
    expect(b.orders).toHaveLength(1);
  });

  it("does not auto-retry a booking that failed mid-purchase", async () => {
    const { cfg, store, notifier } = live();
    const b = new FakeBooker(90, true, true);
    const d = await addDeal(store);
    expect(await executeBuy(cfg, store, notifier, d, "RAN", b)).toMatch(/FAILED/);
    b.failOnBook = false;
    expect(await executeBuy(cfg, store, notifier, d, "RAN", b)).toMatch(/already booked/);
    expect(b.orders).toHaveLength(0);
  });

  it("refuses without passenger details", async () => {
    const { cfg, store, notifier } = live();
    cfg.env.TRAVELERS_JSON = undefined;
    expect(await executeBuy(cfg, store, notifier, await addDeal(store), "RAN", new FakeBooker()))
      .toMatch(/Did NOT book/);
  });
});

// ---------------- webhooks ----------------

function app(overrides = {}) {
  const ctx = { ...live(), ...overrides } as ReturnType<typeof live>;
  const booker = new FakeBooker();
  const pending: Promise<unknown>[] = [];
  const deps = { ...ctx, bookingProvider: booker, fareProvider: () => { throw new Error("unused"); },
                 background: (p: Promise<unknown>) => { pending.push(p); } };
  const post = async (path: string, form: Record<string, string> = {}, sign = true) => {
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (sign) headers["X-Twilio-Signature"] = await twilioSignature("test_auth_token", BASE + path, form);
    const res = await handle(new Request(BASE + path, { method: "POST", headers,
      body: new URLSearchParams(form) }), deps);
    await Promise.all(pending.splice(0));
    return { status: res.status, body: await res.text() };
  };
  return { ...ctx, booker, post, deps };
}

describe("twilio signatures", () => {
  it("matches the official Twilio SDK", async () => {
    // Reference values computed with twilio-python's RequestValidator.
    expect(await twilioSignature("test_auth_token", `${BASE}/voice/answer/K7Q2?who=RAN`,
      { Digits: "1", CallSid: "CA123", From: "+12065550111" })).toBe("xTWhuGAGpduE7WVNEvtUKQRew+4=");
    expect(await twilioSignature("test_auth_token", `${BASE}/sms`, {})).toBe("EfIG+Eu3lPvM9upGqtIwwAYCI8Y=");
  });

  it("rejects unsigned or tampered requests in live mode", async () => {
    const a = app();
    const d = await addDeal(a.store);
    expect((await a.post(`/voice/deal/${d.code}?who=RAN`, {}, false)).status).toBe(403);
    expect((await a.post("/sms", { From: "+12065550111", Body: `BUY ${d.code}` }, false)).status).toBe(403);
  });
});

describe("call flow", () => {
  it("press 1 then 9 books", async () => {
    const a = app();
    const { code } = await addDeal(a.store);
    const script = await a.post(`/voice/deal/${code}?who=RAN`);
    expect(script.body).toContain("<Gather");
    expect(script.body).toContain("Seattle to Los Angeles");
    const ask = await a.post(`/voice/answer/${code}?who=RAN`, { Digits: "1" });
    expect(ask.body).toContain("press 9");
    expect(a.booker.orders).toHaveLength(0);
    const done = await a.post(`/voice/confirm/${code}?who=RAN`, { Digits: "9" });
    expect(done.body).toContain("Confirmed");
    expect(a.booker.orders).toHaveLength(1);
  });

  it("any other key at confirm cancels", async () => {
    const a = app();
    const { code } = await addDeal(a.store);
    await a.post(`/voice/answer/${code}?who=RAN`, { Digits: "1" });
    expect((await a.post(`/voice/confirm/${code}?who=RAN`, { Digits: "5" })).body).toContain("Cancelled");
    expect(a.booker.orders).toHaveLength(0);
  });

  it("press 2 skips, 3 repeats", async () => {
    const a = app();
    const { code } = await addDeal(a.store);
    expect((await a.post(`/voice/answer/${code}?who=RAN`, { Digits: "2" })).body).toContain("Skipped");
    expect((await a.post(`/voice/answer/${code}?who=RAN`, { Digits: "3" })).body).toContain("<Redirect");
    expect(a.booker.orders).toHaveLength(0);
  });

  it("rejects unknown contacts and deals", async () => {
    const a = app();
    const { code } = await addDeal(a.store);
    expect((await a.post(`/voice/deal/${code}?who=MALLORY`)).status).toBe(400);
    expect((await a.post(`/voice/deal/ZZZZ?who=RAN`)).status).toBe(404);
  });
});

describe("text flow", () => {
  it("BUY then YES books for the texter", async () => {
    const a = app();
    const { code } = await addDeal(a.store);
    const ask = await a.post("/sms", { From: "+12065550122", Body: `buy ${code}` });
    expect(ask.body).toContain("Reply YES");
    expect(a.booker.orders).toHaveLength(0);
    await a.post("/sms", { From: "+12065550122", Body: `YES ${code}` });
    expect(a.booker.orders).toHaveLength(1);
    expect(a.booker.orders[0].passengers[0].given_name).toBe("Brock");
  });

  it("YES without BUY does nothing", async () => {
    const a = app();
    const { code } = await addDeal(a.store);
    expect((await a.post("/sms", { From: "+12065550122", Body: `YES ${code}` })).body).toContain("BUY");
    expect(a.booker.orders).toHaveLength(0);
  });

  it("strangers are ignored", async () => {
    const a = app();
    const { code } = await addDeal(a.store);
    await a.post("/sms", { From: "+15555550000", Body: `BUY ${code}` });
    const r = await a.post("/sms", { From: "+15555550000", Body: `YES ${code}` });
    expect(r.body).not.toContain("<Message>");
    expect(a.booker.orders).toHaveLength(0);
  });
});

describe("admin", () => {
  it("requires the admin token", async () => {
    const a = app();
    const req = (auth?: string) => handle(new Request(`${BASE}/admin/status`,
      { headers: auth ? { Authorization: auth } : {} }), a.deps);
    expect((await req()).status).toBe(401);
    expect((await req("Bearer wrong")).status).toBe(401);
    expect((await req("Bearer admin_secret_token_for_tests")).status).toBe(200);
  });
});

describe("duffel request shapes", () => {
  it("search and order payloads", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const data = url.includes("offer_requests")
        ? { offers: [{ id: "off_9", total_amount: "287.40", total_currency: "USD", passengers: [{ id: "pas_9" }],
            slices: [{ segments: [{ marketing_carrier: { iata_code: "AS" } }] },
                     { segments: [{ marketing_carrier: { iata_code: "DL" } }, { marketing_carrier: { iata_code: "AS" } }] }] }] }
        : { id: "ord_9", booking_reference: "XYZ789" };
      return new Response(JSON.stringify({ data }), { status: 201 });
    }) as unknown as typeof fetch;
    const p = new DuffelProvider("duffel_test_x", "economy", 1, fetcher);

    const [f] = await p.search({ origin: "SEA", destination: "NRT", departDate: "2027-01-10", returnDate: "2027-01-17" });
    expect(f).toMatchObject({ price: 287.4, airlines: ["AS", "DL"], outboundStops: 0, returnStops: 1, offerId: "off_9" });
    const req = JSON.parse(calls[0].init.body as string);
    expect(calls[0].url).toBe("https://api.duffel.com/air/offer_requests?return_offers=true");
    expect((calls[0].init.headers as Record<string, string>)["Duffel-Version"]).toBe("v2");
    expect(req.data.slices).toEqual([
      { origin: "SEA", destination: "NRT", departure_date: "2027-01-10" },
      { origin: "NRT", destination: "SEA", departure_date: "2027-01-17" }]);

    expect(await p.book("off_9", 287.4, "USD", [{ id: "pas_9" }])).toEqual({ orderId: "ord_9", reference: "XYZ789" });
    const order = JSON.parse(calls[1].init.body as string).data;
    expect(order).toMatchObject({ type: "instant", selected_offers: ["off_9"],
      payments: [{ type: "balance", amount: "287.40", currency: "USD" }] });
  });

  it("surfaces Duffel errors", async () => {
    const fetcher = (async () => new Response(JSON.stringify({ errors: [{ title: "Offer expired", message: "gone" }] }),
      { status: 422 })) as unknown as typeof fetch;
    await expect(new DuffelProvider("x", "economy", 1, fetcher).book("o", 1, "USD", []))
      .rejects.toThrow(/422.*Offer expired/);
  });
});
