/** Fare search providers: mock (fake data for dry runs), Duffel, Ignav (not written yet). */
import { type Config, secret } from "./config";
import { DuffelProvider } from "./duffel";
import { googleFlightsUrl } from "./messages";
import { type Fare, type FareProvider, NotImplementedError, type SearchQuery } from "./models";

const AIRLINES = ["AS", "DL", "UA", "AA", "WN", "F9", "NK", "B6", "HA", "WS"];

/** 32-bit FNV-1a; deterministic so the same search returns the same fake fares. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/** Fake fares, every one marked isFake so alerts say FAKE TEST FARE. */
export class MockProvider implements FareProvider {
  name = "mock";
  constructor(private cfg: Config, private dealRate = 0.08) {}

  async search(q: SearchQuery): Promise<Fare[]> {
    const seed = fnv(`${q.origin}${q.destination}${q.departDate}${q.returnDate}`);
    const roll = (seed % 1000) / 1000;
    const intl = !this.cfg.domestic.includes(q.destination);
    let base = intl ? 320 + (seed % 900) : 115 + (seed % 330);
    if (roll < this.dealRate) base = intl ? 210 + (seed % 85) : 62 + (seed % 35);
    return [0, 1, 2].map((i) => ({
      provider: this.name, origin: q.origin, destination: q.destination,
      departDate: q.departDate, returnDate: q.returnDate,
      price: base + i * 23, currency: "USD",
      airlines: [AIRLINES[(seed >>> (i * 4)) % AIRLINES.length]],
      outboundStops: (seed >>> 8) % 2, returnStops: (seed >>> 9) % 2,
      offerId: `mock_${seed}_${i}`,
      bookingUrl: googleFlightsUrl(q.origin, q.destination, q.departDate, q.returnDate),
      isFake: true,
    }));
  }
}

/**
 * Ignav: NOT IMPLEMENTED YET. Its API docs couldn't be reached from the build
 * environment, so the request/response mapping hasn't been written. It's left
 * unimplemented on purpose, with no guessed field names. To finish: map a
 * SearchQuery to Ignav's round-trip request and its response to Fare[]
 * (per-person round-trip price). Booking still goes through Duffel.
 */
export class IgnavProvider implements FareProvider {
  name = "ignav";
  constructor(private apiKey: string) {}
  async search(_q: SearchQuery): Promise<Fare[]> {
    throw new NotImplementedError(
      "Ignav adapter not written yet; use provider 'duffel' or 'mock' (see src/providers.ts)");
  }
}

export function makeFareProvider(cfg: Config): FareProvider {
  switch (cfg.provider) {
    case "mock": return new MockProvider(cfg);
    case "duffel": return new DuffelProvider(secret(cfg, "DUFFEL_ACCESS_TOKEN"), cfg.cabinClass, cfg.maxConnections);
    case "ignav": return new IgnavProvider(secret(cfg, "IGNAV_API_KEY"));
  }
}

/** Booking always goes through Duffel, whichever provider found the fare. */
export const makeBookingProvider = (cfg: Config) =>
  new DuffelProvider(secret(cfg, "DUFFEL_ACCESS_TOKEN"), cfg.cabinClass, cfg.maxConnections);
