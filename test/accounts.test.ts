/** Member accounts: sign-in links, sessions, the Account API, and what members can't do. */
import { describe, expect, it } from "vitest";
import { AccountStore } from "../src/accounts";
import { handle } from "../src/app";
import { loginLink, memberLoginLink, sessionCookie } from "../src/auth";
import { contactByName } from "../src/config";
import { subscriberLink, SubscriberStore } from "../src/subscribers";
import { setup } from "./helpers";

const BASE = "https://flights.example.com";

function site() {
  const ctx = setup();
  const subs = new SubscriberStore(ctx.cfg.env.DB);
  const deps = { ...ctx, subs, fareProvider: () => { throw new Error("unused"); }, background: () => {} };
  const sent: { to: string; subject: string; text: string }[] = [];
  const raw = async (path: string, init: RequestInit = {}) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, i: RequestInit) => {
      if (String(url).startsWith("https://api.resend.com")) {
        const b = JSON.parse(i.body as string);
        sent.push({ to: b.to[0], subject: b.subject, text: b.text });
        return new Response(JSON.stringify({ id: "x" }));
      }
      return real(url, i);
    }) as typeof fetch;
    try { return await handle(new Request(BASE + path, init), deps as never); } finally { globalThis.fetch = real; }
  };
  const call = async (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const res = await raw(path, { method, body: data === undefined ? undefined : JSON.stringify(data),
      headers: { "Content-Type": "application/json", Origin: BASE, ...headers } });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text); } catch { body = { html: text }; }
    return { status: res.status, body, setCookie: res.headers.get("Set-Cookie") ?? "", res };
  };
  /** Follows a sign-in link the way a person does: open it, then press the button (POST). */
  const useLink = async (link: string) => {
    const u = new URL(link);
    const res = await raw(u.pathname, { method: "POST", body: u.searchParams,
      headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    return { status: res.status, location: res.headers.get("Location"), cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0] };
  };
  return { ...ctx, subs, sent, call, raw, useLink, accounts: new AccountStore(ctx.cfg.env.DB) };
}

let linkNo = 0;
async function member(s: ReturnType<typeof site>, email = "fan@example.com") {
  // Distinct expiry per call, so links made in the same second aren't identical (each works once).
  const r = await s.useLink(await memberLoginLink(s.cfg, email, Date.now() + (linkNo++) * 1000));
  return { Cookie: r.cookie };
}

describe("member sign-in", () => {
  it("anyone gets a link; using it creates the account and signs them in", async () => {
    const s = site();
    const r = await s.call("POST", "/api/login", { email: "New.Person@Example.com" });
    expect(r.body).toEqual({ ok: true });
    expect(s.sent[0]).toMatchObject({ to: "new.person@example.com", subject: "Create your Fare Radar account" });
    const link = s.sent[0].text.match(/https:\/\/\S+\/u\/login\?\S+/)![0];

    const page = await s.raw(new URL(link).pathname + new URL(link).search); // GET: just a button
    expect(page.status).toBe(200);
    expect(page.headers.get("Set-Cookie")).toBeNull();
    expect(await s.accounts.byEmail("new.person@example.com")).toBeNull();

    const used = await s.useLink(link);
    expect(used.status).toBe(303);
    expect(used.location).toBe("/#account?welcome");
    expect(used.cookie).toMatch(/^fr_session=u\d+v1\./);
    const me = await s.call("GET", "/api/me", undefined, { Cookie: used.cookie });
    expect(me.body).toMatchObject({ signed_in: true, role: "member", email: "new.person@example.com" });

    // Second email to an existing account says "sign in", not "create".
    await s.call("POST", "/api/login", { email: "new.person@example.com" });
    expect(s.sent[1].subject).toBe("Your Fare Radar sign-in link");
  });

  it("each link works once, expires, and can't be edited to another email", async () => {
    const s = site();
    const link = await memberLoginLink(s.cfg, "a@example.com");
    expect((await s.useLink(link)).status).toBe(303);
    expect((await s.useLink(link)).status).toBe(403);
    expect((await s.useLink(link.replace("a%40example.com", "b%40example.com"))).status).toBe(403);
    const old = await memberLoginLink(s.cfg, "c@example.com", Date.now() - 21 * 60_000);
    expect((await s.useLink(old)).status).toBe(403);
  });

  it("owner links are single-use too and still make an owner session", async () => {
    const s = site();
    const link = await loginLink(s.cfg, contactByName(s.cfg, "RAN")!);
    const r = await s.useLink(link);
    expect(r.cookie).toMatch(/^fr_session=RAN\./);
    expect((await s.call("GET", "/api/me", undefined, { Cookie: r.cookie })).body).toMatchObject({ role: "owner" });
    expect((await s.useLink(link)).status).toBe(403);
  });
});

