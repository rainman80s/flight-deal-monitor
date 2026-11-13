/**
 * Free launch: the Pro switch, beta testers, the admin panel's account tools, the Pro launch
 * list, and booking links that go where their labels say.
 */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { bookingSite, dealGoogleUrl, isGoogleFlights } from "../src/messages";
import { entitled, UserStore } from "../src/users";
import { sessionFor, setup } from "./helpers";

const BASE = "https://flights.example.com";

function site(env: Record<string, unknown> = {}) {
  const ctx = setup({ dryRun: false });
  Object.assign(ctx.cfg.env, { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_8", ...env });
  const deps = { ...ctx, fareProvider: () => { throw new Error("unused"); }, background: () => {} };
  const call = async (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const res = await handle(new Request(BASE + path, { method, body: data === undefined ? undefined : JSON.stringify(data),
      headers: { "Content-Type": "application/json", Origin: BASE, ...headers } }), deps as never);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { ...ctx, call, users: UserStore.for(ctx.cfg) };
}

describe("Pro switch", () => {
  it("is off by default: no checkout, and the site says Pro is coming", async () => {
    const s = site();
    expect((await s.call("GET", "/api/meta")).body.billing).toMatchObject({ enabled: false, launched: false });
    const { cookie } = await sessionFor(s.cfg);
    const r = await s.call("POST", "/api/billing/checkout", {}, { Cookie: cookie });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("pro_coming_soon");
  });

  it("turns checkout on when PRO_LAUNCHED is true", async () => {
    const s = site({ PRO_LAUNCHED: "true" });
    expect((await s.call("GET", "/api/meta")).body.billing).toMatchObject({ enabled: true, launched: true });
  });

  it("lets members join the launch list", async () => {
    const s = site();
    const { user, cookie } = await sessionFor(s.cfg);
    expect((await s.call("PUT", "/api/account/pro-waitlist", { on: true }, { Cookie: cookie })).body.pro_waitlist).toBe(true);
    expect((await s.users.byId(user.id))!.proWaitlist).toBe(true);
    expect((await s.call("GET", "/api/me", undefined, { Cookie: cookie })).body.pro_waitlist).toBe(true);
    expect((await s.call("PUT", "/api/account/pro-waitlist", { on: true })).status).toBe(401);
  });
});

describe("beta testers and the admin panel", () => {
  it("admins find an account by email and make it a tester, who then has every Pro feature", async () => {
    const s = site();
    const admin = await sessionFor(s.cfg, { role: "admin", contact: "RAN", email: "ran@example.com" });
    const beta = await sessionFor(s.cfg, { email: "beta@example.com" });
    const A = { Cookie: admin.cookie };

    expect((await s.call("GET", "/api/admin/users?email=nobody@example.com", undefined, A)).body.user).toBeNull();
    const found = await s.call("GET", "/api/admin/users?email=BETA@example.com", undefined, A);
    expect(found.body.user).toMatchObject({ id: beta.user.id, email: "beta@example.com", role: "member" });
    expect(JSON.stringify(found.body)).not.toMatch(/password|hash|stripe/i);

    expect((await s.call("GET", "/api/account/rules", undefined, { Cookie: beta.cookie })).status).toBe(402);
    const r = await s.call("PUT", "/api/admin/users/role", { id: beta.user.id, role: "tester" }, A);
    expect(r.body.user.role).toBe("tester");
    expect(entitled(await s.users.byId(beta.user.id))).toBe(true);
    expect((await s.call("GET", "/api/account/rules", undefined, { Cookie: beta.cookie })).status).toBe(200);
    expect((await s.call("POST", "/api/search", { origin: "SEA", destination: "LAX" }, { Cookie: beta.cookie })).status).not.toBe(402);

    const list = await s.call("GET", "/api/admin/testers", undefined, A);
    expect(list.body.testers.map((t: { email: string }) => t.email)).toEqual(["beta@example.com"]);
    expect(list.body.counts).toMatchObject({ testers: 1 });

    await s.call("PUT", "/api/admin/users/role", { id: beta.user.id, role: "member" }, A);
    expect(entitled(await s.users.byId(beta.user.id))).toBe(false);
  });

  it("testers have no site controls, and can't use the admin panel", async () => {
    const s = site();
    const t = await sessionFor(s.cfg, { email: "t@example.com" });
    await s.users.setRole(t.user.id, "tester", null);
    const T = { Cookie: t.cookie };
    expect((await s.call("GET", "/api/admin/testers", undefined, T)).status).toBe(403);
    expect((await s.call("GET", "/api/admin/users?email=t@example.com", undefined, T)).status).toBe(403);
    expect((await s.call("PUT", "/api/admin/users/role", { id: t.user.id, role: "tester" }, T)).status).toBe(403);
    expect((await s.call("PUT", "/api/logic", { categories: {} }, T)).status).toBe(403);
    expect((await s.call("GET", "/api/me", undefined, T)).body).toMatchObject({ role: "tester", entitled: true });
    expect((await s.call("GET", "/api/me", undefined, T)).body.contact).toBeUndefined();
  });

  it("admins can't be demoted or promoted to admin through the panel; visitors are refused", async () => {
    const s = site();
    const admin = await sessionFor(s.cfg, { role: "admin", contact: "RAN", email: "ran@example.com" });
    const other = await sessionFor(s.cfg, { role: "admin", contact: "BROCK", email: "brock@example.com" });
    const m = await sessionFor(s.cfg, { email: "m@example.com" });
    const A = { Cookie: admin.cookie };
    expect((await s.call("PUT", "/api/admin/users/role", { id: other.user.id, role: "member" }, A)).status).toBe(400);
    expect((await s.call("PUT", "/api/admin/users/role", { id: m.user.id, role: "admin" }, A)).status).toBe(400);
    expect((await s.call("GET", "/api/admin/testers")).status).toBe(401);
    expect((await s.call("PUT", "/api/admin/users/role", { id: m.user.id, role: "tester" }, { ...A, Origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("sign-up sources", () => {
  it("credits a new account to the channel in its fr_src cookie, and ignores junk", async () => {
    const s = site();
    const up = (email: string, cookie: string) => s.call("POST", "/api/auth/signup",
      { email, password: "correct horse battery staple" }, { Cookie: cookie });
    expect((await up("ig@example.com", "fr_src=instagram")).status).toBe(200);
    expect((await up("junk@example.com", "fr_src=<script>")).status).toBe(200);
    expect((await up("plain@example.com", "")).status).toBe(200);
    const admin = await sessionFor(s.cfg, { role: "admin", contact: "RAN", email: "ran@example.com" });
    const c = (await s.call("GET", "/api/admin/testers", undefined, { Cookie: admin.cookie })).body.counts;
    expect(c.sources).toEqual(expect.arrayContaining([{ source: "instagram", n: 1 }, { source: "direct", n: 2 }]));
  });
});

describe("booking links", () => {
  const d = { origin: "SEA", destination: "JFK", depart_date: "2027-01-14", return_date: "2027-01-21" };
  it("Google Flights links always go to Google for the deal's own route and dates", () => {
    const g = dealGoogleUrl({ ...d, booking_url: "https://www.flyfrontier.com/deeplink?x=1" });
    expect(isGoogleFlights(g)).toBe(true);
    expect(decodeURIComponent(g)).toContain("Flights from SEA to JFK on 2027-01-14 through 2027-01-21");
    const own = "https://www.google.com/travel/flights?tfs=abc";
    expect(dealGoogleUrl({ ...d, booking_url: own })).toBe(own);
    expect(isGoogleFlights("https://google.com.evil.example/travel/flights")).toBe(false);
  });
  it("other links are labeled by where they really go", () => {
    expect(bookingSite("https://www.flyfrontier.com/deeplink")).toBe("flyfrontier.com");
    expect(bookingSite("https://www.google.com/travel/flights?q=x")).toBe("Google Flights");
  });
});
