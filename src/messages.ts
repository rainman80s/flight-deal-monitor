/** What the texts and calls say. */
import { daysBetween, shortDate, spokenDate } from "./dates";
import { button, callout, type EmailFrame, escHtml, fine, layout, p, priceLine, textFooter } from "./email";
import type { Deal } from "./models";

const CITY: Record<string, string> = {
  SEA: "Seattle", PDX: "Portland", LAX: "Los Angeles", SFO: "San Francisco", SAN: "San Diego",
  LAS: "Las Vegas", PHX: "Phoenix", DEN: "Denver", SLC: "Salt Lake City", ANC: "Anchorage",
  HNL: "Honolulu", OGG: "Maui", DFW: "Dallas", AUS: "Austin", ORD: "Chicago", MSP: "Minneapolis",
  ATL: "Atlanta", MIA: "Miami", MCO: "Orlando", BOS: "Boston", JFK: "New York J F K",
  EWR: "Newark", DCA: "Washington D C", MSY: "New Orleans", BNA: "Nashville", SJC: "San Jose",
  SMF: "Sacramento", BOI: "Boise", YVR: "Vancouver", MEX: "Mexico City", CUN: "Cancun",
  SJD: "Los Cabos", PVR: "Puerto Vallarta", GDL: "Guadalajara", LIR: "Liberia Costa Rica",
  SJO: "San Jose Costa Rica", NRT: "Tokyo Narita", HND: "Tokyo Haneda", KIX: "Osaka",
  ICN: "Seoul", TPE: "Taipei", MNL: "Manila", BKK: "Bangkok", SIN: "Singapore",
  LHR: "London Heathrow", DUB: "Dublin", KEF: "Reykjavik", CDG: "Paris", AMS: "Amsterdam",
  FRA: "Frankfurt", MAD: "Madrid", BCN: "Barcelona", LIS: "Lisbon", FCO: "Rome",
  SYD: "Sydney", AKL: "Auckland",
};

export const city = (code: string) => CITY[code] ?? code.split("").join(" ");
/** A deal's destination name: what Google called it, else the built-in name. */
export const destCity = (d: { destination: string; dest_name?: string | null }) => d.dest_name || city(d.destination);
export const stops = (n: number) => (n === 0 ? "nonstop" : `${n} stop${n > 1 ? "s" : ""}`);
export const tripDays = (d: Deal) => daysBetween(d.depart_date, d.return_date);
const usd = (n: number) => `$${n.toFixed(0)}`;

export function dealText(d: Deal, kind: string, why: string, bookingLive: boolean): string {
  const fake = d.is_fake ? "[FAKE TEST FARE] " : "";
  const airlines = (JSON.parse(d.airlines) as string[]).join(", ") || "?";
  const action = bookingLive ? "book it" : "get the booking link";
  return `${fake}Flight deal: ${d.origin}→${d.destination} (${destCity(d)}) ${usd(d.price)} round trip `
    + `(${kind}: ${why}).\n`
    + `${shortDate(d.depart_date)} → ${shortDate(d.return_date)} (${tripDays(d)} days), `
    + `out ${stops(d.outbound_stops)}, back ${stops(d.return_stops)}, ${airlines}.\n`
    + `Reply BUY ${d.code} to ${action}, or SKIP ${d.code}.`;
}

export function dealSpeech(d: Deal): string {
  const fake = d.is_fake ? "This is a fake test fare. " : "";
  return `${fake}Flight deal. ${city(d.origin)} to ${destCity(d)}, round trip, `
    + `${d.price.toFixed(0)} dollars. Leaving ${spokenDate(d.depart_date)}, `
    + `returning ${spokenDate(d.return_date)}. That's ${tripDays(d)} days.`;
}

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

export function confirmText(d: Deal, travelers: string[], maxTotal: number): string {
  return `Confirm: buy ${d.origin}→${d.destination} ${shortDate(d.depart_date)}–${shortDate(d.return_date)} `
    + `for ${travelers.map(titleCase).join(" and ")}, up to ${usd(maxTotal)} total. `
    + `Likely NONREFUNDABLE. Reply YES ${d.code} to purchase.`;
}

export function linkText(d: Deal): string {
  return `Book ${d.origin}→${d.destination} ${d.depart_date} to ${d.return_date} here `
    + `(price may have moved): ${d.booking_url}`;
}

/** What pressing Buy will actually do, given the current mode. */
export function buyMeaning(dryRun: boolean, bookingEnabled: boolean, isFake: boolean): string {
  if (isFake) return "This is a fake test fare, so Buy only records your answer.";
  if (dryRun) return "Dry run: Buy only records your answer; nothing is purchased.";
  if (!bookingEnabled) return "Buy gets you a booking link (automatic purchase is off).";
  return "Buy opens a confirmation page. Confirming re-checks the price and purchases the ticket.";
}

