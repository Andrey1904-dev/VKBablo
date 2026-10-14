/**
 * HTTP-помощники Edge Functions: CORS, единый формат ошибок, безопасные ответы.
 */
import { originsAllowed } from "./env.ts";

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = originsAllowed(origin) ? (origin as string) : "null";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "authorization,content-type,x-worker-secret,apikey,x-client-info",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(body: unknown, status = 200, origin: string | null = null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(origin),
    },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/**
 * Обработка ошибок: наружу уходит понятное сообщение, стек — только в лог.
 * Секреты и токены никогда не попадают в текст ответа.
 */
export function errorResponse(err: unknown, origin: string | null): Response {
  if (err instanceof ApiError) {
    return json({ error: err.message, code: err.code }, err.status, origin);
  }

  const raw = err instanceof Error ? err.message : String(err);
  const safe = raw.replace(/(sk-[A-Za-z0-9_-]{8,}|vk1\.[A-Za-z0-9_.-]{8,}|eyJ[A-Za-z0-9_-]{16,})/g, "***");
  console.error("[vk-ai] error:", safe);

  // Наружу — обобщённый текст для неизвестных ошибок.
  const status = /авторизац|Требуется авторизация|Недостаточно прав/i.test(safe) ? 403 : 500;
  return json({ error: status === 403 ? safe : "Внутренняя ошибка сервера", code: "internal" }, status, origin);
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(400, "Некорректный JSON в запросе", "bad_json");
  }
}

export function requireString(value: unknown, field: string, max = 4000): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, `Поле "${field}" обязательно`, "validation");
  }
  if (value.length > max) {
    throw new ApiError(400, `Поле "${field}" длиннее ${max} символов`, "validation");
  }
  return value;
}

export function optionalString(value: unknown, max = 4000): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  return value.slice(0, max);
}

export function assertIso(value: unknown, field: string): string {
  const str = requireString(value, field, 40);
  const date = new Date(str);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, `Поле "${field}" должно быть датой ISO`, "validation");
  }
  return date.toISOString();
}
