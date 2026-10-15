import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { get, getDb, run, setSetting } from "./db.ts";
import { deriveSessionToken, hashPassword, HttpError, nowIso, sha256, verifyPassword } from "./lib.ts";

const COOKIE = "vkaim_sid";
const DAYS = 14;

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: string;
}

export function userCount(): number {
  return get<{ c: number }>("SELECT COUNT(*) AS c FROM users")?.c ?? 0;
}

export function createUser(email: string, password: string, name: string): AuthUser {
  if (password.length < 10) throw new HttpError(400, "Пароль не короче 10 символов");
  const normalizedEmail = email.trim().toLowerCase();
  const hash = hashPassword(password);
  run(
    "INSERT INTO users (email, password_hash, name, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
    normalizedEmail,
    hash,
    name.trim(),
    nowIso(),
  );
  const u = get<AuthUser>("SELECT id, email, name, role FROM users WHERE email = ?", normalizedEmail);
  if (!u) throw new HttpError(500, "Не удалось создать пользователя");
  return u;
}

/** Atomically consume the only local bootstrap slot; concurrent setup requests cannot create two owners. */
export function createFirstOwner(email: string, password: string, name: string): AuthUser {
  const database = getDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    if (userCount() !== 0 || get<{ value: string }>("SELECT value FROM settings WHERE key = 'setup_complete'")?.value === "1") {
      throw new HttpError(400, "Владелец уже создан");
    }
    const owner = createUser(email, password, name);
    setSetting("setup_complete", "1");
    database.exec("COMMIT");
    return owner;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

export function login(email: string, password: string, c: Context): AuthUser {
  const row = get<{ id: number; email: string; name: string; role: string; password_hash: string }>(
    "SELECT id, email, name, role, password_hash FROM users WHERE email = ?",
    email.trim().toLowerCase(),
  );
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw new HttpError(401, "Неверный email или пароль");
  }
  const { id, hash } = deriveSessionToken();
  const exp = new Date(Date.now() + DAYS * 86400 * 1000).toISOString();
  run(
    "INSERT INTO sessions (id, user_id, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
    hash,
    row.id,
    exp,
    nowIso(),
    c.req.header("x-forwarded-for") || "",
    (c.req.header("user-agent") || "").slice(0, 200),
  );
  run("UPDATE users SET last_login_at = ? WHERE id = ?", nowIso(), row.id);
  setCookie(c, COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: DAYS * 86400,
    secure: false,
  });
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export function logout(c: Context) {
  const raw = getCookie(c, COOKIE);
  if (raw) run("DELETE FROM sessions WHERE id = ?", sha256(raw));
  deleteCookie(c, COOKIE, { path: "/" });
}

export function currentUser(c: Context): AuthUser | null {
  const raw = getCookie(c, COOKIE);
  if (!raw) return null;
  const row = get<AuthUser & { expires_at: string }>(
    `SELECT u.id, u.email, u.name, u.role, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ?`,
    sha256(raw),
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run("DELETE FROM sessions WHERE id = ?", sha256(raw));
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export async function requireUser(c: Context, next: Next) {
  const u = currentUser(c);
  if (!u) throw new HttpError(401, "Нужна авторизация");
  c.set("user", u);
  await next();
}

const loginHits = new Map<string, { n: number; t: number }>();

export function rateLimitLogin(ip: string) {
  const now = Date.now();
  const rec = loginHits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 10 * 60 * 1000) {
    rec.n = 0;
    rec.t = now;
  }
  rec.n++;
  loginHits.set(ip, rec);
  if (rec.n > 12) throw new HttpError(429, "Слишком много попыток входа. Подождите 10 минут.");
}
