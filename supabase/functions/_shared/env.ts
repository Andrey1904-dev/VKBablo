/**
 * Доступ к переменным окружения Edge Functions.
 * Все секреты живут только здесь (серверное окружение Supabase) и никогда
 * не попадают в браузер, логи или репозиторий.
 */

function read(name: string): string {
  const deno = (globalThis as typeof globalThis & {
    Deno?: { env: { get: (key: string) => string | undefined } };
  }).Deno;
  const value = deno?.env.get(name);
  return value === undefined || value === null ? "" : value.trim();
}

export const SUPABASE_URL = read("SUPABASE_URL");
export const SUPABASE_ANON_KEY = read("SUPABASE_ANON_KEY");
export const SUPABASE_SERVICE_ROLE_KEY = read("SUPABASE_SERVICE_ROLE_KEY");
export const ENCRYPTION_KEY = read("ENCRYPTION_KEY");
export const WORKER_SECRET = read("WORKER_SECRET");
export const OWNER_SETUP_SECRET = read("OWNER_SETUP_SECRET");

export const AI_API_KEY = read("AI_API_KEY");
export const AI_BASE_URL = read("AI_BASE_URL") || "https://api.openai.com/v1";
export const AI_TEXT_MODEL = read("AI_TEXT_MODEL");
export const AI_IMAGE_MODEL = read("AI_IMAGE_MODEL");

export const VK_API_VERSION = read("VK_API_VERSION") || "5.199";

/** Разрешённые origin для CORS: GitHub Pages и локальная разработка. */
export const ALLOWED_ORIGINS = (read("APP_ORIGINS") ||
  "https://andrey1904-dev.github.io,http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

export function originsAllowed(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Препросмотр и локальные порты: разрешаем только явные схемы, без «*».
  try {
    const url = new URL(origin);
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) {
      return true;
    }
    if (url.hostname.endsWith(".e2b.app")) return true; // предпросмотр в песочнице
  } catch {
    return false;
  }
  return false;
}

export interface ConfigCheck {
  key: string;
  label: string;
  configured: boolean;
  detail: string;
}

/** Честная проверка конфигурации: без ключей функции работают в демо-режиме. */
export function configChecks(): ConfigCheck[] {
  return [
    {
      key: "supabase_admin",
      label: "Supabase service role",
      configured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
      detail: SUPABASE_URL ? "URL задан" : "URL не задан",
    },
    {
      key: "encryption",
      label: "Ключ шифрования секретов",
      configured: ENCRYPTION_KEY.length >= 32,
      detail: ENCRYPTION_KEY.length >= 32 ? "готов" : "ENCRYPTION_KEY не задан или короче 32 символов",
    },
    {
      key: "worker_secret",
      label: "Секрет воркера",
      configured: WORKER_SECRET.length >= 16,
      detail: WORKER_SECRET ? "задан" : "WORKER_SECRET не задан — Cron не сможет вызвать воркер",
    },
    {
      key: "owner_setup_secret",
      label: "Одноразовый секрет первичной настройки владельца",
      configured: OWNER_SETUP_SECRET.length >= 32 && OWNER_SETUP_SECRET.length <= 256,
      detail: OWNER_SETUP_SECRET.length >= 32 && OWNER_SETUP_SECRET.length <= 256
        ? "задан в серверном окружении"
        : "OWNER_SETUP_SECRET должен содержать 32–256 символов; браузерная регистрация отключена",
    },
    {
      key: "ai",
      label: "AI API",
      configured: Boolean(AI_API_KEY),
      detail: AI_API_KEY ? "ключ задан в окружении функции" : "ключ не задан, работает тестовый движок",
    },
  ];
}

export function assertServerConfig(): void {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Edge Function не настроена: отсутствуют SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY");
  }
}
