/**
 * HTTP routes.
 *
 * Twilio webhooks (signature-checked in live mode):
 *   POST /voice/deal/<code>?who=NAME     call script: deal details + "press 1 / 2"
 *   POST /voice/answer/<code>?who=NAME   handles the keypress
 *   POST /voice/confirm/<code>?who=NAME  handles "press 9 to confirm"
 *   POST /sms                            inbound texts: BUY <code>, YES <code>, SKIP <code>
 *
 * Email buttons (signed links, see links.ts):
 *   GET  /d/<code>?who=&a=buy|skip&t=   confirmation page (GET never acts: mail scanners prefetch links)
 *   POST /d/<code>                       performs the action
 *
 * Admin (needs header  Authorization: Bearer <ADMIN_TOKEN>):
 *   GET  /admin/status                   recent deals + bookings
 *   POST /admin/run                      run a search cycle now
 *   POST /admin/test-email              email the latest deal now (works in dry run)
 *   POST /admin/simulate?code=&who=&verb=buy|yes|skip   act like a text reply (dry run only)
 *
 *   GET  /health
 */
import { checkInstagram } from "./instagram";
import { executeBuy, maxTotal, needsConfirmation, requestBuy, travelersFor } from "./booking";
import { type Config, contactByName, contactByPhone, kindOf, limitOf, secret } from "./config";
import { dealSpeech } from "./messages";
import type { BookingProvider, Deal, FareProvider } from "./models";
import { runCycle } from "./monitor";
import type { Store } from "./store";
import { frameFor } from "./email";
import { escHtml, page } from "./html";
import { actionUrl, verifyLink } from "./links";
import { ignavBudget, makeExplore, serpapiBudget } from "./providers";
import { accountRoute, MUST_CHANGE_ALLOWED } from "./account";
import { currentSession, sameOrigin } from "./auth";
import { billingRoute, setupStripe } from "./billing";
import { safeEqual } from "./crypto";
import { ensureAdmins, UserStore } from "./users";
import { ownerRoute } from "./owner";
import { siteRoute } from "./site";
import { staticFile } from "./static";
import { buyMeaning, city, dealEmail, destCity } from "./messages";
import { type Notifier, ResendEmailer } from "./notify";
import { gather, message, pause, redirect, say, twiml, validTwilioRequest } from "./twilio";

export interface Deps {
  cfg: Config;
  store: Store;
  notifier: Notifier;
  fareProvider: () => FareProvider;
  bookingProvider?: BookingProvider;
  /** Run work after the response is sent (ctx.waitUntil in production). */
  background: (p: Promise<unknown>) => void;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } });

/**
 * Headers every response gets. The CSP allows only this site's own scripts, styles, images and
 * fonts (no third-party code at all); inline styles are allowed for the small server-rendered pages.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; "
    + "img-src 'self' data:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; form-action 'self' https://appleid.apple.com; "
    + "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** Cross-site POSTs these paths must accept: Stripe's webhook (signature-checked) and Apple's form_post return (state-checked). */
const CROSS_SITE_OK = new Set(["/api/billing/webhook", "/api/auth/oauth/apple/callback"]);

