import { Component, type ReactNode } from "react";

/** A failed render must show a recovery screen, not leave an empty React root. */
export class StartupBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="startup-error" role="alert" style={{ minHeight: "100vh", display: "grid", placeContent: "center", padding: 24, gap: 16, background: "#09090b", color: "#eee", textAlign: "center" }}>
        <h1>Не удалось открыть VKBablo</h1>
        <p>Обновите страницу. Если ошибка повторяется, сообщите об этом владельцу приложения.</p>
        <button type="button" onClick={() => location.reload()}>Обновить страницу</button>
      </div>
    );
  }
}
