/** The website's files, bundled into the Worker (wrangler.toml [[rules]]: text as strings, images as bytes). */
import appJs from "../public/app.js";
import bgJpg from "../public/bg.jpg";
import indexHtml from "../public/index.html";
import stylesCss from "../public/styles.css";

const FILES: Record<string, { body: string | ArrayBuffer; type: string; cache: string }> = {
  "/": { body: indexHtml, type: "text/html; charset=utf-8", cache: "no-cache" },
  "/index.html": { body: indexHtml, type: "text/html; charset=utf-8", cache: "no-cache" },
  "/styles.css": { body: stylesCss, type: "text/css; charset=utf-8", cache: "public, max-age=300" },
  "/app.js": { body: appJs, type: "text/javascript; charset=utf-8", cache: "public, max-age=300" },
  // The photo never changes under this name; swap the file name to replace it.
  "/bg.jpg": { body: bgJpg, type: "image/jpeg", cache: "public, max-age=604800" },
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
    },
  });
}
