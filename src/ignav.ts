/**
 * Ignav fare search (https://ignav.com/docs, OpenAPI at /api/openapi.json).
 *
 *   POST https://ignav.com/api/fares/cheapest-dates   (calendar: 1 request = up to 31 departure dates)
 *     body: origin, destination, departure_date_range {start, end}, stay_days, ...
 *     200:  { dates: [{ departure_date, return_date, price: {amount, currency, status} | null }] }
 *     Prices are unverified estimates, so a promising date is confirmed with an exact
 *     round-trip search before anyone is alerted.
 *   POST https://ignav.com/api/fares/round-trip      header X-Api-Key
 *     body: origin, destination, departure_date, return_date (required),
 *           adults, cabin_class, max_stops, max_price, market (default "US" -> USD)
 *     200:  { itineraries: [{ price: {amount, currency, status}, outbound: {segments[]},
 *             inbound: {segments[]} | null, ignav_id }] }
 *   POST https://ignav.com/api/fares/booking-links   body { ignav_id }
 *     200:  { booking_options: [{ links: [{ provider_name, provider_type, url, ... }] }] }
 *
 * Every request goes through the Budget first (daily + all-time caps).
 * Pricing (per Ignav): 1,000 free requests, then $2 per 1,000 successful requests;
 * failed requests aren't billed. Ignav never tickets; booking still goes through Duffel.
 */
import type { Budget } from "./budget";
import type { CalendarDay, NewCheck } from "./checks";
import { addDays } from "./dates";
import { googleFlightsUrl } from "./messages";
import type { Fare, FareProvider, SearchQuery } from "./models";

const API = "https://ignav.com/api";

interface Segment { marketing_carrier_code?: string | null }
interface Leg { segments: Segment[] }
interface Itinerary {
  price: { amount: number; currency: string; status: string };
  outbound: Leg;
  inbound?: Leg | null;
  ignav_id: string;
}
interface Link { provider_name: string; provider_type?: string | null; url: string }
interface CalendarDate {
  departure_date: string;
  return_date?: string | null;
  price?: { amount: number; currency: string } | null;
}

export class IgnavProvider implements FareProvider {
  name = "ignav";
  /** Exact searches left this run for confirming calendar prices. */
  private verifyLeft: number;
  /** One line per calendar search this run, for the run report and logs. */
  readonly notes: string[] = [];
  /** Calendar results from this run, saved by the cycle so the site can show them. */
  readonly checks: NewCheck[] = [];

