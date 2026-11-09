/**
 * One search run (cron, hourly): search -> remember prices -> decide shown/pinged -> save and ping.
 *
 *   Search:   every few runs Google Explore (one airport to everywhere); otherwise Ignav
 *             route checks (a month of departure dates per request), or the mock in dry run.
 *   Remember: every price seen goes into the price history, so each route learns its usual price.
 *   Decide:   a fare is *shown* if it passes its category's timing, trip length and show-under
 *             price (Logic panel). It *pings* if it's good enough (baselines.ts pingReason).
 *             Estimates (calendar / Google prices) are confirmed with one exact search before
 *             pinging.
 */
import { type Baseline, pingReason, PriceHistory } from "./baselines";
import { BudgetExceeded } from "./budget";
import { CheckStore } from "./checks";
import { catOf, type Config, kindOf } from "./config";
import { localParts } from "./dates";
import { actionUrl } from "./links";
import { buyMeaning, dealEmail, dealText } from "./messages";
import { type Deal, type Fare, type FareProvider, NotImplementedError } from "./models";
import type { Notifier } from "./notify";
import { planCalendar, planCycle } from "./planner";
import { cheapestPerRoute, rejectionReason } from "./rules";
import { type ExploreClient, exploreFares } from "./serpapi";
import type { Store } from "./store";
import { notifySubscribers, type SubscriberStore } from "./subscribers";

export interface CycleResult {
  cycle: number; searches: number; errors: number; faresSeen: number; deals: Deal[]; suppressed: number;
  subscribersEmailed: number;
  /** Deals saved for the site this run (pinged or not). */
  shown: number;
  /** Set when a paid-request limit stopped the run early. */
  budgetStopped?: string;
  notes?: string[];
  mode?: "explore" | "scan";
}

export function inQuietHours(cfg: Config, now: Date): boolean {
  const h = localParts(now, cfg.timezone).hour;
  const s = cfg.quietStart, e = cfg.quietEnd;
  if (s === e) return false;
  return s > e ? h >= s || h < e : h >= s && h < e;
}

async function alert(cfg: Config, store: Store, notifier: Notifier, d: Deal, call: boolean) {
  const kind = kindOf(cfg, d);
  const why = d.ping_reason ?? `under $${catOf(cfg, d).alert.under}`;
  for (const c of cfg.contacts) {
    if (cfg.channels.includes("email") && c.email) {
      try {
        const msg = dealEmail(d, kind, why, await actionUrl(cfg, d.code, c.name, "buy"),
          await actionUrl(cfg, d.code, c.name, "skip"), buyMeaning(cfg.dryRun, cfg.bookingEnabled, !!d.is_fake));
        await notifier.email(c.email, msg);
      } catch (e) { console.error(`email to ${c.name} failed`, e); }
    }
    if (cfg.channels.includes("sms") && c.phone) {
      const body = dealText(d, kind, why, cfg.bookingEnabled && !cfg.dryRun);
      try { await notifier.sms(c.phone, body); } catch (e) { console.error(`text to ${c.name} failed`, e); }
    }
    if (call && cfg.channels.includes("call") && c.phone) {
      try { await notifier.call(c.phone, d.code, c.name); } catch (e) { console.error(`call to ${c.name} failed`, e); }
    }
  }
  await store.markAlerted(d.id);
}

/** Google Explore, used every `every`-th run instead of the route-by-route scan. */
export interface ExploreSetup { client: ExploreClient; every: number }

function note(r: CycleResult, line: string) {
  r.notes = [...(r.notes ?? []), line];
  console.log(line);
}

/** One Explore run: Google's cheapest round trip from one home airport to everywhere it shows. */
async function exploreRun(cfg: Config, explore: ExploreSetup, cycle: number, r: CycleResult): Promise<Fare[]> {
  const origin = cfg.origins[Math.floor(cycle / explore.every) % cfg.origins.length];
  try {
    const dests = await explore.client.explore(origin, { travelDuration: cfg.exploreTravelDuration,
      stops: cfg.maxConnections === 0 ? 1 : cfg.maxConnections === 1 ? 2 : 3 });
    r.searches++;
    const leads = exploreFares(origin, dests);
    r.faresSeen += leads.length;
    note(r, `Google Explore from ${origin}: ${leads.length} destinations`);
    return leads;
  } catch (e) {
    if (e instanceof BudgetExceeded) { r.budgetStopped = e.message; console.log(e.message); return []; }
    r.searches++;
    r.errors++;
    console.warn(`explore ${origin} failed: ${e}`);
    return [];
  }
}

/** Estimates (price calendars, Google Explore) are confirmed with an exact search before pinging. */
const isEstimate = (f: Fare) => f.provider === "ignav-calendar" || f.provider === "google-explore";

interface Candidate { fare: Fare; base: Baseline | null; reason: string | null }

