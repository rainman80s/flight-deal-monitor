/**
 * Accounts and sign-in, for owners and members alike.
 *
 *   POST /api/login           {email}: email a one-time sign-in link (same reply for every email)
 *   GET  /u/login             "Sign in" button page (mail scanners prefetch GETs, so GET never signs in)
 *   POST /u/login             uses the link once and sets the session cookie
 *   GET  /api/me              who's signed in: {signed_in, role: owner|member, ...}
 *   GET  /api/account         member: profile and alert settings
 *   PUT  /api/account         member: {name?, alerts?: {on, origins, domestic_max, international_max}}
 *   GET  /api/account/export  member: everything we hold, as a JSON download
 *   POST /api/account/signout-all   member: ends every session on every device
 *   POST /api/account/delete  member: {confirm: "DELETE"} deletes the account and its alerts
 *
 * Owners are the configured contacts; they book and edit the logic. Members are anyone
 * who proves they own an email address.
 */
import { AccountStore, alertView, type User } from "./accounts";
import type { Deps } from "./app";
import {
  claimLink, clearCookie, contactByEmail, currentSession, loginLink, memberLoginLink, memberSessionCookie,
  sameOrigin, sessionCookie, verifyLoginLink, verifyMemberLink,
} from "./auth";
import { Budget, BudgetExceeded, visitorLimit, visitorTag } from "./budget";
import type { Config } from "./config";
import { BRAND, button, fine, frameFor, layout, p as para, textFooter } from "./email";
import { escHtml, page } from "./html";
import { ResendEmailer } from "./notify";
import { ownerBooking } from "./owner";
import { EMAIL_RE, SubscriberStore } from "./subscribers";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json",
    "Cache-Control": "no-store", ...headers } });

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try { return await req.json() as Record<string, unknown>; } catch { return null; }
}

/** Sign-in emails the whole site may send per day, on top of the per-visitor limit. */
const LOGIN_EMAILS_PER_DAY = 300;

function signInEmail(cfg: Config, to: string, link: string, isNew: boolean) {
  const f = frameFor(cfg);
  const reason = `You're getting this because someone asked to sign in to ${BRAND} with ${to}.`;
  const heading = isNew ? "Finish creating your account" : "Welcome back";
  const lead = isNew
    ? "Tap below to create your Fare Radar account. You'll be able to set your airports and price limits and turn deal alerts on or off."
    : "Tap below to sign in to Fare Radar.";
  return {
    subject: isNew ? "Create your Fare Radar account" : "Your Fare Radar sign-in link",
    text: `${lead}\n${link}\n\nThe link works once, for 20 minutes. Didn't ask for this? Ignore it; nothing happens `
      + "without this link.\n" + textFooter(f, reason),
    html: layout(f, {
      preheader: "Your sign-in link. It works once, for 20 minutes.",
      eyebrow: isNew ? "New account" : "Sign in",
      heading,
      body: para(lead)
        + `<div style="margin:22px 0 4px">${button(link, isNew ? "Create my account" : "Sign in to Fare Radar")}</div>`
        + fine("The link works once, for 20 minutes. Didn't ask for this? Ignore it. Nothing happens without this link."),
      reason,
    }),
  };
}

const intIn = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null;
};

/** Validates alert settings from the Account page. Returns an error message or the clean values. */
export function cleanAlerts(cfg: Config, a: Record<string, unknown>) {
  const origins = Array.isArray(a.origins)
    ? [...new Set(a.origins.map((o) => String(o).toUpperCase()))].filter((o) => cfg.origins.includes(o)) : [];
  const on = a.on !== false;
  if (on && !origins.length) return { error: "Pick at least one home airport." };
  const dom = intIn(a.domestic_max ?? cfg.domesticMaxPrice, 20, cfg.domesticMaxPrice);
  const intl = intIn(a.international_max ?? cfg.internationalMaxPrice, 50, cfg.internationalMaxPrice);
  if (dom === null || intl === null) {
    return { error: `Limits go up to $${cfg.domesticMaxPrice} for US trips and $${cfg.internationalMaxPrice} abroad.` };
  }
  return { on, origins: origins.length ? origins : cfg.origins, dom, intl };
}

async function memberView(cfg: Config, u: User) {
  const sub = await new SubscriberStore(cfg.env.DB).byEmail(u.email);
  return {
    email: u.email, name: u.name, created_at: u.created_at,
    alerts: sub ? alertView(sub) : { on: false, origins: cfg.origins, domestic_max: cfg.domesticMaxPrice,
      international_max: cfg.internationalMaxPrice, since: null, last_emailed_at: null },
    limits: { domestic_max: cfg.domesticMaxPrice, international_max: cfg.internationalMaxPrice },
  };
}

