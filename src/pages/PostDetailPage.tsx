import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getBackend } from "@/data";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/api";
import { COMMUNITY_META } from "@shared/constants";
import { Badge, Button, Field, Input, PageHead, Textarea } from "@/components/ui";
import { CommunityAvatar } from "@/components/layout";
import { toast } from "@/components/toast";
import { formatMoscow, fromDatetimeLocalMoscow, toDatetimeLocalMoscow } from "@/lib/time";
import { AlertCircle, ArrowLeft, Check, Clock3, Eye, FileText, History, Pencil, RefreshCw, Send, Upload, X } from "lucide-react";
import type { PostDetailPayload } from "@shared/types";

export default function PostDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pack, setPack] = useState<PostDetailPayload | null>(null);
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const [comment, setComment] = useState("");
  const [what, setWhat] = useState<"text" | "image" | "all">("all");
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await getBackend().post(id!);
    setPack(r);
    setText(r.post.text);
    setWhen(toDatetimeLocalMoscow(r.post.scheduledAt));
  }
  useEffect(() => {
    load();
  }, [id]);

  async function act(fn: () => Promise<unknown>, okText: string) {
    setBusy(true);
    try {
      await fn();
      if (okText) toast(okText);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await getBackend().editPost(id!, { text, scheduledAt: fromDatetimeLocalMoscow(when) });
      await load();
      toast("Сохранено. Если пост был одобрен — согласование сброшено.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(f: File) {
    await act(async () => {
      const up = await getBackend().uploadMedia(f, "posts", { postId: id });
      await getBackend().editPost(id!, { imagePath: up.path });
    }, "Изображение обновлено. Одобрение сброшено.");
  }

  if (!pack) {
    return (
      <div className="page enter">
        <p style={{ color: "var(--muted)", fontSize: 12 }}>Загрузка…</p>
      </div>
    );
  }
  const p = pack.post;
  const meta = COMMUNITY_META[p.communityId];
  const img = pack.imageUrl || p.imagePath;

  return (
    <div className="page enter">
      <PageHead
        title={p.title || p.topic || "Публикация"}
        description={`${formatMoscow(p.scheduledAt)} · ${meta?.name ?? p.communityId} · версия ${p.version}${p.testMode ? " · dry-run (VK не задействован)" : ""}`}
        actions={
          <>
            <Button variant="ghost" onClick={() => nav(-1)}>
              <ArrowLeft size={15} /> Назад
            </Button>
            <Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{STATUS_LABEL[p.status] ?? p.status}</Badge>
          </>
        }
      />

      <div className="editor-grid">
        <div>
          <section className="surface" style={{ padding: 19 }}>
            <div className="section-head">
              <div>
                <h2>Редактор</h2>
                <p>Любое изменение сбрасывает одобрение — пост снова попадёт на проверку</p>
              </div>
            </div>
            <Field label="Текст публикации">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 260 }} />
            </Field>
            <div className="field-row">
              <Field label="Время публикации (Москва)">
                <Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
              </Field>
              <Field label="Перегенерировать" hint="Что именно пересоздавать при нажатии «Переделать»">
                <div className="choice-row">
                  {(["text", "image", "all"] as const).map((w) => (
                    <button key={w} className={what === w ? "active" : ""} onClick={() => setWhat(w)} type="button">
                      {w === "text" ? "Текст" : w === "image" ? "Картинку" : "Всё"}
                    </button>
                  ))}
                </div>
              </Field>
            </div>
            <Field label="Комментарий к решению (для истории одобрений)">
              <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Например: сократить второй абзац" />
            </Field>

            <div className="editor-actions" style={{ marginTop: 16 }}>
              <Button variant="secondary" disabled={busy} onClick={save}>
                <Pencil size={15} /> Сохранить правки
              </Button>
              <Button disabled={busy} onClick={() => act(() => getBackend().approvePost(id!, comment), "Публикация одобрена")}>
                <Check size={16} /> Одобрить
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => act(() => getBackend().regeneratePost(id!, what), "Перегенерация выполнена")}>
                <RefreshCw size={15} /> Переделать
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => act(() => getBackend().revisePost(id!, what, comment), "Отправлено на доработку")}
              >
                <RefreshCw size={15} /> На доработку
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => act(() => getBackend().rejectPost(id!, comment), "Публикация отклонена")}>
                <X size={16} /> Отклонить
              </Button>
              {p.status === "scheduled" ? (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    void act(
                      () => getBackend().unschedulePost(id!, "отменено владельцем"),
                      "Публикация снята с расписания; результат подтверждён сервером",
                    );
                  }}
                >
                  <X size={15} /> Снять с расписания
                </Button>
              ) : (
                <Button variant="secondary" disabled={busy} onClick={() => act(() => getBackend().schedulePost(id!), "Запланировано")}>
                  <Send size={15} /> Запланировать в VK
                </Button>
              )}
            </div>

            {p.errorMessage && (
              <div className="notice danger" style={{ marginTop: 14 }}>
                <AlertCircle size={15} />
                <span>{p.errorMessage}</span>
              </div>
            )}
            {p.similarityScore != null && p.similarityScore > 0.4 && (
              <div className="notice" style={{ marginTop: 10 }}>
                <AlertCircle size={15} />
                <span>Похожесть на прошлый пост: {Math.round(p.similarityScore * 100)}% — стоит разнообразить подачу.</span>
              </div>
            )}
          </section>

          <section className="surface" style={{ padding: 19, marginTop: 15 }}>
            <div className="section-head">
              <div>
                <h2>Изображение</h2>
                <p>Заменить картинку можно своим файлом; генератор без identity-lock не обещает сходства персонажей</p>
              </div>
            </div>
            {img ? (
              <img src={img} alt="" style={{ width: "100%", maxHeight: 360, objectFit: "cover", borderRadius: 10, marginTop: 12 }} />
            ) : (
              <p style={{ color: "var(--muted)", fontSize: 11, marginTop: 12 }}>Изображения нет.</p>
            )}
            <label className="upload-label" style={{ marginTop: 12 }}>
              <Upload size={15} />
              <span>Загрузить своё изображение (JPG/PNG)</span>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </label>
          </section>
        </div>

        <div className="editor-side">
          <div className="preview-wrap">
            <div className="preview-top">
              <div>
                <b>Предпросмотр стены</b>
                <span>Так публикация будет выглядеть во ВКонтакте</span>
              </div>
            </div>
            <div className="vk-post">
              <div className="vk-head">
                <CommunityAvatar id={p.communityId} />
                <div>
                  <b>{meta?.name ?? p.communityId}</b>
                  <span>{formatMoscow(p.scheduledAt)}</span>
                </div>
              </div>
              {p.title && <p style={{ fontWeight: 600 }}>{p.title}</p>}
              <p>{p.text || "Текст ещё не сгенерирован."}</p>
              {img && <img className="vk-image" src={img} alt="" />}
              <div className="vk-reactions">
                <span>·</span>
                <Eye size={16} />
              </div>
            </div>
            <div className="preview-status">
              <Badge tone={STATUS_TONE[p.status] ?? "neutral"}>{STATUS_LABEL[p.status] ?? p.status}</Badge>
              <span>
                <Clock3 size={14} /> {formatMoscow(p.scheduledAt)}
              </span>
            </div>
          </div>

          <section className="surface">
            <div className="section-head">
              <div>
                <h2>История версий</h2>
                <p>Каждая правка — новая версия с хэшем содержимого</p>
              </div>
              <History size={16} style={{ color: "var(--muted)" }} />
            </div>
            <ul className="kv-list">
              {(pack.versions ?? []).map((v) => (
                <li key={v.id}>
                  <b>v{v.version}</b> · {v.reason || "изменение"} · {formatMoscow(v.createdAt)}
                </li>
              ))}
              {(!pack.versions || pack.versions.length === 0) && <li>Первая версия</li>}
            </ul>
          </section>

          <section className="surface">
            <div className="section-head">
              <div>
                <h2>Согласования</h2>
                <p>Кто и когда принимал решение</p>
              </div>
              <FileText size={16} style={{ color: "var(--muted)" }} />
            </div>
            <ul className="kv-list">
              {(pack.approvals ?? []).map((a) => (
                <li key={a.id}>
                  <b>{a.action}</b> · {a.comment || "без комментария"} · {formatMoscow(a.createdAt)}
                </li>
              ))}
              {(!pack.approvals || pack.approvals.length === 0) && <li>Решений пока не было</li>}
            </ul>
            {pack.community && (
              <p style={{ marginTop: 12, fontSize: 10, color: "var(--muted)" }}>
                <Link className="text-btn" to={`/communities/${p.communityId}`} style={{ display: "inline" }}>
                  Правила сообщества «{pack.community.shortName}»
                </Link>
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
