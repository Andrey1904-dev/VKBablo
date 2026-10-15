/**
 * VK API client.
 * Tokens are only read from encrypted server-side storage.
 * Every request path accepts an injectable fetcher for deterministic mock tests;
 * production callers use the platform fetch implementation by default.
 */
import { VK_API_VERSION } from "./env.ts";
import { ApiError } from "./http.ts";

export interface VkErrorShape {
  error_code?: number;
  error_msg?: string;
  error?: { error_code?: number; error_msg?: string };
}

const RETRYABLE_CODES = new Set([1, 6, 9, 10, 29, 429]);

export class VkError extends ApiError {
  vkCode?: number;
  retryable: boolean;
  outcomeUnknown = false;

  constructor(message: string, code?: number) {
    super(502, `VK API: ${message}`, "vk");
    this.vkCode = code;
    this.retryable = code !== undefined && RETRYABLE_CODES.has(code);
  }
}

/** wall.post may have been accepted even when no usable response reached us. */
export class VkOutcomeUnknownError extends VkError {
  constructor(method: string, detail = "ответ VK потерян или повреждён") {
    super(`${method}: ${detail}`);
    this.name = "VkOutcomeUnknownError";
    this.outcomeUnknown = true;
    this.retryable = false;
  }
}

export interface VkRequestOptions {
  fetcher?: typeof fetch;
  /** A transport/5xx/invalid response after this call has an ambiguous result. */
  outcomeUnknownOnTransport?: boolean;
}

