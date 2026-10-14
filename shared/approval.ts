/**
 * Гейт одобрения — серверный инвариант, продублированный на клиенте только для UX.
 * Источник истины: PostgreSQL (`app.content_hash`, триггер `posts_sync_hash`) и Edge Functions.
 */
import { contentHash, type ContentHashInput } from "./hash.ts";
import { POST_STATUSES, type PostStatus } from "./types.ts";

export interface ApprovalCandidate {
  communityId: string;
  text: string;
  imagePath: string | null;
  scheduledAt: string;
  status: PostStatus;
  approvedHash?: string | null;
}

export const APPROVABLE_STATUSES: PostStatus[] = ["review", "needs_revision", "draft", "approved"];

export function isApprovable(status: PostStatus): boolean {
  return APPROVABLE_STATUSES.includes(status);
}

export function isPostStatus(value: unknown): value is PostStatus {
  return typeof value === "string" && (POST_STATUSES as readonly string[]).includes(value);
}

export function hashOf(input: ApprovalCandidate | ContentHashInput): string {
  return contentHash({
    communityId: input.communityId,
    text: input.text,
    imagePath: input.imagePath,
    scheduledAt: input.scheduledAt,
  });
}

/** Одобрение действительно только для текущей версии контента. */
export function approvalMatches(post: ApprovalCandidate): boolean {
  if (!post.approvedHash) return false;
  return hashOf(post) === post.approvedHash;
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

export function canApprove(post: ApprovalCandidate): GuardResult {
  if (!isApprovable(post.status)) return { ok: false, reason: "Эту публикацию нельзя одобрить в текущем статусе" };
  if (!post.text.trim()) return { ok: false, reason: "Пустой текст нельзя одобрить" };
  if (!post.imagePath) return { ok: false, reason: "Нужно изображение" };
  if (!post.scheduledAt) return { ok: false, reason: "Не задано время публикации" };
  return { ok: true };
}

/** Отправка/планирование в VK возможны только при действующем одобрении. */
export function canSchedule(post: ApprovalCandidate, opts?: { automationPaused?: boolean }): GuardResult {
  if (opts?.automationPaused) return { ok: false, reason: "Автоматизация на паузе" };
  if (!["approved", "scheduled"].includes(post.status)) {
    return { ok: false, reason: "Статус не позволяет отправку в VK" };
  }
  if (!post.approvedHash) return { ok: false, reason: "Публикация без одобрения невозможна" };
  if (!approvalMatches(post)) return { ok: false, reason: "Одобрение не соответствует текущей версии контента" };
  if (new Date(post.scheduledAt).getTime() < Date.now() + 60_000) {
    return { ok: false, reason: "Время публикации уже прошло или слишком близко" };
  }
  return { ok: true };
}

/** Изменились ли поля, влияющие на одобрение. */
export function isMaterialChange(
  before: Pick<ApprovalCandidate, "communityId" | "text" | "imagePath" | "scheduledAt">,
  after: Pick<ApprovalCandidate, "communityId" | "text" | "imagePath" | "scheduledAt">,
): boolean {
  return hashOf(before) !== hashOf(after);
}

/** Человекочитаемый список того, что сбросит одобрение. */
export const APPROVAL_RESET_FIELDS = [
  "текст",
  "изображение",
  "время публикации",
  "сообщество",
] as const;

export function nextStatusAfterEdit(current: PostStatus): PostStatus {
  return ["approved", "scheduled"].includes(current) ? "review" : current;
}
