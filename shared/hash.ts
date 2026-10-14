/**
 * Канонический хэш версии публикации — единственный источник истины для привязки одобрения.
 *
 * Один и тот же результат обязаны получить:
 *  - браузер (демо-режим, предпросмотр),
 *  - Edge Function (Deno),
 *  - локальный Node-стенд,
 *  - PostgreSQL (`app.content_hash`, pgcrypto `digest(..., 'sha256')`).
 *
 * Формат входа (точно повторяется в SQL, см. supabase/migrations/*_core_schema.sql):
 *   community_id || '\n' || btrim(text с CRLF→LF) || '\n' || coalesce(image_path,'') || '\n' || UTC ISO с миллисекундами
 *
 * SHA-256 реализован на чистом JS, чтобы функцию можно было вызывать синхронно
 * в любом окружении (без Web Crypto / node:crypto). Корректность проверяется тестом
 * против node:crypto (server/tests/hash.test.ts).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8Bytes(str: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  // Резерв для окружений без TextEncoder (не ожидается, но поведение детерминировано).
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

/** SHA-256 → hex. Синхронно, без внешних зависимостей. */
export function sha256Hex(input: string): string {
  const msg = utf8Bytes(input);
  const bitLen = msg.length * 8;
  const withPad = new Uint8Array((((msg.length + 9) >> 6) + 1) << 6);
  withPad.set(msg);
  withPad[msg.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e;
      e = (d + t1) | 0;
      d = c; c = b; b = a;
      a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return Array.from(H, (x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

function rotr(x: number, n: number) {
  return (x >>> n) | (x << (32 - n));
}

export interface ContentHashInput {
  communityId: string;
  text: string;
  imagePath: string | null | undefined;
  scheduledAt: string;
}

/** Нормализация текста — должна совпадать с SQL btrim(replace(text, E'\r\n', E'\n')). */
export function normalizeText(text: string): string {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

/** UTC-время в формате, который даёт SQL to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'). */
export function canonicalUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Некорректная дата: ${iso}`);
  return d.toISOString();
}

export function contentHashInput(input: ContentHashInput): string {
  return [
    input.communityId,
    normalizeText(input.text),
    input.imagePath ?? "",
    canonicalUtc(input.scheduledAt),
  ].join("\n");
}

export function contentHash(input: ContentHashInput): string {
  return sha256Hex(contentHashInput(input));
}

/** Короткая подпись для UI (не заменяет contentHash). */
export function shortHash(hash: string | null | undefined, len = 8): string {
  return hash ? hash.slice(0, len) : "";
}
