/**
 * Sign-up, sign-in and the Account page API.
 *
 *   GET  /api/me                               who's signed in (never secrets)
 *   POST /api/auth/signup     {email, password, name?}
 *   POST /api/auth/login      {email, password}
 *   POST /api/auth/logout
 *   POST /api/auth/forgot     {email}          always the same reply
 *   POST /api/auth/reset      {token, password}
 *   POST /api/auth/verify     {token}
 *   POST /api/auth/verify/resend
 *   POST /api/auth/password   {current, password}
 *   GET  /api/auth/oauth/:provider/start        Google / Apple
 *   GET|POST /api/auth/oauth/:provider/callback
 *   GET|PUT /api/account                        {name}
 *   PUT  /api/account/alerts  {on, origins, destinations?, nonstop_only?}   anyone; the filters are Pro
 *   PUT  /api/account/pro-waitlist {on}        hear when Pro launches
 *   GET  /api/admin/users?email=               admins: find an account (exact email)
 *   GET  /api/admin/testers                    admins: beta testers and counts
 *   PUT  /api/admin/users/role {id, role}      admins: make someone a tester or a member
 *   GET|PUT|DELETE /api/account/rules           subscribers: personal logic
 *   GET  /api/account/export
 *   POST /api/account/signout-all
 *   POST /api/account/delete  {password?, confirm: "DELETE"}
 *
 * Guarantees: passwords are checked in constant work whether or not the account exists; failed
 * sign-ins lock the account with backoff and are rate-limited per visitor; replies don't reveal
 * which emails have accounts (except sign-up, which has to say "already registered");
 * email links carry the token in the URL fragment so it never reaches server logs or referrers.
 */
import type { Deps } from "./app";
import { clearCookie, currentSession, readCookie, sessionCookie } from "./auth";
import { cancelSubscriptionNow, subscriptionView } from "./billing";
import { Budget, BudgetExceeded, visitorLimit, visitorTag } from "./budget";
import { type Config, secret } from "./config";
import { EMAIL_RE, normalizeEmail, passwordProblem } from "./crypto";
import { BRAND, button, fine, frameFor, layout, p as para, textFooter } from "./email";
import { ResendEmailer } from "./notify";
import { clearOauthCookie, finishFlow, OAUTH_COOKIE, OAuthError, type Provider, providersEnabled, readFlow, startFlow } from "./oauth";
import { adminFeedback, submitFeedback } from "./feedback";
import { mediaRoute } from "./media";
import { ownerBooking } from "./owner";
import { describe, personalCategories, toRaw, validateCat } from "./settings";
import { entitled, type User, UserStore } from "./users";

const json = (data: unknown, status = 200, headers: Record<string, string> | [string, string][] = {}) => {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  h.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: h });
};

async function body(req: Request): Promise<Record<string, unknown> | null> {
  if (Number(req.headers.get("Content-Length") ?? 0) > 20_000) return null;
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? b as Record<string, unknown> : null;
  } catch { return null; }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v : "").slice(0, max);
const GENERIC_LOGIN = "That email and password don't match an account.";
const EMAILS_PER_DAY = 300;

async function limit(cfg: Config, req: Request, what: string, perDay: number) {
  const tag = await visitorTag(String(cfg.env.LINK_SECRET ?? ""), req.headers.get("CF-Connecting-IP") ?? "local");
  await visitorLimit(cfg.env.DB, what, tag, perDay).take();
}

/** Sends an account email. Returns false (and logs) instead of throwing. */
export async function sendMail(cfg: Config, to: string, msg: { subject: string; text: string; html: string }) {
  const key = cfg.env.RESEND_API_KEY;
  if (typeof key !== "string" || !key) return false;
  try {
    await new Budget(cfg.env.DB, "account_email", EMAILS_PER_DAY, Number.MAX_SAFE_INTEGER).take();
    await new ResendEmailer(key, String(cfg.env.EMAIL_FROM ?? cfg.emailFrom)).send(to, msg);
    return true;
  } catch (e) {
    console.error("account email failed", (e as Error).message);
    return false;
  }
}

