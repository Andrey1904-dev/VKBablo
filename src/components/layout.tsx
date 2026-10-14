import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  CalendarDays,
  ChevronRight,
  Command,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  WandSparkles,
  BarChart3,
  BookOpen,
  X,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { getBackend } from "@/data";
import { COMMUNITY_IDS } from "@shared/types";
import { COMMUNITY_META } from "@shared/constants";
import { addDays, moscowParts } from "@shared/moscow";
import { fromDatetimeLocalMoscow } from "@/lib/time";
import { isLightTheme, setTheme } from "@/lib/theme";
import { Avatar, Button, Field, Input, Select, Textarea } from "./ui";
import { Toaster, closeCreateModal, openCreateModal, toast, useCreateModalOpen } from "./toast";
import { cn } from "@/lib/cn";

const NAV: { to: string; label: string; icon: LucideIcon; group: string; end?: boolean }[] = [
  { to: "/", label: "Главная", icon: LayoutDashboard, group: "Рабочее пространство", end: true },
  { to: "/communities", label: "Сообщества", icon: Users, group: "Рабочее пространство" },
  { to: "/calendar", label: "Календарь", icon: CalendarDays, group: "Рабочее пространство" },
  { to: "/studio", label: "AI-студия", icon: WandSparkles, group: "Рабочее пространство" },
  { to: "/posts", label: "На проверке", icon: ShieldCheck, group: "Рабочее пространство" },
  { to: "/characters", label: "Персонажи", icon: BookOpen, group: "Инструменты" },
  { to: "/analytics", label: "Аналитика", icon: BarChart3, group: "Инструменты" },
  { to: "/notifications", label: "Уведомления", icon: Bell, group: "Инструменты" },
  { to: "/settings", label: "Настройки", icon: Settings, group: "Система" },
];

const GROUPS = ["Рабочее пространство", "Инструменты", "Система"];

function crumbs(pathname: string): { label: string; to?: string }[] {
  if (pathname === "/" || pathname === "") return [{ label: "Главная" }];
  const seg = pathname.split("/").filter(Boolean);
  const first = seg[0];
  const map: Record<string, string> = {
    communities: "Сообщества",
    posts: "На проверке",
    calendar: "Календарь",
    studio: "AI-студия",
    characters: "Персонажи",
    analytics: "Аналитика",
    notifications: "Уведомления",
    settings: "Настройки",
    login: "Вход",
  };
  const head = map[first] ?? "VKBablo";
  if (seg.length > 1) {
    const tail = first === "communities" ? "Карточка сообщества" : first === "posts" ? "Публикация" : decodeURIComponent(seg[1]);
    return [{ label: head, to: `/${first}` }, { label: tail }];
  }
  return [{ label: head }];
}

