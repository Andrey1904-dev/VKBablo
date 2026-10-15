// ВНИМАНИЕ: файл сгенерирован из shared/ командой `npm run sync:shared`.
// Правки вносите в источник: shared/<имя>.ts
/**
 * File format checks shared by the browser-facing API, local backend and Edge.
 * VK's wall-photo upload path in this project supports only PNG and JPEG.
 */
export const STORAGE_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/gif",
] as const;

export const VK_PUBLICATION_IMAGE_MIME_TYPES = ["image/png", "image/jpeg"] as const;
export type VkPublicationImageMime = (typeof VK_PUBLICATION_IMAGE_MIME_TYPES)[number];

const decoder = new TextDecoder();

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return bytes.byteLength >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return Array.from(bytes.subarray(start, start + length), (value) => String.fromCharCode(value)).join("");
}

/** Best-effort signature sniffing; never trusts a filename or multipart MIME header. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (bytes.byteLength >= 6 && ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "image/gif";

  const text = decoder.decode(bytes.subarray(0, Math.min(bytes.byteLength, 2048)))
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[^]*?-->\s*)*<svg(?:\s|>)/i.test(text)) return "image/svg+xml";
  return null;
}

/** Resolve empty MIME headers from file bytes and reject spoofed declared types. */
export function resolveImageMime(declaredMime: string | null | undefined, bytes: Uint8Array): string {
  const actualMime = sniffImageMime(bytes);
  if (!actualMime) throw new Error("Содержимое файла не распознано как поддерживаемое изображение.");

  const declared = String(declaredMime ?? "").split(";", 1)[0].trim().toLowerCase();
  if (declared && declared !== actualMime) {
    throw new Error(`Тип файла ${declared} не совпадает с фактическим форматом ${actualMime}.`);
  }
  return actualMime;
}

export function isVkPublicationImageMime(mime: string): mime is VkPublicationImageMime {
  return (VK_PUBLICATION_IMAGE_MIME_TYPES as readonly string[]).includes(mime.toLowerCase());
}

export function hasVkPublicationImageExtension(path: string | null | undefined): boolean {
  return Boolean(path && /\.(?:png|jpe?g)(?:$|[?#])/i.test(path.trim()));
}

/** Checks both bytes and MIME for the raster types accepted by the VK publisher. */
export function isVkPublicationImage(mime: string, bytes: Uint8Array): mime is VkPublicationImageMime {
  return isVkPublicationImageMime(mime) && sniffImageMime(bytes) === mime.toLowerCase();
}
