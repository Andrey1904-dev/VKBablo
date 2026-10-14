/**
 * Конфигурация клиента.
 *
 * Важно: в браузер попадают ТОЛЬКО публичные значения.
 *   • VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY — publishable key, безопасен при включённом RLS.
 *   • service_role, VK-токены, AI-ключи — никогда, только в серверном окружении Supabase.
 */
import type { BackendKind } from "@shared/types";

export type BackendPreference = "auto" | "supabase" | "local" | "demo";

function readEnv(key: keyof ImportMetaEnv, fallback = ""): string {
  const value = (import.meta.env as Record<string, unknown>)[key as string];
  return typeof value === "string" ? value.trim() : fallback;
}

const supabaseUrl = readEnv("VITE_SUPABASE_URL");
const supabaseAnonKey = readEnv("VITE_SUPABASE_ANON_KEY");
const requested = (readEnv("VITE_BACKEND_MODE", "auto") || "auto") as BackendPreference;

export const FUNCTIONS_URL = supabaseUrl ? `${supabaseUrl.replace(/\/$/, "")}/functions/v1` : "";

export function hasSupabaseCredentials(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

export function resolveBackendKind(): BackendKind {
  if (requested === "demo") return "demo";
  if (requested === "local") return "local";
  if (requested === "supabase") return hasSupabaseCredentials() ? "supabase" : "demo";
  // auto: Supabase, если заданы публичные ключи; иначе полностью автономный демо-режим
  // (он же используется на GitHub Pages, где серверного API нет по определению).
  return hasSupabaseCredentials() ? "supabase" : "demo";
}

export const CONFIG = {
  supabaseUrl,
  supabaseAnonKey,
  functionsUrl: FUNCTIONS_URL,
  backend: resolveBackendKind(),
  requested,
  localApiBase: readEnv("VITE_LOCAL_API_BASE"),
  /** На GitHub Pages используется hash-роутинг: сервер не умеет отдавать index.html для вложенных путей. */
  useHashRouter: readEnv("VITE_USE_HASH_ROUTER", "") !== "false",
  demoStorageKey: "vkai-demo-store-v2",
  themeStorageKey: "vkai-theme",
  sessionStorageKey: "vkai-demo-session",
} as const;

export function backendLabel(kind: BackendKind): string {
  switch (kind) {
    case "supabase":
      return "Supabase (production)";
    case "local":
      return "Локальный стенд (Node API)";
    default:
      return "ДЕМО-РЕЖИМ (браузер)";
  }
}