export function accountEmail(cfg: Config, to: string, o: { subject: string; eyebrow: string; heading: string; lead: string;
                                                     link?: string; cta?: string; note: string; preheader: string }) {
  const f = frameFor(cfg);
  const reason = `You're getting this because of activity on the ${BRAND} account for ${to}.`;
  return {
    subject: o.subject,
    text: `${o.lead}\n${o.link ? `${o.link}\n` : ""}\n${o.note}\n` + textFooter(f, reason),
    html: layout(f, { preheader: o.preheader, eyebrow: o.eyebrow, heading: o.heading, reason,
      body: para(o.lead) + (o.link ? `<div style="margin:22px 0 4px">${button(o.link, o.cta ?? "Continue")}</div>` : "")
        + fine(o.note) }),
  };
}

const base = (cfg: Config) => secret(cfg, "PUBLIC_BASE_URL").replace(/\/$/, "");

async function sendVerification(cfg: Config, users: UserStore, u: User) {
  const token = await users.issueToken(u.id, "verify", 24 * 60);
  return sendMail(cfg, u.email, accountEmail(cfg, u.email, {
    subject: "Confirm your Fare Radar email", eyebrow: "Welcome", heading: "Confirm your email",
    lead: "Tap below to confirm this is your email address. It keeps your account recoverable and lets us send your deal alerts.",
    link: `${base(cfg)}/#verify?token=${token}`, cta: "Confirm my email", preheader: "One tap to confirm your email.",
    note: "The link works once, for 24 hours. Didn't create an account? Ignore this email.",
  }));
}

async function notifyPasswordChanged(cfg: Config, u: User) {
  await sendMail(cfg, u.email, accountEmail(cfg, u.email, {
    subject: "Your Fare Radar password was changed", eyebrow: "Security", heading: "Password changed",
    lead: "The password for your Fare Radar account was just changed, and every other device was signed out.",
    note: "If this wasn't you, reset your password from the sign-in screen right away and contact us.",
    preheader: "Your password was just changed.",
  }));
}

/** What the browser may know about the signed-in person. Never hashes, tokens or ciphertext. */
async function meView(cfg: Config, users: UserStore, u: User) {
  return {
    signed_in: true,
    id: u.id,
    email: u.email,
    name: u.name || u.email.split("@")[0],
    role: u.role,
    email_verified: u.emailVerified,
    must_change_password: u.mustChangePassword,
    has_password: u.hasPassword,
    sign_in_methods: [...(u.hasPassword ? ["password"] : []), ...(await users.identities(u.id))],
    entitled: entitled(u),
    pro_waitlist: u.proWaitlist,
    subscription: subscriptionView(u),
    ...(u.role === "admin" && u.contact && !u.mustChangePassword ? { contact: u.contact, booking: await ownerBooking(cfg) } : {}),
  };
}

async function signIn(users: UserStore, u: User, req: Request, extra: Record<string, unknown> = {}) {
  await users.recordLogin(u.id);
  const token = await users.createSession(u.id, req.headers.get("User-Agent"));
  return json({ ok: true, must_change_password: u.mustChangePassword, ...extra }, 200, { "Set-Cookie": sessionCookie(token) });
}

/** Paths a person who must change their password may still use. */
export const MUST_CHANGE_ALLOWED = new Set(["/api/me", "/api/meta", "/api/auth/password", "/api/auth/logout", "/api/deals"]);

