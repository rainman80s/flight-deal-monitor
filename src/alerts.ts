/**
 * Deal alerts for members, each judged by that person's own rules.
 *
 * After every hourly search, each new deal is checked against every member who has alerts on,
 * a live membership (admins always count) and a verified email. It must fit their rules (when it
 * leaves, trip length, show limit, home airports) and pass their ping rule (under a price, or far
 * enough below the route's usual price). Each person gets at most 5 alerts per run and 20 per day,
 * and never the same trip twice unless the price dropped meaningfully since.
 *
 * Admins linked to a contact get the owner version with Buy / Skip; everyone else gets a link to
 * book on Google Flights / the airline.
 */
import { type Baseline, pingReason, PriceHistory } from "./baselines";
import { type Config, secret } from "./config";
import { safeEqual } from "./crypto";
import { shortDate } from "./dates";
import { BRAND, button, escHtml, fine, frameFor, layout, p, priceLine, textFooter, unsubscribeHeaders } from "./email";
import { actionUrl } from "./links";
import { buyMeaning, city, dealEmail, destCity, stops, tripDays } from "./messages";
import type { Deal } from "./models";
import type { Notifier } from "./notify";
import { rejectionReason } from "./rules";
import { personalCategories } from "./settings";
import { entitled, type User, UserStore } from "./users";

const PER_RUN = 5;
const PER_DAY = 20;

export async function unsubscribeLink(cfg: Config, userId: number) {
  const t = await UserStore.for(cfg).vault.hmac("unsubscribe-v1", String(userId));
  return `${secret(cfg, "PUBLIC_BASE_URL").replace(/\/$/, "")}/u/unsubscribe?u=${userId}&t=${t}`;
}

export async function verifyUnsubscribe(cfg: Config, userId: number, t: string) {
  if (!Number.isInteger(userId) || userId <= 0 || !t) return false;
  return safeEqual(await UserStore.for(cfg).vault.hmac("unsubscribe-v1", String(userId)), t);
}

export function memberDealEmail(cfg: Config, u: User, d: Deal, kind: string, why: string, unsub: string) {
  const f = frameFor(cfg);
  const airlines = (JSON.parse(d.airlines) as string[]).join(", ");
  const reason = `You're getting this because you turned on deal alerts in your ${BRAND} account (${u.email}).`;
  const subject = `✈ ${city(d.origin)} → ${destCity(d)} $${d.price.toFixed(0)} round trip, `
    + `${shortDate(d.depart_date)}–${shortDate(d.return_date)}`;
  const legs = d.outbound_stops === d.return_stops ? `${stops(d.outbound_stops)} both ways`
    : `${stops(d.outbound_stops)} out, ${stops(d.return_stops)} back`;
  const text = `${d.origin} → ${d.destination} (${destCity(d)}), $${d.price.toFixed(0)} round trip (${kind})\n`
    + `Why: ${why}\n${shortDate(d.depart_date)} → ${shortDate(d.return_date)} (${tripDays(d)} days) · ${legs}`
    + `${airlines ? ` · ${airlines}` : ""}\n\nBook: ${d.booking_url ?? ""}\n\nPrices move fast; check the fare before you pay.\n`
    + textFooter(f, reason, unsub);
  const html = layout(f, {
    preheader: `${why}. ${shortDate(d.depart_date)} to ${shortDate(d.return_date)}.`,
    eyebrow: `Deal alert · ${kind === "international" ? "International" : "Domestic"}`,
    heading: `${escHtml(city(d.origin))} → ${escHtml(destCity(d))}`,
    body: priceLine(`$${d.price.toFixed(0)}`, `round trip · ${tripDays(d)} days`)
      + `<p style="margin:0 0 14px;padding:10px 14px;border-radius:10px;background:#fdf1d8;font-family:-apple-system,Segoe UI,Roboto,sans-serif;`
      + `font-size:15px;color:#6b4705;font-weight:600">Why it's a deal: ${escHtml(why)}</p>`
      + p(`<b style="color:#14262c">${escHtml(shortDate(d.depart_date))} → ${escHtml(shortDate(d.return_date))}</b><br>`
        + `${legs}${airlines ? ` · ${escHtml(airlines)}` : ""}`)
      + (d.booking_url ? `<div style="margin:22px 0 4px">${button(d.booking_url, "See it and book")}</div>` : "")
      + fine("Prices move fast. Check the fare before you pay. We don't earn anything if you book."),
    reason, unsubscribeUrl: unsub,
  });
  return { subject, text, html, headers: unsubscribeHeaders(unsub) };
}

