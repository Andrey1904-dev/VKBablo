// ВНИМАНИЕ: файл сгенерирован из shared/ командой `npm run sync:shared`.
// Правки вносите в источник: shared/<имя>.ts
/** Minimal OpenAI-compatible transport helpers with an injected fetcher for mock-only tests. */

export class ProviderRequestError extends Error {
  readonly costUsd: number;
  constructor(message: string, costUsd: number) {
    super(message);
    this.name = "ProviderRequestError";
    this.costUsd = costUsd;
  }
}

export interface CompatibleTextRequest {
  fetcher: typeof fetch;
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  pricePer1kTokensUsd: number;
  estimatedCostUsd: number;
  signal?: AbortSignal;
}

export interface CompatibleTextResponse {
  text: string;
  costUsd: number;
  costEstimated: true;
  usageReported: boolean;
}

export async function requestCompatibleText(input: CompatibleTextRequest): Promise<CompatibleTextResponse> {
  let response: Response;
  try {
    response = await input.fetcher(`${input.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        temperature: 0.85,
        max_tokens: input.maxTokens,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    throw new ProviderRequestError(`AI transport error: ${error instanceof Error ? error.message : String(error)}`, input.estimatedCostUsd);
  }

  if (!response.ok) {
    throw new ProviderRequestError(`AI API ${response.status}: ${await response.text()}`, input.estimatedCostUsd);
  }

  let payload: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    payload = await response.json() as typeof payload;
  } catch (error) {
    throw new ProviderRequestError(`AI API returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, input.estimatedCostUsd);
  }

  const text = payload.choices?.[0]?.message?.content?.trim();
  if (!text) throw new ProviderRequestError("Пустой ответ модели", input.estimatedCostUsd);

  const promptTokens = Number(payload.usage?.prompt_tokens);
  const completionTokens = Number(payload.usage?.completion_tokens);
  const usageReported = Number.isFinite(promptTokens) && promptTokens >= 0 && Number.isFinite(completionTokens) && completionTokens >= 0;
  const costUsd = usageReported
    ? (promptTokens + completionTokens) * input.pricePer1kTokensUsd / 1000
    : input.estimatedCostUsd;

  return { text, costUsd, costEstimated: true, usageReported };
}

export interface CompatibleImageRequest {
  fetcher: typeof fetch;
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  estimatedCostUsd: number;
  signal?: AbortSignal;
}

export async function requestCompatibleImage(input: CompatibleImageRequest): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await input.fetcher(`${input.baseUrl.replace(/\/$/, "")}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        prompt: input.prompt,
        size: "1024x1024",
        n: 1,
        response_format: "b64_json",
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    throw new ProviderRequestError(`Image transport error: ${error instanceof Error ? error.message : String(error)}`, input.estimatedCostUsd);
  }

  if (!response.ok) {
    throw new ProviderRequestError(`Image API ${response.status}: ${await response.text()}`, input.estimatedCostUsd);
  }

  let payload: { data?: Array<{ b64_json?: string }> };
  try {
    payload = await response.json() as typeof payload;
  } catch (error) {
    throw new ProviderRequestError(`Image API returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, input.estimatedCostUsd);
  }
  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) throw new ProviderRequestError("Провайдер не вернул изображение", input.estimatedCostUsd);

  try {
    const binary = atob(b64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ProviderRequestError("Провайдер вернул некорректное base64-изображение", input.estimatedCostUsd);
  }
}
