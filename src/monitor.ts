/** One search cycle: plan -> search -> filter -> dedupe -> alert. Runs on the cron trigger. */
import { type Config, isDomestic, maxPriceFor } from "./config";
import { localParts } from "./dates";
import { dealText } from "./messages";
import { type Deal, type Fare, type FareProvider, NotImplementedError } from "./models";
import { planCycle } from "./planner";
import { cheapestPerRoute, rejectionReason } from "./rules";
import type { Store } from "./store";
import type { Notifier } from "./twilio";

export interface CycleResult {
  cycle: number; searches: number; errors: number; faresSeen: number; deals: Deal[]; suppressed: number;
}

export function inQuietHours(cfg: Config, now: Date): boolean {
  const h = localParts(now, cfg.timezone).hour;
  const s = cfg.quietStart, e = cfg.quietEnd;
  if (s === e) return false;
  return s > e ? h >= s || h < e : h >= s && h < e;
}

async function alert(cfg: Config, store: Store, notifier: Notifier, d: Deal, call: boolean) {
  const kind = isDomestic(cfg, d.destination) ? "domestic" : "international";
  const body = dealText(d, kind, maxPriceFor(cfg, d.destination), cfg.bookingEnabled && !cfg.dryRun);
  for (const c of cfg.contacts) {
    try { await notifier.sms(c.phone, body); } catch (e) { console.error(`text to ${c.name} failed`, e); }
    if (call) {
      try { await notifier.call(c.phone, d.code, c.name); } catch (e) { console.error(`call to ${c.name} failed`, e); }
    }
  }
  await store.markAlerted(d.id);
}

export async function runCycle(cfg: Config, store: Store, provider: FareProvider, notifier: Notifier,
                               now = new Date()): Promise<CycleResult> {
  const today = localParts(now, cfg.timezone).date;
  const cycle = await store.nextCycle();
  const r: CycleResult = { cycle, searches: 0, errors: 0, faresSeen: 0, deals: [], suppressed: 0 };

  const queries = planCycle(cfg, cycle, today);
  // Run searches concurrently; one failure doesn't sink the cycle.
  const settled = await Promise.allSettled(queries.map((q) => provider.search(q)));
  const fares: Fare[] = [];
  settled.forEach((s, i) => {
    r.searches++;
    if (s.status === "fulfilled") { r.faresSeen += s.value.length; fares.push(...s.value); return; }
    if (s.reason instanceof NotImplementedError) throw s.reason;
    r.errors++;
    const q = queries[i];
    console.warn(`search ${q.origin}-${q.destination} ${q.departDate}/${q.returnDate} failed: ${s.reason}`);
  });

  const candidates: Fare[] = [];
  for (const f of cheapestPerRoute(fares)) {
    if (rejectionReason(cfg, f, today)) continue;
    if (!(await store.shouldAlert(f, cfg.realertDropPercent))) { r.suppressed++; continue; }
    candidates.push(f);
  }

  // Best deals first: lowest price relative to that destination's limit.
  candidates.sort((a, b) => a.price / maxPriceFor(cfg, a.destination) - b.price / maxPriceFor(cfg, b.destination));
  const quiet = inQuietHours(cfg, now);
  for (const [i, f] of candidates.entries()) {
    const d = await store.addDeal(f);
    if (i >= cfg.maxTextsPerCycle) continue; // logged, not alerted; may alert on a later cycle
    await alert(cfg, store, notifier, d, !quiet && i < cfg.maxCallsPerCycle);
    r.deals.push((await store.deal(d.id))!);
  }

  console.log(`cycle ${cycle}: ${r.searches} searches (${r.errors} errors), ${r.faresSeen} fares, `
    + `${r.deals.length} alerted, ${r.suppressed} already-known`);
  return r;
}
