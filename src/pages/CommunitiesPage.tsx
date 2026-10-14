import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getBackend } from "@/data";
import { Badge, Button, PageHead } from "@/components/ui";
import { ChevronRight } from "lucide-react";
import type { Community, DashboardData } from "@shared/types";

export default function CommunitiesPage() {
  const [items, setItems] = useState<Community[]>([]);
  const [dash, setDash] = useState<DashboardData | null>(null);

  useEffect(() => {
    const b = getBackend();
    b.communities().then(setItems).catch(console.error);
    b.dashboard().then(setDash).catch(() => setDash(null));
  }, []);

  return (
    <div className="page enter">
      <PageHead
        title="Сообщества"
        description="Контент, расписания и настройки подключённых сообществ."
      />
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