export async function handle(req: Request, deps: Deps): Promise<Response> {
  let res: Response;
  try {
    res = await route(req, deps);
  } catch (e) {
    console.error("unhandled", new URL(req.url).pathname, (e as Error).message);
    res = new Response(JSON.stringify({ ok: false, error: "Something went wrong on our side. Try again." }),
      { status: 500, headers: { "Content-Type": "application/json" } });
  }
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

async function route(req: Request, deps: Deps): Promise<Response> {
  const { cfg, store, notifier } = deps;
  const url = new URL(req.url);
  const path = url.pathname;

  // Central CSRF guard: any state-changing API call must come from this site's own pages.
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (unsafe && path.startsWith("/api/") && !CROSS_SITE_OK.has(path) && !sameOrigin(cfg, req)) {
    return new Response(JSON.stringify({ ok: false, error: "Bad origin." }), { status: 403, headers: { "Content-Type": "application/json" } });
  }
  // Someone signed in with a starting password must change it before doing anything else.
  if (path.startsWith("/api/") && !MUST_CHANGE_ALLOWED.has(path) && !CROSS_SITE_OK.has(path)) {
    const s = await currentSession(cfg, req);
    if (s?.user.mustChangePassword) {
      return new Response(JSON.stringify({ ok: false, code: "must_change_password", error: "Change your password first." }),
        { status: 403, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
  }

  if (path === "/health") {
    return json({ ok: true, dry_run: cfg.dryRun, booking_enabled: cfg.bookingEnabled,
                  cycle: await store.getState("cycle") ?? "0" });
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const base = typeof cfg.env.PUBLIC_BASE_URL === "string" ? cfg.env.PUBLIC_BASE_URL.replace(/\/$/, "") : url.origin;
    const file = staticFile(path, base);
    if (file) return file;
  }

  if (path.startsWith("/api/") || path.startsWith("/u/")) {
    const res = (await accountRoute(req, url, deps)) ?? (await billingRoute(req, url, deps))
      ?? (await ownerRoute(req, url, deps)) ?? (await siteRoute(req, url, deps));
    if (res) return res;
  }

  if (path.startsWith("/admin/")) {
    try {
      return await admin(req, url, deps);
    } catch (e) {
      console.error("admin error", e);
      return json({ error: (e as Error).message }, 500);
    }
  }

  const link = path.match(/^\/d\/([A-Z0-9]+)$/i);
  if (link) return emailAction(req, url, link[1].toUpperCase(), deps);

  if (req.method !== "POST") return new Response("Not found", { status: 404 });

  // ---- everything below is a Twilio webhook ----
  const form: Record<string, string> = {};
  const ct = req.headers.get("Content-Type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    for (const [k, v] of new URLSearchParams(await req.text())) form[k] = v;
  }
  if (!cfg.dryRun) {
    const ok = await validTwilioRequest(secret(cfg, "TWILIO_AUTH_TOKEN"), req.url, form,
      req.headers.get("X-Twilio-Signature") ?? "");
    if (!ok) {
      console.warn(`rejected unsigned request to ${path}`);
      return new Response("Forbidden", { status: 403 });
    }
  }

  const startBooking = (d: Deal, who: string) =>
    deps.background(executeBuy(cfg, store, notifier, d, who, deps.bookingProvider)
      .catch((e) => console.error("booking job crashed", e)));

  const voice = path.match(/^\/voice\/(deal|answer|confirm)\/([A-Z0-9]+)$/i);
  if (voice) {
    const [, step, code] = voice;
    const who = url.searchParams.get("who") ?? "";
    if (!contactByName(cfg, who)) return new Response("Unknown contact", { status: 400 });
    const d = await store.dealByCode(code);
    if (!d) return new Response("Unknown deal", { status: 404 });
    const q = `?who=${encodeURIComponent(who)}`;

    if (step === "deal") {
      return twiml(
        gather(`/voice/answer/${d.code}${q}`,
          say(dealSpeech(d)) + pause(1) + say("Press 1 to buy. Press 2 to skip. Press 3 to hear that again."))
        + say("No answer received. The details are in your texts. Goodbye."));
    }

    if (step === "answer") {
      const digit = form.Digits ?? "";
      if (digit === "1") {
        if (needsConfirmation(cfg, d)) {
          await requestBuy(cfg, store, d, who, "call");
          const travelers = travelersFor(cfg, who);
          const total = maxTotal(cfg, d, travelers).toFixed(0);
          return twiml(
            gather(`/voice/confirm/${d.code}${q}`,
              say(`To confirm buying this ticket for ${travelers.join(" and ").toLowerCase()}, at up to `
                + `${total} dollars total, which is likely nonrefundable, press 9. Press any other key to cancel.`), 10)
            + say("Not confirmed. Nothing was purchased. Goodbye."));
        }
        await store.addResponse(d.id, who, "buy_requested", "call");
        startBooking(d, who);
        return twiml(say("Got it. I'm texting you the details now. Goodbye."));
      }
      if (digit === "2") {
        await store.addResponse(d.id, who, "skip", "call");
        return twiml(say("Skipped. Goodbye."));
      }
      return twiml(redirect(`/voice/deal/${d.code}${q}`));
    }

    // confirm
    if (form.Digits === "9" && needsConfirmation(cfg, d)) {
      await store.addResponse(d.id, who, "confirmed", "call");
      startBooking(d, who);
      return twiml(say("Confirmed. Checking the price and booking now. You'll get a text with the result "
        + "in a minute. Goodbye."));
    }
    await store.addResponse(d.id, who, "cancelled", "call");
    return twiml(say("Cancelled. Nothing was purchased. Goodbye."));
  }

  if (path === "/sms") {
    const contact = contactByPhone(cfg, form.From ?? "");
    if (!contact) return twiml(); // ignore strangers silently
    const reply = await smsReply(deps, contact.name, form.Body ?? "", startBooking);
    return twiml(reply ? message(reply) : "");
  }

  return new Response("Not found", { status: 404 });
}

async function smsReply(deps: Deps, who: string, text: string,
                        startBooking: (d: Deal, who: string) => void): Promise<string | null> {
  const { cfg, store } = deps;
  const words = text.trim().toUpperCase().split(/\s+/);
  if (words.length !== 2 || !["BUY", "YES", "SKIP"].includes(words[0])) {
    return "Reply BUY <code>, YES <code> or SKIP <code>, e.g. BUY K7Q2.";
  }
  const [verb, code] = words;
  const d = await store.dealByCode(code);
  if (!d) return `No deal with code ${code}.`;
  if (verb === "SKIP") {
    await store.addResponse(d.id, who, "skip", "sms");
    return `Skipped ${code}.`;
  }
  if (verb === "BUY") {
    if (needsConfirmation(cfg, d)) return requestBuy(cfg, store, d, who, "sms");
    await store.addResponse(d.id, who, "buy_requested", "sms");
    startBooking(d, who);
    return null; // the result arrives as its own text
  }
  // YES
  if (!needsConfirmation(cfg, d)) return `Nothing to confirm for ${code}.`;
  if (await store.latestResponse(d.id, who) !== "buy_requested") return `Reply BUY ${code} first.`;
  await store.addResponse(d.id, who, "confirmed", "sms");
  startBooking(d, who);
  return `Confirmed ${code}. Re-checking the price and booking now...`;
}

async function admin(req: Request, url: URL, deps: Deps): Promise<Response> {
  const { cfg, store, notifier } = deps;
  const token = cfg.env.ADMIN_TOKEN;
  if (typeof token !== "string" || token.length < 16 || !safeEqual(req.headers.get("Authorization") ?? "", `Bearer ${token}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (url.pathname === "/admin/status" && req.method === "GET") {
    return json({ provider: cfg.provider, dry_run: cfg.dryRun, ignav_requests: await ignavBudget(cfg).usage(),
      serpapi_searches: await serpapiBudget(cfg).usage(), explore_enabled: !!makeExplore(cfg),
      deals: await store.recentDeals(20), bookings: await store.bookings(20) });
  }
  if (url.pathname === "/admin/instagram/check" && req.method === "GET") {
    return json(await checkInstagram(cfg));
  }
  if (url.pathname === "/admin/stripe/setup" && req.method === "POST") {
    return json(await setupStripe(cfg));
  }
  if (url.pathname === "/admin/seed-admins" && req.method === "POST") {
    return json({ created_or_reset: await ensureAdmins(cfg) });
  }
  if (url.pathname === "/admin/run" && req.method === "POST") {
    // ?mode=explore forces a Google Explore run (one SerpApi search); ?mode=scan forces route checks.
    const mode = url.searchParams.get("mode");
    const explore = mode === "scan" ? undefined : makeExplore(cfg, mode === "explore" ? 1 : cfg.exploreEvery);
    const r = await runCycle(cfg, store, deps.fareProvider(), notifier, new Date(), true, explore);
    return json({ ...r, deals: r.deals.map((d) => `${d.code} ${d.origin}-${d.destination} $${d.price}`) });
  }
  if (url.pathname === "/admin/test-email" && req.method === "POST") {
    // Sends one real alert email for the most recent deal, even in dry run, so the email
    // path can be tried before real fares are flowing.
    const d = (await store.recentDeals(1))[0];
    if (!d) return json({ error: "no deals yet; POST /admin/run first" }, 400);
    const emailer = new ResendEmailer(secret(cfg, "RESEND_API_KEY"), String(cfg.env.EMAIL_FROM ?? cfg.emailFrom));
    const kind = kindOf(cfg, d);
    const sent: string[] = [];
    for (const c of cfg.contacts.filter((c) => c.email)) {
      await emailer.send(c.email, dealEmail(d, kind, d.ping_reason ?? `under $${limitOf(cfg, d)}`,
        await actionUrl(cfg, d.code, c.name, "buy"), await actionUrl(cfg, d.code, c.name, "skip"),
        buyMeaning(cfg.dryRun, cfg.bookingEnabled, !!d.is_fake), frameFor(cfg)));
      sent.push(c.name);
    }
    return json({ deal: d.code, sent });
  }
  if (url.pathname === "/admin/simulate" && req.method === "POST") {
    if (!cfg.dryRun) return json({ error: "simulate only works in dry run" }, 400);
    const who = (url.searchParams.get("who") ?? "").toUpperCase();
    if (!contactByName(cfg, who)) return json({ error: "unknown contact" }, 400);
    const text = `${url.searchParams.get("verb") ?? ""} ${url.searchParams.get("code") ?? ""}`;
    const pending: Promise<unknown>[] = [];
    const reply = await smsReply(deps, who, text, (d, w) => {
      pending.push(executeBuy(cfg, store, notifier, d, w, deps.bookingProvider));
    });
    const results = await Promise.all(pending);
    return json({ reply, results });
  }
  return new Response("Not found", { status: 404 });
}

// ---------------- email buttons ----------------

async function emailAction(req: Request, url: URL, code: string, deps: Deps): Promise<Response> {
  const { cfg, store, notifier } = deps;
  const params: Record<string, string> = {};
  if (req.method === "POST") for (const [k, v] of new URLSearchParams(await req.text())) params[k] = v;
  else if (req.method === "GET") for (const [k, v] of url.searchParams) params[k] = v;
  else return page("Not allowed", "<p>Not allowed.</p>", 405);

  const who = params.who ?? "", action = params.a ?? "", token = params.t ?? "";
  if (!["buy", "skip"].includes(action) || !contactByName(cfg, who)
      || !(await verifyLink(cfg, code, who, action, token))) {
    return page("Invalid link", "<h2>That link isn't valid.</h2><p class=muted>It may be incomplete or altered.</p>", 403);
  }
  const d = await store.dealByCode(code);
  if (!d) return page("Unknown deal", "<h2>Deal not found.</h2>", 404);

  const summary = `<h2>${escHtml(city(d.origin))} → ${escHtml(destCity(d))}</h2>`
    + `<p><b>$${d.price.toFixed(0)}</b> round trip · ${escHtml(d.depart_date)} → ${escHtml(d.return_date)}`
    + ` · deal ${d.code}</p>`;

  if (req.method === "GET") {
    const travelers = travelersFor(cfg, who);
    const hidden = `<input type=hidden name=who value="${escHtml(who)}"><input type=hidden name=a value="${action}">`
      + `<input type=hidden name=t value="${escHtml(token)}">`;
    if (action === "skip") {
      return page("Skip deal", `${summary}<form method=post>${hidden}<button class=skip>Skip this deal</button></form>`);
    }
    const real = needsConfirmation(cfg, d);
    const warn = real
      ? `<p>This will buy for <b>${escHtml(travelers.join(" and "))}</b>, up to `
        + `<b>$${maxTotal(cfg, d, travelers).toFixed(0)}</b> total. The price is re-checked first. `
        + `Tickets are likely <b>nonrefundable</b>.</p>`
      : `<p class=muted>${escHtml(buyMeaning(cfg.dryRun, cfg.bookingEnabled, !!d.is_fake))}</p>`;
    return page("Buy deal", `${summary}${warn}<form method=post>${hidden}`
      + `<button class=buy>${real ? "Confirm purchase" : "Buy"}</button></form>`);
  }

  // POST: act
  if (action === "skip") {
    await store.addResponse(d.id, who, "skip", "email");
    return page("Skipped", `${summary}<p>Skipped. You won't hear about this exact fare again `
      + `unless it drops another ${cfg.realertDropPercent}%.</p>`);
  }
  await store.addResponse(d.id, who, "buy_requested", "email");
  if (needsConfirmation(cfg, d)) await store.addResponse(d.id, who, "confirmed", "email");
  const result = await executeBuy(cfg, store, notifier, d, who, deps.bookingProvider);
  const linked = escHtml(result).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
  return page("Result", `${summary}<p>${linked}</p>`);
}
