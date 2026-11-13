/**
 * Memberships through Stripe ($8/month).
 *
 *   POST /api/billing/checkout   start a Stripe Checkout page for the signed-in member
 *   POST /api/billing/portal     open Stripe's billing portal (card, invoices, cancel)
 *   POST /api/billing/sync       re-read the subscription from Stripe (after returning from Checkout)
 *   POST /api/billing/webhook    Stripe's notifications, signature-checked and handled once each
 *   POST /admin/stripe/setup     one-time: creates the product, price, webhook and portal settings
 *
 * Card details never touch this site: Stripe Checkout collects them on stripe.com.
 * Needs the STRIPE_SECRET_KEY secret. The price id and the webhook signing secret are created by
 * /admin/stripe/setup and kept in D1 (the signing secret encrypted), or can be given as
 * STRIPE_PRICE_ID / STRIPE_WEBHOOK_SECRET secrets instead.
 */
import type { Deps } from "./app";
import { currentSession } from "./auth";
import { type Config, secret } from "./config";
import { accountEmail, sendMail } from "./account";
import { safeEqual } from "./crypto";
import { entitled, type User, UserStore } from "./users";

export const PRICE_CENTS = 800;
/** Free trial for first-time members (0 turns it off). Stripe charges when it ends unless they cancel. */
export const TRIAL_DAYS = 7;
const STRIPE_VERSION = "2024-06-20"; // pinned so field shapes don't change under us
const WEBHOOK_EVENTS = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated",
  "customer.subscription.deleted", "customer.subscription.trial_will_end", "invoice.paid", "invoice.payment_failed"];

/** One trial per account: anyone who has ever had a subscription pays from day one. */
export const trialDaysFor = (u: User) => (u.role !== "admin" && !u.subscriptionId && !u.subscriptionStatus ? TRIAL_DAYS : 0);

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const base = (cfg: Config) => secret(cfg, "PUBLIC_BASE_URL").replace(/\/$/, "");
/**
 * The Pro launch switch. Until PRO_LAUNCHED is "true", nobody can start a subscription and the site
 * shows Pro as "coming soon"; admins and beta testers still get every feature. Existing
 * subscriptions (if any) keep working either way.
 */
export const proLaunched = (cfg: Config) => String(cfg.env.PRO_LAUNCHED ?? "").toLowerCase() === "true";

export const stripeEnabled = (cfg: Config) => typeof cfg.env.STRIPE_SECRET_KEY === "string" && !!cfg.env.STRIPE_SECRET_KEY;

/** Flattens {a: {b: 1}, c: [x]} into Stripe's form encoding: a[b]=1&c[0]=x. */
function form(obj: Record<string, unknown>, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => typeof x === "object" ? form(x as Record<string, unknown>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x)));
    else if (typeof v === "object") form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export class Stripe {
  constructor(private key: string, private fetcher: typeof fetch = fetch.bind(globalThis)) {}
  async call<T = Record<string, unknown>>(method: "GET" | "POST" | "DELETE", path: string,
                                          params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
    const q = form(params);
    const url = `https://api.stripe.com/v1${path}${method === "GET" && [...q].length ? `?${q}` : ""}`;
    const res = await this.fetcher(url, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, "Stripe-Version": STRIPE_VERSION,
        "Content-Type": "application/x-www-form-urlencoded", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      body: method === "GET" ? undefined : q,
    });
    const body = await res.json() as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(`Stripe ${method} ${path} failed: ${res.status} ${body.error?.message ?? ""}`);
    return body;
  }
}

const stripeFor = (cfg: Config) => new Stripe(String(cfg.env.STRIPE_SECRET_KEY));

interface StripeSettings { price_id?: string; webhook_secret_enc?: string; webhook_id?: string; portal_config_id?: string; product_id?: string }

