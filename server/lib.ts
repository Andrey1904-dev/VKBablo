import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { MOSCOW_TZ } from "../shared/types.ts";

export function nid(prefix = ""): string {
  const id = randomBytes(12).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function contentHash(input: {
  communityId: string;
  text: string;
  imagePath: string | null;
  scheduledAt: string;
}): string {
  return sha256(
    JSON.stringify({
      c: input.communityId,
      t: input.text.trim(),
      i: input.imagePath ?? "",
      s: input.scheduledAt,
    }),
  );
}

export function getEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET || "dev-only-insecure-key";
  return createHash("sha256").update(raw).digest();
}

export function encrypt(plain: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decrypt(payload: string): string {
  const [v, ivH, tagH, dataH] = payload.split(":");
  if (v !== "v1") throw new Error("Неподдерживаемый формат секрета");
  const key = getEncryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivH, "hex"));
  decipher.setAuthTag(Buffer.from(tagH, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataH, "hex")), decipher.final()]);
  return dec.toString("utf8");
}

export function maskSecret(value: string | null | undefined): string {
  if (!value) return "";
  if (value.length < 8) return "••••";
  return `${value.slice(0, 3)}••••${value.slice(-2)}`;
}

export function moscowParts(date: Date | string = new Date()): {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  weekday: number;
  dateStr: string;
  timeStr: string;
} {
  const d = typeof date === "string" ? new Date(date) : date;
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: MOSCOW_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  const y = Number(parts.year);
  const m = Number(parts.month);
  const day = Number(parts.day);
  const hh = Number(parts.hour);
  const mm = Number(parts.minute);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    y,
    m,
    d: day,
    hh,
    mm,
    weekday: map[parts.weekday] ?? 0,
    dateStr: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    timeStr: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
  };
}

/** Build an ISO timestamp for a Moscow civil date + HH:MM. */
export function moscowSlotIso(dateStr: string, timeStr: string): string {
  const iso = `${dateStr}T${timeStr}:00+03:00`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Некорректный слот: ${dateStr} ${timeStr}`);
  return d.toISOString();
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  // dateStr is a civil date; adding calendar days via UTC date components is OK
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function formatMoscow(iso: string, withTime = true): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    hourCycle: "h23",
  }).format(d);
}

export function deriveSessionToken(): { id: string; hash: string } {
  const id = randomBytes(32).toString("hex");
  return { id, hash: sha256(id) };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith("scrypt:")) {
    const [, salt, hash] = stored.split(":");
    const check = scryptSync(password, salt, 32).toString("hex");
    return timingSafeEqual(hash, check);
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(s: string): number {
  const h = sha256(s).slice(0, 8);
  return Number.parseInt(h, 16);
}

export function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

export function shuffle<T>(rand: () => number, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
