import { all, get, run, setSetting, setting, withImmediateTransaction } from "./db.ts";
import { decrypt, encrypt, nid, nowIso } from "./lib.ts";
import { generateIdea, generateText, ruleCheck, type Idea } from "./content.ts";
import { illustrationPrompt, makeIllustration } from "./images.ts";
import { findSimilar } from "./similarity.ts";
import type { AiProviderId, CommunityId } from "../shared/types.ts";
import { assertBudgetAvailable, paidAiCallAllowed } from "../shared/ai-safety.ts";
import { ProviderRequestError, requestCompatibleImage, requestCompatibleText } from "../shared/ai-provider.ts";

export interface TextGenInput {
  communityId: CommunityId;
  system: string;
  user: string;
  seed: string;
  idea?: Idea;
}

export interface ImageGenInput {
  communityId: CommunityId;
  prompt: string;
  seed: string;
  title: string;
  topic: string;
  referenceUrls?: string[];
}

export interface AiAdapter {
  id: AiProviderId;
  label: string;
  supportsReferences: boolean;
  limitations: string[];
  generateText(input: TextGenInput): Promise<{ text: string; model: string; costUsd: number; warning?: string }>;
  generateImage(input: ImageGenInput): Promise<{
    path: string;
    model: string;
    costUsd: number;
    note?: string;
  }>;
}

const testAdapter: AiAdapter = {
  id: "test",
  label: "Тестовый движок (без внешних API)",
  supportsReferences: false,
  limitations: ["Тестовый движок детерминированный; референсы не передаются и сходство не гарантируется."],
  async generateText(input) {
    const idea = input.idea ?? generateIdea(input.communityId, [], input.seed);
    const text = generateText(input.communityId, idea, input.seed);
    return { text, model: "test-writer-v1", costUsd: 0 };
  },
  async generateImage(input) {
    const img = makeIllustration({
      communityId: input.communityId,
      title: input.title,
      topic: input.topic,
      seed: input.seed,
    });
    return {
      path: img.path,
      model: "test-illustrator-v1",
      costUsd: 0,
      note: "Тестовый режим: сгенерирована иллюстрация-карточка. Точное сохранение внешности персонажей тестовый движок не обещает.",
    };
  },
};

function normalizedAiBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AI_BASE_URL должен быть корректным HTTPS URL; платный вызов заблокирован.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("AI_BASE_URL должен использовать HTTPS и не содержать credentials/query; платный вызов заблокирован.");
  }
  return url.toString().replace(/\/$/, "");
}

function redactAiError(message: string, key: string): string {
  return message.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]").split(key).join("[REDACTED]").slice(0, 500);
}

const MAX_TEXT_TOKENS = 900;

export function estimateTextCostUsd(system: string, user: string, provider: string): number {
  const rate = provider === "openai" ? 0.001 : 0.01;
  const tokens = Math.ceil((system.length + user.length) / 2) + MAX_TEXT_TOKENS;
  return tokens * rate / 1000;
}

export function estimateImageCostUsd(provider: string): number {
  return provider === "test" ? 0 : 0.1;
}