async function loadSettings(cfg: Config): Promise<StripeSettings> {
  const r = await cfg.env.DB.prepare("SELECT value FROM settings WHERE key='stripe'").first<{ value: string }>();
  try { return r ? JSON.parse(r.value) : {}; } catch { return {}; }
}
async function saveSettings(cfg: Config, s: StripeSettings) {
  await cfg.env.DB.prepare(`INSERT INTO settings(key,value,updated_at,updated_by) VALUES('stripe',?,?,'setup')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(JSON.stringify(s), new Date().toISOString().slice(0, 19) + "Z").run();
}
async function priceId(cfg: Config) {
  return typeof cfg.env.STRIPE_PRICE_ID === "string" && cfg.env.STRIPE_PRICE_ID ? cfg.env.STRIPE_PRICE_ID
    : (await loadSettings(cfg)).price_id ?? null;
}
async function webhookSecret(cfg: Config, users: UserStore) {
  if (typeof cfg.env.STRIPE_WEBHOOK_SECRET === "string" && cfg.env.STRIPE_WEBHOOK_SECRET) return cfg.env.STRIPE_WEBHOOK_SECRET;
  const enc = (await loadSettings(cfg)).webhook_secret_enc;
  return enc ? users.vault.open("stripe-webhook", enc) : null;
}

/** What the Account page shows about billing. */
export function subscriptionView(u: User) {
  return {
    status: u.role === "admin" ? "admin" : u.subscriptionStatus ?? "none",
    active: entitled(u),
    renews_at: u.currentPeriodEnd ? new Date(u.currentPeriodEnd * 1000).toISOString() : null,
    cancel_at_period_end: u.cancelAtPeriodEnd,
    price: `$${(PRICE_CENTS / 100).toFixed(0)}/month`,
    can_manage: !!u.stripeCustomerId,
    trial_days: trialDaysFor(u),
  };
}

interface Sub { id: string; status: string; customer: string; current_period_end?: number; cancel_at_period_end?: boolean;
  items?: { data?: { current_period_end?: number }[] }; metadata?: Record<string, string> }

async function applySubscription(users: UserStore, userId: number, s: Sub | null) {
  await users.setSubscription(userId, s
    ? { id: s.id, status: s.status, periodEnd: s.current_period_end ?? s.items?.data?.[0]?.current_period_end ?? null,
        cancelAtPeriodEnd: !!s.cancel_at_period_end }
    : { id: null, status: null, periodEnd: null, cancelAtPeriodEnd: false });
}

/** Re-reads a customer's newest subscription from Stripe and stores it. */
async function syncCustomer(cfg: Config, users: UserStore, u: User) {
  if (!u.stripeCustomerId) return;
  const list = await stripeFor(cfg).call<{ data: Sub[] }>("GET", "/subscriptions",
    { customer: u.stripeCustomerId, status: "all", limit: 5 });
  // Prefer a live one; otherwise the most recent.
  const live = list.data.find((s) => ["active", "trialing", "past_due"].includes(s.status)) ?? list.data[0] ?? null;
  await applySubscription(users, u.id, live);
}

/** Cancels right away (used when an account is deleted). No-op without a live subscription. */
export async function cancelSubscriptionNow(cfg: Config, u: User) {
  if (!stripeEnabled(cfg) || !u.subscriptionId || ["canceled", "incomplete_expired"].includes(u.subscriptionStatus ?? "")) return;
  await stripeFor(cfg).call("DELETE", `/subscriptions/${encodeURIComponent(u.subscriptionId)}`);
}

/** Stripe-Signature check: HMAC-SHA256 of "t.payload", any v1 match, within 5 minutes. */
export async function verifyStripeSignature(payload: string, header: string, signingSecret: string,
                                            now = Math.floor(Date.now() / 1000), toleranceSec = 300): Promise<boolean> {
  const parts = header.split(",").map((x) => x.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => safeEqual(s, expected));
}

export async function billingRoute(req: Request, url: URL, deps: Deps): Promise<Response | null> {
  const { cfg } = deps;
  const p = url.pathname;
  if (!p.startsWith("/api/billing/")) return null;
  if (!stripeEnabled(cfg)) return json({ ok: false, error: "Payments aren't set up yet. Check back soon." }, 503);
  const users = UserStore.for(cfg);

  if (p === "/api/billing/webhook" && req.method === "POST") {
    const payload = await req.text();
    if (payload.length > 1_000_000) return json({ ok: false }, 413);
    const secretKey = await webhookSecret(cfg, users);
    if (!secretKey || !(await verifyStripeSignature(payload, req.headers.get("Stripe-Signature") ?? "", secretKey))) {
      return json({ ok: false, error: "bad signature" }, 400);
    }
    const event = JSON.parse(payload) as { id: string; type: string; data: { object: Record<string, unknown> } };
    const fresh = await cfg.env.DB.prepare("INSERT INTO stripe_events(id,type,received_at) VALUES(?,?,?) ON CONFLICT DO NOTHING")
      .bind(event.id, event.type, new Date().toISOString().slice(0, 19) + "Z").run();
    if ((fresh.meta?.changes ?? 0) === 0) return json({ ok: true, duplicate: true });
    try {
      await handleEvent(cfg, users, event);
    } catch (e) {
      // Let Stripe retry: forget we saw it.
      await cfg.env.DB.prepare("DELETE FROM stripe_events WHERE id=?").bind(event.id).run();
      console.error("stripe webhook failed", event.type, (e as Error).message);
      return json({ ok: false }, 500);
    }
    return json({ ok: true });
  }

  const s = await currentSession(cfg, req);
  if (!s) return json({ ok: false, error: "Sign in first." }, 401);
  const u = s.user;

  if (p === "/api/billing/checkout" && req.method === "POST") {
    if (!proLaunched(cfg)) return json({ ok: false, code: "pro_coming_soon", error: "Pro isn't available yet. Join the list on your Account page and we'll email you when it launches." }, 403);
    if (u.role === "admin" || u.role === "tester") return json({ ok: false, error: "Your account has full access already." }, 400);
    if (entitled(u)) return json({ ok: false, error: "You're already a member. Use Manage billing to make changes." }, 400);
    const price = await priceId(cfg);
    if (!price) return json({ ok: false, error: "Payments aren't set up yet. Check back soon." }, 503);
    const stripe = stripeFor(cfg);
    let customer = u.stripeCustomerId;
    if (!customer) {
      const c = await stripe.call<{ id: string }>("POST", "/customers",
        { email: u.email, metadata: { user_id: String(u.id) } }, `customer-${u.id}`);
      customer = c.id;
      await users.setStripeCustomer(u.id, customer);
    }
    const session = await stripe.call<{ url: string }>("POST", "/checkout/sessions", {
      mode: "subscription", customer, client_reference_id: String(u.id),
      line_items: [{ price, quantity: 1 }],
      subscription_data: { metadata: { user_id: String(u.id) },
        ...(trialDaysFor(u) ? { trial_period_days: trialDaysFor(u) } : {}) },
      // Shown under the pay button, so nobody is surprised by the first charge.
      custom_text: { submit: { message: trialDaysFor(u)
        ? `Free for ${trialDaysFor(u)} days, then $${PRICE_CENTS / 100}/month. Cancel any time before the trial ends and you won't be charged. We'll email you 3 days before it ends.`
        : `$${PRICE_CENTS / 100}/month. Cancel any time from your Account page.` } },
      allow_promotion_codes: "true",
      success_url: `${base(cfg)}/#account?billing=success`,
      cancel_url: `${base(cfg)}/#account?billing=cancelled`,
    });
    return json({ ok: true, url: session.url });
  }

  if (p === "/api/billing/portal" && req.method === "POST") {
    if (!u.stripeCustomerId) return json({ ok: false, error: "There's no billing history on this account yet." }, 400);
    const st = await loadSettings(cfg);
    const session = await stripeFor(cfg).call<{ url: string }>("POST", "/billing_portal/sessions", {
      customer: u.stripeCustomerId, return_url: `${base(cfg)}/#account`,
      ...(st.portal_config_id ? { configuration: st.portal_config_id } : {}),
    });
    return json({ ok: true, url: session.url });
  }

  if (p === "/api/billing/sync" && req.method === "POST") {
    await syncCustomer(cfg, users, u);
    const fresh = (await users.byId(u.id))!;
    return json({ ok: true, subscription: subscriptionView(fresh), entitled: entitled(fresh) });
  }

  return json({ ok: false, error: "Not found." }, 404);
}

