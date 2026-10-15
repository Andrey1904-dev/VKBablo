/**
 * UI-кит дизайн-системы DesignVK: кнопки, бейджи, аватары, заголовки страниц,
 * карточки статистики, поля ввода. Классы (.btn, .badge, .stat, .field…) определены
 * в src/index.css и перенесены из макета без изменения визуала.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/* ---------- Кнопка ---------- */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  className,
  variant = "primary",
  size = "md",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "sm" | "md" }) {
  return (
    <button
      className={cn("btn", `btn-${variant}`, size === "sm" && "sm", className)}
      {...props}
    />
  );
}

/* ---------- Бейдж со «светодиодом» (как в макете) ---------- */
export type BadgeTone = "neutral" | "success" | "warning" | "purple" | "danger" | "sky";

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span className={cn("badge", `badge-${tone}`, className)}>
      <i />
      {children}
    </span>
  );
}

/* ---------- Аватар сообщества ---------- */
export function Avatar({
  color,
  short,
  img,
  size = "md",
  title,
}: {
  color: string;
  short?: string;
  img?: string | null;
  size?: "sm" | "md" | "lg";
  title?: string;
}) {
  const letters = (short || title || "?").slice(0, 2).toUpperCase();
  return (
    <span className={`avatar avatar-${size}`} style={{ background: color }} title={title}>
      {letters}
      {img && (
        <img
          src={img}
          alt=""
          onError={(e) => {
            // Если файл недоступен — показываем буквы на цветном фоне
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      )}
    </span>
  );
}

/* ---------- Заголовок страницы ---------- */
export function PageHead({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </header>
  );
}

/* ---------- Карточка статистики ---------- */
export function Stat({
  icon: Icon,
  label,
  value,
  help,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  help: string;
  accent?: boolean;
}) {
  return (
    <div className={`stat ${accent ? "accent" : ""}`}>
      <div>
        <span>{label}</span>
        <Icon size={17} />
      </div>
      <strong>{value}</strong>
      <p>{help}</p>
    </div>
  );
}

/* ---------- Поля ввода ---------- */
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("input", className)} {...props} />;
}

export function Textarea({ className, style, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn("textarea", className)}
      style={{ minHeight: 92, padding: "11px", display: "block", ...style }}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("select-btn", className)} {...props} />;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

/* ---------- Переключатель (тумблер из макета) ---------- */
export function Toggle({ on, onChange, title, disabled = false }: { on: boolean; onChange: (v: boolean) => void; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={`toggle ${on ? "on" : ""}`}
      onClick={() => onChange(!on)}
      aria-pressed={on}
      title={title}
      aria-label={title}
      disabled={disabled}
    >
      <i />
    </button>
  );
}

/* ---------- Пустое состояние ---------- */
export function Empty({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon size={28} />
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}
