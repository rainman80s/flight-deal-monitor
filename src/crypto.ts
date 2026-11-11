/**
 * Every security-critical primitive in one place, all on the Web Crypto API.
 *
 *   Passwords   PBKDF2-SHA256, 100,000 iterations (the Workers maximum), 16-byte random salt,
 *               run on HMAC(pepper, password) so a stolen database alone can't be brute-forced.
 *   Personal    AES-256-GCM with a random 96-bit IV per value. The row's purpose ("email",
 *   data        "name") is bound in as additional data, so ciphertext can't be swapped between fields.
 *   Lookups     HMAC-SHA256 "blind index" of the normalized email: find a user without decrypting.
 *   Tokens      256-bit random values; only their SHA-256 is ever stored.
 *
 * All keys derive from LINK_SECRET with HKDF and a distinct label each. Rotating LINK_SECRET
 * makes stored emails, names, profiles and passwords unreadable, so never rotate it casually.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64url = (u: Uint8Array) =>
  btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64url = (s: string) => {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(p + "=".repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const hex = (u: ArrayBuffer) => [...new Uint8Array(u)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time string comparison (length is not secret here). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export class Vault {
  private keys = new Map<string, Promise<CryptoKey>>();
  constructor(private secret: string) {
    if (!secret || secret.length < 16) throw new Error("LINK_SECRET must be set (at least 16 characters)");
  }

  private derive(label: string, usage: "hmac" | "aes"): Promise<CryptoKey> {
    const id = `${usage}:${label}`;
    let k = this.keys.get(id);
    if (!k) {
      k = crypto.subtle.importKey("raw", enc.encode(this.secret), "HKDF", false, ["deriveKey"]).then((base) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: enc.encode("fare-radar"), info: enc.encode(label) }, base,
          usage === "hmac" ? { name: "HMAC", hash: "SHA-256", length: 256 } : { name: "AES-GCM", length: 256 },
          false, usage === "hmac" ? ["sign"] : ["encrypt", "decrypt"]));
      this.keys.set(id, k);
    }
    return k;
  }

  async hmac(label: string, msg: string): Promise<string> {
    return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", await this.derive(label, "hmac"), enc.encode(msg))));
  }

  /** Stable, non-reversible id for an email, used as the lookup key. */
  emailIndex(email: string): Promise<string> {
    return this.hmac("email-index-v1", normalizeEmail(email));
  }

  async seal(purpose: string, value: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(purpose) },
      await this.derive("user-data-v1", "aes"), enc.encode(value));
    return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
  }

  async open(purpose: string, sealed: string): Promise<string> {
    const [v, iv, ct] = sealed.split(".");
    if (v !== "v1" || !iv || !ct) throw new Error("unknown sealed format");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64url(iv), additionalData: enc.encode(purpose) },
      await this.derive("user-data-v1", "aes"), unb64url(ct));
    return dec.decode(pt);
  }

  // ---------------- passwords ----------------

  static readonly ITERATIONS = 100_000;

  async hashPassword(password: string, salt = crypto.getRandomValues(new Uint8Array(16)),
                     iterations = Vault.ITERATIONS): Promise<string> {
    const peppered = await this.hmac("password-pepper-v1", password);
    const key = await crypto.subtle.importKey("raw", enc.encode(peppered), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
    return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(new Uint8Array(bits))}`;
  }

  async verifyPassword(password: string, stored: string | null): Promise<boolean> {
    // Always do the full amount of work, so timing doesn't reveal whether the account exists.
    const parts = (stored ?? "").split("$");
    const ok = parts.length === 4 && parts[0] === "pbkdf2-sha256" && /^\d+$/.test(parts[1]);
    const salt = ok ? unb64url(parts[2]) : new Uint8Array(16);
    const iterations = ok ? Number(parts[1]) : Vault.ITERATIONS;
    const candidate = await this.hashPassword(password, salt, iterations);
    return ok && safeEqual(candidate, stored!);
  }
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export const EMAIL_RE = /^[^\s@<>"(),;:\\[\]]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Passwords people actually use; rejected outright. (Short list; length does most of the work.) */
const COMMON = new Set(["password", "password1", "password123", "123456789", "1234567890", "qwertyuiop",
  "iloveyou12", "letmein123", "welcome123", "admin12345", "passw0rd12", "abc1234567", "1q2w3e4r5t", "football12",
  "baseball12", "sunshine12", "princess12", "dragon1234", "monkey1234", "trustno1234", "superman12", "qwerty1234",
  "flightdeal", "fareradar1", "fareradar123", "seattle123", "portland123"]);

/** A problem with a new password, or null if it's acceptable. */
export function passwordProblem(password: string, email: string): string | null {
  if (typeof password !== "string" || password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "Use 200 characters or fewer.";
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "That password is too common. Pick something harder to guess.";
  if (/^(.)\1+$/.test(password)) return "That password is too easy to guess.";
  const local = normalizeEmail(email).split("@")[0];
  if (local.length >= 4 && lower.includes(local)) return "Don't use your email address in your password.";
  return null;
}
