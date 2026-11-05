/** The website's three files, bundled into the Worker as text (wrangler.toml [[rules]]). */
import appJs from "../public/app.js";
import indexHtml from "../public/index.html";
import stylesCss from "../public/styles.css";

const FILES: Record<string, { body: string; type: string }> = {
  "/": { body: indexHtml, type: "text/html; charset=utf-8" },
  "/index.html": { body: indexHtml, type: "text/html; charset=utf-8" },
  "/styles.css": { body: stylesCss, type: "text/css; charset=utf-8" },
  "/app.js": { body: appJs, type: "text/javascript; charset=utf-8" },
};

export function staticFile(path: string): Response | null {
  const f = FILES[path];
  if (!f) return null;
  return new Response(f.body, {
    headers: {
      "Content-Type": f.type,
      "Cache-Control": path.endsWith(".html") || path === "/" ? "no-cache" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  });
}
