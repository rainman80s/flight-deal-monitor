/**
 * Website sign-ups: people who get deal emails matching their home airports and
 * price limits. Subscribers only ever get alerts with a Google Flights link;
 * buying (with the owner's Duffel balance) stays limited to the configured contacts.
 */
import { type Config, kindOf, secret } from "./config";
import { shortDate } from "./dates";
import { subscriberToken } from "./links";
import { city, destCity, tripDays } from "./messages";
import type { Deal } from "./models";
import type { Notifier } from "./notify";

export interface Subscriber {
  id: number;
  email: string;
  origins: string; // JSON
  domestic_max: number;
  international_max: number;
  status: "pending" | "active" | "unsubscribed";
  created_at: string;
  confirmed_at: string | null;
  last_emailed_at: string | null;
}

const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";
export const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[a-z]{2,}$/i;

export class SubscriberStore {
  constructor(private db: D1Database) {}

  byId(id: number) {
    return this.db.prepare("SELECT * FROM subscribers WHERE id=?").bind(id).first<Subscriber>();
  }

  byEmail(email: string) {
    return this.db.prepare("SELECT * FROM subscribers WHERE email=?").bind(email.toLowerCase()).first<Subscriber>();
  }

  /** Create or update a sign-up. Returns the row (status pending unless already active). */
  async upsert(email: string, origins: string[], domMax: number, intlMax: number): Promise<Subscriber> {
    const e = email.toLowerCase();
    await this.db.prepare(
      `INSERT INTO subscribers(email,origins,domestic_max,international_max,status,created_at)
       VALUES(?,?,?,?,'pending',?)
       ON CONFLICT(email) DO UPDATE SET origins=excluded.origins, domestic_max=excluded.domestic_max,
         international_max=excluded.international_max,
         status=CASE WHEN subscribers.status='active' THEN 'active' ELSE 'pending' END`,
    ).bind(e, JSON.stringify(origins), domMax, intlMax, nowIso()).run();
    return (await this.byEmail(e))!;
  }

  async setStatus(id: number, status: Subscriber["status"]) {
    const confirmed = status === "active" ? nowIso() : null;
    await this.db.prepare("UPDATE subscribers SET status=?, confirmed_at=COALESCE(?, confirmed_at) WHERE id=?")
      .bind(status, confirmed, id).run();
  }

  async markEmailed(id: number) {
    await this.db.prepare("UPDATE subscribers SET last_emailed_at=? WHERE id=?").bind(nowIso(), id).run();
  }

  /** Active subscribers whose airports and limits match this deal. */
  async matching(d: Deal, domestic: boolean): Promise<Subscriber[]> {
    const col = domestic ? "domestic_max" : "international_max";
    const r = await this.db.prepare(
      `SELECT * FROM subscribers WHERE status='active' AND ${col} > ?
       AND EXISTS (SELECT 1 FROM json_each(subscribers.origins) WHERE value = ?)`,
    ).bind(d.price, d.origin).all<Subscriber>();
    return r.results;
  }

  async counts(): Promise<{ active: number }> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE status='active'").first<{ n: number }>();
    return { active: Number(r?.n ?? 0) };
  }

  /** Records an attempt and says whether this IP is over the limit for the past hour. */
  async throttled(ip: string, perHour = 5): Promise<boolean> {
    const since = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19) + "Z";
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM signup_attempts WHERE ip=? AND at>?")
      .bind(ip, since).first<{ n: number }>();
    if (Number(r?.n ?? 0) >= perHour) return true;
    await this.db.prepare("INSERT INTO signup_attempts(ip,at) VALUES(?,?)").bind(ip, nowIso()).run();
    return false;
  }
}

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const wrap = (inner: string) =>
  `<div style="font-family:-apple-system,system-ui,sans-serif;max-width:520px;color:#1a1a1a;font-size:15px;line-height:1.55">${inner}</div>`;

