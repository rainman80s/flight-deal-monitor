/**
 * Accounts, sessions, one-time email tokens and linked Google/Apple identities.
 *
 * Rows hold only ciphertext and hashes (see crypto.ts and migration 0009); this module is the
 * one place that turns them back into a User. Nothing outside it should read the users table.
 */
import { type Config } from "./config";
import { normalizeEmail, randomToken, sha256, Vault } from "./crypto";

/** admin: owners. tester: beta testers with every Pro feature but no site controls. */
export type Role = "member" | "tester" | "admin";

interface Row {
  id: number; email_index: string; email_enc: string; name_enc: string | null; password_hash: string | null;
  role: Role; contact: string | null; email_verified: number; must_change_password: number;
  failed_logins: number; locked_until: number; created_at: string; last_login_at: string | null;
  password_changed_at: string | null; stripe_customer_id: string | null; subscription_id: string | null;
  subscription_status: string | null; current_period_end: number | null; cancel_at_period_end: number;
  alerts_on: number; origins: string; rules: string | null; destinations: string | null; nonstop_only: number;
  pro_waitlist: number;
}

export interface User {
  id: number;
  email: string;
  name: string | null;
  role: Role;
  contact: string | null;
  emailVerified: boolean;
  mustChangePassword: boolean;
  hasPassword: boolean;
  passwordHash: string | null;
  failedLogins: number;
  lockedUntil: number;
  createdAt: string;
  lastLoginAt: string | null;
  stripeCustomerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  alertsOn: boolean;
  origins: string[];
  rules: unknown | null;
  /** Airport codes to get alerts for; null means everywhere. */
  destinations: string[] | null;
  nonstopOnly: boolean;
  /** Asked to hear when Pro launches. */
  proWaitlist: boolean;
}

export const SESSION_DAYS = 30;
const SESSION_IDLE_DAYS = 14;
const nowSec = () => Math.floor(Date.now() / 1000);
const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

export const vaultFor = (cfg: Config) => new Vault(String(cfg.env.LINK_SECRET ?? ""));

/** Pro features: admins and beta testers always; members with a live subscription. */
export function entitled(u: User | null | undefined, now = nowSec()): boolean {
  if (!u) return false;
  if (u.role === "admin" || u.role === "tester") return true;
  const s = u.subscriptionStatus;
  if (s === "active" || s === "trialing") return true;
  // Stripe retries failed renewals for a while; keep access until the paid period runs out.
  return s === "past_due" && (u.currentPeriodEnd ?? 0) > now;
}

export class UserStore {
  readonly vault: Vault;
  constructor(private db: D1Database, vault: Vault) { this.vault = vault; }

  static for(cfg: Config) { return new UserStore(cfg.env.DB, vaultFor(cfg)); }

  private async view(r: Row | null): Promise<User | null> {
    if (!r) return null;
    return {
      id: r.id,
      email: await this.vault.open("email", r.email_enc),
      name: r.name_enc ? await this.vault.open("name", r.name_enc) : null,
      role: r.role === "admin" || r.role === "tester" ? r.role : "member",
      contact: r.contact,
      emailVerified: !!r.email_verified,
      mustChangePassword: !!r.must_change_password,
      hasPassword: !!r.password_hash,
      passwordHash: r.password_hash,
      failedLogins: r.failed_logins,
      lockedUntil: r.locked_until,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      stripeCustomerId: r.stripe_customer_id,
      subscriptionId: r.subscription_id,
      subscriptionStatus: r.subscription_status,
      currentPeriodEnd: r.current_period_end,
      cancelAtPeriodEnd: !!r.cancel_at_period_end,
      alertsOn: !!r.alerts_on,
      origins: safeJson(r.origins, ["SEA", "PDX"]) as string[],
      rules: r.rules ? safeJson(r.rules, null) : null,
      destinations: r.destinations ? safeJson(r.destinations, null) as string[] | null : null,
      nonstopOnly: !!r.nonstop_only,
      proWaitlist: !!r.pro_waitlist,
    };
  }

  async byId(id: number) {
    return this.view(await this.db.prepare("SELECT * FROM users WHERE id=?").bind(id).first<Row>());
  }

  async byEmail(email: string) {
    const idx = await this.vault.emailIndex(email);
    return this.view(await this.db.prepare("SELECT * FROM users WHERE email_index=?").bind(idx).first<Row>());
  }

  async byStripeCustomer(customerId: string) {
    return this.view(await this.db.prepare("SELECT * FROM users WHERE stripe_customer_id=?").bind(customerId).first<Row>());
  }