/** True if this user was already told about this trip at a price that isn't meaningfully higher. */
async function alreadyTold(cfg: Config, userId: number, d: Deal): Promise<boolean> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 19) + "Z";
  const r = await cfg.env.DB.prepare(
    `SELECT MIN(deals.price) AS p FROM user_alerts JOIN deals ON deals.id = user_alerts.deal_id
     WHERE user_alerts.user_id=? AND deals.origin=? AND deals.destination=? AND deals.depart_date=? AND deals.return_date=?
       AND user_alerts.sent_at>?`,
  ).bind(userId, d.origin, d.destination, d.depart_date, d.return_date, since).first<{ p: number | null }>();
  return r?.p != null && d.price > r.p * (1 - cfg.realertDropPercent / 100);
}

/** Emails each eligible member about the deals that fit their rules. Returns how many emails went out. */
export async function notifyMembers(cfg: Config, notifier: Notifier, deals: Deal[], now = new Date()): Promise<number> {
  const fresh = deals.filter((d) => !d.is_fake);
  if (!fresh.length || typeof cfg.env.LINK_SECRET !== "string") return 0;
  const users = UserStore.for(cfg);
  const history = new PriceHistory(cfg.env.DB);
  const baseCache = new Map<string, Promise<Baseline | null>>();
  const baseline = (d: Deal, min: number) => {
    const k = `${d.origin}${d.destination}${min}`;
    if (!baseCache.has(k)) baseCache.set(k, history.baseline(d.origin, d.destination, min, now));
    return baseCache.get(k)!;
  };
  const today = now.toISOString().slice(0, 10);
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 19) + "Z";
  let sent = 0;

  for (const u of await users.withAlertsOn()) {
    if (!entitled(u) || !u.emailVerified || u.mustChangePassword) continue;
    const cats = personalCategories(cfg, u.rules);
    const view = { ...cfg, cats } as Config;
    let mine = 0;
    let todayCount = await users.alertsSince(u.id, dayAgo);
    for (const d of fresh) {
      if (mine >= PER_RUN || todayCount >= PER_DAY) break;
      if (!u.origins.includes(d.origin)) continue;
      const kind = d.kind === "domestic" || d.kind === "international" ? d.kind : (cfg.domestic.includes(d.destination) ? "domestic" : "international");
      const fare = { provider: d.provider, origin: d.origin, destination: d.destination, departDate: d.depart_date,
        returnDate: d.return_date, price: d.price, currency: d.currency, airlines: [], outboundStops: 0, returnStops: 0,
        offerId: null, bookingUrl: null, isFake: false, kind };
      if (rejectionReason(view, fare, today)) continue;
      const rule = cats[kind].alert;
      const why = pingReason(d.price, rule, await baseline(d, rule.minSamples));
      if (!why) continue;
      if (await alreadyTold(cfg, u.id, d)) continue;
      if (!(await users.claimAlert(u.id, d.id))) continue;
      try {
        if (u.role === "admin" && u.contact) {
          await notifier.email(u.email, dealEmail(d, kind, why, await actionUrl(cfg, d.code, u.contact, "buy"),
            await actionUrl(cfg, d.code, u.contact, "skip"), buyMeaning(cfg.dryRun, cfg.bookingEnabled, false), frameFor(cfg)));
        } else {
          await notifier.email(u.email, memberDealEmail(cfg, u, d, kind, why, await unsubscribeLink(cfg, u.id)));
        }
        mine++;
        todayCount++;
        sent++;
      } catch (e) {
        console.error(`alert to user ${u.id} failed`, (e as Error).message);
      }
    }
  }
  return sent;
}
