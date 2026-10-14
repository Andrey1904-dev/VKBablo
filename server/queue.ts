import { all, get, run, setting } from "./db.ts";
import { nid, nowIso } from "./lib.ts";
import { generateForSlot, markPublishedIfDue, upcomingSlots } from "./posts.ts";
import { notify } from "./notify.ts";
import type { CommunityId } from "../shared/types.ts";

const inflight = new Set<string>();
const MAX_CONCURRENCY = 2;

export function enqueue(input: {
  type: string;
  payload: unknown;
  runAt?: string;
  idempotencyKey?: string;
  maxAttempts?: number;
}): string {
  if (input.idempotencyKey) {
    const existing = get<{ id: string; status: string }>(
      "SELECT id, status FROM jobs WHERE idempotency_key = ?",
      input.idempotencyKey,
    );
    if (existing) return existing.id;
  }
  const id = nid("job");
  run(
    `INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, run_at, idempotency_key, created_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    id,
    input.type,
    JSON.stringify(input.payload ?? {}),
    input.maxAttempts ?? 3,
    input.runAt ?? nowIso(),
    input.idempotencyKey ?? null,
    nowIso(),
  );
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
    await generateForSlot({ communityId: p.communityId, scheduledAt: p.scheduledAt });
  }
}

export async function processOnce() {
  markPublishedIfDue();
  if (inflight.size >= MAX_CONCURRENCY) return;
  const job = get<{
    id: string;
    type: string;
    payload: string;
    attempts: number;
    max_attempts: number;
  }>(
    "SELECT * FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at ASC LIMIT 1",
    nowIso(),
  );
  if (!job) return;
  if (inflight.has(job.id)) return;
  inflight.add(job.id);
  run("UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?", nowIso(), job.id);
  try {
    await handle(job.type, JSON.parse(job.payload || "{}"));
    run("UPDATE jobs SET status = 'done', finished_at = ?, error = NULL WHERE id = ?", nowIso(), job.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const attempts = job.attempts + 1;
    if (attempts >= job.max_attempts) {
      run(
        "UPDATE jobs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?",
        nowIso(),
        msg,
        job.id,
      );
      notify({ type: "generation_error", title: "Задача провалена", message: msg, link: "/settings" });
    } else {
      const delay = Math.min(15, 2 ** attempts) * 60 * 1000;
      run(
        "UPDATE jobs SET status = 'queued', run_at = ?, error = ? WHERE id = ?",
        new Date(Date.now() + delay).toISOString(),
        msg,
        job.id,
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
