/**
 * Шифрование секретов (VK-токены, AI-ключ) на сервере.
 * AES-256-GCM, ключ — ENCRYPTION_KEY из секретов Edge Function.
 * Открытые значения никогда не покидают серверное окружение.
 */
import { ENCRYPTION_KEY } from "./env.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function key(): Promise<CryptoKey> {
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length < 32) {
    throw new Error("ENCRYPTION_KEY не задан или короче 32 символов");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(ENCRYPTION_KEY));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/** Формат: v1:<iv b64>:<ciphertext+tag b64> */
export async function encryptSecret(plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(),
    encoder.encode(plain),
  );
  return `v1:${toBase64(iv)}:${toBase64(new Uint8Array(cipher))}`;
}

export async function decryptSecret(payload: string): Promise<string> {
  const [version, ivPart, dataPart] = String(payload).split(":");
  if (version !== "v1" || !ivPart || !dataPart) {
    throw new Error("Неподдерживаемый формат секрета");
  }
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64(ivPart)) },
    await key(),
    asArrayBuffer(fromBase64(dataPart)),
  );
  return decoder.decode(plain);
}

/** Маска для отображения: «vk1…4f» — сам секрет не восстанавливается. */
export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (value.length <= 6) return "••••";
  return `${value.slice(0, 3)}…${value.slice(-2)}`;
}
