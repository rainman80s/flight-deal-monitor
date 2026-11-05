import raw from "../config.json";

export interface Contact { name: string; phone: string }

export interface Traveler {
  title: string; given_name: string; family_name: string; born_on: string;
  gender: string; email: string; phone_number: string;
}

/** Everything the Worker reads from its environment (bindings + secrets). */
export interface Env {
  DB: D1Database;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_FROM_NUMBER?: string;
  PUBLIC_BASE_URL?: string;
  DUFFEL_ACCESS_TOKEN?: string;
  IGNAV_API_KEY?: string;
  TRAVELERS_JSON?: string;
  ADMIN_TOKEN?: string;
  [key: string]: unknown;
}

export interface Config {
  dryRun: boolean;
  bookingEnabled: boolean;
  provider: "mock" | "duffel" | "ignav";
  origins: string[];
  currency: string;
  cabinClass: string;
  maxConnections: number;
  searchesPerCycle: number;
  domesticMaxPrice: number;
  internationalMaxPrice: number;
  minDaysOut: number;
  maxDaysOut: number;
  minTripDays: number;
  maxTripDays: number;
  tripLengths: number[];
  domestic: string[];
  international: string[];
  timezone: string;
  quietStart: number;
  quietEnd: number;
  realertDropPercent: number;
  maxCallsPerCycle: number;
  maxTextsPerCycle: number;
  contacts: Contact[];
  bookingMode: "responder" | "both";
  maxPriceIncreasePercent: number;
  dailySpendCap: number;
  env: Env;
}

export type RawConfig = typeof raw;

export function buildConfig(env: Env, r: RawConfig = raw): Config {
  const up = (xs: string[]) => xs.map((x) => x.toUpperCase());
  const cfg: Config = {
    dryRun: r.mode.dry_run,
    bookingEnabled: r.mode.booking_enabled,
    provider: r.search.provider as Config["provider"],
    origins: up(r.search.origins),
    currency: r.search.currency,
    cabinClass: r.search.cabin_class,
    maxConnections: r.search.max_connections,
    searchesPerCycle: r.search.searches_per_cycle,
    domesticMaxPrice: r.rules.domestic_max_price,
    internationalMaxPrice: r.rules.international_max_price,
    minDaysOut: r.rules.min_days_out,
    maxDaysOut: r.rules.max_days_out,
    minTripDays: r.rules.min_trip_days,
    maxTripDays: r.rules.max_trip_days,
    tripLengths: r.rules.trip_lengths_to_search,
    domestic: up(r.destinations.domestic),
    international: up(r.destinations.international),
    timezone: r.alerts.timezone,
    quietStart: r.alerts.quiet_hours_start,
    quietEnd: r.alerts.quiet_hours_end,
    realertDropPercent: r.alerts.realert_drop_percent,
    maxCallsPerCycle: r.alerts.max_calls_per_cycle,
    maxTextsPerCycle: r.alerts.max_texts_per_cycle,
    contacts: r.alerts.contacts.map((name) => ({
      name, phone: String(env[`CONTACT_${name}_PHONE`] ?? ""),
    })),
    bookingMode: r.booking.mode as Config["bookingMode"],
    maxPriceIncreasePercent: r.booking.max_price_increase_percent,
    dailySpendCap: r.booking.daily_spend_cap,
    env,
  };
  validate(cfg);
  return cfg;
}

export function validate(cfg: Config): void {
  const p: string[] = [];
  if (!["responder", "both"].includes(cfg.bookingMode)) p.push("booking.mode must be responder or both");
  if (!["mock", "duffel", "ignav"].includes(cfg.provider)) p.push("search.provider must be mock, duffel or ignav");
  if (cfg.minDaysOut >= cfg.maxDaysOut) p.push("rules.min_days_out must be < max_days_out");
  const overlap = cfg.domestic.filter((d) => cfg.international.includes(d));
  if (overlap.length) p.push(`destinations in both lists: ${overlap.join(", ")}`);
  const bad = cfg.tripLengths.filter((n) => n < cfg.minTripDays || n > cfg.maxTripDays);
  if (bad.length) p.push(`trip_lengths_to_search outside min/max trip days: ${bad.join(", ")}`);
  if (!cfg.dryRun) {
    for (const c of cfg.contacts) {
      if (!c.phone.startsWith("+")) p.push(`secret CONTACT_${c.name}_PHONE must be E.164, e.g. +12065550111`);
    }
  }
  if (p.length) throw new Error("Config problems:\n  - " + p.join("\n  - "));
}

export function secret(cfg: Config, key: keyof Env & string): string {
  const v = cfg.env[key];
  if (typeof v !== "string" || !v) throw new Error(`Missing secret ${key} (npx wrangler secret put ${key})`);
  return v;
}

export const isDomestic = (cfg: Config, iata: string) => cfg.domestic.includes(iata);
export const maxPriceFor = (cfg: Config, dest: string) =>
  isDomestic(cfg, dest) ? cfg.domesticMaxPrice : cfg.internationalMaxPrice;
export const contactByName = (cfg: Config, name: string) => cfg.contacts.find((c) => c.name === name);
export const contactByPhone = (cfg: Config, phone: string) => cfg.contacts.find((c) => c.phone === phone);

export function loadTravelers(cfg: Config): Record<string, Traveler> {
  const raw = cfg.env.TRAVELERS_JSON;
  if (!raw) throw new Error("Booking needs the TRAVELERS_JSON secret with passenger details");
  const data = JSON.parse(raw) as Record<string, Traveler>;
  const required = ["title", "given_name", "family_name", "born_on", "gender", "email", "phone_number"];
  for (const [name, t] of Object.entries(data)) {
    const missing = required.filter((k) => !(k in t));
    if (missing.length) throw new Error(`TRAVELERS_JSON ${name} missing ${missing.join(", ")}`);
  }
  return data;
}
