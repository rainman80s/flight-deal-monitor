export interface SearchQuery {
  origin: string;
  destination: string;
  departDate: string; // YYYY-MM-DD
  returnDate: string;
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
