/**
 * AI-адаптеры §10 ТЗ.
 *
 * Правила безопасности:
 *  • по умолчанию вызовы платных провайдеров ЗАПРЕЩЕНЫ (`ai_paid_calls_enabled = false`);
 *  • при превышении лимита расходов вызов отклоняется;
 *  • если ключа нет или провайдер выключен — работает тестовый движок, и это видно в метаданных;
 *  • в журнал `ai_generations` пишутся промпт, модель, стоимость, статус и ошибки.
 *
 * Ни один адаптер не возвращает фиктивные данные как результат платной модели:
 * тестовый движок всегда помечается provider = "test" и demo = true.
 */
import { admin } from "./db.ts";
import { readAiKey } from "./secrets.ts";
import { AI_BASE_URL, AI_IMAGE_MODEL, AI_TEXT_MODEL } from "./env.ts";
import type { CommunityId } from "./core/types.ts";
import { generateIdea, generateText, type Idea } from "./core/content-engine.ts";
import { buildDemoIllustration, DEMO_IMAGE_NOTE, illustrationPrompt } from "./images.ts";
import { uploadObject } from "./storage.ts";

export interface AiAdapter {
  id: string;
  label: string;
  demo: boolean;
  supportsReferences: boolean;
  supportsIdentityLock: boolean;
  limitations: string[];
}

export interface TextResult {
  text: string;
  model: string;
  costUsd: number;
  provider: string;
  demo: boolean;
}

export interface ImageResult {
  path: string;
  model: string;
  costUsd: number;
  provider: string;
  demo: boolean;
  note?: string;
}

interface Settings {
  provider: string;
  textModel: string;
  imageModel: string;
  baseUrl: string;
  limitUsd: number;
  spendUsd: number;
  paidEnabled: boolean;
}

export async function loadAiSettings(): Promise<Settings> {
  const { data } = await admin().from("application_settings").select("key, value");
  const map = new Map((data ?? []).map((row: { key: string; value: string }) => [row.key, row.value]));

  const { data: spend } = await admin().rpc("month_spend_usd");
  const limit = Number(map.get("ai_monthly_limit_usd") ?? "20");

  return {
    provider: map.get("ai_provider") ?? "test",
    textModel: map.get("ai_text_model") || AI_TEXT_MODEL || "gpt-4o-mini",
    imageModel: map.get("ai_image_model") || AI_IMAGE_MODEL || "gpt-image-1",
    baseUrl: map.get("ai_base_url") || AI_BASE_URL,
    limitUsd: Number.isFinite(limit) ? limit : 20,
    spendUsd: Number(spend ?? 0),
    // Предохранитель: платные вызовы выключены, пока владелец не включит их явно.
    paidEnabled: (map.get("ai_paid_calls_enabled") ?? "false") === "true",
  };
}

export function budgetGuard(settings: Settings, estimatedUsd: number): void {
  if (settings.limitUsd > 0 && settings.spendUsd + estimatedUsd > settings.limitUsd) {
    throw new Error(
      `Достигнут лимит расходов на AI: $${settings.spendUsd.toFixed(2)} из $${settings.limitUsd}. ` +
        `Увеличьте лимит в настройках или дождитесь нового месяца.`,
    );
  }
}

export function paidGuard(settings: Settings): string | null {
  if (settings.provider === "test") return null;
  if (!settings.paidEnabled) {
    return "Платные AI-вызовы выключены. Работает тестовый движок (provider = test).";
  }
  return null;
}

export interface TextInput {
  communityId: CommunityId;
  system: string;
  user: string;
  seed: string;
  idea?: Idea;
}

export interface ImageInput {
  communityId: CommunityId;
  prompt: string;
  seed: string;
  title: string;
  topic: string;
  referenceUrls?: string[];
}

export async function describeAdapter(): Promise<AiAdapter> {
  const settings = await loadAiSettings();
  const key = await readAiKey();
  const guard = paidGuard(settings);
  const isLive = settings.provider !== "test" && !!key && !guard;

  if (!isLive) {
    return {
      id: "test",
      label: guard
        ? `Тестовый движок (${guard})`
        : key
          ? "Тестовый движок (провайдер не выбран)"
          : "Тестовый движок (ключ AI не задан)",
      demo: true,
      supportsReferences: false,
      supportsIdentityLock: false,
      limitations: [
        guard ?? "Ключ AI не задан: генерируется детерминированный демонстрационный контент.",
        "Тестовый движок не является языковой моделью и не обещает сохранение внешности персонажей.",
      ],
    };
  }

  return {
    id: settings.provider,
    label: settings.provider === "openai" ? "OpenAI" : `Совместимый API (${settings.baseUrl})`,
    demo: false,
    supportsReferences: true,
    supportsIdentityLock: false,
    limitations: [
      "Точное сохранение внешности персонажа по референсу не гарантируется выбранной моделью: " +
        "идентичность может плавать между публикациями.",
    ],
  };
}

