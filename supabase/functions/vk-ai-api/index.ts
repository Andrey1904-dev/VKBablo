/**
 * vk-ai-api — авторизованный серверный API (§14 ТЗ).
 *
 * • Проверяет JWT пользователя и роль (профиль читается из БД, браузеру не доверяем).
 * • Критические операции выполняет через RPC с серверными инвариантами
 *   (одобрение, сброс одобрения, защита от дублей).
 * • Секреты (VK-токены, AI-ключ) хранит в зашифрованном виде и никогда не возвращает.
 * • Публикует только после явного одобрения: сама функция не может обойти гейт в БД.
 */
import { admin, asUser, callRpc, requireUser } from "../_shared/db.ts";
import { ApiError, errorResponse, json, optionalString, preflight, requireString, readJson } from "../_shared/http.ts";
import { OWNER_SETUP_SECRET, WORKER_SECRET, configChecks } from "../_shared/env.ts";
import { constantTimeTextEqual } from "../_shared/core/bootstrap-safety.ts";
import { aiKeyHint, readCommunityToken, saveAiKey, saveCommunityToken } from "../_shared/secrets.ts";
import { checkToken, VkError } from "../_shared/vk.ts";
import { describeAdapter, generateTextWithAi } from "../_shared/ai.ts";
import { referencesReadiness } from "../_shared/references.ts";
import { FOLDERS, MAX_UPLOAD_BYTES, removeObject, signedUrl, uploadObject, type MediaFolder } from "../_shared/storage.ts";
import { illustrationPrompt } from "../_shared/images.ts";
import { cancelPublicationRemotely, processPublicationJobs } from "../_shared/publish.ts";
import { generateIdeas } from "../_shared/core/content-engine.ts";
import { COMMUNITY_IDS, type CommunityId } from "../_shared/core/types.ts";
import { resolveImageMime } from "../_shared/core/image-format.ts";
import { canUseApiRoute } from "../_shared/core/authorization.ts";

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const pre = preflight(req);
  if (pre) return pre;

  const url = new URL(req.url);
  const route = url.pathname
    .replace(/^\/functions\/v1\/vk-ai-api(?=\/|$)/, "")
    .replace(/^\/vk-ai-api(?=\/|$)/, "")
    .replace(/^\/+/, "");

  try {
    // Публичный health: не раскрывает секретов, только факт их наличия.
    if (route === "health" || route === "") {
      return json(
        {
          ok: true,
          service: "vk-ai-api",
          time: new Date().toISOString(),
          config: configChecks(),
          functions: [
            "vk-ai-api",
            "vk-ai-worker",
          ],
        },
        200,
        origin,
      );
    }

    // Setup status is intentionally public but reveals no account details.
    if (route === "setup-state") {
      const { count, error } = await admin()
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("role", "owner");
      if (error) throw new ApiError(503, "Не удалось проверить статус первичной настройки", "setup_state");
      return json({ hasOwner: (count ?? 0) > 0 }, 200, origin);
    }

    // The one-time setup credential is checked only in this server function.
    // The browser never receives or submits it; an operator uses the CLI script.
    if (route === "bootstrap/owner") {
      if (req.method !== "POST") throw new ApiError(405, "Метод не поддерживается", "method");
      if (OWNER_SETUP_SECRET.length < 32 || OWNER_SETUP_SECRET.length > 256) {
        throw new ApiError(503, "Серверная первичная настройка владельца не включена; задайте OWNER_SETUP_SECRET через Supabase secrets.", "setup_disabled");
      }
      const providedSecret = req.headers.get("x-owner-setup-secret") ?? "";
      if (!constantTimeTextEqual(providedSecret, OWNER_SETUP_SECRET)) {
        throw new ApiError(403, "Запрос первичной настройки не авторизован", "setup_unauthorized");
      }

      const body = await readJson<Record<string, unknown>>(req);
      const email = requireString(body.email, "email", 200).trim().toLowerCase();
      const password = requireString(body.password, "password", 200);
      const name = optionalString(body.name, 120)?.trim() || "Владелец";
      if (!email.includes("@")) throw new ApiError(400, "Укажите корректный email", "validation");
      if (password.length < 10) throw new ApiError(400, "Пароль не короче 10 символов", "validation");

      const claim = await callRpc<Record<string, unknown>>(admin(), "claim_owner_bootstrap", { p_email: email });
      if (!Boolean(claim?.claimed)) {
        const reason = String(claim?.reason ?? "unavailable");
        if (reason === "already_setup" || reason === "already_used") {
          throw new ApiError(409, "Первичная настройка уже использована. Выполните обычный вход.", "already_setup");
        }
        if (reason === "email_exists") {
          throw new ApiError(409, "Этот email уже зарегистрирован в Supabase Auth. Выберите другой адрес; bootstrap не был зарезервирован.", "setup_email_exists");
        }
        if (reason === "in_progress") {
          throw new ApiError(409, "Первичная настройка уже зарезервирована для другой операции; проверьте состояние у администратора.", "setup_in_progress");
        }
        throw new ApiError(409, "Не удалось зарезервировать первичную настройку владельца.", "setup_unavailable");
      }

      const resumed = Boolean(claim.resume);
      let userId = typeof claim.userId === "string" ? claim.userId : "";
      if (resumed && !userId) {
        throw new ApiError(409, "Предыдущая попытка прервана до фиксации Auth ID. Не повторяйте создание вслепую; проверьте Supabase Auth и bootstrap state.", "setup_manual_recovery");
      }

      if (!userId) {
        let createdUserId = "";
        try {
          const created = await admin().auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { name },
          });
          if (created.error || !created.data.user?.id) {
            throw new ApiError(409, "Auth не подтвердил создание владельца. Резервирование оставлено закрытым; проверьте Supabase Auth и bootstrap state перед восстановлением.", "setup_manual_recovery");
          }
          createdUserId = created.data.user.id;
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(502, "Auth не подтвердил результат создания владельца. Не повторяйте запрос без проверки Auth и bootstrap state.", "setup_unknown");
        }
        userId = createdUserId;
        await callRpc(admin(), "record_owner_bootstrap_user", { p_user_id: userId });
      }

      await callRpc(admin(), "complete_owner_bootstrap", {
        p_user_id: userId,
        p_email: email,
        p_name: name,
      });
      try {
        await admin().from("notifications").insert({
          type: "system",
          title: "Владелец создан",
          message: "Первый вход выполнен. Проверьте интеграции и предохранители в настройках.",
          link: "/settings",
        });
      } catch {
        // Notification failure must not turn a completed one-time bootstrap into a retry.
      }
      return json({ ok: true }, 201, origin);
    }

    const user = await requireUser(req, { allowViewer: route === "bootstrap" });
    if (!canUseApiRoute(user.role, route)) {
      throw new ApiError(403, "Недостаточно прав для этого маршрута.", "route_forbidden");
    }

    switch (route) {
      // ---------------------------------------------------------------------
      // Диагностика подключений (§16: проверка подключения каждого сервиса)
      // ---------------------------------------------------------------------
      case "health/auth":
        return json({ ok: true, user }, 200, origin);

      case "integrations/status": {
        const { data } = await admin().from("integration_status").select("*").order("key");
        const { count: tokenCount } = await admin()
          .from("community_secrets")
          .select("community_id", { count: "exact", head: true });
        return json(
          {
            integrations: data ?? [],
            vkTokensStored: tokenCount ?? 0,
            workerConfigured: Boolean(WORKER_SECRET),
            config: configChecks(),
          },
          200,
          origin,
        );
      }

      // ---------------------------------------------------------------------
      // Публикации
      // ---------------------------------------------------------------------
      case "posts/create": {
        const body = await readJson<Record<string, unknown>>(req);
        return json(
          await callRpc(asUser(extractToken(req)), "create_manual_post", {
            p_community_id: requireString(body.communityId, "communityId", 40),
            p_scheduled_at: requireString(body.scheduledAt, "scheduledAt", 40),
            p_title: optionalString(body.title, 200),
            p_text: optionalString(body.text, 8000),
          }),
          200,
          origin,
        );
      }

      case "posts/edit": {
        const body = await readJson<Record<string, unknown>>(req);
        return json(
          await callRpc(asUser(extractToken(req)), "save_post_edit", {
            p_post_id: requireString(body.postId, "postId", 80),
            p_text: typeof body.text === "string" ? body.text : null,
            p_image_path: typeof body.imagePath === "string" ? body.imagePath : null,
            p_scheduled_at: typeof body.scheduledAt === "string" ? body.scheduledAt : null,
            p_title: typeof body.title === "string" ? body.title : null,
            p_reason: optionalString(body.reason, 60) ?? "edit",
          }),
          200,
          origin,
        );
      }

      case "posts/approve":
        return json(
          await callRpc(asUser(extractToken(req)), "approve_post", {
            p_post_id: requireString((await readJson<Record<string, unknown>>(req)).postId, "postId", 80),
            p_comment: "",
          }),
          200,
          origin,
        );

      case "posts/reject": {
        const body = await readJson<Record<string, unknown>>(req);
        return json(
          await callRpc(asUser(extractToken(req)), "reject_post", {
            p_post_id: requireString(body.postId, "postId", 80),
            p_comment: optionalString(body.comment, 500) ?? "",
          }),
          200,
          origin,
        );
      }

      case "posts/revise": {
        const body = await readJson<Record<string, unknown>>(req);
        return json(
          await callRpc(asUser(extractToken(req)), "request_revision", {
            p_post_id: requireString(body.postId, "postId", 80),
            p_comment: optionalString(body.comment, 500) ?? "",
            p_scope: optionalString(body.what, 10) ?? "all",
          }),
          200,
          origin,
        );
      }

      case "posts/schedule":
        return json(
          await callRpc(asUser(extractToken(req)), "schedule_post", {
            p_post_id: requireString((await readJson<Record<string, unknown>>(req)).postId, "postId", 80),
          }),
          200,
          origin,
        );

      case "posts/unschedule": {
        const body = await readJson<Record<string, unknown>>(req);
        const result = await callRpc<Record<string, unknown>>(asUser(extractToken(req)), "begin_post_unschedule", {
          p_post_id: requireString(body.postId, "postId", 80),
          p_reason: optionalString(body.reason, 300) ?? "",
        });
        if (result?.kind === "local") {
          return json({ ok: true, status: "cancelled", post: result.post }, 200, origin);
        }
        if (result?.kind === "remote") {
          const cancellation = await cancelPublicationRemotely({
            jobId: String(result.jobId ?? ""),
            postId: String(result.postId ?? ""),
            vkPostId: String(result.vkPostId ?? ""),
            groupId: String(result.groupId ?? ""),
            communityId: requireString(result.communityId, "communityId", 40),
          });
          return json({ ok: true, status: cancellation.status }, 200, origin);
        }
        const warning = String(result?.warning ?? "Отмена не подтверждена; публикация может остаться во ВКонтакте. Проверьте VK вручную.");
        throw new ApiError(502, warning, result?.kind === "unknown" ? "remote_cancel_unknown" : "remote_cancel_pending");
      }

      case "posts/regenerate": {
        const body = await readJson<Record<string, unknown>>(req);
        const result = await callRpc(asUser(extractToken(req)), "enqueue_regeneration", {
          p_post_id: requireString(body.postId, "postId", 80),
          p_scope: optionalString(body.what, 10) ?? "all",
        });
        void triggerWorker("tick");
        return json(result, 200, origin);
      }

      case "posts/generate": {
        const body = await readJson<Record<string, unknown>>(req);
        const result = await callRpc(asUser(extractToken(req)), "enqueue_generation", {
          p_community_id: requireString(body.communityId, "communityId", 40),
          p_scheduled_at: requireString(body.scheduledAt, "scheduledAt", 40),
          p_kind: optionalString(body.kind, 20) ?? "full_post",
          p_force: Boolean(body.force),
          p_prompt: optionalString(body.prompt, 2000),
        });
        void triggerWorker("tick");
        return json(result, 200, origin);
      }

      case "planner/prepare": {
        const result = await callRpc(asUser(extractToken(req)), "enqueue_upcoming_generations", {
          p_hours: null,
        });
        void triggerWorker("tick");
        return json(result, 200, origin);
      }

      case "worker/run": {
        const body = await readJson<Record<string, unknown>>(req);
        const task = optionalString(body.task, 20) ?? "tick";
        const result = task === "publish_due"
          ? await processPublicationJobs(`manual-${Date.now()}`, 2)
          : await triggerWorker(task, true);
        return json({ ok: true, task, result }, 200, origin);
      }

      // ---------------------------------------------------------------------
      // Сообщества, правила, расписание, VK
      // ---------------------------------------------------------------------
      case "communities/update": {
        const body = await readJson<Record<string, unknown>>(req);
        return json(
          await callRpc(asUser(extractToken(req)), "update_community", {
            p_community_id: requireString(body.communityId, "communityId", 40),
            p_patch: (body.patch ?? {}) as Record<string, unknown>,
          }),
          200,
          origin,
        );
      }

      case "communities/rules": {
        const body = await readJson<Record<string, unknown>>(req);
        return json(
          await callRpc(asUser(extractToken(req)), "save_community_rules", {
            p_community_id: requireString(body.communityId, "communityId", 40),
            p_rules: (body.rules ?? {}) as Record<string, unknown>,
            p_change_note: optionalString(body.changeNote, 300) ?? "",
          }),
          200,
          origin,
        );
      }

      case "communities/vk-token": {
        const body = await readJson<Record<string, unknown>>(req);
        const communityId = requireString(body.communityId, "communityId", 40);
        const token = optionalString(body.token, 400);
        const groupId = optionalString(body.groupId, 60);

        if (!token) {
          await saveCommunityToken(communityId, null);
          await admin()
            .from("integration_status")
            .upsert({ key: "vk", status: "off", configured: false, verified: false, detail: "Токен удалён" });
          return json({ connected: false }, 200, origin);
        }

        let verified = false;
        let groupName = "";
        try {
          const info = await checkToken(token, groupId);
          verified = true;
          groupName = info.name;
        } catch (error) {
          const message = error instanceof VkError ? error.message : String(error);
          // В тестовом режиме сохраняем токен, но честно помечаем, что он не подтверждён.
          const { data: settings } = await admin()
            .from("application_settings")
            .select("value")
            .eq("key", "app_mode")
            .maybeSingle();
          const testMode = (settings?.value ?? "test") !== "approval";
          if (!testMode) throw new ApiError(400, `VK отклонил токен: ${message}`, "vk_token");
          await saveCommunityToken(communityId, token, groupId ?? "");
          await admin()
            .from("integration_status")
            .upsert({ key: "vk", status: "configured", configured: true, verified: false, detail: `Токен не проверен: ${message}` });
          return json({ connected: true, verified: false, warning: message, testMode: true }, 200, origin);
        }

        await saveCommunityToken(communityId, token, groupId ?? "");
        await admin().from("communities").update({ vk_verified_at: new Date().toISOString(), vk_connected: true }).eq("id", communityId);
        await admin()
          .from("integration_status")
          .upsert({ key: "vk", status: "verified", configured: true, verified: true, detail: `Группа: ${groupName}` });

        return json({ connected: true, verified, groupName }, 200, origin);
      }

      case "communities/vk-check": {
        const body = await readJson<Record<string, unknown>>(req);
        const communityId = requireString(body.communityId, "communityId", 40);
        const token = await readCommunityToken(communityId);
        if (!token) throw new ApiError(400, "Токен сообщества не задан", "no_token");
        const { data: community } = await admin()
          .from("communities")
          .select("vk_group_id")
          .eq("id", communityId)
          .maybeSingle();
        const info = await checkToken(token, community?.vk_group_id ?? null);
        await admin()
          .from("integration_status")
          .upsert({ key: "vk", status: "verified", configured: true, verified: true, detail: `Группа: ${info.name}` });
        return json({ ok: true, group: info }, 200, origin);
      }

      // ---------------------------------------------------------------------
      // Персонажи и референсы
      // ---------------------------------------------------------------------
      case "characters/update": {
        const body = await readJson<Record<string, unknown>>(req);
        const result = await callRpc(asUser(extractToken(req)), "save_character", {
          p_character_id: requireString(body.characterId, "characterId", 60),
          p_patch: (body.patch ?? {}) as Record<string, unknown>,
        });
        return json(result, 200, origin);
      }

      case "characters/references": {
        const body = await readJson<Record<string, unknown>>(req);
        const characterId = requireString(body.characterId, "characterId", 60);
        const path = requireString(body.path, "path", 400);
        const result = await callRpc(asUser(extractToken(req)), "add_character_reference", {
          p_character_id: characterId,
          p_storage_path: path,
          p_notes: optionalString(body.notes, 500) ?? "",
          p_make_primary: Boolean(body.makePrimary),
          p_approved: Boolean(body.approved),
        });
        return json(result, 200, origin);
      }

      case "characters/references/primary": {
        const body = await readJson<Record<string, unknown>>(req);
        return json(
          await callRpc(asUser(extractToken(req)), "set_primary_reference", {
            p_reference_id: requireString(body.referenceId, "referenceId", 60),
          }),
          200,
          origin,
        );
      }

      case "characters/references/approve": {
        const body = await readJson<Record<string, unknown>>(req);
        return json(
          await callRpc(asUser(extractToken(req)), "approve_character_reference", {
            p_reference_id: requireString(body.referenceId, "referenceId", 60),
          }),
          200,
          origin,
        );
      }

      case "characters/references/delete": {
        const body = await readJson<Record<string, unknown>>(req);
        const referenceId = requireString(body.referenceId, "referenceId", 60);
        const { data: reference } = await admin()
          .from("character_references")
          .select("storage_path")
          .eq("id", referenceId)
          .maybeSingle();

        const result = await callRpc(asUser(extractToken(req)), "delete_character_reference", {
          p_reference_id: referenceId,
        });

        if (reference?.storage_path) {
          await removeObject(String(reference.storage_path)).catch(() => undefined);
        }
        return json(result, 200, origin);
      }

      case "characters/readiness":
        return json({ readiness: await referencesReadiness() }, 200, origin);

      // ---------------------------------------------------------------------
      // Настройки, AI, медиа, аналитика
      // ---------------------------------------------------------------------
      case "ai/ideas": {
        // Направления для AI Studio. Это черновые кандидаты из правил сообщества,
        // а не «ответ модели»: текст по выбранной идее генерирует провайдер отдельно.
        const body = await readJson<Record<string, unknown>>(req);
        const communityId = requireString(body.communityId, "communityId", 40);
        if (!COMMUNITY_IDS.includes(communityId as CommunityId)) {
          throw new ApiError(400, "Неизвестное сообщество", "community");
        }
        const community = communityId as CommunityId;
        const count = Math.min(Math.max(Number(body.count ?? 6) || 6, 1), 12);

        const { data: topics } = await admin()
          .from("topics")
          .select("idea_key, topic")
          .eq("community_id", community)
          .order("created_at", { ascending: false })
          .limit(80);

        const used = (topics ?? [])
          .flatMap((row) => [String(row.idea_key ?? ""), String(row.topic ?? "")])
          .filter((value) => value.length > 0);

        const adapter = await describeAdapter();
        const ideas = generateIdeas(community, used, `ideas-${community}-${Date.now().toString(36)}`, count);

        return json(
          {
            ideas,
            adapter: { id: adapter.id, label: adapter.label, demo: adapter.demo, limitations: adapter.limitations },
            source: "rules",
            note: adapter.demo
              ? "Черновые направления подготовлены по правилам сообщества без вызова языковой модели (тестовый режим)."
              : "Черновые направления подготовлены по правилам сообщества. Текст по выбранной идее сгенерирует подключённый провайдер.",
          },
          200,
          origin,
        );
      }

      case "settings/save": {
        const body = await readJson<Record<string, unknown>>(req);
        return json(
          await callRpc(asUser(extractToken(req)), "save_settings", {
            p_patch: (body.patch ?? {}) as Record<string, unknown>,
          }),
          200,
          origin,
        );
      }

      case "settings/ai-key": {
        const body = await readJson<Record<string, unknown>>(req);
        const key = optionalString(body.key, 400);
        await saveAiKey(key);
        const hint = await aiKeyHint();
        await admin().from("integration_status").upsert({
          key: "ai_text",
          status: hint.hasKey ? "configured" : "off",
          configured: hint.hasKey,
          verified: false,
          detail: hint.hasKey ? `Ключ ${hint.hint}. Платные вызовы включаются отдельно.` : "Ключ не задан",
        });
        return json({ saved: Boolean(key), hasKey: hint.hasKey }, 200, origin);
      }

      case "settings/test-ai": {
        const adapter = await describeAdapter();
        const probe = await generateTextWithAi({
          communityId: "stories",
          system: "Ответь одним коротким предложением на русском, что связь работает.",
          user: "ping",
          seed: `ping-${Date.now()}`,
        });
        return json(
          {
            ok: true,
            adapter: { id: adapter.id, label: adapter.label, demo: adapter.demo, limitations: adapter.limitations },
            sample: probe.text.slice(0, 280),
            costUsd: probe.costUsd,
          },
          200,
          origin,
        );
      }

      case "settings/test-worker": {
        const envelope = await triggerWorker("health", true) as Record<string, unknown>;
        const result = envelope?.result as Record<string, unknown> | undefined;
        if (result?.ok !== true || result?.queueTouched !== false) {
          throw new ApiError(502, "Воркер не подтвердил безопасную проверку состояния без действий с очередью", "worker_health_failed");
        }
        return json({ ok: true, result }, 200, origin);
      }

      case "media/upload": {
        const form = await req.formData();
        const file = form.get("file");
        const folder = String(form.get("folder") ?? "posts") as MediaFolder;
        if (!(file instanceof File)) throw new ApiError(400, "Файл не получен", "no_file");
        if (!FOLDERS.includes(folder)) throw new ApiError(400, "Недопустимая папка", "folder");
        if (file.size <= 0) throw new ApiError(400, "Файл пуст", "empty_file");
        if (file.size > MAX_UPLOAD_BYTES) throw new ApiError(413, "Файл больше 12 МБ", "too_large");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let mime: string;
        try {
          mime = resolveImageMime(file.type, bytes);
        } catch (error) {
          throw new ApiError(400, error instanceof Error ? error.message : "Формат изображения не распознан", "image_signature");
        }

        const uploaded = await uploadObject({
          folder,
          bytes,
          mime,
          createdBy: user.id,
          communityId: optionalString(form.get("communityId"), 40),
          postId: optionalString(form.get("postId"), 80),
          characterId: optionalString(form.get("characterId"), 60),
        });

        return json(
          {
            path: uploaded.path,
            url: await signedUrl(uploaded.path, 3600),
            sizeBytes: uploaded.sizeBytes,
            bucket: "media",
          },
          200,
          origin,
        );
      }

      case "media/sign": {
        const body = await readJson<Record<string, unknown>>(req);
        const path = requireString(body.path, "path", 400);
        return json({ url: await signedUrl(path, 3600) }, 200, origin);
      }

      case "media/delete": {
        const body = await readJson<Record<string, unknown>>(req);
        await removeObject(requireString(body.path, "path", 400));
        return json({ ok: true }, 200, origin);
      }

      case "image-prompt": {
        const body = await readJson<Record<string, unknown>>(req);
        return json(
          {
            prompt: illustrationPrompt(
              requireString(body.communityId, "communityId", 40) as never,
              optionalString(body.topic, 200) ?? "",
              optionalString(body.title, 200) ?? "",
            ),
          },
          200,
          origin,
        );
      }

      case "analytics/import": {
        const body = await readJson<Record<string, unknown>>(req);
        const rows = Array.isArray(body.rows) ? body.rows : [];
        if (rows.length > 5000) throw new ApiError(400, "Слишком много строк в одном импорте (максимум 5000)", "too_many");
        return json(
          await callRpc(asUser(extractToken(req)), "import_analytics", {
            p_rows: rows,
            p_note: optionalString(body.note, 300) ?? "импорт владельца",
          }),
          200,
          origin,
        );
      }

      case "notifications/read": {
        const body = await readJson<Record<string, unknown>>(req);
        return json(
          await callRpc(asUser(extractToken(req)), "mark_notifications_read", {
            p_id: optionalString(body.id, 60),
          }),
          200,
          origin,
        );
      }

      default:
        throw new ApiError(404, `Метод не найден: ${route}`, "not_found");
    }
  } catch (error) {
    return errorResponse(error, origin);
  }
});

