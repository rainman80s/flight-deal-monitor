/**
 * Which searches to run each cycle. Searching every route x date every 30 min would
 * cost a fortune, so each cycle runs a small slice and rotates: every route gets
 * checked several times a day across a spread of departure dates and trip lengths.
 */
import type { Config } from "./config";
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
