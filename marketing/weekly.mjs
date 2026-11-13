// Weekly content run for Fare Radar.
//
// Reads the owners' content library (R2 bucket fareradar-media: talking-heads, trip-photos,
// trip-videos, music), pulls this week's real deals from the live site, renders the week's posts
// with Remotion, and uploads them with caption files to the "Ready to post" folder, which shows on
// the site's Admin → Content page.
//
//   node weekly.mjs            build and upload this week's posts
//   node weekly.mjs --dry-run  build locally into out/, upload nothing
//
// Needs: ffmpeg, python3 with librosa, Chromium (Playwright's), and Cloudflare API access (the
// cloud environment injects the credential; locally set CLOUDFLARE_API_TOKEN).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PUB = join(HERE, "public");
const WORK = join(HERE, "work");
const OUT = join(HERE, "out");
const BUCKET = "fareradar-media";
const ZONE = "d02189e26c759a474222e0130b20b36c"; // fareradar.cc
const SITE = "https://flight-deal-monitor.ranenbothel.workers.dev";
const DRY = process.argv.includes("--dry-run");
const CHROME = existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : null;
const today = new Date().toISOString().slice(0, 10);
const log = (...a) => console.log(`[weekly]`, ...a);

rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28, ...opts }).toString();
const token = process.env.CLOUDFLARE_API_TOKEN || "dummy"; // the cloud proxy swaps in the real key
const env = { ...process.env, CLOUDFLARE_API_TOKEN: token };
const cf = (path) => JSON.parse(run("curl", ["-sS", `https://api.cloudflare.com/client/v4${path}`, "-H", `Authorization: Bearer ${token}`]));
const wrangler = (...args) => run(join(ROOT, "node_modules/.bin/wrangler"), args, { cwd: ROOT, env });

// ---------- library ----------
const account = cf(`/zones/${ZONE}`).result.account.id;
function list(prefix) {
  const out = [];
  let cursor = "";
  do {
    const r = cf(`/accounts/${account}/r2/buckets/${BUCKET}/objects?prefix=${encodeURIComponent(prefix)}&per_page=1000${cursor ? `&cursor=${cursor}` : ""}`);
    out.push(...(r.result || []));
    cursor = r.result_info?.is_truncated ? r.result_info.cursor : "";
  } while (cursor);
  return out.map((o) => ({ key: o.key, size: o.size, uploaded: o.last_modified, type: o.http_metadata?.contentType || "" }));
}
/** Downloads an object straight from Cloudflare's R2 API (more reliable than wrangler for big files). */
function get(key, file) {
  const code = run("curl", ["-sS", "-o", file, "-w", "%{http_code}", "--retry", "3",
    `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`,
    "-H", `Authorization: Bearer ${token}`]).trim();
  if (code !== "200") { rmSync(file, { force: true }); throw new Error(`download of ${key} failed (${code})`); }
  return file;
}
function put(key, file, type) { wrangler("r2", "object", "put", `${BUCKET}/${key}`, "--remote", "--file", file, "--content-type", type); }

const USED_KEY = "system/used.json"; // not a library folder, so it never shows on the Content page
let used = {};
try { used = JSON.parse(readFileSync(get(USED_KEY, join(WORK, "used.json")), "utf8")); } catch { used = {}; }
const fresh = (files) => files.filter((f) => !used[f.key]).sort((a, b) => a.uploaded.localeCompare(b.uploaded));
const leastUsed = (files) => [...files].sort((a, b) => (used[a.key] || "").localeCompare(used[b.key] || ""));
const pick = (files, n) => { const f = fresh(files); return (f.length ? f : leastUsed(files)).slice(0, n); };
const mark = (f) => { used[f.key] = today; };

// ---------- deals ----------
const fmt = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const AIR = { AS: "Alaska", DL: "Delta", UA: "United", AA: "American", WN: "Southwest", B6: "JetBlue", F9: "Frontier", NK: "Spirit",
  G4: "Allegiant", HA: "Hawaiian", SY: "Sun Country", AC: "Air Canada", WS: "WestJet", AM: "Aeroméxico", Y4: "Volaris", ZG: "ZIPAIR",
  JL: "JAL", NH: "ANA", KE: "Korean Air", BA: "British Airways", LH: "Lufthansa", AF: "Air France", KL: "KLM", EI: "Aer Lingus",
  IB: "Iberia", FI: "Icelandair", TK: "Turkish", EK: "Emirates", QR: "Qatar", NZ: "Air New Zealand", CX: "Cathay Pacific" };
