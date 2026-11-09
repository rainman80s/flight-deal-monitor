/**
 * Google Travel Explore via SerpApi (https://serpapi.com/google-travel-explore-api).
 *
 *   GET https://serpapi.com/search.json?engine=google_travel_explore&departure_id=SEA
 *       &currency=USD&gl=us&hl=en&type=1&travel_duration=2&month=0&stops=2&travel_mode=1&api_key=…
 *     type=1 round trip; travel_duration 1 weekend, 2 one week, 3 two weeks;
 *     month=0 means the next 6 months; stops=2 means one stop or fewer; travel_mode=1 flights only.
 *   200: { destinations: [{ name, country, destination_airport: { code }, start_date, end_date,
 *          flight_price, flight_duration, number_of_stops, airline, airline_code, link }] }
 *
 * One request returns Google's cheapest round trip to every destination it shows from that
 * airport, which is what makes it so much cheaper than pricing routes one by one.
 * Each request is one SerpApi search (Free plan: 250 a month).
 */
import type { Budget } from "./budget";
import type { Fare } from "./models";

export interface ExploreDestination {
  name?: string;
  country?: string;
  destination_airport?: { code?: string };
  start_date?: string;
  end_date?: string;
  flight_price?: number;
  number_of_stops?: number;
  airline?: string;
  airline_code?: string;
  link?: string;
}

export interface ExploreOptions {
  travelDuration: 1 | 2 | 3;   // weekend, 1 week, 2 weeks
  stops: 0 | 1 | 2 | 3;        // any, nonstop, ≤1, ≤2
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export class ExploreClient {
  constructor(private apiKey: string, private budget?: Budget,
              private fetcher: typeof fetch = fetch.bind(globalThis)) {}

  async explore(origin: string, opts: ExploreOptions): Promise<ExploreDestination[]> {
    if (this.budget) await this.budget.take(); // throws BudgetExceeded before spending a search
    const q = new URLSearchParams({
      engine: "google_travel_explore", departure_id: origin, currency: "USD", gl: "us", hl: "en",
      type: "1", travel_duration: String(opts.travelDuration), month: "0", stops: String(opts.stops),
      travel_mode: "1", api_key: this.apiKey,
    });
    const res = await this.fetcher(`https://serpapi.com/search.json?${q}`, { headers: { Accept: "application/json" } });
    const data = await res.json().catch(() => ({})) as { destinations?: ExploreDestination[]; error?: string };
    if (!res.ok || data.error) throw new Error(`SerpApi ${res.status}: ${data.error ?? "request failed"}`);
    return data.destinations ?? [];
  }
}

/** Turn Explore destinations into fares. Skips anything without an airport, dates or a price. */
export function exploreFares(origin: string, dests: ExploreDestination[]): Fare[] {
  const out: Fare[] = [];
  for (const d of dests) {
    const code = d.destination_airport?.code?.toUpperCase();
    const price = Number(d.flight_price);
    if (!code || !/^[A-Z]{3}$/.test(code) || code === origin) continue;
    if (!d.start_date || !d.end_date || !ISO.test(d.start_date) || !ISO.test(d.end_date)) continue;
    if (!Number.isFinite(price) || price <= 0) continue;
    const stops = Number.isInteger(d.number_of_stops) ? d.number_of_stops! : 0;
    out.push({
      provider: "google-explore", origin, destination: code,
      departDate: d.start_date, returnDate: d.end_date, price, currency: "USD",
      airlines: d.airline_code ? [d.airline_code] : d.airline ? [d.airline] : [],
      outboundStops: stops, returnStops: stops,
      offerId: null,
      bookingUrl: typeof d.link === "string" && d.link.startsWith("https://") ? d.link : null,
      isFake: false,
      kind: d.country === "United States" ? "domestic" : "international",
      destName: d.name,
    });
  }
  return out;
}

/** The Explore key, under any of the names it may have been saved as. */
export function serpApiKey(env: Record<string, unknown>): string | null {
  for (const k of ["SERPAPI_KEY", "SERPAPI_API_KEY", "serpapi-key", "serpapi_key", "serp-api", "SERP_API"]) {
    const v = env[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}
