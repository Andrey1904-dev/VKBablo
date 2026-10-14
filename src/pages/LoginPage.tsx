import { useState } from "react";
import { api } from "@/lib/api";
import { Button, Field, Input } from "@/components/ui";

export default function LoginPage({
  setup,
  onDone,
}: {
  setup: boolean;
  onDone: (u: { id: number; email: string; name: string; role: string }) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("Андрей");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setPending(true);
    try {
      const path = setup ? "/api/auth/setup" : "/api/auth/login";
      const data = await api<{ user: { id: number; email: string; name: string; role: string } }>(path, {
        method: "POST",
        body: JSON.stringify({ email, password, name }),
      });
      onDone(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[#12141A] text-white">
      <div className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full bg-[#8B7CFF]/30 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -right-24 h-80 w-80 rounded-full bg-[#E86A33]/20 blur-3xl" />
      <div className="mx-auto grid min-h-dvh max-w-6xl items-center gap-10 px-5 py-10 lg:grid-cols-2">
        <div className="space-y-6">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs text-white/70">
            Europe/Moscow · 13:30 / 17:30 / 21:30
          </div>
          <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl">
            VK AI Manager
          </h1>
          <p className="max-w-md text-white/70">
            Автономная платформа для четырёх сообществ ВКонтакте. Генерация, ручное согласование,
            отложенная публикация. Без одобрения — ни одного поста.
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm text-white/80">
            {["Ну и история", "Милана", "ВСЯ СУТЬ ЖИЗНИ", "Вероника"].map((n) => (
              <div key={n} className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                {n}
              </div>
            ))}
          </div>
        </div>
        <form onSubmit={submit} className="rounded-3xl border border-white/10 bg-white text-[#12141A] p-6 shadow-lift sm:p-8">
          <h2 className="text-xl font-extrabold">{setup ? "Создание владельца" : "Вход"}</h2>
          <p className="mt-1 text-sm text-zinc-500">
            {setup
              ? "Первый запуск. Пароль не короче 10 символов. Ключи API в чат не отправляйте."
              : "Закрытая панель. Сессия хранится в httpOnly cookie."}
          </p>
          <div className="mt-6 space-y-4">
            {setup && (
              <Field label="Имя">
                <Input value={name} onChange={(e) => setName(e.target.value)} required />
              </Field>
            )}
            <Field label="Email">
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
            </Field>
            <Field label="Пароль">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={setup ? "new-password" : "current-password"} />
            </Field>
            {error && <div className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Подождите…" : setup ? "Создать аккаунт" : "Войти"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
