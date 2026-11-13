/**
 * Features added after comparing with other fare-alert sites: free trial and its reminder,
 * honest homepage stats, shareable deal links, alert preferences (destinations, nonstop),
 * and search/sharing metadata (robots, sitemap, manifest, link previews).
 */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import type { Fare } from "../src/models";
import { runCycle } from "../src/monitor";
import { UserStore } from "../src/users";
import { sessionFor, setup } from "./helpers";

const BASE = "https://flights.example.com";
const NOON = new Date("2026-11-05T20:00:00Z");
const fare = (dest = "LAX", price = 90, extra: Partial<Fare> = {}): Fare => ({
  provider: "t", origin: "SEA", destination: dest, departDate: "2026-12-15", returnDate: "2026-12-20",
  price, currency: "USD", airlines: ["AS"], outboundStops: 0, returnStops: 0, offerId: null,
  bookingUrl: "https://www.google.com/travel/flights?q=x", isFake: false, ...extra,
});

function site(env: Record<string, unknown> = {}) {
  const ctx = setup({ dryRun: false });
  Object.assign(ctx.cfg.env, env);
  const deps = { ...ctx, fareProvider: () => { throw new Error("unused"); }, background: () => {} };
  const mail: { to: string; subject: string; text: string }[] = [];
  const stripe: { url: string; body: string }[] = [];
  const raw = async (path: string, init: RequestInit = {}) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, i: RequestInit = {}) => {
      if (String(url).startsWith("https://api.resend.com")) {
        const b = JSON.parse(i.body as string);
        mail.push({ to: b.to[0], subject: b.subject, text: b.text });
        return new Response(JSON.stringify({ id: "m" }));
      }
      if (String(url).startsWith("https://api.stripe.com")) {
        stripe.push({ url: String(url), body: String(i.body ?? "") });
        return new Response(JSON.stringify(String(url).endsWith("/customers") ? { id: "cus_1" } : { url: "https://checkout.stripe.com/c/pay/x" }));
      }
      return real(url, i);
    }) as typeof fetch;
    try { return await handle(new Request(BASE + path, init), deps as never); } finally { globalThis.fetch = real; }
  };
  const call = async (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const res = await raw(path, { method, body: data === undefined ? undefined : JSON.stringify(data),
      headers: { "Content-Type": "application/json", Origin: BASE, ...headers } });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { ...ctx, raw, call, mail, stripe, users: UserStore.for(ctx.cfg) };
}

