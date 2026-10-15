/**
 * Publication and statistics worker.
 * All real sends are guarded by the DB snapshot fence and VK ids are persisted
 * before a job can be considered complete. The VK client is mockable in tests.
 */
import { admin, callRpc } from "./db.ts";
import { readCommunityToken } from "./secrets.ts";
import { assertVkCompatibleImage, fetchPostStats, uploadWallPhoto, wallDelete, wallPost, VkOutcomeUnknownError } from "./vk.ts";
import { signedUrl } from "./storage.ts";
import {
  assertCurrentApproval,
  uploadVerifiedPublicationImage,
  isRemoteVkPostId,
  shouldSkipClaimedPublication,
  PublicationSafetyError,
  remoteCancellationWarning,
} from "./core/publication-safety.ts";
import { ApiError, redactSecrets } from "./http.ts";

export interface PublishSettings {
  mode: string;
  realPublishEnabled: boolean;
  automationPaused: boolean;
}

export async function loadPublishSettings(): Promise<PublishSettings> {
  const { data } = await admin().from("application_settings").select("key, value");
  const map = new Map((data ?? []).map((row: { key: string; value: string }) => [row.key, row.value]));
  return {
    mode: map.get("app_mode") ?? "test",
    realPublishEnabled: (map.get("real_publish_enabled") ?? "false") === "true",
    automationPaused: (map.get("automation_paused") ?? "false") === "true",
  };
}

interface PublicationJob {
  id: string;
  postId: string;
  communityId: string;
  versionHash: string;
  imageSha256: string | null;
  scheduledAt: string;
  targetGroupId: string | null;
  vkPostId: string | null;
  dryRun: boolean;
  attempts: number;
  maxAttempts: number;
  cancelled?: boolean;
  alreadyPosted?: boolean;
  unknown?: boolean;
  status?: string;
}

interface PublicationPost {
  id: string;
  community_id: string;
  text: string;
  image_path: string | null;
  status: string;
  test_mode: boolean;
  scheduled_at: string;
  content_hash: string;
  approved_hash: string | null;
  approved_image_sha256: string | null;
  vk_post_id: string | null;
}

async function finishAttempt(input: {
  jobId: string;
  outcome: "confirmed" | "rejected" | "unknown" | "preflight_failed" | "aborted";
  vkPostId?: string | null;
  error?: string | null;
  retryDelaySeconds?: number;
  retryable?: boolean;
}): Promise<Record<string, unknown>> {
  return (await callRpc<Record<string, unknown>>(admin(), "finish_publication_attempt", {
    p_job_id: input.jobId,
    p_outcome: input.outcome,
    p_vk_post_id: input.vkPostId ?? null,
    p_error: input.error ?? null,
    p_retry_delay_seconds: input.retryDelaySeconds ?? 120,
    p_retryable: input.retryable ?? false,
  })) as Record<string, unknown>;
}

