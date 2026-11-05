/** Cloudflare Worker entry: HTTP (Twilio webhooks, admin) + cron (search cycles). */
import { handle } from "./app";
import { buildConfig, type Env } from "./config";
import { runCycle } from "./monitor";
import { makeFareProvider } from "./providers";
import { Store } from "./store";
import { SubscriberStore } from "./subscribers";
import { makeNotifier } from "./notify";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cfg = buildConfig(env);
    return handle(req, {
      cfg,
      store: new Store(env.DB),
      subs: new SubscriberStore(env.DB),
      notifier: makeNotifier(cfg),
      fareProvider: () => makeFareProvider(cfg),
      background: (p) => ctx.waitUntil(p),
    });
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cfg = buildConfig(env);
    await runCycle(cfg, new Store(env.DB), makeFareProvider(cfg), makeNotifier(cfg), new Date(),
      new SubscriberStore(env.DB));
  },
} satisfies ExportedHandler<Env>;