export async function accountRoute(req: Request, url: URL, deps: Deps): Promise<Response | null> {
  const { cfg } = deps;
  const p = url.pathname;
  if (!p.startsWith("/api/auth/") && !p.startsWith("/api/account") && !p.startsWith("/api/admin/") && p !== "/api/me") return null;
  if (typeof cfg.env.LINK_SECRET !== "string" || cfg.env.LINK_SECRET.length < 16) {
    return json({ ok: false, error: "Accounts aren't set up on this site yet." }, 503);
  }
  const users = UserStore.for(cfg);
  const m = req.method;

  try {
    if (p === "/api/me" && m === "GET") {
      const s = await currentSession(cfg, req);
      return json(s ? await meView(cfg, users, s.user) : { signed_in: false, providers: providersEnabled(cfg) });
    }

    // ---------------- sign-up / sign-in ----------------
    if (p === "/api/auth/signup" && m === "POST") {
      const b = await body(req);
      const email = normalizeEmail(str(b?.email, 320));
      const password = str(b?.password, 400);
      const name = str(b?.name, 60).trim() || null;
      if (!EMAIL_RE.test(email)) return json({ ok: false, error: "Enter a valid email address.", field: "email" }, 400);
      const problem = passwordProblem(password, email);
      if (problem) return json({ ok: false, error: problem, field: "password" }, 400);
      await limit(cfg, req, "signup", 10);
      if (await users.byEmail(email)) {
        return json({ ok: false, error: "There's already an account with that email. Sign in instead, or reset your password.",
          field: "email" }, 409);
      }
      // Always a member at sign-up: nobody has proved they own this inbox yet. An owner's email
      // becomes admin only once verified (promoteIfOwner).
      const u = await users.create({ email, password, name, origins: cfg.origins, source: signupSource(req) });
      const sent = await sendVerification(cfg, users, u);
      return signIn(users, u, req, { verification_sent: sent });
    }

    if (p === "/api/auth/login" && m === "POST") {
      const b = await body(req);
      const email = normalizeEmail(str(b?.email, 320));
      const password = str(b?.password, 400);
      if (!email || !password) return json({ ok: false, error: "Enter your email and password." }, 400);
      await limit(cfg, req, "login", 50);
      const u = EMAIL_RE.test(email) ? await users.byEmail(email) : null;
      const ok = await users.vault.verifyPassword(password, u?.passwordHash ?? null); // same work either way
      if (u && u.lockedUntil > Math.floor(Date.now() / 1000)) {
        return json({ ok: false, error: "Too many attempts. Wait a few minutes and try again, or reset your password." }, 429);
      }
      if (!u || !ok) {
        if (u) await users.recordFailedLogin(u);
        return json({ ok: false, error: GENERIC_LOGIN }, 401);
      }
      return signIn(users, u, req);
    }

    if (p === "/api/auth/logout" && m === "POST") {
      const s = await currentSession(cfg, req);
      if (s) await users.endSession(s.idHash);
      return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
    }

    if (p === "/api/auth/forgot" && m === "POST") {
      const b = await body(req);
      const email = normalizeEmail(str(b?.email, 320));
      if (!EMAIL_RE.test(email)) return json({ ok: false, error: "Enter a valid email address." }, 400);
      await limit(cfg, req, "forgot", 5);
      const u = await users.byEmail(email);
      if (u) {
        const token = await users.issueToken(u.id, "reset", 30);
        await sendMail(cfg, u.email, accountEmail(cfg, u.email, {
          subject: "Reset your Fare Radar password", eyebrow: "Security", heading: "Reset your password",
          lead: "Someone (hopefully you) asked to reset the password for your Fare Radar account. Tap below to choose a new one.",
          link: `${base(cfg)}/#reset?token=${token}`, cta: "Choose a new password", preheader: "Your password reset link.",
          note: "The link works once, for 30 minutes. If you didn't ask for this, ignore it; your password stays the same.",
        }));
      }
      // Same reply whether or not there's an account.
      return json({ ok: true });
    }

    if (p === "/api/auth/reset" && m === "POST") {
      const b = await body(req);
      const token = str(b?.token, 100), password = str(b?.password, 400);
      await limit(cfg, req, "reset", 20);
      if (!(await users.peekToken(token, "reset"))) {
        return json({ ok: false, error: "That reset link has expired or was already used. Ask for a new one." }, 400);
      }
      const id0 = await users.consumeToken(token, "reset");
      const u = id0 ? await users.byId(id0) : null;
      if (!u) return json({ ok: false, error: "That reset link has expired or was already used. Ask for a new one." }, 400);
      const problem = passwordProblem(password, u.email);
      if (problem) {
        // Give them a fresh link so a typo in the new password doesn't cost them the email round-trip.
        const again = await users.issueToken(u.id, "reset", 30);
        return json({ ok: false, error: problem, field: "password", token: again }, 400);
      }
      await users.setPassword(u.id, password);
      await users.markVerified(u.id); // they proved they read this inbox
      await promoteIfOwner(cfg, users, u.id);
      await users.endAllSessions(u.id);
      await notifyPasswordChanged(cfg, u);
      return signIn(users, (await users.byId(u.id))!, req);
    }

    if (p === "/api/auth/verify" && m === "POST") {
      const b = await body(req);
      await limit(cfg, req, "verify", 30);
      const id = await users.consumeToken(str(b?.token, 100), "verify");
      if (!id) return json({ ok: false, error: "That link has expired or was already used." }, 400);
      await users.markVerified(id);
      await promoteIfOwner(cfg, users, id);
      return json({ ok: true });
    }

    // ---------------- Google / Apple ----------------
    const oa = p.match(/^\/api\/auth\/oauth\/(google|apple)\/(start|callback)$/);
    if (oa) {
      const provider = oa[1] as Provider;
      if (!providersEnabled(cfg).includes(provider)) return redirect("/#signin?error=unavailable");
      if (oa[2] === "start" && m === "GET") {
        await limit(cfg, req, "oauth", 30);
        const { url: to, cookie } = await startFlow(cfg, users.vault, provider);
        return redirect(to, cookie);
      }
      if (oa[2] === "callback" && (m === "GET" || m === "POST")) {
        const params = m === "POST" ? new URLSearchParams(await req.text()) : url.searchParams;
        if (params.get("error")) return redirect("/#signin?error=cancelled", clearOauthCookie());
        const flow = await readFlow(users.vault, readCookie(req, OAUTH_COOKIE), provider, params.get("state") ?? "");
        if (!flow) return redirect("/#signin?error=expired", clearOauthCookie());
        try {
          const id = await finishFlow(cfg, flow, params.get("code") ?? "", params.get("user"));
          const u = await oauthUser(cfg, users, id, signupSource(req));
          await users.recordLogin(u.id);
          const token = await users.createSession(u.id, req.headers.get("User-Agent"));
          const h = new Headers({ Location: "/#account" });
          h.append("Set-Cookie", sessionCookie(token));
          h.append("Set-Cookie", clearOauthCookie());
          return new Response(null, { status: 303, headers: h });
        } catch (e) {
          console.error("oauth failed", provider, (e as Error).message);
          return redirect(`/#signin?error=${e instanceof OAuthError ? "failed" : "unavailable"}`, clearOauthCookie());
        }
      }
    }

    // ---------------- everything below needs a session ----------------
    const s = await currentSession(cfg, req);
    if (!s) return json({ ok: false, error: "Sign in first." }, 401);
    const u = s.user;

    if (p === "/api/auth/verify/resend" && m === "POST") {
      if (u.emailVerified) return json({ ok: true, already: true });
      await limit(cfg, req, "verify_resend", 3);
      return json({ ok: await sendVerification(cfg, users, u) });
    }

    if (p === "/api/auth/password" && m === "POST") {
      const b = await body(req);
      const current = str(b?.current, 400), next = str(b?.password, 400);
      await limit(cfg, req, "password", 20);
      if (u.hasPassword && !(await users.vault.verifyPassword(current, u.passwordHash))) {
        await users.recordFailedLogin(u);
        return json({ ok: false, error: "Your current password isn't right.", field: "current" }, 400);
      }
      const problem = passwordProblem(next, u.email);
      if (problem) return json({ ok: false, error: problem, field: "password" }, 400);
      if (u.hasPassword && current === next) return json({ ok: false, error: "Pick a password you haven't used here.", field: "password" }, 400);
      await users.setPassword(u.id, next);
      await users.endAllSessions(u.id, s.idHash);
      await notifyPasswordChanged(cfg, u);
      return json({ ok: true, me: await meView(cfg, users, (await users.byId(u.id))!) });
    }

    if (p === "/api/account" && m === "GET") {
      return json({ ok: true, account: await accountView(cfg, users, u) });
    }

    if (p === "/api/account" && m === "PUT") {
      const b = await body(req);
      if (!b) return json({ ok: false, error: "Bad request." }, 400);
      const name = str(b.name, 60).replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
      await users.setName(u.id, name || null);
      return json({ ok: true, account: await accountView(cfg, users, (await users.byId(u.id))!) });
    }

    if (p === "/api/account/alerts" && m === "PUT") {
      // Basic alerts are free. Destination and nonstop filters are Pro.
      const pro = entitled(u);
      const b = await body(req);
      const origins = Array.isArray(b?.origins)
        ? [...new Set((b!.origins as unknown[]).map((o) => String(o).toUpperCase()))].filter((o) => cfg.origins.includes(o)) : [];
      if (!origins.length) return json({ ok: false, error: "Pick at least one home airport." }, 400);
      // Destinations: "everywhere" (or missing) means all; otherwise a list of airports we cover.
      let destinations: string[] | null = null;
      if (pro && Array.isArray(b?.destinations)) {
        const known = new Set([...cfg.domestic, ...cfg.international]);
        destinations = [...new Set((b!.destinations as unknown[]).map((d) => String(d).toUpperCase()))].filter((d) => known.has(d));
        if (!destinations.length) return json({ ok: false, error: "Pick at least one place, or choose Everywhere.", field: "destinations" }, 400);
      }
      await users.setAlerts(u.id, b?.on !== false, origins);
      await users.setAlertPrefs(u.id, destinations, pro && b?.nonstop_only === true);
      return json({ ok: true, account: await accountView(cfg, users, (await users.byId(u.id))!) });
    }

    if (p === "/api/account/feedback" && m === "POST") {
      return submitFeedback(cfg, users, u, req, (to, msg) => sendMail(cfg, to, msg));
    }

    if (p === "/api/account/pro-waitlist" && m === "PUT") {
      const b = await body(req);
      await users.setWaitlist(u.id, b?.on !== false);
      return json({ ok: true, pro_waitlist: b?.on !== false });
    }

    if (p.startsWith("/api/admin/")) {
      if (u.role !== "admin" || u.mustChangePassword) return json({ ok: false, error: "Admins only." }, 403);
      if (p.startsWith("/api/admin/media")) return mediaRoute(req, new URL(req.url), cfg, u);
      if (p.startsWith("/api/admin/feedback")) return adminFeedback(cfg, users, req, p, m);
      return adminRoute(req, p, m, users);
    }

    if (p === "/api/account/rules") {
      if (!entitled(u)) return paywall();
      if (m === "GET") return json({ ok: true, ...rulesView(cfg, u) });
      if (m === "DELETE") {
        await users.setRules(u.id, null);
        return json({ ok: true, ...rulesView(cfg, (await users.byId(u.id))!) });
      }
      if (m === "PUT") {
        const b = await body(req);
        const dom = validateCat(b?.domestic), intl = validateCat(b?.international);
        if (!dom.ok || !intl.ok) {
          return json({ ok: false, error: "Some values need fixing.", fields: {
            domestic: dom.ok ? {} : dom.errors, international: intl.ok ? {} : intl.errors } }, 400);
        }
        await users.setRules(u.id, { domestic: toRaw(dom.rules), international: toRaw(intl.rules) });
        return json({ ok: true, ...rulesView(cfg, (await users.byId(u.id))!) });
      }
    }

    if (p === "/api/account/export" && m === "GET") {
      await limit(cfg, req, "export", 10);
      return json(await users.export(u), 200, {
        "Content-Disposition": `attachment; filename="fare-radar-account-${new Date().toISOString().slice(0, 10)}.json"`,
      });
    }

    if (p === "/api/account/signout-all" && m === "POST") {
      await users.endAllSessions(u.id);
      return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
    }

    if (p === "/api/account/delete" && m === "POST") {
      const b = await body(req);
      if (b?.confirm !== "DELETE") return json({ ok: false, error: "Type DELETE to confirm.", field: "confirm" }, 400);
      if (u.role === "admin") return json({ ok: false, error: "Admin accounts can't be deleted here." }, 400);
      if (u.hasPassword && !(await users.vault.verifyPassword(str(b?.password, 400), u.passwordHash))) {
        await users.recordFailedLogin(u);
        return json({ ok: false, error: "That password isn't right.", field: "password" }, 400);
      }
      try { await cancelSubscriptionNow(cfg, u); } catch (e) {
        console.error("cancel on delete failed", (e as Error).message);
        return json({ ok: false, error: "We couldn't cancel your subscription, so nothing was deleted. Try again, or cancel it in Manage billing first." }, 502);
      }
      await users.delete(u.id);
      return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
    }

    return json({ ok: false, error: "Not found." }, 404);
  } catch (e) {
    if (e instanceof BudgetExceeded) return json({ ok: false, error: "Too many attempts. Try again later." }, 429);
    throw e;
  }
}

