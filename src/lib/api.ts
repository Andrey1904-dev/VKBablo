/**
 * HTTP-хелпер для LocalBackend (локальный стенд разработки, server/).
 * Страницы интерфейса работают через getBackend() из @/data — не через этот модуль.
 *
 * Плюс общие подписи статусов и палитра сообществ из дизайн-системы DesignVK.
 */
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

/** Тон бейджа дизайн-системы для каждого статуса поста. */
export const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "purple" | "danger" | "sky"> = {
  draft: "neutral",
  generating: "purple",
  review: "warning",
  needs_revision: "warning",
  approved: "purple",
  scheduled: "sky",
  published: "success",
  error: "danger",
  rejected: "neutral",
};