describe("what members can and can't do", () => {
  it("can't book, can't edit the logic, can't see owners' traveler details", async () => {
    const s = site();
    const h = await member(s);
    expect((await s.call("GET", "/api/profiles", undefined, h)).status).toBe(401);
    expect((await s.call("POST", "/api/offers", { origin: "SEA", destination: "LAX", depart_date: "2027-01-10",
      return_date: "2027-01-15", travelers: ["RAN"] }, h)).status).toBe(401);
    expect((await s.call("PUT", "/api/logic", {}, h)).status).toBe(401);
    expect((await s.call("GET", "/api/logic", undefined, h)).body.can_edit).toBe(false);
  });

  it("owners can't use the member account API", async () => {
    const s = site();
    const cookie = (await sessionCookie(s.cfg, contactByName(s.cfg, "RAN")!)).split(";")[0];
    expect((await s.call("GET", "/api/account", undefined, { Cookie: cookie })).status).toBe(400);
  });
});

describe("account API", () => {
  it("starts with alerts off, and turning them on takes effect with no confirmation email", async () => {
    const s = site();
    const h = await member(s);
    const a = await s.call("GET", "/api/account", undefined, h);
    expect(a.body.account).toMatchObject({ email: "fan@example.com", name: null, alerts: { on: false } });

    const saved = await s.call("PUT", "/api/account", { name: "  Fan  ",
      alerts: { on: true, origins: ["pdx"], domestic_max: 90, international_max: 250 } }, h);
    expect(saved.body.account).toMatchObject({ name: "Fan",
      alerts: { on: true, origins: ["PDX"], domestic_max: 90, international_max: 250 } });
    expect(s.sent).toHaveLength(0);
    expect((await s.subs.byEmail("fan@example.com"))!.status).toBe("active");

    await s.call("PUT", "/api/account", { alerts: { on: false, origins: ["PDX"], domestic_max: 90, international_max: 250 } }, h);
    expect((await s.subs.byEmail("fan@example.com"))!.status).toBe("unsubscribed");
  });

  it("validates settings and blocks cross-site changes", async () => {
    const s = site();
    const h = await member(s);
    expect((await s.call("PUT", "/api/account", { alerts: { on: true, origins: ["LAX"] } }, h)).status).toBe(400);
    expect((await s.call("PUT", "/api/account", { alerts: { on: true, origins: ["SEA"], domestic_max: 99999 } }, h)).status).toBe(400);
    expect((await s.call("PUT", "/api/account", { name: "x" }, { ...h, Origin: "https://evil.example" })).status).toBe(403);
    expect((await s.call("GET", "/api/account")).status).toBe(401);
  });

  it("exports everything it holds as a download", async () => {
    const s = site();
    const h = await member(s);
    await s.call("PUT", "/api/account", { alerts: { on: true, origins: ["SEA"], domestic_max: 100, international_max: 300 } }, h);
    const r = await s.call("GET", "/api/account/export", undefined, h);
    expect(r.res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="fare-radar-account-/);
    expect(r.body).toMatchObject({ account: { email: "fan@example.com" }, deal_alerts: { on: true, origins: ["SEA"] } });
  });

  it("sign out everywhere kills every existing session", async () => {
    const s = site();
    const h1 = await member(s);
    const h2 = await member(s); // second device
    expect((await s.call("POST", "/api/account/signout-all", {}, h1)).status).toBe(200);
    expect((await s.call("GET", "/api/me", undefined, h2)).body).toEqual({ signed_in: false });
    const h3 = await member(s);
    expect((await s.call("GET", "/api/me", undefined, h3)).body.signed_in).toBe(true);
  });

  it("delete removes the account and its alerts, and needs typed confirmation", async () => {
    const s = site();
    const h = await member(s);
    await s.call("PUT", "/api/account", { alerts: { on: true, origins: ["SEA"], domestic_max: 100, international_max: 300 } }, h);
    expect((await s.call("POST", "/api/account/delete", { confirm: "yes" }, h)).status).toBe(400);
    const r = await s.call("POST", "/api/account/delete", { confirm: "DELETE" }, h);
    expect(r.status).toBe(200);
    expect(r.setCookie).toContain("Max-Age=0");
    expect(await s.accounts.byEmail("fan@example.com")).toBeNull();
    expect(await s.subs.byEmail("fan@example.com")).toBeNull();
    expect((await s.call("GET", "/api/me", undefined, h)).body).toEqual({ signed_in: false });
  });
});

describe("alert sign-ups and accounts", () => {
  it("confirming an alert sign-up creates the account and signs the person in", async () => {
    const s = site();
    const sub = await s.subs.upsert("reader@example.com", ["SEA"], 100, 300);
    const link = new URL(await subscriberLink(s.cfg, sub, "confirm"));
    const res = await s.raw(link.pathname, { method: "POST", body: link.searchParams,
      headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(200);
    const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^fr_session=u\d+v1\./);
    const acct = await s.call("GET", "/api/account", undefined, { Cookie: cookie });
    expect(acct.body.account).toMatchObject({ email: "reader@example.com", alerts: { on: true, origins: ["SEA"] } });
  });

  it("a signed-in member saving the alerts form for their own email skips the confirmation email", async () => {
    const s = site();
    const h = await member(s);
    const r = await s.call("POST", "/api/subscribe", { email: "fan@example.com", origins: ["SEA"] }, h);
    expect(r.body).toEqual({ ok: true, status: "updated" });
    expect(s.sent).toHaveLength(0);
    expect((await s.subs.byEmail("fan@example.com"))!.status).toBe("active");
  });
});
