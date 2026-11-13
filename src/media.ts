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
    const files: { key: string; name: string; size: number; uploaded: string; by: string | null; type: string | null }[] = [];
    let cursor: string | undefined;
    do {
      const page = await r2.list({ prefix: `${folder}/`, cursor, include: ["customMetadata", "httpMetadata"] });
      for (const o of page.objects) {
        files.push({ key: o.key, name: o.customMetadata?.name ?? o.key.split("/").pop()!, size: o.size,
          uploaded: o.uploaded.toISOString(), by: o.customMetadata?.by ?? null, type: o.httpMetadata?.contentType ?? null });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor && files.length < 2000);
    files.sort((a, b) => b.uploaded.localeCompare(a.uploaded) || a.key.localeCompare(b.key));
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
    const name = (obj.customMetadata?.name ?? key.split("/").pop()!).replace(/["\r\n]/g, "");
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
