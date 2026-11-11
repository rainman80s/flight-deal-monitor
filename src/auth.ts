/**
 * Who is making this request.
 *
 * Sessions are server-side: the cookie holds a 256-bit random token, the database holds only its
 * SHA-256, so a database leak can't be replayed as a login and any session can be ended at once.
 *
 * Cookie: __Host-fr_session; Secure; HttpOnly; SameSite=Lax; Path=/ (the __Host- prefix means
 * browsers refuse it unless it's Secure, host-only and site-wide, which blocks subdomain tricks).
 *
 * Cross-site request forgery: every state-changing /api request must carry this site's Origin
 * (enforced centrally in app.ts), on top of SameSite=Lax.
 */
import { type Config, type Contact } from "./config";
import { SESSION_DAYS, type User, UserStore } from "./users";

export const SESSION_COOKIE = "__Host-fr_session";

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

export const sessionCookie = (token: string) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export interface Session { user: User; idHash: string }

/** The signed-in user for this request, if any. Cached per request. */
const cache = new WeakMap<Request, Promise<Session | null>>();
export function currentSession(cfg: Config, req: Request): Promise<Session | null> {
  let s = cache.get(req);
  if (!s) {
    const token = readCookie(req, SESSION_COOKIE);
    s = token && typeof cfg.env.LINK_SECRET === "string" && cfg.env.LINK_SECRET
      ? UserStore.for(cfg).sessionUser(token) : Promise.resolve(null);
    cache.set(req, s);
  }
  return s;
}

/**
 * The signed-in owner, as the configured contact they book as (RAN, BROCK), or null.
 * Only admins linked to a contact qualify; a password that still has to be changed doesn't count.
 */
export async function currentUser(cfg: Config, req: Request): Promise<Contact | null> {
  const s = await currentSession(cfg, req);
  if (!s || s.user.role !== "admin" || !s.user.contact || s.user.mustChangePassword) return null;
  return cfg.contacts.find((c) => c.name === s.user.contact) ?? null;
}

/** Same-origin check for state-changing requests (the browser's Origin must be this site). */
export function sameOrigin(cfg: Config, req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  const own = new URL(req.url).origin;
  const pub = typeof cfg.env.PUBLIC_BASE_URL === "string" ? new URL(cfg.env.PUBLIC_BASE_URL).origin : own;
  return origin === own || origin === pub;
}
