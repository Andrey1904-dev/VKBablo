import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Bell,
  CalendarDays,
  Clapperboard,
  Gauge,
  LayoutGrid,
  LogOut,
  Menu,
  Moon,
  Pause,
  Play,
  Settings,
  Sparkles,
  Sun,
  Users,
  BarChart3,
  ScrollText,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { getBackend } from "@/data";
import { Button } from "./ui";
import { moscowNowLabel } from "@/lib/time";
import { cn } from "@/lib/cn";

const NAV = [
  { to: "/", label: "Панель", icon: Gauge, end: true },
  { to: "/communities", label: "Сообщества", icon: LayoutGrid },
  { to: "/posts", label: "Публикации", icon: ScrollText },
  { to: "/calendar", label: "Календарь", icon: CalendarDays },
  { to: "/studio", label: "ИИ-студия", icon: Sparkles },
  { to: "/characters", label: "Персонажи", icon: Users },
  { to: "/analytics", label: "Аналитика", icon: BarChart3 },
  { to: "/notifications", label: "Уведомления", icon: Bell },
  { to: "/settings", label: "Настройки", icon: Settings },
];

export function AppShell({ user }: { user: { name: string; email: string } }) {
  const [open, setOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [unread, setUnread] = useState(0);
  const [mode, setMode] = useState("test");
  const nav = useNavigate();

  const backend = getBackend();
  const backendInfo = backend.info;

  async function refresh() {
    try {
      const [d, n] = await Promise.all([backend.dashboard(), backend.notifications()]);
      setPaused(d.automationPaused);
      setMode(d.mode);
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

  async function togglePause() {
    await backend.setAutomationPaused(!paused);
    refresh();
  }

  function toggleTheme() {
    const dark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("vkai-theme", dark ? "dark" : "light");
  }

  async function onLogout() {
    await backend.auth.signOut();
    nav("/login");
    location.reload();
  }

  const side = (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-fg">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-sm font-extrabold text-white">
          AI
        </div>
        <div>
          <div className="text-sm font-extrabold tracking-tight">VK AI Manager</div>
          <div className="text-[11px] text-sidebar-fg/60">Europe/Moscow</div>
        </div>
      </div>
      <nav className="flex-1 space-y-1 px-3">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setOpen(false)}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                isActive ? "bg-white/10 text-white" : "text-sidebar-fg/70 hover:bg-white/5 hover:text-white",
              )
            }
          >
            <item.icon size={18} />
            <span className="flex-1">{item.label}</span>
            {item.to === "/notifications" && unread > 0 && (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1 text-[10px] text-white">
                {unread}
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="p-4 space-y-3">
        <div className="rounded-xl bg-white/5 px-3 py-2 text-[11px] text-sidebar-fg/70">
          <div className="font-semibold text-white/90">Режим: {backendInfo.label}</div>
          <div>{mode === "test" ? "Тестовый режим · VK dry-run" : "Согласование · реальный VK"}</div>
          {backendInfo.demo && <div className="mt-1 text-amber-300">Данные демонстрационные</div>}
        </div>
        <button onClick={onLogout} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-sidebar-fg/70 hover:bg-white/5">
          <LogOut size={16} /> Выйти
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[260px] lg:block">{side}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[280px]">{side}</div>
        </div>
      )}
      <div className="lg:pl-[260px]">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-bg/80 px-4 py-3 backdrop-blur-xl">
          <button className="grid h-11 w-11 place-items-center rounded-xl hover:bg-muted lg:hidden" onClick={() => setOpen(true)}>
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold capitalize">{moscowNowLabel()}</div>
            <div className="truncate text-xs text-muted-fg">{user.name} · {user.email}</div>
          </div>
          <Button variant={paused ? "danger" : "outline"} size="sm" onClick={togglePause} className="shrink-0">
            {paused ? <Play size={14} /> : <Pause size={14} />}
            <span className="hidden sm:inline">{paused ? "Запустить" : "Стоп"}</span>
          </Button>
          <button className="grid h-11 w-11 place-items-center rounded-xl hover:bg-muted" onClick={toggleTheme} aria-label="Тема">
            <Sun size={18} className="hidden dark:block" />
            <Moon size={18} className="dark:hidden" />
          </button>
          <NavLink to="/studio" className="hidden sm:grid h-11 w-11 place-items-center rounded-xl hover:bg-muted">
            <Clapperboard size={18} />
          </NavLink>
        </header>
        <main className="p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
