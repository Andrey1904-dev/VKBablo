import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getBackend } from "@/data";
import { COMMUNITY_IDS, type CommunityId, type Post } from "@shared/types";
import { COMMUNITY_META } from "@shared/constants";
import { addDays, moscowParts } from "@shared/moscow";
import { Badge, Button, Field, Input, PageHead, Select, Textarea, Toggle } from "@/components/ui";
import { CommunityAvatar } from "@/components/layout";
import { toast } from "@/components/toast";
import { formatMoscow, fromDatetimeLocalMoscow } from "@/lib/time";
import type { AiGenerationRecord, AiProvidersPayload } from "@shared/types";
import type { Idea } from "@shared/content-engine";
import { Bot, Image as ImageIcon, Lightbulb, MoreHorizontal, Pencil, RefreshCw, Send, ShieldCheck, Sparkles } from "lucide-react";

export default function StudioPage() {
  const nav = useNavigate();
  const [communityId, setCommunityId] = useState<CommunityId>("stories");
  const [topic, setTopic] = useState("");
  const [withImage, setWithImage] = useState(true);
  const [date, setDate] = useState(() => addDays(moscowParts().dateStr, 1));
  const [time, setTime] = useState("13:30");
  const [generating, setGenerating] = useState(false);
  const [ideasBusy, setIdeasBusy] = useState(false);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [post, setPost] = useState<Post | null>(null);
  const [history, setHistory] = useState<AiGenerationRecord[]>([]);
  const [provider, setProvider] = useState<AiProvidersPayload | null>(null);
  const [mobilePreview, setMobilePreview] = useState(false);

  useEffect(() => {
    const b = getBackend();
    b.providers().then(setProvider).catch(() => setProvider(null));
    b.aiHistory().then(setHistory).catch(() => setHistory([]));
  }, []);

  async function generate() {
    setGenerating(true);
    try {
      const r = await getBackend().generateSlot({
        communityId,
        scheduledAt: fromDatetimeLocalMoscow(`${date}T${time}`),
        kind: withImage ? "full_post" : "text",
        prompt: topic.trim() || undefined,
        force: true,
      });
      setPost(r);
      getBackend().aiHistory().then(setHistory).catch(() => undefined);
      toast("Публикация сгенерирована. Она ждёт вашего одобрения.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    } finally {
      setGenerating(false);
    }
  }

  async function loadIdeas() {
    setIdeasBusy(true);
    try {
      const r = await getBackend().ideas(communityId);
      setIdeas(r);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    } finally {
      setIdeasBusy(false);
    }
  }

  return (
    <div className="page enter">
      <PageHead
        title="AI-студия"
        description="Создавайте публикации в голосе вашего сообщества."
        actions={
          <Badge tone="purple">
            <Sparkles size={12} /> {provider ? provider.label : "AI-модель"}
          </Badge>
        }
      />

      <div className="studio-grid">
        <section className="surface studio-settings">
          <div className="section-head">
            <div>
              <h2>Новая публикация</h2>
              <p>Настройте идею и стиль контента</p>
            </div>
            <button
              className="icon-btn"
              onClick={loadIdeas}
              disabled={ideasBusy}
              title="Сгенерировать идеи для сообщества"
            >
              {ideasBusy ? <RefreshCw size={17} className="spin" /> : <Lightbulb size={17} />}
            </button>
          </div>

          <Field label="Сообщество">
            <div className="field-control">
              <CommunityAvatar id={communityId} size="sm" />
              <Select value={communityId} onChange={(e) => setCommunityId(e.target.value as CommunityId)} style={{ border: 0, background: "transparent", minHeight: 36 }}>
                {COMMUNITY_IDS.map((id) => (
                  <option key={id} value={id}>
                    {COMMUNITY_META[id].name}
                  </option>
                ))}
              </Select>
            </div>
          </Field>

          <Field label="Тема публикации" hint="Опишите сюжет или основную мысль — или оставьте пустым, и движок предложит свою идею">
            <Textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="Например: Милана собирается на сельскую дискотеку и выбирает образ, который точно запомнят все соседи"
            />
          </Field>

          <div className="field-row">
            <Field label="Дата (Москва)">
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Слот">
              <Select value={time} onChange={(e) => setTime(e.target.value)}>
                {["13:30", "17:30", "21:30"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="toggle-row">
            <div>
              <ImageIcon size={17} />
              <span>
                <b>Создать изображение</b>
                <small>Демо-режим рисует карточку-заглушку, платные API не вызываются</small>
              </span>
            </div>
            <Toggle on={withImage} onChange={setWithImage} title="Генерировать изображение вместе с текстом" />
          </div>

          {provider && (
            <p className="mono" style={{ margin: "10px 0 0", lineHeight: 1.7 }}>
              Провайдер: {provider.label} · ключ {provider.configuredKey ? "задан" : "не задан"} · референсы{" "}
              {provider.supportsReferences ? "поддерживаются" : "не поддерживаются (сходство не гарантируется)"}
              {provider.demo ? " · демо-движок" : ""}
            </p>
          )}
          {provider?.limitations?.length ? (
            <ul style={{ margin: "8px 0 0", paddingLeft: 16, fontSize: 10, color: "var(--muted)", lineHeight: 1.7 }}>
              {provider.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : null}

          <Button className="generate-btn" onClick={generate} disabled={generating}>
            {generating ? (
              <>
                <RefreshCw className="spin" size={17} /> Создаём магию…
              </>
            ) : (
              <>
                <Sparkles size={17} /> Сгенерировать пост
              </>
            )}
          </Button>

          {ideas.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <div className="section-head">
                <div>
                  <h2 style={{ fontSize: 14 }}>Идеи для «{COMMUNITY_META[communityId as keyof typeof COMMUNITY_META]?.shortName}»</h2>
                  <p>Нажмите «Сгенерировать пост» — движок разовьёт идею в текст</p>
                </div>
              </div>
              <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
                {ideas.map((idea) => (
                  <div className="idea-card" key={idea.key} onClick={() => setTopic(idea.title + ". " + idea.angle)} style={{ cursor: "pointer" }}>
                    <span className="mono">{idea.series || idea.topic}</span>
                    <b>{idea.title}</b>
                    <p>{idea.angle}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="preview-wrap">
          <div className="preview-top">
            <div>
              <b>Предпросмотр</b>
              <span>Так публикация будет выглядеть во ВКонтакте</span>
            </div>
            <div className="desktop-mobile">
              <button className={!mobilePreview ? "active" : ""} onClick={() => setMobilePreview(false)}>
                Десктоп
              </button>
              <button className={mobilePreview ? "active" : ""} onClick={() => setMobilePreview(true)}>
                Телефон
              </button>
            </div>
          </div>

          <div className={`vk-post ${generating ? "loading" : ""}`} style={mobilePreview ? { maxWidth: 380 } : undefined}>
            {generating ? (
              <div className="skeletons">
                <i />
                <i />
                <i />
                <i />
              </div>
            ) : post ? (
              <>
                <div className="vk-head">
                  <CommunityAvatar id={post.communityId} />
                  <div>
                    <b>{COMMUNITY_META[post.communityId]?.name ?? post.communityId}</b>
                    <span>{post.testMode ? "предпросмотр · dry-run" : "предпросмотр"}</span>
                  </div>
                  <MoreHorizontal size={20} />
                </div>
                {post.title && <p style={{ fontWeight: 600 }}>{post.title}</p>}
                <p>{post.text}</p>
                {(post.imageUrl || post.imagePath) && (
                  <img className="vk-image" src={post.imageUrl || post.imagePath!} alt="Иллюстрация к публикации" />
                )}
              </>
            ) : (
              <>
                <div className="vk-head">
                  <CommunityAvatar id={communityId} />
                  <div>
                    <b>{COMMUNITY_META[communityId as keyof typeof COMMUNITY_META]?.name}</b>
                    <span>здесь появится сгенерированный текст</span>
                  </div>
                  <MoreHorizontal size={20} />
                </div>
                <p style={{ color: "#818c99" }}>
                  Настройте параметры слева и нажмите «Сгенерировать пост». Если ключ AI не задан, работает тестовый
                  детерминированный движок — это честно указано и не выдаётся за боевую модель.
                </p>
              </>
            )}
          </div>

          {post && (
            <>
              <div className="preview-status">
                <Badge tone={post.status === "review" ? "warning" : "purple"}>
                  {post.status === "review" ? "На проверке" : "Готово к проверке"}
                </Badge>
                <span>
                  <Send size={14} /> Запланировано на {formatMoscow(post.scheduledAt)} МСК
                </span>
              </div>
              <div className="preview-actions">
                <Button variant="secondary" onClick={() => nav(`/posts/${post.id}`)}>
                  <Pencil size={15} /> Редактировать
                </Button>
                <Button variant="secondary" onClick={generate} disabled={generating}>
                  <RefreshCw size={15} /> Перегенерировать
                </Button>
                <Button onClick={() => nav("/posts")}>
                  <ShieldCheck size={15} /> На проверку
                </Button>
              </div>
            </>
          )}

          <section className="surface" style={{ padding: 18, marginTop: 18 }}>
            <div className="section-head">
              <div>
                <h2>История генераций</h2>
                <p>Все вызовы движка фиксируются вместе с расходом</p>
              </div>
              <Bot size={16} style={{ color: "var(--muted)" }} />
            </div>
            <ul className="history-list">
              {history.map((g) => (
                <li key={g.id}>
                  <b>{g.type}</b>
                  <span style={{ color: "var(--muted)" }}>{g.provider}</span>
                  <span className={`mono ${g.error ? "danger" : ""}`}>
                    {g.error ? "ошибка" : `$${Number(g.costUsd || 0).toFixed(3)}`}
                  </span>
                </li>
              ))}
              {history.length === 0 && (
                <li style={{ color: "var(--muted)", border: 0 }}>Пока пусто — сгенерируйте первую публикацию</li>
              )}
            </ul>
          </section>
        </section>
      </div>
    </div>
  );
}