/** Обработка очереди отложенных публикаций. Вызывается из воркера. */
export async function processPublicationJobs(
  workerId: string,
  maxJobs = 3,
): Promise<{ processed: number; real: number; simulated: number; skipped: number; errors: string[] }> {
  const settings = await loadPublishSettings();
  const result = { processed: 0, real: 0, simulated: 0, skipped: 0, errors: [] as string[] };

  if (settings.automationPaused) return result;

  for (let i = 0; i < maxJobs; i++) {
    const claimed = (await callRpc<Record<string, unknown> | null>(admin(), "claim_publication_job", {
      p_worker: workerId,
    })) as (PublicationJob & { cancelled?: boolean; alreadyPosted?: boolean; unknown?: boolean }) | null;

    if (!claimed) break;
    if (shouldSkipClaimedPublication(claimed)) {
      result.skipped += 1;
      if (claimed.unknown || claimed.status === "unknown") {
        result.errors.push("Результат VK неизвестен; автоматическая отправка остановлена.");
      }
      continue;
    }

    const job = claimed as PublicationJob;
    result.processed += 1;

    let post: PublicationPost | null = null;
    let dispatchFenceSet = false;
    let dispatchRpcAttempted = false;
    try {
      const query = await admin()
        .from("posts")
        .select("id, community_id, text, image_path, status, test_mode, scheduled_at, content_hash, approved_hash, approved_image_sha256, vk_post_id")
        .eq("id", job.postId)
        .maybeSingle();
      if (query.error) throw new ApiError(500, `Не удалось проверить публикацию: ${query.error.message}`, "db");
      post = (query.data as PublicationPost | null) ?? null;
      if (!post) {
        await finishAttempt({ jobId: job.id, outcome: "aborted", error: "публикация не найдена" });
        result.errors.push(`post ${job.postId} не найден`);
        continue;
      }

      const digestQuery = await admin()
        .from("publication_jobs")
        .select("image_sha256")
        .eq("id", job.id)
        .maybeSingle();
      if (digestQuery.error) throw new ApiError(500, `Не удалось проверить SHA-256 снимка публикации: ${digestQuery.error.message}`, "db");
      job.imageSha256 = typeof digestQuery.data?.image_sha256 === "string" ? digestQuery.data.image_sha256 : null;

      // A real job whose global gates were turned off is cancelled, not reported
      // as a successful simulated publication. Dry-run jobs remain explicitly test_*.
      if (job.dryRun || post.test_mode) {
        const simulatedId = `test_${job.communityId}_${Math.floor(new Date(job.scheduledAt).getTime() / 1000)}`;
        const finished = await finishAttempt({ jobId: job.id, outcome: "confirmed", vkPostId: simulatedId });
        if (finished.status === "cancelled") result.skipped += 1;
        else result.simulated += 1;
        continue;
      }
      if (settings.mode !== "approval" || !settings.realPublishEnabled) {
        const message = "Реальная публикация остановлена: app_mode/real_publish_enabled отключены. Повторно запланируйте пост после проверки настроек.";
        await finishAttempt({ jobId: job.id, outcome: "aborted", error: message });
        result.skipped += 1;
        result.errors.push(`${job.communityId}: ${message}`);
        continue;
      }

      assertCurrentApproval(
        {
          id: post.id,
          communityId: post.community_id,
          status: post.status,
          text: post.text,
          imagePath: post.image_path,
          scheduledAt: post.scheduled_at,
          contentHash: post.content_hash,
          approvedHash: post.approved_hash,
          approvedImageSha256: post.approved_image_sha256,
        },
        job,
      );
      if (isRemoteVkPostId(job.vkPostId) || isRemoteVkPostId(post.vk_post_id)) {
        await finishAttempt({
          jobId: job.id,
          outcome: "unknown",
          error: "Для этой версии уже сохранён VK post ID; автоматический повтор wall.post запрещён.",
        });
        result.skipped += 1;
        continue;
      }

      // An image is mandatory for approval and publication. The wrapper verifies
      // Storage bytes against the approval digest before it invokes uploadWallPhoto.
      assertVkCompatibleImage(post.image_path);
      const token = await readCommunityToken(job.communityId);
      if (!token || !job.targetGroupId) {
        const message = "Публикация заблокирована: отсутствует серверный VK-токен или снимок Group ID.";
        await finishAttempt({ jobId: job.id, outcome: "preflight_failed", error: message });
        result.errors.push(`${job.communityId}: ${message}`);
        continue;
      }

      // Uploading a photo does not create a wall post. A failure here may be
      // safely retried; no wall.post has yet been sent to VK.
      const attachment = await uploadVerifiedPublicationImage(
        post.image_path,
        job.imageSha256,
        (path) => signedUrl(path, 600),
        (image) => uploadWallPhoto({
          token,
          groupId: job.targetGroupId!,
          bytes: image.bytes,
          filename: image.filename,
        }),
        fetch,
      );

      // Transactional final gate checks approval, image path, target group and
      // global flags again, then records dispatch_started_at. Edits/cancellations
      // after that point are fenced until the result is reconciled.
      dispatchRpcAttempted = true;
      const dispatch = await callRpc<Record<string, unknown>>(admin(), "begin_publication_dispatch", {
        p_job_id: job.id,
        p_version_hash: job.versionHash,
      });
      if (dispatch?.cancelled || dispatch?.deferred) {
        result.skipped += 1;
        continue;
      }
      dispatchFenceSet = true;
      const dispatchGroup = String(dispatch?.groupId ?? "");
      const dispatchText = String(dispatch?.text ?? "");
      const dispatchImage = String(dispatch?.imagePath ?? "");
      const dispatchScheduledAt = String(dispatch?.scheduledAt ?? "");
      if (
        dispatchGroup !== job.targetGroupId ||
        dispatchText !== post.text ||
        dispatchImage !== post.image_path ||
        Date.parse(dispatchScheduledAt) !== Date.parse(post.scheduled_at)
      ) {
        // The DB fence is already set. Failing closed may require manual
        // reconciliation, but sending a stale snapshot is never allowed.
        await finishAttempt({
          jobId: job.id,
          outcome: "unknown",
          error: "Снимок публикации изменился после проверки; отправка остановлена без повторения.",
        });
        result.errors.push(`${job.communityId}: снимок публикации изменился перед wall.post`);
        continue;
      }

      let posted: { postId: string };
      try {
        posted = await wallPost({
          token,
          groupId: dispatchGroup,
          message: dispatchText,
          attachment,
          publishDateUnix: Math.floor(Date.parse(dispatchScheduledAt) / 1000),
        });
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error));
        const unknown = error instanceof VkOutcomeUnknownError || (error as { outcomeUnknown?: boolean })?.outcomeUnknown === true;
        const retryable = !unknown && (error as { retryable?: boolean })?.retryable === true;
        try {
          await finishAttempt({
            jobId: job.id,
            outcome: unknown ? "unknown" : "rejected",
            error: message,
            retryDelaySeconds: retryable ? 120 * (job.attempts + 1) : 3600,
            retryable,
          });
        } catch (finishError) {
          // Do not reinterpret a failed outcome-persistence write as a new
          // attempt. The dispatch fence makes stale recovery mark it unknown.
          result.errors.push(
            `${job.communityId}: ${message}; результат не удалось сохранить (${redactSecrets(finishError instanceof Error ? finishError.message : "ошибка БД")}). Повтор wall.post запрещён.`,
          );
          continue;
        }
        result.errors.push(`${job.communityId}: ${message}`);
        continue;
      }

      // A VK post ID is known. Persist it with an idempotent DB RPC; if the
      // response is lost, retry only this persistence operation, never wall.post.
      let persisted = false;
      let persistenceError: unknown;
      for (let attempt = 0; attempt < 2 && !persisted; attempt++) {
        try {
          const saved = await finishAttempt({ jobId: job.id, outcome: "confirmed", vkPostId: posted.postId });
          if (saved.status !== "done" || saved.vkPostId !== posted.postId) {
            throw new ApiError(502, "База данных не подтвердила сохранение VK post ID.", "vk_id_persist_unknown");
          }
          persisted = true;
        } catch (error) {
          persistenceError = error;
        }
      }
      if (!persisted) {
        result.errors.push(
          `${job.communityId}: VK вернул post ID ${posted.postId}, но его сохранение не подтверждено. wall.post не будет повторён; проверьте задание и VK вручную. ${redactSecrets(persistenceError instanceof Error ? persistenceError.message : "")}`,
        );
        continue;
      }
      result.real += 1;
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      const outcomeUnknown = error instanceof VkOutcomeUnknownError || (error as { outcomeUnknown?: boolean })?.outcomeUnknown === true;
      const retryable = !dispatchFenceSet && !outcomeUnknown && (error as { retryable?: boolean })?.retryable === true;
      const safetyError = error instanceof PublicationSafetyError;
      const outcome = outcomeUnknown || dispatchFenceSet
        ? "unknown"
        : dispatchRpcAttempted || (safetyError && !retryable)
          ? "preflight_failed"
          : "rejected";
      try {
        await finishAttempt({
          jobId: job.id,
          outcome,
          error: message,
          retryDelaySeconds: retryable ? 120 * (job.attempts + 1) : 3600,
          retryable,
        });
      } catch (finishError) {
        result.errors.push(
          `${job.communityId}: ${message}; состояние задания не удалось зафиксировать (${redactSecrets(finishError instanceof Error ? finishError.message : "ошибка БД")}). Автоматический повтор после dispatch fence запрещён.`,
        );
        continue;
      }
      result.errors.push(`${job.communityId}: ${message}`);
    }
  }

  return result;
}