const button = (href: string, label: string) =>
  `<a href="${escHtml(href)}" style="display:inline-block;padding:12px 28px;border-radius:999px;background:#0a84ff;`
  + `color:#fff;text-decoration:none;font-weight:600">${label}</a>`;

export async function subscriberLink(cfg: Config, s: Subscriber, purpose: "confirm" | "unsubscribe") {
  const base = secret(cfg, "PUBLIC_BASE_URL").replace(/\/$/, "");
  return `${base}/u/${purpose}?id=${s.id}&t=${await subscriberToken(cfg, s.id, purpose)}`;
}

export async function confirmationEmail(cfg: Config, s: Subscriber) {
  const url = await subscriberLink(cfg, s, "confirm");
  const origins = (JSON.parse(s.origins) as string[]).map(city).join(" and ");
  return {
    subject: "Confirm your flight deal alerts",
    text: `Confirm your flight deal alerts from ${origins}:\n${url}\n\nIf you didn't sign up, ignore this email.`,
    html: wrap(`<h2 style="margin:0 0 8px">One tap to confirm</h2>
<p>You asked for round-trip deal alerts from <b>${escHtml(origins)}</b>: domestic under
<b>$${s.domestic_max}</b>, international under <b>$${s.international_max}</b>.</p>
<p style="margin:22px 0">${button(url, "Confirm alerts")}</p>
<p style="color:#666;font-size:13px">If you didn't sign up, ignore this email and nothing will happen.</p>`),
  };
}

export async function subscriberDealEmail(cfg: Config, s: Subscriber, d: Deal) {
  const unsub = await subscriberLink(cfg, s, "unsubscribe");
  const kind = kindOf(cfg, d);
  const airlines = (JSON.parse(d.airlines) as string[]).join(", ");
  const subject = `✈ ${city(d.origin)} → ${destCity(d)} $${d.price.toFixed(0)} round trip, `
    + `${shortDate(d.depart_date)}–${shortDate(d.return_date)}`;
  const text = `${d.origin} → ${d.destination} (${destCity(d)}), $${d.price.toFixed(0)} round trip (${kind})\n`
    + `${shortDate(d.depart_date)} → ${shortDate(d.return_date)} (${tripDays(d)} days) · ${airlines}\n\n`
    + `Book: ${d.booking_url ?? ""}\n\nPrices move fast; check before you book.\nUnsubscribe: ${unsub}\n`;
  const html = wrap(`<h2 style="margin:0 0 4px">${escHtml(city(d.origin))} → ${escHtml(destCity(d))}</h2>
<p style="font-size:28px;font-weight:700;margin:4px 0">$${d.price.toFixed(0)}
 <span style="font-size:15px;font-weight:400;color:#555">round trip · ${kind}</span></p>
<p>${escHtml(shortDate(d.depart_date))} → ${escHtml(shortDate(d.return_date))} (${tripDays(d)} days) · ${escHtml(airlines)}</p>
${d.booking_url ? `<p style="margin:22px 0">${button(d.booking_url, "See it on Google Flights")}</p>` : ""}
<p style="color:#666;font-size:13px">Prices move fast; check before you book.
 <a href="${escHtml(unsub)}" style="color:#666">Unsubscribe</a></p>`);
  return { subject, text, html };
}

/** Email every matching subscriber about a real (not fake) deal. Returns how many were emailed. */
export async function notifySubscribers(cfg: Config, subs: SubscriberStore, notifier: Notifier, d: Deal) {
  if (d.is_fake || cfg.dryRun) return 0;
  const owners = new Set(cfg.contacts.map((c) => c.email.toLowerCase()).filter(Boolean));
  let n = 0;
  for (const s of await subs.matching(d, kindOf(cfg, d) === "domestic")) {
    if (owners.has(s.email)) continue; // owners already got the Buy/Skip version
    try {
      await notifier.email(s.email, await subscriberDealEmail(cfg, s, d));
      await subs.markEmailed(s.id);
      n++;
    } catch (e) { console.error(`subscriber email ${s.id} failed`, e); }
  }
  return n;
}
