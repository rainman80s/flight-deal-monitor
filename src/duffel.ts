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

interface DuffelSegment { marketing_carrier?: { iata_code?: string | null; name?: string } }
interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  slices: { segments: DuffelSegment[] }[];
  passengers: { id: string }[];
}

export class DuffelProvider implements FareProvider, BookingProvider {
  name = "duffel";
  constructor(private token: string, private cabinClass = "economy", private maxConnections = 1,
              private fetcher: typeof fetch = fetch) {}

  private async post<T>(path: string, data: unknown): Promise<T> {
    const res = await this.fetcher(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Duffel-Version": VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ data }),
    });
    const body = await res.json() as { data?: T; errors?: { title?: string; message?: string }[] };
    if (!res.ok || !body.data) {
      const e = body.errors?.[0];
      throw new Error(`Duffel ${path} ${res.status}: ${e?.title ?? ""} ${e?.message ?? ""}`.trim());
    }
    return body.data;
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

  async book(offerId: string, amount: number, currency: string, passengers: Record<string, string>[]) {
    const order = await this.post<{ id: string; booking_reference: string }>("/air/orders", {
      type: "instant",
      selected_offers: [offerId],
      passengers,
      payments: [{ type: "balance", amount: amount.toFixed(2), currency }],
    });
    return { orderId: order.id, reference: order.booking_reference };
  }
}
