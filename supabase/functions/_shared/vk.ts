/**
 * VK API клиент (§16 ТЗ).
 * Токены приходят только из зашифрованного хранилища (service role).
 * Отложенная публикация — `wall.post` с `publish_date` после одобрения владельца.
 */
import { VK_API_VERSION } from "./env.ts";
import { ApiError } from "./http.ts";

export interface VkErrorShape {
  error_code?: number;
  error_msg?: string;
  error?: { error_code?: number; error_msg?: string };
}

const RETRYABLE_CODES = new Set([1, 6, 9, 10, 29]);

export class VkError extends ApiError {
  code?: number;
  retryable: boolean;
  constructor(message: string, code?: number) {
    super(502, `VK API: ${message}`, "vk");
    this.code = code;
    this.retryable = code !== undefined && RETRYABLE_CODES.has(code);
  }
}

async function vkApi<T>(
  method: string,
  token: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const body = new URLSearchParams({
    access_token: token,
    v: VK_API_VERSION,
    ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)])),
  });

  const response = await fetch(`https://api.vk.com/method/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new VkError(`HTTP ${response.status}`, response.status);
  }

  const payload = (await response.json()) as { response?: T } & VkErrorShape;
  const error = payload.error ?? undefined;
  if (error) {
    throw new VkError(error.error_msg || "неизвестная ошибка", error.error_code);
  }
  if (payload.response === undefined) {
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
export async function checkToken(token: string, groupId?: string | null): Promise<VkGroupInfo> {
  const response = await vkApi<
    | Array<{ id: number; name?: string; screen_name?: string }>
    | { groups?: Array<{ id: number; name?: string; screen_name?: string }> }
  >("groups.getById", token, groupId ? { group_id: groupId.replace("-", "") } : {});

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
}): Promise<string> {
  const numericGroupId = String(input.groupId).replace("-", "");
  const uploadServer = await vkApi<{ upload_url: string }>(
    "photos.getWallUploadServer",
    input.token,
    { group_id: numericGroupId },
  );

  const form = new FormData();
  form.append("photo", new Blob([input.bytes]), input.filename);

  const uploadResponse = await fetch(uploadServer.upload_url, { method: "POST", body: form });
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
  );

  const photo = saved?.[0];
  if (!photo) throw new VkError("не удалось сохранить фотографию на стене");
  return `photo${photo.owner_id}_${photo.id}`;
}

export async function wallPost(input: {
  token: string;
  groupId: string;
  message: string;
  attachment?: string | null;
  /** Unix-время отложенной публикации. Если не задано — публикуем сразу. */
  publishDateUnix?: number | null;
}): Promise<{ postId: string }> {
  const ownerId = String(input.groupId).startsWith("-")
    ? String(input.groupId)
    : `-${String(input.groupId).replace("-", "")}`;

  const params: Record<string, string | number> = {
    owner_id: ownerId,
    from_group: 1,
    message: input.message,
  };
  if (input.attachment) params.attachments = input.attachment;
  // VK не принимает publish_date в прошлом: для просроченных постов публикуем сразу.
  if (input.publishDateUnix && input.publishDateUnix > Math.floor(Date.now() / 1000) + 60) {
    params.publish_date = input.publishDateUnix;
  }

  const response = await vkApi<{ post_id: number }>("wall.post", input.token, params);
  return { postId: String(response.post_id) };
}

export async function fetchPostStats(input: {
  token: string;
  groupId: string;
  postId: string;
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
  >("wall.getById", input.token, { posts: `${ownerId}_${input.postId}` });

  const post = response?.[0];
  if (!post) return null;

  return {
    views: post.views?.count ?? 0,
    likes: post.likes?.count ?? 0,
    comments: post.comments?.count ?? 0,
    shares: post.reposts?.count ?? 0,
  };
}

/** VK не принимает SVG — это важное ограничение для публикаций. */
export function assertVkCompatibleImage(path: string | null | undefined): void {
  if (!path) return;
  if (path.toLowerCase().endsWith(".svg")) {
    throw new VkError(
      "VK не принимает SVG. Для реальной публикации нужно растровое изображение (PNG/JPEG) — " +
        "подключите AI-провайдер изображений или загрузите PNG/JPEG вручную.",
    );
  }
}