export async function accountRoute(req: Request, url: URL, deps: Deps): Promise<Response | null> {
  const { cfg } = deps;
  const p = url.pathname;
  const accounts = new AccountStore(cfg.env.DB);

  if (p === "/api/me" && req.method === "GET") {
    const s = await currentSession(cfg, req);
    if (!s) return json({ signed_in: false });
    if (s.kind === "owner") {
      return json({ signed_in: true, role: "owner", name: s.contact.name, booking: await ownerBooking(cfg) });
    }
    const u = s.user;
    return json({ signed_in: true, role: "member", name: u.name || u.email.split("@")[0], email: u.email });
  }

  if (p === "/api/login" && req.method === "POST") {
    if (!sameOrigin(cfg, req)) return json({ ok: false, error: "Bad origin." }, 403);
    const b = await body(req);
    const email = String(b?.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "That email doesn't look right." }, 400);
    const tag = await visitorTag(String(cfg.env.LINK_SECRET ?? ""), req.headers.get("CF-Connecting-IP") ?? "local");
    try {
      await visitorLimit(cfg.env.DB, "login", tag, 5).take();
      await new Budget(cfg.env.DB, "login_email", LOGIN_EMAILS_PER_DAY, Number.MAX_SAFE_INTEGER).take();
    } catch (e) {
      if (e instanceof BudgetExceeded) return json({ ok: false, error: "Too many sign-in attempts. Try again tomorrow." }, 429);
      throw e;
    }
    const key = cfg.env.RESEND_API_KEY;
    if (typeof key !== "string" || !key) return json({ ok: false, error: "Email isn't set up on this site yet." }, 503);
    const owner = contactByEmail(cfg, email);
    const to = owner?.email ?? email;
    const link = owner ? await loginLink(cfg, owner) : await memberLoginLink(cfg, email);
    const isNew = !owner && !(await accounts.byEmail(email));
    try {
      await new ResendEmailer(key, String(cfg.env.EMAIL_FROM ?? cfg.emailFrom)).send(to, signInEmail(cfg, to, link, isNew));
    } catch (e) {
      console.error("sign-in email failed", e);
      return json({ ok: false, error: "We couldn't send the email. The site may only be able to email its owner "
        + "until a sending domain is set up." }, 502);
    }
    return json({ ok: true });
  }

  if (p === "/u/login" && (req.method === "GET" || req.method === "POST")) {
    const params = req.method === "POST" ? new URLSearchParams(await req.text()) : url.searchParams;
    const n = params.get("n") ?? "", m = params.get("m") ?? "", x = params.get("x") ?? "", t = params.get("t") ?? "";
    const owner = n ? await verifyLoginLink(cfg, n, x, t) : null;
    const memberOk = !n && m ? await verifyMemberLink(cfg, m, x, t) : false;
    const expired = () => page("Link expired", "<h2>That sign-in link has expired or was already used.</h2>"
      + "<p>Each link works once, for 20 minutes. Ask for a new one from the site.</p>", 403);
    if (!owner && !memberOk) return expired();
    if (req.method === "GET") {
      const hidden = ["n", "m", "x", "t"].filter((k) => params.get(k))
        .map((k) => `<input type=hidden name=${k} value="${escHtml(params.get(k) ?? "")}">`).join("");
      const who = owner ? owner.name.toLowerCase() : m;
      return page("Sign in", `<h2>Sign in to Fare Radar</h2><p>As <b>${escHtml(who)}</b>, on this device.</p>`
        + `<form method=post>${hidden}<button class=primary>Sign in</button></form>`);
    }
    if (!(await claimLink(cfg.env.DB, t, x))) return expired();
    if (owner) {
      return new Response(null, { status: 303, headers: { Location: "/#browse", "Set-Cookie": await sessionCookie(cfg, owner) } });
    }
    const { user, created } = await accounts.signIn(m);
    return new Response(null, { status: 303, headers: {
      Location: created ? "/#account?welcome" : "/#account", "Set-Cookie": await memberSessionCookie(cfg, user) } });
  }

  if (p.startsWith("/api/account")) {
    const s = await currentSession(cfg, req);
    if (!s) return json({ ok: false, error: "Sign in first." }, 401);
    if (s.kind !== "member") return json({ ok: false, error: "Owner accounts are managed in the site's settings." }, 400);
    const u = s.user;

    if (p === "/api/account" && req.method === "GET") return json({ ok: true, account: await memberView(cfg, u) });

    if (!["GET", "HEAD"].includes(req.method) && !sameOrigin(cfg, req)) return json({ ok: false, error: "Bad origin." }, 403);

    if (p === "/api/account" && req.method === "PUT") {
      const b = await body(req);
      if (!b) return json({ ok: false, error: "Bad request." }, 400);
      if ("name" in b) {
        const name = String(b.name ?? "").trim().slice(0, 60);
        await accounts.setName(u.id, name || null);
      }
      if (b.alerts && typeof b.alerts === "object") {
        const a = cleanAlerts(cfg, b.alerts as Record<string, unknown>);
        if ("error" in a) return json({ ok: false, error: a.error }, 400);
        await new SubscriberStore(cfg.env.DB).saveVerified(u.email, a.origins, a.dom, a.intl, a.on);
      }
      return json({ ok: true, account: await memberView(cfg, (await accounts.byId(u.id))!) });
    }

    if (p === "/api/account/export" && req.method === "GET") {
      return json(await accounts.export(u), 200, {
        "Content-Disposition": `attachment; filename="fare-radar-account-${new Date().toISOString().slice(0, 10)}.json"`,
      });
    }

    if (p === "/api/account/signout-all" && req.method === "POST") {
      await accounts.signOutEverywhere(u.id);
      return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
    }

    if (p === "/api/account/delete" && req.method === "POST") {
      const b = await body(req);
      if (b?.confirm !== "DELETE") return json({ ok: false, error: "Type DELETE to confirm." }, 400);
      await accounts.delete(u);
      return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
    }
    return json({ ok: false, error: "Not found." }, 404);
  }

  return null;
}
