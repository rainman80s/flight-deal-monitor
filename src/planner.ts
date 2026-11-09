/**
 * Which searches to run each cycle. Searching every route x date every 30 min would
 * cost a fortune, so each cycle runs a small slice and rotates: every route gets
 * checked several times a day across a spread of departure dates and trip lengths.
 */
import { catOf, type Config } from "./config";
import { addDays } from "./dates";
import type { SearchQuery } from "./models";

export function allRoutes(cfg: Config): [string, string][] {
  const dests = [...cfg.domestic, ...cfg.international];
  const routes: [string, string][] = [];
  for (const d of dests) for (const o of cfg.origins) if (o !== d) routes.push([o, d]);
  return routes;
}

export function planCycle(cfg: Config, cycle: number, today: string): SearchQuery[] {
  const routes = allRoutes(cfg);
  if (!routes.length) return [];
  const n = Math.min(cfg.searchesPerCycle, routes.length);
  const window = cfg.maxDaysOut - cfg.minDaysOut;
  const lengths = cfg.tripLengths;
  const out: SearchQuery[] = [];
  for (let i = 0; i < n; i++) {
    const slot = cycle * n + i;
    const idx = slot % routes.length;
    const [origin, destination] = routes[idx];
    const pass = Math.floor(slot / routes.length);
    const offset = (pass * 17 + idx * 7) % (window + 1);
    const departDate = addDays(today, cfg.minDaysOut + offset);
    const length = lengths[(pass + slot) % lengths.length];
    out.push({ origin, destination, departDate, returnDate: addDays(departDate, length) });
  }
  return out;
}

/**
 * Calendar plan (Ignav): each query covers one route, one trip length and a window of
 * up to 31 departure dates in a single request. Slots rotate so consecutive runs hit
 * different routes, and every route/window/trip-length combination comes up in turn.
 */
/** 31-day departure windows covering [minDaysOut, maxDaysOut] (the whole config, or one category). */
export function calendarWindows(cfg: Config, rules?: { minDaysOut: number; maxDaysOut: number }):
    { offset: number; days: number }[] {
  const min = rules?.minDaysOut ?? cfg.minDaysOut, max = rules?.maxDaysOut ?? cfg.maxDaysOut;
  const out: { offset: number; days: number }[] = [];
  for (let start = Math.max(1, min); start <= max; start += 31) {
    out.push({ offset: start, days: Math.min(31, max - start + 1) });
  }
  return out;
}

/** Trip lengths to price for a category: the configured ones that fit, else its shortest trip. */
export function staysFor(cfg: Config, rules: { minTripDays: number; maxTripDays: number }): number[] {
  const fit = cfg.tripLengths.filter((n) => n >= rules.minTripDays && n <= rules.maxTripDays);
  return fit.length ? fit : [Math.min(Math.max(7, rules.minTripDays), rules.maxTripDays)];
}

export function planCalendar(cfg: Config, cycle: number, today: string, perRun: number): SearchQuery[] {
  const routes = allRoutes(cfg);
  if (!routes.length) return [];
  const out: SearchQuery[] = [];
  for (let i = 0; i < perRun; i++) {
    const slot = cycle * perRun + i;
    const [origin, destination] = routes[slot % routes.length];
    // Each destination uses its own category's timing and trip lengths.
    const rules = catOf(cfg, { destination });
    const windows = calendarWindows(cfg, rules);
    const stays = staysFor(cfg, rules);
    if (!windows.length) continue;
    const k = Math.floor(slot / routes.length);
    const w = windows[k % windows.length];
    const stay = stays[(k + Math.floor(k / windows.length)) % stays.length];
    const departDate = addDays(today, w.offset);
    out.push({ origin, destination, departDate, returnDate: addDays(departDate, stay),
               windowDays: w.days, stayDays: stay, maxPrice: rules.showUnder });
  }
  return out;
}
