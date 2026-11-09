/** One search cycle: plan -> search -> filter -> dedupe -> alert. Runs on the cron trigger. */
import { type Config, kindOf, limitOf } from "./config";
import { localParts } from "./dates";
import { actionUrl } from "./links";
import { buyMeaning, dealEmail, dealText } from "./messages";
import { type Deal, type Fare, type FareProvider, NotImplementedError } from "./models";
import { planCalendar, planCycle } from "./planner";
import { cheapestPerRoute, rejectionReason } from "./rules";
import type { Store } from "./store";
import { notifySubscribers, type SubscriberStore } from "./subscribers";
import { BudgetExceeded } from "./budget";
import { CheckStore } from "./checks";
import { type ExploreClient, exploreFares } from "./serpapi";
import type { Notifier } from "./notify";

export interface CycleResult {
  cycle: number; searches: number; errors: number; faresSeen: number; deals: Deal[]; suppressed: number;
  subscribersEmailed: number;
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
  const limit = limitOf(cfg, d);
  for (const c of cfg.contacts) {
    if (cfg.channels.includes("email") && c.email) {
      try {
        const msg = dealEmail(d, kind, limit, await actionUrl(cfg, d.code, c.name, "buy"),
          await actionUrl(cfg, d.code, c.name, "skip"), buyMeaning(cfg.dryRun, cfg.bookingEnabled, !!d.is_fake));
        await notifier.email(c.email, msg);
      } catch (e) { console.error(`email to ${c.name} failed`, e); }
    }
    if (cfg.channels.includes("sms") && c.phone) {
      const body = dealText(d, kind, limit, cfg.bookingEnabled && !cfg.dryRun);
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

/**
 * One Explore run: Google's cheapest round trip from one home airport to everywhere.
 * Fares under the limit are confirmed with an exact search from `confirm` (Ignav) when it
 * can, so a stale Google price doesn't trigger an alert; if confirming isn't possible the
 * Google price is used as-is.
 */
async function exploreRun(cfg: Config, explore: ExploreSetup, confirm: FareProvider, cycle: number, today: string,
                          r: CycleResult): Promise<Fare[]> {
  const origin = cfg.origins[Math.floor(cycle / explore.every) % cfg.origins.length];
  const notes: string[] = [];
  let leads: Fare[];
  try {
    const dests = await explore.client.explore(origin, { travelDuration: cfg.exploreTravelDuration,
      stops: cfg.maxConnections === 0 ? 1 : cfg.maxConnections === 1 ? 2 : 3 });
    leads = exploreFares(origin, dests);
    r.searches++;
  } catch (e) {
    if (e instanceof BudgetExceeded) { r.budgetStopped = e.message; console.log(e.message); return []; }
    r.searches++;
    r.errors++;
    console.warn(`explore ${origin} failed: ${e}`);
    return [];
  }
  r.faresSeen += leads.length;
  const hits = leads.filter((f) => !rejectionReason(cfg, f, today))
    .sort((a, b) => a.price / limitOf(cfg, a) - b.price / limitOf(cfg, b));
  notes.push(`Google Explore from ${origin}: ${leads.length} destinations, ${hits.length} under the limit`);

  const out: Fare[] = [];
  for (const [i, lead] of hits.entries()) {
    const limit = limitOf(cfg, lead);
    const where = `${lead.origin}-${lead.destination} ${lead.departDate}/${lead.returnDate} $${lead.price}`;
    if (confirm.name !== "ignav" || i >= cfg.exploreVerifyPerRun) {
      out.push(lead); // nothing to confirm with (or over this run's limit): trust Google's price
      continue;
    }
    try {
      const exact = await confirm.search({ origin: lead.origin, destination: lead.destination,
        departDate: lead.departDate, returnDate: lead.returnDate, maxPrice: limit });
      const best = exact.filter((f) => f.currency === "USD").sort((a, b) => a.price - b.price)[0];
      if (best && best.price < limit) {
        out.push({ ...best, kind: lead.kind, destName: lead.destName });
        notes.push(`${where}: confirmed at $${best.price}`);
      } else {
        notes.push(`${where}: not confirmed (${best ? `now $${best.price}` : "no fare found"})`);
      }
    } catch (e) {
      out.push(lead);
      notes.push(`${where}: couldn't confirm (${e instanceof BudgetExceeded ? "request limit" : "error"}), using Google's price`);
    }
  }
  r.notes = [...(r.notes ?? []), ...notes];
  for (const n of notes) console.log(n);
  return out;
}

export async function runCycle(cfg: Config, store: Store, provider: FareProvider, notifier: Notifier,
                               now = new Date(), subs?: SubscriberStore, explore?: ExploreSetup): Promise<CycleResult> {
  const today = localParts(now, cfg.timezone).date;
  const cycle = await store.nextCycle();
  await store.setState("last_cycle_at", now.toISOString());
  const r: CycleResult = { cycle, searches: 0, errors: 0, faresSeen: 0, deals: [], suppressed: 0, subscribersEmailed: 0 };

  const exploreTurn = !!explore && explore.every > 0 && cycle % explore.every === 0;
  r.mode = exploreTurn ? "explore" : "scan";
  // Paid calendar search (Ignav): a few wide queries per run. Others: exact date pairs.
  const queries = exploreTurn ? [] : provider.name === "ignav"
    ? planCalendar(cfg, cycle, today, cfg.calendarPerRun)
    : planCycle(cfg, cycle, today);
  // One at a time, so a request budget is never overshot; one failure doesn't sink the run.
  const fares: Fare[] = exploreTurn ? await exploreRun(cfg, explore!, provider, cycle, today, r) : [];
  for (const q of queries) {
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

  const candidates: Fare[] = [];
  for (const f of cheapestPerRoute(fares)) {
    if (rejectionReason(cfg, f, today)) continue;
    if (!(await store.shouldAlert(f, cfg.realertDropPercent))) { r.suppressed++; continue; }
    candidates.push(f);
  }

  // Best deals first: lowest price relative to that destination's limit.
  candidates.sort((a, b) => a.price / limitOf(cfg, a) - b.price / limitOf(cfg, b));
  const quiet = inQuietHours(cfg, now);
  for (const [i, f] of candidates.entries()) {
    if (i < cfg.maxAlertsPerCycle && provider.bookingLink && f.offerId) {
      try { f.bookingUrl = (await provider.bookingLink(f.offerId)) ?? f.bookingUrl; }
      catch (e) { console.warn(`booking link for ${f.origin}-${f.destination} skipped: ${e}`); }
    }
    const d = await store.addDeal(f);
    if (i >= cfg.maxAlertsPerCycle) continue; // logged, not alerted; may alert on a later cycle
    await alert(cfg, store, notifier, d, !quiet && i < cfg.maxCallsPerCycle);
    if (subs) r.subscribersEmailed += await notifySubscribers(cfg, subs, notifier, d);
    r.deals.push((await store.deal(d.id))!);
  }

  if (provider.notes?.length) r.notes = [...(r.notes ?? []), ...provider.notes];
  if (provider.checks?.length) {
    const saved = new CheckStore(cfg.env.DB);
    for (const c of provider.checks) {
      try { await saved.save(c, now); } catch (e) { console.error("saving price check failed", e); }
    }
  }
  console.log(`cycle ${cycle}: ${r.searches} searches (${r.errors} errors), ${r.faresSeen} fares, `
    + `${r.deals.length} alerted, ${r.suppressed} already-known`);
  return r;
}