export const paywall = () => json({ ok: false, code: "subscription_required",
  error: "This is part of a Fare Radar membership ($8/month). Subscribe on your Account page to use it." }, 402);

function redirect(to: string, cookie?: string) {
  const h = new Headers({ Location: to, "Cache-Control": "no-store" });
  if (cookie) h.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers: h });
}

async function accountView(cfg: Config, users: UserStore, u: User) {
  return {
    ...(await meView(cfg, users, u)),
    alerts: { on: u.alertsOn, origins: u.origins, destinations: u.destinations, nonstop_only: u.nonstopOnly,
      last_sent_at: await users.lastAlertAt(u.id) },
    customized_rules: !!u.rules,
  };
}

function rulesView(cfg: Config, u: User) {
  const cats = personalCategories(cfg, u.rules);
  return {
    categories: { domestic: toRaw(cats.domestic), international: toRaw(cats.international) },
    defaults: { domestic: toRaw(cfg.cats.domestic), international: toRaw(cfg.cats.international) },
    summaries: { domestic: describe("domestic", cats.domestic), international: describe("international", cats.international) },
    customized: !!u.rules,
  };
}

/**
 * The account for a verified Google/Apple identity: the linked one, else the one with the same
 * (provider-verified) email, else a new one. Linking to an existing account whose email was never
 * verified also clears its password and sessions: whoever set that password may not own the inbox.
 */
