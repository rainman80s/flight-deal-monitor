/**
 * HTTP routes.
 *
 * Twilio webhooks (signature-checked in live mode):
 *   POST /voice/deal/<code>?who=NAME     call script: deal details + "press 1 / 2"
 *   POST /voice/answer/<code>?who=NAME   handles the keypress
 *   POST /voice/confirm/<code>?who=NAME  handles "press 9 to confirm"
 *   POST /sms                            inbound texts: BUY <code>, YES <code>, SKIP <code>
 *
 * Admin (needs header  Authorization: Bearer <ADMIN_TOKEN>):
 *   GET  /admin/status                   recent deals + bookings
 *   POST /admin/run                      run a search cycle now
 *   POST /admin/simulate?code=&who=&verb=buy|yes|skip   act like a text reply (dry run only)
 *
 *   GET  /health
 */
import { executeBuy, maxTotal, needsConfirmation, requestBuy, travelersFor } from "./booking";
import { type Config, contactByName, contactByPhone, secret } from "./config";
import { dealSpeech } from "./messages";
import type { BookingProvider, Deal, FareProvider } from "./models";
import { runCycle } from "./monitor";
import type { Store } from "./store";
import { gather, message, type Notifier, pause, redirect, say, twiml, validTwilioRequest } from "./twilio";

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

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const { cfg, store, notifier } = deps;
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") {
    return json({ ok: true, dry_run: cfg.dryRun, booking_enabled: cfg.bookingEnabled,
                  cycle: await store.getState("cycle") ?? "0" });
  }

  if (path.startsWith("/admin/")) return admin(req, url, deps);

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
  if (typeof token !== "string" || !token || req.headers.get("Authorization") !== `Bearer ${token}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (url.pathname === "/admin/status" && req.method === "GET") {
    return json({ deals: await store.recentDeals(20), bookings: await store.bookings(20) });
  }
  if (url.pathname === "/admin/run" && req.method === "POST") {
    const r = await runCycle(cfg, store, deps.fareProvider(), notifier);
    return json({ ...r, deals: r.deals.map((d) => `${d.code} ${d.origin}-${d.destination} $${d.price}`) });
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
