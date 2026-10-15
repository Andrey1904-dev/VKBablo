import { all, get, run, setting, withImmediateTransaction } from "./db.ts";
import { nid, nowIso } from "./lib.ts";
import { generateForSlot, markPublishedIfDue, upcomingSlots } from "./posts.ts";
import { notify } from "./notify.ts";
import type { CommunityId } from "../shared/types.ts";

const inflight = new Set<string>();
const MAX_CONCURRENCY = 2;
const STALE_JOB_MS = 10 * 60 * 1000;

type QueueRow = {
  id: string;
  type: string;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
  run_at: string;
  started_at: string | null;
  lock_token: string | null;
};

export function enqueue(input: {
  type: string;
  payload: unknown;
  runAt?: string;
  idempotencyKey?: string;
  maxAttempts?: number;
}): string {
  if (input.idempotencyKey) {
    const existing = get<{ id: string }>(
      "SELECT id FROM jobs WHERE idempotency_key = ?",
      input.idempotencyKey,
    );
    if (existing) return existing.id;
  }
  const id = nid("job");
  run(
    `INSERT OR IGNORE INTO jobs (id, type, payload, status, attempts, max_attempts, run_at, idempotency_key, created_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    id,
    input.type,
    JSON.stringify(input.payload ?? {}),
    input.maxAttempts ?? 3,
    input.runAt ?? nowIso(),
    input.idempotencyKey ?? null,
    nowIso(),
  );
  if (input.idempotencyKey) {
    return get<{ id: string }>("SELECT id FROM jobs WHERE idempotency_key = ?", input.idempotencyKey)?.id ?? id;
  }
  return id;
}

export function enqueueUpcomingGeneration() {
  if (setting("automation_paused", "0") === "1") return [];
  const hours = Number(setting("prepare_hours_ahead", "24"));
  const slots = upcomingSlots(hours);
  const ids: string[] = [];
  for (const s of slots) {
    const exists = get(
      "SELECT id FROM posts WHERE community_id = ? AND scheduled_at = ?",
      s.communityId,
      s.scheduledAt,
    );
    if (exists) continue;
    ids.push(
      enqueue({
        type: "generate_post",
        payload: s,
        idempotencyKey: `gen:${s.communityId}:${s.scheduledAt}`,
      }),
    );
  }
  return ids;
}

async function handle(type: string, payload: unknown) {
  if (type === "generate_post") {
    const p = payload as { communityId: CommunityId; scheduledAt: string };
    await generateForSlot({ communityId: p.communityId, scheduledAt: p.scheduledAt, retryInterrupted: true });
    return;
  }
  throw new Error(`Неизвестный тип задания: ${type}`);
}

/**
 * Recover durable leases left running by a crashed local worker. Attempts stay
 * bounded; jobs at the retry limit become terminal instead of looping forever.
 */
export function recoverStaleJobs(now = Date.now(), staleMs = STALE_JOB_MS): { requeued: number; failed: number } {
  const cutoff = new Date(now - staleMs).toISOString();
  const recoveredAt = new Date(now).toISOString();
  return withImmediateTransaction(() => {
    const stale = all<QueueRow>(
      `SELECT id, type, payload, status, attempts, max_attempts, run_at, started_at, lock_token
         FROM jobs
        WHERE status = 'running' AND started_at IS NOT NULL AND started_at <= ?
        ORDER BY started_at ASC`,
      cutoff,
    );
    let requeued = 0;
    let failed = 0;

    for (const job of stale) {
      const lease = job.lock_token;
      if (job.attempts >= job.max_attempts) {
        const result = run(
          `UPDATE jobs SET status = 'failed', finished_at = ?, error = ?, lock_token = NULL
            WHERE id = ? AND status = 'running' AND started_at = ? AND COALESCE(lock_token, '') = COALESCE(?, '')`,
          recoveredAt,
          "Воркер не завершил задачу до истечения аренды; лимит попыток исчерпан.",
          job.id,
          job.started_at,
          lease,
        );
        if (Number(result.changes) > 0) {
          failed += 1;
          markGenerationPostError(job, "Задача генерации остановлена: воркер не восстановился до лимита попыток.", recoveredAt);
          notify({
            type: "generation_error",
            title: "Задача остановлена после сбоя воркера",
            message: `Задание ${job.id} исчерпало число попыток; проверьте слот и повторите вручную.`,
            link: "/settings",
          });
        }
      } else {
        const result = run(
          `UPDATE jobs SET status = 'queued', run_at = ?, started_at = NULL, lock_token = NULL,
                  error = 'Восстановлено после истечения аренды воркера'
            WHERE id = ? AND status = 'running' AND started_at = ? AND COALESCE(lock_token, '') = COALESCE(?, '')`,
          recoveredAt,
          job.id,
          job.started_at,
          lease,
        );
        if (Number(result.changes) > 0) requeued += 1;
      }
    }
    return { requeued, failed };
  });
}

function markGenerationPostError(job: QueueRow, message: string, at: string) {
  if (job.type !== "generate_post") return;
  try {
    const payload = JSON.parse(job.payload || "{}") as { communityId?: string; scheduledAt?: string };
    if (!payload.communityId || !payload.scheduledAt) return;
    run(
      `UPDATE posts SET status = 'error', error_message = ?, updated_at = ?
        WHERE community_id = ? AND scheduled_at = ? AND status = 'generating'`,
      message,
      at,
      payload.communityId,
      payload.scheduledAt,
    );
  } catch {
    // A malformed historical payload must not roll back recovery of other jobs.
  }
}

/** Atomic claim: SQLite's write lock serializes multiple local worker processes. */
export function claimNextJob(): (QueueRow & { attempts: number; lock_token: string }) | null {
  const claimedAt = nowIso();
  return withImmediateTransaction(() => {
    const job = get<QueueRow>(
      `SELECT id, type, payload, status, attempts, max_attempts, run_at, started_at, lock_token
         FROM jobs
        WHERE status = 'queued' AND run_at <= ?
        ORDER BY run_at ASC, created_at ASC
        LIMIT 1`,
      claimedAt,
    );
    if (!job) return null;
    const token = nid("lease");
    const result = run(
      `UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1, lock_token = ?, error = NULL
        WHERE id = ? AND status = 'queued'`,
      claimedAt,
      token,
      job.id,
    );
    if (Number(result.changes) !== 1) return null;
    return { ...job, status: "running", started_at: claimedAt, attempts: job.attempts + 1, lock_token: token };
  });
}

export async function processOnce() {
  markPublishedIfDue();
  if (inflight.size >= MAX_CONCURRENCY) return;
  recoverStaleJobs();
  const job = claimNextJob();
  if (!job) return;
  if (inflight.has(job.id)) {
    run(
      "UPDATE jobs SET status = 'queued', run_at = ?, started_at = NULL, lock_token = NULL WHERE id = ? AND status = 'running' AND lock_token = ?",
      nowIso(),
      job.id,
      job.lock_token,
    );
    return;
  }
  inflight.add(job.id);
  try {
    await handle(job.type, JSON.parse(job.payload || "{}"));
    run(
      "UPDATE jobs SET status = 'done', finished_at = ?, error = NULL, lock_token = NULL WHERE id = ? AND status = 'running' AND lock_token = ?",
      nowIso(),
      job.id,
      job.lock_token,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (job.attempts >= job.max_attempts) {
      const result = run(
        "UPDATE jobs SET status = 'failed', finished_at = ?, error = ?, lock_token = NULL WHERE id = ? AND status = 'running' AND lock_token = ?",
        nowIso(),
        msg,
        job.id,
        job.lock_token,
      );
      if (Number(result.changes) > 0) {
        notify({ type: "generation_error", title: "Задача провалена", message: msg, link: "/settings" });
      }
    } else {
      const delay = Math.min(15, 2 ** job.attempts) * 60 * 1000;
      run(
        `UPDATE jobs SET status = 'queued', run_at = ?, started_at = NULL, lock_token = NULL, error = ?
          WHERE id = ? AND status = 'running' AND lock_token = ?`,
        new Date(Date.now() + delay).toISOString(),
        msg,
        job.id,
        job.lock_token,
      );
    }
  } finally {
    inflight.delete(job.id);
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startWorkers() {
  if (timer) return;
  timer = setInterval(() => {
    enqueueUpcomingGeneration();
    processOnce().catch(() => {});
  }, 8000);
}

export function listJobs(limit = 50) {
  return all(
    "SELECT id, type, status, attempts, max_attempts, run_at, error, idempotency_key, created_at FROM jobs ORDER BY created_at DESC LIMIT ?",
    limit,
  );
}
