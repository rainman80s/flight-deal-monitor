import raw from "../config.json";

export interface Contact { name: string; phone: string; email: string }

export type Channel = "email" | "sms" | "call";

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
  RESEND_API_KEY?: string;
  LINK_SECRET?: string;
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
  maxAlertsPerCycle: number;
  channels: Channel[];
  emailFrom: string;
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
    maxAlertsPerCycle: r.alerts.max_alerts_per_cycle,
    channels: r.alerts.channels as Channel[],
    emailFrom: r.alerts.email_from,
    contacts: r.alerts.contacts.map((name) => ({
      name,
      phone: String(env[`CONTACT_${name}_PHONE`] ?? ""),
      email: String(env[`CONTACT_${name}_EMAIL`] ?? ""),
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
  const badCh = cfg.channels.filter((c) => !["email", "sms", "call"].includes(c));
  if (badCh.length || !cfg.channels.length) p.push("alerts.channels must list email, sms and/or call");
  if (!cfg.dryRun) {
    for (const c of cfg.contacts) {
      if (c.phone && !c.phone.startsWith("+")) p.push(`secret CONTACT_${c.name}_PHONE must be E.164, e.g. +12065550111`);
    }
    if (!cfg.contacts.some((c) => reachable(cfg, c))) {
      p.push("no contact can be reached on alerts.channels (set CONTACT_<NAME>_EMAIL or _PHONE secrets)");
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
/** Can this contact get alerts on at least one enabled channel? */
export const reachable = (cfg: Config, c: Contact) =>
  (cfg.channels.includes("email") && !!c.email)
  || ((cfg.channels.includes("sms") || cfg.channels.includes("call")) && !!c.phone);
export const contactByPhone = (cfg: Config, phone: string) =>
  phone ? cfg.contacts.find((c) => c.phone === phone) : undefined;

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
