export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, { ...init, headers, credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || "Ошибка запроса");
  return data as T;
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Черновик",
  generating: "Генерируется",
  review: "На проверке",
  needs_revision: "Требует доработки",
  approved: "Одобрен",
  scheduled: "Запланирован",
  published: "Опубликован",
  error: "Ошибка",
  rejected: "Отклонён",
};

export const STATUS_TONE: Record<string, string> = {
  draft: "bg-muted text-muted-fg",
  generating: "bg-accent/15 text-accent",
  review: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  needs_revision: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  scheduled: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  published: "bg-emerald-600/20 text-emerald-800 dark:text-emerald-200",
  error: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  rejected: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
};

export const COMMUNITY_COLOR: Record<string, string> = {
  stories: "#E86A33",
  milana: "#2FA36B",
  life: "#3B7BD6",
  veronica: "#D4537E",
};
