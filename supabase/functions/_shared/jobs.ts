/**
 * Исполнение заданий генерации (§10, §14 ТЗ).
 *
 * Одно задание = один шаг. Долгие пайплайны разбиты на этапы: воркер не держит
 * один бесконечный вызов, а завершает задание и (при необходимости) ставит следующее.
 */
import { admin, callRpc } from "./db.ts";
import { ApiError } from "./http.ts";
import { generateImageWithAi, generateTextWithAi, loadAiSettings, type AiAdapter } from "./ai.ts";
import { illustrationPrompt } from "./images.ts";
import { resolveReferences } from "./references.ts";
import { loadCommunityContext, loadRecentTexts } from "./context.ts";
import type { CommunityId, GenerationMeta } from "./core/types.ts";
import { generateIdea, generateText, type Idea } from "./core/content-engine.ts";
import { validateCommunityText } from "./core/rules.ts";
import { SIMILARITY_BLOCK_THRESHOLD, similarity } from "./core/similarity.ts";
import { STYLE_RULES, COMMUNITY_META } from "./core/constants.ts";

export interface GenerationJob {
  id: string;
  communityId: string;
  postId: string | null;
  kind: string;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
}

export interface JobOutcome {
  ok: boolean;
  summary: string;
  costUsd: number;
  error?: string;
}

function buildSystemPrompt(communityId: CommunityId, rules: { textStyle: string; forbidden: string[] } | null) {
  const style = STYLE_RULES[communityId];
  const parts = [
    `Ты автор постов для сообщества ВКонтакте «${COMMUNITY_META[communityId].name}».`,
    style.voice,
    style.hook,
    style.language,
    `Обязательно: ${style.mustInclude.join(", ")}.`,
    `Запрещено: ${style.mustAvoid.join(", ")}.`,
    style.ending,
    ...style.notes,
  ];
  if (rules?.textStyle) parts.push(`Правила сообщества: ${rules.textStyle}`);
  if (rules?.forbidden?.length) parts.push(`Строго запрещено: ${rules.forbidden.join(", ")}.`);
  parts.push("Пиши только текст поста на русском, без заголовка и без простыни хештегов.");
  return parts.join("\n");
}

async function loadIdeaFromPayload(payload: Record<string, unknown>, communityId: CommunityId, seed: string): Promise<Idea> {
  const topic = typeof payload.topic === "string" ? payload.topic : "";
  const title = typeof payload.title === "string" ? payload.title : "";
  const angle = typeof payload.angle === "string" ? payload.angle : "";
  if (topic) {
    return { key: `${communityId}:${topic}:manual`, topic, title: title || topic, angle: angle || "" };
  }
  const { data: used } = await admin()
    .from("topics")
    .select("idea_key")
    .eq("community_id", communityId)
    .order("created_at", { ascending: false })
    .limit(200);
  const usedKeys = (used ?? []).map((row: { idea_key: string | null }) => String(row.idea_key ?? ""));
  return generateIdea(communityId, usedKeys, seed);
}

