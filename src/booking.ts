/**
 * What happens after someone says BUY (and confirms).
 *
 * Safety rails, in order:
 *   1. Fake (mock) fares are never booked.
 *   2. dry_run -> log what would happen, book nothing.
 *   3. booking_enabled = false -> text the booking link instead.
 *   4. One booking per (deal, traveler), enforced by the database, so a double
 *      press or a duplicate webhook can't double-book.
 *   5. Fresh re-price right before paying; refuse if the price rose more than
 *      max_price_increase_percent over the alerted price.
 *   6. Daily spend cap.
 */
import { type Config, contactByName, loadTravelers, type Traveler } from "./config";
import { utcDate } from "./dates";
import { confirmText, linkText } from "./messages";
import type { BookingProvider, Deal } from "./models";
import { makeBookingProvider } from "./providers";
import type { Store } from "./store";
import type { Notifier } from "./twilio";

export const travelersFor = (cfg: Config, responder: string) =>
  cfg.bookingMode === "both" ? cfg.contacts.map((c) => c.name) : [responder];

export const maxTotal = (cfg: Config, d: Deal, travelers: string[]) =>
  d.price * travelers.length * (1 + cfg.maxPriceIncreasePercent / 100);

/** Only a real purchase needs the second confirmation step. */
export const needsConfirmation = (cfg: Config, d: Deal) => cfg.bookingEnabled && !cfg.dryRun && !d.is_fake;

async function tell(cfg: Config, notifier: Notifier, names: string[], body: string) {
  for (const n of names) {
    const c = contactByName(cfg, n);
    if (!c) continue;
    try { await notifier.sms(c.phone, body); } catch (e) { console.error(`failed to text ${n}`, e); }
  }
}

export async function requestBuy(cfg: Config, store: Store, d: Deal, responder: string, channel: string) {
  await store.addResponse(d.id, responder, "buy_requested", channel);
  const travelers = travelersFor(cfg, responder);
  return confirmText(d, travelers, maxTotal(cfg, d, travelers));
}

export async function executeBuy(cfg: Config, store: Store, notifier: Notifier, d: Deal, responder: string,
                                 provider?: BookingProvider, now = new Date()): Promise<string> {
  const travelers = travelersFor(cfg, responder);
  const notifyWho = [...new Set([...travelers, responder])];

  if (d.is_fake || cfg.dryRun) {
    const status = d.is_fake
      ? `Deal ${d.code} is a FAKE TEST FARE; nothing booked.`
      : `[DRY RUN] Would book ${d.code} for ${travelers.join(", ")} `
        + `(up to $${maxTotal(cfg, d, travelers).toFixed(0)}). Nothing purchased.`;
    for (const t of travelers) {
      if (await store.claimBooking(d.id, t)) await store.finishBooking(d.id, t, "dry_run");
    }
    await tell(cfg, notifier, [responder], status);
    return status;
  }

  if (!cfg.bookingEnabled) {
    for (const t of travelers) {
      if (await store.claimBooking(d.id, t)) await store.finishBooking(d.id, t, "link_sent");
    }
    const status = linkText(d);
    await tell(cfg, notifier, [responder], status);
    return status;
  }

  // ---- real purchase ----
  const claimed: string[] = [];
  for (const t of travelers) if (await store.claimBooking(d.id, t)) claimed.push(t);
  if (claimed.length !== travelers.length) {
    for (const t of claimed) await store.releaseBooking(d.id, t);
    const status = `Deal ${d.code} is already booked (or being booked) for ${travelers.join(", ")}.`;
    await tell(cfg, notifier, [responder], status);
    return status;
  }

  const abort = async (reason: string) => {
    for (const t of travelers) await store.releaseBooking(d.id, t);
    const msg = `Did NOT book ${d.code}: ${reason}`;
    await tell(cfg, notifier, notifyWho, msg);
    return msg;
  };

  let people: Record<string, Traveler>;
  let fresh;
  try {
    people = loadTravelers(cfg);
    const missing = travelers.filter((t) => !(t in people));
    if (missing.length) return abort(`no passenger details for ${missing.join(", ")} in TRAVELERS_JSON`);
    provider ??= makeBookingProvider(cfg);
    fresh = await provider.reprice(d.origin, d.destination, d.depart_date, d.return_date, travelers.length);
  } catch (e) { // nothing paid yet, safe to release
    console.error("pre-booking step failed", e);
    return abort(`error before purchase (${(e as Error).message})`);
  }

  if (!fresh) return abort("fare is no longer available.");
  if (fresh.currency !== d.currency) return abort(`fresh price is in ${fresh.currency}, expected ${d.currency}.`);
  const ceiling = maxTotal(cfg, d, travelers);
  if (fresh.total > ceiling) {
    return abort(`price is now $${fresh.total.toFixed(0)} total, over the $${ceiling.toFixed(0)} limit.`);
  }
  const spent = await store.spentOn(utcDate(now));
  if (spent + fresh.total > cfg.dailySpendCap) {
    return abort(`would exceed daily spend cap ($${spent.toFixed(0)} spent + $${fresh.total.toFixed(0)} > `
      + `$${cfg.dailySpendCap}).`);
  }
  if (fresh.passengerIds.length !== travelers.length) return abort("offer passenger count mismatch.");

  const passengers = fresh.passengerIds.map((id, i) => {
    const p = people[travelers[i]];
    return { id, title: p.title, given_name: p.given_name, family_name: p.family_name, born_on: p.born_on,
             gender: p.gender, email: p.email, phone_number: p.phone_number };
  });
  const perPerson = fresh.total / travelers.length;

  let order;
  try {
    order = await provider.book(fresh.offerId, fresh.total, fresh.currency, passengers);
  } catch (e) {
    // The request may have reached the airline; we can't be sure it failed cleanly.
    // Keep the claim (status failed) so it is NOT retried automatically.
    console.error("booking call failed", e);
    const m = (e as Error).message;
    for (const t of travelers) {
      await store.finishBooking(d.id, t, "failed", { amount: perPerson, currency: fresh.currency, detail: m.slice(0, 500) });
    }
    const msg = `Booking ${d.code} FAILED or is uncertain (${m}). Check the Duffel dashboard before retrying.`;
    await tell(cfg, notifier, notifyWho, msg);
    return msg;
  }

  for (const t of travelers) {
    await store.finishBooking(d.id, t, "booked", {
      amount: perPerson, currency: fresh.currency, orderId: order.orderId, reference: order.reference,
    });
  }
  const msg = `BOOKED ${d.origin}→${d.destination} ${d.depart_date} to ${d.return_date} for `
    + `${travelers.join(", ")}: $${fresh.total.toFixed(2)} ${fresh.currency}. Airline confirmation ${order.reference}.`;
  await tell(cfg, notifier, notifyWho, msg);
  return msg;
}
