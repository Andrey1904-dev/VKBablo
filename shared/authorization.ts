/**
 * Role/route allowlist shared by the Edge API and its regression tests.
 * SQL RPCs and RLS repeat authorization checks; this is an early API boundary,
 * not the sole authorization mechanism. Editor access is fail-closed: a new
 * switch route is denied until it is explicitly classified here.
 */
export const OWNER_ONLY_API_ROUTES = [
  "integrations/status",
  "posts/approve",
  "posts/schedule",
  "posts/unschedule",
  "planner/prepare",
  "worker/run",
  "communities/update",
  "communities/vk-token",
  "communities/vk-check",
  "characters/update",
  "characters/references",
  "characters/references/primary",
  "characters/references/approve",
  "characters/references/delete",
  "settings/save",
  "settings/ai-key",
  "settings/test-ai",
  "settings/test-worker",
  "media/delete",
] as const;

/** Exact non-owner routes explicitly granted to editors in vk-ai-api/index.ts. */
export const EDITOR_API_ROUTES = [
  "health/auth",
  "posts/create",
  "posts/edit",
  "posts/reject",
  "posts/revise",
  "posts/regenerate",
  "posts/generate",
  "communities/rules",
  "characters/readiness",
  "ai/ideas",
  "media/upload",
  "media/sign",
  "image-prompt",
  "analytics/import",
  "notifications/read",
] as const;

export const API_ROUTES = [...OWNER_ONLY_API_ROUTES, ...EDITOR_API_ROUTES] as const;

export type AppRole = "owner" | "editor" | "viewer" | string;

export function isOwnerOnlyRoute(route: string): boolean {
  return (OWNER_ONLY_API_ROUTES as readonly string[]).includes(route);
}

export function canUseApiRoute(role: AppRole, route: string): boolean {
  if (role === "owner") return true;
  if (role !== "editor") return false;
  return (EDITOR_API_ROUTES as readonly string[]).includes(route) &&
    (API_ROUTES as readonly string[]).includes(route) &&
    !isOwnerOnlyRoute(route);
}