  /** Every user who should get alerts (alerts on). Entitlement is checked by the caller. */
  async withAlertsOn(): Promise<User[]> {
    const r = await this.db.prepare("SELECT * FROM users WHERE alerts_on=1").all<Row>();
    return (await Promise.all(r.results.map((x) => this.view(x)))).filter((u): u is User => !!u);
  }

  async create(o: { email: string; password?: string | null; name?: string | null; role?: Role; contact?: string | null;
                    emailVerified?: boolean; mustChangePassword?: boolean; origins?: string[]; source?: string | null }): Promise<User> {
    const email = normalizeEmail(o.email);
    await this.db.prepare(
      `INSERT INTO users(email_index,email_enc,name_enc,password_hash,role,contact,email_verified,must_change_password,
         created_at,password_changed_at,origins,signup_source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      await this.vault.emailIndex(email), await this.vault.seal("email", email),
      o.name ? await this.vault.seal("name", o.name) : null,
      o.password ? await this.vault.hashPassword(o.password) : null,
      o.role ?? "member", o.contact ?? null, o.emailVerified ? 1 : 0, o.mustChangePassword ? 1 : 0,
      nowIso(), o.password ? nowIso() : null, JSON.stringify(o.origins ?? ["SEA", "PDX"]), o.source ?? null,
    ).run();
    return (await this.byEmail(email))!;
  }

  // ---------------- sign-in bookkeeping ----------------

  async recordFailedLogin(u: User) {
    const failures = u.failedLogins + 1;
    // After 5 misses, lock for 1 minute, doubling each further miss up to 1 hour.
    const lock = failures >= 5 ? nowSec() + Math.min(3600, 60 * 2 ** (failures - 5)) : 0;
    await this.db.prepare("UPDATE users SET failed_logins=?, locked_until=? WHERE id=?").bind(failures, lock, u.id).run();
  }

  async recordLogin(id: number) {
    await this.db.prepare("UPDATE users SET failed_logins=0, locked_until=0, last_login_at=? WHERE id=?")
      .bind(nowIso(), id).run();
  }

  async setPassword(id: number, password: string, mustChange = false) {
    await this.db.prepare("UPDATE users SET password_hash=?, must_change_password=?, password_changed_at=?, failed_logins=0, locked_until=0 WHERE id=?")
      .bind(await this.vault.hashPassword(password), mustChange ? 1 : 0, nowIso(), id).run();
  }

  async setName(id: number, name: string | null) {
    await this.db.prepare("UPDATE users SET name_enc=? WHERE id=?")
      .bind(name ? await this.vault.seal("name", name) : null, id).run();
  }

  async markVerified(id: number) {
    await this.db.prepare("UPDATE users SET email_verified=1 WHERE id=?").bind(id).run();
  }

  async setRole(id: number, role: Role, contact: string | null) {
    await this.db.prepare("UPDATE users SET role=?, contact=? WHERE id=?").bind(role, contact, id).run();
  }

  // ---------------- personal settings ----------------

  async setAlerts(id: number, on: boolean, origins: string[]) {
    await this.db.prepare("UPDATE users SET alerts_on=?, origins=? WHERE id=?").bind(on ? 1 : 0, JSON.stringify(origins), id).run();
  }

  async setAlertPrefs(id: number, destinations: string[] | null, nonstopOnly: boolean) {
    await this.db.prepare("UPDATE users SET destinations=?, nonstop_only=? WHERE id=?")
      .bind(destinations ? JSON.stringify(destinations) : null, nonstopOnly ? 1 : 0, id).run();
  }

  async setWaitlist(id: number, on: boolean) {
    await this.db.prepare("UPDATE users SET pro_waitlist=? WHERE id=?").bind(on ? 1 : 0, id).run();
  }

  /** Beta testers, newest first (for the admin panel). */
  async testers(): Promise<User[]> {
    const r = await this.db.prepare("SELECT * FROM users WHERE role='tester' ORDER BY id DESC LIMIT 200").all<Row>();
    return (await Promise.all(r.results.map((x) => this.view(x)))).filter((u): u is User => !!u);
  }

  async counts() {
    const r = await this.db.prepare(`SELECT COUNT(*) AS users, SUM(pro_waitlist) AS waitlist,
      SUM(role='tester') AS testers, SUM(subscription_status IN ('active','trialing')) AS paying FROM users`).first<Record<string, number | null>>();
    const src = await this.db.prepare(`SELECT COALESCE(signup_source, 'direct') AS source, COUNT(*) AS n FROM users
      WHERE role != 'admin' GROUP BY 1 ORDER BY n DESC LIMIT 12`).all<{ source: string; n: number }>();
    return { users: r?.users ?? 0, waitlist: r?.waitlist ?? 0, testers: r?.testers ?? 0, paying: r?.paying ?? 0,
      sources: src.results };
  }

  async setRules(id: number, rules: unknown | null) {
    await this.db.prepare("UPDATE users SET rules=? WHERE id=?").bind(rules ? JSON.stringify(rules) : null, id).run();
  }

  // ---------------- billing ----------------

  async setStripeCustomer(id: number, customerId: string) {
    await this.db.prepare("UPDATE users SET stripe_customer_id=? WHERE id=?").bind(customerId, id).run();
  }

  async setSubscription(id: number, s: { id: string | null; status: string | null; periodEnd: number | null; cancelAtPeriodEnd: boolean }) {
    await this.db.prepare(
      "UPDATE users SET subscription_id=?, subscription_status=?, current_period_end=?, cancel_at_period_end=? WHERE id=?",
    ).bind(s.id, s.status, s.periodEnd, s.cancelAtPeriodEnd ? 1 : 0, id).run();
  }

  // ---------------- sessions ----------------

  /** Starts a session. Returns the raw token for the cookie; only its hash is stored. */
  async createSession(userId: number, userAgent: string | null): Promise<string> {
    const token = randomToken();
    const now = nowSec();
    await this.db.prepare("INSERT INTO sessions(id_hash,user_id,created_at,expires_at,last_seen_at,user_agent) VALUES(?,?,?,?,?,?)")
      .bind(await sha256(token), userId, now, now + SESSION_DAYS * 86400, now, (userAgent ?? "").slice(0, 160)).run();
    return token;
  }

  /** The user behind a session token, if it's valid and not idle too long. */
  async sessionUser(token: string): Promise<{ user: User; idHash: string } | null> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
    const idHash = await sha256(token);
    const s = await this.db.prepare("SELECT * FROM sessions WHERE id_hash=?").bind(idHash)
      .first<{ user_id: number; expires_at: number; last_seen_at: number }>();
    const now = nowSec();
    if (!s || s.expires_at < now || s.last_seen_at < now - SESSION_IDLE_DAYS * 86400) {
      if (s) await this.db.prepare("DELETE FROM sessions WHERE id_hash=?").bind(idHash).run();
      return null;
    }
    if (now - s.last_seen_at > 3600) {
      await this.db.prepare("UPDATE sessions SET last_seen_at=? WHERE id_hash=?").bind(now, idHash).run();
    }
    const user = await this.byId(s.user_id);
    return user ? { user, idHash } : null;
  }

  async endSession(idHash: string) {
    await this.db.prepare("DELETE FROM sessions WHERE id_hash=?").bind(idHash).run();
  }

  /** Signs out every device, optionally keeping one session (the one making the change). */
  async endAllSessions(userId: number, keepIdHash?: string) {
    await this.db.prepare("DELETE FROM sessions WHERE user_id=? AND id_hash != ?").bind(userId, keepIdHash ?? "").run();
  }

  async sessionCount(userId: number): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND expires_at>?")
      .bind(userId, nowSec()).first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  // ---------------- one-time email tokens ----------------

  async issueToken(userId: number, purpose: "verify" | "reset", minutes: number): Promise<string> {
    // Only the newest link of each kind works.
    await this.db.prepare("DELETE FROM auth_tokens WHERE user_id=? AND purpose=?").bind(userId, purpose).run();
    const token = randomToken();
    await this.db.prepare("INSERT INTO auth_tokens(token_hash,user_id,purpose,expires_at) VALUES(?,?,?,?)")
      .bind(await sha256(token), userId, purpose, nowSec() + minutes * 60).run();
    return token;
  }

  /** Uses a token once. Returns the user id, or null if it's unknown, expired or already used. */
  async consumeToken(token: string, purpose: "verify" | "reset"): Promise<number | null> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
    const r = await this.db.prepare(
      "UPDATE auth_tokens SET used_at=? WHERE token_hash=? AND purpose=? AND used_at IS NULL AND expires_at>? RETURNING user_id",
    ).bind(nowSec(), await sha256(token), purpose, nowSec()).first<{ user_id: number }>();
    return r?.user_id ?? null;
  }

  /** Checks a token without using it (to show the right page before the form is submitted). */
  async peekToken(token: string, purpose: "verify" | "reset"): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return false;
    const r = await this.db.prepare("SELECT 1 AS ok FROM auth_tokens WHERE token_hash=? AND purpose=? AND used_at IS NULL AND expires_at>?")
      .bind(await sha256(token), purpose, nowSec()).first<{ ok: number }>();
    return !!r;
  }

  // ---------------- Google / Apple ----------------

  async byIdentity(provider: string, subject: string) {
    const r = await this.db.prepare("SELECT user_id FROM identities WHERE provider=? AND subject=?")
      .bind(provider, subject).first<{ user_id: number }>();
    return r ? this.byId(r.user_id) : null;
  }

  async linkIdentity(provider: string, subject: string, userId: number) {
    await this.db.prepare("INSERT INTO identities(provider,subject,user_id,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING")
      .bind(provider, subject, userId, nowIso()).run();
  }

  async identities(userId: number): Promise<string[]> {
    const r = await this.db.prepare("SELECT provider FROM identities WHERE user_id=?").bind(userId).all<{ provider: string }>();
    return r.results.map((x) => x.provider);
  }

  // ---------------- alerts bookkeeping ----------------

  /** Records that this user was emailed about this deal. False if they already were. */
  async claimAlert(userId: number, dealId: number): Promise<boolean> {
    const r = await this.db.prepare("INSERT INTO user_alerts(user_id,deal_id,sent_at) VALUES(?,?,?) ON CONFLICT DO NOTHING")
      .bind(userId, dealId, nowIso()).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async alertsSince(userId: number, sinceIso: string): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM user_alerts WHERE user_id=? AND sent_at>?")
      .bind(userId, sinceIso).first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async lastAlertAt(userId: number): Promise<string | null> {
    const r = await this.db.prepare("SELECT MAX(sent_at) AS t FROM user_alerts WHERE user_id=?").bind(userId).first<{ t: string | null }>();
    return r?.t ?? null;
  }

  // ---------------- your data ----------------

  async export(u: User) {
    return {
      exported_at: nowIso(),
      account: { email: u.email, name: u.name, role: u.role, email_verified: u.emailVerified,
        created_at: u.createdAt, last_login_at: u.lastLoginAt, sign_in_methods: [
          ...(u.hasPassword ? ["password"] : []), ...(await this.identities(u.id))] },
      subscription: { status: u.subscriptionStatus, current_period_end: u.currentPeriodEnd
        ? new Date(u.currentPeriodEnd * 1000).toISOString() : null, cancel_at_period_end: u.cancelAtPeriodEnd },
      alerts: { on: u.alertsOn, origins: u.origins, destinations: u.destinations ?? "everywhere", nonstop_only: u.nonstopOnly,
        last_sent_at: await this.lastAlertAt(u.id) },
      personal_rules: u.rules,
      active_sessions: await this.sessionCount(u.id),
    };
  }

  /** Deletes the account and everything tied to it. */
  async delete(id: number) {
    for (const t of ["sessions", "auth_tokens", "identities", "user_alerts"]) {
      await this.db.prepare(`DELETE FROM ${t} WHERE user_id=?`).bind(id).run();
    }
    await this.db.prepare("DELETE FROM users WHERE id=?").bind(id).run();
  }

  /** Deletes expired sessions and tokens (daily). */
  async prune() {
    const now = nowSec();
    await this.db.prepare("DELETE FROM sessions WHERE expires_at<? OR last_seen_at<?")
      .bind(now, now - SESSION_IDLE_DAYS * 86400).run();
    await this.db.prepare("DELETE FROM auth_tokens WHERE expires_at<?").bind(now).run();
  }
}

function safeJson(s: string, fallback: unknown) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * Makes sure each configured contact with an email (the owners) has an admin account.
 * New admin accounts get ADMIN_INITIAL_PASSWORD and must change it on first sign-in.
 * Existing accounts keep their password; only their role is (re)set to admin.
 */
export async function ensureAdmins(cfg: Config): Promise<string[]> {
  const users = UserStore.for(cfg);
  const initial = typeof cfg.env.ADMIN_INITIAL_PASSWORD === "string" ? cfg.env.ADMIN_INITIAL_PASSWORD : "";
  const made: string[] = [];
  for (const c of cfg.contacts.filter((x) => x.email)) {
    const existing = await users.byEmail(c.email);
    if (existing && !existing.emailVerified) {
      // Someone registered the owner's address without proving they own it. The owner takes it
      // back: their sessions end and the password becomes the configured starting one.
      if (!initial) continue;
      await users.endAllSessions(existing.id);
      await users.setPassword(existing.id, initial, true);
      await users.markVerified(existing.id);
      await users.setRole(existing.id, "admin", c.name);
      made.push(c.name);
      continue;
    }
    if (existing) {
      if (existing.role !== "admin" || existing.contact !== c.name) await users.setRole(existing.id, "admin", c.name);
      continue;
    }
    if (!initial) continue; // no starting password configured: they can't be created yet
    await users.create({ email: c.email, password: initial, role: "admin", contact: c.name,
      emailVerified: true, mustChangePassword: true });
    made.push(c.name);
  }
  return made;
}
