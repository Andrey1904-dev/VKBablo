import { readPreference, writePreference } from "./storage";

/**
 * Тема оформления дизайн-системы DesignVK.
 * Тёмная — тема по умолчанию (как в макете), светлая включается классом `.light`.
 * Выбор сохраняется в localStorage под ключом vkai-theme (совместимо с прежним кодом).
 */
export function isLightTheme(): boolean {
  return document.documentElement.classList.contains("light");
}

export function setTheme(light: boolean): void {
  document.documentElement.classList.toggle("light", light);
  document.documentElement.classList.toggle("dark", !light);
  writePreference("vkai-theme", light ? "light" : "dark");
}

export function initTheme(): void {
  const saved = readPreference("vkai-theme");
  // Макет DesignVK по умолчанию тёмный; сохранённый выбор владельца приоритетнее.
  setTheme(saved === "light");
}
