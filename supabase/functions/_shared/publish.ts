/**
 * Публикация и статистика (§8, §16 ТЗ).
 *
 * Здесь находятся настоящие предохранители:
 *  • реальный вызов VK возможен только при app_mode = 'approval'
 *    И real_publish_enabled = true И наличии действующего одобрения;
 *  • все остальные случаи — dry-run с честной пометкой test_mode;
 *  • повторные попытки с защитой от дублей через idempotency_key и очередь.
 */
import { admin, callRpc } from "./db.ts";
import { readCommunityToken } from "./secrets.ts";
import { assertVkCompatibleImage, fetchPostStats, wallPost } from "./vk.ts";
import { signedUrl } from "./storage.ts";

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
  scheduledAt: string;
  dryRun: boolean;
  attempts: number;
  maxAttempts: number;
}

/** Обработка очереди отложенных публикаций. Вызывается из воркера. */
export async function processPublicationJobs(
  workerId: string,
  maxJobs = 3,
): Promise<{ processed: number; real: number; simulated: number; skipped: number; errors: string[] }> {
  const settings = await loadPublishSettings();
  const result = { processed: 0, real: 0, simulated: 0, skipped: 0, errors: [] as string[] };

  if (settings.automationPaused) {
    return result;
  }

  for (let i = 0; i < maxJobs; i++) {
    const claimed = (await callRpc<Record<string, unknown> | null>(admin(), "claim_publication_job", {
      p_worker: workerId,
    })) as PublicationJob | null;

    if (!claimed) break;
    if ((claimed as unknown as { cancelled?: boolean }).cancelled) {
      result.skipped += 1;
      continue;
    }

    const job = claimed as PublicationJob;
    result.processed += 1;

    const { data: post } = await admin()
      .from("posts")
      .select("id, community_id, text, image_path, status, test_mode, scheduled_at")
      .eq("id", job.postId)
      .maybeSingle();

    if (!post) {
      await callRpc(admin(), "finish_publication_job", {
        p_job_id: job.id,
        p_ok: false,
        p_error: "публикация не найдена",
        p_retry_delay_seconds: 300,
      });
      result.errors.push(`post ${job.postId} не найден`);
      continue;
    }

    const canPublishForReal =
      settings.mode === "approval" &&
      settings.realPublishEnabled &&
      job.dryRun === false &&
      post.test_mode === false;

    try {
      if (!canPublishForReal) {
        // Dry-run: ничего не уходит в VK. Идентификатор помечен test_ и никогда не считается реальным.
        const simulatedId = `test_${job.communityId}_${Math.floor(new Date(job.scheduledAt).getTime() / 1000)}`;
        await callRpc(admin(), "finish_publication_job", {
          p_job_id: job.id,
          p_ok: true,
          p_vk_post_id: simulatedId,
          p_error: null,
        });
        result.simulated += 1;
        continue;
      }

      assertVkCompatibleImage(post.image_path);

      const token = await readCommunityToken(job.communityId);
      const { data: community } = await admin()
        .from("communities")
        .select("vk_group_id")
        .eq("id", job.communityId)
        .maybeSingle();

      if (!token || !community?.vk_group_id) {
        await callRpc(admin(), "finish_publication_job", {
          p_job_id: job.id,
          p_ok: false,
          p_error: "нет VK-токена или Group ID",
          p_retry_delay_seconds: 900,
        });
        result.errors.push(`${job.communityId}: нет VK-токена или Group ID`);
        continue;
      }

      let attachment: string | null = null;
      if (post.image_path) {
        const url = await signedUrl(post.image_path, 600);
        if (url) {
          const response = await fetch(url);
          if (response.ok) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            const { uploadWallPhoto } = await import("./vk.ts");
            attachment = await uploadWallPhoto({
              token,
              groupId: community.vk_group_id,
              bytes,
              filename: post.image_path.split("/").pop() ?? "post.png",
            });
          }
        }
      }

      const scheduledUnix = Math.floor(new Date(post.scheduled_at).getTime() / 1000);
      const posted = await wallPost({
        token,
        groupId: community.vk_group_id,
        message: post.text ?? "",
        attachment,
        publishDateUnix: scheduledUnix,
      });

      await callRpc(admin(), "finish_publication_job", {
        p_job_id: job.id,
        p_ok: true,
        p_vk_post_id: posted.postId,
        p_error: null,
      });
      result.real += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = (error as { retryable?: boolean }).retryable !== false;
      await callRpc(admin(), "finish_publication_job", {
        p_job_id: job.id,
        p_ok: false,
        p_error: message,
        p_retry_delay_seconds: retryable ? 120 * (job.attempts + 1) : 3600,
      });
      result.errors.push(`${job.communityId}: ${message}`);
    }
  }

  return result;
}

/**
 * Отметка «опубликовано» для постов, время которых прошло.
 * Реальные посты — только если у них есть vk_post_id, подтверждённый VK.
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
      // Демонстрационная публикация: помечаем явно, что это не VK.
      await callRpc(admin(), "mark_post_published", {
        p_post_id: post.id,
        p_vk_post_id: post.vk_post_id ?? `test_${post.id}`,
        p_published_at: post.scheduled_at,
      });
      marked += 1;
      simulated += 1;
      continue;
    }

    if (post.vk_post_id && !String(post.vk_post_id).startsWith("test_")) {
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
