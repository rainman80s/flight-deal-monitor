/**
 * Instagram connection for posting the weekly content. The token is the Worker secret
 * INSTAGRAM_TOKEN; it is never returned or logged.
 *
 * Tokens from "Instagram login"/unified setup start with "IG" and use graph.instagram.com;
 * tokens from the Facebook-login setup start with "EA" and use graph.facebook.com. We support both.
 */
import type { Config } from "./config";

const VERSION = "v21.0";

export function igToken(cfg: Config): string | null {
  const t = (cfg.env as unknown as Record<string, unknown>).INSTAGRAM_TOKEN;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

async function getJson(url: string): Promise<{ ok: boolean; status: number; data: Record<string, any> }> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  let data: Record<string, any> = {};
  try { data = await res.json() as Record<string, any>; } catch { /* not JSON */ }
  return { ok: res.ok && !data.error, status: res.status, data };
}

/** Error text from Meta, without anything that could echo the token back. */
const metaError = (d: Record<string, any>) =>
  d?.error ? `${d.error.type ?? "error"} ${d.error.code ?? ""}: ${String(d.error.message ?? "").replace(/access_token=[^&\s]+/g, "access_token=…")}` : null;

/** Who the token belongs to and whether it can publish. Safe to show the owners. */
export async function checkInstagram(cfg: Config) {
  const token = igToken(cfg);
  if (!token) return { connected: false, reason: "INSTAGRAM_TOKEN isn't set." };
  const kind = token.startsWith("IG") ? "instagram" : token.startsWith("EA") ? "facebook" : "unknown";
  const enc = encodeURIComponent(token);

  if (kind !== "facebook") {
    const me = await getJson(`https://graph.instagram.com/${VERSION}/me?fields=user_id,username,account_type,media_count&access_token=${enc}`);
    if (me.ok) {
      const id = me.data.user_id ?? me.data.id;
      const limit = await getJson(`https://graph.instagram.com/${VERSION}/${id}/content_publishing_limit?fields=quota_usage,config&access_token=${enc}`);
      return { connected: true, token_kind: kind, host: "graph.instagram.com", ig_user_id: String(id), username: me.data.username,
        account_type: me.data.account_type, media_count: me.data.media_count,
        can_publish: limit.ok, publishing: limit.ok ? limit.data.data?.[0] ?? limit.data : metaError(limit.data) };
    }
    if (kind === "instagram") return { connected: false, token_kind: kind, reason: metaError(me.data) ?? `HTTP ${me.status}` };
  }

  // Facebook-login token: find the Instagram account through the Pages it manages.
  const pages = await getJson(`https://graph.facebook.com/${VERSION}/me/accounts?fields=name,instagram_business_account{id,username}&access_token=${enc}`);
  if (!pages.ok) return { connected: false, token_kind: kind, reason: metaError(pages.data) ?? `HTTP ${pages.status}` };
  const page = (pages.data.data ?? []).find((p: any) => p.instagram_business_account);
  if (!page) {
    // Diagnostics only: who the token is, what it's allowed to do, and any Instagram accounts it can
    // reach through a business portfolio. Names and permission names only, never the token.
    const who = await getJson(`https://graph.facebook.com/${VERSION}/me?fields=id,name&access_token=${enc}`);
    const perms = await getJson(`https://graph.facebook.com/${VERSION}/me/permissions?access_token=${enc}`);
    const biz = await getJson(`https://graph.facebook.com/${VERSION}/me/businesses?fields=name,instagram_accounts{id,username},owned_instagram_accounts{id,username}&access_token=${enc}`);
    const igViaBiz = (biz.data.data ?? []).flatMap((b: any) => [...(b.instagram_accounts?.data ?? []), ...(b.owned_instagram_accounts?.data ?? [])]);
    return { connected: false, token_kind: kind,
      reason: "The token works, but no Facebook Page with a linked Instagram account was found.",
      token_user: who.ok ? who.data.name : metaError(who.data),
      pages_found: (pages.data.data ?? []).map((p: any) => p.name),
      granted: (perms.data.data ?? []).filter((p: any) => p.status === "granted").map((p: any) => p.permission),
      declined: (perms.data.data ?? []).filter((p: any) => p.status !== "granted").map((p: any) => p.permission),
      businesses: biz.ok ? (biz.data.data ?? []).map((b: any) => b.name) : metaError(biz.data),
      instagram_via_business: igViaBiz.map((a: any) => a.username ?? a.id) };
  }
  const ig = page.instagram_business_account;
  const limit = await getJson(`https://graph.facebook.com/${VERSION}/${ig.id}/content_publishing_limit?fields=quota_usage,config&access_token=${enc}`);
  return { connected: true, token_kind: kind, host: "graph.facebook.com", ig_user_id: String(ig.id), username: ig.username,
    page: page.name, can_publish: limit.ok, publishing: limit.ok ? limit.data.data?.[0] ?? limit.data : metaError(limit.data) };
}
