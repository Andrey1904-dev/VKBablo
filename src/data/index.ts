/**
 * Точка входа слоя данных: выбирает реализацию Backend по конфигурации.
 *
 *   supabase — production (GitHub Pages + Supabase);
 *   local    — локальный стенд разработки (Node API /api/*);
 *   demo     — автономный браузерный режим (GitHub Pages без ключей, тест-режим ТЗ §19).
 */
import { CONFIG } from "@/lib/config";
import type { Backend } from "./types";
import { DemoBackend } from "./demo";
import { LocalBackend } from "./local";
import { SupabaseBackend } from "./supabase";

let current: Backend | null = null;

export function createBackend(): Backend {
  switch (CONFIG.backend) {
    case "supabase":
      return new SupabaseBackend();
    case "local":
      return new LocalBackend();
    default:
      return new DemoBackend();
  }
}

/** Единственный экземпляр на приложение (клиент Supabase держит сессию). */
export function getBackend(): Backend {
  if (!current) current = createBackend();
  return current;
}

/** Последний созданный backend — без создания нового (для компонентов-обёрток). */
export function peekBackend(): Backend | null {
  return current;
}

export function resetBackend(): void {
  current = null;
}

export type { Backend, CommunityDetail, GenerateSlotInput, VkConnectResult } from "./types";
export { backendInfoFor } from "./types";
