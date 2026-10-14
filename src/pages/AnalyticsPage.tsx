import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card } from "@/components/ui";
import { formatMoscow } from "@/lib/time";

export default function AnalyticsPage() {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    api("/api/analytics").then(setData);
  }, []);
  if (!data) return <p className="text-muted-fg">Загрузка…</p>;

  return (
    <div className="space-y-5 animate-fade-in">
      <div>
        <h1 className="text-2xl font-extrabold">Аналитика</h1>
        <p className="text-sm text-muted-fg">{data.note}</p>
      </div>
      <Card className="p-5">
        <h2 className="font-bold">Опубликованные посты</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-fg">
              <tr>
                <th className="py-2">Когда</th>
                <th>Сообщество</th>
                <th>Тема</th>
                <th>VK id</th>
              </tr>
            </thead>
            <tbody>
              {(data.published || []).map((p: any) => (
                <tr key={p.id} className="border-t border-line">
                  <td className="py-2">{formatMoscow(p.publishedAt || p.scheduledAt)}</td>
                  <td>{p.communityId}</td>
                  <td>{p.title || p.topic}</td>
                  <td className="text-muted-fg">{p.vkPostId || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(data.published || []).length === 0 && <p className="mt-3 text-sm text-muted-fg">Пока нет опубликованных постов — и нет выдуманных цифр.</p>}
        </div>
      </Card>
      {(data.points || []).length === 0 && (
        <Card className="p-5 text-sm text-muted-fg">
          Статистика просмотров, лайков, комментариев и репостов появится после синхронизации с VK. В тестовом режиме я не подставляю фальшивые графики.
        </Card>
      )}
    </div>
  );
}
