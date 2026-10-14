import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { Command } from "lucide-react";
import { getBackend } from "@/data";
import type { UserPublic } from "@shared/types";
import { AppShell } from "@/components/layout";
import LoginPage from "@/pages/LoginPage";
import DashboardPage from "@/pages/DashboardPage";
import CommunitiesPage from "@/pages/CommunitiesPage";
import CommunityDetailPage from "@/pages/CommunityDetailPage";
import PostsPage from "@/pages/PostsPage";
import PostDetailPage from "@/pages/PostDetailPage";
import CalendarPage from "@/pages/CalendarPage";
import StudioPage from "@/pages/StudioPage";
import CharactersPage from "@/pages/CharactersPage";
import AnalyticsPage from "@/pages/AnalyticsPage";
import SettingsPage from "@/pages/SettingsPage";
import NotificationsPage from "@/pages/NotificationsPage";

export default function App() {
  const [user, setUser] = useState<UserPublic | null>(null);
  const [setup, setSetup] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const loc = useLocation();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await getBackend().auth.status();
        if (!alive) return;
        setSetup(s.setupComplete);
        setUser(s.user);
      } catch {
        if (alive) setSetup(false);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [loc.pathname]);

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "var(--bg, #09090b)",
          color: "var(--muted, #9494a3)",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
          <div
            className="brand-mark"
            style={{ width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center", background: "#8b5cf6", color: "#fff", boxShadow: "0 0 24px #8b5cf633" }}
          >
            <Command size={22} />
          </div>
          <span style={{ fontSize: 12, letterSpacing: ".04em" }}>Загрузка VKBablo…</span>
        </div>
      </div>
    );
  }

  const authed = Boolean(user);

  return (
    <Routes>
      <Route path="/login" element={authed ? <Navigate to="/" replace /> : <LoginPage setup={!setup} onDone={setUser} />} />
      <Route element={authed ? <AppShell user={user!} /> : <Navigate to="/login" replace />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/communities" element={<CommunitiesPage />} />
        <Route path="/communities/:id" element={<CommunityDetailPage />} />
        <Route path="/posts" element={<PostsPage />} />
        <Route path="/posts/:id" element={<PostDetailPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/studio" element={<StudioPage />} />
        <Route path="/characters" element={<CharactersPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
      </Route>
      <Route path="*" element={<Navigate to={authed ? "/" : "/login"} replace />} />
    </Routes>
  );
}
