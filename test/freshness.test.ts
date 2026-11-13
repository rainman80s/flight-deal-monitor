/** Deals shown on the boards must still be the price you'll find when you click through. */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { PriceHistory } from "../src/baselines";
import { trustedBookingUrl } from "../src/messages";
import type { Fare } from "../src/models";
import { setup } from "./helpers";

const BASE = "https://flights.example.com";
const fare = (extra: Partial<Fare> = {}): Fare => ({
  provider: "ignav", origin: "SEA", destination: "LAS", departDate: "2027-01-14", returnDate: "2027-01-21",
  price: 93, currency: "USD", airlines: ["F9"], outboundStops: 0, returnStops: 0, offerId: null,
  bookingUrl: "https://booking.flyfrontier.com/external/flightselect?o1=SEA", isFake: false, ...extra,
});

async function board(ctx: ReturnType<typeof setup>) {
  const deps = { ...ctx, fareProvider: () => { throw new Error("unused"); }, background: () => {} };
  const res = await handle(new Request(`${BASE}/api/deals?kind=domestic&sort=price`), deps as never);
  return (await res.json() as { deals: { destination: string; price: number; booking_url: string | null }[] }).deals;
}

describe("deal freshness", () => {
  it("hides a deal once a later check finds the same trip noticeably pricier", async () => {
    const ctx = setup({ dryRun: false });
    const d = await ctx.store.addDeal(fare());
    expect((await board(ctx)).map((x) => x.price)).toContain(93);
    const later = new Date(Date.now() + 3600_000);
    // A small wobble ($99) doesn't hide it; a real rise ($140) does.
    await new PriceHistory(ctx.cfg.env.DB).recordFares([fare({ price: 99 })], "calendar", later);
    expect(await ctx.store.markSuperseded(later)).toBe(0);
    await new PriceHistory(ctx.cfg.env.DB).recordFares([fare({ price: 140 })], "calendar", later);
    expect(await ctx.store.markSuperseded(later)).toBe(1);
    expect((await board(ctx)).map((x) => x.price)).not.toContain(93);
    expect((await ctx.store.deal(d.id))!.superseded_at).toBeTruthy();
  });

  it("drops deals not seen for more than 48 hours", async () => {
    const ctx = setup({ dryRun: false });
    const d = await ctx.store.addDeal(fare());
    await ctx.cfg.env.DB.prepare("UPDATE deals SET found_at=? WHERE id=?")
      .bind(new Date(Date.now() - 50 * 3600_000).toISOString().slice(0, 19) + "Z", d.id).run();
    expect(await board(ctx)).toHaveLength(0);
  });
});

describe("booking links for mixed-airline trips", () => {
  it("never sends a Delta-out, Frontier-back fare to Frontier's site", async () => {
    const mixed = { booking_url: "https://booking.flyfrontier.com/x", airlines: ["DL", "F9"] };
    expect(trustedBookingUrl(mixed)).toBeNull();
    expect(trustedBookingUrl({ ...mixed, airlines: '["F9"]' })).toBe(mixed.booking_url);
    expect(trustedBookingUrl({ booking_url: "https://www.google.com/travel/flights?q=x", airlines: ["DL", "F9"] }))
      .toBe("https://www.google.com/travel/flights?q=x");
    const ctx = setup({ dryRun: false });
    await ctx.store.addDeal(fare({ airlines: ["DL", "F9"] }));
    expect((await board(ctx))[0].booking_url).toBeNull();
  });
});
