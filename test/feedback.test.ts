/** Beta feedback: testers send it, owners read it, nobody else can do either. */
import { describe, expect, it } from "vitest";
import { handle } from "../src/app";
import { UserStore } from "../src/users";
import { sessionFor, setup } from "./helpers";

const BASE = "https://flights.example.com";

function site() {
  const ctx = setup({ dryRun: false });
  Object.assign(ctx.cfg.env, { RESEND_API_KEY: "re_test" });
  const deps = { ...ctx, fareProvider: () => { throw new Error("unused"); }, background: () => {} };
  const mail: { to: string; subject: string; text: string }[] = [];
  const call = async (method: string, path: string, data?: unknown, headers: Record<string, string> = {}) => {
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, i: RequestInit = {}) => {
      if (String(url).startsWith("https://api.resend.com")) {
        const b = JSON.parse(i.body as string);
        mail.push({ to: b.to[0], subject: b.subject, text: b.text });
        return new Response(JSON.stringify({ id: "m" }));
      }
      return real(url, i);
    }) as typeof fetch;
    try {
      const res = await handle(new Request(BASE + path, { method, body: data === undefined ? undefined : JSON.stringify(data),
        headers: { "Content-Type": "application/json", Origin: BASE, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1", ...headers } }), deps as never);
      return { status: res.status, body: await res.json() as Record<string, any> };
    } finally { globalThis.fetch = real; }
  };
  return { ...ctx, call, mail, users: UserStore.for(ctx.cfg) };
}

async function tester(s: ReturnType<typeof site>, email = "beta@example.com") {
  const t = await sessionFor(s.cfg, { email });
  await s.users.setRole(t.user.id, "tester", null);
  return t;
}

describe("beta feedback", () => {
  it("testers send feedback; it's stored encrypted and the owners are emailed", async () => {
    const s = site();
    const t = await tester(s);
    const r = await s.call("POST", "/api/account/feedback", { kind: "bug", message: "Share didn't copy on my phone", page: "browse" }, { Cookie: t.cookie });
    expect(r.status).toBe(200);
    const row = await s.cfg.env.DB.prepare("SELECT * FROM feedback").first<Record<string, string>>();
    expect(row).toMatchObject({ kind: "bug", page: "browse", status: "new", device: "iPhone · Safari" });
    expect(row!.message_enc).not.toContain("Share");
    const ownerEmails = s.cfg.contacts.filter((c) => c.email).map((c) => c.email);
    expect(s.mail.map((m) => m.to).sort()).toEqual([...ownerEmails].sort());
    expect(s.mail[0].subject).toBe("Bug report from beta@example.com");
    expect(s.mail[0].text).toContain("Share didn't copy on my phone");
  });

  it("owners list, read and close feedback; testers and members can't", async () => {
    const s = site();
    const t = await tester(s);
    await s.call("POST", "/api/account/feedback", { kind: "idea", message: "Add Boise as a home airport" }, { Cookie: t.cookie });
    const a = await sessionFor(s.cfg, { role: "admin", contact: "RAN", email: "ran@example.com" });
    const A = { Cookie: a.cookie };
    const open = await s.call("GET", "/api/admin/feedback", undefined, A);
    expect(open.body.items).toHaveLength(1);
    expect(open.body.items[0]).toMatchObject({ kind: "idea", message: "Add Boise as a home airport", from: { email: "beta@example.com", role: "tester" } });
    expect(open.body.counts).toMatchObject({ open: 1, done: 0 });
    const id = open.body.items[0].id;
    expect((await s.call("PUT", "/api/admin/feedback/status", { id, status: "done" }, A)).status).toBe(200);
    expect((await s.call("GET", "/api/admin/feedback", undefined, A)).body.items).toHaveLength(0);
    expect((await s.call("GET", "/api/admin/feedback?status=done", undefined, A)).body.items).toHaveLength(1);

    expect((await s.call("GET", "/api/admin/feedback", undefined, { Cookie: t.cookie })).status).toBe(403);
    expect((await s.call("GET", "/api/admin/feedback")).status).toBe(401);
  });

  it("is for testers and owners only, validates input, and limits volume", async () => {
    const s = site();
    const m = await sessionFor(s.cfg, { email: "member@example.com" });
    expect((await s.call("POST", "/api/account/feedback", { kind: "bug", message: "hello there" }, { Cookie: m.cookie })).status).toBe(403);
    expect((await s.call("POST", "/api/account/feedback", { kind: "bug", message: "hello there" })).status).toBe(401);
    const t = await tester(s);
    const T = { Cookie: t.cookie };
    expect((await s.call("POST", "/api/account/feedback", { kind: "bug", message: " " }, T)).status).toBe(400);
    expect((await s.call("POST", "/api/account/feedback", { kind: "bug", message: "x".repeat(4001) }, T)).status).toBe(400);
    expect((await s.call("POST", "/api/account/feedback", { kind: "bug", message: "from elsewhere" }, { ...T, Origin: "https://evil.example" })).status).toBe(403);
    for (let i = 0; i < 20; i++) await s.call("POST", "/api/account/feedback", { kind: "other", message: `note ${i}` }, T);
    expect((await s.call("POST", "/api/account/feedback", { kind: "other", message: "one more" }, T)).status).toBe(429);
  });
});