async function vkApi<T>(
  method: string,
  token: string,
  params: Record<string, string | number> = {},
  options: VkRequestOptions = {},
): Promise<T> {
  const body = new URLSearchParams({
    access_token: token,
    v: VK_API_VERSION,
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
  });
  const fetcher = options.fetcher ?? fetch;

  let response: Response;
  try {
    response = await fetcher(`https://api.vk.com/method/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    if (options.outcomeUnknownOnTransport) {
      throw new VkOutcomeUnknownError(method, error instanceof Error ? "сетевой ответ потерян" : "сетевой ответ не получен");
    }
    throw new VkError("не удалось связаться с VK API");
  }

  if (!response.ok) {
    if (options.outcomeUnknownOnTransport && (response.status === 408 || response.status >= 500)) {
      throw new VkOutcomeUnknownError(method, `VK вернул HTTP ${response.status}`);
    }
    throw new VkError(`HTTP ${response.status}`, response.status);
  }

  let payload: { response?: T } & VkErrorShape;
  try {
    payload = (await response.json()) as { response?: T } & VkErrorShape;
  } catch {
    if (options.outcomeUnknownOnTransport) throw new VkOutcomeUnknownError(method);
    throw new VkError("не удалось прочитать ответ VK");
  }

  const error = payload.error ?? undefined;
  if (error) {
    // Generic/internal VK errors on state-changing calls may be returned after
    // the server received the request; never automatically repeat wall.post.
    if (options.outcomeUnknownOnTransport && [1, 10].includes(error.error_code ?? -1)) {
      throw new VkOutcomeUnknownError(method, `VK вернул неоднозначную ошибку ${error.error_code}`);
    }
    throw new VkError(error.error_msg || "неизвестная ошибка", error.error_code);
  }
  if (payload.response === undefined) {
    if (options.outcomeUnknownOnTransport) throw new VkOutcomeUnknownError(method);
    throw new VkError("пустой ответ");
  }
  return payload.response;
}

export interface VkGroupInfo {
  id: number;
  name: string;
  screenName: string;
}

/** Проверка токена и прав: возвращает данные группы или понятную ошибку. */
export async function checkToken(
  token: string,
  groupId?: string | null,
  options: VkRequestOptions = {},
): Promise<VkGroupInfo> {
  const response = await vkApi<
    | Array<{ id: number; name?: string; screen_name?: string }>
    | { groups?: Array<{ id: number; name?: string; screen_name?: string }> }
  >("groups.getById", token, groupId ? { group_id: groupId.replace("-", "") } : {}, options);

  const groups = Array.isArray(response) ? response : (response.groups ?? []);
  const group = groups[0];
  if (!group) throw new VkError("группа не найдена или токен без прав");

  return {
    id: group.id,
    name: group.name ?? String(group.id),
    screenName: group.screen_name ?? String(group.id),
  };
}

export async function uploadWallPhoto(input: {
  token: string;
  groupId: string;
  bytes: Uint8Array;
  filename: string;
  fetcher?: typeof fetch;
}): Promise<string> {
  const fetcher = input.fetcher ?? fetch;
  const numericGroupId = String(input.groupId).replace("-", "");
  const uploadServer = await vkApi<{ upload_url: string }>(
    "photos.getWallUploadServer",
    input.token,
    { group_id: numericGroupId },
    { fetcher },
  );

  const form = new FormData();
  const blobBytes = new Uint8Array(input.bytes.byteLength);
  blobBytes.set(input.bytes);
  form.append("photo", new Blob([blobBytes]), input.filename);
  const uploadResponse = await fetcher(uploadServer.upload_url, { method: "POST", body: form });
  if (!uploadResponse.ok) throw new VkError(`ошибка загрузки изображения HTTP ${uploadResponse.status}`);
  const uploaded = (await uploadResponse.json()) as { photo: string; server: number; hash: string };

  const saved = await vkApi<Array<{ id: number; owner_id: number }>>(
    "photos.saveWallPhoto",
    input.token,
    {
      group_id: numericGroupId,
      photo: uploaded.photo,
      server: uploaded.server,
      hash: uploaded.hash,
    },
    { fetcher },
  );

  const photo = saved?.[0];
  if (!photo) throw new VkError("не удалось сохранить фотографию на стене");
  return `photo${photo.owner_id}_${photo.id}`;
}

export async function wallPost(
  input: {
    token: string;
    groupId: string;
    message: string;
    attachment?: string | null;
    /** Unix timestamp for VK's deferred wall post. */
    publishDateUnix?: number | null;
  },
  options: Pick<VkRequestOptions, "fetcher"> = {},
): Promise<{ postId: string }> {
  const ownerId = String(input.groupId).startsWith("-")
    ? String(input.groupId)
    : `-${String(input.groupId).replace("-", "")}`;

  const params: Record<string, string | number> = {
    owner_id: ownerId,
    from_group: 1,
    message: input.message,
  };
  if (input.attachment) params.attachments = input.attachment;
  // Never turn a still-future approved slot into an immediate post. Near-due
  // jobs are deferred by the DB fence; if a request is late, send immediately.
  if (input.publishDateUnix && input.publishDateUnix > Math.floor(Date.now() / 1000)) {
    params.publish_date = input.publishDateUnix;
  }

  const response = await vkApi<{ post_id?: number }>("wall.post", input.token, params, {
    fetcher: options.fetcher,
    outcomeUnknownOnTransport: true,
  });
  if (typeof response.post_id !== "number" || response.post_id <= 0) {
    throw new VkOutcomeUnknownError("wall.post", "в ответе нет корректного post_id");
  }
  return { postId: String(response.post_id) };
}

/** Confirm remote deletion of an already-created delayed VK wall post. */
export async function wallDelete(
  input: { token: string; groupId: string; postId: string },
  options: Pick<VkRequestOptions, "fetcher"> = {},
): Promise<{ deleted: true }> {
  const ownerId = String(input.groupId).startsWith("-")
    ? String(input.groupId)
    : `-${String(input.groupId).replace("-", "")}`;
  const response = await vkApi<number>(
    "wall.delete",
    input.token,
    { owner_id: ownerId, post_id: input.postId },
    { fetcher: options.fetcher, outcomeUnknownOnTransport: true },
  );
  if (response !== 1) throw new VkError("VK не подтвердил удаление отложенной публикации");
  return { deleted: true };
}

export async function fetchPostStats(input: {
  token: string;
  groupId: string;
  postId: string;
  fetcher?: typeof fetch;
}): Promise<{ views: number; likes: number; comments: number; shares: number } | null> {
  const ownerId = String(input.groupId).startsWith("-")
    ? String(input.groupId)
    : `-${String(input.groupId).replace("-", "")}`;

  const response = await vkApi<
    Array<{
      views?: { count?: number };
      likes?: { count?: number };
      comments?: { count?: number };
      reposts?: { count?: number };
    }>
  >("wall.getById", input.token, { posts: `${ownerId}_${input.postId}` }, { fetcher: input.fetcher });

  const post = response?.[0];
  if (!post) return null;

  return {
    views: post.views?.count ?? 0,
    likes: post.likes?.count ?? 0,
    comments: post.comments?.count ?? 0,
    shares: post.reposts?.count ?? 0,
  };
}

/** VK publication requires an available raster; missing/unknown files fail closed. */
export function assertVkCompatibleImage(path: string | null | undefined): void {
  if (!path || !path.trim()) {
    throw new VkError("изображение отсутствует — неполная публикация не отправлена");
  }
  if (/\.svg(?:$|[?#])/i.test(path)) {
    throw new VkError("VK не принимает SVG. Загрузите PNG или JPEG и одобрите обновлённую версию.");
  }
  if (!/\.(png|jpe?g)(?:$|[?#])/i.test(path)) {
    throw new VkError("VK-публикация допускает только проверенные файлы PNG/JPEG.");
  }
}
