import { test } from "node:test";
import assert from "node:assert/strict";
import { get, openMemoryDb, setSetting } from "../db.ts";
import { getAdapter, monthSpendUsd, releaseAiBudget, reserveAiBudget, saveAiKey, settleAiBudget } from "../ai.ts";
import { seedCore } from "../seed.ts";

test("local AI budget reservations serialize spend and settle exactly once", () => {
  openMemoryDb();
  seedCore();
  setSetting("ai_monthly_limit_usd", "1");

  const first = reserveAiBudget(0.6);
  assert.throws(() => reserveAiBudget(0.6), /Достигнут лимит/);
  settleAiBudget(first, {
    communityId: "stories",
    postId: null,
    jobId: null,
    type: "text",
    provider: "mock",
    model: "mock-text",
    prompt: "mock prompt",
    result: "mock result",
    costUsd: 0.7,
    status: "done",
  });
  settleAiBudget(first, {
    communityId: "stories",
    type: "text",
    provider: "mock",
    model: "mock-text",
    prompt: "duplicate settlement must not create another ledger row",
    result: "",
    costUsd: 0.7,
    status: "done",
  });

  assert.equal(monthSpendUsd(), 0.7);
  assert.equal(get<{ count: number }>("SELECT COUNT(*) AS count FROM ai_generations WHERE budget_reservation_id = ?", first)?.count, 1);
  assert.throws(() => reserveAiBudget(0.4), /Достигнут лимит/);

  const second = reserveAiBudget(0.2);
  releaseAiBudget(second);
  assert.equal(get<{ status: string }>("SELECT status FROM ai_budget_reservations WHERE id = ?", second)?.status, "released");
  assert.equal(monthSpendUsd(), 0.7);
});

test("local dry-run never selects a paid AI adapter even with a key and server flag", async () => {
  openMemoryDb();
  seedCore();
  setSetting("ai_provider", "openai");
  setSetting("ai_paid_calls_enabled", "true");
  saveAiKey("mock-ai-key-that-is-never-used");
  setSetting("app_mode", "test");
  assert.equal((await getAdapter()).id, "test");
});

test("budget reservations fail closed for invalid or non-positive estimates", () => {
  openMemoryDb();
  seedCore();
  setSetting("ai_monthly_limit_usd", "20");
  assert.throws(() => reserveAiBudget(0), /Неверная сумма/);
  assert.throws(() => reserveAiBudget(Number.NaN), /Неверная сумма/);
  setSetting("ai_monthly_limit_usd", "0");
  assert.throws(() => reserveAiBudget(0.01), /положительный месячный лимит/);
});