export function dealEmail(d: Deal, kind: string, why: string, buyUrl: string, skipUrl: string,
                          meaning: string, f: EmailFrame): { subject: string; text: string; html: string } {
  const fake = d.is_fake ? "[FAKE TEST FARE] " : "";
  const airlines = (JSON.parse(d.airlines) as string[]).join(", ") || "?";
  const deep = isGoogleFlights(d.booking_url) ? null : trustedBookingUrl(d);
  const subject = `${fake}✈ ${city(d.origin)} → ${destCity(d)} $${d.price.toFixed(0)} round trip, `
    + `${shortDate(d.depart_date)}–${shortDate(d.return_date)}`;
  const reason = "You're getting this because you're one of this site's owners and deal alerts are on.";
  const lines = [
    `${d.origin} → ${d.destination} (${destCity(d)})`,
    `$${d.price.toFixed(2)} ${d.currency} round trip per person (${kind})`,
    `Why it's a deal: ${why}`,
    `Leave ${shortDate(d.depart_date)}, return ${shortDate(d.return_date)} (${tripDays(d)} days)`,
    `Outbound ${stops(d.outbound_stops)}, return ${stops(d.return_stops)} · ${airlines}`,
    `Deal code ${d.code}`,
  ];
  const text = `${fake}Flight deal\n\n${lines.join("\n")}\n\n${meaning}\n\nBuy: ${buyUrl}\nSkip: ${skipUrl}\n`
    + `\nSee it on Google Flights: ${dealGoogleUrl(d)}\n`
    + (deep ? `Book on ${bookingSite(deep)}: ${deep}\n` : "")
    + textFooter(f, reason);
  const body = (d.is_fake ? callout("Fake test fare: not a real flight.") : "")
    + priceLine(`$${d.price.toFixed(0)}`, `round trip · ${tripDays(d)} days`)
    + callout(`Why it's a deal: ${escHtml(why)}`)
    + p(`<b style="color:#14262c">${escHtml(shortDate(d.depart_date))} → ${escHtml(shortDate(d.return_date))}</b><br>`
      + `Out ${stops(d.outbound_stops)} · back ${stops(d.return_stops)} · ${escHtml(airlines)}`)
    + `<div style="margin:22px 0 4px">${button(buyUrl, "Buy")}${button(skipUrl, "Skip", "secondary")}</div>`
    + fine(escHtml(meaning))
    + fine(`${d.origin}–${d.destination} · deal ${escHtml(d.code)}`
      + ` · <a href="${escHtml(dealGoogleUrl(d))}" style="color:#7d8a8c">See it on Google Flights</a>`
      + (deep ? ` · <a href="${escHtml(deep)}" style="color:#7d8a8c">Book on ${escHtml(bookingSite(deep))}</a>` : ""));
  const html = layout(f, {
    preheader: `${why}. ${shortDate(d.depart_date)} to ${shortDate(d.return_date)}, ${stops(d.outbound_stops)}.`,
    eyebrow: `${d.is_fake ? "Test · " : ""}Deal alert · ${kind === "international" ? "International" : "Domestic"}`,
    heading: `${escHtml(city(d.origin))} → ${escHtml(destCity(d))}`,
    body, reason,
  });
  return { subject, text, html };
}

/** True for Google Flights links (what SerpApi returns); airline and agency deep links are not. */
export const isGoogleFlights = (url: string | null | undefined) =>
  !!url && /^https:\/\/(www\.)?google\.com\/travel\/flights/.test(url);

/** Where a deal's booking link really goes, for labels: "Google Flights" or the site's host. */
export function bookingSite(url: string): string {
  if (isGoogleFlights(url)) return "Google Flights";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "the booking site"; }
}

/**
 * The provider's own booking link, if it can actually sell this fare. A trip that mixes airlines
 * (say Delta out, Frontier back) is only bookable as shown via Google Flights or an agency, so an
 * airline's link for it would show a different price.
 */
export function trustedBookingUrl(d: { booking_url?: string | null; airlines: string | string[] }): string | null {
  const url = d.booking_url ?? null;
  if (!url || isGoogleFlights(url)) return url;
  let codes: string[] = [];
  try { codes = Array.isArray(d.airlines) ? d.airlines : JSON.parse(d.airlines) as string[]; } catch { codes = []; }
  return new Set(codes).size <= 1 ? url : null;
}

/** The Google Flights search for a deal: always Google, whatever the provider's own link is. */
export function dealGoogleUrl(d: { origin: string; destination: string; depart_date: string; return_date: string; booking_url?: string | null }) {
  return isGoogleFlights(d.booking_url) ? d.booking_url! : googleFlightsUrl(d.origin, d.destination, d.depart_date, d.return_date);
}

export function googleFlightsUrl(origin: string, dest: string, depart: string, ret: string): string {
  const q = `Flights from ${origin} to ${dest} on ${depart} through ${ret}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}
