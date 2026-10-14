import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getBackend } from "@/data";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/api";
import { COMMUNITY_META } from "@shared/constants";
import { addDays, moscowParts, moscowSlotIso } from "@shared/moscow";
import { Badge, Button, PageHead } from "@/components/ui";
import { CommunityAvatar } from "@/components/layout";
import { openCreateModal } from "@/components/toast";
import { formatMoscow } from "@/lib/time";
import { COMMUNITY_IDS, type CalendarPayload, type Post } from "@shared/types";
import { AlertCircle, ChevronLeft, ChevronRight, Lightbulb, Plus } from "lucide-react";

type View = "day" | "week" | "month";
const AXIS = ["09:00", "13:30", "17:30", "21:30"];
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

function moscowTime(iso: string) {
  return formatMoscow(iso).split(", ")[1] ?? "";
}
function dateStrOf(d: Date) {
  return moscowParts(d).dateStr;
}
function weekdayIndex(dateStr: string) {
  return (new Date(`${dateStr}T12:00:00Z`).getUTCDay() + 6) % 7;
}
function rowForTime(t: string) {
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const target = mins(t);
  let best = 0;
  let dist = Infinity;
  AXIS.forEach((label, i) => {
    const d = Math.abs(mins(label) - target);
    if (d < dist) {
      dist = d;
      best = i;
    }
  });
  return best;
}
function shiftAnchor(anchor: Date, view: View, dir: 1 | -1) {
  const d = new Date(anchor);
  if (view === "day") d.setDate(d.getDate() + dir);
  else if (view === "week") d.setDate(d.getDate() + dir * 7);
  else d.setMonth(d.getMonth() + dir);
  return d;
}
function rangeLabel(anchor: Date, view: View) {
  const ds = dateStrOf(anchor);
  const fmtLong = (s: string) =>
    new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "long" }).format(new Date(`${s}T12:00:00Z`));
  const fmtShort = (s: string) =>
    new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" }).format(new Date(`${s}T12:00:00Z`));
  if (view === "day") return fmtLong(ds).replace(/ г\.?$/, "");
  if (view === "month") {
    return new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${ds}T12:00:00Z`));
  }
  const monday = addDays(ds, -weekdayIndex(ds));
  const sunday = addDays(monday, 6);
  const y = ds.slice(0, 4);
  return `${fmtShort(monday)} – ${fmtShort(sunday)} ${y}`;
}

export default function CalendarPage() {
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(new Date());
  const [community, setCommunity] = useState("");
  const [data, setData] = useState<CalendarPayload | null>(null);
  const today = moscowParts().dateStr;

  useEffect(() => {
    const ds = dateStrOf(anchor);
    let from: string;
    let to: string;
    if (view === "day") {
      from = moscowSlotIso(ds, "00:00");
      to = moscowSlotIso(ds, "23:59");
    } else if (view === "week") {
      const monday = addDays(ds, -weekdayIndex(ds));
      from = moscowSlotIso(monday, "00:00");
      to = moscowSlotIso(addDays(monday, 6), "23:59");
    } else {
      const first = `${ds.slice(0, 7)}-01`;
      const gridStart = addDays(first, -weekdayIndex(first));
      from = moscowSlotIso(gridStart, "00:00");
      to = moscowSlotIso(addDays(gridStart, 41), "23:59");
    }
    getBackend().calendar(from, to).then(setData).catch(console.error);
  }, [anchor, view]);

  const posts = useMemo(
    () => (data?.posts ?? []).filter((p) => !community || p.communityId === community),
    [data, community],
  );

  const byDay = useMemo(() => {
    const map = new Map<string, Post[]>();
    for (const p of posts) {
      const key = moscowParts(p.scheduledAt).dateStr;
      const arr = map.get(key) ?? [];
      arr.push(p);
      map.set(key, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    return map;
  }, [posts]);

  const weekDays = useMemo(() => {
    const ds = dateStrOf(anchor);
    const monday = addDays(ds, -weekdayIndex(ds));
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }, [anchor]);

  const monthCells = useMemo(() => {
    const ds = dateStrOf(anchor);
    const first = `${ds.slice(0, 7)}-01`;
    const gridStart = addDays(first, -weekdayIndex(first));
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [anchor]);

  const dayPosts = byDay.get(dateStrOf(anchor)) ?? [];

  return (
    <div className="page enter">
      <PageHead
        title="Календарь"
        description="Планируйте публикации и управляйте контент-планом. Время московское."
        actions={
          <Button onClick={openCreateModal}>
            <Plus size={16} /> Добавить публикацию
          </Button>
        }
      />

      <div className="calendar-toolbar">
        <div className="segmented">
          {(["day", "week", "month"] as View[]).map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              {v === "day" ? "День" : v === "week" ? "Неделя" : "Месяц"}
            </button>
          ))}
        </div>
        <div className="date-nav">
          <button className="icon-btn" onClick={() => setAnchor(shiftAnchor(anchor, view, -1))} aria-label="Назад">
            <ChevronLeft size={17} />
          </button>
          <b>{rangeLabel(anchor, view)}</b>
          <button className="icon-btn" onClick={() => setAnchor(shiftAnchor(anchor, view, 1))} aria-label="Вперёд">
            <ChevronRight size={17} />
          </button>
          <Button variant="secondary" size="sm" onClick={() => setAnchor(new Date())}>
            Сегодня
          </Button>
        </div>
        <select className="select-btn" value={community} onChange={(e) => setCommunity(e.target.value)}>
          <option value="">Все сообщества</option>
          {COMMUNITY_IDS.map((id) => (
            <option key={id} value={id}>
              {COMMUNITY_META[id].shortName}
            </option>
          ))}
        </select>
      </div>

      {(data?.missed ?? []).length > 0 && (
        <div className="notice" style={{ marginBottom: 13 }}>
          <AlertCircle size={15} />
          <span>
            Пропущенные слоты: {data!.missed.length}. Задним числом публикации не создаются — расписание идёт дальше по плану.
          </span>
        </div>
      )}

      {view === "week" && (
        <div className="week">
          <div className="week-head">
            <span />
            {weekDays.map((d, i) => (
              <span key={d} className={d === today ? "today" : ""}>
                {WD[i]} <b>{Number(d.slice(8, 10))}</b>
              </span>
            ))}
          </div>
          <div className="week-body">
            <div className="time-axis">
              {AXIS.map((x) => (
                <span key={x}>{x}</span>
              ))}
            </div>
            {weekDays.map((d) => {
              const list = byDay.get(d) ?? [];
              // Раскладка по строкам сетки: строка = ближайший слот оси, внутри — стек
              const placed: Array<{ p: Post; top: number }> = [];
              const stacks = new Map<number, number>();
              for (const p of list) {
                const row = rowForTime(moscowTime(p.scheduledAt));
                const stack = stacks.get(row) ?? 0;
                stacks.set(row, stack + 1);
                const top = Math.min(10 + row * 114 + stack * 97, 352);
                placed.push({ p, top });
              }
              return (
                <div className={`day-col ${d === today ? "current" : ""}`} key={d}>
                  {placed.slice(0, 4).map(({ p, top }) => {
                    const meta = COMMUNITY_META[p.communityId];
                    return (
                      <Link
                        to={`/posts/${p.id}`}
                        className={`cal-post s-${p.status}`}
                        style={{ top }}
                        key={p.id}
                        title={`${meta?.name ?? p.communityId} · ${STATUS_LABEL[p.status]}`}
                      >
                        <div>
                          <CommunityAvatar id={p.communityId} size="sm" />
                          <span>{moscowTime(p.scheduledAt)}</span>
                        </div>
                        <b>{meta?.shortName ?? p.communityId}</b>
                        <small>{STATUS_LABEL[p.status] ?? p.status}</small>
                      </Link>
                    );
                  })}
                  {list.length > 4 && (
                    <span className="mono" style={{ position: "absolute", bottom: 8, left: 8 }}>
                      +{list.length - 4} ещё
                    </span>
                  )}
                  <button className="slot-add" onClick={openCreateModal} title="Создать публикацию" aria-label="Создать публикацию">
                    <Plus size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {view === "month" && (
        <div className="month-grid">
          {monthCells.map((d) => {
            const list = byDay.get(d) ?? [];
            const out = d.slice(0, 7) !== dateStrOf(anchor).slice(0, 7);
            return (
              <div className={`month-cell ${out ? "out" : ""}`} key={d}>
                <div className={`mc-date ${d === today ? "today" : ""}`}>
                  <button
                    onClick={() => {
                      setAnchor(new Date(`${d}T12:00:00Z`));
                      setView("day");
                    }}
                    style={{ background: "none", border: 0, color: "inherit", font: "inherit", cursor: "pointer", padding: 0 }}
                  >
                    {Number(d.slice(8, 10))}
                  </button>
                  {d === today && <Badge tone="purple">сегодня</Badge>}
                </div>
                {list.slice(0, 4).map((p) => (
                  <Link to={`/posts/${p.id}`} className={`month-chip s-${p.status}`} key={p.id} title={STATUS_LABEL[p.status]}>
                    <CommunityAvatar id={p.communityId} size="sm" />
                    <span>{moscowTime(p.scheduledAt)}</span>
                  </Link>
                ))}
                {list.length > 4 && <span className="mono">+{list.length - 4}</span>}
              </div>
            );
          })}
        </div>
      )}

      {view === "day" && (
        <section className="surface schedule">
          <div className="section-head">
            <div>
              <h2>{rangeLabel(anchor, "day")}</h2>
              <p>Слоты 13:30 / 17:30 / 21:30 по Москве · {posts.length} публикаций</p>
            </div>
          </div>
          <div className="timeline">
            {AXIS.slice(1).map((t) => {
              const list = dayPosts.filter((p) => rowForTime(moscowTime(p.scheduledAt)) === rowForTime(t));
              return (
                <div key={t}>
                  <div className="time-label">
                    <span>{t}</span>
                    <i />
                  </div>
                  {list.length === 0 ? (
                    <p style={{ color: "var(--muted)", fontSize: 10, padding: "4px 0 12px" }}>Слот свободен</p>
                  ) : (
                    list.map((p) => (
                      <Link className="post-row" to={`/posts/${p.id}`} key={p.id}>
                        <span className="post-thumb">
                          <CommunityAvatar id={p.communityId} size="sm" />
                        </span>
                        <span className="post-copy">
                          <b>{COMMUNITY_META[p.communityId]?.name ?? p.communityId}</b>
                          <span>{p.title || p.topic}</span>
                        </span>
                        <span className="mono">{moscowTime(p.scheduledAt)}</span>
                        <Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{STATUS_LABEL[p.status] ?? p.status}</Badge>
                      </Link>
                    ))
                  )}
                </div>
              );
            })}
            {dayPosts
              .filter((p) => ![1, 2, 3].includes(rowForTime(moscowTime(p.scheduledAt))))
              .map((p) => (
                <Link className="post-row" to={`/posts/${p.id}`} key={p.id}>
                  <span className="post-thumb">
                    <CommunityAvatar id={p.communityId} size="sm" />
                  </span>
                  <span className="post-copy">
                    <b>{COMMUNITY_META[p.communityId]?.name ?? p.communityId}</b>
                    <span>{p.title || p.topic}</span>
                  </span>
                  <span className="mono">{moscowTime(p.scheduledAt)}</span>
                  <Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{STATUS_LABEL[p.status] ?? p.status}</Badge>
                </Link>
              ))}
          </div>
        </section>
      )}

      <p className="calendar-hint">
        <Lightbulb size={15} /> Перетаскивание пока не включено: время публикации меняется в карточке поста (поле «Время публикации»).
      </p>
    </div>
  );
}
