/**
 * "Continue with Google" and "Sign in with Apple" (OpenID Connect).
 *
 * Flow: /start sets a short-lived signed cookie holding a random state, nonce and PKCE verifier,
 * then redirects to the provider. The provider sends the person back to /callback with a code;
 * we check the state against the cookie, swap the code for an ID token over a direct HTTPS call,
 * and verify that token ourselves: RS256 signature against the provider's published keys, issuer,
 * audience (our client id), expiry, our nonce, and that the provider verified the email.
 *
 * A provider is offered only when its secrets are set:
 *   Google: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   Apple:  APPLE_CLIENT_ID (the Services ID), APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (.p8 contents)
 */
import { type Config, secret } from "./config";
import { b64url, randomToken, safeEqual, unb64url, Vault } from "./crypto";

export type Provider = "google" | "apple";
export const OAUTH_COOKIE = "__Host-fr_oauth";
const STATE_MINUTES = 10;

const s = (cfg: Config, k: string) => (typeof cfg.env[k] === "string" ? (cfg.env[k] as string).trim() : "");

export function providersEnabled(cfg: Config): Provider[] {
  const out: Provider[] = [];
  if (s(cfg, "GOOGLE_CLIENT_ID") && s(cfg, "GOOGLE_CLIENT_SECRET")) out.push("google");
  if (s(cfg, "APPLE_CLIENT_ID") && s(cfg, "APPLE_TEAM_ID") && s(cfg, "APPLE_KEY_ID") && s(cfg, "APPLE_PRIVATE_KEY")) out.push("apple");
  return out;
}

const base = (cfg: Config) => secret(cfg, "PUBLIC_BASE_URL").replace(/\/$/, "");
export const redirectUri = (cfg: Config, p: Provider) => `${base(cfg)}/api/auth/oauth/${p}/callback`;

interface FlowState { p: Provider; state: string; nonce: string; verifier: string; exp: number }

async function pkceChallenge(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** Where to send the browser, plus the Set-Cookie that remembers this attempt. */
export async function startFlow(cfg: Config, vault: Vault, p: Provider): Promise<{ url: string; cookie: string }> {
  const st: FlowState = { p, state: randomToken(24), nonce: randomToken(24), verifier: randomToken(48),
    exp: Math.floor(Date.now() / 1000) + STATE_MINUTES * 60 };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(st)));
  const sig = await vault.hmac("oauth-state-v1", payload);
  // SameSite=None: Apple returns with a cross-site POST, which wouldn't carry a Lax cookie.
  const cookie = `${OAUTH_COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${STATE_MINUTES * 60}`;
  const q = new URLSearchParams({ redirect_uri: redirectUri(cfg, p), response_type: "code", state: st.state, nonce: st.nonce });
  if (p === "google") {
    q.set("client_id", s(cfg, "GOOGLE_CLIENT_ID"));
    q.set("scope", "openid email profile");
    q.set("code_challenge", await pkceChallenge(st.verifier));
    q.set("code_challenge_method", "S256");
    q.set("prompt", "select_account");
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, cookie };
  }
  q.set("client_id", s(cfg, "APPLE_CLIENT_ID"));
  q.set("scope", "name email");
  q.set("response_mode", "form_post");
  return { url: `https://appleid.apple.com/auth/authorize?${q}`, cookie };
}

export const clearOauthCookie = () => `${OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`;

/** Reads and checks the flow cookie against the returned state. */
export async function readFlow(vault: Vault, cookieValue: string | null, p: Provider, returnedState: string): Promise<FlowState | null> {
  if (!cookieValue) return null;
  const [payload, sig] = cookieValue.split(".");
  if (!payload || !sig || !safeEqual(await vault.hmac("oauth-state-v1", payload), sig)) return null;
  let st: FlowState;
  try { st = JSON.parse(new TextDecoder().decode(unb64url(payload))); } catch { return null; }
  if (st.p !== p || st.exp < Math.floor(Date.now() / 1000) || !returnedState || !safeEqual(st.state, returnedState)) return null;
  return st;
}

export interface Identity { provider: Provider; subject: string; email: string; name: string | null }

