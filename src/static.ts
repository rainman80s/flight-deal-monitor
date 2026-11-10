/** The website's files, bundled into the Worker (wrangler.toml [[rules]]: text as strings, images and fonts as bytes). */
import appJs from "../public/app.js";
import bgJpg from "../public/bg.jpg";
import emailBannerJpg from "../public/email-banner.jpg";
import serifItalic from "../public/fonts/instrument-serif-italic.woff2";
import serif from "../public/fonts/instrument-serif.woff2";
import indexHtml from "../public/index.html";
import stylesCss from "../public/styles.css";

const SHORT = "public, max-age=300";
// These never change under the same name; give a new file a new name to replace it.
const LONG = "public, max-age=604800";

const FILES: Record<string, { body: string | ArrayBuffer; type: string; cache: string }> = {
  "/": { body: indexHtml, type: "text/html; charset=utf-8", cache: "no-cache" },
  "/index.html": { body: indexHtml, type: "text/html; charset=utf-8", cache: "no-cache" },
  "/styles.css": { body: stylesCss, type: "text/css; charset=utf-8", cache: SHORT },
  "/app.js": { body: appJs, type: "text/javascript; charset=utf-8", cache: SHORT },
  "/bg.jpg": { body: bgJpg, type: "image/jpeg", cache: LONG },
  "/email-banner.jpg": { body: emailBannerJpg, type: "image/jpeg", cache: LONG },
  "/fonts/instrument-serif.woff2": { body: serif, type: "font/woff2", cache: LONG },
  "/fonts/instrument-serif-italic.woff2": { body: serifItalic, type: "font/woff2", cache: LONG },
};

export function staticFile(path: string): Response | null {
  const f = FILES[path];
  if (!f) return null;
  return new Response(f.body, {
    headers: {
      "Content-Type": f.type,
      "Cache-Control": f.cache,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      // Mail apps load the banner and font from other origins.
      ...(f.type.startsWith("font/") || path.endsWith(".jpg") ? { "Access-Control-Allow-Origin": "*" } : {}),
    },
  });
}
