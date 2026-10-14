import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, STATUS_LABEL, STATUS_TONE, COMMUNITY_COLOR } from "@/lib/api";
import { Badge, Card } from "@/components/ui";
import { formatMoscow } from "@/lib/time";

const STATUSES = ["", "review", "needs_revision", "approved", "scheduled", "published", "error", "draft", "rejected"];
const COMM = ["", "stories", "milana", "life", "veronica"];

export default function PostsPage() {
  const [posts, setPosts] = useState<any[]>([]);
  const [status, setStatus] = useState("");
  const [communityId, setCommunityId] = useState("");
  const [q, setQ] = useState("");

  async function load() {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (communityId) p.set("communityId", communityId);
    if (q) p.set("q", q);
    const r = await api<{ posts: any[] }>(`/api/posts?${p.toString()}`);
    setPosts(r.posts);
  }
  useEffect(() => {
    load();
  }, [status, communityId]);

  return (
    <div className="space-y-5 animate-fade-in">
      <div>
        <h1 className="text-2xl font-extrabold">Публикации</h1>
        <p className="text-sm text-muted-fg">Фильтры, предпросмотр и согласование.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <select className="h-11 rounded-xl border border-line bg-card px-3 text-sm" value={communityId} onChange={(e) => setCommunityId(e.target.value)}>
          {COMM.map((id) => (
            <option key={id} value={id}>{id || "Все сообщества"}</option>
          ))}
        </select>
        <select className="h-11 rounded-xl border border-line bg-card px-3 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s ? STATUS_LABEL[s] : "Все статусы"}</option>
          ))}
        </select>
        <input
          className="h-11 flex-1 min-w-[180px] rounded-xl border border-line bg-card px-3 text-sm"
          placeholder="Поиск по тексту"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {posts.map((p) => (
          <Link key={p.id} to={`/posts/${p.id}`}>
            <Card className="overflow-hidden transition hover:shadow-lift">
              {p.imagePath && (
                <div className="aspect-[16/10] bg-muted">
                  <img src={p.imagePath} alt="" className="h-full w-full object-cover" />
                </div>
              )}
              <div className="space-y-2 p-4">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: COMMUNITY_COLOR[p.communityId] }} />
                  <span className="text-xs text-muted-fg">{p.communityId}</span>
                  <Badge className={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
                </div>
                <div className="font-bold">{p.title || p.topic}</div>
                <p className="line-clamp-3 text-sm text-muted-fg">{p.text}</p>
                <div className="text-xs text-muted-fg">{formatMoscow(p.scheduledAt)}</div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
      {posts.length === 0 && <p className="text-sm text-muted-fg">Нет публикаций по фильтру.</p>}
    </div>
  );
}
