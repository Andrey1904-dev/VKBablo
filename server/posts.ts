import { all, get, run, setting } from "./db.ts";
import {
  contentHash,
  HttpError,
  moscowParts,
  moscowSlotIso,
  nid,
  nowIso,
  addDays,
} from "./lib.ts";
import { COMMUNITY_META, STYLE_RULES } from "../shared/constants.ts";
import type { CommunityId, Post, PostStatus, GenerationMeta } from "../shared/types.ts";
import { COMMUNITY_IDS, DEFAULT_SLOTS } from "../shared/types.ts";
import {
  assertBudget,
  getAdapter,
  generateIdea,
  generateText,
  logGeneration,
  ruleCheck,
} from "./ai.ts";
import { illustrationPrompt } from "./ai.ts";
import { findSimilar } from "./similarity.ts";
import { makeIllustration } from "./images.ts";
import { audit, notify } from "./notify.ts";
import { getVk, communityToken } from "./vk.ts";

interface PostRow {
  id: string;
  community_id: CommunityId;
  status: PostStatus;
  scheduled_at: string;
  published_at: string | null;
  title: string;
  text: string;
  image_path: string | null;
  image_prompt: string | null;
  topic: string;
  idea: string;
  vk_post_id: string | null;
  content_hash: string;
  approved_hash: string | null;
  approved_at: string | null;
  approved_by: number | null;
  error_message: string | null;
  generation_meta: string | null;
  similarity_score: number | null;
  similar_to: string | null;
  test_mode: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export function mapPost(r: PostRow): Post {
  return {
    id: r.id,
    communityId: r.community_id,
    status: r.status,
    scheduledAt: r.scheduled_at,
    publishedAt: r.published_at,
    title: r.title,
    text: r.text,
    imagePath: r.image_path,
    imagePrompt: r.image_prompt ?? "",
    topic: r.topic,
    idea: r.idea,
    vkPostId: r.vk_post_id,
    contentHash: r.content_hash,
    approvedHash: r.approved_hash,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    errorMessage: r.error_message,
    generationMeta: r.generation_meta ? (JSON.parse(r.generation_meta) as GenerationMeta) : null,
    similarityScore: r.similarity_score,
    similarTo: r.similar_to,
    testMode: !!r.test_mode,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getPost(id: string): Post {
  const r = get<PostRow>("SELECT * FROM posts WHERE id = ?", id);
  if (!r) throw new HttpError(404, "Публикация не найдена");
  return mapPost(r);
}

export function listPosts(filters: {
  communityId?: string;
  status?: string;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
}): Post[] {
  const where: string[] = ["1=1"];
  const params: unknown[] = [];
  if (filters.communityId) {
    where.push("community_id = ?");
    params.push(filters.communityId);
  }
  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  if (filters.from) {
    where.push("scheduled_at >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    where.push("scheduled_at <= ?");
    params.push(filters.to);
  }
  if (filters.q) {
    where.push("(text LIKE ? OR title LIKE ? OR topic LIKE ?)");
    const like = `%${filters.q}%`;
    params.push(like, like, like);
  }
  params.push(filters.limit ?? 200);
  const rows = all<PostRow>(
    `SELECT * FROM posts WHERE ${where.join(" AND ")} ORDER BY scheduled_at ASC LIMIT ?`,
    ...params,
  );
  return rows.map(mapPost);
}

function usedKeys(communityId: string): string[] {
  return all<{ topic: string }>(
    "SELECT topic FROM topics WHERE community_id = ?",
    communityId,
  ).map((t) => t.topic);
}

function saveVersion(post: Post, userId: number | null, reason: string) {
  run(
    `INSERT INTO post_versions (id, post_id, version, text, image_path, image_prompt, content_hash, created_at, created_by, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nid("ver"),
    post.id,
    post.version,
    post.text,
    post.imagePath,
    post.imagePrompt,
    post.contentHash,
    nowIso(),
    userId,
    reason,
  );
}

function refreshHash(id: string) {
  const p = getPost(id);
  const hash = contentHash({
    communityId: p.communityId,
    text: p.text,
    imagePath: p.imagePath,
    scheduledAt: p.scheduledAt,
  });
  run("UPDATE posts SET content_hash = ?, updated_at = ? WHERE id = ?", hash, nowIso(), id);
  return hash;
}

function resetApprovalIfNeeded(id: string, reason: string, userId: number | null) {
  const p = getPost(id);
  const nextHash = contentHash({
    communityId: p.communityId,
    text: p.text,
    imagePath: p.imagePath,
    scheduledAt: p.scheduledAt,
  });
  const material = ["approved", "scheduled"].includes(p.status);
  if (material && p.approvedHash && p.approvedHash !== nextHash) {
    run(
      `UPDATE posts SET status = 'review', approved_hash = NULL, approved_at = NULL, approved_by = NULL,
        vk_post_id = CASE WHEN status = 'scheduled' THEN NULL ELSE vk_post_id END,
        content_hash = ?, updated_at = ? WHERE id = ?`,
      nextHash,
      nowIso(),
      id,
    );
    audit({
      userId,
      action: "approval_reset",
      entityType: "post",
      entityId: id,
      details: { reason },
    });
    notify({
      type: "review",
      title: "Нужно новое одобрение",
      message: `Публикация «${p.title || p.topic}» изменена и снова на проверке.`,
      link: `/posts/${id}`,
    });
  } else {
    run("UPDATE posts SET content_hash = ?, updated_at = ? WHERE id = ?", nextHash, nowIso(), id);
  }
}

export async function generateForSlot(opts: {
  communityId: CommunityId;
  scheduledAt: string;
  userId?: number | null;
  force?: boolean;
}): Promise<Post> {
  const existing = get<PostRow>(
    "SELECT * FROM posts WHERE community_id = ? AND scheduled_at = ?",
    opts.communityId,
    opts.scheduledAt,
  );
  if (existing && !opts.force) return mapPost(existing);
  if (existing && ["approved", "scheduled", "published"].includes(existing.status) && !opts.force) {
    return mapPost(existing);
  }

  const id = existing?.id ?? nid("post");
  const testMode = setting("app_mode", "test") !== "approval" ? 1 : 0;
  const ts = nowIso();
  if (!existing) {
    run(
      `INSERT INTO posts (
        id, community_id, status, scheduled_at, published_at, title, text, image_path, image_prompt,
        topic, idea, vk_post_id, content_hash, approved_hash, approved_at, approved_by, error_message,
        generation_meta, similarity_score, similar_to, test_mode, version, created_at, updated_at
      ) VALUES (?, ?, 'generating', ?, NULL, '', '', NULL, '', '', '', NULL, '', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 1, ?, ?)`,
      id,
      opts.communityId,
      opts.scheduledAt,
      testMode,
      ts,
      ts,
    );
  } else {
    run("UPDATE posts SET status = 'generating', error_message = NULL, updated_at = ? WHERE id = ?", ts, id);
  }

  try {
    assertBudget(0.05);
    const adapter = await getAdapter();
    const idea = generateIdea(opts.communityId, usedKeys(opts.communityId), id);
    const rules = STYLE_RULES[opts.communityId];
    const metaC = COMMUNITY_META[opts.communityId];
    const system = [
      `Ты автор постов для сообщества ВКонтакте «${metaC.name}».`,
      rules.voice,
      rules.hook,
      rules.language,
      `Обязательно: ${rules.mustInclude.join(", ")}.`,
      `Запрещено: ${rules.mustAvoid.join(", ")}.`,
      rules.ending,
      ...rules.notes,
      "Пиши только текст поста на русском, без заголовка и без хештегов-простыней.",
    ].join("\n");
    const user = `Тема: ${idea.topic}\nУгол: ${idea.angle}\nСерия: ${idea.series ?? "нет"}`;
    const textRes = await adapter.generateText({
      communityId: opts.communityId,
      system,
      user,
      seed: id,
      idea,
    });
    const warnings = ruleCheck(opts.communityId, textRes.text);
    const sim = findSimilar(opts.communityId, textRes.text, id);
    if (sim && sim.score >= 0.7) {
      throw new Error(`Слишком похоже на существующую публикацию (${Math.round(sim.score * 100)}%)`);
    }
    const imgPrompt = illustrationPrompt(opts.communityId, idea.topic, idea.title);
    const img = await adapter.generateImage({
      communityId: opts.communityId,
      prompt: imgPrompt,
      seed: id,
      title: idea.title,
      topic: idea.topic,
    });
    if (img.note) warnings.push(img.note);
    const genMeta: GenerationMeta = {
      provider: adapter.id,
      model: textRes.model,
      imageProvider: adapter.id,
      imageModel: img.model,
      costUsd: textRes.costUsd + img.costUsd,
      ideaSource: idea.key,
      warnings,
    };
    run(
      `UPDATE posts SET status = 'review', title = ?, text = ?, image_path = ?, image_prompt = ?,
        topic = ?, idea = ?, generation_meta = ?, similarity_score = ?, similar_to = ?,
        test_mode = ?, error_message = NULL, updated_at = ? WHERE id = ?`,
      idea.title,
      textRes.text,
      img.path,
      img.prompt ?? imgPrompt,
      idea.topic,
      idea.angle,
      JSON.stringify(genMeta),
      sim?.score ?? null,
      sim?.id ?? null,
      testMode,
      nowIso(),
      id,
    );
    run(
      "INSERT INTO topics (id, community_id, topic, post_id, created_at) VALUES (?, ?, ?, ?, ?)",
      nid("top"),
      opts.communityId,
      idea.key,
      id,
      nowIso(),
    );
    logGeneration({
      communityId: opts.communityId,
      type: "full",
      provider: adapter.id,
      model: textRes.model,
      prompt: user,
      result: textRes.text,
      costUsd: genMeta.costUsd,
      status: "done",
    });
    const hash = refreshHash(id);
    const post = getPost(id);
    saveVersion(post, opts.userId ?? null, "generation");
    notify({
      type: "review",
      title: "Новый пост на проверке",
      message: `${metaC.shortName}: «${idea.title}» к ${moscowParts(opts.scheduledAt).dateStr} ${moscowParts(opts.scheduledAt).timeStr}`,
      link: `/posts/${id}`,
    });
    audit({
      userId: opts.userId,
      action: "generate",
      entityType: "post",
      entityId: id,
      details: { hash },
    });
    return getPost(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    run(
      "UPDATE posts SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?",
      msg,
      nowIso(),
      id,
    );
    logGeneration({
      communityId: opts.communityId,
      type: "full",
      provider: setting("ai_provider", "test"),
      model: setting("ai_text_model", ""),
      prompt: "",
      result: "",
      costUsd: 0,
      status: "error",
      error: msg,
    });
    notify({
      type: "generation_error",
      title: "Ошибка генерации",
      message: `${COMMUNITY_META[opts.communityId].shortName}: ${msg}`,
      link: `/posts/${id}`,
    });
    throw e;
  }
}

export function updatePost(
  id: string,
  patch: Partial<{
    text: string;
    title: string;
    imagePath: string | null;
    imagePrompt: string;
    scheduledAt: string;
    communityId: CommunityId;
  }>,
  userId: number | null,
): Post {
  const p = getPost(id);
  if (p.status === "published") throw new HttpError(400, "Опубликованный пост нельзя изменить");
  if (patch.scheduledAt && patch.scheduledAt !== p.scheduledAt) {
    const clash = get<{ id: string }>(
      "SELECT id FROM posts WHERE community_id = ? AND scheduled_at = ? AND id != ?",
      patch.communityId ?? p.communityId,
      patch.scheduledAt,
      id,
    );
    if (clash) throw new HttpError(409, "На это время в сообществе уже есть публикация");
  }
  saveVersion(p, userId, "edit");
  const text = patch.text ?? p.text;
  const title = patch.title ?? p.title;
  const imagePath = patch.imagePath === undefined ? p.imagePath : patch.imagePath;
  const imagePrompt = patch.imagePrompt ?? p.imagePrompt;
  const scheduledAt = patch.scheduledAt ?? p.scheduledAt;
  const communityId = patch.communityId ?? p.communityId;
  run(
    `UPDATE posts SET text = ?, title = ?, image_path = ?, image_prompt = ?, scheduled_at = ?, community_id = ?,
      version = version + 1, updated_at = ? WHERE id = ?`,
    text,
    title,
    imagePath,
    imagePrompt,
    scheduledAt,
    communityId,
    nowIso(),
    id,
  );
  resetApprovalIfNeeded(id, "edit", userId);
  audit({ userId, action: "edit", entityType: "post", entityId: id });
  return getPost(id);
}

export function approvePost(id: string, userId: number, comment = ""): Post {
  const p = getPost(id);
  if (!["review", "needs_revision", "draft", "approved"].includes(p.status)) {
    throw new HttpError(400, "Эту публикацию нельзя одобрить в текущем статусе");
  }
  if (!p.text.trim()) throw new HttpError(400, "Пустой текст нельзя одобрить");
  if (!p.imagePath) throw new HttpError(400, "Нужно изображение");
  const hash = contentHash({
    communityId: p.communityId,
    text: p.text,
    imagePath: p.imagePath,
    scheduledAt: p.scheduledAt,
  });
  run(
    `UPDATE posts SET status = 'approved', approved_hash = ?, approved_at = ?, approved_by = ?,
      content_hash = ?, error_message = NULL, updated_at = ? WHERE id = ?`,
    hash,
    nowIso(),
    userId,
    hash,
    nowIso(),
    id,
  );
  run(
    `INSERT INTO approvals (id, post_id, version_hash, action, comment, user_id, created_at)
     VALUES (?, ?, ?, 'approve', ?, ?, ?)`,
    nid("ap"),
    id,
    hash,
    comment,
    userId,
    nowIso(),
  );
  audit({ userId, action: "approve", entityType: "post", entityId: id, details: { hash } });
  return getPost(id);
}

export function rejectPost(id: string, userId: number, comment: string): Post {
  const p = getPost(id);
  if (p.status === "published") throw new HttpError(400, "Опубликованное нельзя отклонить");
  run(
    `UPDATE posts SET status = 'rejected', approved_hash = NULL, updated_at = ? WHERE id = ?`,
    nowIso(),
    id,
  );
  run(
    `INSERT INTO approvals (id, post_id, version_hash, action, comment, user_id, created_at)
     VALUES (?, ?, ?, 'reject', ?, ?, ?)`,
    nid("ap"),
    id,
    p.contentHash,
    comment,
    userId,
    nowIso(),
  );
  audit({ userId, action: "reject", entityType: "post", entityId: id });
  return getPost(id);
}

export function requestRevision(id: string, userId: number, comment: string, what: "text" | "image" | "all"): Post {
  run(
    `UPDATE posts SET status = 'needs_revision', error_message = ?, updated_at = ? WHERE id = ?`,
    `Доработка (${what}): ${comment}`,
    nowIso(),
    id,
  );
  run(
    `INSERT INTO approvals (id, post_id, version_hash, action, comment, user_id, created_at)
     VALUES (?, ?, ?, 'revise', ?, ?, ?)`,
    nid("ap"),
    id,
    getPost(id).contentHash,
    `${what}: ${comment}`,
    userId,
    nowIso(),
  );
  audit({ userId, action: "revise", entityType: "post", entityId: id, details: { what, comment } });
  return getPost(id);
}

export async function regenerate(id: string, what: "text" | "image" | "all", userId: number | null): Promise<Post> {
  const p = getPost(id);
  if (p.status === "published" || p.status === "scheduled") {
    throw new HttpError(400, "Сначала снимите с публикации / запланирования");
  }
  saveVersion(p, userId, `regenerate:${what}`);
  run("UPDATE posts SET status = 'generating', updated_at = ? WHERE id = ?", nowIso(), id);
  try {
    const adapter = await getAdapter();
    let text = p.text;
    let imagePath = p.imagePath;
    let imagePrompt = p.imagePrompt;
    let cost = 0;
    if (what === "text" || what === "all") {
      const idea = { key: p.topic, topic: p.topic, title: p.title, angle: p.idea };
      const res = await adapter.generateText({
        communityId: p.communityId,
        system: STYLE_RULES[p.communityId].voice,
        user: `Переделай пост. Тема: ${p.topic}. Указание: сохранить смысл, сделать иначе.\nБыло:\n${p.text}`,
        seed: nid("r"),
        idea,
      });
      text = res.text;
      cost += res.costUsd;
    }
    if (what === "image" || what === "all") {
      const prompt = illustrationPrompt(p.communityId, p.topic, p.title);
      const img = await adapter.generateImage({
        communityId: p.communityId,
        prompt,
        seed: nid("r"),
        title: p.title,
        topic: p.topic,
      });
      imagePath = img.path;
      imagePrompt = prompt;
      cost += img.costUsd;
    }
    run(
      `UPDATE posts SET text = ?, image_path = ?, image_prompt = ?, status = 'review',
        version = version + 1, approved_hash = NULL, approved_at = NULL, approved_by = NULL,
        error_message = NULL, updated_at = ? WHERE id = ?`,
      text,
      imagePath,
      imagePrompt,
      nowIso(),
      id,
    );
    logGeneration({
      communityId: p.communityId,
      type: `regen_${what}`,
      provider: adapter.id,
      model: "",
      prompt: what,
      result: text.slice(0, 500),
      costUsd: cost,
      status: "done",
    });
    refreshHash(id);
    return getPost(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    run("UPDATE posts SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?", msg, nowIso(), id);
    throw e;
  }
}

/** Backend gate: publishing without matching approval hash is impossible. */
export function assertApprovedVersion(post: Post) {
  if (!post.approvedHash) {
    throw new HttpError(403, "Публикация без одобрения невозможна");
  }
  const hash = contentHash({
    communityId: post.communityId,
    text: post.text,
    imagePath: post.imagePath,
    scheduledAt: post.scheduledAt,
  });
  if (hash !== post.approvedHash) {
    throw new HttpError(403, "Одобрение не соответствует текущей версии контента");
  }
  if (!["approved", "scheduled"].includes(post.status)) {
    throw new HttpError(403, "Статус не позволяет отправку в VK");
  }
}

export async function scheduleToVk(id: string, userId: number | null): Promise<Post> {
  const p = getPost(id);
  assertApprovedVersion(p);
  const unix = Math.floor(new Date(p.scheduledAt).getTime() / 1000);
  if (unix < Math.floor(Date.now() / 1000) + 60) {
    throw new HttpError(400, "Время публикации уже прошло или слишком близко");
  }
  const mode = setting("app_mode", "test");
  const vk = getVk();
  try {
    let postId = p.vkPostId;
    if (mode === "approval" && !vk.testMode) {
      const token = communityToken(p.communityId);
      const group = get<{ vk_group_id: string | null }>(
        "SELECT vk_group_id FROM communities WHERE id = ?",
        p.communityId,
      );
      if (!token || !group?.vk_group_id) {
        throw new HttpError(400, "Сообщество не подключено к VK. Добавьте токен в настройках.");
      }
      const r = await vk.uploadAndSchedule({
        communityId: p.communityId,
        groupId: group.vk_group_id,
        token,
        text: p.text,
        imagePath: p.imagePath,
        publishAtUnix: unix,
      });
      postId = r.postId;
    } else {
      const r = await vk.uploadAndSchedule({
        communityId: p.communityId,
        groupId: "test",
        token: "test",
        text: p.text,
        imagePath: p.imagePath,
        publishAtUnix: unix,
      });
      postId = r.postId;
    }
    run(
      `UPDATE posts SET status = 'scheduled', vk_post_id = ?, error_message = NULL, updated_at = ? WHERE id = ?`,
      postId,
      nowIso(),
      id,
    );
    notify({
      type: "scheduled",
      title: "Пост запланирован",
      message: `${COMMUNITY_META[p.communityId].shortName}: ${p.title}`,
      link: `/posts/${id}`,
    });
    audit({ userId, action: "schedule", entityType: "post", entityId: id, details: { postId, mode } });
    return getPost(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    run("UPDATE posts SET status = 'error', error_message = ?, updated_at = ? WHERE id = ?", msg, nowIso(), id);
    notify({
      type: "publish_error",
      title: "Ошибка планирования в VK",
      message: msg,
      link: `/posts/${id}`,
    });
    throw e;
  }
}

export function markPublishedIfDue() {
  const due = all<PostRow>(
    "SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?",
    nowIso(),
  );
  for (const r of due) {
    run(
      "UPDATE posts SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?",
      nowIso(),
      nowIso(),
      r.id,
    );
    notify({
      type: "published",
      title: "Пост опубликован",
      message: `${COMMUNITY_META[r.community_id].shortName}: ${r.title}`,
      link: `/posts/${r.id}`,
    });
  }
}

export function upcomingSlots(hoursAhead: number): Array<{ communityId: CommunityId; scheduledAt: string }> {
  const hours = hoursAhead;
  const start = moscowParts(new Date());
  const days = Math.max(2, Math.ceil(hours / 24) + 1);
  const result: Array<{ communityId: CommunityId; scheduledAt: string }> = [];
  const now = Date.now();
  const horizon = now + hours * 3600 * 1000;
  for (let i = 0; i <= days; i++) {
    const dateStr = addDays(start.dateStr, i);
    for (const cid of COMMUNITY_IDS) {
      const comm = get<{ schedule: string; status: string }>(
        "SELECT schedule, status FROM communities WHERE id = ?",
        cid,
      );
      if (!comm || comm.status !== "active") continue;
      const slots = JSON.parse(comm.schedule) as string[];
      for (const t of slots.length ? slots : DEFAULT_SLOTS) {
        const iso = moscowSlotIso(dateStr, t);
        const ts = new Date(iso).getTime();
        if (ts > now && ts <= horizon) result.push({ communityId: cid, scheduledAt: iso });
      }
    }
  }
  return result;
}

export function createManualPost(input: {
  communityId: CommunityId;
  scheduledAt: string;
  text?: string;
  title?: string;
  userId: number | null;
}): Post {
  const clash = get("SELECT id FROM posts WHERE community_id = ? AND scheduled_at = ?", input.communityId, input.scheduledAt);
  if (clash) throw new HttpError(409, "Слот занят");
  const id = nid("post");
  const ts = nowIso();
  run(
    `INSERT INTO posts (
      id, community_id, status, scheduled_at, published_at, title, text, image_path, image_prompt,
      topic, idea, vk_post_id, content_hash, test_mode, version, created_at, updated_at
    ) VALUES (?, ?, 'draft', ?, NULL, ?, ?, NULL, '', ?, '', NULL, '', ?, 1, ?, ?)`,
    id,
    input.communityId,
    input.scheduledAt,
    input.title || "Черновик",
    input.text || "",
    input.title || "Черновик",
    setting("app_mode", "test") !== "approval" ? 1 : 0,
    ts,
    ts,
  );
  refreshHash(id);
  audit({ userId: input.userId, action: "create_draft", entityType: "post", entityId: id });
  return getPost(id);
}

export function missedSlots(): Array<{ communityId: CommunityId; scheduledAt: string }> {
  const start = moscowParts(new Date());
  const missed: Array<{ communityId: CommunityId; scheduledAt: string }> = [];
  for (let i = -2; i <= 0; i++) {
    const dateStr = addDays(start.dateStr, i);
    for (const cid of COMMUNITY_IDS) {
      const comm = get<{ schedule: string }>("SELECT schedule FROM communities WHERE id = ?", cid);
      const slots = comm ? (JSON.parse(comm.schedule) as string[]) : [...DEFAULT_SLOTS];
      for (const t of slots) {
        const iso = moscowSlotIso(dateStr, t);
        if (new Date(iso).getTime() >= Date.now()) continue;
        const row = get("SELECT id FROM posts WHERE community_id = ? AND scheduled_at = ? AND status IN ('scheduled','published','approved','review','generating')", cid, iso);
        if (!row) missed.push({ communityId: cid, scheduledAt: iso });
      }
    }
  }
  return missed;
}

export { makeIllustration };