async function openaiCompatible(kind: "openai" | "compatible"): Promise<AiAdapter> {
  return {
    id: kind,
    label: kind === "openai" ? "OpenAI" : "Совместимый API",
    supportsReferences: false,
    limitations: ["Текущий адаптер не передаёт изображения-референсы; точное сходство персонажей не гарантируется.", "Каждая публикация требует ручного одобрения."],
    async generateText(input) {
      const key = getAiKey();
      if (!key) throw new Error("Не задан ключ AI API");
      const model = setting("ai_text_model", "gpt-4o-mini");
      const base = normalizedAiBaseUrl(setting("ai_base_url") || "https://api.openai.com/v1");
      const pricePer1kTokensUsd = kind === "openai" ? 0.001 : 0.01;
      const estimatedCost = estimateTextCostUsd(input.system, input.user, kind);
      assertBudget(estimatedCost);
      const reservationId = reserveAiBudget(estimatedCost);
      let result: Awaited<ReturnType<typeof requestCompatibleText>>;
      try {
        result = await requestCompatibleText({
          fetcher: (...args) => fetch(...args),
          baseUrl: base,
          apiKey: key,
          model,
          system: input.system,
          user: input.user,
          maxTokens: MAX_TEXT_TOKENS,
          pricePer1kTokensUsd,
          estimatedCostUsd: estimatedCost,
          signal: AbortSignal.timeout(60_000),
        });
      } catch (error) {
        const message = redactAiError(error instanceof Error ? error.message : String(error), key);
        const costUsd = error instanceof ProviderRequestError ? error.costUsd : estimatedCost;
        try {
          logGeneration({
            communityId: input.communityId,
            budgetReservationId: reservationId,
            type: "text",
            provider: kind,
            model,
            prompt: `SYSTEM:\n${input.system}\n\nUSER:\n${input.user}`,
            result: "",
            costUsd,
            status: "error",
            error: message,
          });
        } catch {
          // Preserve the provider error; do not accidentally replace it with a logging error.
        }
        const chargedError = new Error(message) as Error & { costUsd: number };
        chargedError.costUsd = costUsd;
        throw chargedError;
      }
      let warning: string | undefined;
      try {
        logGeneration({
          communityId: input.communityId,
          budgetReservationId: reservationId,
          type: "text",
          provider: kind,
          model,
          prompt: `SYSTEM:\n${input.system}\n\nUSER:\n${input.user}`,
          result: result.text,
          costUsd: result.costUsd,
          status: "done",
        });
      } catch {
        warning = "Ответ AI получен, но журнал стоимости не записался; проверьте расходы вручную.";
      }
      return { text: result.text, model, costUsd: result.costUsd, warning };
    },
    async generateImage(input) {
      const key = getAiKey();
      if (!key) throw new Error("Не задан ключ AI API");
      const model = setting("ai_image_model", "gpt-image-1");
      const base = normalizedAiBaseUrl(setting("ai_base_url") || "https://api.openai.com/v1");
      const estimatedCost = estimateImageCostUsd(kind);
      assertBudget(estimatedCost);
      const reservationId = reserveAiBudget(estimatedCost);
      let bytes: Uint8Array;
      try {
        bytes = await requestCompatibleImage({
          fetcher: (...args) => fetch(...args),
          baseUrl: base,
          apiKey: key,
          model,
          prompt: input.prompt,
          estimatedCostUsd: estimatedCost,
          signal: AbortSignal.timeout(90_000),
        });
      } catch (error) {
        const message = redactAiError(error instanceof Error ? error.message : String(error), key);
        const costUsd = error instanceof ProviderRequestError ? error.costUsd : estimatedCost;
        try {
          logGeneration({
            communityId: input.communityId,
            budgetReservationId: reservationId,
            type: "image",
            provider: kind,
            model,
            prompt: input.prompt,
            result: "",
            costUsd,
            status: "error",
            error: message,
          });
        } catch {
          // Preserve the provider error; do not accidentally replace it with a logging error.
        }
        const chargedError = new Error(message) as Error & { costUsd: number };
        chargedError.costUsd = costUsd;
        throw chargedError;
      }
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { UPLOAD_DIR } = await import("./db.ts");
      const name = `${nid("ai")}.png`;
      writeFileSync(join(UPLOAD_DIR, name), Buffer.from(bytes));
      const referenceNote = input.referenceUrls?.length
        ? "Текущий адаптер не передаёт референсы изображений провайдеру; точное сходство не гарантируется."
        : "Стоимость рассчитана по консервативному тарифу; сверяйте её со счётом провайдера.";
      let logWarning = "";
      try {
        logGeneration({
          communityId: input.communityId,
          budgetReservationId: reservationId,
          type: "image",
          provider: kind,
          model,
          prompt: input.prompt,
          result: `/uploads/${name}`,
          costUsd: estimatedCost,
          status: "done",
        });
      } catch {
        logWarning = " Журнал стоимости не записался; проверьте расходы вручную.";
      }
      return { path: `/uploads/${name}`, model, costUsd: estimatedCost, note: `${referenceNote}${logWarning}` };
    },
  };
}

export function getAiKey(): string | null {
  const enc = setting("ai_api_key_enc");
  if (!enc) return null;
  try {
    return decrypt(enc);
  } catch {
    return null;
  }
}

export function saveAiKey(plain: string | null) {
  if (!plain) {
    setSetting("ai_api_key_enc", "");
    return;
  }
  setSetting("ai_api_key_enc", encrypt(plain));
}

export async function getAdapter(): Promise<AiAdapter> {
  const id = (setting("ai_provider", "test") || "test") as AiProviderId;
  if (id === "openai" || id === "compatible") {
    const paidEnabled = setting("ai_paid_calls_enabled", "false").toLowerCase() === "true" &&
      setting("app_mode", "test") === "approval";
    if (!paidAiCallAllowed(id, paidEnabled, Boolean(getAiKey()))) {
      return testAdapter;
    }
    return openaiCompatible(id);
  }
  return testAdapter;
}

