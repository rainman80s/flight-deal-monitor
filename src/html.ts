/** Small server-rendered pages (email-button confirmations, subscribe confirmations). */

export const escHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Same glass look as the site, kept tiny and inline.
const PAGE_CSS = `:root{color-scheme:light dark;--fg:#1d1d1f;--muted:#6e6e73;--glass:rgba(255,255,255,.55);`
  + `--edge:rgba(255,255,255,.7);--link:#0a84ff}`
  + `@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--glass:rgba(40,40,46,.5);`
  + `--edge:rgba(255,255,255,.14);--link:#64d2ff}}`
  + `*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;`
  + `font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:var(--fg);`
  + `background:radial-gradient(1200px 600px at 10% -10%,#7fd3ff,transparent 60%),`
  + `radial-gradient(900px 600px at 110% 10%,#c49bff,transparent 55%),`
  + `radial-gradient(900px 700px at 50% 120%,#ffb38a,transparent 55%),#e9eef6}`
  + `@media (prefers-color-scheme:dark){body{background:radial-gradient(1200px 600px at 10% -10%,#0b4a7a,transparent 60%),`
  + `radial-gradient(900px 600px at 110% 10%,#3d2470,transparent 55%),`
  + `radial-gradient(900px 700px at 50% 120%,#6b2f17,transparent 55%),#0b0c10}}`
  + `.card{width:100%;max-width:480px;padding:28px;border-radius:28px;background:var(--glass);`
  + `-webkit-backdrop-filter:blur(28px) saturate(180%);backdrop-filter:blur(28px) saturate(180%);`
  + `border:1px solid var(--edge);box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 20px 60px rgba(0,0,0,.18)}`
  + `h2{margin:0 0 6px;font-size:24px;letter-spacing:-.02em}p{line-height:1.5}`
  + `button{font:inherit;font-size:17px;font-weight:600;padding:13px 28px;border:0;border-radius:999px;color:#fff;`
  + `cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 6px 18px rgba(0,0,0,.18)}`
  + `.buy{background:#30d158}.skip{background:#8e8e93}.primary{background:#0a84ff}`
  + `.muted{color:var(--muted);font-size:14px}a{color:var(--link)}`;

export function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>`
    + `<style>${PAGE_CSS}</style></head><body><main class="card">${body}`
    + `<p class="muted" style="margin-top:22px"><a href="/">Fare Radar</a></p></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
