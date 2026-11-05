/**
 * Duffel over plain fetch: search (offer requests) and booking (orders).
 *
 * Request shapes match the official duffel-api SDK (POST /air/offer_requests with
 * return_offers=true; POST /air/orders with type "instant" and a "balance" payment).
 * Bookings are paid from your pre-funded Duffel balance, not a card. Use a test
 * token (duffel_test_...) first: test mode books a fake airline and moves no money.
 *
 * Cost note: Duffel charges an excess-search fee when searches greatly outnumber
 * bookings (reported ~1,500:1), so for steady monitoring search with a cheaper
 * provider and use Duffel for re-pricing and booking.
 */
import { googleFlightsUrl } from "./messages";
import type { BookingProvider, Fare, FareProvider, SearchQuery } from "./models";

const API = "https://api.duffel.com";
const VERSION = "v2";

interface DuffelAirport { iata_code?: string | null; city_name?: string | null; name?: string | null }
interface DuffelSegment {
  marketing_carrier?: { iata_code?: string | null; name?: string };
  marketing_carrier_flight_number?: string | null;
  origin?: DuffelAirport;
  destination?: DuffelAirport;
  departing_at?: string;
  arriving_at?: string;
  duration?: string | null;
}
interface DuffelCondition { allowed?: boolean; penalty_amount?: string | null; penalty_currency?: string | null }
export interface DuffelOffer {
  id: string;
  live_mode?: boolean;
  total_amount: string;
  total_currency: string;
  expires_at?: string;
  owner?: { name?: string; iata_code?: string | null };
  conditions?: { refund_before_departure?: DuffelCondition | null; change_before_departure?: DuffelCondition | null };
  passenger_identity_documents_required?: boolean;
  slices: { duration?: string | null; segments: DuffelSegment[] }[];
  passengers: { id: string }[];
}

/** What the booking sheet shows for one offer. */
export interface OfferView {
  id: string;
  total: number;
  currency: string;
  expires_at: string | null;
  airline: string;
  refundable: boolean | null;
  changeable: boolean | null;
  needs_passport: boolean;
  test_mode: boolean;
  slices: { from: string; to: string; depart_at: string; arrive_at: string; duration: string | null;
            stops: number; flights: string[] }[];
}

export function viewOffer(o: DuffelOffer): OfferView {
  return {
    id: o.id,
    total: Number(o.total_amount),
    currency: o.total_currency,
    expires_at: o.expires_at ?? null,
    airline: o.owner?.name ?? "",
    refundable: o.conditions?.refund_before_departure?.allowed ?? null,
    changeable: o.conditions?.change_before_departure?.allowed ?? null,
    needs_passport: !!o.passenger_identity_documents_required,
    test_mode: o.live_mode === false,
    slices: o.slices.map((s) => {
      const first = s.segments[0], last = s.segments[s.segments.length - 1];
      return {
        from: first?.origin?.iata_code ?? "", to: last?.destination?.iata_code ?? "",
        depart_at: first?.departing_at ?? "", arrive_at: last?.arriving_at ?? "",
        duration: s.duration ?? null, stops: Math.max(0, s.segments.length - 1),
        flights: s.segments.map((g) => `${g.marketing_carrier?.iata_code ?? ""}${g.marketing_carrier_flight_number ?? ""}`),
      };
    }),
  };
}

export class DuffelProvider implements FareProvider, BookingProvider {
  name = "duffel";
  constructor(private token: string, private cabinClass = "economy", private maxConnections = 1,
              private fetcher: typeof fetch = fetch.bind(globalThis)) {}

  /** Test tokens book fake flights and move no money. */
  get testMode() { return this.token.startsWith("duffel_test_"); }

  private async call<T>(method: "GET" | "POST", path: string, data?: unknown): Promise<T> {
    const res = await this.fetcher(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Duffel-Version": VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify({ data }),
    });
    const body = await res.json() as { data?: T; errors?: { title?: string; message?: string }[] };
    if (!res.ok || !body.data) {
      const e = body.errors?.[0];
      throw new Error(`Duffel ${path} ${res.status}: ${e?.title ?? ""} ${e?.message ?? ""}`.trim());
    }
    return body.data;
  }

  private post<T>(path: string, data: unknown) { return this.call<T>("POST", path, data); }

  /** Bookable offers for exact dates, cheapest first. */
  async listOffers(origin: string, dest: string, depart: string, ret: string, passengers: number, limit = 8) {
    const offers = await this.offers(origin, dest, depart, ret, passengers);
    return offers.sort((a, b) => Number(a.total_amount) - Number(b.total_amount)).slice(0, limit);
  }

  /** The latest version of one offer (Duffel refreshes price and availability). */
  getOffer(id: string) {
    return this.call<DuffelOffer>("GET", `/air/offers/${encodeURIComponent(id)}`);
  }

  private async offers(origin: string, dest: string, depart: string, ret: string, passengers = 1) {
    const data = await this.post<{ offers: DuffelOffer[] }>("/air/offer_requests?return_offers=true", {
      cabin_class: this.cabinClass,
      max_connections: this.maxConnections,
      passengers: Array.from({ length: passengers }, () => ({ type: "adult" })),
      slices: [
        { origin, destination: dest, departure_date: depart },
        { origin: dest, destination: origin, departure_date: ret },
      ],
    });
    return data.offers ?? [];
  }

  async search(q: SearchQuery): Promise<Fare[]> {
    const offers = await this.offers(q.origin, q.destination, q.departDate, q.returnDate);
    const fares: Fare[] = [];
    for (const o of offers) {
      if (o.slices?.length !== 2) continue;
      const carriers = new Set<string>();
      for (const sl of o.slices) for (const s of sl.segments) {
        const c = s.marketing_carrier?.iata_code ?? s.marketing_carrier?.name;
        if (c) carriers.add(c);
      }
      const price = Number(o.total_amount);
      if (!Number.isFinite(price)) continue;
      fares.push({
        provider: this.name, origin: q.origin, destination: q.destination,
        departDate: q.departDate, returnDate: q.returnDate, price, currency: o.total_currency,
        airlines: [...carriers].sort(),
        outboundStops: o.slices[0].segments.length - 1, returnStops: o.slices[1].segments.length - 1,
        offerId: o.id,
        bookingUrl: googleFlightsUrl(q.origin, q.destination, q.departDate, q.returnDate),
        isFake: false,
      });
    }
    return fares;
  }

  /** Always searches fresh: offers expire (~30 min) and alerts may be older. */
  async reprice(origin: string, dest: string, depart: string, ret: string, passengers: number) {
    const offers = await this.offers(origin, dest, depart, ret, passengers);
    if (!offers.length) return null;
    const best = offers.reduce((a, b) => (Number(b.total_amount) < Number(a.total_amount) ? b : a));
    return {
      offerId: best.id, total: Number(best.total_amount), currency: best.total_currency,
      passengerIds: best.passengers.map((p) => p.id),
    };
  }

  async book(offerId: string, amount: number, currency: string, passengers: Record<string, unknown>[]) {
    const order = await this.post<{ id: string; booking_reference: string }>("/air/orders", {
      type: "instant",
      selected_offers: [offerId],
      passengers,
      payments: [{ type: "balance", amount: amount.toFixed(2), currency }],
    });
    return { orderId: order.id, reference: order.booking_reference };
  }
}
