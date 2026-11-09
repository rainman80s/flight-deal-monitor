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
/** A deal's destination name: what Google called it, else the built-in name. */
export const destCity = (d: { destination: string; dest_name?: string | null }) => d.dest_name || city(d.destination);
const stops = (n: number) => (n === 0 ? "nonstop" : `${n} stop${n > 1 ? "s" : ""}`);
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

const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What pressing Buy will actually do, given the current mode. */
export function buyMeaning(dryRun: boolean, bookingEnabled: boolean, isFake: boolean): string {
  if (isFake) return "This is a fake test fare, so Buy only records your answer.";
  if (dryRun) return "Dry run: Buy only records your answer; nothing is purchased.";
  if (!bookingEnabled) return "Buy gets you a booking link (automatic purchase is off).";
  return "Buy opens a confirmation page. Confirming re-checks the price and purchases the ticket.";
}

export function dealEmail(d: Deal, kind: string, why: string, buyUrl: string, skipUrl: string,
                          meaning: string): { subject: string; text: string; html: string } {
  const fake = d.is_fake ? "[FAKE TEST FARE] " : "";
  const airlines = (JSON.parse(d.airlines) as string[]).join(", ") || "?";
  const subject = `${fake}✈ ${city(d.origin)} → ${destCity(d)} $${d.price.toFixed(0)} round trip, `
    + `${shortDate(d.depart_date)}–${shortDate(d.return_date)}`;
  const lines = [
    `${d.origin} → ${d.destination} (${destCity(d)})`,
    `$${d.price.toFixed(2)} ${d.currency} round trip per person (${kind})`,
    `Why it's a deal: ${why}`,
    `Leave ${shortDate(d.depart_date)}, return ${shortDate(d.return_date)} (${tripDays(d)} days)`,
    `Outbound ${stops(d.outbound_stops)}, return ${stops(d.return_stops)} · ${airlines}`,
    `Deal code ${d.code}`,
  ];
  const text = `${fake}Flight deal\n\n${lines.join("\n")}\n\n${meaning}\n\nBuy: ${buyUrl}\nSkip: ${skipUrl}\n`
    + (d.booking_url ? `\nSee it on Google Flights: ${d.booking_url}\n` : "");
  const btn = (href: string, label: string, bg: string) =>
    `<a href="${escHtml(href)}" style="display:inline-block;padding:12px 28px;margin-right:10px;border-radius:8px;`
    + `background:${bg};color:#fff;text-decoration:none;font-weight:600">${label}</a>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;color:#1a1a1a">
  ${fake ? `<p style="background:#fff3cd;padding:8px 12px;border-radius:6px"><b>Fake test fare</b>: not a real flight.</p>` : ""}
  <h2 style="margin:0 0 4px">${escHtml(city(d.origin))} → ${escHtml(destCity(d))}</h2>
  <p style="font-size:28px;font-weight:700;margin:4px 0">$${d.price.toFixed(0)} <span style="font-size:15px;font-weight:400;color:#555">round trip · ${kind}</span></p>
  <p style="font-size:15px;margin:2px 0 0;color:#1a7f37;font-weight:600">${escHtml(why)}</p>
  <p style="font-size:15px;line-height:1.6;margin:12px 0">
    ${escHtml(shortDate(d.depart_date))} → ${escHtml(shortDate(d.return_date))} (${tripDays(d)} days)<br>
    Out ${stops(d.outbound_stops)} · back ${stops(d.return_stops)} · ${escHtml(airlines)}<br>
    <span style="color:#666">${d.origin}–${d.destination} · deal ${d.code}</span></p>
  <p style="margin:20px 0">${btn(buyUrl, "Buy", "#1a7f37")}${btn(skipUrl, "Skip", "#6e7781")}</p>
  <p style="font-size:13px;color:#555">${escHtml(meaning)}</p>
  ${d.booking_url ? `<p style="font-size:13px"><a href="${escHtml(d.booking_url)}">See it on Google Flights</a></p>` : ""}
</div>`;
  return { subject, text, html };
}

export function googleFlightsUrl(origin: string, dest: string, depart: string, ret: string): string {
  const q = `Flights from ${origin} to ${dest} on ${depart} through ${ret}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}
