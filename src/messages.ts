/** What the texts and calls say. */
import { daysBetween, shortDate, spokenDate } from "./dates";
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
const stops = (n: number) => (n === 0 ? "nonstop" : `${n} stop${n > 1 ? "s" : ""}`);
export const tripDays = (d: Deal) => daysBetween(d.depart_date, d.return_date);
const usd = (n: number) => `$${n.toFixed(0)}`;

export function dealText(d: Deal, kind: string, limit: number, bookingLive: boolean): string {
  const fake = d.is_fake ? "[FAKE TEST FARE] " : "";
  const airlines = (JSON.parse(d.airlines) as string[]).join(", ") || "?";
  const action = bookingLive ? "book it" : "get the booking link";
  return `${fake}Flight deal: ${d.origin}→${d.destination} (${city(d.destination)}) ${usd(d.price)} round trip `
    + `(${kind}, under ${usd(limit)}).\n`
    + `${shortDate(d.depart_date)} → ${shortDate(d.return_date)} (${tripDays(d)} days), `
    + `out ${stops(d.outbound_stops)}, back ${stops(d.return_stops)}, ${airlines}.\n`
    + `Reply BUY ${d.code} to ${action}, or SKIP ${d.code}.`;
}

export function dealSpeech(d: Deal): string {
  const fake = d.is_fake ? "This is a fake test fare. " : "";
  return `${fake}Flight deal. ${city(d.origin)} to ${city(d.destination)}, round trip, `
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

export function googleFlightsUrl(origin: string, dest: string, depart: string, ret: string): string {
  const q = `Flights from ${origin} to ${dest} on ${depart} through ${ret}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}
