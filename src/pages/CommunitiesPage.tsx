import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getBackend } from "@/data";
import { Badge, Button, PageHead } from "@/components/ui";
import { AlertCircle, ChevronRight } from "lucide-react";
import type { Community, DashboardData } from "@shared/types";

export default function CommunitiesPage() {
  const [items, setItems] = useState<Community[]>([]);
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const b = getBackend();
    setError(null);
    setDashboardError(null);
    b.communities()
      .then((result) => { if (active) setItems(result); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Не удалось загрузить сообщества"); });
    b.dashboard()
      .then((result) => { if (active) setDash(result); })
      .catch((reason) => { if (active) { setDash(null); setDashboardError(reason instanceof Error ? reason.message : "Не удалось загрузить счётчики"); } });
    return () => { active = false; };
  }, [retry]);

  return (
    <div className="page enter">
      <PageHead
        title="Сообщества"
        description="Контент, расписания и настройки подключённых сообществ."
      />
      {(error || dashboardError) && (
        <div className="notice danger" role="alert" style={{ marginBottom: 12 }}>
          <AlertCircle size={15} />
          <span>{error ? `Сообщества не загружены: ${error}` : `Счётчики не обновлены: ${dashboardError}`}</span>
          <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>Повторить</Button>
        </div>
      )}
      {!error && items.length === 0 && <div className="notice">Сообщества пока не загружены.</div>}
      <div className="community-grid">
        {items.map((c) => {
          const stats = dash?.byCommunity.find((x) => x.id === c.id);
          return (
            <Link to={`/communities/${c.id}`} key={c.id} style={{ display: "flex" }}>
              <article className="community-card">
                <div className="community-visual" style={{ background: `linear-gradient(135deg, ${c.color}22, transparent)` }}>
                  <img
                    className="cover"
                    src={`${import.meta.env.BASE_URL}covers/${c.id}.svg`}
                    alt=""
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                  <Badge tone={c.vkConnected ? "success" : "neutral"}>{c.vkConnected ? "Подключено" : "VK не подключён"}</Badge>
                </div>
                <div className="community-body">
                  <h2 title={c.name}>{c.name}</h2>
                  <p title={c.tagline}>{c.tagline}</p>
                  <div className="community-meta">
                    <span>
                      <b>{stats?.scheduled ?? 0}</b> запланировано
                    </span>
                    <span>
                      <b>{stats?.pending ?? 0}</b> на проверке
                    </span>
                    <span className="mt">
                      <b>{stats?.published ?? 0}</b> вышло
                    </span>
                  </div>
                  <div style={{ marginTop: "auto", paddingTop: 4 }}>
                    <Button variant="secondary" className="full">
                      Открыть <ChevronRight size={15} />
                    </Button>
                  </div>
                </div>
              </article>
            </Link>
          );
        })}
      </div>
      <p className="calendar-hint" style={{ marginTop: 16 }}>
        Сообщества фиксированы владельцем: четыре группы, по три слота в день (13:30 / 17:30 / 21:30 по Москве). Новые сообщества не подключаются.
      </p>
    </div>
  );
}
