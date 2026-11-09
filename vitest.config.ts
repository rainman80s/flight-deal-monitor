import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Mirror wrangler.toml's [[rules]]: text files in public/ import as strings, images as ArrayBuffers.
// Imports are redirected to a virtual id so Vite's own CSS/JS handling never sees them.
const PREFIX = "\0public-text:";

export default defineConfig({
  plugins: [{
    name: "public-as-text",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /(^|\/)public\/[^/]+\.(html|css|js|jpg)$/.test(source)) {
        return PREFIX + resolve(dirname(importer), source) + ".text"; // no .css suffix, so Vitest's CSS stub skips it
      }
    },
    load(id) {
      if (id.startsWith(PREFIX) && id.endsWith(".jpg.text")) {
        const b64 = readFileSync(id.slice(PREFIX.length, -".text".length)).toString("base64");
        return `export default Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0)).buffer;`;
      }
      if (id.startsWith(PREFIX)) {
        return `export default ${JSON.stringify(readFileSync(id.slice(PREFIX.length, -".text".length), "utf8"))};`;
      }
    },
  }],
});
