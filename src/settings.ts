/**
 * The deal rules for each category (the Logic panel). Defaults come from config.json
 * "categories"; anything saved from the site (D1 `settings`, key "categories") overrides them.
 *
 *   show:  a fare appears on the site if it leaves within [min_days_out, max_days_out], lasts
 *          [min_trip_days, max_trip_days] and costs under show_under.
 *   alert: "under"  -> ping when the price is under alert.under
 *          "smart"  -> ping when the price is at least drop_percent below the route's usual
 *                      price (learned from saved prices, see baselines.ts); until a route has
 *                      min_samples prices, fall back to "under alert.under".
 */
import raw from "../config.json";
import type { Config } from "./config";

export type Kind = "domestic" | "international";

export interface AlertRule { mode: "smart" | "under"; under: number; dropPercent: number; minSamples: number }
export interface CatRules {
  minDaysOut: number; maxDaysOut: number; minTripDays: number; maxTripDays: number; showUnder: number; alert: AlertRule;
}
export type Categories = Record<Kind, CatRules>;

type RawCat = {
  min_days_out: number; max_days_out: number; min_trip_days: number; max_trip_days: number; show_under: number;
  alert: { mode: string; under: number; drop_percent: number; min_samples: number };
};

export function fromRaw(r: RawCat): CatRules {
  return {
    minDaysOut: r.min_days_out, maxDaysOut: r.max_days_out, minTripDays: r.min_trip_days, maxTripDays: r.max_trip_days,
    showUnder: r.show_under,
    alert: { mode: r.alert.mode === "smart" ? "smart" : "under", under: r.alert.under,
             dropPercent: r.alert.drop_percent, minSamples: r.alert.min_samples },
  };
}

export const toRaw = (c: CatRules) => ({
  min_days_out: c.minDaysOut, max_days_out: c.maxDaysOut, min_trip_days: c.minTripDays, max_trip_days: c.maxTripDays,
  show_under: c.showUnder,
  alert: { mode: c.alert.mode, under: c.alert.under, drop_percent: c.alert.dropPercent, min_samples: c.alert.minSamples },
});

export function defaultCategories(): Categories {
  const c = (raw as unknown as { categories: Record<Kind, RawCat> }).categories;
  return { domestic: fromRaw(c.domestic), international: fromRaw(c.international) };
}

