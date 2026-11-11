/**
 * Member accounts. Anyone who proves they own an email (by tapping a sign-in link) gets one.
 * Alert settings live in the subscribers table under the same email, so an account and an
 * alert sign-up are the same person seen two ways.
 */
import { type Subscriber, SubscriberStore } from "./subscribers";

export interface User {
  id: number;
  email: string;
  name: string | null;
  created_at: string;
  last_login_at: string | null;
  session_version: number;
}

const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

export class AccountStore {
  constructor(private db: D1Database) {}

  byId(id: number) {
    return this.db.prepare("SELECT * FROM users WHERE id=?").bind(id).first<User>();
  }

  byEmail(email: string) {
    return this.db.prepare("SELECT * FROM users WHERE email=?").bind(email.trim().toLowerCase()).first<User>();
  }

  /** The account for a verified email, created if new. `created` says which. */
  async signIn(email: string): Promise<{ user: User; created: boolean }> {
    const e = email.trim().toLowerCase();
    const r = await this.db.prepare("INSERT INTO users(email,created_at,last_login_at) VALUES(?,?,?) ON CONFLICT(email) DO NOTHING")
      .bind(e, nowIso(), nowIso()).run();
    const created = (r.meta?.changes ?? 0) > 0;
    if (!created) await this.db.prepare("UPDATE users SET last_login_at=? WHERE email=?").bind(nowIso(), e).run();
    return { user: (await this.byEmail(e))!, created };
  }

  async setName(id: number, name: string | null) {
    await this.db.prepare("UPDATE users SET name=? WHERE id=?").bind(name, id).run();
  }

  /** Invalidates every session for this account. */
  async signOutEverywhere(id: number) {
    await this.db.prepare("UPDATE users SET session_version=session_version+1 WHERE id=?").bind(id).run();
  }

  /** Everything we hold about this person, for "Download my data". */
  async export(u: User) {
    const sub = await new SubscriberStore(this.db).byEmail(u.email);
    return {
      exported_at: nowIso(),
      account: { email: u.email, name: u.name, created_at: u.created_at, last_login_at: u.last_login_at },
      deal_alerts: sub ? alertView(sub) : null,
    };
  }

  /** Deletes the account and its alert settings completely. */
  async delete(u: User) {
    // Account last, so a failure halfway leaves something the person can still sign in and delete.
    await this.db.prepare("DELETE FROM subscribers WHERE email=?").bind(u.email).run();
    await this.db.prepare("DELETE FROM users WHERE id=?").bind(u.id).run();
  }
}

export function alertView(s: Subscriber) {
  return {
    on: s.status === "active",
    origins: JSON.parse(s.origins) as string[],
    domestic_max: s.domestic_max,
    international_max: s.international_max,
    since: s.confirmed_at,
    last_emailed_at: s.last_emailed_at,
  };
}