/** Модальное окно «Создать публикацию» из макета; каждая опция выполняет реальное действие. */
function CreateModal() {
  const nav = useNavigate();
  const [mode, setMode] = useState<"menu" | "manual">("menu");
  const [communityId, setCommunityId] = useState<string>("stories");
  const [date, setDate] = useState(() => addDays(moscowParts().dateStr, 1));
  const [time, setTime] = useState("13:30");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeCreateModal();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function close() {
    closeCreateModal();
    setMode("menu");
    setError("");
  }

  async function createManual() {
    if (!date || !time) {
      setError("Укажите дату и время публикации (по Москве).");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const post = await getBackend().createPost({
        communityId,
        scheduledAt: fromDatetimeLocalMoscow(`${date}T${time}`),
        title: title.trim() || undefined,
        text: text.trim() || undefined,
      });
      toast("Публикация создана. До выхода в VK нужно одобрение.");
      close();
      nav(`/posts/${post.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        {mode === "menu" ? (
          <>
            <div className="modal-head">
              <div>
                <h2>Создать публикацию</h2>
                <p>Выберите способ создания контента</p>
              </div>
              <button className="icon-btn" onClick={close} aria-label="Закрыть">
                <X size={18} />
              </button>
            </div>
            <button
              className="create-option"
              onClick={() => {
                close();
                nav("/studio");
              }}
            >
              <span className="option-icon ai">
                <Sparkles size={20} />
              </span>
              <span>
                <b>Создать с помощью AI</b>
                <small>Идея, текст и изображение за несколько минут</small>
              </span>
              <ChevronRight size={17} />
            </button>
            <button className="create-option" onClick={() => setMode("manual")}>
              <span className="option-icon">
                <Pencil size={20} />
              </span>
              <span>
                <b>Создать вручную</b>
                <small>Черновик с вашим текстом — на проверку и в расписание</small>
              </span>
              <ChevronRight size={17} />
            </button>
            <button
              className="create-option"
              onClick={() => {
                close();
                nav("/posts?status=draft");
              }}
            >
              <span className="option-icon">
                <FileText size={20} />
              </span>
              <span>
                <b>Из черновика</b>
                <small>Продолжите работу над сохранённым постом</small>
              </span>
              <ChevronRight size={17} />
            </button>
          </>
        ) : (
          <>
            <div className="modal-head">
              <div>
                <h2>Новая публикация</h2>
                <p>Черновик сохранится со статусом «Черновик» и потребует одобрения</p>
              </div>
              <button className="icon-btn" onClick={close} aria-label="Закрыть">
                <X size={18} />
              </button>
            </div>
            <Field label="Сообщество">
              <Select value={communityId} onChange={(e) => setCommunityId(e.target.value)}>
                {COMMUNITY_IDS.map((id) => (
                  <option key={id} value={id}>
                    {COMMUNITY_META[id].name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="field-row">
              <Field label="Дата (Москва)">
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Время">
                <Select value={time} onChange={(e) => setTime(e.target.value)}>
                  {["13:30", "17:30", "21:30"].map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Заголовок (необязательно)">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="О чём публикация" maxLength={120} />
            </Field>
            <Field label="Текст (необязательно)">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Текст публикации" style={{ minHeight: 120 }} />
            </Field>
            {error && <p className="login-error">{error}</p>}
            <div className="settings-save" style={{ marginTop: 14 }}>
              <Button variant="ghost" onClick={() => setMode("menu")} disabled={busy}>
                Назад
              </Button>
              <Button onClick={createManual} disabled={busy}>
                {busy ? "Создаём…" : "Создать черновик"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function AppShell({ user }: { user: { name: string; email: string } }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("vkai-sidebar") === "collapsed");
  const [paused, setPaused] = useState(false);
  const [pendingReview, setPendingReview] = useState(0);
  const [unread, setUnread] = useState(0);
  const [light, setLight] = useState(() => isLightTheme());
  const [mode, setMode] = useState("test");
  const nav = useNavigate();
  const loc = useLocation();
  const modalOpen = useCreateModalOpen();

  const backend = getBackend();
  const backendInfo = backend.info;

  async function refresh() {
    try {
      const [d, n] = await Promise.all([backend.dashboard(), backend.notifications()]);
      setPaused(d.automationPaused);
      setMode(d.mode);
      setPendingReview(d.pendingReview);
      setUnread(n.unread);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 12000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setOpen(false);
  }, [loc.pathname]);

  useEffect(() => {
    localStorage.setItem("vkai-sidebar", collapsed ? "collapsed" : "expanded");
  }, [collapsed]);

  // ⌘K / Ctrl+K — переход к поиску по публикациям (как на кнопке в топбаре)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        nav("/posts");
        window.dispatchEvent(new Event("vkai:focus-search"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  async function togglePause() {
    try {
      await backend.setAutomationPaused(!paused);
      toast(!paused ? "Автоматизация поставлена на паузу" : "Автоматизация запущена");
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    }
  }

  function toggleTheme() {
    const next = !light;
    setLight(next);
    setTheme(next);
  }

  async function onLogout() {
    await backend.auth.signOut();
    nav("/login");
    location.reload();
  }

  const initials =
    user.name
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "ВЛ";

  const modeShort =
    backendInfo.kind === "supabase" ? "Supabase · облако" : backendInfo.kind === "local" ? "Локальный стенд" : "Демо-режим · браузер";

  const sideNav: ReactNode = (
    <nav>
      {GROUPS.map((g) => (
        <div className="nav-group" key={g}>
          <span className="nav-label">{g}</span>
          {NAV.filter((n) => n.group === g).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={item.label}
              className={({ isActive }) => cn(isActive && "active")}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.to === "/posts" && pendingReview > 0 && <i>{pendingReview}</i>}
              {item.to === "/notifications" && unread > 0 && <i>{unread}</i>}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );

  const side = (
    <>
      <div className="brand">
        <div className="brand-mark">
          <Command size={19} />
        </div>
        <div className="brand-copy">
          <b>VKBablo</b>
          <span>AI Content Manager</span>
        </div>
        <button className="collapse" onClick={() => setCollapsed(!collapsed)} title={collapsed ? "Развернуть меню" : "Свернуть меню"}>
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>
      {sideNav}
      <div className="sidebar-bottom">
        <div className="connection">
          <i className={paused ? "paused" : ""} />
          <span>
            <b>{paused ? "Автоматизация на паузе" : "Система работает"}</b>
            <small>{modeShort}{mode === "test" ? " · VK dry-run" : " · согласование"}</small>
          </span>
          <button className="icon-btn" onClick={togglePause} title={paused ? "Запустить автоматизацию" : "Поставить на паузу"}>
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button className="profile" onClick={() => nav("/settings")} title="Настройки">
            <span>{initials}</span>
            <span>
              <b>{user.name}</b>
              <small>{user.email}</small>
            </span>
          </button>
          <button className="icon-btn" onClick={onLogout} title="Выйти" aria-label="Выйти" style={{ flex: "none" }}>
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </>
  );

  const crumb = crumbs(loc.pathname);

  return (
    <div className={cn("app", collapsed && "sidebar-collapsed")}>
      {open && <button className="mobile-overlay" onClick={() => setOpen(false)} aria-label="Закрыть меню" />}
      <aside className={cn("sidebar", open && "mobile-open")}>{side}</aside>
      <main>
        <div className="topbar">
          <button className="mobile-menu icon-btn" onClick={() => setOpen(true)} aria-label="Открыть меню">
            <Menu size={19} />
          </button>
          <div className="breadcrumbs">
            <span>VKBablo</span>
            {crumb.map((c, i) => (
              <Fragment key={i}>
                <ChevronRight size={13} />
                {c.to ? (
                  <a
                    href={c.to}
                    onClick={(e) => {
                      e.preventDefault();
                      nav(c.to!);
                    }}
                    style={{ color: "var(--muted)" }}
                  >
                    {c.label}
                  </a>
                ) : (
                  <b>{c.label}</b>
                )}
              </Fragment>
            ))}
          </div>
          <div className="top-actions">
            <button
              className="search-trigger"
              onClick={() => {
                nav("/posts");
                window.dispatchEvent(new Event("vkai:focus-search"));
              }}
            >
              <Search size={15} />
              <span>Поиск</span>
              <kbd>⌘ K</kbd>
            </button>
            <button className="icon-btn" onClick={toggleTheme} aria-label="Переключить тему">
              {light ? <Moon size={17} /> : <Sun size={17} />}
            </button>
            <NavLink to="/notifications" className="icon-btn notification" title="Уведомления">
              <Bell size={17} />
              {unread > 0 && <i />}
            </NavLink>
            <Button className="top-create" onClick={() => { setOpen(false); openCreateModal(); }}>
              <Plus size={16} /> Создать
            </Button>
          </div>
        </div>
        <Outlet />
      </main>
      {modalOpen && <CreateModal />}
      <Toaster />
    </div>
  );
}

/** Аватар сообщества по id — общий хелпер для страниц. */
export function CommunityAvatar({
  id,
  size = "md",
}: {
  id: string;
  size?: "sm" | "md" | "lg";
}) {
  const meta = COMMUNITY_META[id as keyof typeof COMMUNITY_META];
  if (!meta) return null;
  return (
    <Avatar
      color={meta.color}
      short={meta.shortName}
      title={meta.name}
      img={`${import.meta.env.BASE_URL}avatars/${id}.svg`}
      size={size}
    />
  );
}
