import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, STATUS_LABEL, STATUS_TONE } from "@/lib/api";
import { Badge, Button, Card, Textarea } from "@/components/ui";
import { formatMoscow, fromDatetimeLocalMoscow, toDatetimeLocalMoscow } from "@/lib/time";

export default function PostDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [pack, setPack] = useState<any>(null);
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const [comment, setComment] = useState("");
  const [what, setWhat] = useState<"text" | "image" | "all">("all");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await api<any>(`/api/posts/${id}`);
    setPack(r);
    setText(r.post.text);
    setWhen(toDatetimeLocalMoscow(r.post.scheduledAt));
  }
  useEffect(() => {
    load();
  }, [id]);

  async function act(path: string, body?: unknown) {
    setBusy(true);
    setMsg("");
    try {
      await api(path, { method: "POST", body: body ? JSON.stringify(body) : "{}" });
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await api(`/api/posts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ text, scheduledAt: fromDatetimeLocalMoscow(when) }),
      });
      await load();
      setMsg("Сохранено. Если пост был одобрен, согласование сброшено.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(f: File) {
    const fd = new FormData();
    fd.append("file", f);
    fd.append("folder", "posts");
    const up = await api<{ path: string }>("/api/uploads", { method: "POST", body: fd });
    await api(`/api/posts/${id}`, { method: "PATCH", body: JSON.stringify({ imagePath: up.path }) });
    load();
  }

  if (!pack) return <p className="text-muted-fg">Загрузка…</p>;
  const p = pack.post;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] animate-fade-in">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button className="text-sm text-muted-fg" onClick={() => nav(-1)}>← Назад</button>
          <Badge className={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
          {p.testMode && <Badge className="bg-amber-500/15 text-amber-700">dry-run</Badge>}
        </div>
        <h1 className="text-2xl font-extrabold">{p.title || p.topic}</h1>
        <p className="text-sm text-muted-fg">{formatMoscow(p.scheduledAt)} · {p.communityId} · версия {p.version}</p>
        {(pack.imageUrl || p.imagePath) && (
          <img src={pack.imageUrl || p.imagePath} alt="" className="w-full rounded-2xl border border-line" />
        )}
        <label className="block">
          <span className="text-sm text-muted-fg">Заменить изображение</span>
          <input type="file" accept="image/*" className="mt-1 block text-sm" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </label>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} className="min-h-[280px]" />
        <label className="block text-sm text-muted-fg">
          Время (Москва)
          <input type="datetime-local" className="mt-1 h-11 w-full rounded-xl border border-line bg-card px-3" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={save}>Сохранить правки</Button>
          <Button disabled={busy} onClick={() => act(`/api/posts/${id}/approve`, { comment })}>Одобрить</Button>
          <Button variant="soft" disabled={busy} onClick={() => act(`/api/posts/${id}/regenerate`, { what })}>Переделать</Button>
          <Button variant="outline" disabled={busy} onClick={() => act(`/api/posts/${id}/revise`, { what, comment })}>На доработку</Button>
          <Button variant="danger" disabled={busy} onClick={() => act(`/api/posts/${id}/reject`, { comment })}>Отклонить</Button>
          <Button variant="outline" disabled={busy} onClick={() => act(`/api/posts/${id}/schedule`)}>Запланировать в VK</Button>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {(["text", "image", "all"] as const).map((w) => (
            <button key={w} onClick={() => setWhat(w)} className={`rounded-full px-3 py-1 ${what === w ? "bg-accent text-white" : "bg-muted"}`}>
              {w === "text" ? "только текст" : w === "image" ? "только картинка" : "всё"}
            </button>
          ))}
        </div>
        <input className="h-11 w-full rounded-xl border border-line bg-card px-3 text-sm" placeholder="Комментарий к решению" value={comment} onChange={(e) => setComment(e.target.value)} />
        {msg && <p className="text-sm text-rose-600 dark:text-rose-300">{msg}</p>}
        {p.errorMessage && <Card className="border-rose-500/30 bg-rose-500/10 p-3 text-sm">{p.errorMessage}</Card>}
        {p.similarityScore && p.similarityScore > 0.4 && (
          <Card className="border-amber-500/30 bg-amber-500/10 p-3 text-sm">Похожесть на прошлый пост: {Math.round(p.similarityScore * 100)}%</Card>
        )}
      </div>
      <div className="space-y-4">
        <Card className="p-4">
          <div className="text-xs font-semibold text-muted-fg">Предпросмотр стены</div>
          <div className="mt-3 rounded-2xl border border-line p-4">
            <div className="flex items-center gap-2 text-sm font-bold">{p.communityId}</div>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{p.text}</p>
          </div>
        </Card>
        <Card className="p-4">
          <h3 className="font-bold">История версий</h3>
          <ul className="mt-3 space-y-2 text-sm text-muted-fg">
            {(pack.versions || []).map((v: any) => (
              <li key={v.id}>v{v.version} · {v.reason} · {formatMoscow(v.created_at)}</li>
            ))}
          </ul>
        </Card>
        <Card className="p-4">
          <h3 className="font-bold">Согласования</h3>
          <ul className="mt-3 space-y-2 text-sm text-muted-fg">
            {(pack.approvals || []).map((a: any) => (
              <li key={a.id}>{a.action} · {formatMoscow(a.created_at)}</li>
            ))}
            {(!pack.approvals || pack.approvals.length === 0) && <li>Ещё не было решений</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
