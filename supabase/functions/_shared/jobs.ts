/** Generation job execution: all results remain drafts requiring explicit owner approval. */
import { admin } from "./db.ts";
import { ApiError } from "./http.ts";
import {
  budgetGuard,
  estimateImageCostUsd,
  estimateTextCostUsd,
  generateImageWithAi,
  generateTextWithAi,
  loadAiPromptTemplate,
  loadAiSettings,
  type AiAdapter,
} from "./ai.ts";
import { illustrationPrompt } from "./images.ts";
import { resolveReferences } from "./references.ts";
import { loadCommunityContext, loadRecentTexts, type CommunityContext } from "./context.ts";
import type { CommunityId, GenerationMeta } from "./core/types.ts";
import { generateIdea, type Idea } from "./core/content-engine.ts";
import { validateCommunityText } from "./core/rules.ts";
import { SIMILARITY_BLOCK_THRESHOLD, similarity } from "./core/similarity.ts";
import { COMMUNITY_META } from "./core/constants.ts";
import { estimateCombinedCost, referencePolicy, renderPromptTemplate, resolveGenerationMode, sanitizeUserPrompt } from "./core/ai-safety.ts";
import { buildCommunityImageUserPrompt, buildCommunitySystemPrompt, buildCommunityTextUserPrompt } from "./core/ai-prompts.ts";

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

interface ExistingPost {
  title: string;
  text: string;
  image_path: string | null;
  image_prompt: string | null;
  topic: string;
  idea: string;
  similarity_score: number | null;
  generation_meta: GenerationMeta | null;
  status: string;
}

export function buildSystemPrompt(communityId: CommunityId, rules: CommunityContext["rules"]): string {
  return buildCommunitySystemPrompt(communityId, rules);
}

export function buildTextUserPrompt(input: {
  idea: Idea;
  community: string;
  audience: string;
  template: string;
  templateName: string;
  templateVersion?: number;
  userGuidance: string;
  characters: CommunityContext["characters"];
  rules: CommunityContext["rules"];
}): string {
  return buildCommunityTextUserPrompt(input);
}

async function loadExistingPost(postId: string | null): Promise<ExistingPost | null> {
  if (!postId) return null;
  const { data, error } = await admin()
    .from("posts")
    .select("title, text, image_path, image_prompt, topic, idea, similarity_score, generation_meta, status")
    .eq("id", postId)
    .maybeSingle();
  if (error) throw new ApiError(500, `Не удалось загрузить исходную публикацию: ${error.message}`, "db");
  if (!data) throw new ApiError(404, "Публикация для генерации не найдена", "post_missing");
  return {
    title: String(data.title ?? ""),
    text: String(data.text ?? ""),
    image_path: (data.image_path as string | null) ?? null,
    image_prompt: (data.image_prompt as string | null) ?? null,
    topic: String(data.topic ?? ""),
    idea: String(data.idea ?? ""),
    similarity_score: data.similarity_score == null ? null : Number(data.similarity_score),
    generation_meta: (data.generation_meta as GenerationMeta | null) ?? null,
    status: String(data.status ?? ""),
  };
}

