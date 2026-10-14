import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getBackend } from "@/data";
import { Button, Card } from "@/components/ui";
import { formatMoscow } from "@/lib/time";

export default function NotificationsPage() {
  const [items, setItems] = useState<any[]>([]);

  async function load() {
    const r = await getBackend().notifications();
    setItems(r.items);
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-5 animate-fade-in max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-extrabold">Уведомления</h1>
        <Button variant="outline" size="sm" onClick={() => getBackend().markNotificationsRead().then(load)}>
          Прочитать все
        </Button>
      </div>
      <div className="space-y-2">
        {items.map((n) => (
          <Card key={n.id} className={`p-4 ${n.read ? "opacity-70" : ""}`}>
            <div className="text-xs text-muted-fg">{n.type} · {formatMoscow(n.createdAt)}</div>
            <div className="font-bold">{n.title}</div>
            <p className="text-sm text-muted-fg">{n.message}</p>
            {n.link && <Link className="text-sm text-accent" to={n.link}>Открыть</Link>}
          </Card>
        ))}
        {items.length === 0 && <p className="text-sm text-muted-fg">Пока тихо.</p>}
      </div>
    </div>
  );
}
