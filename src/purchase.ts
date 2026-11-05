/**
 * Buying a specific Duffel offer from the website's booking sheet.
 *
 * Safety rails, in order (nothing is written before the checks that can refuse cheaply):
 *   1. dry_run blocks purchases; booking_enabled must be on.
 *   2. Every traveler must be a configured contact with details in TRAVELERS_JSON
 *      (plus passport details when the airline requires them).
 *   3. The offer is re-fetched from Duffel; refuse if the price rose more than
 *      max_price_increase_percent over what the buyer saw, or the passenger count differs.
 *   4. Daily spend cap (real money only; test-mode bookings don't count).
 *   5. One order per offer id, enforced by the database: a double click can't double-book.
 *   6. If Duffel errors during the purchase itself, the order is marked failed and never
 *      retried automatically, since it may have gone through.
 */
import { type Config, contactByName, type Contact, loadTravelers, type Traveler } from "./config";
import { utcDate } from "./dates";
import type { DuffelProvider } from "./duffel";
import { tell, type Notifier } from "./notify";
import type { Store } from "./store";

export interface BookRequest {
  offerId: string;
  travelers: string[];
  expectedTotal: number;
  origin: string; destination: string; departDate: string; returnDate: string;
}

export interface BookResult {
  ok: boolean;
  message: string;
  reference?: string;
  total?: number;
  currency?: string;
  test_mode?: boolean;
}

const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

class Orders {
  constructor(private db: D1Database) {}
  async claim(r: BookRequest, by: string, amount: number, currency: string, testMode: boolean) {
    const res = await this.db.prepare(
      `INSERT OR IGNORE INTO orders(offer_id,requested_by,travelers,origin,destination,depart_date,return_date,
         status,amount,currency,test_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?)`,
    ).bind(r.offerId, by, JSON.stringify(r.travelers), r.origin, r.destination, r.departDate, r.returnDate,
      amount, currency, testMode ? 1 : 0, nowIso(), nowIso()).run();
    return res.meta.changes === 1;
  }
  async finish(offerId: string, status: "booked" | "failed", o: { orderId?: string; reference?: string; detail?: string }) {
    await this.db.prepare(
      "UPDATE orders SET status=?, duffel_order_id=?, booking_reference=?, detail=?, updated_at=? WHERE offer_id=?",
    ).bind(status, o.orderId ?? null, o.reference ?? null, o.detail ?? null, nowIso(), offerId).run();
  }
}

export function passengerPayload(id: string, p: Traveler, needsPassport: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id, title: p.title, given_name: p.given_name, family_name: p.family_name, born_on: p.born_on,
    gender: p.gender, email: p.email, phone_number: p.phone_number,
  };
  if (needsPassport) {
    out.identity_documents = [{ type: "passport", unique_identifier: p.passport_number,
      expires_on: p.passport_expires_on, issuing_country_code: p.passport_country }];
  }
  return out;
}

const money = (n: number, c: string) => `${c === "USD" ? "$" : ""}${n.toFixed(2)}${c === "USD" ? "" : ` ${c}`}`;

export async function bookOffer(cfg: Config, store: Store, notifier: Notifier, duffel: DuffelProvider,
                                user: Contact, r: BookRequest, now = new Date()): Promise<BookResult> {
  const fail = (message: string): BookResult => ({ ok: false, message });

  if (cfg.dryRun) return fail("The site is in dry-run mode, so purchases are switched off.");
  if (!cfg.bookingEnabled) return fail("Purchasing is switched off (booking_enabled in config.json).");
  if (!r.travelers.length) return fail("Pick at least one traveler.");
  if (new Set(r.travelers).size !== r.travelers.length) return fail("A traveler is listed twice.");
  if (r.travelers.some((t) => !contactByName(cfg, t))) return fail("Unknown traveler.");

  let people: Record<string, Traveler>;
  try { people = loadTravelers(cfg); } catch (e) { return fail((e as Error).message); }
  const missing = r.travelers.filter((t) => !people[t]);
  if (missing.length) return fail(`No passenger details for ${missing.join(", ")} in TRAVELERS_JSON.`);

  // Fresh offer: Duffel updates price/availability; this is what we'd pay.
  let offer;
  try { offer = await duffel.getOffer(r.offerId); } catch (e) {
    return fail(`That fare is no longer available (${(e as Error).message}). Search again for current prices.`);
  }
  const total = Number(offer.total_amount);
  const currency = offer.total_currency;
  const testMode = offer.live_mode === false || duffel.testMode;
  if (!Number.isFinite(total) || total <= 0) return fail("Duffel returned no price for that fare.");
  if (offer.passengers.length !== r.travelers.length) {
    return fail("The fare is for a different number of travelers. Search again with the right travelers.");
  }
  const ceiling = r.expectedTotal * (1 + cfg.maxPriceIncreasePercent / 100);
  if (total > ceiling) {
    return fail(`The price is now ${money(total, currency)}, up from ${money(r.expectedTotal, currency)} `
      + `(more than ${cfg.maxPriceIncreasePercent}%). Nothing was bought.`);
  }
  if (offer.passenger_identity_documents_required) {
    const noPassport = r.travelers.filter((t) => {
      const p = people[t];
      return !p.passport_number || !p.passport_expires_on || !p.passport_country;
    });
    if (noPassport.length) {
      return fail(`This airline needs passport details for ${noPassport.join(", ")}. Add passport_number, `
        + "passport_expires_on and passport_country to TRAVELERS_JSON, then try again.");
    }
  }
  if (!testMode) {
    const spent = await store.spentOn(utcDate(now));
    if (spent + total > cfg.dailySpendCap) {
      return fail(`That would pass today's spending cap of $${cfg.dailySpendCap} `
        + `($${spent.toFixed(0)} already spent). Nothing was bought.`);
    }
  }

  const orders = new Orders(cfg.env.DB);
  if (!(await orders.claim(r, user.name, total, currency, testMode))) {
    return fail("This fare has already been booked (or a booking for it is in progress).");
  }

  const passengers = offer.passengers.map((p, i) =>
    passengerPayload(p.id, people[r.travelers[i]], !!offer.passenger_identity_documents_required));
  const who = r.travelers.join(" and ");
  const notifyWho = [...new Set([...r.travelers, user.name])];
  const trip = `${r.origin}→${r.destination} ${r.departDate} to ${r.returnDate}`;
  const test = testMode ? "[TEST MODE, no money moved] " : "";

  let order;
  try {
    order = await duffel.book(r.offerId, total, currency, passengers);
  } catch (e) {
    const m = (e as Error).message;
    await orders.finish(r.offerId, "failed", { detail: m.slice(0, 500) });
    const msg = `${test}Booking ${trip} FAILED or is uncertain (${m}). Check the Duffel dashboard before trying again.`;
    for (const n of notifyWho) {
      const c = contactByName(cfg, n);
      if (c) await tell(cfg, notifier, c, "Flight booking problem", msg);
    }
    return fail(msg);
  }

  await orders.finish(r.offerId, "booked", { orderId: order.orderId, reference: order.reference });
  const msg = `${test}Booked ${trip} for ${who}: ${money(total, currency)}. Airline confirmation ${order.reference}.`;
  for (const n of notifyWho) {
    const c = contactByName(cfg, n);
    if (c) await tell(cfg, notifier, c, `${testMode ? "[TEST] " : ""}Flight booked: ${r.origin}→${r.destination}`, msg);
  }
  return { ok: true, message: msg, reference: order.reference, total, currency, test_mode: testMode };
}