export async function runGenerationJob(job: GenerationJob): Promise<JobOutcome> {
  const communityId = job.communityId as CommunityId;
  const settings = await loadAiSettings();
  const context = await loadCommunityContext(communityId);
  const seed = `${job.id}`;
  const payload = job.payload ?? {};
  const scope = typeof payload.scope === "string" ? payload.scope : null;

  const idea = await loadIdeaFromPayload(payload, communityId, seed);
  const topic = idea.topic;
  const title = idea.title;

  // 1. Текст
  const shouldGenerateText = !scope || scope === "all" || scope === "text" || job.kind === "text" || job.kind === "full_post";
  let text = "";
  let textModel = "test-writer-v1";
  let textProvider = "test";
  let cost = 0;
  let demo = true;
  const warnings: string[] = [];

  if (shouldGenerateText) {
    const system = buildSystemPrompt(communityId, context.rules);
    const user = [
      `Тема: ${idea.topic}`,
      `Угол: ${idea.angle}`,
      idea.series ? `Серия: ${idea.series}` : "",
      context.characters.length
        ? `Персонажи: ${context.characters
            .map((c) => `${c.name} — ${c.appearanceStatus === "approved" ? "внешность по утверждённым референсам" : "внешность ожидает утверждённых референсов"}`)
            .join("; ")}`
        : "",
      context.rules?.preferredTopics?.length ? `Предпочтительные темы: ${context.rules.preferredTopics.join(", ")}` : "",
      context.rules?.unwantedTopics?.length ? `Нежелательные темы: ${context.rules.unwantedTopics.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await generateTextWithAi(
      { communityId, system, user, seed, idea, postId: job.postId, jobId: job.id },
      settings,
    );
    text = result.text;
    textModel = result.model;
    textProvider = result.provider;
    cost += result.costUsd;
    demo = result.demo;
    warnings.push(...validateCommunityText(communityId, text).map((v) => `${v.severity === "error" ? "⛔" : "⚠"} ${v.message}`));
  } else if (job.postId) {
    const { data } = await admin().from("posts").select("text").eq("id", job.postId).maybeSingle();
    text = String(data?.text ?? "");
  }

  if (shouldGenerateText && text.trim().length === 0) {
    throw new ApiError(502, "Не удалось получить текст публикации", "ai_text");
  }

  // 2. Проверка повторов среди последних публикаций сообщества
  if (shouldGenerateText && text) {
    const previous = await loadRecentTexts(communityId, job.postId);
    let best = { id: "", score: 0 };
    for (const row of previous) {
      const score = similarity(text, row.text);
      if (score > best.score) best = { id: row.id, score };
    }
    if (best.score >= SIMILARITY_BLOCK_THRESHOLD) {
      throw new Error(
        `Текст слишком похож на предыдущую публикацию (${Math.round(best.score * 100)}%). Задание отправлено на повтор.`,
      );
    }
  }

  // 3. Изображение
  let imagePath: string | null = null;
  let imageModel = "test-illustrator-v1";
  let imageProvider = "test";
  let imagePrompt = "";

  const shouldGenerateImage = !scope || scope === "all" || scope === "image" || job.kind === "image" || job.kind === "full_post";
  if (shouldGenerateImage) {
    imagePrompt = illustrationPrompt(communityId, topic, title);
    const references = await resolveReferences(context.characters);
    if (references.length && !context.adapterCanUseReferences) {
      warnings.push(
        "⚠ Выбранный AI-провайдер не поддерживает референсы персонажей: точное совпадение внешности не гарантируется.",
      );
    }
    const image = await generateImageWithAi(
      {
        communityId,
        prompt: imagePrompt,
        seed: `${seed}:image`,
        title,
        topic,
        referenceUrls: references,
        postId: job.postId,
        jobId: job.id,
      },
      settings,
    );
    imagePath = image.path;
    imageModel = image.model;
    imageProvider = image.provider;
    cost += image.costUsd;
    demo = demo || image.demo;
    if (image.note) warnings.push(`⚠ ${image.note}`);
  }

  // 4. Сохраняем результат на публикацию
  if (job.postId) {
    const meta: GenerationMeta = {
      provider: textProvider,
      model: textModel,
      imageProvider,
      imageModel,
      costUsd: cost,
      ideaSource: idea.key,
      warnings,
      providerLimitations: context.limitations,
      demo,
    };

    const similarityScore = shouldGenerateText && text
      ? await highestSimilarity(communityId, text, job.postId)
      : 0;

    const { error } = await admin()
      .from("posts")
      .update({
        status: "review",
        title,
        text: shouldGenerateText ? text : undefined,
        image_path: imagePath ?? undefined,
        image_prompt: imagePrompt || undefined,
        topic,
        idea: idea.angle,
        generation_meta: meta,
        similarity_score: similarityScore,
        similar_to: null,
        error_message: null,
        test_mode: demo,
      })
      .eq("id", job.postId);

    if (error) throw new ApiError(500, `Не удалось сохранить публикацию: ${error.message}`, "db");

    await admin().from("topics").insert({
      community_id: communityId,
      topic,
      idea_key: idea.key,
      post_id: job.postId,
    });

    await admin().from("notifications").insert({
      type: "review",
      title: "Новый пост на проверке",
      message: `${COMMUNITY_META[communityId].shortName}: «${title}»`,
      link: `/posts/${job.postId}`,
    });
  }

  const summary = demo
    ? "Сгенерировано тестовым движком (демонстрационный контент)"
    : `Сгенерировано провайдером ${textProvider}/${imageProvider}`;

  return { ok: true, summary, costUsd: cost };
}

async function highestSimilarity(communityId: string, text: string, postId: string): Promise<number> {
  const previous = await loadRecentTexts(communityId, postId);
  let best = 0;
  for (const row of previous) best = Math.max(best, similarity(text, row.text));
  return Number(best.toFixed(4));
}

export type { AiAdapter };
