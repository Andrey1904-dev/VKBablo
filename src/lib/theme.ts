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
  try {
    localStorage.setItem("vkai-theme", light ? "light" : "dark");
  } catch {
    /* приватный режим — просто без сохранения */
  }
}

export function initTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("vkai-theme");
  } catch {
    /* ignore */
  }
  // Макет DesignVK по умолчанию тёмный; сохранённый выбор владельца приоритетнее.
  setTheme(saved === "light");
}
