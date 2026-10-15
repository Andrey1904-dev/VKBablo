import { useState } from "react";
import { getBackend } from "@/data";
import type { UserPublic } from "@shared/types";
import { COMMUNITY_IDS } from "@shared/types";
import { COMMUNITY_META } from "@shared/constants";
import { Button, Field, Input } from "@/components/ui";
import { Command, Clock3 } from "lucide-react";

export default function LoginPage({
  setup,
  onDone,
}: {
  setup: boolean;
  onDone: (u: UserPublic) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("Андрей");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const supabaseBootstrapRequired = setup && getBackend().info.kind === "supabase";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setPending(true);
    try {
      const backend = getBackend();
      const user = setup
        ? await backend.auth.createOwner(email, password, name)
        : await backend.auth.signIn(email, password);
      onDone(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-glow-a" />
      <div className="login-glow-b" />
      <div className="login-grid login-wide">
        <div className="login-hero">
          <div className="login-pill">
            <i />
            Europe/Moscow · 13:30 / 17:30 / 21:30
          </div>
          <h1>VKBablo</h1>
          <p>
            Автономная платформа для четырёх сообществ ВКонтакте. Генерация, обязательное ручное
            согласование и отложенная публикация. Без одобрения владельца не уходит ни один пост.
          </p>
          <div className="login-communities">
            {COMMUNITY_IDS.map((id) => {
              const meta = COMMUNITY_META[id];
              return (
                <div className="login-community" key={id}>
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      background: meta.color,
                      display: "grid",
                      placeItems: "center",
                      fontSize: 9,
                      fontWeight: 700,
                      color: "#fff",
                      flex: "none",
                    }}
                  >
                    {meta.shortName.slice(0, 2).toUpperCase()}
                  </span>
                  <span
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={meta.name}
                  >
                    {meta.name}
                  </span>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: "#676773", fontSize: 10, letterSpacing: ".07em", textTransform: "uppercase" }}>
            <Clock3 size={12} /> 4 сообщества · 12 публикаций в день
          </div>
        </div>
        {supabaseBootstrapRequired ? (
          <section className="login-card" aria-labelledby="bootstrap-title">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span className="brand-mark"><Command size={18} /></span>
              <div>
                <h2 id="bootstrap-title">Первичная настройка владельца</h2>
                <p style={{ margin: "3px 0 0" }}>Браузерная регистрация отключена.</p>
              </div>
            </div>
            <p>
              Оператор должен выполнить <code>scripts/bootstrap-owner.mjs</code> из CLI после
              настройки серверного <code>OWNER_SETUP_SECRET</code>. Секрет не вводится на этой
              странице, не попадает в JavaScript bundle и не передаётся браузером.
            </p>
            <p style={{ color: "var(--muted, #9494a3)", fontSize: 12 }}>
              Инструкции и безопасное восстановление: <code>CODEX_SETUP.md</code>. После создания
              владельца обновите страницу и войдите через Supabase Auth.
            </p>
          </section>
        ) : (
          <form onSubmit={submit} className="login-card">
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
              <span className="brand-mark">
                <Command size={18} />
              </span>
              <div>
                <h2>{setup ? "Создание владельца" : "Вход в панель"}</h2>
                <p style={{ margin: "3px 0 0" }}>
                  {setup
                    ? "Первый запуск. Пароль не короче 10 символов. Ключи API в чат не отправляйте."
                    : "Закрытая панель. Сессия управляется выбранным сервером авторизации."}
                </p>
              </div>
            </div>
            <div>
              {setup && (
                <Field label="Имя">
                  <Input value={name} onChange={(e) => setName(e.target.value)} required />
                </Field>
              )}
              <Field label="Email">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="username"
                />
              </Field>
              <Field label="Пароль">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete={setup ? "new-password" : "current-password"}
                />
              </Field>
              {error && <div className="login-error">{error}</div>}
              <div style={{ marginTop: 16 }}>
                <Button type="submit" className="full" disabled={pending} style={{ height: 42 }}>
                  {pending ? "Подождите…" : setup ? "Создать аккаунт" : "Войти"}
                </Button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
