#!/usr/bin/env node
/**
 * One-time Supabase owner setup. This script is CLI-only: the setup secret is
 * never imported by the browser bundle or sent by the React frontend.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const API_PATH = "/functions/v1/vk-ai-api/bootstrap/owner";

async function promptLine(question, fallback = "") {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await readline.question(question);
    return answer.trim() || fallback;
  } finally {
    readline.close();
  }
}

async function promptHidden(question) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error(`Нет интерактивного терминала. Передайте значение через переменную окружения (не через аргументы командной строки).`);
  }
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return await new Promise((resolve, reject) => {
    let value = "";
    const finish = (error = null) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") return finish(new Error("Прервано пользователем"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL?.trim() ?? "";
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim() ?? "";
  if (!supabaseUrl || !anonKey) {
    throw new Error("Задайте SUPABASE_URL и SUPABASE_ANON_KEY в окружении оператора.");
  }

  let projectUrl;
  try {
    projectUrl = new URL(supabaseUrl);
  } catch {
    throw new Error("SUPABASE_URL должен быть корректным URL.");
  }
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(projectUrl.hostname);
  if ((projectUrl.protocol !== "https:" && !(localHost && projectUrl.protocol === "http:")) || projectUrl.username || projectUrl.password || projectUrl.search || projectUrl.hash) {
    throw new Error("SUPABASE_URL должен быть HTTPS (HTTP разрешён только для локальной разработки) и не содержать credentials/query.");
  }

  const ownerEmail = (process.env.OWNER_EMAIL?.trim() || await promptLine("Email первого владельца: ")).toLowerCase();
  const ownerName = process.env.OWNER_NAME?.trim() || await promptLine("Имя владельца [Владелец]: ", "Владелец");
  let setupSecret = process.env.OWNER_SETUP_SECRET ?? "";
  if (!setupSecret) setupSecret = await promptHidden("Одноразовый OWNER_SETUP_SECRET: ");
  let ownerPassword = process.env.OWNER_PASSWORD ?? "";
  if (!ownerPassword) ownerPassword = await promptHidden("Пароль владельца (не короче 10 символов): ");

  if (!ownerEmail.includes("@") || ownerEmail.length > 200) throw new Error("Укажите корректный email владельца.");
  if (setupSecret.length < 32 || setupSecret.length > 256) throw new Error("OWNER_SETUP_SECRET должен быть длиной 32–256 символов.");
  if (ownerPassword.length < 10 || ownerPassword.length > 200) throw new Error("Пароль должен содержать от 10 до 200 символов.");

  const endpoint = `${projectUrl.toString().replace(/\/$/, "")}${API_PATH}`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
        "x-owner-setup-secret": setupSecret,
      },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword, name: ownerName }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Ответ сервера не получен. Исход операции неизвестен: проверьте Supabase Auth и setup-state; не запускайте повторно вслепую.");
  } finally {
    setupSecret = "";
    ownerPassword = "";
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Do not print an untrusted raw response body.
  }
  if (!response.ok) {
    const detail = typeof payload?.error === "string" ? payload.error : "Сервер отклонил настройку.";
    throw new Error(`${detail} HTTP ${response.status}; перед повтором проверьте Auth и bootstrap state.`);
  }

  stdout.write("Первичный владелец создан. Теперь войдите через обычную форму Supabase Auth.\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Настройка завершилась ошибкой.");
  process.exitCode = 1;
});