async function handleEvent(cfg: Config, users: UserStore, event: { type: string; data: { object: Record<string, unknown> } }) {
  const o = event.data.object;
  const customerId = typeof o.customer === "string" ? o.customer : null;
  if (event.type === "checkout.session.completed") {
    // Link the Stripe customer to the account that started Checkout, if not linked yet.
    const userId = Number(o.client_reference_id);
    if (customerId && Number.isInteger(userId) && userId > 0) {
      const u = await users.byId(userId);
      if (u && !u.stripeCustomerId) await users.setStripeCustomer(u.id, customerId);
    }
  }
  if (!customerId) return;
  const u = await users.byStripeCustomer(customerId);
  if (!u) return; // a customer we don't know (or a deleted account): nothing to update
  if (event.type === "customer.subscription.trial_will_end") {
    // Stripe sends this 3 days before a trial ends: tell them plainly when and how much.
    const end = typeof o.trial_end === "number" ? new Date(o.trial_end * 1000) : null;
    const when = end ? end.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : "in 3 days";
    await sendMail(cfg, u.email, accountEmail(cfg, u.email, {
      subject: "Your Fare Radar free trial ends soon", eyebrow: "Membership", heading: "Your free trial ends soon",
      lead: `Your free trial ends on ${when}. If you keep your membership, you'll be charged $${PRICE_CENTS / 100} then and `
        + "each month after. To stop it, cancel in Manage billing on your Account page before that date and you won't be charged.",
      link: `${base(cfg)}/#account`, cta: "Manage my membership", preheader: `Your trial ends ${when}.`,
      note: "Questions about billing? Reply to this email or use the contact page.",
    }));
    return;
  }
  if (event.type.startsWith("customer.subscription.")) {
    const sub = o as unknown as Sub;
    // Only track this customer's current subscription (or a new one replacing it).
    if (!u.subscriptionId || u.subscriptionId === sub.id || ["active", "trialing"].includes(sub.status)) {
      await applySubscription(users, u.id, sub);
    }
    return;
  }
  // checkout.session.completed, invoice.paid, invoice.payment_failed: re-read the truth.
  await syncCustomer(cfg, users, (await users.byId(u.id))!);
}

