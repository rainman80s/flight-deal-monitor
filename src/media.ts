/**
 * The owners' content library (Admin → Content): talking heads, trip photos and videos, licensed
 * music, and the finished posts ready for Instagram. Files live in the private R2 bucket MEDIA and
 * are only reachable through these admin-only routes (the caller has already checked the session
 * is an admin's; the central CSRF check covers every write).
 *
 *   GET    /api/admin/media?folder=            list a folder
 *   POST   /api/admin/media/start  {folder, name, type}      begin an upload  -> {key, uploadId}
 *   PUT    /api/admin/media/part?key=&uploadId=&n=           one chunk (≤ 50 MB) -> {n, etag}
 *   POST   /api/admin/media/finish {key, uploadId, parts}    complete the upload
 *   POST   /api/admin/media/abort  {key, uploadId}
 *   GET    /api/admin/media/file?key=                        download
 *   DELETE /api/admin/media?key=
 *
 * Uploads go in chunks because a single Worker request body tops out around 100 MB; phone videos
 * are often bigger. The weekly content run reads and writes the same bucket through Cloudflare's API.
 */
import type { Config } from "./config";
import type { User } from "./users";

export const FOLDERS = {
  "talking-heads": "Talking heads",
  "trip-photos": "Trip photos",
  "trip-videos": "Trip videos",
  "music": "Music",
  "ready": "Ready to post",
} as const;
export type Folder = keyof typeof FOLDERS;

const TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
  pdf: "application/pdf", txt: "text/plain",
};
const MAX_BYTES = 4 * 1024 ** 3; // 4 GB per file
const MAX_PART = 60 * 1024 ** 2; // chunks are 50 MB; allow a little slack

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

const isFolder = (f: unknown): f is Folder => typeof f === "string" && f in FOLDERS;

/** A safe, readable object name: "2026-11-13-k3j9qa-cabo sunset.mov". */
/** The name people see: stored name, or the key without its "2026-11-13-k3j9qa-" storage prefix. */
export const displayName = (key: string, stored?: string) =>
  stored ?? key.split("/").pop()!.replace(/^\d{4}-\d{2}-\d{2}-[a-z0-9]{1,8}-/, "");

