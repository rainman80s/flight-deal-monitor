/** Cloudflare Worker entry: HTTP (site, API, webhooks, admin) + cron (search cycles). */
import { handle } from "./app";
import { buildConfig, type Env } from "./config";
import { applySettings } from "./settings";
import { runCycle } from "./monitor";
import { makeExplore, makeFareProvider } from "./providers";
import { Store } from "./store";
import { makeNotifier } from "./notify";
import { ensureAdmins, UserStore } from "./users";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cfg = buildConfig(env);
    await applySettings(cfg);
    return handle(req, {
      cfg,
      store: new Store(env.DB),
      notifier: makeNotifier(cfg),
      fareProvider: () => makeFareProvider(cfg),
      background: (p) => ctx.waitUntil(p),
    });
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cfg = buildConfig(env);
    await applySettings(cfg);
    // Housekeeping first, so a failed search doesn't skip it: owners' admin accounts exist,
    // expired sessions and email tokens are gone.
    try {
      await ensureAdmins(cfg);
      await UserStore.for(cfg).prune();
    } catch (e) { console.error("account housekeeping failed", (e as Error).message); }
    await runCycle(cfg, new Store(env.DB), makeFareProvider(cfg), makeNotifier(cfg), new Date(), true, makeExplore(cfg));
  },
} satisfies ExportedHandler<Env>;
