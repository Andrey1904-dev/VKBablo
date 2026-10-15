/**
 * AI adapters and safety gates.
 *
 * Defaults are deliberately safe: paid calls are off, the test provider never
 * makes a network request, and configured providers cannot send image
 * references until an adapter actually implements reference transfer.
 */
import { admin } from "./db.ts";
import { readAiKey } from "./secrets.ts";
import { AI_BASE_URL, AI_IMAGE_MODEL, AI_TEXT_MODEL } from "./env.ts";
import type { CommunityId } from "./core/types.ts";
import { DEFAULT_AI_PROMPTS } from "./core/constants.ts";
import { generateIdea, generateText, type Idea } from "./core/content-engine.ts";
import { buildDemoIllustration, DEMO_IMAGE_NOTE } from "./images.ts";
import { uploadObject } from "./storage.ts";
import { assertBudgetAvailable, paidAiCallAllowed } from "./core/ai-safety.ts";
import { ProviderRequestError, requestCompatibleImage, requestCompatibleText } from "./core/ai-provider.ts";

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
  costEstimated: boolean;
  provider: string;
  demo: boolean;
  warning?: string;
}

export interface ImageResult {
  path: string;
  model: string;
  costUsd: number;
  costEstimated: boolean;
  provider: string;
  demo: boolean;
  note?: string;
}

export interface AiSettings {
  provider: string;
  textModel: string;
  imageModel: string;
  baseUrl: string;
  limitUsd: number;
  spendUsd: number;
  paidEnabled: boolean;
  /** Conservative estimate from server-side provider metadata. */
  textPricePer1kTokensUsd: number;
  imagePriceUsd: number;
  maxTokens: number;
  supportsReferences: false;
}

export interface PromptTemplateRecord {
  id: string | null;
  name: string;
  template: string;
  version: number;
  source: "database" | "builtin";
  warning?: string;
}

export interface GenerationLogRow {
  communityId?: string | null;
  postId?: string | null;
  jobId?: string | null;
  type: string;
  provider: string;
  model: string;
  prompt: string;
  result: string;
  costUsd: number;
  costEstimated?: boolean;
  status: string;
  error?: string | null;
}

export interface AiRuntime {
  readAiKey(): Promise<string | null>;
  fetcher: typeof fetch;
  logGeneration(row: GenerationLogRow): Promise<void>;
  uploadImage(bytes: Uint8Array, mime: string, extension: string): Promise<{ path: string }>;
}

export class AiCallError extends Error {
  readonly costUsd: number;
  constructor(message: string, costUsd: number) {
    super(message);
    this.name = "AiCallError";
    this.costUsd = costUsd;
  }
}

const DEFAULT_TEXT_PRICE_PER_1K_USD = 0.001;
const UNKNOWN_PROVIDER_TEXT_PRICE_PER_1K_USD = 0.01;
const DEFAULT_IMAGE_PRICE_USD = 0.1;
const DEFAULT_MAX_TOKENS = 900;

export async function loadAiSettings(): Promise<AiSettings> {
  const client = admin();
  const { data: rows, error: settingsError } = await client.from("application_settings").select("key, value");
  if (settingsError) throw new Error(`Не удалось прочитать настройки AI; платный вызов заблокирован: ${settingsError.message}`);

  const values = new Map<string, string>((rows ?? []).map((row: { key: string; value: unknown }) => [String(row.key), String(row.value ?? "")]));
  const providerRaw = values.get("ai_provider") ?? "test";
  const provider = ["test", "openai", "compatible", "custom"].includes(providerRaw) ? providerRaw : "test";

  const [spendResult, providerResult] = await Promise.all([
    client.rpc("month_spend_usd"),
    client.from("ai_providers")
      .select("price_per_image_usd, price_per_1k_tokens_usd")
      .eq("id", provider)
      .maybeSingle(),
  ]);
  if (spendResult.error) throw new Error(`Не удалось проверить расходы AI; платный вызов заблокирован: ${spendResult.error.message}`);
  if (providerResult.error) throw new Error(`Не удалось прочитать тариф AI; платный вызов заблокирован: ${providerResult.error.message}`);

  const spendUsd = Number(spendResult.data);
  const limitRaw = values.get("ai_monthly_limit_usd");
  const limitUsd = limitRaw === undefined ? 20 : Number(limitRaw);
  if (!Number.isFinite(spendUsd) || spendUsd < 0 || !Number.isFinite(limitUsd) || limitUsd < 0) {
    throw new Error("Настройки бюджета AI повреждены; платный вызов заблокирован.");
  }

  const rawTextRate = Number(providerResult.data?.price_per_1k_tokens_usd ?? 0);
  const rawImagePrice = Number(providerResult.data?.price_per_image_usd ?? 0);
  const textPricePer1kTokensUsd = provider === "test"
    ? 0
    : Math.max(Number.isFinite(rawTextRate) ? rawTextRate : 0, provider === "openai" ? DEFAULT_TEXT_PRICE_PER_1K_USD : UNKNOWN_PROVIDER_TEXT_PRICE_PER_1K_USD);
  const imagePriceUsd = provider === "test"
    ? 0
    : Math.max(Number.isFinite(rawImagePrice) ? rawImagePrice : 0, DEFAULT_IMAGE_PRICE_USD);
  const baseUrl = values.get("ai_base_url") || AI_BASE_URL;

  return {
    provider,
    textModel: values.get("ai_text_model") || AI_TEXT_MODEL || "gpt-4o-mini",
    imageModel: values.get("ai_image_model") || AI_IMAGE_MODEL || "gpt-image-1",
    baseUrl,
    limitUsd,
    spendUsd,
    paidEnabled: (values.get("ai_paid_calls_enabled") ?? "false").toLowerCase() === "true",
    textPricePer1kTokensUsd,
    imagePriceUsd,
    maxTokens: DEFAULT_MAX_TOKENS,
    // Existing chat-completions / images-generations adapters do not upload references.
    supportsReferences: false,
  };
}