/** Exchanges the code and returns the verified identity. Throws with a safe message on any problem. */
export async function finishFlow(cfg: Config, st: FlowState, code: string, appleUser: string | null,
                                 fetcher: typeof fetch = fetch.bind(globalThis)): Promise<Identity> {
  if (!code || code.length > 2048) throw new OAuthError("missing code");
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri(cfg, st.p) });
  let clientId: string;
  if (st.p === "google") {
    clientId = s(cfg, "GOOGLE_CLIENT_ID");
    body.set("client_id", clientId);
    body.set("client_secret", s(cfg, "GOOGLE_CLIENT_SECRET"));
    body.set("code_verifier", st.verifier);
  } else {
    clientId = s(cfg, "APPLE_CLIENT_ID");
    body.set("client_id", clientId);
    body.set("client_secret", await appleClientSecret(cfg));
  }
  const tokenUrl = st.p === "google" ? "https://oauth2.googleapis.com/token" : "https://appleid.apple.com/auth/token";
  const res = await fetcher(tokenUrl, { method: "POST", body,
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } });
  if (!res.ok) throw new OAuthError(`token exchange failed (${res.status})`);
  const tok = await res.json() as { id_token?: string };
  if (!tok.id_token) throw new OAuthError("no id_token");

  const claims = await verifyIdToken(tok.id_token, st.p, clientId, fetcher);
  if (!claims.nonce || !safeEqual(String(claims.nonce), st.nonce)) throw new OAuthError("nonce mismatch");
  const verified = claims.email_verified === true || claims.email_verified === "true";
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email || !verified) throw new OAuthError("email not verified by provider");

  let name: string | null = typeof claims.name === "string" ? claims.name : null;
  if (!name && appleUser) { // Apple sends the name once, on the first sign-in, outside the token
    try {
      const u = JSON.parse(appleUser) as { name?: { firstName?: string; lastName?: string } };
      name = [u.name?.firstName, u.name?.lastName].filter(Boolean).join(" ") || null;
    } catch { /* ignore */ }
  }
  return { provider: st.p, subject: String(claims.sub), email, name: name ? name.slice(0, 60) : null };
}

export class OAuthError extends Error {}

// ---------------- ID token verification ----------------

const ISSUERS: Record<Provider, string[]> = {
  google: ["https://accounts.google.com", "accounts.google.com"],
  apple: ["https://appleid.apple.com"],
};
const JWKS: Record<Provider, string> = {
  google: "https://www.googleapis.com/oauth2/v3/certs",
  apple: "https://appleid.apple.com/auth/keys",
};
const keyCache = new Map<string, { keys: JsonWebKey[]; at: number }>();

async function providerKeys(p: Provider, fetcher: typeof fetch, refresh = false): Promise<JsonWebKey[]> {
  const c = keyCache.get(p);
  if (c && !refresh && Date.now() - c.at < 3_600_000) return c.keys;
  const r = await fetcher(JWKS[p]);
  if (!r.ok) throw new OAuthError("couldn't fetch signing keys");
  const keys = ((await r.json()) as { keys: JsonWebKey[] }).keys ?? [];
  keyCache.set(p, { keys, at: Date.now() });
  return keys;
}

export async function verifyIdToken(jwt: string, p: Provider, audience: string, fetcher: typeof fetch,
                                    now = Math.floor(Date.now() / 1000)): Promise<Record<string, unknown>> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new OAuthError("malformed token");
  const dec = (x: string) => JSON.parse(new TextDecoder().decode(unb64url(x)));
  const header = dec(parts[0]) as { alg?: string; kid?: string };
  const claims = dec(parts[1]) as Record<string, unknown>;
  if (header.alg !== "RS256" || !header.kid) throw new OAuthError("unexpected token algorithm");
  let jwk = (await providerKeys(p, fetcher)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) jwk = (await providerKeys(p, fetcher, true)).find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) throw new OAuthError("unknown signing key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, unb64url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new OAuthError("bad signature");
  if (!ISSUERS[p].includes(String(claims.iss))) throw new OAuthError("wrong issuer");
  const aud = claims.aud;
  if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) throw new OAuthError("wrong audience");
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new OAuthError("token expired");
  if (typeof claims.iat === "number" && claims.iat > now + 300) throw new OAuthError("token from the future");
  if (!claims.sub) throw new OAuthError("no subject");
  return claims;
}

// ---------------- Apple client secret (ES256 JWT) ----------------

async function appleClientSecret(cfg: Config): Promise<string> {
  const pem = s(cfg, "APPLE_PRIVATE_KEY").replace(/\\n/g, "\n");
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: "ES256", kid: s(cfg, "APPLE_KEY_ID"), typ: "JWT" });
  const body = enc({ iss: s(cfg, "APPLE_TEAM_ID"), iat: now, exp: now + 300, aud: "https://appleid.apple.com",
    sub: s(cfg, "APPLE_CLIENT_ID") });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
