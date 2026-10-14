import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Button, Card } from "@/components/ui";
import { COMMUNITY_IDS } from "@shared/types";

function nextSlotIso(time = "13:30") {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value;
  const date = `${g("year")}-${g("month")}-${g("day")}`;
  const tomorrow = new Date(`${date}T00:00:00+03:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const y = tomorrow.getFullYear();
  const m = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const d = String(tomorrow.getDate()).padStart(2, "0");
  return new Date(`${y}-${m}-${d}T${time}:00+03:00`).toISOString();
}

export default function StudioPage() {
  const [communityId, setCommunityId] = useState<(typeof COMMUNITY_IDS)[number]>("stories");
  const [ideas, setIdeas] = useState<any[]>([]);
  const [post, setPost] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [provider, setProvider] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/ai/providers").then(setProvider);
    api<{ generations: any[] }>("/api/ai/history").then((r) => setHistory(r.generations));
  }, []);

  async function loadIdeas() {
    setBusy("ideas");
    setError("");
    try {
      const r = await api<{ ideas: any[] }>("/api/ai/ideas", {
        method: "POST",
        body: JSON.stringify({ communityId }),
      });
      setIdeas(r.ideas);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy("");
    }
  }

  async function generate(time = "13:30") {
    setBusy("gen");
    setError("");
    try {
      const r = await api<{ post: any }>("/api/ai/generate-slot", {
        method: "POST",
        body: JSON.stringify({ communityId, scheduledAt: nextSlotIso(time), force: true }),
      });
      setPost(r.post);
      const h = await api<{ generations: any[] }>("/api/ai/history");
      setHistory(h.generations);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px] animate-fade-in">
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-extrabold">ИИ-студия</h1>
          <p className="text-sm text-muted-fg">
            Идеи, текст и изображение. Если ключ AI не задан — работает тестовый движок, это явно не «боевая» модель.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {COMMUNITY_IDS.map((id) => (
            <Button key={id} size="sm" variant={communityId === id ? "primary" : "outline"} onClick={() => setCommunityId(id)}>
              {id}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={loadIdeas} disabled={!!busy}>{busy === "ideas" ? "…" : "Сгенерировать идеи"}</Button>
          <Button variant="soft" onClick={() => generate("13:30")} disabled={!!busy}>
            {busy === "gen" ? "Генерация…" : "Полный пост на завтра 13:30"}
          </Button>
        </div>
        {error && <Card className="border-rose-500/30 bg-rose-500/10 p-3 text-sm">{error}</Card>}
        {provider && (
          <p className="text-xs text-muted-fg">
            Провайдер: {provider.label}. Референсы персонажей: {provider.supportsReferences ? "да" : "выбранный движок не обещает точное сходство"}.
            Ключ: {provider.configuredKey ? "задан" : "нет"}.
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {ideas.map((idea) => (
            <Card key={idea.key} className="p-4">
              <div className="text-xs text-muted-fg">{idea.series || "идея"}</div>
              <div className="font-bold">{idea.title}</div>
              <p className="mt-2 text-sm text-muted-fg">{idea.angle}</p>
            </Card>
          ))}
        </div>
        {post && (
          <Card className="p-5 space-y-3">
            <div className="flex justify-between gap-2">
              <h2 className="font-bold">{post.title}</h2>
              <Link className="text-sm text-accent" to={`/posts/${post.id}`}>Открыть карточку →</Link>
            </div>
            {post.imagePath && <img src={post.imagePath} className="max-h-80 w-full rounded-xl object-cover" alt="" />}
            <p className="whitespace-pre-wrap text-sm leading-6">{post.text}</p>
            {post.generationMeta?.warnings?.length > 0 && (
              <ul className="text-xs text-amber-700">
                {post.generationMeta.warnings.map((w: string) => <li key={w}>{w}</li>)}
              </ul>
            )}
          </Card>
        )}
      </div>
      <Card className="p-4 h-fit">
        <h2 className="font-bold">История генераций</h2>
        <ul className="mt-3 space-y-3 text-sm">
          {history.map((g) => (
            <li key={g.id} className="border-b border-line pb-2">
              <div className="font-medium">{g.type} · {g.provider}</div>
              <div className="text-xs text-muted-fg">{g.status} · ${Number(g.cost_usd || 0).toFixed(3)}</div>
              {g.error && <div className="text-xs text-rose-600">{g.error}</div>}
            </li>
          ))}
          {history.length === 0 && <li className="text-muted-fg">Пока пусто</li>}
        </ul>
      </Card>
    </div>
  );
}
