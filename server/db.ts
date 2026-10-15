import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "./lib.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

export const DATA_DIR = process.env.DATA_DIR || join(ROOT, "data");
export const UPLOAD_DIR = join(DATA_DIR, "uploads");
export const DB_PATH = process.env.DB_PATH || join(DATA_DIR, "vkai.sqlite");

mkdirSync(UPLOAD_DIR, { recursive: true });

let db: DatabaseSync;

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    migrate(db);
  }
  return db;
}

export function openMemoryDb(): DatabaseSync {
  const memory = new DatabaseSync(":memory:");
  memory.exec("PRAGMA foreign_keys = ON;");
  migrate(memory);
  db = memory;
  return memory;
}

function migrate(database: DatabaseSync) {
  for (const id of ["0001_init", "0002_jobs_stats", "0003_safety_reliability"]) {
    const sqlPath = join(ROOT, "migrations", `${id}.sql`);
    if (!existsSync(sqlPath)) continue;

    const migrationsTableExists = Boolean(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get(),
    );
    if (migrationsTableExists && database.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(id)) continue;

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(readFileSync(sqlPath, "utf8"));
      database.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(id, nowIso());
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the migration error if SQLite already rolled back.
      }
      throw error;
    }
  }
}

/** Run a synchronous SQLite transaction that serializes writers across processes. */
export function withImmediateTransaction<T>(operation: () => T): T {
  const database = getDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

// node:sqlite принимает только скалярные значения; параметры приходят из JSON
// и уже проверены на уровне API, поэтому здесь достаточно приведения.
export function all<T>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...(params as never[])) as T[];
}

export function get<T>(sql: string, ...params: unknown[]): T | undefined {
  return getDb().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]) {
  return getDb().prepare(sql).run(...(params as never[]));
}

export function setting(key: string, fallback = ""): string {
  const row = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string) {
  run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key,
    value,
    nowIso(),
  );
}

export type Row = Record<string, unknown>;
