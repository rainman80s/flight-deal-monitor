/**
 * Sign-in for the website. Owners (configured contacts) can book and edit the logic;
 * members (anyone with a verified email) manage their own account and alerts.
 *
 *   POST /api/login {email}   -> if it's a contact's email, send a one-time sign-in link
 *                                (always the same reply, so it doesn't reveal who's a contact)
 *   GET  /u/login?e=&x=&t=    -> page with a "Sign in" button (GET never signs in; mail
 *                                scanners prefetch links)
 *   POST /u/login             -> sets a signed, HttpOnly session cookie for 30 days
 *   POST /api/logout          -> clears it
 *
 * Tokens are HMAC-SHA256 with LINK_SECRET. Sessions name a contact, not an email, so
 * removing someone from the contacts list signs them out.
 */
import { AccountStore, type User } from "./accounts";
import { type Config, type Contact, secret } from "./config";

const COOKIE = "fr_session";
const LINK_MINUTES = 20;
const SESSION_DAYS = 30;

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const linkSecret = (cfg: Config) => {
  const v = cfg.env.LINK_SECRET;
  return typeof v === "string" && v ? v : null;
};

export function contactByEmail(cfg: Config, email: string): Contact | undefined {
  const e = email.trim().toLowerCase();
  return e ? cfg.contacts.find((c) => c.email && c.email.toLowerCase() === e) : undefined;
}

/** One-time sign-in link for a contact, valid LINK_MINUTES. */
export async function loginLink(cfg: Config, c: Contact, now = Date.now()) {
  const exp = Math.floor(now / 1000) + LINK_MINUTES * 60;
  const t = await hmac(secret(cfg, "LINK_SECRET"), `login|${c.name}|${exp}`);
  const base = secret(cfg, "PUBLIC_BASE_URL").replace(/\/$/, "");
  return `${base}/u/login?n=${encodeURIComponent(c.name)}&x=${exp}&t=${t}`;
}

export async function verifyLoginLink(cfg: Config, name: string, exp: string, t: string, now = Date.now()) {
  const key = linkSecret(cfg);
  if (!key || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null;
  const c = cfg.contacts.find((x) => x.name === name);
  if (!c) return null;
  return safeEqual(await hmac(key, `login|${name}|${exp}`), t) ? c : null;
}

export async function sessionCookie(cfg: Config, c: Contact, now = Date.now()) {
  const exp = Math.floor(now / 1000) + SESSION_DAYS * 86400;
  const v = `${c.name}.${exp}.${await hmac(secret(cfg, "LINK_SECRET"), `session|${c.name}|${exp}`)}`;
  return `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** The verified subject of this request's session cookie (a contact name, or "u<id>v<version>"). */
async function sessionSubject(cfg: Config, req: Request, now: number): Promise<string | null> {
  const key = linkSecret(cfg);
  if (!key) return null;
  const raw = (req.headers.get("Cookie") ?? "").split(/;\s*/).find((p) => p.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [name, exp, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!name || !exp || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return null;
  return safeEqual(await hmac(key, `session|${name}|${exp}`), sig) ? name : null;
}

/** The signed-in owner (configured contact) for this request, if any. Members get null. */
export async function currentUser(cfg: Config, req: Request, now = Date.now()): Promise<Contact | null> {
  const name = await sessionSubject(cfg, req, now);
  return name ? cfg.contacts.find((c) => c.name === name) ?? null : null;
}

// ---------------- member accounts ----------------

export type Session = { kind: "owner"; contact: Contact } | { kind: "member"; user: User };

/** Whoever is signed in: an owner, a member, or nobody. */
export async function currentSession(cfg: Config, req: Request, now = Date.now()): Promise<Session | null> {
  const name = await sessionSubject(cfg, req, now);
  if (!name) return null;
  const m = /^u(\d+)v(\d+)$/.exec(name);
  if (m) {
    const user = await new AccountStore(cfg.env.DB).byId(Number(m[1]));
    // A deleted account, or one signed out everywhere since, doesn't count.
    return user && user.session_version === Number(m[2]) ? { kind: "member", user } : null;
  }
  const contact = cfg.contacts.find((c) => c.name === name);
  return contact ? { kind: "owner", contact } : null;
}

/** One-time sign-in link for any email; the account is created when it's used. */
export async function memberLoginLink(cfg: Config, email: string, now = Date.now()) {
  const e = email.trim().toLowerCase();
  const exp = Math.floor(now / 1000) + LINK_MINUTES * 60;
  const t = await hmac(secret(cfg, "LINK_SECRET"), `mlogin|${e}|${exp}`);
  const base = secret(cfg, "PUBLIC_BASE_URL").replace(/\/$/, "");
  return `${base}/u/login?m=${encodeURIComponent(e)}&x=${exp}&t=${t}`;
}

export async function verifyMemberLink(cfg: Config, email: string, exp: string, t: string, now = Date.now()) {
  const key = linkSecret(cfg);
  if (!key || !email || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return false;
  return safeEqual(await hmac(key, `mlogin|${email.trim().toLowerCase()}|${exp}`), t);
}

/** Marks a sign-in link as used. False if it already was, so each link works once. */
export async function claimLink(db: D1Database, sig: string, exp: string, now = Date.now()): Promise<boolean> {
  await db.prepare("DELETE FROM used_links WHERE expires_at < ?").bind(Math.floor(now / 1000)).run();
  const r = await db.prepare("INSERT INTO used_links(sig, expires_at) VALUES(?, ?) ON CONFLICT(sig) DO NOTHING")
    .bind(sig, Number(exp)).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function memberSessionCookie(cfg: Config, u: User, now = Date.now()) {
  const subject = `u${u.id}v${u.session_version}`;
  const exp = Math.floor(now / 1000) + SESSION_DAYS * 86400;
  const v = `${subject}.${exp}.${await hmac(secret(cfg, "LINK_SECRET"), `session|${subject}|${exp}`)}`;
  return `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

/**
 * Blocks cross-site requests to state-changing endpoints: the browser's Origin must be this
 * site. (SameSite=Lax cookies plus JSON bodies already make this hard; this is the backstop.)
 */
export function sameOrigin(cfg: Config, req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  const own = new URL(req.url).origin;
  const pub = typeof cfg.env.PUBLIC_BASE_URL === "string" ? new URL(cfg.env.PUBLIC_BASE_URL).origin : own;
  return origin === own || origin === pub;
}