export async function runCycle(cfg: Config, store: Store, provider: FareProvider, notifier: Notifier,
                               now = new Date(), subs?: SubscriberStore, explore?: ExploreSetup): Promise<CycleResult> {
  const today = localParts(now, cfg.timezone).date;
  const cycle = await store.nextCycle();
  await store.setState("last_cycle_at", now.toISOString());
  const r: CycleResult = { cycle, searches: 0, errors: 0, faresSeen: 0, deals: [], suppressed: 0,
                           subscribersEmailed: 0, shown: 0 };
  const history = new PriceHistory(cfg.env.DB);

  // 1. Search.
  const exploreTurn = !!explore && explore.every > 0 && cycle % explore.every === 0;
  r.mode = exploreTurn ? "explore" : "scan";
  const fares: Fare[] = exploreTurn ? await exploreRun(cfg, explore!, cycle, r) : [];
  const queries = exploreTurn ? [] : provider.name === "ignav"
    ? planCalendar(cfg, cycle, today, cfg.calendarPerRun)
    : planCycle(cfg, cycle, today);
  for (const q of queries) { // one at a time, so request budgets are never overshot
    try {
      const found = await provider.search(q);
      r.searches++;
      r.faresSeen += found.length;
      fares.push(...found);
    } catch (e) {
      if (e instanceof NotImplementedError) throw e;
      if (e instanceof BudgetExceeded) { r.budgetStopped = e.message; console.log(e.message); break; }
      r.searches++;
      r.errors++;
      console.warn(`search ${q.origin}-${q.destination} ${q.departDate}/${q.returnDate} failed: ${e}`);
    }
  }
  for (const n of provider.notes ?? []) note(r, n);

  // 2. Remember every price seen.
  try {
    if (exploreTurn) await history.recordFares(fares.filter((f) => !f.isFake), "explore", now);
    for (const c of provider.checks ?? []) {
      await history.recordCalendar(c.origin, c.destination, c.stayDays, c.days, "calendar", now);
    }
    if (cycle % 24 === 0) await history.prune(now);
  } catch (e) { console.error("saving price history failed", e); }
  if (provider.checks?.length) {
    const saved = new CheckStore(cfg.env.DB);
    for (const c of provider.checks) {
      try { await saved.save(c, now); } catch (e) { console.error("saving price check failed", e); }
    }
  }

  // 3. Decide what's shown and what pings.
  let confirmsLeft = exploreTurn ? cfg.exploreVerifyPerRun : cfg.verifyPerRun;
  const candidates: Candidate[] = [];
  for (let f of cheapestPerRoute(fares)) {
    if (rejectionReason(cfg, f, today)) continue;
    const rule = catOf(cfg, f).alert;
    let base = await history.baseline(f.origin, f.destination, rule.minSamples, now);
    let reason = pingReason(f.price, rule, base);
    if (reason && isEstimate(f) && provider.confirm) {
      const where = `${f.origin}-${f.destination} ${f.departDate}/${f.returnDate} ~$${Math.round(f.price)}`;
      if (confirmsLeft <= 0) {
        reason = null; // shown for now; it comes up again and gets confirmed then
        note(r, `${where}: worth a ping, not confirmed this run (confirmation limit)`);
      } else {
        confirmsLeft--;
        try {
          const exact = await provider.confirm(f);
          if (!exact) {
            note(r, `${where}: not confirmed (no bookable fare found)`);
            continue;
          }
          note(r, `${where}: confirmed at $${exact.price}`);
          f = exact;
          if (rejectionReason(cfg, f, today)) continue;
          base = await history.baseline(f.origin, f.destination, rule.minSamples, now);
          reason = pingReason(f.price, rule, base);
        } catch (e) {
          // Couldn't confirm (request limit or error): keep the estimate and still ping.
          note(r, `${where}: couldn't confirm (${e instanceof BudgetExceeded ? "request limit" : "error"}), using the estimate`);
        }
      }
    }
    candidates.push({ fare: f, base, reason });
  }

  // 4. Save and ping. Best deals first: furthest below usual (or below the alert price).
  const goodness = (c: Candidate) =>
    c.base ? c.fare.price / c.base.median : c.fare.price / catOf(cfg, c.fare).alert.under;
  candidates.sort((a, b) => Number(!!b.reason) - Number(!!a.reason) || goodness(a) - goodness(b));
  const quiet = inQuietHours(cfg, now);
  let pinged = 0;
  for (const c of candidates) {
    const f = c.fare;
    const ping = !!c.reason && pinged < cfg.maxAlertsPerCycle && await store.shouldAlert(f, cfg.realertDropPercent);
    if (!ping && await store.recentlyShown(f, 24)) { r.suppressed++; continue; }
    if (ping && provider.bookingLink && f.offerId) {
      try { f.bookingUrl = (await provider.bookingLink(f.offerId)) ?? f.bookingUrl; }
      catch (e) { console.warn(`booking link for ${f.origin}-${f.destination} skipped: ${e}`); }
    }
    const d = await store.addDeal(f, { typicalLow: c.base?.low, typicalHigh: c.base?.high,
      typicalMedian: c.base?.median, pingReason: ping ? c.reason : null });
    r.shown++;
    if (!ping) continue;
    await alert(cfg, store, notifier, d, !quiet && pinged < cfg.maxCallsPerCycle);
    pinged++;
    if (subs) r.subscribersEmailed += await notifySubscribers(cfg, subs, notifier, d);
    r.deals.push((await store.deal(d.id))!);
  }

  console.log(`cycle ${cycle} (${r.mode}): ${r.searches} searches (${r.errors} errors), ${r.faresSeen} fares, `
    + `${r.shown} shown, ${r.deals.length} pinged, ${r.suppressed} already-known`);
  return r;
}
