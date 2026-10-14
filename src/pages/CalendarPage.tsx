import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, STATUS_LABEL, STATUS_TONE, COMMUNITY_COLOR } from "@/lib/api";
import { Badge, Button, Card } from "@/components/ui";
import { formatMoscow } from "@/lib/time";
import { COMMUNITY_IDS } from "@shared/types";

type View = "day" | "week" | "month";

export default function CalendarPage() {
  const [view, setView] = useState<View>("week");
  const [posts, setPosts] = useState<any[]>([]);
  const [missed, setMissed] = useState<any[]>([]);
  const [anchor, setAnchor] = useState(new Date());

  async function load() {
    const r = await api<{ posts: any[]; missed: any[] }>("/api/calendar");
    setPosts(r.posts);
    setMissed(r.missed || []);
  }
  useEffect(() => {
    load();
  }, []);

  const days = useMemo(() => {
    const start = new Date(anchor);
    if (view === "day") return [start];
    if (view === "week") {
      const d = new Date(start);
      const wd = (d.getDay() + 6) % 7;
      d.setDate(d.getDate() - wd);
      return Array.from({ length: 7 }, (_, i) => {
        const x = new Date(d);
        x.setDate(d.getDate() + i);
        return x;
      });
    }
    const first = new Date(start.getFullYear(), start.getMonth(), 1);
    const wd = (first.getDay() + 6) % 7;
    const gridStart = new Date(first);
    gridStart.setDate(1 - wd);
    return Array.from({ length: 42 }, (_, i) => {
      const x = new Date(gridStart);
      x.setDate(gridStart.getDate() + i);
      return x;
    });
  }, [anchor, view]);

  function key(d: Date) {
    return d.toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
  }

  function postsOn(d: Date) {
    const k = key(d);
    return posts.filter((p) => formatMoscow(p.scheduledAt, false).includes("") && new Date(p.scheduledAt).toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" }) === k);
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold">Календарь</h1>
          <p className="text-sm text-muted-fg">Все слоты — Europe/Moscow. Цвета = сообщества.</p>
        </div>
        <div className="flex gap-2">
          {(["day", "week", "month"] as View[]).map((v) => (
            <Button key={v} size="sm" variant={view === v ? "primary" : "outline"} onClick={() => setView(v)}>
              {v === "day" ? "День" : v === "week" ? "Неделя" : "Месяц"}
            </Button>
          ))}
        </div>
      </div>
      {missed.length > 0 && (
        <Card className="border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          Пропущенные слоты: {missed.length}. Они не публикуются задним числом.
        </Card>
      )}
      <div className="flex flex-wrap gap-3 text-xs">
        {COMMUNITY_IDS.map((id) => (
          <span key={id} className="inline-flex items-center gap-1">
            <i className="h-2 w-2 rounded-full" style={{ background: COMMUNITY_COLOR[id] }} /> {id}
          </span>
        ))}
      </div>
      <div className={view === "month" ? "grid grid-cols-7 gap-2" : "grid gap-3 md:grid-cols-2 xl:grid-cols-4"}>
        {days.map((d) => {
          const list = postsOn(d);
          return (
            <Card key={d.toISOString()} className="p-3">
              <div className="text-sm font-bold">
                {d.toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow", weekday: "short", day: "numeric", month: "short" })}
              </div>
              <div className="mt-2 space-y-1">
                {list.map((p) => (
                  <Link key={p.id} to={`/posts/${p.id}`} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-muted">
                    <span className="h-2 w-2 rounded-full" style={{ background: COMMUNITY_COLOR[p.communityId] }} />
                    <span className="flex-1 truncate text-xs">{p.title || p.topic}</span>
                    <Badge className={`${STATUS_TONE[p.status]} !text-[10px]`}>{STATUS_LABEL[p.status]}</Badge>
                  </Link>
                ))}
                {list.length === 0 && <div className="text-xs text-muted-fg">Нет постов</div>}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
