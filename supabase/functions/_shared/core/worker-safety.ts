// ВНИМАНИЕ: файл сгенерирован из shared/ командой `npm run sync:shared`.
// Правки вносите в источник: shared/<имя>.ts
/** Safe task allowlist for the Edge queue worker. Health checks must stay read-only. */
export const WORKER_TASKS = ["tick", "planner", "publish_due", "stats", "health"] as const;
export type WorkerTask = (typeof WORKER_TASKS)[number];

export function isWorkerTask(value: unknown): value is WorkerTask {
  return typeof value === "string" && (WORKER_TASKS as readonly string[]).includes(value);
}

export function shouldProcessWorkerQueue(task: unknown): boolean {
  return task === "tick" || task === "planner" || task === "publish_due" || task === "stats";
}
