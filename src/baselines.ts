/**
 * Learning what's normal for each route, so "good deal" can mean "cheap for this city"
 * (LA might always be $90-250 from Seattle while New York is $300-500).
 *
 * Every price the tool sees (calendar checks price ~31 dates each, Google Explore gives one
 * per destination, site searches add more) goes into price_obs. A route's baseline is the
 * spread of the last 60 days of observations: median, plus the 25th-75th percentile as the
 * "usual range". The same destination from SEA and PDX is pooled when one airport alone
 * doesn't have enough data, since prices to a city track closely across the two.
 */
import type { CalendarDay } from "./checks";
import { daysBetween } from "./dates";
import type { Fare } from "./models";

export interface Baseline { median: number; low: number; high: number; samples: number; pooled: boolean }

const WINDOW_DAYS = 60;
const KEEP_DAYS = 120;
const iso = (d: Date) => d.toISOString().slice(0, 19) + "Z";

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function summarize(prices: number[], pooled = false): Baseline | null {
  const s = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (!s.length) return null;
  return { median: Math.round(pct(s, 0.5)), low: Math.round(pct(s, 0.25)), high: Math.round(pct(s, 0.75)),
           samples: s.length, pooled };
}

export class PriceHistory {
  constructor(private db: D1Database) {}

  /** Save calendar prices (one row per priced date). */
  async recordCalendar(origin: string, destination: string, stayDays: number, days: CalendarDay[], source: string,
                       now = new Date()): Promise<void> {
    const rows = days.filter((d) => d.p !== null && d.p > 0);
    if (!rows.length) return;
    const at = iso(now);
    const stmt = this.db.prepare(
      "INSERT INTO price_obs(origin,destination,depart_date,trip_days,price,source,observed_at) VALUES(?,?,?,?,?,?,?)");
    const batch = rows.map((d) => stmt.bind(origin, destination, d.d, stayDays, d.p, source, at));
    await this.runBatch(batch);
  }

  /** Save individual fares (e.g. one per Google Explore destination). */
  async recordFares(fares: Fare[], source: string, now = new Date()): Promise<void> {
    if (!fares.length) return;
    const at = iso(now);
    const stmt = this.db.prepare(
      "INSERT INTO price_obs(origin,destination,depart_date,trip_days,price,source,observed_at) VALUES(?,?,?,?,?,?,?)");
    await this.runBatch(fares.map((f) => stmt.bind(f.origin, f.destination, f.departDate,
      daysBetween(f.departDate, f.returnDate), f.price, source, at)));
  }

  private async runBatch(stmts: D1PreparedStatement[]) {
    const db = this.db as D1Database & { batch?: (s: D1PreparedStatement[]) => Promise<unknown> };
    if (typeof db.batch === "function") await db.batch(stmts);
    else for (const s of stmts) await s.run();
  }

  /** The route's usual price, or null without enough data. */
  async baseline(origin: string, destination: string, minSamples: number, now = new Date()): Promise<Baseline | null> {
    const since = iso(new Date(now.getTime() - WINDOW_DAYS * 86_400_000));
    const own = await this.db.prepare(
      "SELECT price FROM price_obs WHERE destination=? AND origin=? AND observed_at>?",
    ).bind(destination, origin, since).all<{ price: number }>();
    const mine = own.results.map((r) => r.price);
    if (mine.length >= minSamples) return summarize(mine);
    const all = await this.db.prepare(
      "SELECT price FROM price_obs WHERE destination=? AND observed_at>?",
    ).bind(destination, since).all<{ price: number }>();
    const pooled = all.results.map((r) => r.price);
    return pooled.length >= minSamples ? summarize(pooled, true) : null;
  }

  /** Every route's baseline, for the Logic panel. */
  async all(now = new Date()): Promise<{ origin: string; destination: string; median: number; low: number; high: number;
                                         samples: number; last_seen: string }[]> {
    const since = iso(new Date(now.getTime() - WINDOW_DAYS * 86_400_000));
    const r = await this.db.prepare(
      "SELECT origin, destination, price, observed_at FROM price_obs WHERE observed_at>? ORDER BY destination, origin",
    ).bind(since).all<{ origin: string; destination: string; price: number; observed_at: string }>();
    const groups = new Map<string, { origin: string; destination: string; prices: number[]; last: string }>();
    for (const x of r.results) {
      const k = `${x.origin}-${x.destination}`;
      const g = groups.get(k) ?? { origin: x.origin, destination: x.destination, prices: [], last: x.observed_at };
      g.prices.push(x.price);
      if (x.observed_at > g.last) g.last = x.observed_at;
      groups.set(k, g);
    }
    return [...groups.values()].map((g) => ({ origin: g.origin, destination: g.destination, ...summarize(g.prices)!,
      last_seen: g.last }));
  }

  /** Drop observations older than KEEP_DAYS. */
  async prune(now = new Date()): Promise<void> {
    await this.db.prepare("DELETE FROM price_obs WHERE observed_at<?")
      .bind(iso(new Date(now.getTime() - KEEP_DAYS * 86_400_000))).run();
  }
}

/**
 * Should this fare ping? Returns a short reason when it should, null when it's only shown.
 *   smart: at least drop% below the route's median; without enough data, under `under`.
 *   under: under `under`.
 */
export function pingReason(price: number, rule: { mode: "smart" | "under"; under: number; dropPercent: number },
                           base: Baseline | null): string | null {
  if (rule.mode === "smart" && base) {
    const cutoff = base.median * (1 - rule.dropPercent / 100);
    if (price <= cutoff) {
      const off = Math.round((1 - price / base.median) * 100);
      return `${off}% below the usual $${base.median} for this route (usually $${base.low}-$${base.high})`;
    }
    return null;
  }
  if (price < rule.under) {
    return rule.mode === "smart" ? `under $${rule.under} (still learning this route's usual price)` : `under $${rule.under}`;
  }
  return null;
}
