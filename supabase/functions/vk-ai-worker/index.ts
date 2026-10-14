/**
 * vk-ai-worker — обработка очередей (§14, §15 ТЗ).
 *
 * Вызывается:
 *  • Supabase Cron (pg_net → HTTP) с заголовком x-worker-secret;
 *  • вручную владельцем через интерфейс (кнопка «Обработать очередь»).
 *
 * Каждая задача ограничена по времени: не полагаемся на бесконечное выполнение
 * одной Edge Function. Незавершённое задание вернётся в очередь и будет повторено.
 */
import { admin, callRpc } from "../_shared/db.ts";
import { errorResponse, json, preflight } from "../_shared/http.ts";
import { WORKER_SECRET } from "../_shared/env.ts";
import { runGenerationJob, type GenerationJob } from "../_shared/jobs.ts";
import { collectStatistics, markDuePostsPublished, processPublicationJobs } from "../_shared/publish.ts";

const MAX_RUNTIME_MS = 45_000;
const MAX_JOBS_PER_RUN = 2;

interface WorkerRequest {
  task?: "tick" | "planner" | "publish_due" | "stats" | "health";
  source?: string;
}

function authorize(req: Request): boolean {
  if (!WORKER_SECRET) return false;
  const header = req.headers.get("x-worker-secret") || "";
  // Сравнение постоянного времени: защита от подбора секрета.
  if (header.length !== WORKER_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) {
    diff |= header.charCodeAt(i) ^ WORKER_SECRET.charCodeAt(i);
  }
  return diff === 0;
}

async function runGenerationQueue(workerId: string) {
  const started = Date.now();
  const summary = { claimed: 0, done: 0, retried: 0, failed: 0, errors: [] as string[] };

  while (Date.now() - started < MAX_RUNTIME_MS && summary.claimed < MAX_JOBS_PER_RUN) {
    const claimed = (await callRpc<Record<string, unknown> | null>(admin(), "claim_generation_job", {
      p_kinds: null,
      p_worker: workerId,
    })) as GenerationJob | null;

    if (!claimed) break;
    summary.claimed += 1;

    try {
      const outcome = await runGenerationJob(claimed);
      await callRpc(admin(), "finish_generation_job", {
        p_job_id: claimed.id,
        p_ok: outcome.ok,
        p_result: { summary: outcome.summary },
        p_error: outcome.error ?? null,
        p_cost: outcome.costUsd,
      });
      summary.done += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finished = (await callRpc<{ status: string }>(admin(), "finish_generation_job", {
        p_job_id: claimed.id,
        p_ok: false,
        p_error: message,
        p_cost: 0,
      })) as { status: string };

      if (finished?.status === "failed") summary.failed += 1;
      else summary.retried += 1;
      summary.errors.push(message);
    }
  }

  return summary;
}

async function handle(task: string, workerId: string) {
  const requeued = await callRpc(admin(), "requeue_stale_jobs", { p_stale_seconds: 600 });
  const publishSettings = (await callRpc<Record<string, unknown>>(admin(), "get_settings")) as {
    automationPaused?: boolean;
  };

  if (publishSettings?.automationPaused) {
    return { task, paused: true, requeued };
  }

  switch (task) {
    case "planner": {
      const queued = await callRpc(admin(), "enqueue_upcoming_generations", { p_hours: null });
      const published = await markDuePostsPublished(10);
      return { task, requeued, queued, published };
    }
    case "publish_due": {
      const publication = await processPublicationJobs(workerId, 3);
      const published = await markDuePostsPublished(20);
      return { task, requeued, publication, published };
    }
    case "stats": {
      const stats = await collectStatistics(10);
      return { task, requeued, stats };
    }
    case "tick":
    default: {
      const queued = await callRpc(admin(), "enqueue_upcoming_generations", { p_hours: null });
      const generation = await runGenerationQueue(workerId);
      const published = await markDuePostsPublished(10);
      return { task: "tick", requeued, queued, generation, published };
    }
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const pre = preflight(req);
  if (pre) return pre;

  try {
    if (!authorize(req)) {
      return json({ error: "Неверный или отсутствующий рабочий секрет" }, 401, origin);
    }

    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as WorkerRequest) : {};
    const task = body.task ?? "tick";
    const workerId = `worker-${task}-${Date.now()}`;

    const started = Date.now();
    const result = await handle(task, workerId);

    await admin()
      .from("audit_logs")
      .insert({
        action: "worker_run",
        entity_type: "worker",
        details: { task, durationMs: Date.now() - started, source: body.source ?? "manual" },
        result: "ok",
      })
      .then(() => undefined, () => undefined);

    return json({ ok: true, task, durationMs: Date.now() - started, result }, 200, origin);
  } catch (error) {
    return errorResponse(error, origin);
  }
});
