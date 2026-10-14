import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
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
      <div className="grid min-h-dvh place-items-center bg-bg text-muted-fg">
        Загрузка VK AI Manager…
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
