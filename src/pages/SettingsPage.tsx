import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, Field, Input } from "@/components/ui";

export default function SettingsPage() {
  const [s, setS] = useState<any>(null);
  const [aiKey, setAiKey] = useState("");
  const [msg, setMsg] = useState("");

  async function load() {
    setS(await api("/api/settings"));
  }
  useEffect(() => {
    load();
  }, []);

  async function save(patch: Record<string, unknown>) {
    setMsg("");
    try {
      await api("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
      setMsg("Сохранено");
      load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    }
  }

  async function testAi() {
    try {
      const r = await api<{ ok: boolean; sample?: string; error?: string; provider?: string }>("/api/settings/test-ai", { method: "POST" });
      setMsg(r.ok ? `AI отвечает (${r.provider}): ${r.sample}` : r.error || "ошибка");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    }
  }

  if (!s) return <p className="text-muted-fg">Загрузка…</p>;

  return (
    <div className="space-y-5 max-w-3xl animate-fade-in">
      <h1 className="text-2xl font-extrabold">Настройки</h1>

      <Card className="p-5 space-y-3">
        <h2 className="font-bold">Режим работы</h2>
        <p className="text-sm text-muted-fg">Самостоятельная публикация без согласования не включена и не будет.</p>
        <div className="flex gap-2">
          <Button variant={s.mode === "test" ? "primary" : "outline"} onClick={() => save({ mode: "test" })}>Тестирование</Button>
          <Button variant={s.mode === "approval" ? "primary" : "outline"} onClick={() => save({ mode: "approval" })}>С согласованием</Button>
        </div>
        <p className="text-xs text-muted-fg">
          Сейчас: {s.mode === "test" ? "dry-run, VK не получает посты" : "после одобрения — отложенная запись VK"}.
          Автоматизация {s.automationPaused ? "на паузе" : "активна"}. Часовой пояс {s.timezone}.
        </p>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-bold">Supabase</h2>
        <p className="text-sm leading-6 text-muted-fg">
          {s.supabase?.configured
            ? "Сервер видит SUPABASE_URL и service role. Анонимный ключ не равен service role и не должен попадать в чат."
            : "Проект ещё не подключён. Локальная SQLite база работает для разработки. Чтобы перейти в облако: создайте проект в Supabase Dashboard, выполните SQL из папки supabase/migrations и supabase/policies.sql, затем задайте секреты на сервере / в Cloudflare — не в этом окне."}
        </p>
        <ul className="list-disc pl-5 text-sm text-muted-fg space-y-1">
          <li>SUPABASE_URL — да</li>
          <li>SUPABASE_ANON_KEY — да, можно в VITE_ для Realtime</li>
          <li>SUPABASE_SERVICE_ROLE_KEY — только Worker/сервер</li>
        </ul>
        <div className="text-xs">URL задан: {s.supabase?.url ? "да" : "нет"} · anon: {s.supabase?.anon ? "да" : "нет"} · service: {s.supabase?.service ? "да" : "нет"}</div>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-bold">AI</h2>
        <Field label="Провайдер">
          <select
            className="h-11 w-full rounded-xl border border-line bg-card px-3"
            value={s.aiProvider}
            onChange={(e) => save({ aiProvider: e.target.value })}
          >
            <option value="test">Тестовый движок</option>
            <option value="openai">OpenAI</option>
            <option value="compatible">Совместимый API</option>
          </select>
        </Field>
        <Field label="Модель текста">
          <Input defaultValue={s.aiTextModel} onBlur={(e) => save({ aiTextModel: e.target.value })} />
        </Field>
        <Field label="Модель изображения">
          <Input defaultValue={s.aiImageModel} onBlur={(e) => save({ aiImageModel: e.target.value })} />
        </Field>
        <Field label="Base URL (для compatible)">
          <Input defaultValue={s.aiBaseUrl} onBlur={(e) => save({ aiBaseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
        </Field>
        <Field label="API-ключ (не отображается после сохранения)">
          <Input type="password" value={aiKey} onChange={(e) => setAiKey(e.target.value)} placeholder={s.aiConfigured ? "ключ задан · введите новый чтобы заменить" : ""} />
        </Field>
        <div className="flex gap-2">
          <Button onClick={() => save({ aiApiKey: aiKey })}>Сохранить ключ</Button>
          <Button variant="outline" onClick={testAi}>Проверить AI</Button>
        </div>
        <Field label="Лимит $/мес">
          <Input type="number" defaultValue={s.aiMonthlyLimitUsd} onBlur={(e) => save({ aiMonthlyLimitUsd: Number(e.target.value) })} />
        </Field>
        <p className="text-xs text-muted-fg">Потрачено в этом месяце: ${Number(s.spendUsdMonth || 0).toFixed(2)}</p>
      </Card>

      <Card className="p-5 space-y-3">
        <h2 className="font-bold">Автоматизация</h2>
        <Field label="Готовить посты за N часов">
          <Input type="number" defaultValue={s.prepareHoursAhead} onBlur={(e) => save({ prepareHoursAhead: Number(e.target.value) })} />
        </Field>
        <p className="text-sm text-muted-fg">Уведомления на сайте {s.notificationsEnabled ? "включены" : "выключены"}. Telegram и web push заложены, но не подключены.</p>
      </Card>
      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
