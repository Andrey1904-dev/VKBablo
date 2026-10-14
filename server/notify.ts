import { all, get, run, setting } from "./db.ts";
import { nid, nowIso } from "./lib.ts";
import type { NotificationItem } from "../shared/types.ts";

export function notify(input: {
  type: NotificationItem["type"];
  title: string;
  message: string;
  link?: string | null;
}) {
  if (setting("notifications_enabled", "1") === "0") return;
  run(
    `INSERT INTO notifications (id, type, title, message, link, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`,
    nid("nt"),
    input.type,
    input.title,
    input.message,
    input.link ?? null,
    nowIso(),
  );
}

export function listNotifications(unreadOnly = false, limit = 50): NotificationItem[] {
  const rows = all<{
    id: string;
    type: NotificationItem["type"];
    title: string;
    message: string;
    link: string | null;
    read: number;
    created_at: string;
  }>(
    `SELECT * FROM notifications ${unreadOnly ? "WHERE read = 0" : ""} ORDER BY created_at DESC LIMIT ?`,
    limit,
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    message: r.message,
    link: r.link,
    read: !!r.read,
    createdAt: r.created_at,
  }));
}

export function unreadCount(): number {
  return get<{ c: number }>("SELECT COUNT(*) AS c FROM notifications WHERE read = 0")?.c ?? 0;
}

export function markRead(id?: string) {
  if (id) run("UPDATE notifications SET read = 1 WHERE id = ?", id);
  else run("UPDATE notifications SET read = 1");
}

export function audit(input: {
  userId?: number | null;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: unknown;
  ip?: string | null;
}) {
  run(
    `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, details, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    nid("aud"),
    input.userId ?? null,
    input.action,
    input.entityType ?? null,
    input.entityId ?? null,
    input.details ? JSON.stringify(input.details) : null,
    input.ip ?? null,
    nowIso(),
  );
}