export function objectKey(folder: Folder, name: string, now = new Date()): string | null {
  const clean = name.normalize("NFC").replace(/[\\/\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim().slice(-120);
  const ext = clean.split(".").pop()?.toLowerCase() ?? "";
  if (!clean || !TYPES[ext]) return null;
  const rand = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 6);
  return `${folder}/${now.toISOString().slice(0, 10)}-${rand}-${clean}`;
}

const validKey = (k: unknown): k is string =>
  typeof k === "string" && k.length < 400 && !k.includes("..") && isFolder(k.split("/")[0]) && k.split("/").length >= 2;

function bucket(cfg: Config): R2Bucket | null {
  return (cfg.env as unknown as { MEDIA?: R2Bucket }).MEDIA ?? null;
}

/**
 * "[REEL] flightdealphoenix9x16.mp4" and "[POST] flightdealphoenix4x4.mp4" share the caption
 * "[CAPTION] flightdealphoenix.txt" from the same week. Returns that shared name ("flightdealphoenix").
 */
export function postSlug(name: string): string | null {
  const m = name.match(/^\[(?:REEL|POST|CAPTION)\]\s*(.+?)(?:\d+x\d+)?\.(?:mp4|mov|txt)$/i);
  return m ? m[1].toLowerCase() : null;
}

/** Gives each finished video in Ready to post its caption text, so the page can copy it in one tap. */
async function attachCaptions(r2: R2Bucket, files: { key: string; name: string; caption?: string | null }[]) {
  const week = (key: string) => key.split("/")[1]?.slice(0, 10) ?? "";
  const captions = files.filter((f) => /^\[CAPTION\]/i.test(f.name)).slice(0, 80);
  const text = new Map<string, string>(); // "week|slug" and "slug" (newest wins) -> caption
  for (const c of captions) {
    const slug = postSlug(c.name);
    if (!slug) continue;
    const obj = await r2.get(c.key);
    if (!obj) continue;
    const body = (await new Response(obj.body).text()).slice(0, 5000);
    text.set(`${week(c.key)}|${slug}`, body);
    if (!text.has(slug)) text.set(slug, body); // files are newest first
  }
  for (const f of files) {
    if (!/^\[(REEL|POST)\]/i.test(f.name)) continue;
    const slug = postSlug(f.name);
    f.caption = slug ? text.get(`${week(f.key)}|${slug}`) ?? text.get(slug) ?? null : null;
  }
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try { const b = await req.json(); return b && typeof b === "object" ? b as Record<string, unknown> : null; } catch { return null; }
}

export async function mediaRoute(req: Request, url: URL, cfg: Config, u: User): Promise<Response> {
  const r2 = bucket(cfg);
  if (!r2) return json({ ok: false, error: "The content library isn't set up yet." }, 503);
  const p = url.pathname;
  const m = req.method;

  if (p === "/api/admin/media" && m === "GET") {
    const folder = url.searchParams.get("folder");
    if (!isFolder(folder)) return json({ ok: false, error: "Unknown folder." }, 400);
    const files: { key: string; name: string; size: number; uploaded: string; by: string | null; type: string | null; caption?: string | null }[] = [];
    let cursor: string | undefined;
    do {
      const page = await r2.list({ prefix: `${folder}/`, cursor, include: ["customMetadata", "httpMetadata"] });
      for (const o of page.objects) {
        files.push({ key: o.key, name: displayName(o.key, o.customMetadata?.name), size: o.size,
          uploaded: o.uploaded.toISOString(), by: o.customMetadata?.by ?? null, type: o.httpMetadata?.contentType ?? null });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && files.length < 2000);
    files.sort((a, b) => b.uploaded.localeCompare(a.uploaded) || a.key.localeCompare(b.key));
    if (folder === "ready") await attachCaptions(r2, files);
    return json({ ok: true, folder, files });
  }

  if (p === "/api/admin/media/start" && m === "POST") {
    const b = await body(req);
    if (!isFolder(b?.folder)) return json({ ok: false, error: "Pick a folder." }, 400);
    const name = String(b!.name ?? "");
    const size = Number(b!.size ?? 0);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) return json({ ok: false, error: "Files can be up to 4 GB." }, 400);
    const key = objectKey(b!.folder, name);
    if (!key) return json({ ok: false, error: "That file type isn't supported. Use photos, videos, audio, PDF or text." }, 400);
    const ext = key.split(".").pop()!.toLowerCase();
    const up = await r2.createMultipartUpload(key, {
      httpMetadata: { contentType: TYPES[ext] },
      customMetadata: { name: name.slice(-120), by: u.contact ?? u.name ?? u.email.split("@")[0] },
    });
    return json({ ok: true, key, uploadId: up.uploadId, chunk: 50 * 1024 ** 2 });
  }

  if (p === "/api/admin/media/part" && m === "PUT") {
    const key = url.searchParams.get("key");
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const n = Number(url.searchParams.get("n"));
    if (!validKey(key) || !uploadId || !Number.isInteger(n) || n < 1 || n > 10000) return json({ ok: false, error: "Bad request." }, 400);
    const len = Number(req.headers.get("Content-Length") ?? 0);
    if (!req.body || len > MAX_PART) return json({ ok: false, error: "Chunk too large." }, 413);
    const part = await r2.resumeMultipartUpload(key, uploadId).uploadPart(n, req.body);
    return json({ ok: true, n: part.partNumber, etag: part.etag });
  }

  if (p === "/api/admin/media/finish" && m === "POST") {
    const b = await body(req);
    const parts = Array.isArray(b?.parts) ? (b!.parts as { n: unknown; etag: unknown }[])
      .map((x) => ({ partNumber: Number(x.n), etag: String(x.etag) })) : [];
    if (!validKey(b?.key) || typeof b?.uploadId !== "string" || !parts.length) return json({ ok: false, error: "Bad request." }, 400);
    await r2.resumeMultipartUpload(b.key, b.uploadId).complete(parts.sort((a, c) => a.partNumber - c.partNumber));
    return json({ ok: true, key: b.key });
  }

  if (p === "/api/admin/media/abort" && m === "POST") {
    const b = await body(req);
    if (validKey(b?.key) && typeof b?.uploadId === "string") {
      try { await r2.resumeMultipartUpload(b.key, b.uploadId).abort(); } catch { /* already gone */ }
    }
    return json({ ok: true });
  }

  if (p === "/api/admin/media/file" && m === "GET") {
    const key = url.searchParams.get("key");
    if (!validKey(key)) return json({ ok: false, error: "Bad request." }, 400);
    const obj = await r2.get(key);
    if (!obj) return json({ ok: false, error: "Not found." }, 404);
    const name = displayName(key, obj.customMetadata?.name).replace(/["\r\n]/g, "");
    const inline = url.searchParams.get("view") === "1";
    return new Response(obj.body, { headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(obj.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  }

  if (p === "/api/admin/media" && m === "DELETE") {
    const key = url.searchParams.get("key");
    if (!validKey(key)) return json({ ok: false, error: "Bad request." }, 400);
    await r2.delete(key);
    return json({ ok: true });
  }

  return json({ ok: false, error: "Not found." }, 404);
}
