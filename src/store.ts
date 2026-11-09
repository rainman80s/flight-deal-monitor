/** D1 storage: deals log, dedupe, responses, bookings. */
import { type Deal, type Fare, routeKey } from "./models";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

function randomCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

export class Store {
  constructor(private db: D1Database) {}

  // --- state ---
  async getState(key: string): Promise<string | null> {
    const r = await this.db.prepare("SELECT value FROM state WHERE key=?").bind(key).first<{ value: string }>();
    return r?.value ?? null;
  }

  async setState(key: string, value: string): Promise<void> {
    await this.db.prepare("INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(key, value).run();
  }

  /** Atomically take the next cycle number. */
  async nextCycle(): Promise<number> {
    await this.db.prepare("INSERT INTO state(key,value) VALUES('cycle','0') ON CONFLICT(key) DO NOTHING").run();
    const r = await this.db.prepare(
      "UPDATE state SET value = CAST(value AS INTEGER) + 1 WHERE key='cycle' RETURNING value",
    ).first<{ value: number | string }>();
    return Number(r!.value) - 1;
  }

  // --- deals ---
  async lastAlertedPrice(key: string): Promise<number | null> {
    const r = await this.db.prepare(
      "SELECT price FROM deals WHERE route_key=? AND alerted_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    ).bind(key).first<{ price: number }>();
    return r?.price ?? null;
  }

  async shouldAlert(f: Fare, realertDropPercent: number): Promise<boolean> {
    const last = await this.lastAlertedPrice(routeKey(f));
    return last === null || f.price <= last * (1 - realertDropPercent / 100);
  }

  async addDeal(f: Fare, meta: { typicalLow?: number; typicalHigh?: number; typicalMedian?: number;
                                 pingReason?: string | null } = {}): Promise<Deal> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await this.db.prepare(
        `INSERT OR IGNORE INTO deals(code,route_key,provider,origin,destination,depart_date,return_date,
          price,currency,airlines,outbound_stops,return_stops,offer_id,booking_url,is_fake,found_at,kind,dest_name,
          typical_low,typical_high,typical_median,ping_reason)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(randomCode(), routeKey(f), f.provider, f.origin, f.destination, f.departDate, f.returnDate,
        f.price, f.currency, JSON.stringify(f.airlines), f.outboundStops, f.returnStops, f.offerId,
        f.bookingUrl, f.isFake ? 1 : 0, nowIso(), f.kind ?? null, f.destName ?? null, meta.typicalLow ?? null,
        meta.typicalHigh ?? null, meta.typicalMedian ?? null, meta.pingReason ?? null).run();
      if (res.meta.changes === 1) return (await this.deal(Number(res.meta.last_row_id)))!;
    }
    throw new Error("could not allocate a unique deal code");
  }

  /** Was this exact trip saved in the last `hours` at this price or lower? (Avoids repeat rows.) */
  async recentlyShown(f: Fare, hours: number, now = new Date()): Promise<boolean> {
    const since = new Date(now.getTime() - hours * 3_600_000).toISOString().slice(0, 19) + "Z";
    const r = await this.db.prepare(
      "SELECT 1 FROM deals WHERE route_key=? AND found_at>? AND price<=? LIMIT 1",
    ).bind(routeKey(f), since, f.price).first();
    return r !== null;
  }

  async markAlerted(id: number): Promise<void> {
    await this.db.prepare("UPDATE deals SET alerted_at=? WHERE id=?").bind(nowIso(), id).run();
  }

  deal(id: number): Promise<Deal | null> {
    return this.db.prepare("SELECT * FROM deals WHERE id=?").bind(id).first<Deal>();
  }

  dealByCode(code: string): Promise<Deal | null> {
    return this.db.prepare("SELECT * FROM deals WHERE code=?").bind(code.toUpperCase()).first<Deal>();
  }

  async recentDeals(limit = 20): Promise<Deal[]> {
    const r = await this.db.prepare("SELECT * FROM deals ORDER BY id DESC LIMIT ?").bind(limit).all<Deal>();
    return r.results;
  }

  // --- responses ---
  async addResponse(dealId: number, contact: string, answer: string, channel: string): Promise<void> {
    await this.db.prepare("INSERT INTO responses(deal_id,contact,answer,channel,at) VALUES(?,?,?,?,?)")
      .bind(dealId, contact, answer, channel, nowIso()).run();
  }

  async latestResponse(dealId: number, contact: string): Promise<string | null> {
    const r = await this.db.prepare(
      "SELECT answer FROM responses WHERE deal_id=? AND contact=? ORDER BY id DESC LIMIT 1",
    ).bind(dealId, contact).first<{ answer: string }>();
    return r?.answer ?? null;
  }

  // --- bookings ---
  /** Reserve the (deal, traveler) slot; false if it already exists, so nothing double-books. */
  async claimBooking(dealId: number, traveler: string): Promise<boolean> {
    const r = await this.db.prepare(
      "INSERT OR IGNORE INTO bookings(deal_id,traveler,status,at) VALUES(?,?,'pending',?)",
    ).bind(dealId, traveler, nowIso()).run();
    return r.meta.changes === 1;
  }

  async finishBooking(dealId: number, traveler: string, status: string, o: {
    amount?: number; currency?: string; orderId?: string; reference?: string; detail?: string;
  } = {}): Promise<void> {
    await this.db.prepare(
      `UPDATE bookings SET status=?,amount=?,currency=?,provider_order_id=?,booking_reference=?,detail=?,at=?
       WHERE deal_id=? AND traveler=?`,
    ).bind(status, o.amount ?? null, o.currency ?? null, o.orderId ?? null, o.reference ?? null,
      o.detail ?? null, nowIso(), dealId, traveler).run();
  }

  /** Remove a claim that never reached the airline, so it can be retried. */
  async releaseBooking(dealId: number, traveler: string): Promise<void> {
    await this.db.prepare("DELETE FROM bookings WHERE deal_id=? AND traveler=? AND status='pending'")
      .bind(dealId, traveler).run();
  }

  /** Total booked on a UTC calendar day. */
  async spentOn(day: string): Promise<number> {
    const r = await this.db.prepare(
      `SELECT
         (SELECT COALESCE(SUM(amount),0) FROM bookings WHERE status='booked' AND substr(at,1,10)=?1)
       + (SELECT COALESCE(SUM(amount),0) FROM orders WHERE status IN ('booked','pending') AND test_mode=0
            AND substr(created_at,1,10)=?1) AS s`,
    ).bind(day).first<{ s: number }>();
    return Number(r?.s ?? 0);
  }

  async bookings(limit = 20): Promise<Record<string, unknown>[]> {
    const r = await this.db.prepare("SELECT * FROM bookings ORDER BY id DESC LIMIT ?").bind(limit).all();
    return r.results as Record<string, unknown>[];
  }
}
