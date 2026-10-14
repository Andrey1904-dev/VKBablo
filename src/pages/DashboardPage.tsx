import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getBackend } from "@/data";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/api";
import { COMMUNITY_META } from "@shared/constants";
import { DEFAULT_SLOTS, moscowParts, moscowSlotIso } from "@shared/moscow";
import { Badge, Button, PageHead, Stat } from "@/components/ui";
import { openCreateModal, toast } from "@/components/toast";
import { CommunityAvatar } from "@/components/layout";
import { formatMoscow } from "@/lib/time";
import type { DashboardData, Post } from "@shared/types";
import {
  Activity,
  AlertCircle,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";

/** Строка публикации в таймлайне «Сегодня» (макет: .post-row). */
const WD_RU = ["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"];

function PostRow({ post }: { post: Post }) {
  const meta = COMMUNITY_META[post.communityId];
  const img = post.imageUrl || post.imagePath;
  return (
    <Link className="post-row" to={`/posts/${post.id}`}>
      <span className="post-thumb">
        {img ? <img src={img} alt="" /> : <CommunityAvatar id={post.communityId} size="sm" />}
      </span>
      <span className="post-copy">
        <b>{meta?.name ?? post.communityId}</b>
        <span>{post.title || post.topic}</span>
      </span>
      <span className="mono">{formatMoscow(post.scheduledAt).split(", ")[1] ?? ""}</span>
      <Badge tone={STATUS_TONE[post.status] ?? "neutral"}>{STATUS_LABEL[post.status] ?? post.status}</Badge>
      <Eye size={16} style={{ color: "var(--muted)" }} />
    </Link>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [today, setToday] = useState<Post[]>([]);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();

  async function load() {
    const backend = getBackend();
    const d = await backend.dashboard();
    setData(d);
    const m = moscowParts();
    const r = await backend.calendar(moscowSlotIso(m.dateStr, "00:00"), moscowSlotIso(m.dateStr, "23:59"));
    setToday(r.posts);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  async function prepare() {
    setBusy(true);
    try {
      const r = await getBackend().prepareUpcoming();
      await getBackend().runWorker("tick");
      toast(`В очередь поставлено слотов: ${r.queued}. Генерация завершена.`);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    } finally {
      setBusy(false);
    }
  }

  // Секции таймлайна: слоты расписания + фактические времена постов (кастомное расписание)
  const sections = useMemo(() => {
    const times = new Set<string>(DEFAULT_SLOTS);
    for (const p of today) {
      times.add(formatMoscow(p.scheduledAt).split(", ")[1] ?? "");
    }
    return [...times].filter(Boolean).sort();
  }, [today]);

  const currentSlot = useMemo(() => {
    const now = moscowParts().timeStr;
    let active = "";
    for (const t of sections) if (t <= now) active = t;
    return active;
  }, [sections]);

  if (!data) {
    return (
      <div className="page enter">
        <p style={{ color: "var(--muted)", fontSize: 12 }}>Загрузка панели…</p>
      </div>
    );
  }

  const byId = new Map<string, Post[]>();
  for (const p of today) {
    const t = formatMoscow(p.scheduledAt).split(", ")[1] ?? "";
    const arr = byId.get(t) ?? [];
    arr.push(p);
    byId.set(t, arr);
  }

  const integrations = data.integrations ?? [];
  const vkIntegration = integrations.find((i) => i.key === "vk");
  const connectedHelp = vkIntegration?.status === "verified" ? "Подключения активны" : "VK не подключён (публикации выключены)";

  return (
    <div className="page enter">
      <PageHead
        title="Обзор"
        description="Управляйте контентом всех сообществ в одном месте."
        actions={
          <>
            <Button variant="secondary" onClick={prepare} disabled={busy}>
              {busy ? <RefreshCw size={16} className="spin" /> : <CalendarDays size={16} />}
              {busy ? "Готовим…" : "Подготовить слоты"}
            </Button>
            <Button onClick={openCreateModal}>
              <Plus size={16} /> Создать пост
            </Button>
          </>
        }
      />

      {data.backend.kind !== "supabase" && (
        <div className="demo-note">
          <Sparkles size={14} />
          {data.backend.kind === "demo"
            ? "Демонстрационное пространство"
            : "Локальный стенд разработки"}
          <span>
            {data.backend.kind === "demo"
              ? "Данные хранятся в браузере и приведены для примера; публикация в VK невозможна"
              : "Локальный API; реальные публикации VK отключены"}
          </span>
        </div>
      )}

      <section className="stats-grid">
        <Stat icon={Users} label="Сообщества" value={data.byCommunity.length} help={connectedHelp} />
        <Stat icon={CalendarDays} label="Запланировано" value={data.scheduled + data.ready} help="Слоты на ближайшие дни" accent />
        <Stat icon={Clock3} label="Ожидают проверки" value={data.pendingReview} help="Решение принимает владелец" />
        <Stat icon={CheckCircle2} label="Опубликовано" value={data.published} help="За всё время работы" />
      </section>

      {data.missedSlots > 0 && (
        <div className="notice" style={{ marginBottom: 14 }}>
          <AlertCircle size={15} />
          <span>
            Пропущенных слотов за последние дни: {data.missedSlots}. Задним числом ничего не публикуется —{" "}
            <Link className="text-btn" to="/calendar" style={{ display: "inline" }}>
              открыть календарь
            </Link>
          </span>
        </div>
      )}

      <div className="dashboard-grid">
        <section className="surface schedule">
          <div className="section-head">
            <div>
              <h2>Сегодня</h2>
              <p>
                {WD_RU[data.moscow.weekday - 1] ?? ""},{" "}
                {new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "long" }).format(
                  new Date(`${data.moscow.dateStr}T12:00:00Z`),
                )}{" "}
                · московское время {data.moscow.timeStr}
              </p>
            </div>
            <button className="text-btn" onClick={() => nav("/calendar")}>
              Весь календарь <ChevronRight size={15} />
            </button>
          </div>
          <div className="timeline">
            {sections.map((t) => {
              const posts = (byId.get(t) ?? []).sort((a, b) => a.communityId.localeCompare(b.communityId));
              return (
                <div key={t}>
                  <div className={`time-label ${t === currentSlot ? "active" : ""}`}>
                    <span>{t}</span>
                    <i />
                  </div>
                  {posts.length === 0 ? (
                    <p style={{ color: "var(--muted)", fontSize: 10, padding: "4px 0 12px" }}>Слот свободен — публикация не создана</p>
                  ) : (
                    posts.map((p) => <PostRow key={p.id} post={p} />)
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <aside className="surface attention">
          <div className="section-head">
            <div>
              <h2>Требуют внимания</h2>
              <p>Задачи, которые ждут решения</p>
            </div>
          </div>
          <button className="attention-item" onClick={() => nav("/posts")}>
            <span className="attention-icon warning">
              <ShieldCheck size={18} />
            </span>
            <span>
              <b>Посты на проверке</b>
              <small>Без одобрения не публикуются</small>
            </span>
            <strong>{data.pendingReview}</strong>
          </button>
          <button className="attention-item" onClick={() => nav("/posts?status=error")}>
            <span className={`attention-icon ${data.errors > 0 ? "danger" : ""}`}>
              <AlertCircle size={18} />
            </span>
            <span>
              <b>Ошибки генерации</b>
              <small>Посты, которые не удалось создать</small>
            </span>
            <strong>{data.errors}</strong>
          </button>
          <button className="attention-item" onClick={() => nav("/settings")}>
            <span className="attention-icon">
              <Activity size={18} />
            </span>
            <span>
              <b>Подключения</b>
              <small>{data.mode === "test" ? "Тестовый режим · VK dry-run" : "Согласование · реальный VK"}</small>
            </span>
            {data.mode === "test" ? <Check size={16} className="green" /> : <strong>ON</strong>}
          </button>
          <div className="ai-brief">
            <div>
              <Bot size={21} />
            </div>
            <span>
              <b>{data.automationPaused ? "Автоматизация на паузе" : "AI работает по плану"}</b>
              <p>
                {data.automationPaused
                  ? "Генерация остановлена. Запустите автоматизацию, чтобы готовить ближайшие слоты."
                  : `Готовит посты к слотам 13:30 / 17:30 / 21:30 по Москве. Расход за месяц: $${data.spendUsdMonth.toFixed(2)} из $${data.spendLimitUsd}.`}
              </p>
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