/** Validate one category from the Logic panel. Returns the rules or field errors. */
export function validateCat(input: unknown): { ok: true; rules: CatRules } | { ok: false; errors: Record<string, string> } {
  const r = (input ?? {}) as Record<string, unknown>;
  const a = (r.alert ?? {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const int = (v: unknown, key: string, lo: number, hi: number, label: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) { errors[key] = `${label} must be a whole number from ${lo} to ${hi}.`; return lo; }
    return n;
  };
  const minDays = int(r.min_days_out, "min_days_out", 0, 300, "Earliest departure");
  const maxDays = int(r.max_days_out, "max_days_out", 1, 330, "Latest departure");
  const minTrip = int(r.min_trip_days, "min_trip_days", 1, 30, "Shortest trip");
  const maxTrip = int(r.max_trip_days, "max_trip_days", 1, 60, "Longest trip");
  const show = int(r.show_under, "show_under", 20, 5000, "Show-under price");
  const mode = a.mode === "smart" ? "smart" : a.mode === "under" ? "under" : null;
  if (!mode) errors["alert.mode"] = "Pick how alerts are decided.";
  const under = int(a.under, "alert.under", 20, 5000, "Alert price");
  const drop = int(a.drop_percent, "alert.drop_percent", 5, 90, "Percent below usual");
  const samples = int(a.min_samples, "alert.min_samples", 3, 200, "Prices needed");
  if (!errors.max_days_out && !errors.min_days_out && maxDays <= minDays) {
    errors.max_days_out = "Latest departure must be after the earliest.";
  }
  if (!errors.max_trip_days && !errors.min_trip_days && maxTrip < minTrip) {
    errors.max_trip_days = "Longest trip can't be shorter than the shortest.";
  }
  if (!errors["alert.under"] && !errors.show_under && under > show) {
    errors["alert.under"] = "The alert price can't be above the show-under price (alerts are always shown).";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, rules: { minDaysOut: minDays, maxDaysOut: maxDays, minTripDays: minTrip, maxTripDays: maxTrip,
    showUnder: show, alert: { mode: mode!, under, dropPercent: drop, minSamples: samples } } };
}

/** Put category rules onto a Config, keeping the older summary fields in step. */
export function setCategories(cfg: Config, cats: Categories): void {
  cfg.cats = cats;
  cfg.domesticMaxPrice = cats.domestic.showUnder;
  cfg.internationalMaxPrice = cats.international.showUnder;
  cfg.minDaysOut = Math.min(cats.domestic.minDaysOut, cats.international.minDaysOut);
  cfg.maxDaysOut = Math.max(cats.domestic.maxDaysOut, cats.international.maxDaysOut);
  cfg.minTripDays = Math.min(cats.domestic.minTripDays, cats.international.minTripDays);
  cfg.maxTripDays = Math.max(cats.domestic.maxTripDays, cats.international.maxTripDays);
}

export async function loadSaved(db: D1Database): Promise<{ cats: Partial<Categories>; updated_at: string | null; updated_by: string | null }> {
  try {
    const row = await db.prepare("SELECT value, updated_at, updated_by FROM settings WHERE key='categories'")
      .first<{ value: string; updated_at: string; updated_by: string }>();
    if (!row) return { cats: {}, updated_at: null, updated_by: null };
    const saved = JSON.parse(row.value) as Record<string, unknown>;
    const out: Partial<Categories> = {};
    for (const k of ["domestic", "international"] as Kind[]) {
      const v = validateCat(saved[k]);
      if (v.ok) out[k] = v.rules; // a bad saved value falls back to the default
    }
    return { cats: out, updated_at: row.updated_at, updated_by: row.updated_by };
  } catch (e) {
    console.error("settings unreadable; using defaults", e);
    return { cats: {}, updated_at: null, updated_by: null };
  }
}

/** Apply saved Logic-panel settings on top of the defaults. Call once per request/run. */
export async function applySettings(cfg: Config): Promise<void> {
  const saved = await loadSaved(cfg.env.DB);
  setCategories(cfg, { ...defaultCategories(), ...saved.cats });
}

export async function saveCategories(db: D1Database, cats: Categories, by: string): Promise<void> {
  const value = JSON.stringify({ domestic: toRaw(cats.domestic), international: toRaw(cats.international) });
  await db.prepare(
    `INSERT INTO settings(key,value,updated_at,updated_by) VALUES('categories',?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
  ).bind(value, new Date().toISOString().slice(0, 19) + "Z", by).run();
}

export async function resetCategories(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key='categories'").run();
}

/** Plain-English summary, used by the site and emails. */
export function describe(kind: Kind, c: CatRules): string {
  const label = kind === "domestic" ? "US trips" : "Trips abroad";
  const ping = c.alert.mode === "smart"
    ? `ping when a fare is at least ${c.alert.dropPercent}% below that route's usual price `
      + `(under $${c.alert.under} until we've seen ${c.alert.minSamples} prices for the route)`
    : `ping when a fare is under $${c.alert.under}`;
  return `${label}: show round trips leaving ${c.minDaysOut} to ${c.maxDaysOut} days from now, `
    + `${c.minTripDays} to ${c.maxTripDays} days long, under $${c.showUnder}; ${ping}.`;
}

/**
 * A person's own rules (saved from their Logic page), falling back per category to the
 * site defaults when they haven't customized it or a saved value no longer validates.
 */
export function personalCategories(cfg: Config, saved: unknown | null): Categories {
  const out: Categories = { ...cfg.cats };
  if (saved && typeof saved === "object") {
    for (const k of ["domestic", "international"] as Kind[]) {
      const v = validateCat((saved as Record<string, unknown>)[k]);
      if (v.ok) out[k] = v.rules;
    }
  }
  return out;
}
