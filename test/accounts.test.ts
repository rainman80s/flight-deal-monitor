/**
 * Accounts and security: password storage, sign-up/sign-in, lockout, sessions, reset and
 * verification tokens, admin bootstrap, Google/Apple token verification, Stripe billing,
 * the paywall, CSRF and security headers.
 */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { verifyStripeSignature } from "../src/billing";
import { b64url, passwordProblem, Vault } from "../src/crypto";
import { finishFlow, readFlow, startFlow, verifyIdToken } from "../src/oauth";
import { ensureAdmins, entitled, UserStore } from "../src/users";
import { sessionFor, setup } from "./helpers";

const BASE = "https://flights.example.com";
const PW = "correct horse battery staple";

function site(env: Record<string, unknown> = {}) {
  const ctx = setup();
  Object.assign(ctx.cfg.env, env);
  const deps = { ...ctx, fareProvider: () => { throw new Error("unused"); }, background: () => {} };
  const mail: { to: string; subject: string; text: string }[] = [];
  const stripe: { method: string; url: string; body: string }[] = [];
  let stripeReply: (url: string, method: string) => unknown = () => ({});
  const raw = async (path: string, init: RequestInit = {}) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, i: RequestInit = {}) => {
      if (String(url).startsWith("https://api.resend.com")) {
        const b = JSON.parse(i.body as string);
        mail.push({ to: b.to[0], subject: b.subject, text: b.text });
        return new Response(JSON.stringify({ id: "m" }));
      }
      if (String(url).startsWith("https://api.stripe.com")) {
        stripe.push({ method: i.method ?? "GET", url: String(url), body: String(i.body ?? "") });
        return new Response(JSON.stringify(stripeReply(String(url), i.method ?? "GET")));
      }
      return real(url, i);
    }) as typeof fetch;
    try { return await handle(new Request(BASE + path, init), deps as never); } finally { globalThis.fetch = real; }
  };
  const call = async (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const res = await raw(path, { method, body: data === undefined ? undefined : JSON.stringify(data),
      headers: { "Content-Type": "application/json", Origin: BASE, "CF-Connecting-IP": "1.2.3.4", ...headers } });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text); } catch { body = { html: text }; }
    const set = res.headers.get("Set-Cookie") ?? "";
    return { status: res.status, body, res, setCookie: set, cookie: set.split(";")[0] };
  };
  return { ...ctx, call, raw, mail, stripe, users: UserStore.for(ctx.cfg), setStripe: (f: typeof stripeReply) => { stripeReply = f; } };
}

const tokenFrom = (text: string, kind: "reset" | "verify") => text.match(new RegExp(`#${kind}\\?token=([A-Za-z0-9_-]+)`))![1];

describe("crypto", () => {
  const v = new Vault("a-test-secret-that-is-long-enough");

  it("hashes passwords with a per-user salt and verifies them", async () => {
    const h1 = await v.hashPassword(PW);
    const h2 = await v.hashPassword(PW);
    expect(h1).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(h1).not.toBe(h2); // different salts
    expect(h1).not.toContain(PW);
    expect(await v.verifyPassword(PW, h1)).toBe(true);
    expect(await v.verifyPassword(`${PW}!`, h1)).toBe(false);
    expect(await v.verifyPassword(PW, null)).toBe(false);
    expect(await v.verifyPassword(PW, "garbage")).toBe(false);
    // A different server secret (pepper) can't verify it: a stolen database alone isn't enough.
    expect(await new Vault("another-secret-entirely-xyz").verifyPassword(PW, h1)).toBe(false);
  });

  it("encrypts data bound to its purpose; tampering or swapping fields fails", async () => {
    const sealed = await v.seal("email", "ran@example.com");
    expect(sealed).not.toContain("ran");
    expect(await v.open("email", sealed)).toBe("ran@example.com");
    await expect(v.open("name", sealed)).rejects.toThrow();
    const [ver, iv, ct] = sealed.split(".");
    const flipped = ct.slice(0, 4) + (ct[4] === "A" ? "B" : "A") + ct.slice(5);
    await expect(v.open("email", `${ver}.${iv}.${flipped}`)).rejects.toThrow();
    expect(await v.emailIndex(" Ran@Example.COM ")).toBe(await v.emailIndex("ran@example.com"));
  });

  it("rejects weak passwords", () => {
    expect(passwordProblem("short", "a@b.co")).toMatch(/10 characters/);
    expect(passwordProblem("password123", "a@b.co")).toMatch(/too common/);
    expect(passwordProblem("aaaaaaaaaaaa", "a@b.co")).toMatch(/easy to guess/);
    expect(passwordProblem("mynamejohnsmith1", "johnsmith@b.co")).toMatch(/email address/);
    expect(passwordProblem(PW, "a@b.co")).toBeNull();
  });
});

