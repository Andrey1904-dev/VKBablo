/** Preferences are optional: Safari/private mode may deny even reading localStorage. */
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Keep the React state; a full/disabled store must not unmount the interface.
  }
}
