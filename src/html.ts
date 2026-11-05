/** Small server-rendered pages (email-button confirmations, subscribe confirmations). */

export const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Same tokens as public/styles.css: plain surface for content, one accent.
const PAGE_CSS = `:root{color-scheme:light dark;--bg:#eef2f6;--surface:#fff;--fg:#111418;--fg2:#4a5360;--fg3:#77808c;`
  + `--hair:rgba(17,20,24,.09);--accent:#0a7cff}`
  + `@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--surface:#161b22;--fg:#e9edf2;--fg2:#aab3be;`
  + `--fg3:#7d8792;--hair:rgba(255,255,255,.08);--accent:#3d9bff}}`
  + `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;`
  + `background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}`
  + `.card{width:100%;max-width:460px;padding:26px;border-radius:18px;background:var(--surface);border:1px solid var(--hair)}`
  + `h2{margin:0 0 6px;font-size:24px;letter-spacing:-.015em}p{color:var(--fg2)}p b{color:var(--fg)}`
  + `button{font:inherit;font-size:16px;font-weight:600;padding:12px 22px;border:0;border-radius:999px;cursor:pointer}`
  + `.buy,.primary{background:var(--accent);color:#fff}.skip{background:var(--hair);color:var(--fg)}`
  + `.muted{color:var(--fg3);font-size:14px}a{color:var(--accent)}`;

export function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>`
    + `<style>${PAGE_CSS}</style></head><body><main class="card">${body}`
    + `<p class="muted" style="margin-top:22px"><a href="/">Fare Radar</a></p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
