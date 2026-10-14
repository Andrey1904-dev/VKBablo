/**
 * Проверка правил сообщества и запрещённых тем. Изоморфно (browser / Deno / Node).
 * Правила самих сообществ утверждаются владельцем — здесь только валидация текста.
 */
import type { CommunityId } from "./types.ts";
import { COMMUNITY_IDS } from "./types.ts";

export interface RuleViolation {
  code: string;
  message: string;
  severity: "error" | "warning";
}

const BANNED_18_PLUS = [
  "эротик",
  "эротич",
  "nude",
  "нагишом",
  "голая",
  "голый",
  "18+",
  "секс",
  "porn",
  "nsfw",
  "интим-услуг",
];

const FORBIDDEN_CITIES = [
  "москв",
  "питер",
  "санкт-петербург",
  "екатеринбург",
  "новосибир",
  "казан",
  "сочи",
  "краснодар",
  "ростов",
  "самар",
  "уфа",
  "омск",
  "челябин",
  "воронеж",
  "перм",
];

const TOXIC_PATTERNS = [
  "все мужики",
  "все бабы",
  "все женщины такие",
  "все мужчины такие",
  "ненавижу мужиков",
  "тупые бабы",
];

export function ruleCheck(communityId: CommunityId, text: string): string[] {
  return validateCommunityText(communityId, text).map((v) => v.message);
}

export function validateCommunityText(communityId: CommunityId, text: string): RuleViolation[] {
  const out: RuleViolation[] = [];
  const lower = text.toLowerCase();
  const push = (code: string, message: string, severity: RuleViolation["severity"] = "warning") =>
    out.push({ code, message, severity });

  for (const b of BANNED_18_PLUS) {
    if (lower.includes(b)) push("forbidden_18_plus", "Запрещённый контент 18+", "error");
  }
  for (const t of TOXIC_PATTERNS) {
    if (lower.includes(t)) push("toxic_generalization", "Обобщение, унижающее группу людей", "error");
  }
  if (communityId === "veronica") {
    if (FORBIDDEN_CITIES.some((c) => lower.includes(c))) {
      push("city_mentioned", "Нельзя указывать город проживания Вероники", "error");
    }
    if (!text.includes("?")) push("no_question", "Нет вопроса аудитории");
    if (/\bменяй?.../i.test(text)) push("bio_drift", "Похоже на смену биографии персонажа", "error");
  }
  if (communityId === "milana" && !/милан/i.test(text)) push("no_heroine", "В тексте нет Миланы");
  if (communityId === "life") {
    if (/\d{2,}\s*%/.test(text)) push("fake_stats", "Похоже на выдуманную статистику — не выдавать за факт");
    if (/\b\d{1,3}\s*(тыс|млн)\b/i.test(text) && !/например|условно|примерно/i.test(text)) {
      push("unverified_numbers", "Цифры без пометки «условно» могут читаться как факт");
    }
  }
  if (text.trim().length < 120) push("too_short", "Текст слишком короткий");
  if (text.trim().length > 1800) push("too_long", "Текст длиннее комфортного формата стены");
  if (out.length === 0) return [];
  return out;
}

export function hasBlockingViolation(violations: RuleViolation[]): boolean {
  return violations.some((v) => v.severity === "error");
}

export function isCommunityId(value: unknown): value is CommunityId {
  return typeof value === "string" && (COMMUNITY_IDS as readonly string[]).includes(value);
}

/** Запрещённые темы сообщества (из community_rules.forbidden_topics). */
export function matchesForbiddenTopic(text: string, forbiddenTopics: readonly string[]): string | null {
  const lower = text.toLowerCase();
  for (const t of forbiddenTopics) {
    const needle = t.trim().toLowerCase();
    if (needle.length > 2 && lower.includes(needle)) return t;
  }
  return null;
}
