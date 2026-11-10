/** Small server-rendered pages (email-button confirmations, subscribe confirmations). */

export const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Same look as public/styles.css: the blurred photo, a dark glass card, one amber accent.
const PAGE_CSS = `@font-face{font-family:"Instrument Serif";font-weight:400;font-display:swap;src:url(/fonts/instrument-serif.woff2) format("woff2")}`
  + `:root{color-scheme:dark;--bg:#0e1d22;--fg:#f5f7f4;--fg2:rgba(236,242,238,.8);--fg3:rgba(226,235,231,.6);`
  + `--hair:rgba(255,255,255,.13);--accent:#f6b443;--accent-ink:#231703;--ok:#5ad48a}`
  + `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;`
  + `background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;isolation:isolate}`
  + `body::before{content:"";position:fixed;inset:-24px;z-index:-2;background:var(--bg) url(/bg.jpg) center 35%/cover no-repeat;filter:blur(5px)}`
  + `body::after{content:"";position:fixed;inset:0;z-index:-1;background:rgba(6,18,22,.5)}`
  + `.card{width:100%;max-width:460px;padding:30px 28px;border-radius:22px;background:rgba(12,27,33,.62);`
  + `-webkit-backdrop-filter:blur(26px) saturate(150%);backdrop-filter:blur(26px) saturate(150%);`
  + `border:1px solid var(--hair);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 18px 40px rgba(0,0,0,.3)}`
  + `.brand{display:inline-flex;align-items:center;gap:8px;margin-bottom:18px;color:var(--fg);font-weight:700;text-decoration:none}`
  + `.brand i{width:22px;height:22px;border-radius:7px;background:var(--accent);color:var(--accent-ink);font-style:normal;`
  + `font-size:13px;display:grid;place-items:center}`
  + `h2{margin:0 0 8px;font:400 34px/1.1 "Instrument Serif",Georgia,serif;letter-spacing:-.01em}`
  + `p{color:var(--fg2);margin:0 0 14px}p b{color:var(--fg)}`
  + `button{font:inherit;font-size:16px;font-weight:600;padding:13px 24px;border:0;border-radius:999px;cursor:pointer;margin:4px 8px 0 0}`
  + `.buy,.primary{background:var(--accent);color:var(--accent-ink);box-shadow:inset 0 1px 0 rgba(255,255,255,.45)}`
  + `.skip{background:rgba(255,255,255,.12);color:var(--fg)}`
  + `.muted{color:var(--fg3);font-size:14px}a{color:var(--accent)}`
  + `:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`;

export function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)} · Fare Radar</title>`
    + `<style>${PAGE_CSS}</style></head><body><main class="card">`
    + `<a class="brand" href="/"><i aria-hidden="true">✈︎</i>Fare Radar</a>${body}`
    + `<p class="muted" style="margin:22px 0 0"><a href="/">Back to the deals</a> · <a href="/#privacy">Privacy</a></p>`
    + `</main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