async function logGeneration(row: {
  communityId?: string | null;
  postId?: string | null;
  jobId?: string | null;
  type: string;
  provider: string;
  model: string;
  prompt: string;
  result: string;
  costUsd: number;
  status: string;
  error?: string | null;
}): Promise<void> {
  await admin().from("ai_generations").insert({
    community_id: row.communityId ?? null,
    post_id: row.postId ?? null,
    job_id: row.jobId ?? null,
    type: row.type,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt.slice(0, 4000),
    result: row.result.slice(0, 8000),
    cost_usd: row.costUsd,
    status: row.status,
    error: row.error ?? null,
  });
}

export async function generateTextWithAi(
  input: TextInput & { postId?: string | null; jobId?: string | null },
  settingsArg?: Settings,
): Promise<TextResult> {
  const settings = settingsArg ?? (await loadAiSettings());
  const guard = paidGuard(settings);
  const key = await readAiKey();

  if (guard || !key || settings.provider === "test") {
    const idea = input.idea ?? generateIdea(input.communityId, [], input.seed);
    const text = generateText(input.communityId, idea, input.seed);
    await logGeneration({
      communityId: input.communityId,
      postId: input.postId,
      jobId: input.jobId,
      type: "text",
      provider: "test",
      model: "test-writer-v1",
      prompt: input.user,
      result: text,
      costUsd: 0,
      status: "done",
    });
    return { text, model: "test-writer-v1", costUsd: 0, provider: "test", demo: true };
  }

  budgetGuard(settings, 0.002);
  const base = settings.baseUrl.replace(/\/$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.textModel,
      temperature: 0.85,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const body = await response.text();
    const error = `AI API ${response.status}: ${body.slice(0, 300)}`;
    await logGeneration({
      communityId: input.communityId,
      postId: input.postId,
      jobId: input.jobId,
      type: "text",
      provider: settings.provider,
      model: settings.textModel,
      prompt: input.user,
      result: "",
      costUsd: 0,
      status: "error",
      error,
    });
    throw new Error(error);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Пустой ответ модели");

  const cost = ((payload.usage?.prompt_tokens ?? 0) * 0.00000015) +
    ((payload.usage?.completion_tokens ?? 0) * 0.0000006);

  await logGeneration({
    communityId: input.communityId,
    postId: input.postId,
    jobId: input.jobId,
    type: "text",
    provider: settings.provider,
    model: settings.textModel,
    prompt: input.user,
    result: text,
    costUsd: cost,
    status: "done",
  });

  return { text, model: settings.textModel, costUsd: cost, provider: settings.provider, demo: false };
}

export async function generateImageWithAi(
  input: ImageInput & { postId?: string | null; jobId?: string | null },
  settingsArg?: Settings,
): Promise<ImageResult> {
  const settings = settingsArg ?? (await loadAiSettings());
  const guard = paidGuard(settings);
  const key = await readAiKey();

  if (guard || !key || settings.provider === "test") {
    const svg = buildDemoIllustration({
      communityId: input.communityId,
      title: input.title,
      topic: input.topic,
      seed: input.seed,
    });
    const uploaded = await uploadObject({
      folder: "generated",
      bytes: new TextEncoder().encode(svg),
      mime: "image/svg+xml",
      extension: "svg",
    });
    await logGeneration({
      communityId: input.communityId,
      postId: input.postId,
      jobId: input.jobId,
      type: "image",
      provider: "test",
      model: "test-illustrator-v1",
      prompt: input.prompt,
      result: uploaded.path,
      costUsd: 0,
      status: "done",
    });
    return {
      path: uploaded.path,
      model: "test-illustrator-v1",
      costUsd: 0,
      provider: "test",
      demo: true,
      note: DEMO_IMAGE_NOTE,
    };
  }

  budgetGuard(settings, 0.06);
  const base = settings.baseUrl.replace(/\/$/, "");
  const response = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.imageModel,
      prompt: input.prompt,
      size: "1024x1024",
      n: 1,
      response_format: "b64_json",
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    const body = await response.text();
    const error = `Image API ${response.status}: ${body.slice(0, 300)}`;
    await logGeneration({
      communityId: input.communityId,
      postId: input.postId,
      jobId: input.jobId,
      type: "image",
      provider: settings.provider,
      model: settings.imageModel,
      prompt: input.prompt,
      result: "",
      costUsd: 0,
      status: "error",
      error,
    });
    throw new Error(error);
  }

  const payload = (await response.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) throw new Error("Провайдер не вернул изображение");

  const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
  const uploaded = await uploadObject({ folder: "generated", bytes, mime: "image/png", extension: "png" });

  await logGeneration({
    communityId: input.communityId,
    postId: input.postId,
    jobId: input.jobId,
    type: "image",
    provider: settings.provider,
    model: settings.imageModel,
    prompt: input.prompt,
    result: uploaded.path,
    costUsd: 0.04,
    status: "done",
  });

  return {
    path: uploaded.path,
    model: settings.imageModel,
    costUsd: 0.04,
    provider: settings.provider,
    demo: false,
    note: input.referenceUrls?.length
      ? "Провайдер не гарантирует точное сохранение внешности по референсам."
      : undefined,
  };
}

export { illustrationPrompt };
