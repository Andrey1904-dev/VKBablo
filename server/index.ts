import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadDotEnv, env } from "./env.ts";
import { getDb } from "./db.ts";
import { seedCore } from "./seed.ts";
import { startWorkers } from "./queue.ts";
import { createUser, userCount } from "./auth.ts";

loadDotEnv();
getDb();
seedCore();

if (env("BOOTSTRAP_EMAIL") && env("BOOTSTRAP_PASSWORD") && userCount() === 0) {
  createUser(env("BOOTSTRAP_EMAIL"), env("BOOTSTRAP_PASSWORD"), "Владелец");
}

const app = createApp();
const port = Number(env("PORT", "8787"));

startWorkers();

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`VK AI Manager API → http://0.0.0.0:${info.port}`);
  console.log(`Режим: ${env("APP_MODE", "test")} · TZ: Europe/Moscow`);
});
