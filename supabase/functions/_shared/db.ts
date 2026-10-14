/**
 * Клиенты Supabase для Edge Functions.
 *  • admin()  — service role: обходит RLS, используется ТОЛЬКО после проверки пользователя.
 *  • asUser() — клиент с JWT пользователя: проверка токена и вызовы RPC от его имени.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.3";
import { ApiError } from "./http.ts";
import { SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL, assertServerConfig } from "./env.ts";

export interface SessionUser {
  id: string;
  email: string;
  role: "owner" | "editor" | "viewer" | string;
  name: string;
}

let adminClient: SupabaseClient | null = null;

export function admin(): SupabaseClient {
  assertServerConfig();
  if (!adminClient) {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-application-name": "vk-ai-manager-worker" } },
    });
  }
  return adminClient;
}

/** Пользовательский клиент: та же проверка RLS, что видит браузер. */
export function asUser(accessToken: string): SupabaseClient {
  assertServerConfig();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Проверка JWT и полномочий. Браузеру не доверяем: роль читается из таблицы profiles.
 * Возвращает пользователя только если он подтверждён GoTrue и имеет роль владельца/редактора.
 */
export async function requireUser(req: Request, options?: { allowViewer?: boolean }): Promise<SessionUser> {
  const header = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) {
    throw new ApiError(401, "Требуется авторизация", "unauthorized");
  }

  const { data, error } = await admin().auth.getUser(token);
  if (error || !data.user) {
    throw new ApiError(401, "Сессия недействительна или истекла", "unauthorized");
  }

  const { data: profile, error: profileError } = await admin()
    .from("profiles")
    .select("id, email, name, role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError) throw new ApiError(500, "Не удалось прочитать профиль", "profile");
  if (!profile) throw new ApiError(403, "Профиль не найден. Обратитесь к администратору.", "no_profile");

  const role = String(profile.role || "viewer");
  if (role === "viewer" && !options?.allowViewer) {
    throw new ApiError(403, "Недостаточно прав: нужен владелец или редактор", "forbidden");
  }

  return {
    id: String(profile.id),
    email: String(profile.email ?? data.user.email ?? ""),
    role,
    name: String(profile.name ?? ""),
  };
}

/**
 * Единая точка вызова RPC: ошибки Postgres превращаются в понятные ApiError.
 * Текст ошибок БД уже содержит русские сообщения (см. миграции).
 */
export async function callRpc<T = unknown>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    const message = error.message || "Ошибка операции";
    const status = /авторизац|Недостаточно прав|Требуется авторизация/i.test(message)
      ? 403
      : /не найдено|не найдена/i.test(message)
        ? 404
        : /занят|уже|Слишком много/i.test(message)
          ? 409
          : 400;
    throw new ApiError(status, message, error.code ?? "rpc");
  }
  return data as T;
}