function extractToken(req: Request): string {
  const header = req.headers.get("authorization") || "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

/** Ручной запуск воркера (использует тот же рабочий секрет, что и Cron). */
async function triggerWorker(task: string, wait = false): Promise<unknown> {
  if (!WORKER_SECRET) {
    if (wait) throw new ApiError(503, "WORKER_SECRET не настроен; проверка воркера не выполнена", "worker_not_configured");
    return { dispatched: false, skipped: "WORKER_SECRET не задан" };
  }
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) {
    if (wait) throw new ApiError(503, "SUPABASE_URL не настроен; проверка воркера не выполнена", "worker_not_configured");
    return { dispatched: false, skipped: "SUPABASE_URL не задан" };
  }

  const response = await fetch(`${base}/functions/v1/vk-ai-worker`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-secret": WORKER_SECRET },
    body: JSON.stringify({ task, source: "api" }),
    signal: AbortSignal.timeout(wait ? 60_000 : 5_000),
  }).catch(() => null);

  if (!response) {
    if (wait) throw new ApiError(502, "Ответ воркера не получен; проверка не подтверждена", "worker_unreachable");
    return { dispatched: false, error: "Ответ воркера не получен" };
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
    if (wait) throw new ApiError(502, `Воркер отклонил запрос: ${detail}`, "worker_rejected");
    return { dispatched: false, status: response.status, error: detail };
  }
  return wait ? await response.json().catch(() => ({ ok: false, error: "Воркер вернул некорректный JSON" })) : { dispatched: true };
}