/**
 * Mark due posts published only after confirmed remote post IDs. Unknown or
 * unconfirmed-cancellation jobs are deliberately not reconciled as published.
 */
export async function markDuePostsPublished(limit = 20): Promise<{ marked: number; simulated: number; real: number }> {
  const { data } = await admin()
    .from("posts")
    .select("id, test_mode, vk_post_id, scheduled_at")
    .eq("status", "scheduled")
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(limit);

  let marked = 0;
  let simulated = 0;
  let real = 0;

  for (const post of data ?? []) {
    if (post.test_mode) {
      await callRpc(admin(), "mark_post_published", {
        p_post_id: post.id,
        p_vk_post_id: post.vk_post_id ?? `test_${post.id}`,
        p_published_at: post.scheduled_at,
      });
      marked += 1;
      simulated += 1;
      continue;
    }

    if (isRemoteVkPostId(post.vk_post_id)) {
      const { data: jobs } = await admin()
        .from("publication_jobs")
        .select("status, remote_cancel_state, vk_post_id")
        .eq("post_id", post.id)
        .order("created_at", { ascending: false })
        .limit(1);
      const job = jobs?.[0] as { status?: string; remote_cancel_state?: string; vk_post_id?: string | null } | undefined;
      if (job?.status !== "done" || job.remote_cancel_state !== "none" || job.vk_post_id !== post.vk_post_id) continue;
      await callRpc(admin(), "mark_post_published", {
        p_post_id: post.id,
        p_vk_post_id: post.vk_post_id,
        p_published_at: post.scheduled_at,
      });
      marked += 1;
      real += 1;
    }
  }

  return { marked, simulated, real };
}

