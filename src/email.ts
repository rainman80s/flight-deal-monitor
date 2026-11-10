/**
 * One look for every email: the site's mountain photo as a banner, a warm off-white card,
 * a serif headline, amber buttons, and a dark footer with the usual email fine print
 * (why you got it, unsubscribe, privacy, contact, postal address, copyright).
 *
 * Email clients ignore most modern CSS, so this is table layout with inline styles.
 * Outlook drops the banner photo and shows the dark teal fill behind it instead.
 */
import { type Config, secret } from "./config";

export const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const BRAND = "Fare Radar";
const C = {
  page: "#0e1d22", banner: "#1d3a44", card: "#fbfaf6", ink: "#14262c", ink2: "#4a5a5e", ink3: "#7d8a8c",
  hair: "#e6e2d6", accent: "#f6b443", accentInk: "#231703", foot: "#9fb2b2", footLink: "#d9e4e2",
};
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "'Instrument Serif',Georgia,'Times New Roman',serif";

/** What every email needs to know about the site it comes from. */
export interface EmailFrame { base: string; address: string; year: number }

export function frameFor(cfg: Config, now = new Date()): EmailFrame {
  let base = "";
  try { base = secret(cfg, "PUBLIC_BASE_URL").replace(/\/$/, ""); } catch { /* links fall back to relative */ }
  return { base, address: cfg.mailingAddress, year: now.getUTCFullYear() };
}

export function button(href: string, label: string, kind: "primary" | "secondary" = "primary"): string {
  const bg = kind === "primary" ? C.accent : "#ebe7dc";
  const fg = kind === "primary" ? C.accentInk : C.ink;
  return `<a href="${escHtml(href)}" style="display:inline-block;padding:13px 26px;margin:0 8px 8px 0;border-radius:999px;`
    + `background:${bg};color:${fg};font-family:${SANS};font-size:16px;font-weight:600;line-height:1;text-decoration:none">`
    + `${escHtml(label)}</a>`;
}

/** Small helpers for the body copy, so each email reads the same. */
export const p = (html: string, extra = "") =>
  `<p style="margin:0 0 14px;font-family:${SANS};font-size:16px;line-height:1.55;color:${C.ink2};${extra}">${html}</p>`;
export const fine = (html: string) =>
  `<p style="margin:14px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${C.ink3}">${html}</p>`;
export const priceLine = (price: string, note: string) =>
  `<p style="margin:2px 0 10px;font-family:${SANS};color:${C.ink}"><span style="font-size:40px;font-weight:700;`
  + `letter-spacing:-1px">${escHtml(price)}</span> <span style="font-size:15px;color:${C.ink3}">${escHtml(note)}</span></p>`;
export const callout = (html: string) =>
  `<p style="margin:0 0 14px;padding:10px 14px;border-radius:10px;background:#fdf1d8;font-family:${SANS};font-size:15px;`
  + `line-height:1.45;color:#6b4705;font-weight:600">${html}</p>`;

export interface LayoutOpts {
  /** Shown in the inbox list next to the subject; never visible in the email itself. */
  preheader: string;
  /** Small line above the headline, e.g. "Deal alert". */
  eyebrow?: string;
  heading: string;
  body: string;
  /** Why this person is getting the email. */
  reason: string;
  unsubscribeUrl?: string;
}

export function layout(f: EmailFrame, o: LayoutOpts): string {
  const link = (href: string, label: string) =>
    `<a href="${escHtml(href)}" style="color:${C.footLink};text-decoration:underline">${label}</a>`;
  const links = [
    o.unsubscribeUrl ? link(o.unsubscribeUrl, "Unsubscribe") : "",
    link(`${f.base}/#signup`, "Change alerts"),
    link(`${f.base}/#privacy`, "Privacy"),
    link(`${f.base}/#contact`, "Contact"),
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  const banner = `${f.base}/email-banner.jpg`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only">
<title>${escHtml(o.heading)}</title>
<style>@font-face{font-family:'Instrument Serif';font-style:normal;font-weight:400;src:url(${f.base}/fonts/instrument-serif.woff2) format('woff2')}
@media (max-width:620px){.wrap{padding:0!important}.card{padding:26px 20px!important}.h1{font-size:30px!important}}</style>
</head><body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${escHtml(o.preheader)}&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;&#8204;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page}">
<tr><td align="center" class="wrap" style="padding:28px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td background="${banner}" bgcolor="${C.banner}" height="150" valign="top"
 style="height:150px;padding:22px 28px;border-radius:18px 18px 0 0;background:${C.banner} url('${banner}') center/cover no-repeat">
 <a href="${escHtml(f.base || "/")}" style="font-family:${SANS};font-size:18px;font-weight:700;color:#ffffff;text-decoration:none">
 <span style="display:inline-block;width:26px;height:26px;line-height:26px;margin-right:8px;border-radius:8px;background:${C.accent};`
    + `color:${C.accentInk};text-align:center;font-size:15px;vertical-align:middle">&#9992;&#xFE0E;</span>`
    + `<span style="vertical-align:middle">${BRAND}</span></a>
</td></tr>
<tr><td class="card" bgcolor="${C.card}" style="background:${C.card};padding:32px 34px 30px;border-radius:0 0 18px 18px">
${o.eyebrow ? `<p style="margin:0 0 6px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#a0700f">${escHtml(o.eyebrow)}</p>` : ""}
<h1 class="h1" style="margin:0 0 14px;font-family:${SERIF};font-weight:400;font-size:36px;line-height:1.1;color:${C.ink}">${o.heading}</h1>
${o.body}
</td></tr>
<tr><td style="padding:22px 20px 8px;font-family:${SANS};font-size:12px;line-height:1.6;color:${C.foot};text-align:center">
${escHtml(o.reason)}<br>${links}
${f.address ? `<br>${escHtml(BRAND)} · ${escHtml(f.address)}` : ""}
<br>© ${f.year} ${BRAND}. Fares are round trip, per person, in USD and can change before you book.
</td></tr>
</table></td></tr></table></body></html>`;
}

/** The plain-text version's footer, matching the HTML one. */
export function textFooter(f: EmailFrame, reason: string, unsubscribeUrl?: string): string {
  return `\n--\n${reason}\n`
    + (unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}\n` : "")
    + `Privacy: ${f.base}/#privacy · Contact: ${f.base}/#contact\n`
    + (f.address ? `${BRAND} · ${f.address}\n` : "")
    + `© ${f.year} ${BRAND}\n`;
}

/** Headers Gmail and Yahoo expect on bulk mail: one-click unsubscribe from the inbox. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}
