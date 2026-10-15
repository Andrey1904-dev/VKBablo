import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AuthUser } from "./auth.ts";
import {
  createFirstOwner,
  currentUser,
  login,
  logout,
  rateLimitLogin,
  requireUser,
  userCount,
} from "./auth.ts";
import { all, get, run, setSetting, setting, withImmediateTransaction } from "./db.ts";
import { env, supabasePublic } from "./env.ts";
import { HttpError, moscowParts, nid, nowIso, requireParam } from "./lib.ts";
import { audit, listNotifications, markRead, unreadCount } from "./notify.ts";
import {
  approvePost,
  createManualPost,
  generateForSlot,
  getPost,
  listPosts,
  missedSlots,
  regenerate,
  rejectPost,
  requestRevision,
  scheduleToVk,
  unscheduleLocalPost,
  updatePost,
  upcomingSlots,
} from "./posts.ts";
import { enqueueUpcomingGeneration, listJobs, processOnce } from "./queue.ts";
import { monthSpendUsd, getAdapter, getAiKey, saveAiKey, generateIdea, logGeneration } from "./ai.ts";
import { communityToken, saveCommunityToken } from "./vk.ts";
import { putMedia, readLocalUpload, signedUrl } from "./storage.ts";
import { APP_LIMITS, COMMUNITY_META } from "../shared/constants.ts";
import { COMMUNITY_IDS, type CommunityId, type PostStatus } from "../shared/types.ts";
import { resolveImageMime } from "../shared/image-format.ts";
import { hashPassword, verifyPassword } from "./lib.ts";

type Vars = { Variables: { user: AuthUser } };