/** The marketing source a visitor arrived with (set by the page from ?utm_source= or ?ref=). */
export function signupSource(req: Request): string | null {
  const v = (readCookie(req, "fr_src") ?? "").toLowerCase();
  return /^[a-z0-9_.-]{1,40}$/.test(v) ? v : null;
}

async function oauthUser(cfg: Config, users: UserStore, id: { provider: Provider; subject: string; email: string; name: string | null },
  source: string | null = null) {
  const linked = await users.byIdentity(id.provider, id.subject);
  if (linked) return linked;
  const existing = await users.byEmail(id.email);
  if (existing) {
    if (!existing.emailVerified) {
      await users.endAllSessions(existing.id);
      if (existing.hasPassword && existing.role !== "admin") {
        await cfg.env.DB.prepare("UPDATE users SET password_hash=NULL WHERE id=?").bind(existing.id).run();
      }
      await users.markVerified(existing.id);
    }
    await users.linkIdentity(id.provider, id.subject, existing.id);
    await promoteIfOwner(cfg, users, existing.id);
    return (await users.byId(existing.id))!;
  }
  const isOwner = cfg.contacts.find((c) => c.email && normalizeEmail(c.email) === id.email);
  const u = await users.create({ email: id.email, name: id.name, emailVerified: true, origins: cfg.origins, source,
    ...(isOwner ? { role: "admin" as const, contact: isOwner.name } : {}) });
  await users.linkIdentity(id.provider, id.subject, u.id);
  return u;
}

