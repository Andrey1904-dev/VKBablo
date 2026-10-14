import { all, get, run, setSetting, setting } from "./db.ts";
import { decrypt, encrypt, nid, nowIso } from "./lib.ts";
import { generateIdea, generateText, ruleCheck, type Idea } from "./content.ts";
import { illustrationPrompt, makeIllustration } from "./images.ts";
import { findSimilar } from "./similarity.ts";
import type { AiProviderId, CommunityId } from "../shared/types.ts";

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
  generateText(input: TextGenInput): Promise<{ text: string; model: string; costUsd: number }>;
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

async function openaiCompatible(
  kind: "openai" | "compatible",
): Promise<AiAdapter> {
  return {
    id: kind,
    label: kind === "openai" ? "OpenAI" : "Совместимый API",
    supportsReferences: false,
    async generateText(input) {
      const key = getAiKey();
      if (!key) throw new Error("Не задан ключ AI API");
      const model = setting("ai_text_model", "gpt-4o-mini");
      const base = (setting("ai_base_url") || "https://api.openai.com/v1").replace(/\/$/, "");
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0.85,
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`AI API ${res.status}: ${t.slice(0, 400)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("Пустой ответ модели");
      const cost =
        ((data.usage?.prompt_tokens ?? 0) * 0.15 + (data.usage?.completion_tokens ?? 0) * 0.6) /
        1_000_000;
      return { text, model, costUsd: cost };
    },
    async generateImage(input) {
      const key = getAiKey();
      if (!key) throw new Error("Не задан ключ AI API");
      const model = setting("ai_image_model", "dall-e-3");
      const base = (setting("ai_base_url") || "https://api.openai.com/v1").replace(/\/$/, "");
      if (input.referenceUrls?.length) {
        // OpenAI images API does not reliably lock a character from refs in all models.
        // We still generate, but callers must surface this limitation.
      }
      const res = await fetch(`${base}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          prompt: input.prompt,
          size: "1024x1024",
          response_format: "b64_json",
          n: 1,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`Image API ${res.status}: ${t.slice(0, 400)}`);
      }
      const data = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
      const b64 = data.data?.[0]?.b64_json;
      if (!b64) throw new Error("Изображение не получено");
      const buf = Buffer.from(b64, "base64");
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { UPLOAD_DIR } = await import("./db.ts");
      const name = `${nid("ai")}.png`;
      writeFileSync(join(UPLOAD_DIR, name), buf);
      return {
        path: `/uploads/${name}`,
        model,
        costUsd: 0.04,
        note: input.referenceUrls?.length
          ? "Выбранный провайдер не гарантирует точное сохранение внешности по референсам."
          : undefined,
      };
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
    if (!getAiKey()) return testAdapter;
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
  const limit = Number(setting("ai_monthly_limit_usd", "20"));
  if (limit <= 0) return;
  if (monthSpendUsd() + extra >= limit) {
    throw new Error(`Достигнут лимит расходов на AI: $${limit} в месяц`);
  }
}

export function logGeneration(row: {
  communityId?: string | null;
  type: string;
  provider: string;
  model: string;
  prompt: string;
  result: string;
  costUsd: number;
  status: string;
  error?: string;
}) {
  run(
    `INSERT INTO ai_generations (id, community_id, type, provider, model, prompt, result, cost_usd, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  );
}

export { generateIdea, generateText, ruleCheck, illustrationPrompt, findSimilar };
