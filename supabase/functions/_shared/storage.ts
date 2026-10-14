/**
 * Приватный bucket `media` (§13 ТЗ).
 *  • загрузка/подпись/удаление — только с service role;
 *  • просмотр — через временные signed URL;
 *  • удаление запрещено, если изображение используется одобренной/запланированной публикацией.
 */
import { admin } from "./db.ts";
import { ApiError } from "./http.ts";

export const BUCKET = "media";
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const ALLOWED_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/gif",
];
export const FOLDERS = ["communities", "characters", "posts", "generated", "archive"] as const;
export type MediaFolder = (typeof FOLDERS)[number];

function extensionFor(mime: string, fallback = "bin"): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("svg")) return "svg";
  if (mime.includes("gif")) return "gif";
  return fallback;
}

export function assertUploadAllowed(mime: string, size: number): void {
  if (!ALLOWED_MIME.includes(mime)) {
    throw new ApiError(400, `Недопустимый тип файла: ${mime}. Разрешены PNG, JPEG, WEBP, SVG, GIF.`, "mime");
  }
  if (size > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, "Файл больше 12 МБ", "too_large");
  }
}

export async function uploadObject(input: {
  folder: MediaFolder;
  bytes: Uint8Array;
  mime: string;
  extension?: string;
  communityId?: string | null;
  postId?: string | null;
  characterId?: string | null;
  kind?: "post_image" | "character_reference" | "community_logo" | "generated" | "archive";
  createdBy?: string | null;
}): Promise<{ path: string; sizeBytes: number }> {
  assertUploadAllowed(input.mime, input.bytes.byteLength);

  const ext = input.extension || extensionFor(input.mime);
  const path = `${input.folder}/${crypto.randomUUID()}.${ext}`;

  const { error } = await admin().storage.from(BUCKET).upload(path, input.bytes, {
    contentType: input.mime,
    upsert: false,
  });
  if (error) throw new ApiError(500, `Storage: ${error.message}`, "storage");

  await admin().from("media_assets").insert({
    community_id: input.communityId ?? null,
    post_id: input.postId ?? null,
    character_id: input.characterId ?? null,
    bucket: BUCKET,
    path,
    mime_type: input.mime,
    size_bytes: input.bytes.byteLength,
    kind: input.kind ?? (input.folder === "characters" ? "character_reference" : "post_image"),
    created_by: input.createdBy ?? null,
  });

  return { path, sizeBytes: input.bytes.byteLength };
}

export async function signedUrl(path: string | null | undefined, expiresIn = 3600): Promise<string | null> {
  if (!path) return null;
  if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("/avatars/")) return path;

  const key = path.startsWith(`${BUCKET}/`) ? path.slice(BUCKET.length + 1) : path;
  const { data, error } = await admin().storage.from(BUCKET).createSignedUrl(key, expiresIn);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** Удаление с защитой: файл не удаляется, если он есть в одобренной/запланированной публикации. */
export async function removeObject(path: string): Promise<void> {
  const { data: used } = await admin()
    .from("posts")
    .select("id, status")
    .eq("image_path", path)
    .in("status", ["approved", "scheduled", "published"])
    .limit(1);

  if (used && used.length > 0) {
    throw new ApiError(409, "Изображение используется одобренной или запланированной публикацией — удаление запрещено", "in_use");
  }

  const { error } = await admin().storage.from(BUCKET).remove([path]);
  if (error) throw new ApiError(500, `Storage: ${error.message}`, "storage");
  await admin().from("media_assets").delete().eq("path", path);
}

export function extFromMime(mime: string): string {
  return extensionFor(mime);
}