export function budgetGuard(settings: AiSettings, estimatedUsd: number): void {
  assertBudgetAvailable(settings.spendUsd, settings.limitUsd, estimatedUsd);
}

export function estimateTextCostUsd(input: { system: string; user: string }, settings: AiSettings): number {
  // Russian prompts can use relatively more tokens than English; use a conservative 2 chars/token.
  const estimatedInputTokens = Math.ceil((input.system.length + input.user.length) / 2);
  const estimatedTokens = estimatedInputTokens + settings.maxTokens;
  return Math.max(settings.textPricePer1kTokensUsd, settings.provider === "test" ? 0 : DEFAULT_TEXT_PRICE_PER_1K_USD) * estimatedTokens / 1000;
}

export function estimateImageCostUsd(settings: AiSettings): number {
  return settings.provider === "test" ? 0 : Math.max(settings.imagePriceUsd, DEFAULT_IMAGE_PRICE_USD);
}

export function paidGuard(settings: AiSettings): string | null {
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

export async function loadAiPromptTemplate(communityId: CommunityId, kind: "text" | "image"): Promise<PromptTemplateRecord> {
  const fallback = DEFAULT_AI_PROMPTS.find((item) => item.communityId === communityId && item.kind === kind && item.active);
  const fallbackRecord: PromptTemplateRecord | null = fallback
    ? { id: fallback.id, name: fallback.name, template: fallback.template, version: fallback.version, source: "builtin", warning: "Используется встроенный безопасный шаблон: активный шаблон из БД недоступен." }
    : null;

  try {
    const { data, error } = await admin()
      .from("ai_prompt_templates")
      .select("id, name, template, version")
      .eq("community_id", communityId)
      .eq("kind", kind)
      .eq("active", true)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return fallbackRecord ?? { id: null, name: "", template: "", version: 0, source: "builtin", warning: "Шаблоны недоступны; использованы постоянные правила приложения." };
    if (data && typeof data.template === "string") {
      return { id: String(data.id), name: String(data.name ?? ""), template: data.template, version: Number(data.version ?? 1), source: "database" };
    }
  } catch {
    // The hard-coded prompt and community rules remain available if this table is not seeded yet.
  }
  return fallbackRecord ?? { id: null, name: "", template: "", version: 0, source: "builtin", warning: "Активный шаблон не найден; использованы постоянные правила приложения." };
}

export async function describeAdapter(): Promise<AiAdapter> {
  const settings = await loadAiSettings();
  const key = await readAiKey();
  const guard = paidGuard(settings);
  const isLive = paidAiCallAllowed(settings.provider, settings.paidEnabled, Boolean(key));

  if (!isLive) {
    const label = guard
      ? `Тестовый движок (${guard})`
      : settings.provider === "test"
        ? "Тестовый движок (выбран)"
        : "Тестовый движок (ключ AI не задан)";
    return {
      id: "test",
      label,
      demo: true,
      supportsReferences: false,
      supportsIdentityLock: false,
      limitations: [
        guard ?? "Генерируется детерминированный демонстрационный контент; платный AI не вызывается.",
        "Тестовый движок не является языковой моделью и не обещает сохранение внешности персонажей.",
      ],
    };
  }

  return {
    id: settings.provider,
    label: settings.provider === "openai" ? "OpenAI" : `Совместимый API (${settings.baseUrl})`,
    demo: false,
    supportsReferences: false,
    supportsIdentityLock: false,
    limitations: [
      "Текущий адаптер не передаёт изображения-референсы провайдеру; сходство персонажей не гарантируется.",
      "Identity-lock не реализован; каждую публикацию обязательно проверять вручную.",
    ],
  };
}

async function logGeneration(row: GenerationLogRow): Promise<void> {
  const { error } = await admin().from("ai_generations").insert({
    community_id: row.communityId ?? null,
    post_id: row.postId ?? null,
    job_id: row.jobId ?? null,
    type: row.type,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt.slice(0, 4000),
    result: row.result.slice(0, 8000),
    cost_usd: row.costUsd,
    cost_estimated: row.costEstimated ?? false,
    status: row.status,
    error: row.error ?? null,
  });
  if (error) throw new Error(`Не удалось записать журнал AI: ${error.message}`);
}

const defaultRuntime: AiRuntime = {
  readAiKey,
  fetcher: (...args) => fetch(...args),
  logGeneration,
  async uploadImage(bytes, mime, extension) {
    return uploadObject({ folder: "generated", bytes, mime, extension });
  },
};

function fullPromptForLog(input: { system: string; user: string }): string {
  return `SYSTEM:\n${input.system}\n\nUSER:\n${input.user}`;
}

function redactError(value: string, key: string | null): string {
  let out = value.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  if (key) out = out.split(key).join("[REDACTED]");
  return out.slice(0, 500);
}

function normalizedBaseUrl(value: string): string {
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

function isAiCallError(error: unknown): error is AiCallError | ProviderRequestError {
  return error instanceof AiCallError || error instanceof ProviderRequestError;
}

async function logFailedCall(runtime: AiRuntime, row: GenerationLogRow, error: unknown): Promise<void> {
  try {
    await runtime.logGeneration({
      ...row,
      status: "error",
      result: "",
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    });
  } catch {
    // The original failure remains the actionable error; never include provider credentials.
  }
}

export async function generateTextWithAi(
  input: TextInput & { postId?: string | null; jobId?: string | null },
  settingsArg?: AiSettings,
  runtime: AiRuntime = defaultRuntime,
): Promise<TextResult> {
  const settings = settingsArg ?? (await loadAiSettings());
  const guard = paidGuard(settings);
  const key = await runtime.readAiKey();
  const promptForLog = fullPromptForLog(input);

  if (guard || !key || settings.provider === "test") {
    const idea = input.idea ?? generateIdea(input.communityId, [], input.seed);
    const text = generateText(input.communityId, idea, input.seed);
    await runtime.logGeneration({
      communityId: input.communityId,
      postId: input.postId,
      jobId: input.jobId,
      type: "text",
      provider: "test",
      model: "test-writer-v1",
      prompt: promptForLog,
      result: text,
      costUsd: 0,
      status: "done",
    });
    return {
      text,
      model: "test-writer-v1",
      costUsd: 0,
      costEstimated: false,
      provider: "test",
      demo: true,
      warning: guard ?? (!key && settings.provider !== "test" ? "Ключ AI не задан; использован тестовый движок." : undefined),
    };
  }

  const estimatedCost = estimateTextCostUsd(input, settings);
  budgetGuard(settings, estimatedCost);
  const base = normalizedBaseUrl(settings.baseUrl);
  const logBase: GenerationLogRow = {
    communityId: input.communityId,
    postId: input.postId,
    jobId: input.jobId,
    type: "text",
    provider: settings.provider,
    model: settings.textModel,
    prompt: promptForLog,
    result: "",
    costUsd: estimatedCost,
    costEstimated: true,
    status: "error",
  };

  try {
    const result = await requestCompatibleText({
      fetcher: runtime.fetcher,
      baseUrl: base,
      apiKey: key,
      model: settings.textModel,
      system: input.system,
      user: input.user,
      maxTokens: settings.maxTokens,
      pricePer1kTokensUsd: settings.textPricePer1kTokensUsd,
      estimatedCostUsd: estimatedCost,
      signal: AbortSignal.timeout(60_000),
    });
    const text = result.text;
    const hasUsage = result.usageReported;
    const costUsd = result.costUsd;
    const costEstimated = true; // The configured rate is an estimate, not a provider invoice.
    let logWarning: string | undefined;
    try {
      await runtime.logGeneration({ ...logBase, result: text, costUsd, costEstimated: true, status: "done" });
    } catch {
      // A completed provider response must not be retried only because audit logging failed.
      logWarning = "Ответ AI получен, но запись журнала не удалась; проверьте лимит расходов вручную.";
    }
    settings.spendUsd += costUsd;
    return {
      text,
      model: settings.textModel,
      costUsd,
      costEstimated,
      provider: settings.provider,
      demo: false,
      warning: [!hasUsage ? "Провайдер не вернул usage; стоимость учтена по консервативной оценке." : "Стоимость рассчитана по тарифу из настроек; сверяйте её со счётом.", logWarning].filter(Boolean).join(" ") || undefined,
    };
  } catch (error) {
    const message = redactError(error instanceof Error ? error.message : String(error), key);
    const costUsd = isAiCallError(error) ? error.costUsd : estimatedCost;
    await logFailedCall(runtime, { ...logBase, costUsd }, message);
    if (error instanceof AiCallError) throw new AiCallError(message, costUsd);
    throw new AiCallError(`Не удалось выполнить запрос к AI: ${message}`, costUsd);
  }
}

export async function generateImageWithAi(
  input: ImageInput & { postId?: string | null; jobId?: string | null },
  settingsArg?: AiSettings,
  runtime: AiRuntime = defaultRuntime,
): Promise<ImageResult> {
  const settings = settingsArg ?? (await loadAiSettings());
  const guard = paidGuard(settings);
  const key = await runtime.readAiKey();

  if (guard || !key || settings.provider === "test") {
    const svg = buildDemoIllustration({
      communityId: input.communityId,
      title: input.title,
      topic: input.topic,
      seed: input.seed,
    });
    const uploaded = await runtime.uploadImage(new TextEncoder().encode(svg), "image/svg+xml", "svg");
    await runtime.logGeneration({
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
      costEstimated: false,
      provider: "test",
      demo: true,
      note: guard ?? DEMO_IMAGE_NOTE,
    };
  }

  const estimatedCost = estimateImageCostUsd(settings);
  budgetGuard(settings, estimatedCost);
  const base = normalizedBaseUrl(settings.baseUrl);
  const referenceNote = input.referenceUrls?.length
    ? "Текущий адаптер не передаёт референсы изображений провайдеру; точное сходство не гарантируется."
    : undefined;
  const logBase: GenerationLogRow = {
    communityId: input.communityId,
    postId: input.postId,
    jobId: input.jobId,
    type: "image",
    provider: settings.provider,
    model: settings.imageModel,
    prompt: input.prompt,
    result: "",
    costUsd: estimatedCost,
    costEstimated: true,
    status: "error",
  };

  try {
    const bytes = await requestCompatibleImage({
      fetcher: runtime.fetcher,
      baseUrl: base,
      apiKey: key,
      model: settings.imageModel,
      prompt: input.prompt,
      estimatedCostUsd: estimatedCost,
      signal: AbortSignal.timeout(90_000),
    });
    const uploaded = await runtime.uploadImage(bytes, "image/png", "png");
    const costUsd = Math.max(settings.imagePriceUsd, 0);

    let logWarning: string | undefined;
    try {
      await runtime.logGeneration({ ...logBase, result: uploaded.path, costUsd, costEstimated: true, status: "done" });
    } catch {
      // Do not spend again merely because the audit row could not be persisted.
      logWarning = "Ответ AI получен, но запись журнала не удалась; проверьте лимит расходов вручную.";
    }
    settings.spendUsd += costUsd;
    return {
      path: uploaded.path,
      model: settings.imageModel,
      costUsd,
      costEstimated: true,
      provider: settings.provider,
      demo: false,
      note: [referenceNote, "Стоимость изображения рассчитана по тарифу из настроек; сверяйте её со счётом.", logWarning].filter(Boolean).join(" "),
    };
  } catch (error) {
    const message = redactError(error instanceof Error ? error.message : String(error), key);
    const costUsd = isAiCallError(error) ? error.costUsd : estimatedCost;
    await logFailedCall(runtime, { ...logBase, costUsd }, message);
    if (error instanceof AiCallError) throw new AiCallError(message, costUsd);
    throw new AiCallError(`Не удалось выполнить запрос изображения: ${message}`, costUsd);
  }
}