async function signed(payload: string, secret: string) {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("free trial", () => {
  const env = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_t", STRIPE_PRICE_ID: "price_8", PRO_LAUNCHED: "true" };

  it("first-time members get 7 days free, with the charge spelled out at checkout", async () => {
    const s = site(env);
    const { cookie } = await sessionFor(s.cfg);
    expect((await s.call("GET", "/api/me", undefined, { Cookie: cookie })).body).toMatchObject({ subscription: { trial_days: 7 } });
    await s.call("POST", "/api/billing/checkout", {}, { Cookie: cookie });
    const body = decodeURIComponent(s.stripe.find((c) => c.url.endsWith("/checkout/sessions"))!.body.replace(/\+/g, " "));
    expect(body).toContain("subscription_data[trial_period_days]=7");
    expect(body).toMatch(/custom_text\[submit\]\[message\]=Free for 7 days, then \$8\/month/);
  });

  it("anyone who has had a subscription before pays from day one", async () => {
    const s = site(env);
    const { user, cookie } = await sessionFor(s.cfg);
    await s.users.setSubscription(user.id, { id: "sub_old", status: "canceled", periodEnd: null, cancelAtPeriodEnd: false });
    expect((await s.call("GET", "/api/me", undefined, { Cookie: cookie })).body).toMatchObject({ subscription: { trial_days: 0 } });
    await s.call("POST", "/api/billing/checkout", {}, { Cookie: cookie });
    expect(decodeURIComponent(s.stripe.find((c) => c.url.endsWith("/checkout/sessions"))!.body)).not.toContain("trial_period_days");
  });

  it("emails a reminder when Stripe says the trial is about to end", async () => {
    const s = site(env);
    const { user } = await sessionFor(s.cfg, { email: "trial@example.com" });
    await s.users.setStripeCustomer(user.id, "cus_t");
    const payload = JSON.stringify({ id: "evt_tw", type: "customer.subscription.trial_will_end",
      data: { object: { id: "sub_t", customer: "cus_t", status: "trialing", trial_end: Date.UTC(2026, 10, 20) / 1000 } } });
    const r = await s.raw("/api/billing/webhook", { method: "POST", body: payload,
      headers: { "Stripe-Signature": await signed(payload, "whsec_t") } });
    expect(r.status).toBe(200);
    expect(s.mail).toHaveLength(1);
    expect(s.mail[0]).toMatchObject({ to: "trial@example.com", subject: "Your Fare Radar free trial ends soon" });
    expect(s.mail[0].text).toContain("November 20");
    expect(s.mail[0].text).toContain("$8");
  });
});

describe("homepage stats", () => {
  it("counts only real deals from the last 30 days and reports the true average saving", async () => {
    const s = site();
    await s.store.addDeal(fare("LAX", 80), { typicalMedian: 160 });   // 50% below
    await s.store.addDeal(fare("JFK", 300), { typicalMedian: 400 });  // 25% below
    await s.store.addDeal(fare("LAS", 70, { isFake: true }), { typicalMedian: 300 });
    const stats = (await s.call("GET", "/api/meta")).body.stats as Record<string, number>;
    expect(stats).toMatchObject({ deals_30d: 2, avg_below_usual_pct: 38, routes_with_deals_30d: 2 });
  });
});

describe("shared deal links", () => {
  it("return a recent real deal, and refuse test fares and unknown codes", async () => {
    const s = site();
    const d = await s.store.addDeal(fare("LAX", 80));
    const ok = await s.call("GET", `/api/deal?code=${d.code}`);
    expect(ok.body).toMatchObject({ ok: true, deal: { code: d.code, destination: "LAX", price: 80 }, stale: false });
    expect(JSON.stringify(ok.body)).not.toContain("offer_id");
    const fake = await s.store.addDeal(fare("SFO", 60, { isFake: true }));
    expect((await s.call("GET", `/api/deal?code=${fake.code}`)).status).toBe(404);
    expect((await s.call("GET", "/api/deal?code=NOPE99")).status).toBe(404);
    expect((await s.call("GET", "/api/deal?code=<script>")).status).toBe(404);
  });
});

describe("alert preferences", () => {
  it("validate destinations and save nonstop-only", async () => {
    const s = site();
    const { cookie } = await sessionFor(s.cfg, { entitled: true });
    const put = (b: unknown) => s.call("PUT", "/api/account/alerts", b, { Cookie: cookie });
    expect((await put({ on: true, origins: ["SEA"], destinations: ["XXX"] })).status).toBe(400);
    const ok = await put({ on: true, origins: ["SEA"], destinations: ["lax", "NRT", "LAX"], nonstop_only: true });
    expect((ok.body.account as { alerts: unknown }).alerts).toMatchObject({ destinations: ["LAX", "NRT"], nonstop_only: true });
    const all = await put({ on: true, origins: ["SEA"], destinations: "everywhere" });
    expect((all.body.account as { alerts: unknown }).alerts).toMatchObject({ destinations: null, nonstop_only: false });
  });

  it("are applied to alerts: only picked places, and nonstop only skips fares with stops", async () => {
    const s = site();
    const picky = await sessionFor(s.cfg, { entitled: true, email: "picky@example.com" });
    await s.users.setAlertPrefs(picky.user.id, ["JFK"], false);
    const direct = await sessionFor(s.cfg, { entitled: true, email: "direct@example.com" });
    await s.users.setAlertPrefs(direct.user.id, null, true);
    await runCycle(s.cfg, s.store, { name: "f", search: async () => [
      fare("LAX", 90),                                    // nonstop, not in picky's list
      fare("JFK", 95, { outboundStops: 1 }),              // picky's place, but with a stop
    ] }, s.notifier, NOON, true);
    const sent = s.notifier.sent.filter((m) => m.kind === "email").map((m) => `${m.to}:${m.email!.subject.includes("New York") ? "JFK" : "LAX"}`);
    expect(sent.sort()).toEqual(["direct@example.com:LAX", "picky@example.com:JFK"]);
  });
});

describe("search engines, previews and install", () => {
  it("serve robots.txt, sitemap.xml and a manifest with the site's real address", async () => {
    const s = site();
    const robots = await (await s.raw("/robots.txt")).text();
    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain(`Sitemap: ${BASE}/sitemap.xml`);
    expect(await (await s.raw("/sitemap.xml")).text()).toContain(`<loc>${BASE}/</loc>`);
    const manifest = await (await s.raw("/manifest.webmanifest")).json() as { name: string; icons: unknown[] };
    expect(manifest.name).toBe("Fare Radar");
    expect(manifest.icons).toHaveLength(3);
    for (const p of ["/icon-192.png", "/icon-512.png", "/apple-touch-icon.png", "/og.jpg"]) {
      expect((await s.raw(p)).status, p).toBe(200);
    }
  });

  it("the page carries link-preview tags with absolute URLs and no unfilled placeholders", async () => {
    const s = site();
    const html = await (await s.raw("/")).text();
    expect(html).toContain(`<meta property="og:image" content="${BASE}/og.jpg">`);
    expect(html).toContain(`<link rel="canonical" href="${BASE}/">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).not.toContain("{{BASE}}");
  });
});
