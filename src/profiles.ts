/**
 * Traveler profiles from the Account page, stored encrypted in D1.
 *
 * Encryption: AES-256-GCM, key derived with HKDF-SHA256 from LINK_SECRET. Rotating
 * LINK_SECRET makes saved profiles unreadable (they'd need re-entering), so don't.
 *
 * Booking reads profiles first and falls back to the TRAVELERS_JSON secret.
 */
import { type Config, type Traveler } from "./config";

export const TITLES = ["mr", "ms", "mrs", "miss", "dr"] as const;

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function key(cfg: Config): Promise<CryptoKey> {
  const secret = cfg.env.LINK_SECRET;
  if (typeof secret !== "string" || !secret) throw new Error("LINK_SECRET is needed to store traveler details");
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("fare-radar"), info: enc.encode("traveler-profiles-v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function seal(cfg: Config, contact: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(contact) },
    await key(cfg), enc.encode(JSON.stringify(value)));
  return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

async function open(cfg: Config, contact: string, sealed: string): Promise<Traveler> {
  const [v, iv, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !ct) throw new Error("unknown profile format");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv), additionalData: enc.encode(contact) },
    await key(cfg), unb64(ct));
  return JSON.parse(dec.decode(pt)) as Traveler;
}

/** Check and normalize submitted details. Returns the profile or a list of problems. */
export function validateProfile(input: Record<string, unknown>, existing: Traveler | null, today: string):
    { ok: true; profile: Traveler } | { ok: false; errors: Record<string, string> } {
  const s = (k: string) => String(input[k] ?? "").trim();
  const errors: Record<string, string> = {};
  const title = s("title").toLowerCase();
  const given = s("given_name"), family = s("family_name");
  const born = s("born_on"), gender = s("gender").toLowerCase();
  const email = s("email").toLowerCase(), phone = s("phone_number").replace(/[\s().-]/g, "");
  const NAME = /^[\p{L}][\p{L}' -]{0,48}$/u;

  if (!(TITLES as readonly string[]).includes(title)) errors.title = "Pick a title.";
  if (!NAME.test(given)) errors.given_name = "Enter the first name as it appears on your ID.";
  if (!NAME.test(family)) errors.family_name = "Enter the last name as it appears on your ID.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(born) || born >= today || born < "1900-01-01") errors.born_on = "Enter a valid date of birth.";
  if (!["m", "f"].includes(gender)) errors.gender = "Pick the gender shown on your ID.";
  if (!/^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[a-z]{2,}$/i.test(email)) errors.email = "Enter a valid email.";
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) errors.phone_number = "Use international format, e.g. +12065550111.";

  // Passport: optional, but all three fields together. A blank number keeps the saved one.
  let number = s("passport_number").toUpperCase().replace(/\s/g, "");
  const expires = s("passport_expires_on"), country = s("passport_country").toUpperCase();
  if (!number && existing?.passport_number && (expires || country)) number = existing.passport_number;
  const anyPassport = number || expires || country;
  if (anyPassport) {
    if (!/^[A-Z0-9]{5,20}$/.test(number)) errors.passport_number = "Enter the passport number (letters and digits).";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || expires <= today) errors.passport_expires_on = "Enter a future expiry date.";
    if (!/^[A-Z]{2}$/.test(country)) errors.passport_country = "Use the 2-letter country code, e.g. US.";
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const profile: Traveler = { title, given_name: given, family_name: family, born_on: born, gender, email, phone_number: phone };
  if (anyPassport) Object.assign(profile, { passport_number: number, passport_expires_on: expires, passport_country: country });
  return { ok: true, profile };
}

/** What the Account page may show: passport number masked. */
export function publicProfile(p: Traveler | null) {
  if (!p) return null;
  const { passport_number, ...rest } = p;
  return { ...rest, passport_number_hint: passport_number ? `•••• ${passport_number.slice(-3)}` : null };
}

export class ProfileStore {
  constructor(private cfg: Config) {}
  private get db() { return this.cfg.env.DB; }

  async get(contact: string): Promise<Traveler | null> {
    const r = await this.db.prepare("SELECT data FROM traveler_profiles WHERE contact=?").bind(contact)
      .first<{ data: string }>();
    if (!r) return null;
    try { return await open(this.cfg, contact, r.data); } catch (e) {
      console.error(`profile for ${contact} unreadable`, e);
      return null;
    }
  }

  async meta(contact: string) {
    return this.db.prepare("SELECT updated_at, updated_by FROM traveler_profiles WHERE contact=?").bind(contact)
      .first<{ updated_at: string; updated_by: string }>();
  }

  async save(contact: string, profile: Traveler, by: string) {
    await this.db.prepare(
      `INSERT INTO traveler_profiles(contact,data,updated_at,updated_by) VALUES(?,?,?,?)
       ON CONFLICT(contact) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    ).bind(contact, await seal(this.cfg, contact, profile), new Date().toISOString().slice(0, 19) + "Z", by).run();
  }

  async remove(contact: string) {
    await this.db.prepare("DELETE FROM traveler_profiles WHERE contact=?").bind(contact).run();
  }
}

/** Passenger details for booking: Account-page profiles first, then the TRAVELERS_JSON secret. */
export async function loadAllTravelers(cfg: Config): Promise<Record<string, Traveler>> {
  let fromSecret: Record<string, Traveler> = {};
  try {
    const raw = cfg.env.TRAVELERS_JSON;
    if (typeof raw === "string" && raw) fromSecret = JSON.parse(raw) as Record<string, Traveler>;
  } catch (e) { console.error("TRAVELERS_JSON unreadable", e); }
  const out: Record<string, Traveler> = {};
  const store = new ProfileStore(cfg);
  for (const c of cfg.contacts) {
    const p = (await store.get(c.name)) ?? fromSecret[c.name];
    if (p) out[c.name] = p;
  }
  return out;
}
