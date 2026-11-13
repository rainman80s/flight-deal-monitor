/** The owners' content library: only admins can see, upload, download or delete. */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { objectKey } from "../src/media";
import { UserStore } from "../src/users";
import { sessionFor, setup } from "./helpers";

const BASE = "https://flights.example.com";

/** Just enough of R2 for these routes, kept in memory. */
function fakeR2() {
  const objects = new Map<string, { data: Uint8Array; contentType?: string; meta: Record<string, string>; uploaded: Date }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array>; contentType?: string; meta: Record<string, string> }>();
  const bytes = async (b: ReadableStream | ArrayBuffer | string) => new Uint8Array(await new Response(b as BodyInit).arrayBuffer());
  return {
    objects,
    async list({ prefix }: { prefix: string }) {
      return { truncated: false, objects: [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({
        key, size: o.data.length, uploaded: o.uploaded, customMetadata: o.meta, httpMetadata: { contentType: o.contentType } })) };
    },
    async createMultipartUpload(key: string, o: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
      const uploadId = `up${uploads.size + 1}`;
      uploads.set(uploadId, { key, parts: new Map(), contentType: o.httpMetadata?.contentType, meta: o.customMetadata ?? {} });
      return { uploadId };
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) throw new Error("no such upload");
      return {
        async uploadPart(n: number, body: ReadableStream) { u.parts.set(n, await bytes(body)); return { partNumber: n, etag: `e${n}` }; },
        async complete(parts: { partNumber: number }[]) {
          const chunks = parts.map((p) => u.parts.get(p.partNumber)!);
          const data = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
          let off = 0;
          for (const c of chunks) { data.set(c, off); off += c.length; }
          objects.set(key, { data, contentType: u.contentType, meta: u.meta, uploaded: new Date() });
          uploads.delete(uploadId);
        },
        async abort() { uploads.delete(uploadId); },
      };
    },
    async get(key: string) {
      const o = objects.get(key);
      return o ? { body: o.data, size: o.data.length, httpMetadata: { contentType: o.contentType }, customMetadata: o.meta } : null;
    },
    async delete(key: string) { objects.delete(key); },
  };
}

function site() {
  const ctx = setup({ dryRun: false });
  const r2 = fakeR2();
  Object.assign(ctx.cfg.env, { MEDIA: r2 });
  const deps = { ...ctx, fareProvider: () => { throw new Error("unused"); }, background: () => {} };
  const raw = (method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) =>
    handle(new Request(BASE + path, { method, body: init.body, headers: { Origin: BASE, ...init.headers } }), deps as never);
  const call = async (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const res = await raw(method, path, { body: data === undefined ? undefined : JSON.stringify(data),
      headers: { "Content-Type": "application/json", ...headers } });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { ...ctx, r2, raw, call };
}

describe("content library", () => {
  it("admins upload in chunks, list, download and delete", async () => {
    const s = site();
    const a = await sessionFor(s.cfg, { role: "admin", contact: "RAN", email: "ran@example.com" });
    const A = { Cookie: a.cookie };
    const start = await s.call("POST", "/api/admin/media/start", { folder: "trip-videos", name: "Cabo sunset.MOV", size: 11 }, A);
    expect(start.status).toBe(200);
    expect(start.body.key).toMatch(/^trip-videos\/\d{4}-\d{2}-\d{2}-[a-z0-9]{1,6}-Cabo sunset\.MOV$/);
    const q = (n: number) => `/api/admin/media/part?${new URLSearchParams({ key: start.body.key, uploadId: start.body.uploadId, n: String(n) })}`;
    const p1 = await (await s.raw("PUT", q(1), { body: "hello ", headers: A })).json() as { etag: string };
    const p2 = await (await s.raw("PUT", q(2), { body: "world", headers: A })).json() as { etag: string };
    const fin = await s.call("POST", "/api/admin/media/finish",
      { key: start.body.key, uploadId: start.body.uploadId, parts: [{ n: 2, etag: p2.etag }, { n: 1, etag: p1.etag }] }, A);
    expect(fin.status).toBe(200);

    const list = await s.call("GET", "/api/admin/media?folder=trip-videos", undefined, A);
    expect(list.body.files).toHaveLength(1);
    expect(list.body.files[0]).toMatchObject({ name: "Cabo sunset.MOV", size: 11, by: "RAN", type: "video/quicktime" });

    const dl = await s.raw("GET", `/api/admin/media/file?key=${encodeURIComponent(start.body.key)}`, { headers: A });
    expect(await dl.text()).toBe("hello world");
    expect(dl.headers.get("Content-Disposition")).toContain("attachment");

    await s.call("DELETE", `/api/admin/media?key=${encodeURIComponent(start.body.key)}`, undefined, A);
    expect((await s.call("GET", "/api/admin/media?folder=trip-videos", undefined, A)).body.files).toHaveLength(0);
  });

  it("is admins only: testers and members get 403, visitors 401, other sites can't write", async () => {
    const s = site();
    const t = await sessionFor(s.cfg, { email: "t@example.com" });
    await UserStore.for(s.cfg).setRole(t.user.id, "tester", null);
    const m = await sessionFor(s.cfg, { email: "m@example.com" });
    for (const c of [t.cookie, m.cookie]) {
      expect((await s.call("GET", "/api/admin/media?folder=music", undefined, { Cookie: c })).status).toBe(403);
      expect((await s.call("POST", "/api/admin/media/start", { folder: "music", name: "x.mp3", size: 1 }, { Cookie: c })).status).toBe(403);
    }
    expect((await s.call("GET", "/api/admin/media?folder=music")).status).toBe(401);
    const a = await sessionFor(s.cfg, { role: "admin", contact: "RAN", email: "ran@example.com" });
    expect((await s.call("POST", "/api/admin/media/start", { folder: "music", name: "x.mp3", size: 1 },
      { Cookie: a.cookie, Origin: "https://evil.example" })).status).toBe(403);
  });

  it("refuses unknown folders, file types, oversized files and keys outside the library", async () => {
    const s = site();
    const a = await sessionFor(s.cfg, { role: "admin", contact: "RAN", email: "ran@example.com" });
    const A = { Cookie: a.cookie };
    expect((await s.call("POST", "/api/admin/media/start", { folder: "secrets", name: "x.mp4", size: 1 }, A)).status).toBe(400);
    expect((await s.call("POST", "/api/admin/media/start", { folder: "music", name: "evil.exe", size: 1 }, A)).status).toBe(400);
    expect((await s.call("POST", "/api/admin/media/start", { folder: "music", name: "a.mp3", size: 5e9 }, A)).status).toBe(400);
    for (const key of ["../users.db", "secrets/x.mp4", "music/../../x", "music"]) {
      expect((await s.raw("GET", `/api/admin/media/file?key=${encodeURIComponent(key)}`, { headers: A })).status, key).toBe(400);
    }
    expect(objectKey("music", "../../a/b.mp3")).toMatch(/^music\/[^/]+-\.\.\.\.ab\.mp3$|^music\/[^/]+ab\.mp3$|^music\/.+\.mp3$/);
    expect(objectKey("music", "../../a/b.mp3")!.split("/")).toHaveLength(2);
  });
});