async function loadIdeaFromPayload(
  payload: Record<string, unknown>,
  communityId: CommunityId,
  seed: string,
  existing: ExistingPost | null,
  preserveExisting: boolean,
  userGuidance: string,
): Promise<Idea> {
  if (preserveExisting && existing?.topic) {
    return {
      key: `${communityId}:${existing.topic}:preserved`,
      topic: existing.topic,
      title: existing.title || existing.topic,
      angle: existing.idea || "Сохранить утверждённый контекст исходной публикации.",
    };
  }

  const explicitTopic = typeof payload.topic === "string" ? sanitizeUserPrompt(payload.topic, 500) : "";
  const topic = explicitTopic || userGuidance;
  const explicitTitle = typeof payload.title === "string" ? sanitizeUserPrompt(payload.title, 180) : "";
  const explicitAngle = typeof payload.angle === "string" ? sanitizeUserPrompt(payload.angle, 500) : "";
  if (topic) {
    return {
      key: `${communityId}:${topic}:manual`,
      topic,
      title: explicitTitle || topic.slice(0, 120),
      angle: explicitAngle || "Развернуть пожелание пользователя в безопасный пост, соблюдая правила сообщества.",
    };
  }

  const { data: used, error } = await admin()
    .from("topics")
    .select("idea_key")
    .eq("community_id", communityId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new ApiError(500, `Не удалось прочитать историю тем: ${error.message}`, "db");
  const usedKeys = (used ?? []).map((row: { idea_key: string | null }) => String(row.idea_key ?? ""));
  return generateIdea(communityId, usedKeys, seed);
}

export async function runGenerationJob(job: GenerationJob): Promise<JobOutcome> {
  const communityId = job.communityId as CommunityId;
  const settings = await loadAiSettings();
  const context = await loadCommunityContext(communityId);
  const seed = `${job.id}`;
  const payload = job.payload ?? {};
  const requestedScope = typeof payload.scope === "string" ? payload.scope : null;
  const mode = resolveGenerationMode(job.kind, requestedScope);
  const userGuidance = sanitizeUserPrompt(payload.prompt, 2000);
  const existing = await loadExistingPost(job.postId);
  if (existing && ["scheduled", "published"].includes(existing.status)) {
    throw new ApiError(409, "Запланированную или опубликованную публикацию нельзя генерировать заново; сначала отмените планирование или создайте новый слот.", "post_not_regenerable");
  }
  const preserveExisting = Boolean(existing && (mode.scope === "text" || mode.scope === "image"));
  const idea = await loadIdeaFromPayload(payload, communityId, seed, existing, preserveExisting, userGuidance);
  const topic = idea.topic;
  const title = idea.title;

  const warnings: string[] = [];
  const textTemplate = mode.generateText ? await loadAiPromptTemplate(communityId, "text") : null;
  const imageTemplate = mode.generateImage ? await loadAiPromptTemplate(communityId, "image") : null;
  if (textTemplate?.warning) warnings.push(`⚠ ${textTemplate.warning}`);
  if (imageTemplate?.warning) warnings.push(`⚠ ${imageTemplate.warning}`);

  const system = buildSystemPrompt(communityId, context.rules);
  const textUser = textTemplate
    ? buildTextUserPrompt({
        idea,
        community: context.name,
        audience: context.rules?.audience ?? "",
        template: textTemplate.template,
        templateName: textTemplate.name,
        templateVersion: textTemplate.version,
        userGuidance,
        characters: context.characters,
        rules: context.rules,
      })
    : "";

  const approvedReferenceCount = context.characters.filter((character) => character.appearanceStatus === "approved").length;
  const reference = referencePolicy(approvedReferenceCount, settings.supportsReferences && context.adapterCanUseReferences);
  if (reference.warning) warnings.push(`⚠ ${reference.warning}`);
  const imageTemplateText = imageTemplate
    ? renderPromptTemplate(imageTemplate.template, {
        community: context.name,
        topic,
        title,
        image_rules: context.rules?.imageRules ?? "",
        character_rules: context.rules?.characterRules ?? "",
        reference_instruction: reference.promptInstruction,
        reference_status: approvedReferenceCount > 0 ? "approved references exist" : "no approved references",
      })
    : "";
  const imagePrompt = mode.generateImage
    ? buildCommunityImageUserPrompt({
        basePrompt: illustrationPrompt(communityId, topic, title, {
          imageRules: context.rules?.imageRules,
          referenceInstruction: reference.promptInstruction,
        }),
        templateName: imageTemplate?.name ?? "",
        templateText: imageTemplateText,
        userGuidance,
        rules: context.rules,
        referenceInstruction: reference.promptInstruction,
      })
    : existing?.image_prompt ?? "";

  // Preflight the combined cost before the first paid request; component-level checks
  // below include updated spend after each successful call.
  if (!context.demo && settings.provider !== "test" && settings.paidEnabled) {
    const estimate = estimateCombinedCost({
      generateText: mode.generateText,
      generateImage: mode.generateImage,
      textEstimateUsd: estimateTextCostUsd({ system, user: textUser }, settings),
      imageEstimateUsd: estimateImageCostUsd(settings),
    });
    if (estimate > 0) budgetGuard(settings, estimate);
  }

  let text = existing?.text ?? "";
  let textModel = existing?.generation_meta?.model ?? "test-writer-v1";
  let textProvider = existing?.generation_meta?.provider ?? "test";
  let textDemo: boolean | null = existing?.text
    ? existing.generation_meta?.provider === "test"
    : null;
  let imagePath: string | null = existing?.image_path ?? null;
  let imageModel = existing?.generation_meta?.imageModel ?? "test-illustrator-v1";
  let imageProvider = existing?.generation_meta?.imageProvider ?? "test";
  let imageDemo: boolean | null = existing?.image_path
    ? existing.generation_meta?.imageProvider === "test"
    : null;
  let cost = 0;
  let costEstimated = false;

  if (mode.generateText) {
    const result = await generateTextWithAi(
      { communityId, system, user: textUser, seed, idea, postId: job.postId, jobId: job.id },
      settings,
    );
    text = result.text;
    textModel = result.model;
    textProvider = result.provider;
    textDemo = result.demo;
    cost += result.costUsd;
    costEstimated ||= result.costEstimated;
    if (result.warning) warnings.push(`⚠ ${result.warning}`);
    warnings.push(...validateCommunityText(communityId, text).map((v) => `${v.severity === "error" ? "⛔" : "⚠"} ${v.message}`));

    const previous = await loadRecentTexts(communityId, job.postId);
    let best = { id: "", score: 0 };
    for (const row of previous) {
      const score = similarity(text, row.text);
      if (score > best.score) best = { id: row.id, score };
    }
    if (best.score >= SIMILARITY_BLOCK_THRESHOLD) {
      throw new Error(`Текст слишком похож на предыдущую публикацию (${Math.round(best.score * 100)}%). Задание отправлено на повтор.`);
    }
  }

  if (mode.generateImage) {
    const references = reference.sendReferences ? await resolveReferences(context.characters) : [];
    if (reference.sendReferences && approvedReferenceCount > 0 && references.length === 0) {
      warnings.push("⚠ Не удалось получить URL одобренных референсов; изображение будет создано без них.");
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
    imageDemo = image.demo;
    cost += image.costUsd;
    costEstimated ||= image.costEstimated;
    if (image.note) warnings.push(`⚠ ${image.note}`);
  }

  const componentDemoStates = [textDemo, imageDemo].filter((value): value is boolean => value !== null);
  const demo = componentDemoStates.length === 0 || componentDemoStates.some(Boolean);
  if (job.postId) {
    const previousMeta = existing?.generation_meta;
    const meta: GenerationMeta = {
      provider: textProvider,
      model: textModel,
      imageProvider,
      imageModel,
      costUsd: Number(previousMeta?.costUsd ?? 0) + cost,
      ideaSource: preserveExisting && existing ? `${communityId}:${existing.topic}:preserved` : idea.key,
      warnings: [...(previousMeta?.warnings ?? []), ...warnings],
      providerLimitations: context.limitations,
      costEstimated: Boolean(previousMeta?.costEstimated) || costEstimated,
      demo,
      promptTemplateId: [textTemplate?.id, imageTemplate?.id].filter(Boolean).join(",") || undefined,
    };

    const similarityScore = mode.generateText && text
      ? await highestSimilarity(communityId, text, job.postId)
      : Number(existing?.similarity_score ?? 0);

    const { error } = await admin()
      .from("posts")
      .update({
        status: "review",
        title: preserveExisting ? existing?.title ?? title : title,
        text,
        image_path: imagePath,
        image_prompt: imagePrompt,
        topic: preserveExisting && existing ? existing.topic : topic,
        idea: preserveExisting && existing ? existing.idea : idea.angle,
        generation_meta: meta,
        similarity_score: similarityScore,
        similar_to: null,
        error_message: null,
        test_mode: demo,
        approved_hash: null,
        approved_at: null,
        approved_by: null,
      })
      .eq("id", job.postId);

    if (error) throw new ApiError(500, `Не удалось сохранить публикацию: ${error.message}`, "db");

    if (!preserveExisting || !existing || existing.topic !== topic) {
      const { error: topicError } = await admin().from("topics").insert({
        community_id: communityId,
        topic,
        idea_key: idea.key,
        post_id: job.postId,
      });
      if (topicError) warnings.push(`Не удалось записать историю темы: ${topicError.message}`);
    }

    const { error: notificationError } = await admin().from("notifications").insert({
      type: "review",
      title: "Публикация обновлена и ждёт проверки",
      message: `${COMMUNITY_META[communityId].shortName}: «${title}»`,
      link: `/posts/${job.postId}`,
    });
    if (notificationError) warnings.push(`Не удалось создать уведомление: ${notificationError.message}`);
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
