import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getBackend } from "@/data";
import { COMMUNITY_META } from "@shared/constants";
import { Badge, Button, Empty, PageHead, Stat } from "@/components/ui";
import { CommunityAvatar } from "@/components/layout";
import { formatMoscow } from "@/lib/time";
import type { AnalyticsPayload } from "@shared/types";
import { BarChart3, Eye, Info, LineChart, MessageCircle, ThumbsUp, TrendingUp } from "lucide-react";

function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x},${pts[0].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const mx = (p0.x + p1.x) / 2;
    d += ` C${mx},${p0.y} ${mx},${p1.y} ${p1.x},${p1.y}`;
  }
  return d;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    getBackend().analytics()
      .then((result) => { if (active) setData(result); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Не удалось загрузить аналитику"); });
    return () => { active = false; };
  }, [retry]);

  const series = useMemo(() => {
    if (!data) return [];
    const byDate = new Map<string, number>();
    for (const p of data.points) {
      const key = formatMoscow(p.date, false);
      byDate.set(key, (byDate.get(key) ?? 0) + p.views);
    }
    return [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, views], i) => ({ date, views }));
  }, [data]);

  const totals = useMemo(() => {
    const t = { views: 0, likes: 0, comments: 0, shares: 0 };
    for (const p of data?.points ?? []) {
      t.views += p.views;
      t.likes += p.likes;
      t.comments += p.comments;
      t.shares += p.shares;
    }
    return t;
  }, [data]);

  if (!data) {
    return (
      <div className="page enter">
        <PageHead title="Аналитика" description="Результаты по фактически опубликованным постам." />
        {error ? (
          <div className="notice danger" role="alert">
            <Info size={15} /> <span>{error}</span>
            <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>Повторить</Button>
          </div>
        ) : <p style={{ color: "var(--muted)", fontSize: 12 }}>Загрузка…</p>}
      </div>
    );
  }

  const hasPoints = series.length > 0;
  const maxScore = Math.max(1, ...(data.best ?? []).map((b) => b.score));
  const labelIdx = [0, Math.floor(series.length * 0.25), Math.floor(series.length * 0.5), Math.floor(series.length * 0.75), series.length - 1];
  const pts = series.map((s, i) => ({
    x: series.length === 1 ? 400 : (i / (series.length - 1)) * 800,
    y: 250 - (s.views / Math.max(1, ...series.map((x) => x.views))) * 230,
  }));
  const linePath = smoothPath(pts);
  const areaPath = hasPoints ? `${linePath} L800,260 L0,260 Z` : "";

  return (
    <div className="page enter">
      <PageHead
        title="Аналитика"
        description="Результаты контент-стратегии за всё время по фактически опубликованным постам."
      />

      {data.testMode && (
        <div className="demo-note">
          <BarChart3 size={14} />
          {data.note.includes("ДЕМО") ? "Демонстрационные данные" : "Тестовый режим"}
          <span>{data.note}</span>
        </div>
      )}

      <section className="analytics-stats">
        <Stat icon={Eye} label="Просмотры" value={totals.views.toLocaleString("ru-RU")} help={`По ${data.published.length} опубликованным постам`} />
        <Stat icon={ThumbsUp} label="Лайки" value={totals.likes.toLocaleString("ru-RU")} help="Сумма по фактически вышедшим постам" />
        <Stat icon={MessageCircle} label="Комментарии" value={totals.comments.toLocaleString("ru-RU")} help="Без прогнозов и экстраполяций" />
        <Stat icon={TrendingUp} label="Репосты" value={totals.shares.toLocaleString("ru-RU")} help="Источник: статистика публикаций" accent />
      </section>

      {data.insufficientData && (
        <div className="notice" style={{ marginBottom: 14 }}>
          <Info size={15} />
          <span>
            Данных пока мало для выводов: опубликовано {data.published.length} постов из {data.thresholds.postsForConclusions},
            необходимых для статистических заключений. Никаких выдуманных трендов не показываем.
          </span>
        </div>
      )}

      {hasPoints ? (
        <div className="analytics-grid">
          <section className="surface chart">
            <div className="section-head">
              <div>
                <h2>Динамика просмотров</h2>
                <p>Все сообщества, по датам публикации</p>
              </div>
              <Badge tone="purple">
                <LineChart size={12} /> {series.length} точек
              </Badge>
            </div>
            <svg viewBox="0 0 800 260" preserveAspectRatio="none">
              <defs>
                <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="#8B5CF6" stopOpacity=".28" />
                  <stop offset="1" stopColor="#8B5CF6" stopOpacity="0" />
                </linearGradient>
              </defs>
              <g className="grid-lines">
                <line x1="0" y1="30" x2="800" y2="30" />
                <line x1="0" y1="100" x2="800" y2="100" />
                <line x1="0" y1="170" x2="800" y2="170" />
                <line x1="0" y1="240" x2="800" y2="240" />
              </g>
              <path className="area" d={areaPath} />
              <path className="line" d={linePath} />
            </svg>
            <div className="chart-labels">
              {[...new Set(labelIdx)].map((i) => (
                <span key={i}>{series[i]?.date ?? ""}</span>
              ))}
            </div>
          </section>

          <section className="surface ranking">
            <div className="section-head">
              <div>
                <h2>Лучшие посты</h2>
                <p>По вовлечённости (просмотры + реакции)</p>
              </div>
            </div>
            {(data.best ?? []).map((b, i) => {
              const meta = COMMUNITY_META[b.communityId];
              return (
                <Link to={`/posts/${b.postId}`} className="rank" key={b.postId}>
                  <span>{i + 1}</span>
                  <CommunityAvatar id={b.communityId} size="sm" />
                  <div>
                    <b>{b.title || meta?.shortName || b.communityId}</b>
                    <i>
                      <em style={{ width: `${(b.score / maxScore) * 100}%`, background: meta?.color ?? "var(--accent)" }} />
                    </i>
                  </div>
                  <strong>{b.views.toLocaleString("ru-RU")}</strong>
                </Link>
              );
            })}
            {(data.best ?? []).length === 0 && (
              <p style={{ color: "var(--muted)", fontSize: 11, marginTop: 12 }}>Пока нет опубликованных постов.</p>
            )}
          </section>
        </div>
      ) : (
        <div className="surface">
          <Empty
            icon={BarChart3}
            title="Статистики ещё нет"
            text="Графики просмотров, лайков и комментариев появятся после первых публикаций и синхронизации со статистикой VK. Пока не вышло ни одного поста — и мы не подставляем фальшивые цифры."
          />
        </div>
      )}

      <section className="surface" style={{ padding: 19, marginTop: 16 }}>
        <div className="section-head">
          <div>
            <h2>Опубликованные посты</h2>
            <p>Только фактические публикации; тестовые помечены dry-run</p>
          </div>
        </div>
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Когда</th>
                <th>Сообщество</th>
                <th>Тема</th>
                <th>VK id</th>
              </tr>
            </thead>
            <tbody>
              {(data.published ?? []).map((p) => (
                <tr key={p.id}>
                  <td className="mono">{formatMoscow(p.publishedAt || p.scheduledAt)}</td>
                  <td>{COMMUNITY_META[p.communityId]?.shortName ?? p.communityId}</td>
                  <td>
                    <Link to={`/posts/${p.id}`}>{p.title || p.topic}</Link>
                  </td>
                  <td className="mono">{p.vkPostId || "—"}</td>
                </tr>
              ))}
              {(data.published ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} style={{ color: "var(--muted)" }}>
                    Публикаций пока нет.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