/** A verified account whose email is a configured owner's becomes that owner's admin account. */
async function promoteIfOwner(cfg: Config, users: UserStore, id: number) {
  const u = await users.byId(id);
  if (!u || !u.emailVerified) return;
  const owner = cfg.contacts.find((c) => c.email && normalizeEmail(c.email) === u.email);
  if (owner && (u.role !== "admin" || u.contact !== owner.name)) await users.setRole(u.id, "admin", owner.name);
}

/** What the admin panel may see about an account: no hashes, no billing ids. */
function adminView(u: User) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, email_verified: u.emailVerified,
    created_at: u.createdAt, last_login_at: u.lastLoginAt, subscription_status: u.subscriptionStatus,
    pro_waitlist: u.proWaitlist };
}

async function adminRoute(req: Request, p: string, m: string, users: UserStore): Promise<Response> {
  const url = new URL(req.url);
  if (p === "/api/admin/users" && m === "GET") {
    // Emails are stored encrypted, so lookups are by exact address (via the blind index).
    const email = (url.searchParams.get("email") ?? "").trim();
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "Enter the full email address." }, 400);
    const found = await users.byEmail(email);
    return json({ ok: true, user: found ? adminView(found) : null });
  }
  if (p === "/api/admin/testers" && m === "GET") {
    return json({ ok: true, testers: (await users.testers()).map(adminView), counts: await users.counts() });
  }
  if (p === "/api/admin/users/role" && m === "PUT") {
    const b = await body(req);
    const id = Number(b?.id);
    const role = b?.role;
    if (!Number.isInteger(id) || (role !== "tester" && role !== "member")) return json({ ok: false, error: "Bad request." }, 400);
    const target = await users.byId(id);
    if (!target) return json({ ok: false, error: "No such account." }, 404);
    if (target.role === "admin") return json({ ok: false, error: "Admin accounts can't be changed here." }, 400);
    await users.setRole(id, role, null);
    return json({ ok: true, user: adminView((await users.byId(id))!) });
  }
  return json({ ok: false, error: "Not found." }, 404);
}
