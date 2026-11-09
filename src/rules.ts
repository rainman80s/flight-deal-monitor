/** The deal rules. A fare is a deal only if every check passes. */
import { type Config, kindOf, limitOf } from "./config";
import { daysBetween } from "./dates";
import { type Fare, routeKey } from "./models";

export function rejectionReason(cfg: Config, f: Fare, today: string): string | null {
  if (f.currency !== cfg.currency) return `currency ${f.currency} != ${cfg.currency}`;
  const daysOut = daysBetween(today, f.departDate);
  if (daysOut < cfg.minDaysOut) return `departs in ${daysOut} days (< ${cfg.minDaysOut})`;
  if (daysOut > cfg.maxDaysOut) return `departs in ${daysOut} days (> ${cfg.maxDaysOut})`;
  const trip = daysBetween(f.departDate, f.returnDate);
  if (trip > cfg.maxTripDays) return `trip is ${trip} days (> ${cfg.maxTripDays})`;
  if (trip < cfg.minTripDays) return `trip is ${trip} days (< ${cfg.minTripDays})`;
  if (!f.kind && !cfg.domestic.includes(f.destination) && !cfg.international.includes(f.destination)) {
    return `${f.destination} not in destination lists`;
  }
  const limit = limitOf(cfg, f);
  if (f.price >= limit) {
    const kind = kindOf(cfg, f);
    return `$${f.price.toFixed(0)} not under ${kind} limit $${limit}`;
  }
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
