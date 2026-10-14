import { createApp } from "./app.ts";
import { bindWorkerEnv } from "./env.ts";
import { enqueueUpcomingGeneration, processOnce } from "./queue.ts";
import { seedCore } from "./seed.ts";

const app = createApp();

export default {
  async fetch(request: Request, env: Record<string, unknown>, ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    bindWorkerEnv(env);
    seedCore();
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api") || url.pathname.startsWith("/uploads")) {
      return app.fetch(request);
    }
    const assets = env.ASSETS as { fetch: (req: Request) => Promise<Response> } | undefined;
    if (assets) return assets.fetch(request);
    return app.fetch(request);
  },

  async scheduled(_event: unknown, env: Record<string, unknown>, ctx: { waitUntil: (p: Promise<unknown>) => void }) {
    bindWorkerEnv(env);
    seedCore();
    ctx.waitUntil(
      (async () => {
        enqueueUpcomingGeneration();
        for (let i = 0; i < 4; i++) await processOnce();
      })(),
    );
  },
};
