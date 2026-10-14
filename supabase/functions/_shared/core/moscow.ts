// ВНИМАНИЕ: файл сгенерирован из shared/ командой `npm run sync:shared`.
// Правки вносите в источник: shared/<имя>.ts
/**
 * Московское время и слоты расписания.
 * Все даты в базе — UTC (timestamptz), отображение и планирование — Europe/Moscow.
 */
export const MOSCOW_TZ = "Europe/Moscow" as const;
export const MOSCOW_OFFSET = "+03:00";
export const DEFAULT_SLOTS = ["13:30", "17:30", "21:30"] as const;

export interface MoscowParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  weekday: number; // 1 = Mon … 7 = Sun
  dateStr: string; // YYYY-MM-DD (МСК)
  timeStr: string; // HH:MM (МСК)
}

const WEEKDAY_MAP: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function moscowParts(date: Date | string = new Date()): MoscowParts {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) throw new Error(`Некорректная дата: ${String(date)}`);
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
  return {
    y,
    m,
    d: day,
    hh,
    mm,
    weekday: WEEKDAY_MAP[parts.weekday ?? ""] ?? 0,
    dateStr: `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    timeStr: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
  };
}

/** ISO (UTC) для московской календарной даты и времени ЧЧ:ММ. */
export function moscowSlotIso(dateStr: string, timeStr: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error(`Некорректная дата: ${dateStr}`);
  if (!/^\d{2}:\d{2}$/.test(timeStr)) throw new Error(`Некорректное время: ${timeStr}`);
  const d = new Date(`${dateStr}T${timeStr}:00${MOSCOW_OFFSET}`);
  if (Number.isNaN(d.getTime())) throw new Error(`Некорректный слот: ${dateStr} ${timeStr}`);
  return d.toISOString();
}

export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(
    dt.getUTCDate(),
  ).padStart(2, "0")}`;
}

export function isValidSlotTime(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [h, m] = value.split(":").map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

export function normalizeSlots(slots: unknown): string[] {
  const list = Array.isArray(slots) ? slots : DEFAULT_SLOTS;
  const out = list
    .map((s) => String(s).trim())
    .filter(isValidSlotTime)
    .sort();
  return out.length ? Array.from(new Set(out)) : [...DEFAULT_SLOTS];
}

export function formatMoscow(iso?: string | null, withTime = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW_TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
  }).format(d);
}

/** YYYY-MM-DD в МСК для произвольного ISO. */
export function moscowDateKey(iso: string | Date): string {
  return moscowParts(iso).dateStr;
}

export function toDatetimeLocalMoscow(iso: string): string {
  const p = moscowParts(iso);
  return `${p.dateStr}T${p.timeStr}`;
}

export function fromDatetimeLocalMoscow(value: string): string {
  return new Date(`${value}:00${MOSCOW_OFFSET}`).toISOString();
}

export interface SlotPlan {
  communityId: string;
  scheduledAt: string;
}

export interface SlotSpec {
  communityId: string;
  schedule: string[];
  active?: boolean;
}

/**
 * Слоты в окне [now, now + hoursAhead] для активных сообществ.
 * Детерминированно и без дублей — используется планировщиком, локальным API и UI.
 */
export function upcomingSlots(specs: SlotSpec[], hoursAhead: number, now: Date = new Date()): SlotPlan[] {
  const start = moscowParts(now);
  const days = Math.max(2, Math.ceil(Math.max(hoursAhead, 1) / 24) + 1);
  const horizon = now.getTime() + hoursAhead * 3600 * 1000;
  const out: SlotPlan[] = [];
  const seen = new Set<string>();
  for (let i = 0; i <= days; i++) {
    const dateStr = addDays(start.dateStr, i);
    for (const spec of specs) {
      if (spec.active === false) continue;
      for (const t of normalizeSlots(spec.schedule)) {
        const iso = moscowSlotIso(dateStr, t);
        const ts = new Date(iso).getTime();
        if (ts <= now.getTime() || ts > horizon) continue;
        const key = `${spec.communityId}:${iso}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ communityId: spec.communityId, scheduledAt: iso });
      }
    }
  }
  return out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/** Слоты за прошедшие сутки, для которых нет публикации — пропущенные запуски. */
export function missedSlots(
  specs: SlotSpec[],
  existing: SlotPlan[],
  now: Date = new Date(),
  lookbackDays = 2,
): SlotPlan[] {
  const start = moscowParts(now);
  const have = new Set(existing.map((e) => `${e.communityId}:${e.scheduledAt}`));
  const out: SlotPlan[] = [];
  for (let i = -lookbackDays; i <= 0; i++) {
    const dateStr = addDays(start.dateStr, i);
    for (const spec of specs) {
      if (spec.active === false) continue;
      for (const t of normalizeSlots(spec.schedule)) {
        const iso = moscowSlotIso(dateStr, t);
        if (new Date(iso).getTime() >= now.getTime()) continue;
        if (have.has(`${spec.communityId}:${iso}`)) continue;
        out.push({ communityId: spec.communityId, scheduledAt: iso });
      }
    }
  }
  return out.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

/** Ключ идемпотентности слота — защита от повторных заданий. */
export function slotKey(communityId: string, scheduledAt: string): string {
  return `slot:${communityId}:${canonicalUtcSafe(scheduledAt)}`;
}

function canonicalUtcSafe(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString();
}