describe("sign-up and sign-in", () => {
  it("sign-up stores nothing readable and signs you in with a locked-down cookie", async () => {
    const s = site();
    const r = await s.call("POST", "/api/auth/signup", { email: "New@Example.com", password: PW, name: "Pat" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, verification_sent: true });
    expect(r.setCookie).toMatch(/^__Host-fr_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    expect(s.mail[0]).toMatchObject({ to: "new@example.com", subject: "Confirm your Fare Radar email" });

    const row = await s.cfg.env.DB.prepare("SELECT * FROM users").first<Record<string, string>>();
    const dump = JSON.stringify(row);
    for (const secret of ["new@example.com", "New@Example.com", "Pat", PW]) expect(dump).not.toContain(secret);
    const sess = await s.cfg.env.DB.prepare("SELECT id_hash FROM sessions").first<{ id_hash: string }>();
    expect(r.cookie.split("=")[1]).not.toBe(sess!.id_hash); // only the hash is stored

    const me = await s.call("GET", "/api/me", undefined, { Cookie: r.cookie });
    expect(me.body).toMatchObject({ signed_in: true, email: "new@example.com", name: "Pat", role: "member",
      email_verified: false, entitled: false });
    expect(JSON.stringify(me.body)).not.toMatch(/pbkdf2|hash|v1\./);
  });

  it("validates sign-up and refuses a second account for the same email", async () => {
    const s = site();
    expect((await s.call("POST", "/api/auth/signup", { email: "nope", password: PW })).status).toBe(400);
    expect((await s.call("POST", "/api/auth/signup", { email: "a@b.co", password: "short" })).status).toBe(400);
    expect((await s.call("POST", "/api/auth/signup", { email: "a@b.co", password: PW })).status).toBe(200);
    expect((await s.call("POST", "/api/auth/signup", { email: "A@B.co", password: PW })).status).toBe(409);
  });

  it("wrong password and unknown email get the same answer; repeated misses lock the account", async () => {
    const s = site();
    await s.call("POST", "/api/auth/signup", { email: "pat@example.com", password: PW });
    const wrong = await s.call("POST", "/api/auth/login", { email: "pat@example.com", password: "not the password" });
    const unknown = await s.call("POST", "/api/auth/login", { email: "nobody@example.com", password: "not the password" });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    for (let i = 0; i < 4; i++) await s.call("POST", "/api/auth/login", { email: "pat@example.com", password: "nope nope nope" });
    const locked = await s.call("POST", "/api/auth/login", { email: "pat@example.com", password: PW });
    expect(locked.status).toBe(429); // even the right password waits out the lock
    await s.cfg.env.DB.prepare("UPDATE users SET locked_until=0").run();
    const ok = await s.call("POST", "/api/auth/login", { email: "Pat@Example.com", password: PW });
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toMatch(/^__Host-fr_session=/);
  });

  it("limits sign-up attempts per visitor", async () => {
    const s = site();
    for (let i = 0; i < 10; i++) await s.call("POST", "/api/auth/signup", { email: `p${i}@example.com`, password: PW });
    expect((await s.call("POST", "/api/auth/signup", { email: "p99@example.com", password: PW })).status).toBe(429);
  });

  it("sign-out ends the session on the server, not just in the browser", async () => {
    const s = site();
    const { cookie } = await sessionFor(s.cfg);
    expect((await s.call("POST", "/api/auth/logout", {}, { Cookie: cookie })).setCookie).toContain("Max-Age=0");
    expect((await s.call("GET", "/api/me", undefined, { Cookie: cookie })).body.signed_in).toBe(false);
    expect((await s.call("GET", "/api/me", undefined, { Cookie: "__Host-fr_session=forged" })).body.signed_in).toBe(false);
  });
});

describe("reset and verification", () => {
  it("forgot-password replies the same for anyone and emails only real accounts", async () => {
    const s = site();
    await sessionFor(s.cfg, { email: "pat@example.com" });
    const a = await s.call("POST", "/api/auth/forgot", { email: "pat@example.com" });
    const b = await s.call("POST", "/api/auth/forgot", { email: "ghost@example.com" });
    expect(a.body).toEqual(b.body);
    expect(s.mail.map((m) => m.to)).toEqual(["pat@example.com"]);
  });

  it("a reset link works once, sets the password, verifies the email and signs out other devices", async () => {
    const s = site();
    const { user, cookie: old } = await sessionFor(s.cfg, { email: "pat@example.com", verified: false });
    await s.call("POST", "/api/auth/forgot", { email: "pat@example.com" });
    const token = tokenFrom(s.mail[0].text, "reset");
    const weak = await s.call("POST", "/api/auth/reset", { token, password: "short" });
    expect(weak.status).toBe(400);
    const fresh = String(weak.body.token); // a typo doesn't cost another email
    const done = await s.call("POST", "/api/auth/reset", { token: fresh, password: "a whole new passphrase" });
    expect(done.status).toBe(200);
    expect(done.setCookie).toMatch(/^__Host-fr_session=/);
    expect((await s.call("POST", "/api/auth/reset", { token: fresh, password: "another new passphrase" })).status).toBe(400);
    expect((await s.call("POST", "/api/auth/reset", { token, password: "another new passphrase" })).status).toBe(400);
    expect((await s.call("GET", "/api/me", undefined, { Cookie: old })).body.signed_in).toBe(false);
    const u = (await s.users.byId(user.id))!;
    expect(u.emailVerified).toBe(true);
    expect(await s.users.vault.verifyPassword("a whole new passphrase", u.passwordHash)).toBe(true);
    expect(s.mail.some((m) => m.subject === "Your Fare Radar password was changed")).toBe(true);
  });

  it("email verification links work once", async () => {
    const s = site();
    const r = await s.call("POST", "/api/auth/signup", { email: "v@example.com", password: PW });
    const token = tokenFrom(s.mail[0].text, "verify");
    expect((await s.call("POST", "/api/auth/verify", { token })).status).toBe(200);
    expect((await s.call("POST", "/api/auth/verify", { token })).status).toBe(400);
    expect((await s.call("GET", "/api/me", undefined, { Cookie: r.cookie })).body.email_verified).toBe(true);
  });

  it("changing your password needs the current one and signs out your other devices", async () => {
    const s = site();
    const a = await s.call("POST", "/api/auth/signup", { email: "c@example.com", password: PW });
    const b = await s.call("POST", "/api/auth/login", { email: "c@example.com", password: PW });
    expect((await s.call("POST", "/api/auth/password", { current: "wrong one!!", password: "a new passphrase here" }, { Cookie: a.cookie })).status).toBe(400);
    expect((await s.call("POST", "/api/auth/password", { current: PW, password: "a new passphrase here" }, { Cookie: a.cookie })).status).toBe(200);
    expect((await s.call("GET", "/api/me", undefined, { Cookie: a.cookie })).body.signed_in).toBe(true);
    expect((await s.call("GET", "/api/me", undefined, { Cookie: b.cookie })).body.signed_in).toBe(false);
  });
});

describe("admins", () => {
  it("owners get admin accounts with the starting password, and must change it before anything else", async () => {
    const s = site({ ADMIN_INITIAL_PASSWORD: "admin" });
    s.cfg.contacts.find((c) => c.name === "BROCK")!.email = "brock@example.com";
    expect((await ensureAdmins(s.cfg)).sort()).toEqual(["BROCK", "RAN"]);
    expect(await ensureAdmins(s.cfg)).toEqual([]); // idempotent: never resets a password again

    const login = await s.call("POST", "/api/auth/login", { email: "ran@example.com", password: "admin" });
    expect(login.body).toMatchObject({ ok: true, must_change_password: true });
    const h = { Cookie: login.cookie };
    expect((await s.call("GET", "/api/me", undefined, h)).body).toMatchObject({ role: "admin", must_change_password: true, entitled: true });
    const blocked = await s.call("GET", "/api/account", undefined, h);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("must_change_password");
    expect((await s.call("GET", "/api/profiles", undefined, h)).status).toBe(403);
    expect((await s.call("POST", "/api/auth/password", { current: "admin", password: "a real admin passphrase" }, h)).status).toBe(200);
    expect((await s.call("GET", "/api/account", undefined, h)).status).toBe(200);
    expect((await s.call("GET", "/api/profiles", undefined, h)).status).toBe(200);
    expect((await s.call("POST", "/api/auth/login", { email: "brock@example.com", password: "admin" })).body.must_change_password).toBe(true);
  });

  it("signing up with an owner's email doesn't make you an admin until the inbox is proven", async () => {
    const s = site();
    const r = await s.call("POST", "/api/auth/signup", { email: "ran@example.com", password: PW });
    expect((await s.call("GET", "/api/me", undefined, { Cookie: r.cookie })).body.role).toBe("member");
    expect((await s.call("GET", "/api/profiles", undefined, { Cookie: r.cookie })).status).toBe(401);
    await s.call("POST", "/api/auth/verify", { token: tokenFrom(s.mail[0].text, "verify") });
    expect((await s.call("GET", "/api/me", undefined, { Cookie: r.cookie })).body.role).toBe("admin");
  });

  it("an unverified squatter on an owner's email loses it when admins are set up", async () => {
    const s = site({ ADMIN_INITIAL_PASSWORD: "admin" });
    const squat = await s.call("POST", "/api/auth/signup", { email: "ran@example.com", password: PW });
    expect(await ensureAdmins(s.cfg)).toEqual(["RAN"]);
    expect((await s.call("GET", "/api/me", undefined, { Cookie: squat.cookie })).body.signed_in).toBe(false);
    expect((await s.call("POST", "/api/auth/login", { email: "ran@example.com", password: PW })).status).toBe(401);
    expect((await s.call("POST", "/api/auth/login", { email: "ran@example.com", password: "admin" })).status).toBe(200);
  });

  it("admin accounts can't be deleted from the site", async () => {
    const s = site();
    const { cookie } = await sessionFor(s.cfg, { role: "admin", contact: "RAN", email: "ran@example.com" });
    expect((await s.call("POST", "/api/account/delete", { confirm: "DELETE", password: "a long test password" }, { Cookie: cookie })).status).toBe(400);
  });
});

describe("your data", () => {
  it("export has no secrets; delete needs your password and removes everything", async () => {
    const s = site();
    const { user, cookie } = await sessionFor(s.cfg, { email: "del@example.com" });
    const exp = await s.call("GET", "/api/account/export", undefined, { Cookie: cookie });
    expect(exp.res.headers.get("Content-Disposition")).toMatch(/^attachment/);
    expect(exp.body).toMatchObject({ account: { email: "del@example.com" } });
    expect(JSON.stringify(exp.body)).not.toMatch(/pbkdf2|password_hash|v1\./);

    expect((await s.call("POST", "/api/account/delete", { confirm: "DELETE", password: "wrong password!" }, { Cookie: cookie })).status).toBe(400);
    expect((await s.call("POST", "/api/account/delete", { confirm: "yes", password: "a long test password" }, { Cookie: cookie })).status).toBe(400);
    const r = await s.call("POST", "/api/account/delete", { confirm: "DELETE", password: "a long test password" }, { Cookie: cookie });
    expect(r.status).toBe(200);
    expect(await s.users.byId(user.id)).toBeNull();
    for (const t of ["sessions", "auth_tokens", "identities", "user_alerts"]) {
      expect((await s.cfg.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id=?`).bind(user.id).first<{ n: number }>())!.n).toBe(0);
    }
  });

  it("sign out everywhere ends every session", async () => {
    const s = site();
    await s.call("POST", "/api/auth/signup", { email: "e@example.com", password: PW });
    const a = await s.call("POST", "/api/auth/login", { email: "e@example.com", password: PW });
    const b = await s.call("POST", "/api/auth/login", { email: "e@example.com", password: PW });
    await s.call("POST", "/api/account/signout-all", {}, { Cookie: a.cookie });
    expect((await s.call("GET", "/api/me", undefined, { Cookie: b.cookie })).body.signed_in).toBe(false);
  });
});

describe("site-wide protections", () => {
  it("every response carries the security headers", async () => {
    const s = site();
    for (const path of ["/", "/api/me", "/api/deals", "/nope"]) {
      const r = await s.raw(path);
      expect(r.headers.get("Content-Security-Policy"), path).toContain("default-src 'self'");
      expect(r.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(r.headers.get("Strict-Transport-Security")).toContain("max-age=");
      expect(r.headers.get("X-Frame-Options")).toBe("DENY");
      expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("state-changing API calls from other sites are refused", async () => {
    const s = site();
    const { cookie } = await sessionFor(s.cfg);
    for (const [m, p] of [["POST", "/api/auth/login"], ["PUT", "/api/account"], ["POST", "/api/account/delete"], ["POST", "/api/billing/checkout"]]) {
      expect((await s.call(m, p, {}, { Cookie: cookie, Origin: "https://evil.example" })).status, p).toBe(403);
      const noOrigin = await s.raw(p, { method: m, body: "{}", headers: { Cookie: cookie, "Content-Type": "application/json" } });
      expect(noOrigin.status, `${p} without Origin`).toBe(403);
    }
  });

  it("Pro features answer 402 for free accounts and 401 for visitors; basic alerts are free", async () => {
    const s = site();
    const { cookie } = await sessionFor(s.cfg);
    const free = await s.call("PUT", "/api/account/alerts", { on: true, origins: ["SEA"], destinations: ["LAX"], nonstop_only: true }, { Cookie: cookie });
    expect(free.status).toBe(200);
    // The Pro-only filters are ignored for free accounts.
    expect((free.body.account as { alerts: unknown }).alerts).toMatchObject({ on: true, destinations: null, nonstop_only: false });
    expect((await s.call("GET", "/api/account/rules", undefined, { Cookie: cookie })).status).toBe(402);
    expect((await s.call("GET", "/api/account/rules")).status).toBe(401);
    expect(entitled((await sessionFor(s.cfg, { entitled: true })).user)).toBe(true);
  });
});

// ---------------- Google / Apple ----------------

async function rsaKey(kid = "k1") {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
  const sign = async (claims: Record<string, unknown>) => {
    const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const head = enc({ alg: "RS256", kid, typ: "JWT" });
    const body = enc(claims);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
  };
  return { jwk, sign };
}

describe("Google and Apple sign-in", () => {
  const env = { GOOGLE_CLIENT_ID: "gid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "gsecret" };

  it("verifies the ID token's signature, issuer, audience and expiry", async () => {
    const { jwk, sign } = await rsaKey();
    const keys = (async () => new Response(JSON.stringify({ keys: [jwk] }))) as unknown as typeof fetch;
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, sub: "g-1", email: "pat@example.com",
      email_verified: true, exp: now + 300, iat: now, nonce: "n1" };
    expect((await verifyIdToken(await sign(good), "google", env.GOOGLE_CLIENT_ID, keys)).sub).toBe("g-1");
    await expect(verifyIdToken(await sign({ ...good, aud: "someone-else" }), "google", env.GOOGLE_CLIENT_ID, keys)).rejects.toThrow(/audience/);
    await expect(verifyIdToken(await sign({ ...good, iss: "https://evil.example" }), "google", env.GOOGLE_CLIENT_ID, keys)).rejects.toThrow(/issuer/);
    await expect(verifyIdToken(await sign({ ...good, exp: now - 3600 }), "google", env.GOOGLE_CLIENT_ID, keys)).rejects.toThrow(/expired/);
    const other = await rsaKey(); // same key id, different key: the signature fails
    await expect(verifyIdToken(await other.sign(good), "google", env.GOOGLE_CLIENT_ID, keys)).rejects.toThrow(/signature/);
  });

  it("start sets a signed state cookie; the callback rejects a mismatched or forged state", async () => {
    const s = site(env);
    const start = await s.raw("/api/auth/oauth/google/start");
    expect(start.status).toBe(303);
    const to = new URL(start.headers.get("Location")!);
    expect(to.origin).toBe("https://accounts.google.com");
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("redirect_uri")).toBe(`${BASE}/api/auth/oauth/google/callback`);
    const cookie = start.headers.get("Set-Cookie")!.split(";")[0];
    expect(start.headers.get("Set-Cookie")).toContain("HttpOnly; Secure; SameSite=None; Max-Age=600");
    const bad = await s.raw("/api/auth/oauth/google/callback?state=wrong&code=c", { headers: { Cookie: cookie } });
    expect(bad.headers.get("Location")).toBe("/#signin?error=expired");
    const value = cookie.slice(cookie.indexOf("=") + 1);
    expect(await readFlow(s.users.vault, value.replace(/\.[^.]+$/, ".forged"), "google", to.searchParams.get("state")!)).toBeNull();
    expect(await readFlow(s.users.vault, value, "apple", to.searchParams.get("state")!)).toBeNull();
    expect(await readFlow(s.users.vault, value, "google", to.searchParams.get("state")!)).not.toBeNull();
  });

  it("a verified Google email links to the existing account; an unverified squatter's password is cleared", async () => {
    const s = site(env);
    const squat = await s.call("POST", "/api/auth/signup", { email: "pat@example.com", password: PW });
    const { jwk, sign } = await rsaKey("k-link");
    const { url, cookie } = await startFlow(s.cfg, s.users.vault, "google");
    const state = new URL(url).searchParams.get("state")!;
    const cookieValue = cookie.split(";")[0].slice(cookie.indexOf("=") + 1);
    const flow = (await readFlow(s.users.vault, cookieValue, "google", state))!;
    const now = Math.floor(Date.now() / 1000);
    const idToken = await sign({ iss: "https://accounts.google.com", aud: env.GOOGLE_CLIENT_ID, sub: "g-77", email: "Pat@Example.com",
      email_verified: true, exp: now + 300, iat: now, nonce: flow.nonce, name: "Pat" });
    const fetcher = (async (u: string, i: RequestInit = {}) => {
      if (String(u).startsWith("https://oauth2.googleapis.com/token")) {
        expect(String(i.body)).toContain(`code_verifier=${flow.verifier}`); // PKCE
        return new Response(JSON.stringify({ id_token: idToken }));
      }
      return new Response(JSON.stringify({ keys: [jwk] }));
    }) as unknown as typeof fetch;
    expect(await finishFlow(s.cfg, flow, "the-code", null, fetcher))
      .toMatchObject({ provider: "google", subject: "g-77", email: "pat@example.com", name: "Pat" });
    await expect(finishFlow(s.cfg, { ...flow, nonce: "different" }, "the-code", null, fetcher)).rejects.toThrow(/nonce/);

    // Through the real callback route.
    const real = globalThis.fetch;
    globalThis.fetch = fetcher;
    let res: Response;
    try {
      res = await handle(new Request(`${BASE}/api/auth/oauth/google/callback?state=${state}&code=the-code`,
        { headers: { Cookie: `__Host-fr_oauth=${cookieValue}` } }),
        { ...s, fareProvider: () => { throw new Error(); }, background: () => {} } as never);
    } finally { globalThis.fetch = real; }
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/#account");
    const u = (await s.users.byEmail("pat@example.com"))!;
    expect(u.emailVerified).toBe(true);
    expect(u.hasPassword).toBe(false); // the squatter's password no longer works
    expect(await s.users.identities(u.id)).toEqual(["google"]);
    expect((await s.call("GET", "/api/me", undefined, { Cookie: squat.cookie })).body.signed_in).toBe(false);
  });
});

// ---------------- Stripe ----------------

async function stripeSig(payload: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("Stripe billing", () => {
  const env = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", STRIPE_PRICE_ID: "price_8", PRO_LAUNCHED: "true" };

  it("checks webhook signatures, including their age", async () => {
    const body = '{"id":"evt_1"}';
    expect(await verifyStripeSignature(body, await stripeSig(body, "whsec_test"), "whsec_test")).toBe(true);
    expect(await verifyStripeSignature(body, await stripeSig(body, "wrong"), "whsec_test")).toBe(false);
    expect(await verifyStripeSignature(`${body} `, await stripeSig(body, "whsec_test"), "whsec_test")).toBe(false);
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(await verifyStripeSignature(body, await stripeSig(body, "whsec_test", old), "whsec_test")).toBe(false);
  });

  it("checkout creates the customer once and only sends members to Stripe", async () => {
    const s = site(env);
    s.setStripe((url) => url.endsWith("/customers") ? { id: "cus_1" } : { url: "https://checkout.stripe.com/c/pay/cs_1" });
    const { user, cookie } = await sessionFor(s.cfg);
    const r = await s.call("POST", "/api/billing/checkout", {}, { Cookie: cookie });
    expect(r.body).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(s.stripe.map((c) => c.url.replace("https://api.stripe.com/v1", ""))).toEqual(["/customers", "/checkout/sessions"]);
    const session = decodeURIComponent(s.stripe[1].body);
    expect(session).toContain("line_items[0][price]=price_8");
    expect(session).toContain(`client_reference_id=${user.id}`);
    expect(session).toContain("mode=subscription");
    await s.call("POST", "/api/billing/checkout", {}, { Cookie: cookie });
    expect(s.stripe.filter((c) => c.url.endsWith("/customers"))).toHaveLength(1);
    expect((await s.call("POST", "/api/billing/checkout", {})).status).toBe(401);
    const admin = (await sessionFor(s.cfg, { role: "admin", contact: "RAN", email: "ran@example.com" })).cookie;
    expect((await s.call("POST", "/api/billing/checkout", {}, { Cookie: admin })).status).toBe(400);
  });

  it("webhooks turn membership on and off, once per event, and only when signed", async () => {
    const s = site(env);
    const { user, cookie } = await sessionFor(s.cfg);
    await s.users.setStripeCustomer(user.id, "cus_9");
    const send = async (evt: Record<string, unknown>, sig?: string) => {
      const payload = JSON.stringify(evt);
      return s.raw("/api/billing/webhook", { method: "POST", body: payload,
        headers: { "Stripe-Signature": sig ?? await stripeSig(payload, "whsec_test"), "Content-Type": "application/json" } });
    };
    const sub = (status: string) => ({ id: `evt_${status}`, type: "customer.subscription.updated", data: { object: {
      id: "sub_9", customer: "cus_9", status, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, cancel_at_period_end: false } } });
    expect((await send(sub("active"), "t=1,v1=bad")).status).toBe(400);
    expect(entitled(await s.users.byId(user.id))).toBe(false);
    expect((await send(sub("active"))).status).toBe(200); // cross-site, no Origin: allowed, because it's signed
    expect(entitled(await s.users.byId(user.id))).toBe(true);
    expect((await s.call("GET", "/api/account/rules", undefined, { Cookie: cookie })).status).toBe(200);
    expect(await (await send(sub("active"))).json()).toMatchObject({ duplicate: true });
    await send({ ...sub("canceled"), type: "customer.subscription.deleted" });
    expect(entitled(await s.users.byId(user.id))).toBe(false);
    expect((await s.call("GET", "/api/account/rules", undefined, { Cookie: cookie })).status).toBe(402);
  });

  it("deleting an account cancels its subscription first", async () => {
    const s = site(env);
    const { user, cookie } = await sessionFor(s.cfg, { entitled: true });
    s.setStripe(() => ({ id: "sub_test", status: "canceled" }));
    const r = await s.call("POST", "/api/account/delete", { confirm: "DELETE", password: "a long test password" }, { Cookie: cookie });
    expect(r.status).toBe(200);
    expect(s.stripe).toEqual([expect.objectContaining({ method: "DELETE", url: "https://api.stripe.com/v1/subscriptions/sub_test" })]);
    expect(await s.users.byId(user.id)).toBeNull();
  });
});