  constructor(private apiKey: string, private cabinClass = "economy", private maxStops = 1,
              private maxPrice: number | null = null,
              private fetcher: typeof fetch = fetch.bind(globalThis),
              private budget?: Budget, verifyPerRun = 2) {
    this.verifyLeft = verifyPerRun;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    if (this.budget) await this.budget.take(); // throws BudgetExceeded before anything is spent
    const res = await this.fetcher(`${API}${path}`, {
      method: "POST",
      headers: { "X-Api-Key": this.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
    if (!res.ok) {
      const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new Error(`Ignav ${path} ${res.status}: ${e?.code ?? ""} ${e?.message ?? text.slice(0, 200)}`.trim());
    }
    return data as T;
  }

  async search(q: SearchQuery): Promise<Fare[]> {
    return q.windowDays && q.stayDays ? this.calendar(q) : this.exact(q);
  }

  /**
   * One calendar request: the lowest round-trip fare for each departure date in the window.
   * No max_price on purpose: a request costs the same either way, and the full picture is
   * what the site shows. Non-USD or missing prices come back as null.
   */
  async calendarDays(origin: string, destination: string, start: string, windowDays: number,
                     stayDays: number): Promise<CalendarDay[]> {
    const data = await this.post<{ dates?: CalendarDate[] }>("/fares/cheapest-dates", {
      origin, destination,
      departure_date_range: { start, end: addDays(start, windowDays - 1) },
      stay_days: stayDays, adults: 1, cabin_class: this.cabinClass, max_stops: this.maxStops, market: "US",
    });
    return (data.dates ?? []).map((d) => ({
      d: d.departure_date,
      r: d.return_date ?? addDays(d.departure_date, stayDays),
      p: d.price && d.price.currency === "USD" && d.price.amount > 0 ? d.price.amount : null,
    }));
  }

  /** Background scan: one calendar request; confirm the cheapest under-limit date with one exact search. */
  private async calendar(q: SearchQuery): Promise<Fare[]> {
    const limit = q.maxPrice ?? this.maxPrice ?? Infinity;
    const days = await this.calendarDays(q.origin, q.destination, q.departDate, q.windowDays!, q.stayDays!);
    this.checks.push({ origin: q.origin, destination: q.destination, windowStart: q.departDate,
      windowDays: q.windowDays!, stayDays: q.stayDays!, days,
      limit: Number.isFinite(limit) ? limit : null, source: "scan" });
    const sorted = days.filter((x) => x.p !== null).sort((a, b) => a.p! - b.p!);
    const cheapest = sorted[0];
    const note = `${q.origin}-${q.destination} from ${q.departDate} (${q.windowDays} days), ${q.stayDays}-day trips: `
      + `${sorted.length}/${days.length} dates priced`
      + (cheapest ? `, cheapest $${Math.round(cheapest.p!)} leaving ${cheapest.d}` : "")
      + ` (limit $${limit})`;
    this.notes.push(note);
    console.log(note);
    const hit = sorted.find((x) => x.p! < limit);
    const best = hit && { departure_date: hit.d, return_date: hit.r, price: { amount: hit.p! } };
    if (!best) return [];
    if (this.verifyLeft <= 0) {
      console.log(`calendar ${q.origin}-${q.destination} ${best.departure_date} ~$${best.price!.amount}: `
        + "not confirmed this run (verification limit); it will come up again");
      return [];
    }
    this.verifyLeft--;
    return this.exact({ origin: q.origin, destination: q.destination, departDate: best.departure_date,
      returnDate: best.return_date ?? addDays(best.departure_date, q.stayDays!), maxPrice: q.maxPrice });
  }

  private async exact(q: SearchQuery): Promise<Fare[]> {
    const body: Record<string, unknown> = {
      origin: q.origin, destination: q.destination,
      departure_date: q.departDate, return_date: q.returnDate,
      adults: 1, cabin_class: this.cabinClass, max_stops: this.maxStops, market: "US",
    };
    // Server-side price cap trims the response; our own rules still decide what's a deal.
    const cap = q.maxPrice ?? this.maxPrice;
    if (cap) body.max_price = Math.ceil(cap);
    const data = await this.post<{ itineraries?: Itinerary[] }>("/fares/round-trip", body);
    const fares: Fare[] = [];
    for (const it of data.itineraries ?? []) {
      const amount = Number(it.price?.amount);
      // Manual/placeholder results can carry amount 0 with status "unverified": not a real fare.
      if (!Number.isFinite(amount) || amount <= 0 || it.price.status === "unverified") continue;
      if (!it.inbound?.segments?.length || !it.outbound?.segments?.length) continue; // not a round trip
      const carriers = new Set<string>();
      for (const s of [...it.outbound.segments, ...it.inbound.segments]) {
        if (s.marketing_carrier_code) carriers.add(s.marketing_carrier_code);
      }
      fares.push({
        provider: this.name, origin: q.origin, destination: q.destination,
        departDate: q.departDate, returnDate: q.returnDate,
        price: amount, currency: it.price.currency,
        airlines: [...carriers].sort(),
        outboundStops: it.outbound.segments.length - 1, returnStops: it.inbound.segments.length - 1,
        offerId: it.ignav_id,
        bookingUrl: googleFlightsUrl(q.origin, q.destination, q.departDate, q.returnDate),
        isFake: false,
      });
    }
    return fares;
  }

  /** Best booking URL for an itinerary: airline-direct first, else any provider. */
  async bookingLink(ignavId: string): Promise<string | null> {
    const data = await this.post<{ booking_options?: { links?: Link[] }[] }>("/fares/booking-links",
      { ignav_id: ignavId });
    const links = (data.booking_options ?? []).flatMap((o) => o.links ?? [])
      .filter((l) => typeof l.url === "string" && l.url.startsWith("https://"));
    return (links.find((l) => l.provider_type === "airline") ?? links[0])?.url ?? null;
  }
}
