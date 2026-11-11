/** Website API: static files, browse, contact form, email layout. */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import type { Fare } from "../src/models";
import { runCycle } from "../src/monitor";
import { memberDealEmail, unsubscribeLink } from "../src/alerts";
import { sessionFor, setup } from "./helpers";

const BASE = "https://flights.example.com";
const NOON = new Date("2026-11-05T20:00:00Z");

const fare = (dest = "LAX", price = 90, extra: Partial<Fare> = {}): Fare => ({
  provider: "t", origin: "SEA", destination: dest, departDate: "2026-12-15", returnDate: "2026-12-20",
  price, currency: "USD", airlines: ["AS"], outboundStops: 0, returnStops: 0, offerId: "secret_offer",
  bookingUrl: "https://www.google.com/travel/flights?q=x", isFake: false, ...extra,
});

function site(overrides = {}) {
  const ctx = setup(overrides);
  const emails: { to: string; subject: string }[] = [];
  // Capture confirmation emails sent straight to Resend.
  const realFetch = globalThis.fetch;
  const deps = { ...ctx, fareProvider: () => { throw new Error("unused"); }, background: () => {} };
  const call = async (path: string, init?: RequestInit) => {
    globalThis.fetch = (async (url: string, i: RequestInit) => {
      if (String(url).startsWith("https://api.resend.com")) {
        const b = JSON.parse(i.body as string);
        emails.push({ to: b.to[0], subject: b.subject, html: b.html, text: b.text, reply_to: b.reply_to, headers: b.headers } as never);
        return new Response(JSON.stringify({ id: "x" }));
      }
      return realFetch(url, i);
    }) as typeof fetch;
    try {
      const res = await handle(new Request(BASE + path, init), deps);
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* html */ }
      return { status: res.status, body: body as Record<string, unknown> & string };
    } finally { globalThis.fetch = realFetch; }
  };
  const subscribe = (body: Record<string, unknown>, ip = "1.1.1.1") => call("/api/subscribe", {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, Origin: BASE }, body: JSON.stringify(body),
  });
  const form = (path: string) => {
    const u = new URL(path, BASE);
    return call(u.pathname, { method: "POST", body: u.searchParams,
      headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  };
  return { ...ctx, emails, call, subscribe, form };
}

describe("static site", () => {
  it("serves the page, styles and script", async () => {
    const s = site();
    const home = await s.call("/");
    expect(home.status).toBe(200);
    expect(home.body).toContain("<title>Fare Radar</title>");
    expect((await s.call("/styles.css")).body).toContain("backdrop-filter");
    expect((await s.call("/app.js")).body).toContain("/api/deals");
    expect((await s.call("/nope.css")).status).toBe(404);
  });
});

describe("browse API", () => {
  it("lists deals without internal fields, with filters", async () => {
    const s = site();
    await s.store.addDeal(fare("LAX", 90));
    await s.store.addDeal(fare("NRT", 250));
    await s.store.addDeal({ ...fare("CUN", 199), origin: "PDX" });
    const all = (await s.call("/api/deals")).body.deals as Record<string, unknown>[];
    expect(all).toHaveLength(3);
    expect(all[0]).not.toHaveProperty("offer_id");
    expect(JSON.stringify(all)).not.toContain("secret_offer");
    expect(all.find((d) => d.destination === "NRT")).toMatchObject({ kind: "international", destination_city: "Tokyo Narita", trip_days: 5 });

    const pdx = (await s.call("/api/deals?origin=pdx")).body.deals as { destination: string }[];
    expect(pdx.map((d) => d.destination)).toEqual(["CUN"]);
    const dom = (await s.call("/api/deals?kind=domestic")).body.deals as { destination: string }[];
    expect(dom.map((d) => d.destination)).toEqual(["LAX"]);
    const cheap = (await s.call("/api/deals?max=200&sort=price")).body.deals as { price: number }[];
    expect(cheap.map((d) => d.price)).toEqual([90, 199]);
  });

  it("meta reports airports, limits and demo mode", async () => {
    const m = (await site({ dryRun: true, provider: "mock" }).call("/api/meta")).body;
    expect(m).toMatchObject({ domestic_max: 100, international_max: 300, demo: true, destinations: 54 });
    expect(m.origins).toEqual([{ code: "SEA", city: "Seattle" }, { code: "PDX", city: "Portland" }]);
  });
});

describe("footer pages and contact form", () => {
  const contact = (s: ReturnType<typeof site>, body: Record<string, unknown>, ip = "2.2.2.2", origin = BASE) =>
    s.call("/api/contact", {
      method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, Origin: origin },
    });

  it("has the footer links and the pages they point to", async () => {
    const home = (await site().call("/")).body;
    for (const id of ["about", "contact", "privacy", "terms", "accessibility"]) {
      expect(home).toContain(`id="view-${id}"`);
      expect(home).toContain(`href="#${id}"`);
    }
    expect(home).toContain("Do not sell or share my info");
    expect(home).not.toContain("fonts.googleapis.com"); // the font is self-hosted
  });

  it("serves the photo, email banner and fonts with long caching", async () => {
    const s = site();
    for (const path of ["/bg.jpg", "/email-banner.jpg", "/fonts/instrument-serif.woff2", "/fonts/instrument-serif-italic.woff2"]) {
      const r = await handle(new Request(BASE + path), { ...s, subs: s.subs, fareProvider: () => { throw new Error(); }, background: () => {} } as never);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("Cache-Control")).toContain("max-age=604800");
      expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
  });

  it("emails the owner with reply-to set to the sender, without exposing the owner's address", async () => {
    const s = site();
    const r = await contact(s, { name: "Pat", email: "Pat@Example.com", message: "Is PDX to Tokyo ever under $500?" });
    expect(r.body).toEqual({ ok: true });
    expect(s.emails).toHaveLength(1);
    const e = s.emails[0] as unknown as Record<string, string>;
    expect(e.to).toBe(s.cfg.contacts.find((c) => c.email)!.email);
    expect(e.reply_to).toBe("pat@example.com");
    expect(e.html).toContain("Is PDX to Tokyo ever under $500?");
    expect(JSON.stringify(r.body)).not.toContain("@");
  });

  it("escapes the message, validates input, checks origin and ignores bots", async () => {
    const s = site();
    await contact(s, { email: "a@b.co", message: "<script>alert(1)</script> hi" });
    expect((s.emails[0] as unknown as { html: string }).html).not.toContain("<script>");
    expect((await contact(s, { email: "nope", message: "hello there" })).status).toBe(400);
    expect((await contact(s, { email: "a@b.co", message: "" })).status).toBe(400);
    expect((await contact(s, { email: "a@b.co", message: "hello there" }, "3.3.3.3", "https://evil.example")).status).toBe(403);
    const before = s.emails.length;
    expect((await contact(s, { email: "a@b.co", message: "buy pills", website: "x" })).body).toEqual({ ok: true });
    expect(s.emails.length).toBe(before);
  });

  it("limits each visitor to 3 messages a day and keeps no raw IP", async () => {
    const s = site();
    for (let i = 0; i < 3; i++) expect((await contact(s, { email: "a@b.co", message: `note ${i}` }, "9.9.9.9")).status).toBe(200);
    expect((await contact(s, { email: "a@b.co", message: "note 4" }, "9.9.9.9")).status).toBe(429);
    expect((await contact(s, { email: "a@b.co", message: "other person" }, "8.8.8.8")).status).toBe(200);
    const keys = await s.cfg.env.DB.prepare("SELECT key FROM state").all<{ key: string }>();
    expect(keys.results.map((k) => k.key).join(" ")).not.toContain("9.9.9.9");
  });
});

