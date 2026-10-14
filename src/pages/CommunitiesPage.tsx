import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Badge, Card } from "@/components/ui";

type Community = {
  id: string;
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  color: string;
  avatarUrl: string;
  vkConnected: boolean;
  schedule: string[];
  status: string;
};

export default function CommunitiesPage() {
  const [items, setItems] = useState<Community[]>([]);
  useEffect(() => {
    api<{ communities: Community[] }>("/api/communities").then((r) => setItems(r.communities));
  }, []);

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-extrabold">Сообщества</h1>
        <p className="text-sm text-muted-fg">Четыре постоянные группы. Расписание по Москве, 3 слота в день.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((c) => (
          <Link key={c.id} to={`/communities/${c.id}`}>
            <Card className="h-full p-5 transition hover:-translate-y-0.5 hover:shadow-lift">
              <div className="flex items-start gap-4">
                <img src={c.avatarUrl} alt="" className="h-14 w-14 rounded-2xl" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-extrabold">{c.name}</h2>
                    <Badge className={c.vkConnected ? "bg-emerald-500/15 text-emerald-700" : "bg-muted text-muted-fg"}>
                      {c.vkConnected ? "VK подключён" : "VK не подключён"}
                    </Badge>
                    <Badge className="bg-muted text-muted-fg">{c.status === "active" ? "активно" : "пауза"}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-fg">{c.tagline}</p>
                  <p className="mt-3 text-xs text-muted-fg">Слоты: {c.schedule.join(" · ")} МСК</p>
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
