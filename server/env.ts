import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");


export function loadDotEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null) process.env[k] = v;
  }
}

export function env(key: string, fallback = ""): string {
  return process.env[key] || fallback;
}

export function supabaseConfigured(): boolean {
  return Boolean(env("SUPABASE_URL") && env("SUPABASE_SERVICE_ROLE_KEY"));
}

export function supabasePublic() {
  return {
    url: env("SUPABASE_URL") || env("VITE_SUPABASE_URL"),
    anon: Boolean(env("SUPABASE_ANON_KEY") || env("VITE_SUPABASE_ANON_KEY")),
    service: Boolean(env("SUPABASE_SERVICE_ROLE_KEY")),
    configured: supabaseConfigured(),
  };
}
