/** Pure helpers for safe AI job orchestration (browser/Node/Deno compatible). */

export type GenerationScope = "text" | "image" | "all";

export interface GenerationMode {
  generateIdea: boolean;
  generateText: boolean;
  generateImage: boolean;
  scope: GenerationScope | "idea";
}

/** Resolve API kind/scope explicitly; never infer "all" from a missing scope on text/image jobs. */
export function resolveGenerationMode(kind: string, requestedScope?: unknown): GenerationMode {
  const scope = typeof requestedScope === "string" ? requestedScope.toLowerCase() : "";
  if (scope === "text") return { generateIdea: false, generateText: true, generateImage: false, scope: "text" };
  if (scope === "image") return { generateIdea: false, generateText: false, generateImage: true, scope: "image" };
  if (scope === "all") return { generateIdea: false, generateText: true, generateImage: true, scope: "all" };

  switch (kind) {
    case "idea":
      return { generateIdea: true, generateText: false, generateImage: false, scope: "idea" };
    case "text":
    case "preview":
      return { generateIdea: false, generateText: true, generateImage: false, scope: "text" };
    case "image":
      return { generateIdea: false, generateText: false, generateImage: true, scope: "image" };
    case "full_post":
    case "regenerate":
    default:
      return { generateIdea: false, generateText: true, generateImage: true, scope: "all" };
  }
}

/** Keep user guidance bounded and readable; hard community rules remain in the system prompt. */
export function sanitizeUserPrompt(value: unknown, maxLength = 2000): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, Math.max(0, maxLength));
}

/** Render {{name}} placeholders without evaluating template content as code. */
export function renderPromptTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, name: string) => {
    const value = values[name];
    if (Array.isArray(value)) return value.map(String).join(", ");
    return value == null ? "" : String(value);
  });
}

export function paidAiCallAllowed(provider: string, paidCallsEnabled: boolean, keyPresent: boolean): boolean {
  return provider !== "test" && paidCallsEnabled && keyPresent;
}

export interface ReferencePolicy {
  sendReferences: boolean;
  warning: string | null;
  promptInstruction: string;
}

export function referencePolicy(approvedReferenceCount: number, providerSupportsReferences: boolean): ReferencePolicy {
  if (approvedReferenceCount <= 0) {
    return {
      sendReferences: false,
      warning: null,
      promptInstruction: "No approved character reference images are available. Do not claim or imply exact resemblance.",
    };
  }
  if (!providerSupportsReferences) {
    return {
      sendReferences: false,
      warning: "Одобренные референсы есть, но выбранный адаптер не передаёт изображения провайдеру; точное сходство не гарантируется.",
      promptInstruction: "Approved character references exist but are not provided to this image model. Do not claim or imply exact resemblance; use a non-identifying editorial depiction.",
    };
  }
  return {
    sendReferences: true,
    warning: "Референсы будут переданы провайдеру, но точное сохранение внешности не гарантируется.",
    promptInstruction: "Use only the approved character reference images supplied with this request. Do not invent or alter fixed character traits.",
  };
}

/** Conservative per-job estimate before sequential text + image calls. */
export function estimateCombinedCost(input: {
  generateText: boolean;
  generateImage: boolean;
  textEstimateUsd: number;
  imageEstimateUsd: number;
}): number {
  return (input.generateText ? Math.max(0, input.textEstimateUsd) : 0) +
    (input.generateImage ? Math.max(0, input.imageEstimateUsd) : 0);
}

/** A zero/invalid limit fails closed for paid use; it never means unlimited spend. */
export function assertBudgetAvailable(spendUsd: number, limitUsd: number, estimatedUsd: number): void {
  if (!Number.isFinite(spendUsd) || spendUsd < 0 || !Number.isFinite(limitUsd) || !Number.isFinite(estimatedUsd) || estimatedUsd < 0) {
    throw new Error("Не удалось проверить безопасный бюджет AI; платный вызов заблокирован.");
  }
  if (limitUsd <= 0) {
    throw new Error("Платные AI-вызовы заблокированы: установите положительный месячный лимит расходов.");
  }
  if (spendUsd + estimatedUsd >= limitUsd) {
    throw new Error(
      `Достигнут лимит расходов на AI: $${spendUsd.toFixed(2)} из $${limitUsd.toFixed(2)}. ` +
        "Увеличьте лимит или дождитесь нового месяца.",
    );
  }
}
