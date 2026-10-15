import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env, supabaseConfigured } from "./env.ts";
import { UPLOAD_DIR } from "./db.ts";
import { nid } from "./lib.ts";

const BUCKET = "media";
const MAX_BYTES = 12 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"]);

let sb: SupabaseClient | null = null;

export function adminClient(): SupabaseClient | null {
  if (!supabaseConfigured()) return null;
  if (!sb) {
    sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return sb;
}

export function extFromMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("svg")) return "svg";
  if (mime.includes("gif")) return "gif";
  return "bin";
}

export function assertImage(mime: string, size: number) {
  if (!ALLOWED.has(mime)) throw new Error("Допустимы только PNG, JPEG, WEBP, SVG");
  if (size <= 0) throw new Error("Файл пуст");
  if (size > MAX_BYTES) throw new Error("Файл больше 12 МБ");
}

export async function putMedia(opts: {
  folder: "communities" | "characters" | "posts" | "generated" | "archive";
  bytes: Buffer;
  mime: string;
  filename?: string;
}): Promise<{ path: string; key: string }> {
  assertImage(opts.mime, opts.bytes.length);
  const ext = extFromMime(opts.mime);
  const key = `${opts.folder}/${nid("f")}.${ext}`;
  const client = adminClient();
  if (client) {
    const { error } = await client.storage.from(BUCKET).upload(key, opts.bytes, {
      contentType: opts.mime,
      upsert: false,
    });
    if (error) throw new Error(`Storage: ${error.message}`);
    return { path: `supabase://${key}`, key };
  }
  const name = key.replaceAll("/", "_");
  mkdirSync(UPLOAD_DIR, { recursive: true });
  writeFileSync(join(UPLOAD_DIR, name), opts.bytes);
  return { path: `/uploads/${name}`, key: name };
}

export async function signedUrl(path: string, expires = 3600): Promise<string | null> {
  if (!path) return null;
  if (path.startsWith("/uploads/")) return path;
  if (path.startsWith("supabase://")) {
    const client = adminClient();
    if (!client) return null;
    const key = path.slice("supabase://".length);
    const { data, error } = await client.storage.from(BUCKET).createSignedUrl(key, expires);
    if (error) return null;
    return data.signedUrl;
  }
  return path;
}

export function readLocalUpload(file: string): { bytes: Buffer; mime: string } | null {
  if (!/^[\w.\-]+$/.test(file)) return null;
  const p = join(UPLOAD_DIR, file);
  if (!existsSync(p) || dirname(p) !== UPLOAD_DIR) return null;
  const bytes = readFileSync(p);
  const mime = file.endsWith(".svg")
    ? "image/svg+xml"
    : file.endsWith(".png")
      ? "image/png"
      : file.endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
  return { bytes, mime };
}

export async function removeMedia(path: string, inUse: boolean) {
  if (inUse) throw new Error("Нельзя удалить изображение, которое используется в публикации");
  if (path.startsWith("supabase://")) {
    const client = adminClient();
    if (!client) return;
    await client.storage.from(BUCKET).remove([path.slice("supabase://".length)]);
  }
}
