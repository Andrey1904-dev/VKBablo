/**
 * Глобальные тосты и открытие окна «Создать публикацию» (как в макете DesignVK).
 * Мини-стор на useSyncExternalStore: без провайдеров, работает из любой страницы.
 */
import { useSyncExternalStore } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

export type ToastKind = "ok" | "error";

interface ToastItem {
  id: number;
  text: string;
  kind: ToastKind;
}

let toasts: ToastItem[] = [];
const toastListeners = new Set<() => void>();
let modalOpen = false;
const modalListeners = new Set<() => void>();

function emitToasts() {
  for (const l of toastListeners) l();
}
function emitModal() {
  for (const l of modalListeners) l();
}

/** Показать тост. Ошибка — красная вариация того же тоста из макета. */
export function toast(text: string, kind: ToastKind = "ok") {
  const id = Date.now() + Math.random();
  toasts = [...toasts, { id, text, kind }];
  emitToasts();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emitToasts();
  }, 4200);
}

/** Открыть модальное окно «Создать публикацию» (живёт в AppShell). */
export function openCreateModal() {
  modalOpen = true;
  emitModal();
}

export function closeCreateModal() {
  modalOpen = false;
  emitModal();
}

function subscribeToasts(cb: () => void) {
  toastListeners.add(cb);
  return () => toastListeners.delete(cb);
}
function subscribeModal(cb: () => void) {
  modalListeners.add(cb);
  return () => modalListeners.delete(cb);
}

export function Toaster() {
  const items = useSyncExternalStore(subscribeToasts, () => toasts);
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
          {t.kind === "error" ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{t.text}</span>
          <button
            onClick={() => {
              toasts = toasts.filter((x) => x.id !== t.id);
              emitToasts();
            }}
            aria-label="Закрыть"
          >
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function useCreateModalOpen(): boolean {
  return useSyncExternalStore(subscribeModal, () => modalOpen);
}