describe("email layout", () => {
  it("member alerts carry the footer, an unsubscribe link and one-click unsubscribe headers", async () => {
    const s = site({ dryRun: false });
    const { user } = await sessionFor(s.cfg, { entitled: true, email: "fan@x.co" });
    await s.store.addDeal(fare("LAX", 90));
    const d = (await s.store.recentDeals(1))[0];
    const m = memberDealEmail(s.cfg, user, d, "domestic", "under $100", await unsubscribeLink(s.cfg, user.id));
    expect(m.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(m.headers!["List-Unsubscribe"]).toMatch(/^<https:\/\/flights\.example\.com\/u\/unsubscribe\?u=\d+&t=/);
    for (const want of ["Unsubscribe", "#privacy", "#contact", "deal alerts in your Fare Radar account (fan@x.co)",
      `© ${new Date().getUTCFullYear()} Fare Radar`, "/email-banner.jpg", "#f6b443", "under $100"]) expect(m.html).toContain(want);
    expect(m.text).toContain("Unsubscribe: https://flights.example.com/u/unsubscribe");
  });

  it("prints the postal address only when one is configured", async () => {
    const { frameFor, layout } = await import("../src/email");
    const s = site();
    const opts = { preheader: "p", heading: "h", body: "", reason: "r" };
    expect(layout(frameFor(s.cfg), opts)).not.toContain("PO Box");
    expect(layout({ ...frameFor(s.cfg), address: "PO Box 1, Seattle, WA 98101" }, opts)).toContain("PO Box 1, Seattle, WA 98101");
  });

});

describe("visitor records", () => {
  it("are deleted after 7 days", async () => {
    const { pruneVisitorRecords, visitorLimit } = await import("../src/budget");
    const s = site();
    const db = s.cfg.env.DB;
    await visitorLimit(db, "contact", "abc", 3, () => new Date("2026-11-01T00:00:00Z")).take();
    await visitorLimit(db, "contact", "abc", 3, () => new Date("2026-11-10T00:00:00Z")).take();
    await pruneVisitorRecords(db, new Date("2026-11-10T12:00:00Z"));
    const keys = (await db.prepare("SELECT key FROM state WHERE key LIKE 'rl_%'").all<{ key: string }>()).results.map((k) => k.key);
    expect(keys).toEqual(["rl_contact_abc_day_2026-11-10"]);
  });
});

describe("free sign-ups are gone", () => {
  it("the old endpoint explains alerts are for members, and stores and sends nothing", async () => {
    const s = site();
    const r = await s.subscribe({ email: "someone@example.com", origins: ["SEA"] });
    expect(r.status).toBe(410);
    expect(r.body.code).toBe("subscription_required");
    expect(s.emails).toHaveLength(0);
  });
});
