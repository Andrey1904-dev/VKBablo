#!/usr/bin/env node
/**
 * Disposable-DB integration test: two independent PostgreSQL sessions contend
 * for 1.5 request-estimates of remaining budget. No AI/VK HTTP request is made.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Задайте DATABASE_URL для отдельной локальной/тестовой PostgreSQL БД.");
if (process.env.VKBABLO_DISPOSABLE_DB_CONFIRM !== "I_UNDERSTAND") {
  throw new Error("Тест временно меняет app_mode/лимит. Только отдельная disposable БД и VKBABLO_DISPOSABLE_DB_CONFIRM=I_UNDERSTAND.");
}

function psql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["--no-psqlrc", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--dbname", databaseUrl], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(sql);
  });
}

function quote(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function requireOk(result, action) {
  if (result.code !== 0) throw new Error(`${action} завершилось с ошибкой PostgreSQL; подробности не выводятся, чтобы не раскрывать строку подключения.`);
  return result.stdout;
}

const id1 = randomUUID();
const id2 = randomUUID();
let original;
let changedSettings = false;
let accepted = [];
try {
  const stateSql = `select json_build_object(
    'mode', coalesce((select value from public.application_settings where key='app_mode'), 'test'),
    'paid', coalesce((select value from public.application_settings where key='ai_paid_calls_enabled'), 'false'),
    'limit', coalesce(nullif((select value from public.application_settings where key='ai_monthly_limit_usd'), '')::numeric, 20),
    'spend', public.month_spend_usd(),
    'reserved', coalesce((select reserved_usd from app.ai_budget_periods where month_start=date_trunc('month', timezone('UTC', now()))::date), 0)
  )::text;`;
  original = JSON.parse(requireOk(await psql(stateSql), "Чтение AI budget state"));

  const estimate = 0.1;
  const temporaryLimit = Number(original.spend) + Number(original.reserved) + estimate * 1.5;
  if (!Number.isFinite(temporaryLimit) || temporaryLimit <= 0) throw new Error("Невозможно вычислить тестовый лимит.");

  requireOk(await psql(`
    begin;
    update public.application_settings set value='approval' where key='app_mode';
    update public.application_settings set value='true' where key='ai_paid_calls_enabled';
    update public.application_settings set value=${quote(temporaryLimit.toFixed(6))} where key='ai_monthly_limit_usd';
    commit;
  `), "Подготовка disposable budget fixture");
  changedSettings = true;

  const reserve = (id) => psql(`select public.reserve_ai_budget('${id}'::uuid, ${estimate}::numeric);`);
  const results = await Promise.all([reserve(id1), reserve(id2)]);
  accepted = results.map((result, index) => result.code === 0 ? (index === 0 ? id1 : id2) : null).filter(Boolean);
  const rejectedCount = results.filter((result) => result.code !== 0 && /Недостаточно свободного AI-бюджета/i.test(`${result.stdout}\n${result.stderr}`)).length;

  if (accepted.length !== 1 || rejectedCount !== 1) {
    throw new Error(`Ожидался ровно один успешный резерв и один отказ; успешно=${accepted.length}, отказ по лимиту=${rejectedCount}.`);
  }
  console.log("PASS: два независимых PostgreSQL-сеанса не зарезервировали бюджет сверх лимита.");
} finally {
  // No provider call was made, so test-created active reservations are safe to release.
  const cleanupIds = [id1, id2];
  for (const id of cleanupIds) {
    await psql(`select public.release_ai_budget('${id}'::uuid, 'disposable concurrency test cleanup');`).catch(() => undefined);
  }
  if (changedSettings && original) {
    const restore = await psql(`
      begin;
      update public.application_settings set value=${quote(original.mode)} where key='app_mode';
      update public.application_settings set value=${quote(original.paid)} where key='ai_paid_calls_enabled';
      update public.application_settings set value=${quote(original.limit)} where key='ai_monthly_limit_usd';
      commit;
    `);
    if (restore.code !== 0) {
      console.error("CRITICAL: не удалось восстановить три настройки в disposable БД. Проверьте только эти keys: app_mode, ai_paid_calls_enabled, ai_monthly_limit_usd.");
      process.exitCode = 2;
    }
  }
}
