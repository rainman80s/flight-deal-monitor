/**
 * Beta feedback: testers (and owners) send bugs and ideas from any page; owners read and triage
 * them on the Admin page. Messages are encrypted at rest with the same vault as emails and names.
 *
 *   POST /api/account/feedback  {kind, message, page}   testers and admins
 *   GET  /api/admin/feedback?status=new|done|all        admins
 *   PUT  /api/admin/feedback/status {id, status}        admins
 */
import type { Config } from "./config";
import { BRAND, button, frameFor, layout, p as para, textFooter } from "./email";
import { escHtml } from "./html";
import type { User, UserStore } from "./users";

const KINDS = ["bug", "idea", "other"] as const;
const PER_DAY = 20;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

/** "iPhone · Safari" from a user agent, so we know where a bug happened without storing the full string. */
export function deviceHint(ua: string): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Other";
  const br = /Edg\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${os} · ${br}`;
}

export async function submitFeedback(cfg: Config, users: UserStore, u: User, req: Request,
  mail: (to: string, msg: { subject: string; text: string; html: string }) => Promise<unknown>): Promise<Response> {
  if (u.role !== "tester" && u.role !== "admin") return json({ ok: false, error: "Feedback is open to beta testers." }, 403);
  let b: Record<string, unknown> | null = null;
  try { b = await req.json() as Record<string, unknown>; } catch { b = null; }
  const kind = KINDS.includes(b?.kind as typeof KINDS[number]) ? b!.kind as string : "other";
  const message = String(b?.message ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (message.length < 3) return json({ ok: false, error: "Tell us a little more.", field: "message" }, 400);
  if (message.length > 4000) return json({ ok: false, error: "Keep it under 4,000 characters.", field: "message" }, 400);
  const page = String(b?.page ?? "").replace(/[^a-z0-9=_-]/gi, "").slice(0, 40) || null;

  const db = cfg.env.DB;
  const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19) + "Z";
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE user_id=? AND created_at>=?").bind(u.id, since).first<{ n: number }>();
  if ((recent?.n ?? 0) >= PER_DAY) return json({ ok: false, error: "That's a lot of feedback for one day. Thank you! Try again tomorrow." }, 429);

  const sealed = await users.vault.seal("feedback", message);
  const device = deviceHint(req.headers.get("User-Agent") ?? "");
  await db.prepare("INSERT INTO feedback(user_id,kind,page,message_enc,device,status,created_at) VALUES(?,?,?,?,?,'new',?)")
    .bind(u.id, kind, page, sealed, device, nowIso()).run();

  // Let the owners know (best effort; feedback is saved either way).
  const f = frameFor(cfg);
  const label = { bug: "Bug report", idea: "Idea", other: "Feedback" }[kind]!;
  const from = u.name || u.email;
  for (const c of cfg.contacts.filter((x) => x.email)) {
    const reason = `You're getting this because you're a ${BRAND} owner.`;
    await mail(c.email!, {
      subject: `${label} from ${from}`,
      text: `${label} from ${from} (${u.email}) on ${page ?? "the site"}, ${device}:\n\n${message}\n\nRead and triage: ${f.base}/#admin\n` + textFooter(f, reason),
      html: layout(f, { preheader: message.slice(0, 90), eyebrow: "Beta feedback", heading: escHtml(label),
        body: para(`<b>${escHtml(from)}</b> · ${escHtml(page ?? "site")} · ${escHtml(device)}`)
          + `<div style="white-space:pre-wrap;padding:14px 16px;border-radius:12px;background:#f3f1ea;font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#14262c">${escHtml(message)}</div>`
          + `<div style="margin:22px 0 4px">${button(`${f.base}/#admin`, "Open feedback")}</div>`, reason }),
    }).catch(() => {});
  }
  return json({ ok: true });
}

export async function adminFeedback(cfg: Config, users: UserStore, req: Request, p: string, m: string): Promise<Response> {
  const db = cfg.env.DB;
  if (p === "/api/admin/feedback" && m === "GET") {
    const status = new URL(req.url).searchParams.get("status") ?? "new";
    const where = status === "done" ? "WHERE status='done'" : status === "all" ? "" : "WHERE status='new'";
    const rows = (await db.prepare(`SELECT * FROM feedback ${where} ORDER BY id DESC LIMIT 200`).all<{
      id: number; user_id: number; kind: string; page: string | null; message_enc: string; device: string | null; status: string; created_at: string;
    }>()).results;
    const people = new Map<number, User | null>();
    const items = [];
    for (const r of rows) {
      if (!people.has(r.user_id)) people.set(r.user_id, await users.byId(r.user_id));
      const who = people.get(r.user_id);
      let message = "";
      try { message = await users.vault.open("feedback", r.message_enc); } catch { message = "(couldn't be decrypted)"; }
      items.push({ id: r.id, kind: r.kind, page: r.page, device: r.device, status: r.status, created_at: r.created_at, message,
        from: who ? { name: who.name, email: who.email, role: who.role } : { name: null, email: "(deleted account)", role: null } });
    }
    const counts = await db.prepare("SELECT SUM(status='new') AS open, SUM(status='done') AS done FROM feedback").first<{ open: number | null; done: number | null }>();
    return json({ ok: true, items, counts: { open: counts?.open ?? 0, done: counts?.done ?? 0 } });
  }
  if (p === "/api/admin/feedback/status" && m === "PUT") {
    let b: Record<string, unknown> | null = null;
    try { b = await req.json() as Record<string, unknown>; } catch { b = null; }
    const id = Number(b?.id);
    const status = b?.status === "done" ? "done" : b?.status === "new" ? "new" : null;
    if (!Number.isInteger(id) || !status) return json({ ok: false, error: "Bad request." }, 400);
    const r = await db.prepare("UPDATE feedback SET status=? WHERE id=?").bind(status, id).run();
    if (!r.meta.changes) return json({ ok: false, error: "Not found." }, 404);
    return json({ ok: true, id, status });
  }
  return json({ ok: false, error: "Not found." }, 404);
}
