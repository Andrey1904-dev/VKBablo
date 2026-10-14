import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getBackend } from "@/data";
import { Button, Empty, PageHead } from "@/components/ui";
import { formatMoscow } from "@/lib/time";
import type { NotificationItem } from "@shared/types";
import { Bell, BellRing, Check, ChevronRight, CircleAlert, Send, Sparkles } from "lucide-react";

const ICONS: Record<string, typeof Bell> = {
  review: BellRing,
  generation_error: CircleAlert,
  publish_error: CircleAlert,
  scheduled: Send,
  published: Check,
  missed_slot: CircleAlert,
  vk_connection: Bell,
  system: Sparkles,
};

export default function NotificationsPage() {
  const [items, setItems] = useState<NotificationItem[]>([]);

  async function load() {
    const r = await getBackend().notifications();
    setItems(r.items);
  }
  useEffect(() => {
    load();
  }, []);

  const unread = items.filter((n) => !n.read).length;

  return (
    <div className="page enter">
      <PageHead
        title="Уведомления"
        description="Важные обновления рабочего пространства."
        actions={
          <Button variant="secondary" onClick={() => getBackend().markNotificationsRead().then(load)} disabled={unread === 0}>
            <Check size={15} /> Прочитать все
          </Button>
        }
      />
      {items.length === 0 ? (
        <div className="surface">
          <Empty icon={Bell} title="Пока всё спокойно" text="Новых уведомлений нет." />
        </div>
      ) : (
        <div className="notif-list">
          {items.map((n) => {
            const Icon = ICONS[n.type] ?? Bell;
            return (
              <div key={n.id} className={`notif surface ${n.read ? "read" : ""}`}>
                <span className={`attention-icon ${n.type.includes("error") || n.type === "missed_slot" ? "warning" : ""}`}>
                  <Icon size={17} />
                </span>
                <div className="notif-body">
                  <span className="mono">
                    {n.type} · {formatMoscow(n.createdAt)}
                  </span>
                  <b>{n.title}</b>
                  <p>{n.message}</p>
                  {n.link && (
                    <Link className="text-btn" to={n.link}>
                      Открыть <ChevronRight size={13} />
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
