import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getBackend } from "@/data";
import { COMMUNITY_META } from "@shared/constants";
import { Badge, Button, Field, Input, PageHead } from "@/components/ui";
import { CommunityAvatar } from "@/components/layout";
import { toast } from "@/components/toast";
import { STATUS_LABEL } from "@/lib/api";
import type { CommunityDetail as CommunityDetailPayload } from "@/data";
import { CalendarDays, KeyRound, Link2, ScrollText, Users } from "lucide-react";

export default function CommunityDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<CommunityDetailPayload | null>(null);
  const [token, setToken] = useState("");
  const [groupId, setGroupId] = useState("");
  const [schedule, setSchedule] = useState("13:30, 17:30, 21:30");
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await getBackend().community(id!);
    setData(r);
    setSchedule((r.community.schedule || []).join(", "));
    setGroupId(r.community.vkGroupId || "");
  }
  useEffect(() => {
    load();
  }, [id]);

  if (!data) {
    return (
      <div className="page enter">
        <p style={{ color: "var(--muted)", fontSize: 12 }}>Загрузка…</p>
      </div>
    );
  }
  const c = data.community;
  const meta = COMMUNITY_META[c.id];

  async function saveSchedule() {
    setBusy(true);
    try {
      const slots = schedule.split(",").map((s) => s.trim()).filter(Boolean);
      await getBackend().updateCommunity(id!, { schedule: slots, vkGroupId: groupId });
      toast("Расписание сохранено");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    } finally {
      setBusy(false);
    }
  }

  async function connectVk() {
    setBusy(true);
    try {
      const r = await getBackend().connectVk(id!, token, groupId);
      toast(
        r.testMode
          ? "Токен сохранён. В тестовом режиме реальные запросы к VK не отправляются."
          : r.verified
            ? `VK подключён: ${r.groupName ?? "группа"}`
            : "Токен сохранён, но ещё не проверен",
      );
      setToken("");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    } finally {
      setBusy(false);
    }
  }

  const statusEntries = Object.entries(data.stats ?? {});

  return (
    <div className="page enter">
      <PageHead
        title={c.name}
        description={c.tagline}
        actions={
          <>
            <Badge tone={c.vkConnected ? "success" : "neutral"}>{c.vkConnected ? "VK подключён" : "VK не подключён"}</Badge>
            <Badge tone={c.status === "active" ? "purple" : "warning"}>{c.status === "active" ? "активно" : "пауза"}</Badge>
          </>
        }
      />

      <section className="surface comm-hero" style={{ marginBottom: 15 }}>
        <span className="cover-glow" style={{ background: c.color }} />
        <CommunityAvatar id={c.id} size="lg" />
        <div style={{ position: "relative" }}>
          <h1>{c.name}</h1>
          <p>{c.description}</p>
          <div className="badges">
            <Badge tone="neutral">
              <CalendarDays size={11} /> Слоты: {(c.schedule ?? []).join(" · ") || "—"} МСК
            </Badge>
            <Badge tone="neutral">
              <Link2 size={11} /> VK ID: {c.vkGroupId || "не задан"}
            </Badge>
            <Badge tone="neutral">
              <Users size={11} /> Персонажей: {data.characters?.length ?? 0}
            </Badge>
          </div>
        </div>
      </section>

      <div className="detail-grid">
        <section className="surface">
          <div className="section-head">
            <div>
              <h2>Расписание (Москва)</h2>
              <p>Стандарт — 13:30, 17:30, 21:30. Итого 3 поста в день на сообщество</p>
            </div>
            <CalendarDays size={16} style={{ color: "var(--muted)" }} />
          </div>
          <Field label="Слоты через запятую">
            <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="13:30, 17:30, 21:30" />
          </Field>
          <Field label="VK Group ID">
            <Input value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="например 123456789" />
          </Field>
          <div className="settings-save" style={{ marginTop: 8 }}>
            <Button onClick={saveSchedule} disabled={busy}>
              Сохранить
            </Button>
          </div>
        </section>

        <section className="surface">
          <div className="section-head">
            <div>
              <h2>Подключение VK</h2>
              <p>Токен сообщества с правами wall, photos, offline</p>
            </div>
            <KeyRound size={16} style={{ color: "var(--muted)" }} />
          </div>
          <p className="settings-note" style={{ marginTop: 10 }}>
            Не вставляйте токен в чат — только в это поле. Хранится в зашифрованном виде и никогда не отдаётся в браузер
            обратно. В тестовом режиме сохранение не вызывает реальных обращений к VK.
          </p>
          <Field label="Access token">
            <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="токен сообщества" />
          </Field>
          <div className="settings-save" style={{ marginTop: 8 }}>
            <Button onClick={connectVk} disabled={busy || !token}>
              Сохранить токен
            </Button>
          </div>
        </section>

        <section className="surface">
          <div className="section-head">
            <div>
              <h2>Правила стиля</h2>
              <p>Согласованы владельцем, изменению через интерфейс не подлежат</p>
            </div>
            <ScrollText size={16} style={{ color: "var(--muted)" }} />
          </div>
          <ul className="rule-list">
            {(c.styleRules?.notes ?? []).map((n: string) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p style={{ marginTop: 12, fontSize: 11, color: "var(--muted)" }}>
            Голос: <b style={{ color: "var(--text)" }}>{c.styleRules?.voice}</b>
          </p>
        </section>

        <section className="surface">
          <div className="section-head">
            <div>
              <h2>Персонажи и статистика</h2>
              <p>Постоянные герои сообщества и состояние постов</p>
            </div>
            <Users size={16} style={{ color: "var(--muted)" }} />
          </div>
          <div className="chip-row">
            {(data.characters ?? []).map((ch) => (
              <Link to="/characters" className="chip" key={ch.id}>
                {ch.name} {ch.locked ? "🔒" : ""}
              </Link>
            ))}
            {(data.characters ?? []).length === 0 && (
              <span style={{ fontSize: 11, color: "var(--muted)" }}>Постоянных персонажей нет</span>
            )}
          </div>
          <div className="chip-row" style={{ marginTop: 14 }}>
            {statusEntries.map(([status, count]) => (
              <span className="chip" key={status}>
                {STATUS_LABEL[status] ?? status}: <b style={{ marginLeft: 4 }}>{count}</b>
              </span>
            ))}
            {statusEntries.length === 0 && <span style={{ fontSize: 11, color: "var(--muted)" }}>Постов пока нет</span>}
          </div>
          <p className="settings-note" style={{ marginTop: 14 }}>
            Сообщество работает по теме «{meta?.theme}». Правила контента: без 18+/эротики, без ложных утверждений, без
            выдуманной аналитики конкурентов.
          </p>
        </section>
      </div>
    </div>
  );
}