export function monthSpendUsd(): number {
  const from = new Date();
  from.setUTCDate(1);
  from.setUTCHours(0, 0, 0, 0);
  const row = get<{ s: number }>(
    "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM ai_generations WHERE created_at >= ?",
    from.toISOString(),
  );
  return Number(row?.s ?? 0);
}

export function assertBudget(extra = 0) {
  const provider = setting("ai_provider", "test");
  const enabled = setting("ai_paid_calls_enabled", "false").toLowerCase() === "true" &&
    setting("app_mode", "test") === "approval";
  if (!paidAiCallAllowed(provider, enabled, Boolean(getAiKey()))) return;
  const limit = Number(setting("ai_monthly_limit_usd", "20"));
  const reserved = get<{ s: number }>(
    "SELECT COALESCE(SUM(reserved_usd), 0) AS s FROM ai_budget_reservations WHERE status = 'reserved' AND month_start = ?",
    utcMonthStart(),
  );
  assertBudgetAvailable(monthSpendUsd() + Number(reserved?.s ?? 0), limit, extra);
}

function utcMonthStart(date = new Date()): string {
  const start = new Date(date);
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

export function reserveAiBudget(estimatedUsd: number): string {
  if (!Number.isFinite(estimatedUsd) || estimatedUsd <= 0) {
    throw new Error("Неверная сумма AI-бюджета; платный вызов заблокирован.");
  }
  const id = nid("budget");
  const monthStart = utcMonthStart();
  withImmediateTransaction(() => {
    const limit = Number(setting("ai_monthly_limit_usd", "20"));
    const active = get<{ s: number }>(
      "SELECT COALESCE(SUM(reserved_usd), 0) AS s FROM ai_budget_reservations WHERE status = 'reserved' AND month_start = ?",
      monthStart,
    );
    assertBudgetAvailable(monthSpendUsd() + Number(active?.s ?? 0), limit, estimatedUsd);
    run(
      `INSERT INTO ai_budget_reservations (id, month_start, reserved_usd, actual_usd, status, created_at)
       VALUES (?, ?, ?, 0, 'reserved', ?)`,
      id,
      monthStart,
      estimatedUsd,
      nowIso(),
    );
  });
  return id;
}

type GenerationLogInput = {
  communityId?: string | null;
  postId?: string | null;
  jobId?: string | null;
  budgetReservationId?: string | null;
  type: string;
  provider: string;
  model: string;
  prompt: string;
  result: string;
  costUsd: number;
  status: string;
  error?: string;
};

function insertGenerationLog(row: GenerationLogInput, reservationId?: string | null) {
  run(
    `INSERT INTO ai_generations (id, community_id, type, provider, model, prompt, result, cost_usd, status, error, created_at, budget_reservation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nid("gen"),
    row.communityId ?? null,
    row.type,
    row.provider,
    row.model,
    row.prompt.slice(0, 4000),
    row.result.slice(0, 8000),
    row.costUsd,
    row.status,
    row.error ?? null,
    nowIso(),
    reservationId ?? null,
  );
}

/** Atomically turn a reservation into a cost row; a retry cannot double-charge the ledger. */
export function settleAiBudget(reservationId: string, row: GenerationLogInput): void {
  if (!Number.isFinite(row.costUsd) || row.costUsd < 0) {
    throw new Error("Не удалось записать корректную стоимость AI; резерв бюджета сохранён.");
  }
  withImmediateTransaction(() => {
    const reservation = get<{ status: string }>(
      "SELECT status FROM ai_budget_reservations WHERE id = ?",
      reservationId,
    );
    if (!reservation) throw new Error("Резерв AI-бюджета не найден; резерв не освобождён.");
    if (reservation.status === "settled") return;
    if (reservation.status !== "reserved") throw new Error("Резерв AI-бюджета уже закрыт.");

    insertGenerationLog(row, reservationId);
    run(
      "UPDATE ai_budget_reservations SET status = 'settled', actual_usd = ?, resolved_at = ? WHERE id = ? AND status = 'reserved'",
      row.costUsd,
      nowIso(),
      reservationId,
    );
  });
}

/** Only for a reservation proven not to have reached a paid provider (tests/operator recovery). */
export function releaseAiBudget(reservationId: string): void {
  withImmediateTransaction(() => {
    run(
      "UPDATE ai_budget_reservations SET status = 'released', resolved_at = ? WHERE id = ? AND status = 'reserved'",
      nowIso(),
      reservationId,
    );
  });
}

export function logGeneration(row: GenerationLogInput) {
  if (row.budgetReservationId) {
    settleAiBudget(row.budgetReservationId, row);
    return;
  }
  insertGenerationLog(row);
}

export { generateIdea, generateText, ruleCheck, illustrationPrompt, findSimilar };
