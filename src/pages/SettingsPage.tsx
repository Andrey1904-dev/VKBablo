import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getBackend } from "@/data";
import { COMMUNITY_META } from "@shared/constants";
import { COMMUNITY_IDS, type ApplicationSettings } from "@shared/types";
import { Badge, Button, Field, Input, PageHead, Select, Toggle } from "@/components/ui";
import { toast } from "@/components/toast";
import { isLightTheme, setTheme } from "@/lib/theme";
import { Check, ChevronRight, Moon, Sun } from "lucide-react";

const TABS = ["Общие", "Сообщества", "Искусственный интеллект", "Публикации", "Безопасность"] as const;
type Tab = (typeof TABS)[number];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("Общие");
  const [s, setS] = useState<ApplicationSettings | null>(null);
  const [aiKey, setAiKey] = useState("");
  const [light, setLight] = useState(() => isLightTheme());

  async function load() {
    setS(await getBackend().settings());
  }
  useEffect(() => {
    load();
  }, []);

  async function save(patch: Record<string, unknown>, okText = "Сохранено") {
    try {
      await getBackend().saveSettings(patch);
      toast(okText);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    }
  }

  async function testAi() {
    try {
      const r = await getBackend().testAi();
      toast(r.ok ? `AI отвечает (${r.provider}): ${r.sample}` : r.error || "ошибка", r.ok ? "ok" : "error");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    }
  }

  async function saveAiKey() {
    try {
      await getBackend().saveAiKey(aiKey || null);
      setAiKey("");
      toast("Ключ сохранён на сервере и не отображается");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    }
  }

  function chooseTheme(next: boolean) {
    setLight(next);
    setTheme(next);
  }

  if (!s) {
    return (
      <div className="page enter">
        <p style={{ color: "var(--muted)", fontSize: 12 }}>Загрузка…</p>
      </div>
    );
  }

  const info = getBackend().info;

  return (
    <div className="page enter">
      <PageHead title="Настройки" description="Управляйте рабочим пространством и автоматизацией." />
      <div className="settings-layout">
        <aside>
          {TABS.map((x) => (
            <button className={tab === x ? "active" : ""} onClick={() => setTab(x)} key={x}>
              {x}
            </button>
          ))}
        </aside>

        <section className="surface settings-content">
          {tab === "Общие" && (
            <>
              <div>
                <h2>Общие</h2>
                <p>Основные параметры рабочего пространства VKBablo.</p>
              </div>
              <hr />
              <div className="setting-line">
                <div>
                  <b>Тема интерфейса</b>
                  <span>Выберите комфортное оформление</span>
                </div>
                <div className="theme-choice">
                  <button className={!light ? "active" : ""} onClick={() => chooseTheme(false)}>
                    <Moon size={16} /> Тёмная
                  </button>
                  <button className={light ? "active" : ""} onClick={() => chooseTheme(true)}>
                    <Sun size={16} /> Светлая
                  </button>
                </div>
              </div>
              <div className="setting-line">
                <div>
                  <b>Часовой пояс</b>
                  <span>Расписание работает по Москве: 13:30 / 17:30 / 21:30</span>
                </div>
                <Badge tone="neutral">Europe/Moscow (UTC+3)</Badge>
              </div>
              <div className="setting-line">
                <div>
                  <b>Уведомления на сайте</b>
                  <span>Колокольчик в шапке и страница «Уведомления»</span>
                </div>
                <Toggle on={s.notificationsEnabled} onChange={(v) => save({ notificationsEnabled: v }, v ? "Уведомления включены" : "Уведомления выключены")} />
              </div>
              <div className="setting-line" style={{ borderBottom: 0 }}>
                <div>
                  <b>Режим данных</b>
                  <span>{info.note}</span>
                </div>
                <Badge tone={info.demo ? "warning" : "success"}>{info.label}</Badge>
              </div>
              <hr />
              <p className="settings-note">
                Telegram и web push заложены в архитектуру, но пока не подключены — честно показываем только то, что работает.
              </p>
            </>
          )}

          {tab === "Сообщества" && (
            <>
              <div>
                <h2>Сообщества</h2>
                <p>Четыре группы с фиксированными правилами. Настройки — в карточке каждого сообщества.</p>
              </div>
              <hr />
              {COMMUNITY_IDS.map((id) => {
                const meta = COMMUNITY_META[id];
                return (
                  <Link
                    to={`/communities/${id}`}
                    key={id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 10px",
                      borderRadius: 9,
                    }}
                    className="create-option"
                  >
                    <span className="option-icon" style={{ background: `${meta.color}1a`, color: meta.color }}>
                      {meta.shortName.slice(0, 2).toUpperCase()}
                    </span>
                    <span>
                      <b>{meta.name}</b>
                      <small>{meta.tagline}</small>
                    </span>
                    <ChevronRight size={17} style={{ marginLeft: "auto", color: "var(--muted)" }} />
                  </Link>
                );
              })}
              <p className="settings-note" style={{ marginTop: 12 }}>
                Новые сообщества не подключаются: состав групп и правила согласованы владельцем и менять их нельзя.
              </p>
            </>
          )}

          {tab === "Искусственный интеллект" && (
            <>
              <div>
                <h2>Искусственный интеллект</h2>
                <p>Провайдер, модели и бюджет генерации.</p>
              </div>
              <hr />
              <Field label="Провайдер">
                <Select value={s.aiProvider} onChange={(e) => save({ aiProvider: e.target.value })}>
                  <option value="test">Тестовый движок (без платных вызовов)</option>
                  <option value="openai">OpenAI</option>
                  <option value="compatible">Совместимый API</option>
                </Select>
              </Field>
              <Field label="Модель текста">
                <Input defaultValue={s.aiTextModel} onBlur={(e) => e.target.value !== s.aiTextModel && save({ aiTextModel: e.target.value })} />
              </Field>
              <Field label="Модель изображения">
                <Input defaultValue={s.aiImageModel} onBlur={(e) => e.target.value !== s.aiImageModel && save({ aiImageModel: e.target.value })} />
              </Field>
              <Field label="Base URL (для совместимого API)">
                <Input
                  defaultValue={s.aiBaseUrl}
                  placeholder="https://api.openai.com/v1"
                  onBlur={(e) => e.target.value !== s.aiBaseUrl && save({ aiBaseUrl: e.target.value })}
                />
              </Field>
              <Field label="API-ключ (не отображается после сохранения)" hint="Ключ уходит только на сервер и хранится в зашифрованном виде">
                <Input type="password" value={aiKey} onChange={(e) => setAiKey(e.target.value)} placeholder="Введите новый ключ" />
              </Field>
              <div className="settings-save">
                <Button variant="secondary" onClick={testAi}>
                  Проверить AI
                </Button>
                <Button onClick={saveAiKey} disabled={!aiKey}>
                  <Check size={15} /> Сохранить ключ
                </Button>
              </div>
              <Field label={`Лимит расходов, $/мес (потрачено: $${Number(s.spendUsdMonth || 0).toFixed(2)})`}>
                <Input
                  type="number"
                  defaultValue={s.aiMonthlyLimitUsd}
                  onBlur={(e) => Number(e.target.value) !== s.aiMonthlyLimitUsd && save({ aiMonthlyLimitUsd: Number(e.target.value) })}
                />
              </Field>
              <p className="settings-note">
                В демо-режиме и на локальном стенде работает детерминированный тестовый движок: платные вызовы не выполняются,
                изображения — демонстрационные заглушки. Это указано прямо в студии.
              </p>
            </>
          )}

          {tab === "Публикации" && (
            <>
              <div>
                <h2>Публикации</h2>
                <p>Режим выхода постов и подготовка слотов.</p>
              </div>
              <hr />
              <div className="setting-line" style={{ alignItems: "flex-start" }}>
                <div>
                  <b>Режим работы</b>
                  <span>Самостоятельная публикация без согласования не включена и не будет</span>
                </div>
                <div className="theme-choice">
                  <button className={s.mode === "test" ? "active" : ""} onClick={() => save({ mode: "test" }, "Включён тестовый режим (dry-run)")}>
                    Тестирование
                  </button>
                  <button
                    className={s.mode === "approval" ? "active" : ""}
                    disabled={!info.realPublishPossible}
                    title={!info.realPublishPossible ? "Реальные публикации доступны только в подключённом Supabase backend" : undefined}
                    onClick={() => save({ mode: "approval" }, "Включён режим согласования")}
                  >
                    С согласованием
                  </button>
                </div>
              </div>
              <p className="settings-note" style={{ marginTop: -6 }}>
                {s.mode === "test"
                  ? "Dry-run: посты проходят весь цикл, но VK их не получает."
                  : "После вашего одобрения создаётся отложенная запись VK на время слота."}
              </p>
              <div className="setting-line">
                <div>
                  <b>Автоматизация</b>
                  <span>Генерация постов к ближайшим слотам</span>
                </div>
                <Toggle
                  on={!s.automationPaused}
                  onChange={(v) => save({ automationPaused: !v }, v ? "Автоматизация запущена" : "Автоматизация на паузе")}
                />
              </div>
              <Field label="Готовить посты за N часов до слота">
                <Input
                  type="number"
                  defaultValue={s.prepareHoursAhead}
                  onBlur={(e) => Number(e.target.value) !== s.prepareHoursAhead && save({ prepareHoursAhead: Number(e.target.value) })}
                />
              </Field>
              <div className="setting-line">
                <div>
                  <b>Реальные публикации VK разрешены</b>
                  <span>Предохранитель. По умолчанию выключен; даже включённый не отменяет ручное одобрение</span>
                </div>
                <Toggle
                  on={s.realPublishEnabled}
                  disabled={!info.realPublishPossible}
                  title={!info.realPublishPossible ? "Реальные публикации доступны только в подключённом Supabase backend" : undefined}
                  onChange={(v) =>
                    save({ realPublishEnabled: v }, v ? "Реальные публикации разрешены (по-прежнему только после одобрения)" : "Реальные публикации выключены")
                  }
                />
              </div>
              <p className="settings-note">
                Каждый пост публикуется только после явного одобрения владельцем конкретной версии текста и изображения.
                Изменение одобренного поста сбрасывает одобрение.
              </p>
            </>
          )}

          {tab === "Безопасность" && (
            <>
              <div>
                <h2>Безопасность</h2>
                <p>Где живут ключи и кто может видеть данные.</p>
              </div>
              <hr />
              <div className="setting-line" style={{ borderBottom: 0 }}>
                <div>
                  <b>Supabase</b>
                  <span>{info.note}</span>
                </div>
                <Badge tone={info.kind === "supabase" ? "success" : "warning"}>{info.kind === "supabase" ? "Подключён" : "Не подключён"}</Badge>
              </div>
              <hr />
              <div className="settings-note">
                <b>Правила обращения с ключами</b>
                <ul>
                  <li>В браузере допустимы только публичные значения: VITE_SUPABASE_URL и VITE_SUPABASE_ANON_KEY (при включённом RLS).</li>
                  <li>SUPABASE_SERVICE_ROLE_KEY, VK-токены и ключи AI — только серверное окружение Supabase Edge Functions.</li>
                  <li>Секреты не попадают в Git, логи, localStorage и чат.</li>
                  <li>Инструкции по подключению облака — в файле CODEX_SETUP.md.</li>
                </ul>
              </div>
              <div className="settings-note" style={{ marginTop: 12 }}>
                <b>Статус ключей интерфейса:</b> URL задан: {info.supabaseUrl ? "да" : "нет"} · anon-ключ:{" "}
                {info.hasAnonKey ? "да" : "нет"} · серверные секреты: проверяются отдельно в облаке.
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
