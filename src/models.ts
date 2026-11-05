export interface SearchQuery {
  origin: string;
  destination: string;
  departDate: string; // YYYY-MM-DD (first departure date when windowDays is set)
  returnDate: string;
  /** Calendar search: check every departure date in [departDate, departDate + windowDays - 1]. */
  windowDays?: number;
  /** Calendar search: trip length in days. */
  stayDays?: number;
  /** The route's price limit, so providers can skip what can't be a deal. */
  maxPrice?: number;
}

/** One round-trip fare, per person. */
export interface Fare {
  provider: string;
  origin: string;
  destination: string;
  departDate: string;
  returnDate: string;
  price: number;
  currency: string;
  airlines: string[];
  outboundStops: number;
  returnStops: number;
  offerId: string | null;
  bookingUrl: string | null;
  isFake: boolean;
}

/** A row from the deals table. */
export interface Deal {
  id: number;
  code: string;
  route_key: string;
  provider: string;
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string;
  price: number;
  currency: string;
  airlines: string; // JSON array
  outbound_stops: number;
  return_stops: number;
  offer_id: string | null;
  booking_url: string | null;
  is_fake: number;
  found_at: string;
  alerted_at: string | null;
}

export const routeKey = (f: { origin: string; destination: string; departDate: string; returnDate: string }) =>
  `${f.origin}-${f.destination}-${f.departDate}-${f.returnDate}`;

export interface FareProvider {
  name: string;
  search(q: SearchQuery): Promise<Fare[]>;
  /** Optional: a better booking URL (e.g. airline-direct) for a fare's offerId. */
  bookingLink?(offerId: string): Promise<string | null>;
  /** Optional: human-readable lines about this run's searches. */
  readonly notes?: string[];
}

export interface BookingProvider {
  /** Fresh bookable offer for exact dates: total for all passengers. */
  reprice(origin: string, destination: string, depart: string, ret: string, passengers: number):
    Promise<{ offerId: string; total: number; currency: string; passengerIds: string[] } | null>;
  /** Pay for and ticket the offer. */
  book(offerId: string, amount: number, currency: string, passengers: Record<string, string>[]):
    Promise<{ orderId: string; reference: string }>;
}

export class NotImplementedError extends Error {}
