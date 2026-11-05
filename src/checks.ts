/** Saved calendar price checks: what was priced, when, and the cheapest fare seen. */

export interface CalendarDay { d: string; r: string | null; p: number | null }

export interface PriceCheck {
  id: number;
  origin: string;
  destination: string;
  window_start: string;
  window_days: number;
  stay_days: number;
  dates: string; // JSON CalendarDay[]
  cheapest: number | null;
  cheapest_date: string | null;
  price_limit: number | null;
  source: "scan" | "search";
  checked_at: string;
}

export interface NewCheck {
  origin: string; destination: string; windowStart: string; windowDays: number; stayDays: number;
  days: CalendarDay[]; limit: number | null; source: "scan" | "search";
}

const iso = (d: Date) => d.toISOString().slice(0, 19) + "Z";

export class CheckStore {
  constructor(private db: D1Database) {}

  async save(c: NewCheck, now = new Date()): Promise<void> {
    const priced = c.days.filter((x) => x.p !== null && x.p > 0);
    const cheapest = priced.reduce<CalendarDay | null>((m, x) => (!m || x.p! < m.p! ? x : m), null);
    await this.db.prepare(
      `INSERT INTO price_checks(origin,destination,window_start,window_days,stay_days,dates,cheapest,
         cheapest_date,price_limit,source,checked_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(c.origin, c.destination, c.windowStart, c.windowDays, c.stayDays, JSON.stringify(c.days),
      cheapest?.p ?? null, cheapest?.d ?? null, c.limit, c.source, iso(now)).run();
  }

  /** A saved check for exactly this search, if one is newer than maxAgeHours. */
  async fresh(origin: string, destination: string, windowStart: string, windowDays: number, stayDays: number,
              maxAgeHours: number, now = new Date()): Promise<PriceCheck | null> {
    const since = iso(new Date(now.getTime() - maxAgeHours * 3_600_000));
    return this.db.prepare(
      `SELECT * FROM price_checks WHERE origin=? AND destination=? AND window_start=? AND window_days=?
       AND stay_days=? AND checked_at>? ORDER BY id DESC LIMIT 1`,
    ).bind(origin, destination, windowStart, windowDays, stayDays, since).first<PriceCheck>();
  }

  /** Most recent background-scan checks, newest first. */
  async recent(limit = 20): Promise<PriceCheck[]> {
    const r = await this.db.prepare(
      "SELECT * FROM price_checks WHERE source='scan' ORDER BY id DESC LIMIT ?",
    ).bind(limit).all<PriceCheck>();
    return r.results;
  }

  async count(): Promise<number> {
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM price_checks WHERE source='scan'").first<{ n: number }>();
    return Number(r?.n ?? 0);
  }
}
