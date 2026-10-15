import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { getBackend } from "@/data";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/api";
import { COMMUNITY_IDS, type Post, type PostFilters } from "@shared/types";
import { COMMUNITY_META } from "@shared/constants";
import { Badge, Button, Empty, PageHead } from "@/components/ui";
import { CommunityAvatar } from "@/components/layout";
import { toast } from "@/components/toast";
import { formatMoscow } from "@/lib/time";
import { Check, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Inbox, MoreHorizontal, Pencil, RefreshCw, Search, ShieldCheck, X } from "lucide-react";

const QUICK: { key: string; label: string; statuses?: string[] }[] = [
  { key: "", label: "Все" },
  { key: "review", label: "На проверке", statuses: ["review", "needs_revision"] },
  { key: "approved", label: "Одобрены", statuses: ["approved", "scheduled"] },
  { key: "published", label: "Опубликованы", statuses: ["published"] },
  { key: "draft", label: "Черновики", statuses: ["draft"] },
];

export default function PostsPage() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);

  const focusRequested = useRef(false);
  const previewRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const [mobileListOpen, setMobileListOpen] = useState(true);

  const [posts, setPosts] = useState<Post[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [communityId, setCommunityId] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const quick = params.get("tab") ?? "";
  const statusParam = params.get("status") ?? "";
  const quickDef = QUICK.find((x) => x.key === quick);

  async function load() {
    const filters: PostFilters = { limit: 300 };
    if (communityId) filters.communityId = communityId as PostFilters["communityId"];
    if (q.trim()) filters.q = q.trim();
    const r = await getBackend().posts(filters);
    setPosts(r);
    setMobileListOpen(true);
    setLoaded(true);
  }

  useEffect(() => {
    load();
  }, [communityId]);

  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    window.addEventListener("vkai:focus-search", focus);
    return () => window.removeEventListener("vkai:focus-search", focus);
  }, []);

  // Фильтр по статусу — на клиенте: быстрые вкладки могут объединять несколько статусов.
  const visible = useMemo(() => {
    return posts.filter((p) => {
      if (statusParam) return p.status === statusParam;
      if (quickDef?.statuses) return quickDef.statuses.includes(p.status);
      if (quickDef?.key) return p.status === quickDef.key;
      return true;
    });
  }, [posts, statusParam, quickDef]);

  const selected = useMemo(
    () => visible.find((p) => p.id === selectedId) ?? visible[0] ?? null,
    [visible, selectedId],
  );

  const selectedIndex = selected ? visible.findIndex((post) => post.id === selected.id) : -1;

  useEffect(() => {
    setMobileListOpen(true);
  }, [quick, statusParam, communityId]);

  function choosePost(id: string) {
    focusRequested.current = true;
    setSelectedId(id);
    setMobileListOpen(false);
  }

  useEffect(() => {
    if (!focusRequested.current) return;
    focusRequested.current = false;
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    const target = mobileListOpen
      ? listRef.current?.querySelector<HTMLButtonElement>('button[aria-current="true"]')
      : previewRef.current;
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "nearest" });
    }
  }, [mobileListOpen, selected?.id]);

  async function act(fn: () => Promise<unknown>, okText: string) {
    if (!selected) return;
    setBusy(true);
    try {
      await fn();
      toast(okText);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page enter review-page">
      <PageHead
        title="На проверке"
        description="Проверьте контент перед публикацией. Одобрение обязательно для каждого поста."
        actions={
          <Badge tone={visible.filter((p) => p.status === "review" || p.status === "needs_revision").length > 0 ? "warning" : "success"}>
            {visible.filter((p) => p.status === "review" || p.status === "needs_revision").length} ожидают решения
          </Badge>
        }
      />

      <div className="review-filters">
        <div className="segmented">
          {QUICK.map((x) => (
            <button
              key={x.key}
              className={quick === x.key ? "active" : ""}
              onClick={() => setParams(x.key ? { tab: x.key } : {})}
            >
              {x.label}
            </button>
          ))}
        </div>
        <div className="search">
          <Search size={16} />
          <input
            ref={searchRef}
            placeholder="Найти публикацию…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); load(); } }}
          />
        </div>
        <select aria-label="Сообщество" className="select-btn" value={communityId} onChange={(e) => setCommunityId(e.target.value)}>
          <option value="">Все сообщества</option>
          {COMMUNITY_IDS.map((id) => (
            <option key={id} value={id}>
              {COMMUNITY_META[id].shortName}
            </option>
          ))}
        </select>
      </div>

      {loaded && visible.length === 0 ? (
        <div className="surface">
          <Empty
            icon={Inbox}
            title={posts.length === 0 && !q.trim() && !communityId ? "Публикаций пока нет" : "Нет публикаций по выбранным фильтрам"}
            text="Измените фильтры или создайте материал в AI-студии. Каждый пост требует ручного одобрения."
            action={
              <Button onClick={() => nav("/studio")}>
                <ShieldCheck size={16} /> Открыть AI-студию
              </Button>
            }
          />
        </div>
      ) : (
        <div className={`review-grid ${mobileListOpen ? "is-list-open" : "is-preview-open"}`}>
          <div className="review-mobile-controls">
            <Button variant="secondary" disabled={busy} aria-expanded={mobileListOpen} aria-controls="review-list" onClick={() => { focusRequested.current = true; setMobileListOpen(!mobileListOpen); }}>
              {mobileListOpen ? "К просмотру" : "К списку"} · {visible.length}
            </Button>
            {selected && (
              <div className="review-mobile-navigation" aria-label="Навигация по публикациям">
                <Button variant="ghost" aria-label="Предыдущая публикация" disabled={busy || selectedIndex <= 0} onClick={() => choosePost(visible[selectedIndex - 1].id)}><ChevronLeft size={18} /></Button>
                <span role="status">{selectedIndex + 1} из {visible.length}</span>
                <Button variant="ghost" aria-label="Следующая публикация" disabled={busy || selectedIndex >= visible.length - 1} onClick={() => choosePost(visible[selectedIndex + 1].id)}><ChevronRight size={18} /></Button>
              </div>
            )}
          </div>
          <aside ref={listRef} id="review-list" className="review-list" aria-label="Публикации очереди">
            {visible.map((p) => {
              const meta = COMMUNITY_META[p.communityId];
              return (
                <button
                  key={p.id}
                  className={p.id === selected?.id ? "active" : ""}
                  aria-current={p.id === selected?.id ? "true" : undefined}
                  disabled={busy}
                  onClick={() => choosePost(p.id)}
                >
                  <CommunityAvatar id={p.communityId} />
                  <span>
                    <b>{meta?.name ?? p.communityId}</b>
                    <small>{p.title || p.topic}</small>
                    <em>
                      <Clock3 size={12} />
                      {formatMoscow(p.scheduledAt)}
                    </em>
                  </span>
                  {p.status === "approved" || p.status === "published" || p.status === "scheduled" ? (
                    <CheckCircle2 className="green" size={18} />
                  ) : (
                    <ChevronRight className="chev" size={16} />
                  )}
                </button>
              );
            })}
          </aside>

          {selected ? (
            <section ref={previewRef} tabIndex={-1} aria-label="Просмотр публикации" className="review-preview">
              <div className="review-preview-head">
                <div>
                  <Badge tone={STATUS_TONE[selected.status] ?? "neutral"}>{STATUS_LABEL[selected.status] ?? selected.status}</Badge>
                  {selected.testMode && <Badge tone="neutral">dry-run</Badge>}
                  <span>
                    версия {selected.version} · создано {formatMoscow(selected.createdAt)}
                  </span>
                </div>
                <Link to={`/posts/${selected.id}`} className="icon-btn" title="Полный редактор">
                  <MoreHorizontal size={18} />
                </Link>
              </div>

              <div className="review-post">
                <div className="vk-head">
                  <CommunityAvatar id={selected.communityId} />
                  <div>
                    <b>{COMMUNITY_META[selected.communityId]?.name ?? selected.communityId}</b>
                    <span>{formatMoscow(selected.scheduledAt)}</span>
                  </div>
                </div>
                <p>
                  <b>{selected.title || selected.topic}</b>
                </p>
                <p style={{ whiteSpace: "pre-wrap" }}>{selected.text || "Текст ещё не сгенерирован."}</p>
                {(selected.imageUrl || selected.imagePath) && (
                  <img src={selected.imageUrl || selected.imagePath!} alt="Изображение публикации" />
                )}
                {selected.errorMessage && (
                  <p style={{ color: "var(--red)", fontSize: 12 }}>{selected.errorMessage}</p>
                )}
              </div>

              <div className="review-bar">
                <Button variant="ghost" disabled={busy} onClick={() => act(() => getBackend().rejectPost(selected.id), "Публикация отклонена")}>
                  <X size={16} /> Отклонить
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => act(() => getBackend().revisePost(selected.id, "all"), "Отправлено на доработку")}
                >
                  <RefreshCw size={16} /> На доработку
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => nav(`/posts/${selected.id}`)}>
                  <Pencil size={15} /> Редактировать
                </Button>
                <Button
                  disabled={busy || selected.status === "approved" || selected.status === "published"}
                  onClick={() => act(() => getBackend().approvePost(selected.id), "Публикация одобрена и добавлена в расписание")}
                >
                  <Check size={17} /> {selected.status === "approved" ? "Одобрено" : "Одобрить"}
                </Button>
              </div>
            </section>
          ) : (
            <section className="review-preview">
              <Empty icon={Inbox} title="Выберите публикацию" text="Список слева — все публикации с учётом фильтров." />
            </section>
          )}
        </div>
      )}
    </div>
  );
}