const shortCity = (c) => c.replace(/^San José del Cabo$/, "Cabo").replace(/ (International|Narita|Haneda)$/, "");
const getDeals = (kind) => JSON.parse(run("curl", ["-sS", `${SITE}/api/deals?kind=${kind}&sort=value&limit=60`])).deals.filter((d) => !d.is_fake);
const all = [...getDeals("domestic"), ...getDeals("international")];
if (all.length < 4) throw new Error(`only ${all.length} live deals; not enough for a week of posts`);
const below = (d) => (d.typical?.median && d.price < d.typical.median ? 1 - d.price / d.typical.median : 0);
const toDeal = (d) => ({
  from: d.origin_city, origin: d.origin, to: shortCity(d.destination_city), price: Math.round(d.price),
  usual: d.typical?.median && d.typical.median > d.price ? Math.round(d.typical.median) : null,
  dates: `${fmt(d.depart_date)} → ${fmt(d.return_date)}`,
  airline: [...new Set(d.airlines)].length === 1 ? AIR[d.airlines[0]] || d.airlines[0] : "",
});
// Headline deals must be exact quotes (not calendar/explore estimates) so the price in the ad is real.
const exact = all.filter((d) => !d.estimate);
const ranked = [...(exact.length >= 3 ? exact : all)].sort((a, b) => below(b) - below(a) || a.price - b.price);
const hero = ranked[0];
const seen = new Set([hero.destination]);
const listDeals = [...(exact.length >= 6 ? exact : all)].sort((a, b) => a.price - b.price).filter((d) => !seen.has(d.destination) && seen.add(d.destination)).slice(0, 5);
const alertDeal = (exact.length >= 3 ? exact : all).filter((d) => d.outbound_stops === 0 && d.return_stops === 0 && !seen.has(d.destination))
  .sort((a, b) => below(b) - below(a))[0] || ranked[1];
const tripDeal = all.filter((d) => d.kind === "international").sort((a, b) => a.price - b.price)[0] || alertDeal;
log(`hero ${hero.origin}-${hero.destination} $${hero.price}; ${all.length} live deals`);

// ---------- media prep ----------
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
rmSync(PUB, { recursive: true, force: true }); mkdirSync(PUB, { recursive: true });
for (const f of ["bg.jpg", "fonts/instrument-serif.woff2", "fonts/instrument-serif-italic.woff2"]) copyFileSync(join(ROOT, "public", f), join(PUB, f.split("/").pop()));
for (const w of [500, 600, 700, 800]) copyFileSync(join(HERE, "node_modules/@fontsource/inter/files", `inter-latin-${w}-normal.woff2`), join(PUB, `inter-latin-${w}-normal.woff2`));
const ext = (k) => k.split(".").pop().toLowerCase();
const ff = (...a) => run("ffmpeg", ["-y", "-loglevel", "error", ...a]);
const duration = (file) => Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).trim()) || 0;
const COVER = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1";

const lib = { heads: list("talking-heads/"), photos: list("trip-photos/"), videos: list("trip-videos/"), music: list("music/") };
log(`library: ${lib.heads.length} talking heads, ${lib.photos.length} photos, ${lib.videos.length} videos, ${lib.music.length} music files`);

const beatsFiles = lib.music.filter((f) => ["mp3", "wav", "m4a", "aac"].includes(ext(f.key)));
if (!beatsFiles.length) throw new Error("no music in the library; add a licensed beat to Music");
const beatFile = leastUsed(beatsFiles)[0];
mark(beatFile);
const beatPath = get(beatFile.key, join(WORK, `beat.${ext(beatFile.key)}`));
const grid = JSON.parse(run("python3", ["-I", join(HERE, "beat.py"), beatPath]));
ff("-ss", String(grid.start), "-t", "15.2", "-i", beatPath, "-af", "afade=t=out:st=14.3:d=0.9", join(PUB, "cut.mp3"));
log(`beat ${beatFile.key}: ${grid.tempo} BPM, drop at ${grid.drop}s`);

