import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { STATUS_LABEL, STATUS_TONE, COMMUNITY_COLOR } from "@/lib/api";
import { getBackend } from "@/data";
import { Badge, Button, Card } from "@/components/ui";
import { formatMoscow } from "@/lib/time";

import type { DashboardData } from "@shared/types";

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function load() {
    setData(await getBackend().dashboard());
  }
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  async function prepare() {
    setBusy(true);
    setMsg("");
    try {
      const r = await getBackend().prepareUpcoming();
      setMsg(`В очередь поставлено слотов: ${r.queued}. Генерация идёт в фоне.`);
      await getBackend().runWorker("tick");
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <p className="text-muted-fg">Загрузка панели…</p>;

  const kpis = [
    { label: "На проверке", value: data.pendingReview },
    { label: "Одобрено", value: data.ready },
    { label: "Запланировано", value: data.scheduled },
    { label: "Опубликовано", value: data.published },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Главная панель</h1>
          <p className="text-sm text-muted-fg">
            Режим: {data.mode === "test" ? "тестовый, без реальных публикаций VK" : "согласование + VK"}
            {data.automationPaused ? " · автоматизация на паузе" : ""}
          </p>
        </div>
        <Button onClick={prepare} disabled={busy}>
          {busy ? "Готовим…" : "Подготовить ближайшие слоты"}
        </Button>
      </div>

      {data.backend.kind !== "supabase" && (
        <Card className="border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          Supabase пока не подключён. {getBackend().info.kind === "demo" ? "Данные демонстрационные и не публикуются в VK." : "Работает локальный стенд."} Инструкция — в Настройках.
        </Card>
      )}
      {data.missedSlots > 0 && (
        <Card className="border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm">
          Пропущенных слотов за последние дни: {data.missedSlots}. Откройте календарь.
        </Card>
      )}
      {msg && <p className="text-sm text-muted-fg">{msg}</p>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => (
          <Card key={k.label} className="p-5">
            <div className="text-sm text-muted-fg">{k.label}</div>
            <div className="mt-2 text-3xl font-extrabold">{k.value}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="font-bold">Сообщества</h2>
          <div className="mt-4 space-y-3">
            {data.byCommunity.map((c) => (
              <Link key={c.id} to={`/communities/${c.id}`} className="flex items-center gap-3 rounded-xl p-2 hover:bg-muted">
                <span className="h-9 w-9 rounded-xl" style={{ background: c.color }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{c.name}</div>
                  <div className="text-xs text-muted-fg">
                    проверка {c.pending} · план {c.scheduled} · вышло {c.published}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="font-bold">Ближайшие публикации</h2>
          <div className="mt-4 space-y-3">
            {data.nextPosts.length === 0 && <p className="text-sm text-muted-fg">Пока пусто. Нажмите «Подготовить ближайшие слоты».</p>}
            {data.nextPosts.map((p) => (
              <Link key={p.id} to={`/posts/${p.id}`} className="flex items-center gap-3 rounded-xl p-2 hover:bg-muted">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: COMMUNITY_COLOR[p.communityId] }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{p.title || "Без названия"}</div>
                  <div className="text-xs text-muted-fg">{formatMoscow(p.scheduledAt)}</div>
                </div>
                <Badge className={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
              </Link>
            ))}
          </div>
        </Card>
      </div>
      <p className="text-xs text-muted-fg">
        Расход AI за месяц: ${data.spendUsdMonth.toFixed(2)} из ${data.spendLimitUsd}. Ошибки: {data.errors}.
      </p>
    </div>
  );
}
