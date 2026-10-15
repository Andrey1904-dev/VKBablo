/**
 * Shared safety checks for VK publication jobs.
 * Keep these helpers free of network and database dependencies so they can be
 * exercised with mocked VK/storage adapters in Node tests and reused by Edge.
 */

export interface ApprovedPublicationSnapshot {
  id: string;
  communityId: string;
  status: string;
  text: string | null;
  imagePath: string | null;
  scheduledAt: string;
  contentHash: string | null;
  approvedHash: string | null;
}

export interface PublicationJobSnapshot {
  postId: string;
  communityId: string;
  versionHash: string;
  scheduledAt: string;
  status?: string;
  dispatchStartedAt?: string | null;
  vkPostId?: string | null;
}

export class PublicationSafetyError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = "publication_safety", retryable = false) {
    super(message);
    this.name = "PublicationSafetyError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * A returned VK id is the durable evidence that VK accepted the wall.post.
 * Test ids are deliberately excluded from real cancellation/publication paths.
 */
export function isRemoteVkPostId(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "" && !value.startsWith("test_");
}

/**
 * Defense in depth before any external side effect. The database RPC repeats
 * this check while holding the post row lock immediately before wall.post.
 */
export function hasCurrentApproval(
  post: ApprovedPublicationSnapshot,
  job: PublicationJobSnapshot,
): boolean {
  const postTime = Date.parse(post.scheduledAt);
  const jobTime = Date.parse(job.scheduledAt);
  return Boolean(
    post.id === job.postId &&
      post.communityId === job.communityId &&
      Number.isFinite(postTime) &&
      Number.isFinite(jobTime) &&
      postTime === jobTime &&
      post.approvedHash &&
      post.contentHash === post.approvedHash &&
      post.approvedHash === job.versionHash &&
      post.status === "scheduled" &&
      typeof post.text === "string" &&
      post.text.trim().length > 0,
  );
}

export function assertCurrentApproval(
  post: ApprovedPublicationSnapshot,
  job: PublicationJobSnapshot,
): void {
  if (!hasCurrentApproval(post, job)) {
    throw new PublicationSafetyError(
      "Публикация заблокирована: одобрение не соответствует текущей версии, сообществу или времени.",
      "approval_stale",
    );
  }
}

/**
 * Image is mandatory for an approved post. A signed URL failure, 404, empty
 * file, SVG, or unsupported MIME type stops publication before wall.post.
 */
export async function fetchRequiredPublicationImage(
  path: string | null | undefined,
  createSignedUrl: (path: string) => Promise<string | null>,
  fetcher: typeof fetch = fetch,
): Promise<{ bytes: Uint8Array; filename: string; mimeType: "image/png" | "image/jpeg" }> {
  if (!path || !path.trim()) {
    throw new PublicationSafetyError(
      "Публикация заблокирована: в одобренной версии отсутствует изображение.",
      "missing_image",
    );
  }
  if (/\.svg(?:$|[?#])/i.test(path)) {
    throw new PublicationSafetyError(
      "Публикация заблокирована: VK не принимает SVG. Загрузите PNG или JPEG и одобрите обновлённую версию.",
      "unsupported_image",
    );
  }

  let url: string | null;
  try {
    url = await createSignedUrl(path);
  } catch {
    url = null;
  }
  if (!url) {
    throw new PublicationSafetyError(
      "Публикация заблокирована: изображение недоступно в Supabase Storage.",
      "image_unavailable",
    );
  }

  let response: Response;
  try {
    response = await fetcher(url);
  } catch {
    throw new PublicationSafetyError(
      "Публикация заблокирована: не удалось загрузить одобренное изображение.",
      "image_unavailable",
      true,
    );
  }
  if (!response.ok) {
    throw new PublicationSafetyError(
      `Публикация заблокирована: Storage вернул HTTP ${response.status} для одобренного изображения.`,
      "image_unavailable",
      response.status >= 500,
    );
  }

  const rawMime = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  const mimeType = rawMime === "image/png" ? "image/png" : rawMime === "image/jpeg" ? "image/jpeg" : null;
  if (!mimeType) {
    throw new PublicationSafetyError(
      `Публикация заблокирована: тип изображения ${rawMime || "неизвестен"}; разрешены только PNG и JPEG.`,
      "unsupported_image",
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new PublicationSafetyError(
      "Публикация заблокирована: файл изображения пуст.",
      "missing_image",
    );
  }

  const cleanPath = path.split(/[?#]/, 1)[0];
  const basename = cleanPath.split("/").filter(Boolean).pop() || "post-image";
  const fallbackExtension = mimeType === "image/png" ? ".png" : ".jpg";
  const filename = /\.(png|jpe?g)$/i.test(basename) ? basename : `${basename}${fallbackExtension}`;
  return { bytes, filename, mimeType };
}

export function shouldSkipClaimedPublication(job: {
  cancelled?: boolean;
  alreadyPosted?: boolean;
  unknown?: boolean;
  status?: string;
  vkPostId?: string | null;
}): boolean {
  return Boolean(
    job.cancelled ||
      job.alreadyPosted ||
      job.unknown ||
      job.status === "unknown" ||
      isRemoteVkPostId(job.vkPostId),
  );
}

export type StalePublicationDisposition = "requeue" | "unknown" | "leave_terminal";

/**
 * A stale lease after dispatch started is never automatically retried: VK may
 * have accepted the request and its response may have been lost.
 */
export function stalePublicationDisposition(job: {
  status: string;
  dispatchStartedAt?: string | null;
  vkPostId?: string | null;
}): StalePublicationDisposition {
  if (job.status !== "running") return "leave_terminal";
  if (job.dispatchStartedAt || isRemoteVkPostId(job.vkPostId)) return "unknown";
  return "requeue";
}

export function shouldRetryDefinitePublicationFailure(input: {
  outcomeUnknown: boolean;
  retryable: boolean;
  attempts: number;
  maxAttempts: number;
}): boolean {
  return !input.outcomeUnknown && input.retryable && input.attempts < input.maxAttempts;
}

/** Map a failed remote delete to truthful user-facing status; never imply success. */
export function remoteCancellationWarning(outcome: "failed" | "unknown", detail?: string): string {
  const reason = outcome === "unknown"
    ? "VK не подтвердил результат удаления."
    : "VK отклонил или не подтвердил удаление.";
  const safeDetail = detail?.trim() ? ` ${detail.trim()}` : "";
  return `${reason}${safeDetail} Публикация может остаться запланированной во ВКонтакте. Проверьте VK вручную; автоматический повтор wall.delete не выполняется.`;
}