const photos = [];
for (const f of pick(lib.photos.filter((x) => ["jpg", "jpeg", "png", "webp"].includes(ext(x.key))), 4)) {
  try {
    const src = get(f.key, join(WORK, `p${photos.length}.${ext(f.key)}`));
    const name = `photo${photos.length}.jpg`;
    ff("-i", src, "-vf", "scale=1600:-2", "-q:v", "3", join(PUB, name));
    photos.push(name); mark(f);
  } catch (e) { log(`skipped photo ${f.key}: ${e.message.split("\n")[0]}`); }
}
const clips = [];
for (const f of pick(lib.videos.filter((x) => ["mp4", "mov", "m4v", "webm"].includes(ext(x.key))), 4)) {
  try {
    const src = get(f.key, join(WORK, `v${clips.length}.${ext(f.key)}`));
    const mid = Math.max(0, duration(src) / 2 - 1.5);
    const name = `clip${clips.length}.mp4`;
    ff("-ss", String(mid), "-t", "3", "-i", src, "-vf", `${COVER},fps=30`, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", join(PUB, name));
    clips.push(name); mark(f);
  } catch (e) { log(`skipped clip ${f.key}: ${e.message.split("\n")[0]}`); }
}

// ---------- render ----------
const render = (comp, props, file) => {
  const propsFile = join(WORK, `${comp}.json`);
  writeFileSync(propsFile, JSON.stringify(props));
  run("npx", ["remotion", "render", "src/index.ts", comp, join(OUT, file), `--props=${propsFile}`, "--crf=18", "--log=error",
    ...(CHROME ? [`--browser-executable=${CHROME}`] : [])], { cwd: HERE });
  log(`rendered ${file}`);
  return file;
};
const month = new Date().toLocaleDateString("en-US", { month: "short", year: "numeric" });
const link = `https://fareradar.cc/?utm_source=instagram&utm_medium=social&utm_campaign=${today}`;
const tags = "#Seattle #Portland #SEA #PDX #cheapflights #flightdeals #PNW";
const credit = `Music: licensed beat "${beatFile.key.split("/").pop().replace(/^\d{4}-\d{2}-\d{2}-[a-z0-9]+-/, "").replace(/\.[^.]+$/, "")}"`;
const posts = [];

const H = toDeal(hero);
const adProps = { beats: grid.beats, audio: "cut.mp3", hero: H, list: listDeals.map(toDeal), alert: toDeal(alertDeal),
  photo: photos[0] || null, clips: clips.slice(0, 4), month };
posts.push({ files: [render("DealDropVertical", adProps, "1 Deal Drop (Reels, TikTok, Stories).mp4"),
  render("DealDropSquare", adProps, "1 Deal Drop (feed, square).mp4")],
  caption: `${H.from} → ${H.to} for $${H.price} round trip${H.usual ? ` (usually about $${H.usual})` : ""}. ✈️\n\n`
    + `${H.dates}${H.airline ? ` on ${H.airline}` : ""}. We check fares out of SEA and PDX every hour, and this is the best one this week.\n\n`
    + `More this week:\n${listDeals.slice(0, 4).map((d) => `• ${d.origin} → ${shortCity(d.destination_city)} $${Math.round(d.price)}`).join("\n")}\n\n`
    + `Free deal alerts: ${link}\n(link in bio)\n\nPrices change fast, so book soon if you want it.\n\n${tags}\n${credit}` });

if (clips.length || photos.length > 1) {
  const T = toDeal(tripDeal);
  posts.push({ files: [render("TripEdit", { beats: grid.beats, audio: "cut.mp3", clips, photos: photos.slice(1).length ? photos.slice(1) : photos,
    deal: T, caption: "Go somewhere." }, "2 Trip edit (Reels, TikTok).mp4")],
  caption: `This is why we built Fare Radar. 🌎\n\nThis week: ${T.from} → ${T.to} for $${T.price} round trip (${T.dates}).\n\n`
    + `Free alerts when fares out of Seattle and Portland drop: ${link}\n\n${tags}\n${credit}` });
}

const head = pick(lib.heads.filter((x) => ["mp4", "mov", "m4v", "webm"].includes(ext(x.key))), 1)[0];
if (head) {
  try {
    const src = get(head.key, join(WORK, `talk.${ext(head.key)}`));
    const secs = Math.min(58, duration(src));
    ff("-i", src, "-t", String(secs), "-vf", `${COVER},fps=30`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
      "-c:a", "aac", "-b:a", "160k", "-ac", "2", join(PUB, "talk.mp4"));
    const obj = cf(`/accounts/${account}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(head.key)}`);
    const by = obj?.result?.custom_metadata?.by || null;
    const name = by ? by.charAt(0) + by.slice(1).toLowerCase() : null;
    posts.push({ files: [render("Founder", { video: "talk.mp4", seconds: secs, name }, "3 Founder clip (Reels, TikTok).mp4")],
      caption: `${name ? `${name} here. ` : ""}We built Fare Radar because cheap flights out of Seattle and Portland are out there, you just have to catch them.\n\n`
        + `It's free: ${link}\n\n${tags}` });
    mark(head);
  } catch (e) { log(`skipped talking head ${head.key}: ${e.message.split("\n")[0]}`); }
}

// ---------- deliver ----------
const plan = [`Fare Radar posts for the week of ${today}`, "",
  ...posts.map((p, i) => `${i + 1}. ${p.files.join(" + ")}`), "",
  "Suggested schedule: post 1 Monday evening, post 2 Wednesday, post 3 Friday. Put the link in your bio.",
  "Also here: Talking-head scripts to record.txt. Film one or more this week and drop them in Talking heads.",
  `Link for bio: ${link}`, "", "Captions are in the matching .txt files."].join("\n");
writeFileSync(join(OUT, "0 This week's plan.txt"), plan);
posts.forEach((p, i) => writeFileSync(join(OUT, `${i + 1} caption.txt`), p.caption));

// ---------- talking-head scripts to record ----------
// Short scripts built from this week's real deals, for Ran and Brock to film and drop into
// Talking heads. The next Sunday run turns each recording into a branded founder clip.
const d1 = toDeal(hero);
// Each script names a different place, so the three don't repeat each other.
const others = ranked.filter((d) => d.destination !== hero.destination);
const d2raw = others.find((d) => d.outbound_stops === 0 && d.return_stops === 0) || others[0] || alertDeal;
const d3raw = others.find((d) => d.destination !== d2raw.destination && d.origin !== d2raw.origin)
  || others.find((d) => d.destination !== d2raw.destination) || listDeals[0] || ranked[1];
const d2 = toDeal(d2raw);
const d3 = toDeal(d3raw);
const off = (d) => (d.usual ? Math.round((1 - d.price / d.usual) * 100) : null);
const scripts = [
  { title: "The deal of the week (20–30 sec)", lines: [
    `HOOK (look straight at the camera, say it fast): "${d1.from} to ${d1.to}. ${d1.price} bucks. Round trip."`,
    d1.usual ? `"That route usually runs about $${d1.usual}. That's ${off(d1)}% off."` : `"That's one of the cheapest fares we've seen on that route."`,
    `"${d1.dates}${d1.airline ? `, on ${d1.airline}` : ""}. Fares like this don't last, so if you want it, book it this week."`,
    `CTA: "We find these every hour out of Seattle and Portland. Alerts are free. Link's in our bio."`,
  ] },
  { title: "Why we built it (30–40 sec)", lines: [
    `HOOK: "We got tired of checking flight prices every single day. So we built something that does it for us."`,
    `"Fare Radar checks round trips out of SEA and PDX every hour, compares them to what that route normally costs, and only emails you when something's actually cheap."`,
    `"Like this week: ${d2.from} to ${d2.to} for $${d2.price}${d2.airline ? ` on ${d2.airline}` : ""}."`,
    `CTA: "No ads, no booking fees. It's free. Link's in our bio."`,
  ] },
  { title: "Quick tip (20–30 sec)", lines: [
    `HOOK: "Here's how to actually catch a cheap flight out of ${d3.origin === "PDX" ? "Portland" : "Seattle"}."`,
    `"Be flexible by a day or two. The same trip can cost a lot less if you leave midweek instead of on a Friday."`,
    `"And when you see a good fare, book it. In the US you can usually cancel within 24 hours for a full refund."`,
    `CTA: "This week we found ${d3.from} to ${d3.to} for $${d3.price}. We post these every week. Follow for more."`,
  ] },
];
const scriptText = [`Talking-head scripts to record (week of ${today})`, "",
  "How to film: phone vertical at eye level, face a window for light, quiet room. One take each is fine.",
  "Talk like you're telling a friend, not reading. Pause a second before you start and after you finish.",
  "Upload to Admin → Content → Talking heads. Next Sunday's run turns each one into a branded post.", "",
  ...scripts.flatMap((sc, i) => [`${i + 1}. ${sc.title}`, ...sc.lines.map((l) => `   ${l}`), ""]),
  "Prices are this week's real deals. If you film more than a few days later, check the fare on",
  "fareradar.cc and use the current price, or leave the exact number out."].join("\n");
writeFileSync(join(OUT, "Talking-head scripts to record.txt"), scriptText);

const uploads = [["0 This week's plan.txt", "text/plain"], ["Talking-head scripts to record.txt", "text/plain"], ...posts.flatMap((p, i) => [...p.files.map((f) => [f, "video/mp4"]), [`${i + 1} caption.txt`, "text/plain"]])];
if (DRY) { log(`dry run: ${uploads.length} files in ${OUT}`); process.exit(0); }
for (const [file, type] of uploads) {
  const rand = Math.random().toString(36).slice(2, 8);
  put(`ready/${today}-${rand}-${today} ${file}`, join(OUT, file), type);
}
writeFileSync(join(WORK, "used.json"), JSON.stringify(used, null, 1));
put(USED_KEY, join(WORK, "used.json"), "application/json");
log(`uploaded ${uploads.length} files to Ready to post`);
console.log(JSON.stringify({ week: today, posts: posts.map((p) => p.files), hero: `${H.from} → ${H.to} $${H.price}`, beat: beatFile.key }));
