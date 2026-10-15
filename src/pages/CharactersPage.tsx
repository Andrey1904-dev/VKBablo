import { useEffect, useState } from "react";
import { getBackend } from "@/data";
import { COMMUNITY_META } from "@shared/constants";
import { Badge, Button, PageHead } from "@/components/ui";
import { toast } from "@/components/toast";
import type { Character } from "@shared/types";
import { ChevronDown, Image as ImageIcon, Lock, ShieldAlert, Upload } from "lucide-react";

function CharacterCard({
  ch,
  onUpload,
  onApproveReference,
  onSelectReference,
}: {
  ch: Character;
  onUpload: (id: string, f: File) => void;
  onApproveReference: (referenceId: string) => void;
  onSelectReference: (referenceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const meta = COMMUNITY_META[ch.communityId];
  const refs = ch.references ?? [];

  return (
    <article className="character">
      <div className="character-img">
        {/* Внешность не выдумываем: пока нет утверждённых фото — честная заглушка. */}
        <div className="char-placeholder">
          <b style={{ background: meta?.color ?? "#8b5cf6" }}>{ch.name.slice(0, 1)}</b>
          <small>{ch.appearanceStatus === "placeholder" ? "Референсы не загружены" : "Внешность задана референсами"}</small>
        </div>
        <span className="icon-btn" style={{ background: "#101014b5" }} title={ch.locked ? "Внешность заблокирована" : "Можно менять"}>
          {ch.locked ? <Lock size={15} /> : <ImageIcon size={15} />}
        </span>
      </div>
      <div>
        <span className="character-community">{meta?.name ?? ch.communityId}</span>
        <h2>{ch.name}</h2>
        <p>{ch.description}</p>
        <div className="char-footer">
          <span>
            <ImageIcon size={15} />
            {refs.length} референсов
          </span>
          <Button variant="secondary" onClick={() => setOpen(!open)}>
            {open ? "Свернуть" : "Открыть"} <ChevronDown size={15} style={{ transform: open ? "rotate(180deg)" : "none", transition: ".2s" }} />
          </Button>
        </div>
      </div>
      {open && (
        <div className="char-details">
          <div className="kv">
            <b>Роль</b>
            {ch.role}
          </div>
          <div className="kv">
            <b>Характер</b>
            {ch.personality}
          </div>
          <div className="kv">
            <b>Нельзя менять</b>
            {(ch.appearance?.neverChange ?? []).join("; ") || "—"}
          </div>
          <div className="kv">
            <b>Особые приметы</b>
            {(ch.appearance?.distinctive ?? []).join(" · ") || "Ожидают утверждённых референсов владельца"}
          </div>
          <div>
            <div className="char-refs">
              {refs.map((r) => (
                <div className="char-reference" key={r.id}>
                  <img src={r.url || r.filePath} alt={`Референс: ${ch.name}`} />
                  <div className="char-reference-actions">
                    <Badge tone={r.approved ? "success" : "warning"}>{r.approved ? "Одобрен" : "На проверке"}</Badge>
                    {r.isPrimary && <Badge tone="purple">Основной</Badge>}
                    {!r.approved ? (
                      <Button variant="secondary" onClick={() => onApproveReference(r.id)}>Одобрить</Button>
                    ) : !r.isPrimary ? (
                      <Button variant="secondary" onClick={() => onSelectReference(r.id)}>Сделать основным</Button>
                    ) : null}
                  </div>
                </div>
              ))}
              {refs.length === 0 && <span className="empty-refs">Утверждённых референсов пока нет</span>}
            </div>
          </div>
          <label className="upload-label">
            <Upload size={15} />
            <span>Загрузить референс для одобрения владельцем</span>
            <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && onUpload(ch.id, e.target.files[0])} />
          </label>
          {ch.appearanceStatus === "placeholder" && (
            <div className="notice accent">
              <ShieldAlert size={15} />
              <span>
                Генератор без identity-lock не обещает точное сходство с человеком. Загрузите эталонные фото владельца,
                прежде чем рассчитывать на стабильную внешность.
              </span>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

export default function CharactersPage() {
  const [items, setItems] = useState<Character[]>([]);

  async function load() {
    setItems(await getBackend().characters());
  }
  useEffect(() => {
    load();
  }, []);

  async function upload(id: string, file: File) {
    try {
      await getBackend().uploadReference(id, file, "");
      toast("Референс загружен и сохранён как ожидающий одобрения.");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    }
  }

  async function referenceAction(referenceId: string, action: "approve" | "primary") {
    try {
      if (action === "approve") await getBackend().approveReference(referenceId);
      else await getBackend().setPrimaryReference(referenceId);
      toast(action === "approve" ? "Референс одобрен владельцем." : "Основной референс изменён.");
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Ошибка", "error");
    }
  }

  return (
    <div className="page enter">
      <PageHead
        title="Персонажи"
        description="Визуальные образы и правила для стабильной AI-генерации."
        actions={<Badge tone={items.some((c) => c.locked) ? "purple" : "neutral"}>Внешность заблокирована</Badge>}
      />
      <div className="character-grid">
        {items.map((ch) => (
          <CharacterCard
            key={ch.id}
            ch={ch}
            onUpload={upload}
            onApproveReference={(referenceId) => void referenceAction(referenceId, "approve")}
            onSelectReference={(referenceId) => void referenceAction(referenceId, "primary")}
          />
        ))}
        <div className="add-character">
          <Upload size={25} />
          <b>Эталонные изображения</b>
          <span>
            Персонажи и их правила согласованы владельцем и не создаются из интерфейса. Загружайте утверждённые
            референсы в карточке персонажа — они хранятся в приватном хранилище.
          </span>
        </div>
      </div>
    </div>
  );
}