export function createApp() {
  const app = new Hono<Vars>();

  app.onError((err, c) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500 && status !== 501) console.error(err);
    return c.json({ error: err.message || "Внутренняя ошибка" }, status as ContentfulStatusCode);
  });

  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    const host = c.req.header("host") || "";
    if (origin && ["POST", "PATCH", "PUT", "DELETE"].includes(c.req.method) && !originAllowed(origin, host)) {
      return c.json({ error: "Запрос с чужого origin отклонён" }, 403);
    }
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
    try {
      await next();
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : "Внутренняя ошибка";
      if (status >= 500 && status !== 501) console.error(e);
      return c.json({ error: message }, status as ContentfulStatusCode);
    }
  });

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      time: nowIso(),
      moscow: moscowParts(),
      mode: setting("app_mode", "test"),
      supabase: supabasePublic(),
    }),
  );

  app.get("/uploads/:file", (c) => {
    const file = requireParam(c, "file");
    const found = readLocalUpload(file);
    if (!found) return c.notFound();
    return new Response(found.bytes, {
      headers: { "Content-Type": found.mime, "Cache-Control": "public, max-age=86400" },
    });
  });

  app.get("/api/auth/status", (c) =>
    c.json({
      setupComplete: userCount() > 0 || setting("setup_complete") === "1",
      user: currentUser(c),
      supabase: supabasePublic(),
    }),
  );

  app.post("/api/auth/setup", async (c) => {
    if (userCount() > 0) throw new HttpError(400, "Владелец уже создан");
    const body = await c.req.json();
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    const name = String(body.name || "Владелец").trim();
    if (!email.includes("@")) throw new HttpError(400, "Укажите корректный email");
    const user = createFirstOwner(email, password, name);
    login(email, password, c);
    audit({ userId: user.id, action: "setup", entityType: "user", entityId: String(user.id) });
    return c.json({ user });
  });

  app.post("/api/auth/login", async (c) => {
    const ip = c.req.header("x-forwarded-for") || "local";
    rateLimitLogin(ip);
    const body = await c.req.json();
    const user = login(String(body.email || ""), String(body.password || ""), c);
    audit({ userId: user.id, action: "login", ip });
    return c.json({ user });
  });

  app.post("/api/auth/logout", (c) => {
    logout(c);
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", requireUser, (c) => c.json({ user: c.get("user"), supabase: supabasePublic() }));

  app.post("/api/auth/password", requireUser, async (c) => {
    const user = c.get("user");
    const body = await c.req.json();
    const row = get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", user.id);
    if (!row || !verifyPassword(String(body.current || ""), row.password_hash)) {
      throw new HttpError(400, "Текущий пароль неверен");
    }
    run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(String(body.next || "")), user.id);
    audit({ userId: user.id, action: "password_change" });
    return c.json({ ok: true });
  });

  app.get("/api/dashboard", requireUser, (c) => {
    const counts = all<{ status: string; c: number }>("SELECT status, COUNT(*) AS c FROM posts GROUP BY status");
    const map = Object.fromEntries(counts.map((x) => [x.status, Number(x.c)]));
    const missed = missedSlots();
    const byCommunity = COMMUNITY_IDS.map((id) => {
      const rows = all<{ status: string; c: number }>(
        "SELECT status, COUNT(*) AS c FROM posts WHERE community_id = ? GROUP BY status",
        id,
      );
      const m = Object.fromEntries(rows.map((x) => [x.status, Number(x.c)]));
      return {
        id,
        name: COMMUNITY_META[id].name,
        color: COMMUNITY_META[id].color,
        pending: Number(m.review || 0) + Number(m.needs_revision || 0),
        scheduled: Number(m.scheduled || 0) + Number(m.approved || 0),
        published: Number(m.published || 0),
        errors: Number(m.error || 0),
      };
    });
    return c.json({
      ready: Number(map.approved || 0),
      pendingReview: Number(map.review || 0) + Number(map.needs_revision || 0) + Number(map.generating || 0),
      scheduled: Number(map.scheduled || 0),
      published: Number(map.published || 0),
      errors: Number(map.error || 0),
      missedSlots: missed.length,
      automationPaused: setting("automation_paused", "0") === "1",
      mode: setting("app_mode", "test"),
      nextPosts: listPosts({ from: nowIso(), limit: 8 }),
      byCommunity,
      spendUsdMonth: monthSpendUsd(),
      spendLimitUsd: Number(setting("ai_monthly_limit_usd", "20")),
      unread: unreadCount(),
      moscow: moscowParts(),
      supabase: supabasePublic(),
    });
  });

  app.get("/api/communities", requireUser, () => {
    const rows = all<Record<string, unknown>>("SELECT * FROM communities ORDER BY name");
    return Response.json({ communities: rows.map(mapCommunity) });
  });

  app.get("/api/communities/:id", requireUser, async (c) => {
    const id = requireParam(c, "id");
    const row = get<Record<string, unknown>>("SELECT * FROM communities WHERE id = ?", id);
    if (!row) throw new HttpError(404, "Сообщество не найдено");
    const characters = await Promise.all(all<Record<string, unknown>>(
      "SELECT * FROM characters WHERE community_id = ?",
      id,
    ).map(mapCharacter));
    const stats = all<{ status: string; c: number }>(
      "SELECT status, COUNT(*) AS c FROM posts WHERE community_id = ? GROUP BY status",
      id,
    );
    return c.json({ community: mapCommunity(row), characters, stats });
  });

  app.patch("/api/communities/:id", requireUser, async (c) => {
    const id = requireParam(c, "id");
    const body = await c.req.json();
    const row = get("SELECT id FROM communities WHERE id = ?", id);
    if (!row) throw new HttpError(404, "Сообщество не найдено");
    if (body.schedule) {
      const slots = body.schedule as string[];
      if (!Array.isArray(slots) || !slots.every((s) => /^\d{2}:\d{2}$/.test(s))) {
        throw new HttpError(400, "Слоты должны быть в формате ЧЧ:ММ");
      }
      run("UPDATE communities SET schedule = ? WHERE id = ?", JSON.stringify(slots), id);
    }
    if (body.generationSettings) {
      run("UPDATE communities SET generation_settings = ? WHERE id = ?", JSON.stringify(body.generationSettings), id);
    }
    if (body.status === "active" || body.status === "paused") {
      run("UPDATE communities SET status = ? WHERE id = ?", body.status, id);
    }
    if (typeof body.vkGroupId === "string") {
      run("UPDATE communities SET vk_group_id = ? WHERE id = ?", body.vkGroupId, id);
    }
    if (typeof body.vkScreenName === "string") {
      run("UPDATE communities SET vk_screen_name = ? WHERE id = ?", body.vkScreenName, id);
    }
    audit({ userId: c.get("user").id, action: "community_update", entityType: "community", entityId: id });
    const next = get<Record<string, unknown>>("SELECT * FROM communities WHERE id = ?", id)!;
    return c.json({ community: mapCommunity(next) });
  });

  app.post("/api/communities/:id/vk", requireUser, async (c) => {
    const id = requireParam(c, "id") as CommunityId;
    const body = await c.req.json();
    const token = String(body.token || "").trim();
    if (!token) {
      saveCommunityToken(id, null);
      return c.json({ connected: false });
    }
    // Local mode is deliberately offline: do not accept or persist real VK credentials
    // behind a mock "connected" response. Use the protected Supabase Edge adapter instead.
    throw new HttpError(501, "Локальный backend не подключается к VK и не сохраняет токены. Подключите Supabase.");
  });

  app.get("/api/posts", requireUser, (c) => {
    const q = c.req.query();
    const posts = listPosts({
      communityId: q.communityId,
      status: q.status,
      from: q.from,
      to: q.to,
      q: q.q,
      limit: q.limit ? Number(q.limit) : 200,
    });
    return c.json({ posts });
  });

  app.post("/api/posts", requireUser, async (c) => {
    const body = await c.req.json();
    const post = createManualPost({
      communityId: body.communityId,
      scheduledAt: body.scheduledAt,
      text: body.text,
      title: body.title,
      userId: c.get("user").id,
    });
    return c.json({ post }, 201);
  });

  app.get("/api/posts/:id", requireUser, async (c) => {
    const post = getPost(requireParam(c, "id"));
    const versions = all(
      "SELECT * FROM post_versions WHERE post_id = ? ORDER BY version DESC LIMIT 30",
      post.id,
    );
    const approvals = all(
      "SELECT * FROM approvals WHERE post_id = ? ORDER BY created_at DESC LIMIT 30",
      post.id,
    );
    const imageUrl = post.imagePath ? await signedUrl(post.imagePath) : null;
    return c.json({ post, versions, approvals, imageUrl });
  });

  app.patch("/api/posts/:id", requireUser, async (c) => {
    const body = await c.req.json();
    const post = updatePost(requireParam(c, "id"), body, c.get("user").id);
    return c.json({ post });
  });

  app.post("/api/posts/:id/approve", requireUser, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const post = approvePost(requireParam(c, "id"), c.get("user").id, String(body.comment || ""));
    return c.json({ post });
  });

  app.post("/api/posts/:id/reject", requireUser, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const post = rejectPost(requireParam(c, "id"), c.get("user").id, String(body.comment || "Отклонено"));
    return c.json({ post });
  });

  app.post("/api/posts/:id/revise", requireUser, async (c) => {
    const body = await c.req.json();
    const what = body.what === "text" || body.what === "image" ? body.what : "all";
    const post = requestRevision(requireParam(c, "id"), c.get("user").id, String(body.comment || ""), what);
    return c.json({ post });
  });

  app.post("/api/posts/:id/regenerate", requireUser, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const what = body.what === "text" || body.what === "image" ? body.what : "all";
    const post = await regenerate(requireParam(c, "id"), what, c.get("user").id);
    return c.json({ post });
  });

  app.post("/api/posts/:id/schedule", requireUser, async (c) => {
    if (setting("automation_paused", "0") === "1") {
      throw new HttpError(423, "Автоматизация на паузе. Снимите паузу, чтобы планировать публикации.");
    }
    const post = await scheduleToVk(requireParam(c, "id"), c.get("user").id);
    return c.json({ post, dryRun: setting("app_mode", "test") !== "approval" });
  });

  app.post("/api/posts/:id/unschedule", requireUser, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const post = unscheduleLocalPost(
      requireParam(c, "id"),
      c.get("user").id,
      String(body.reason || "отменено владельцем").slice(0, 300),
    );
    return c.json({ post, status: post.status, dryRun: true });
  });

  app.post("/api/posts/:id/generate", requireUser, async (c) => {
    const existing = getPost(requireParam(c, "id"));
    const post = await generateForSlot({
      communityId: existing.communityId,
      scheduledAt: existing.scheduledAt,
      userId: c.get("user").id,
      force: true,
    });
    return c.json({ post });
  });

  app.get("/api/calendar", requireUser, (c) => {
    const from = c.req.query("from") || nowIso();
    const to = c.req.query("to");
    const posts = listPosts({ from, to, limit: 500 });
    const hours = Number(setting("prepare_hours_ahead", "24"));
    const expected = upcomingSlots(Math.max(hours, 24 * 14));
    return c.json({ posts, expected, missed: missedSlots(), timezone: "Europe/Moscow" });
  });

  app.post("/api/ai/ideas", requireUser, async (c) => {
    const body = await c.req.json();
    const communityId = body.communityId as CommunityId;
    if (!COMMUNITY_IDS.includes(communityId)) throw new HttpError(400, "Неизвестное сообщество");
    const used = all<{ topic: string }>("SELECT topic FROM topics WHERE community_id = ?", communityId).map(
      (t) => t.topic,
    );
    const ideas = Array.from({ length: 6 }, (_, i) => generateIdea(communityId, used, nid("idea") + i));
    return c.json({ ideas });
  });

  app.post("/api/ai/generate-slot", requireUser, async (c) => {
    const body = await c.req.json();
    const post = await generateForSlot({
      communityId: body.communityId,
      scheduledAt: body.scheduledAt,
      userId: c.get("user").id,
      force: Boolean(body.force),
      kind: ["full_post", "text", "image", "idea", "preview"].includes(body.kind) ? body.kind : "full_post",
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
    });
    return c.json({ post });
  });

  app.get("/api/ai/history", requireUser, (c) => {
    const rows = all("SELECT * FROM ai_generations ORDER BY created_at DESC LIMIT 80");
    return c.json({ generations: rows });
  });

  app.get("/api/ai/providers", requireUser, async (c) => {
    const adapter = await getAdapter();
    return c.json({
      active: adapter.id,
      label: adapter.label,
      supportsReferences: adapter.supportsReferences,
      configuredKey: Boolean(getAiKey()),
      models: {
        text: setting("ai_text_model", "test-writer-v1"),
        image: setting("ai_image_model", "test-illustrator-v1"),
      },
    });
  });

  app.post("/api/automation/prepare", requireUser, (c) => {
    if (setting("automation_paused", "0") === "1") throw new HttpError(423, "Автоматизация на паузе");
    const ids = enqueueUpcomingGeneration();
    return c.json({ queued: ids.length, ids });
  });

  app.post("/api/automation/pause", requireUser, (c) => {
    setSetting("automation_paused", "1");
    audit({ userId: c.get("user").id, action: "automation_pause" });
    return c.json({ automationPaused: true });
  });

  app.post("/api/automation/resume", requireUser, (c) => {
    setSetting("automation_paused", "0");
    audit({ userId: c.get("user").id, action: "automation_resume" });
    return c.json({ automationPaused: false });
  });

  app.post("/api/automation/tick", requireUser, async (c) => {
    await processOnce();
    return c.json({ ok: true, jobs: listJobs(20) });
  });

  app.get("/api/jobs", requireUser, (c) => c.json({ jobs: listJobs(80) }));

  app.get("/api/characters", requireUser, async (c) => {
    const communityId = c.req.query("communityId");
    const rows = communityId
      ? all<Record<string, unknown>>("SELECT * FROM characters WHERE community_id = ?", communityId)
      : all<Record<string, unknown>>("SELECT * FROM characters");
    return c.json({ characters: await Promise.all(rows.map(mapCharacter)) });
  });

  app.patch("/api/characters/:id", requireUser, async (c) => {
    const id = requireParam(c, "id");
    const ch = get<{ locked: number; appearance: string }>("SELECT locked, appearance FROM characters WHERE id = ?", id);
    if (!ch) throw new HttpError(404, "Персонаж не найден");
    const body = await c.req.json();
    if (body.appearance && ch.locked) {
      throw new HttpError(403, "Внешность заблокирована. Снимите замок явно, чтобы изменить.");
    }
    if (typeof body.locked === "boolean") {
      run("UPDATE characters SET locked = ?, updated_at = ? WHERE id = ?", body.locked ? 1 : 0, nowIso(), id);
    }
    if (body.description) run("UPDATE characters SET description = ?, updated_at = ? WHERE id = ?", body.description, nowIso(), id);
    if (body.personality) run("UPDATE characters SET personality = ?, updated_at = ? WHERE id = ?", body.personality, nowIso(), id);
    audit({ userId: c.get("user").id, action: "character_update", entityType: "character", entityId: id });
    const row = get<Record<string, unknown>>("SELECT * FROM characters WHERE id = ?", id)!;
    return c.json({ character: await mapCharacter(row) });
  });

  app.post("/api/characters/:id/references", requireUser, async (c) => {
    const id = requireParam(c, "id");
    const ch = get("SELECT id FROM characters WHERE id = ?", id);
    if (!ch) throw new HttpError(404, "Персонаж не найден");
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw new HttpError(400, "Прикрепите файл");
    if (file.size <= 0) throw new HttpError(400, "Файл пуст");
    if (file.size > APP_LIMITS.maxUploadBytes) throw new HttpError(413, "Файл больше 12 МБ");
    const buf = Buffer.from(await file.arrayBuffer());
    let mime: string;
    try {
      mime = resolveImageMime(file.type, buf);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "Формат изображения не распознан");
    }
    const stored = await putMedia({
      folder: "characters",
      bytes: buf,
      mime,
    });
    const refId = nid("ref");
    run(
      `INSERT INTO character_references (id, character_id, file_path, approved, notes, created_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
      refId,
      id,
      stored.path,
      String(body.notes || ""),
      nowIso(),
    );
    return c.json({ id: refId, path: stored.path, url: await signedUrl(stored.path) });
  });

  app.post("/api/characters/references/:id/approve", requireUser, (c) => {
    const referenceId = requireParam(c, "id");
    const reference = get<{ id: string; character_id: string; is_primary: number }>(
      "SELECT id, character_id, is_primary FROM character_references WHERE id = ?",
      referenceId,
    );
    if (!reference) throw new HttpError(404, "Референс не найден");
    withImmediateTransaction(() => {
      run("UPDATE character_references SET approved = 1 WHERE id = ?", referenceId);
      const primary = get<{ id: string }>(
        "SELECT id FROM character_references WHERE character_id = ? AND is_primary = 1 AND approved = 1",
        reference.character_id,
      );
      if (!primary) {
        run("UPDATE character_references SET is_primary = 1 WHERE id = ? AND approved = 1", referenceId);
        run(
          "UPDATE characters SET primary_reference_id = ?, appearance_status = 'approved', updated_at = ? WHERE id = ?",
          referenceId,
          nowIso(),
          reference.character_id,
        );
      }
    });
    audit({ userId: c.get("user").id, action: "character_reference_approve", entityType: "character", entityId: reference.character_id, details: { referenceId } });
    return c.json({ ok: true });
  });

  app.post("/api/characters/references/:id/primary", requireUser, (c) => {
    const referenceId = requireParam(c, "id");
    const reference = get<{ id: string; character_id: string; approved: number }>(
      "SELECT id, character_id, approved FROM character_references WHERE id = ?",
      referenceId,
    );
    if (!reference) throw new HttpError(404, "Референс не найден");
    if (!reference.approved) throw new HttpError(400, "Основным можно сделать только одобренный референс");
    withImmediateTransaction(() => {
      run("UPDATE character_references SET is_primary = 0 WHERE character_id = ?", reference.character_id);
      run("UPDATE character_references SET is_primary = 1 WHERE id = ? AND approved = 1", referenceId);
      run(
        "UPDATE characters SET primary_reference_id = ?, appearance_status = 'approved', updated_at = ? WHERE id = ?",
        referenceId,
        nowIso(),
        reference.character_id,
      );
    });
    audit({ userId: c.get("user").id, action: "character_reference_primary", entityType: "character", entityId: reference.character_id, details: { referenceId } });
    return c.json({ ok: true });
  });

  app.delete("/api/characters/references/:id", requireUser, (c) => {
    const referenceId = requireParam(c, "id");
    const reference = get<{ id: string; character_id: string; is_primary: number }>(
      "SELECT id, character_id, is_primary FROM character_references WHERE id = ?",
      referenceId,
    );
    if (!reference) throw new HttpError(404, "Референс не найден");
    withImmediateTransaction(() => {
      run("DELETE FROM character_references WHERE id = ?", referenceId);
      if (reference.is_primary) {
        const next = get<{ id: string }>(
          "SELECT id FROM character_references WHERE character_id = ? AND approved = 1 ORDER BY created_at DESC LIMIT 1",
          reference.character_id,
        );
        if (next) run("UPDATE character_references SET is_primary = 1 WHERE id = ?", next.id);
        run(
          "UPDATE characters SET primary_reference_id = ?, appearance_status = ?, updated_at = ? WHERE id = ?",
          next?.id ?? null,
          next ? "approved" : "placeholder",
          nowIso(),
          reference.character_id,
        );
      }
    });
    audit({ userId: c.get("user").id, action: "character_reference_delete", entityType: "character", entityId: reference.character_id, details: { referenceId } });
    return c.json({ ok: true });
  });

  app.get("/api/analytics", requireUser, (c) => {
    const sourceNote =
      setting("app_mode", "test") === "test"
        ? "Тестовый режим: живой сбор VK-статистики не выполняется. Показаны только сохранённые факты."
        : "Данные из VK, если синхронизация прошла успешно. Пустые значения — это отсутствие данных, а не ноль.";
    const rows = all<{
      community_id: string;
      views: number;
      likes: number;
      comments: number;
      shares: number;
      date: string;
      source: string;
    }>("SELECT community_id, views, likes, comments, shares, date, source FROM analytics ORDER BY date ASC");
    const posts = listPosts({ status: "published", limit: 100 });
    return c.json({ points: rows, published: posts, note: sourceNote, testMode: setting("app_mode", "test") === "test" });
  });

  app.get("/api/settings", requireUser, (c) => {
    return c.json({
      mode: "test",
      automationPaused: setting("automation_paused", "0") === "1",
      realPublishEnabled: false,
      timezone: "Europe/Moscow",
      prepareHoursAhead: Number(setting("prepare_hours_ahead", "24")),
      aiMonthlyLimitUsd: Number(setting("ai_monthly_limit_usd", "20")),
      spendUsdMonth: monthSpendUsd(),
      vkConfigured: COMMUNITY_IDS.some((id) => Boolean(communityToken(id))),
      aiConfigured: Boolean(getAiKey()),
      aiProvider: setting("ai_provider", "test"),
      aiTextModel: setting("ai_text_model", "test-writer-v1"),
      aiImageModel: setting("ai_image_model", "test-illustrator-v1"),
      aiBaseUrl: setting("ai_base_url", ""),
      notificationsEnabled: setting("notifications_enabled", "1") === "1",
      telegramConfigured: false,
      backupLastAt: setting("backup_last_at") || null,
      supabase: supabasePublic(),
    });
  });

  app.patch("/api/settings", requireUser, async (c) => {
    const body = await c.req.json();
    const user = c.get("user");
    if (body.mode === "approval" || body.realPublishEnabled === true) {
      throw new HttpError(501, "Локальный Node/SQLite backend — только dry-run; реальные публикации доступны через защищённый Supabase worker.");
    }
    if (body.mode === "test") setSetting("app_mode", "test");
    if (typeof body.prepareHoursAhead === "number") setSetting("prepare_hours_ahead", String(body.prepareHoursAhead));
    if (typeof body.aiMonthlyLimitUsd === "number") setSetting("ai_monthly_limit_usd", String(body.aiMonthlyLimitUsd));
    if (body.aiProvider) setSetting("ai_provider", body.aiProvider);
    if (typeof body.aiTextModel === "string") setSetting("ai_text_model", body.aiTextModel);
    if (typeof body.aiImageModel === "string") setSetting("ai_image_model", body.aiImageModel);
    if (typeof body.aiBaseUrl === "string") setSetting("ai_base_url", body.aiBaseUrl);
    if (typeof body.notificationsEnabled === "boolean") {
      setSetting("notifications_enabled", body.notificationsEnabled ? "1" : "0");
    }
    if (typeof body.aiApiKey === "string") saveAiKey(body.aiApiKey || null);
    audit({ userId: user.id, action: "settings_update", details: { keys: Object.keys(body) } });
    return c.json({ ok: true });
  });

  app.post("/api/settings/test-ai", requireUser, async (c) => {
    try {
      const adapter = await getAdapter();
      const sample = await adapter.generateText({
        communityId: "stories",
        system: "Ответь одним коротким предложением на русском, что связь работает.",
        user: "ping",
        seed: "ping",
      });
      logGeneration({
        type: "ping",
        provider: adapter.id,
        model: sample.model,
        prompt: "ping",
        result: sample.text,
        costUsd: sample.costUsd,
        status: "done",
      });
      return c.json({ ok: true, provider: adapter.id, sample: sample.text.slice(0, 280) });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.get("/api/notifications", requireUser, (c) =>
    c.json({ items: listNotifications(false, 80), unread: unreadCount() }),
  );

  app.post("/api/notifications/read", requireUser, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    markRead(body.id);
    return c.json({ ok: true, unread: unreadCount() });
  });

  app.get("/api/audit", requireUser, (c) => {
    const rows = all("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200");
    return c.json({ items: rows });
  });

  app.post("/api/uploads", requireUser, async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw new HttpError(400, "Нет файла");
    if (file.size <= 0) throw new HttpError(400, "Файл пуст");
    if (file.size > APP_LIMITS.maxUploadBytes) throw new HttpError(413, "Файл больше 12 МБ");
    const folderValue = typeof body.folder === "string" ? body.folder : "posts";
    const allowedFolders = ["posts", "characters", "communities", "generated", "archive"] as const;
    if (!(allowedFolders as readonly string[]).includes(folderValue)) throw new HttpError(400, "Недопустимая папка загрузки");
    const buf = Buffer.from(await file.arrayBuffer());
    let mime: string;
    try {
      mime = resolveImageMime(file.type, buf);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "Формат изображения не распознан");
    }
    const stored = await putMedia({
      folder: folderValue as (typeof allowedFolders)[number],
      bytes: buf,
      mime,
    });
    return c.json({ path: stored.path, url: await signedUrl(stored.path) });
  });

  app.post("/api/backup", requireUser, (c) => {
    const payload = {
      exportedAt: nowIso(),
      communities: all("SELECT id, name, schedule, status FROM communities"),
      posts: all("SELECT id, community_id, status, scheduled_at, title, topic FROM posts"),
      characters: all("SELECT id, community_id, name FROM characters"),
    };
    setSetting("backup_last_at", nowIso());
    audit({ userId: c.get("user").id, action: "backup" });
    return c.json(payload);
  });

  app.get("/api/media/sign", requireUser, async (c) => {
    const path = c.req.query("path") || "";
    return c.json({ url: await signedUrl(path) });
  });

  return app;
}

function originAllowed(origin: string, host: string) {
  try {
    const u = new URL(origin);
    if (u.host === host) return true;
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
    if (u.hostname.endsWith(".e2b.app") || u.hostname.endsWith(".arena.ai")) return true;
    const appUrl = env("APP_URL");
    if (appUrl && origin === appUrl) return true;
  } catch {
    return false;
  }
  return false;
}

function mapCommunity(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.name,
    shortName: r.short_name,
    tagline: r.tagline,
    description: r.description,
    theme: r.theme,
    color: r.color,
    avatarUrl: r.avatar_url,
    vkGroupId: r.vk_group_id,
    vkScreenName: r.vk_screen_name,
    vkConnected: Boolean(r.vk_connected),
    schedule: JSON.parse(String(r.schedule || "[]")),
    styleRules: JSON.parse(String(r.style_rules || "{}")),
    generationSettings: JSON.parse(String(r.generation_settings || "{}")),
    status: r.status,
    createdAt: r.created_at,
  };
}

async function mapCharacter(r: Record<string, unknown>) {
  const refs = all<Record<string, unknown>>(
    "SELECT * FROM character_references WHERE character_id = ? ORDER BY created_at DESC",
    r.id,
  );
  const references = await Promise.all(refs.map(async (x) => ({
    id: x.id,
    characterId: x.character_id,
    filePath: x.file_path,
    url: await signedUrl(String(x.file_path ?? "")),
    approved: Boolean(x.approved),
    isPrimary: Boolean(x.is_primary),
    notes: x.notes,
    createdAt: x.created_at,
  })));
  return {
    id: r.id,
    communityId: r.community_id,
    name: r.name,
    role: r.role,
    description: r.description,
    appearance: JSON.parse(String(r.appearance || "{}")),
    personality: r.personality,
    locked: Boolean(r.locked),
    appearanceStatus: r.appearance_status === "approved" ? "approved" : "placeholder",
    primaryReferenceId: r.primary_reference_id == null ? null : String(r.primary_reference_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    references,
  };
}

export type { PostStatus };
