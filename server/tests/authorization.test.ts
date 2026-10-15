import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  API_ROUTES,
  EDITOR_API_ROUTES,
  OWNER_ONLY_API_ROUTES,
  canUseApiRoute,
  isOwnerOnlyRoute,
} from "../../shared/authorization.ts";

const edgeApi = readFileSync(new URL("../../supabase/functions/vk-ai-api/index.ts", import.meta.url), "utf8");
const switchRoutes = [...edgeApi.matchAll(/case\s+"([^"]+)"\s*:/g)].map((match) => match[1]!);

test("every Edge API switch route has exactly one explicit role classification", () => {
  assert.equal(new Set(API_ROUTES).size, API_ROUTES.length, "route map contains duplicates");
  assert.deepEqual([...API_ROUTES].sort(), [...switchRoutes].sort());
  for (const route of OWNER_ONLY_API_ROUTES) assert.equal((EDITOR_API_ROUTES as readonly string[]).includes(route), false);
});

test("owner, editor and viewer have separate allowlists and unknown routes fail closed", () => {
  for (const route of OWNER_ONLY_API_ROUTES) {
    assert.equal(isOwnerOnlyRoute(route), true);
    assert.equal(canUseApiRoute("owner", route), true);
    assert.equal(canUseApiRoute("editor", route), false, route);
    assert.equal(canUseApiRoute("viewer", route), false, route);
  }
  for (const route of EDITOR_API_ROUTES) {
    assert.equal(isOwnerOnlyRoute(route), false, route);
    assert.equal(canUseApiRoute("owner", route), true, route);
    assert.equal(canUseApiRoute("editor", route), true, route);
    assert.equal(canUseApiRoute("viewer", route), false, route);
  }
  assert.equal(canUseApiRoute("editor", "future/unreviewed-route"), false);
  assert.equal(canUseApiRoute("viewer", "health/auth"), false);
  assert.equal(canUseApiRoute("unknown-role", "posts/create"), false);
});
