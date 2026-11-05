import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Mirror wrangler.toml's [[rules]] Text: files in public/ import as plain strings.
// Imports are redirected to a virtual id so Vite's own CSS/JS handling never sees them.
const PREFIX = "\0public-text:";

export default defineConfig({
  plugins: [{
    name: "public-as-text",
    enforce: "pre",
    resolveId(source, importer) {
      if (importer && /(^|\/)public\/[^/]+\.(html|css|js)$/.test(source)) {
        return PREFIX + resolve(dirname(importer), source) + ".text"; // no .css suffix, so Vitest's CSS stub skips it
      }
    },
    load(id) {
      if (id.startsWith(PREFIX)) {
        return `export default ${JSON.stringify(readFileSync(id.slice(PREFIX.length, -".text".length), "utf8"))};`;
      }
    },
  }],
});
