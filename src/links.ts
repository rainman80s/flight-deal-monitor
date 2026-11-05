/**
 * Signed Buy/Skip links for emails. The token is HMAC-SHA256(LINK_SECRET, code|who|action),
 * so a link only works for that exact deal, person and action, and can't be forged.
 */
import { type Config, secret } from "./config";

export type LinkAction = "buy" | "skip";

const b64url = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sign(key: string, code: string, who: string, action: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${code}|${who}|${action}`)));
}

/** Signed token for subscriber links (confirm / unsubscribe). */
export async function subscriberToken(cfg: Config, id: number, purpose: "confirm" | "unsubscribe") {
  return sign(secret(cfg, "LINK_SECRET"), `sub${id}`, purpose, "v1");
}

export async function verifySubscriberToken(cfg: Config, id: number, purpose: string, token: string) {
  const key = cfg.env.LINK_SECRET;
  if (typeof key !== "string" || !key || !token || !Number.isInteger(id)) return false;
  return safeEqual(await sign(key, `sub${id}`, purpose, "v1"), token);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function actionUrl(cfg: Config, code: string, who: string, action: LinkAction): Promise<string> {
  const base = secret(cfg, "PUBLIC_BASE_URL").replace(/\/$/, "");
  const t = await sign(secret(cfg, "LINK_SECRET"), code, who, action);
  return `${base}/d/${code}?who=${encodeURIComponent(who)}&a=${action}&t=${t}`;
}

export async function verifyLink(cfg: Config, code: string, who: string, action: string, token: string) {
  const key = cfg.env.LINK_SECRET;
  if (typeof key !== "string" || !key || !token) return false;
  const expected = await sign(key, code.toUpperCase(), who, action);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
