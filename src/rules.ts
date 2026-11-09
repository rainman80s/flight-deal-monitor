/**
 * The "show" rules: a fare is shown on the site if it passes its category's timing, trip
 * length and show-under price (Logic panel). Whether it also pings is decided separately
 * (baselines.ts pingReason).
 */
import { catOf, type Config, kindOf } from "./config";
import { daysBetween } from "./dates";
import { type Fare, routeKey } from "./models";

export function rejectionReason(cfg: Config, f: Fare, today: string): string | null {
  if (f.currency !== cfg.currency) return `currency ${f.currency} != ${cfg.currency}`;
  if (!f.kind && !cfg.domestic.includes(f.destination) && !cfg.international.includes(f.destination)) {
    return `${f.destination} not in destination lists`;
  }
  const c = catOf(cfg, f);
  const kind = kindOf(cfg, f);
  const daysOut = daysBetween(today, f.departDate);
  if (daysOut < c.minDaysOut) return `departs in ${daysOut} days (${kind} needs ${c.minDaysOut}+)`;
  if (daysOut > c.maxDaysOut) return `departs in ${daysOut} days (${kind} max ${c.maxDaysOut})`;
  const trip = daysBetween(f.departDate, f.returnDate);
  if (trip > c.maxTripDays) return `trip is ${trip} days (${kind} max ${c.maxTripDays})`;
  if (trip < c.minTripDays) return `trip is ${trip} days (${kind} needs ${c.minTripDays}+)`;
  if (f.price >= c.showUnder) return `$${f.price.toFixed(0)} not under ${kind} limit $${c.showUnder}`;
  return null;
}

export function cheapestPerRoute(fares: Fare[]): Fare[] {
  const best = new Map<string, Fare>();
  for (const f of fares) {
    const k = routeKey(f);
    const cur = best.get(k);
    if (!cur || f.price < cur.price) best.set(k, f);
  }
  return [...best.values()];
}
