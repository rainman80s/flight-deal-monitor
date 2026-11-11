/**
 * The website's files, bundled into the Worker (wrangler.toml [[rules]]: text as strings,
 * images and fonts as bytes), plus robots.txt, sitemap.xml and the web app manifest, which
 * are generated so they always carry the site's real address (PUBLIC_BASE_URL).
 */
import appJs from "../public/app.js";
import appleTouchIcon from "../public/apple-touch-icon.png";
import bgJpg from "../public/bg.jpg";
import emailBannerJpg from "../public/email-banner.jpg";
import serifItalic from "../public/fonts/instrument-serif-italic.woff2";
import serif from "../public/fonts/instrument-serif.woff2";
import icon192 from "../public/icon-192.png";
import icon512 from "../public/icon-512.png";
import indexHtml from "../public/index.html";
import ogJpg from "../public/og.jpg";
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
  "/og.jpg": { body: ogJpg, type: "image/jpeg", cache: LONG },
  "/email-banner.jpg": { body: emailBannerJpg, type: "image/jpeg", cache: LONG },
  "/icon-192.png": { body: icon192, type: "image/png", cache: LONG },
  "/icon-512.png": { body: icon512, type: "image/png", cache: LONG },
  "/apple-touch-icon.png": { body: appleTouchIcon, type: "image/png", cache: LONG },
  "/fonts/instrument-serif.woff2": { body: serif, type: "font/woff2", cache: LONG },
  "/fonts/instrument-serif-italic.woff2": { body: serifItalic, type: "font/woff2", cache: LONG },
};

/** Pages a search engine should list. The rest of the site lives at #anchors on "/". */
const PUBLIC_PAGES = ["/"];

function generated(path: string, base: string): { body: string; type: string } | null {
  if (path === "/robots.txt") {
    return { type: "text/plain; charset=utf-8", body: ["User-agent: *", "Allow: /", "Disallow: /api/", "Disallow: /admin/",
      "Disallow: /u/", "Disallow: /d/", `Sitemap: ${base}/sitemap.xml`, ""].join("\n") };
  }
  if (path === "/sitemap.xml") {
    return { type: "application/xml; charset=utf-8", body: `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
      + PUBLIC_PAGES.map((p) => `<url><loc>${base}${p}</loc><changefreq>hourly</changefreq></url>`).join("")
      + `</urlset>\n` };
  }
  if (path === "/manifest.webmanifest") {
    return { type: "application/manifest+json", body: JSON.stringify({
      name: "Fare Radar", short_name: "Fare Radar",
      description: "Cheap round trips out of Seattle and Portland, found day and night.",
      start_url: "/", scope: "/", display: "standalone", background_color: "#0e1d22", theme_color: "#0e1d22",
      icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }],
    }) };
  }
  return null;
}

export function staticFile(path: string, base = ""): Response | null {
  const gen = generated(path, base);
  const f = gen ? { ...gen, cache: SHORT } : FILES[path];
  if (!f) return null;
  // Page metadata (link previews, canonical URL) needs the site's absolute address.
  const body = typeof f.body === "string" && f.type.startsWith("text/html") ? f.body.replaceAll("{{BASE}}", base) : f.body;
  return new Response(body, {
    headers: {
      "Content-Type": f.type,
      "Cache-Control": f.cache,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      // Mail apps load the banner and font from other origins.
      ...(f.type.startsWith("font/") || f.type.startsWith("image/") ? { "Access-Control-Allow-Origin": "*" } : {}),
    },
  });
}
