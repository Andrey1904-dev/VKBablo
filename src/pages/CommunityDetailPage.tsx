import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "@/lib/api";
import { Badge, Button, Card, Field, Input } from "@/components/ui";

export default function CommunityDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<any>(null);
  const [token, setToken] = useState("");
  const [groupId, setGroupId] = useState("");
  const [schedule, setSchedule] = useState("13:30, 17:30, 21:30");
  const [msg, setMsg] = useState("");

  async function load() {
    const r = await api<any>(`/api/communities/${id}`);
    setData(r);
    setSchedule((r.community.schedule || []).join(", "));
    setGroupId(r.community.vkGroupId || "");
  }
  useEffect(() => {
    load();
  }, [id]);

  if (!data) return <p className="text-muted-fg">Загрузка…</p>;
  const c = data.community;

  async function saveSchedule() {
    const slots = schedule.split(",").map((s) => s.trim()).filter(Boolean);
    await api(`/api/communities/${id}`, { method: "PATCH", body: JSON.stringify({ schedule: slots, vkGroupId: groupId }) });
    setMsg("Расписание сохранено");
    load();
  }

  async function connectVk() {
    try {
      const r = await api<any>(`/api/communities/${id}/vk`, {
        method: "POST",
        body: JSON.stringify({ token, groupId }),
      });
      setMsg(r.testMode ? "Токен сохранён. В тестовом режиме реальные запросы к VK не отправляются." : "VK подключён");
      setToken("");
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-4">
        <img src={c.avatarUrl} className="h-16 w-16 rounded-2xl" alt="" />
        <div>
          <h1 className="text-2xl font-extrabold">{c.name}</h1>
          <p className="text-sm text-muted-fg">{c.tagline}</p>
        </div>
      </div>
      <p className="max-w-3xl text-sm leading-6">{c.description}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5 space-y-3">
          <h2 className="font-bold">Расписание (Москва)</h2>
          <Field label="Слоты через запятую">
            <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} />
          </Field>
          <Field label="VK Group ID">
            <Input value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="например 123456789" />
          </Field>
          <Button onClick={saveSchedule}>Сохранить</Button>
        </Card>
        <Card className="p-5 space-y-3">
          <h2 className="font-bold">Подключение VK</h2>
          <p className="text-sm text-muted-fg">
            Токен сообщества с правами wall, photos, offline. Не вставляйте токен в чат — только сюда. Хранится в зашифрованном виде и не отдаётся на клиент.
          </p>
          <Field label="Access token">
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button onClick={connectVk}>Сохранить токен</Button>
            <Badge className={c.vkConnected ? "bg-emerald-500/15 text-emerald-700" : "bg-muted text-muted-fg"}>
              {c.vkConnected ? "подключено" : "нет токена"}
            </Badge>
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="font-bold">Правила стиля</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-fg">
          {(c.styleRules?.notes || []).map((n: string) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <div className="mt-3 text-sm">Голос: {c.styleRules?.voice}</div>
      </Card>

      <Card className="p-5">
        <h2 className="font-bold">Персонажи</h2>
        <div className="mt-3 flex flex-wrap gap-2">
          {(data.characters || []).map((ch: any) => (
            <Link key={ch.id} to="/characters" className="rounded-full bg-muted px-3 py-1 text-sm">
              {ch.name} {ch.locked ? "🔒" : ""}
            </Link>
          ))}
          {data.characters?.length === 0 && <span className="text-sm text-muted-fg">Постоянных персонажей нет</span>}
        </div>
      </Card>
      {msg && <p className="text-sm text-muted-fg">{msg}</p>}
    </div>
  );
}
