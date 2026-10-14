import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badge, Card } from "@/components/ui";

export default function CharactersPage() {
  const [items, setItems] = useState<any[]>([]);
  const [msg, setMsg] = useState("");

  async function load() {
    const r = await api<{ characters: any[] }>("/api/characters");
    setItems(r.characters);
  }
  useEffect(() => {
    load();
  }, []);

  async function upload(id: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    await api(`/api/characters/${id}/references`, { method: "POST", body: fd });
    setMsg("Референс загружен. Внешность не меняется без снятия замка.");
    load();
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <div>
        <h1 className="text-2xl font-extrabold">Персонажи и референсы</h1>
        <p className="text-sm text-muted-fg">
          Внешность заблокирована. Генератор не должен подменять лица. Если провайдер не умеет держать референс — это написано прямо в студии, а не обещается.
        </p>
      </div>
      {msg && <p className="text-sm text-muted-fg">{msg}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        {items.map((ch) => (
          <Card key={ch.id} className="p-5 space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-extrabold">{ch.name}</h2>
                <p className="text-sm text-muted-fg">{ch.role} · {ch.communityId}</p>
              </div>
              <Badge className={ch.locked ? "bg-accent/15 text-accent" : "bg-muted"}>{ch.locked ? "внешность заблокирована" : "можно менять"}</Badge>
            </div>
            <p className="text-sm leading-6">{ch.description}</p>
            <div className="rounded-xl bg-muted p-3 text-xs leading-5">
              {(ch.appearance?.distinctive || []).join(" · ")}
              <div className="mt-2 text-muted-fg">Нельзя: {(ch.appearance?.neverChange || []).join("; ")}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {(ch.references || []).map((r: any) => (
                <img key={r.id} src={r.filePath} alt="" className="h-16 w-16 rounded-xl object-cover" />
              ))}
            </div>
            <label className="block text-sm">
              Загрузить утверждённый референс
              <input type="file" accept="image/*" className="mt-1 block" onChange={(e) => e.target.files?.[0] && upload(ch.id, e.target.files[0])} />
            </label>
          </Card>
        ))}
      </div>
    </div>
  );
}