/**
 * Owner-initiated cancellation. Local queue cancellation is distinct from VK
 * wall.delete; errors are persisted and the UI is told the post may remain.
 */
export async function cancelPublicationRemotely(input: {
  jobId: string;
  postId: string;
  vkPostId: string;
  groupId: string;
  communityId: string;
}): Promise<{ status: "confirmed" }> {
  const token = await readCommunityToken(input.communityId);
  if (!token || !input.groupId || !isRemoteVkPostId(input.vkPostId)) {
    const warning = remoteCancellationWarning("failed", "Не удалось получить VK-токен, Group ID или корректный VK post ID.");
    let persistWarning = "";
    try {
      await callRpc(admin(), "finish_post_unschedule", {
        p_job_id: input.jobId,
        p_post_id: input.postId,
        p_vk_post_id: input.vkPostId,
        p_outcome: "failed",
        p_error: warning,
      });
    } catch {
      persistWarning = " Состояние отмены не удалось сохранить в базе.";
    }
    throw new ApiError(502, `${warning}${persistWarning}`, "remote_cancel_failed");
  }

  try {
    await wallDelete({ token, groupId: input.groupId, postId: input.vkPostId });
  } catch (error) {
    const outcome = error instanceof VkOutcomeUnknownError || (error as { outcomeUnknown?: boolean })?.outcomeUnknown === true
      ? "unknown"
      : "failed";
    const detail = redactSecrets(error instanceof Error ? error.message : String(error));
    const warning = remoteCancellationWarning(outcome, detail);
    let persistWarning = "";
    try {
      await callRpc(admin(), "finish_post_unschedule", {
        p_job_id: input.jobId,
        p_post_id: input.postId,
        p_vk_post_id: input.vkPostId,
        p_outcome: outcome,
        p_error: warning,
      });
    } catch {
      persistWarning = " Состояние отмены не удалось сохранить в базе.";
    }
    throw new ApiError(502, `${warning}${persistWarning}`, outcome === "unknown" ? "remote_cancel_unknown" : "remote_cancel_failed");
  }

  try {
    await callRpc(admin(), "finish_post_unschedule", {
      p_job_id: input.jobId,
      p_post_id: input.postId,
      p_vk_post_id: input.vkPostId,
      p_outcome: "confirmed",
      p_error: null,
    });
  } catch (error) {
    // VK did confirm deletion, but we cannot report success until the database
    // records it. Retrying the DB write is safe; issuing wall.delete again is not.
    try {
      await callRpc(admin(), "finish_post_unschedule", {
        p_job_id: input.jobId,
        p_post_id: input.postId,
        p_vk_post_id: input.vkPostId,
        p_outcome: "confirmed",
        p_error: null,
      });
    } catch {
      const warning = remoteCancellationWarning(
        "unknown",
        `VK ответил об удалении, но сохранение результата в базе не подтвердилось (${redactSecrets(error instanceof Error ? error.message : "ошибка БД")}).`,
      );
      try {
        await callRpc(admin(), "finish_post_unschedule", {
          p_job_id: input.jobId,
          p_post_id: input.postId,
          p_vk_post_id: input.vkPostId,
          p_outcome: "unknown",
          p_error: warning,
        });
      } catch {
        /* Keep the user-facing warning even if the database is unavailable. */
      }
      throw new ApiError(502, warning, "remote_cancel_persist_unknown");
    }
  }
  return { status: "confirmed" };
}

/** Сбор статистики реальных публикаций (демо-данные не создаются). */
export async function collectStatistics(limit = 10): Promise<{ collected: number; errors: string[] }> {
  const due = (await callRpc<Array<Record<string, unknown>>>(admin(), "posts_due_for_stats", {
    p_limit: limit,
  })) as Array<{ post_id: string; vk_post_id: string; vk_group_id: string; community_id: string }>;

  const errors: string[] = [];
  let collected = 0;

  for (const item of due ?? []) {
    try {
      const token = await readCommunityToken(String(item.community_id));
      if (!token) continue;

      const stats = await fetchPostStats({
        token,
        groupId: String(item.vk_group_id),
        postId: String(item.vk_post_id),
      });
      if (!stats) continue;

      await callRpc(admin(), "save_post_statistics", {
        p_post_id: item.post_id,
        p_views: stats.views,
        p_likes: stats.likes,
        p_comments: stats.comments,
        p_shares: stats.shares,
        p_source: "vk",
      });
      collected += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { collected, errors };
}