/** One-time Stripe setup. Safe to run again: it only creates what's missing. */
export async function setupStripe(cfg: Config) {
  if (!stripeEnabled(cfg)) throw new Error("Set the STRIPE_SECRET_KEY secret first");
  const stripe = stripeFor(cfg);
  const users = UserStore.for(cfg);
  const st = await loadSettings(cfg);
  if (!st.product_id) {
    st.product_id = (await stripe.call<{ id: string }>("POST", "/products", { name: "Fare Radar membership",
      description: "Deal alerts, personal rules and route search." }, "fr-product-v1")).id;
  }
  if (!st.price_id) {
    st.price_id = (await stripe.call<{ id: string }>("POST", "/prices", { product: st.product_id, currency: "usd",
      unit_amount: PRICE_CENTS, recurring: { interval: "month" } }, "fr-price-800-v1")).id;
  }
  if (!st.webhook_secret_enc) {
    const wh = await stripe.call<{ id: string; secret: string }>("POST", "/webhook_endpoints",
      { url: `${base(cfg)}/api/billing/webhook`, enabled_events: WEBHOOK_EVENTS, api_version: STRIPE_VERSION });
    st.webhook_id = wh.id;
    st.webhook_secret_enc = await users.vault.seal("stripe-webhook", wh.secret);
  }
  if (!st.portal_config_id) {
    st.portal_config_id = (await stripe.call<{ id: string }>("POST", "/billing_portal/configurations", {
      business_profile: { headline: "Manage your Fare Radar membership",
        privacy_policy_url: `${base(cfg)}/#privacy`, terms_of_service_url: `${base(cfg)}/#terms` },
      features: { invoice_history: { enabled: "true" }, payment_method_update: { enabled: "true" },
        subscription_cancel: { enabled: "true", mode: "at_period_end" } },
    })).id;
  }
  await saveSettings(cfg, st);
  return { product: st.product_id, price: st.price_id, webhook: st.webhook_id, portal: st.portal_config_id,
    test_mode: String(cfg.env.STRIPE_SECRET_KEY).startsWith("sk_test_") };
}
