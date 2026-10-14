// Keep the initial HTML visible if loading/evaluating the React bundle fails.
// Do not dump errors/credentials into the UI or clear the user's stored data.
void import("./main").catch(() => {
  const root = document.getElementById("root");
  if (!root) return;
  const message = document.createElement("div");
  message.className = "startup-error";
  message.setAttribute("role", "alert");
  message.style.cssText = "min-height:100vh;display:grid;place-content:center;gap:16px;padding:24px;background:#09090b;color:#eee;font-family:system-ui;text-align:center";
  const title = document.createElement("h1");
  title.textContent = "Не удалось запустить VKBablo";
  const hint = document.createElement("p");
  hint.textContent = "Проверьте соединение и обновите страницу. Если ошибка повторяется, проверьте загрузку JS/CSS и настройки GitHub Pages.";
  const retry = document.createElement("button");
  retry.textContent = "Обновить страницу";
  retry.onclick = () => location.reload();
  message.append(title, hint, retry);
  root.replaceChildren(message);
});
