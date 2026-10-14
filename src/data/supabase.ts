/**
 * PRODUCTION backend — Supabase (PostgreSQL + Auth + Storage + Edge Functions).
 *
 * Правила слоя:
 *   • Чтение — напрямую PostgREST под RLS (доступ проверяет база, а не браузер).
 *   • Изменения — только через Edge Function vk-ai-api и RPC: инварианты
 *     (одобрение, сброс одобрения при правке, очередь генерации, предохранители
 *     реальной публикации) живут на сервере.
 *   • Секреты (VK-токены, AI-ключи) в браузер не попадают никогда: их записывает
 *     только сервер в зашифрованном виде.
 *   • Картинки приватного bucket `media` отдаются только через подписанные ссылки.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  COMMUNITY_IDS,
  type AiGenerationRecord,
  type AiProvidersPayload,
  type AnalyticsPayload,
  type AnalyticsPoint,
  type ApplicationSettings,
  type Approval,
  type AuditEntry,
  type AuthStatus,
  type BackendInfo,
  type CalendarPayload,
  type Character,
  type CharacterReference,
  type Community,
  type CommunityId,
  type CommunityRuleSet,
  type DashboardData,
  type GenerationSettings,
  type IntegrationStatus,
  type Job,
  type JobStatus,
  type NotificationItem,
  type Post,
  type PostDetailPayload,
  type PostFilters,
  type PostStatus,
  type PostVersion,
  type Schedule,
  type StyleRules,
  type UploadResult,
  type UserPublic,
} from "@shared/types";
import type { Idea } from "@shared/content-engine";
import { addDays, moscowParts, moscowSlotIso, normalizeSlots } from "@shared/moscow";
import { ApiError } from "@/lib/api";
import { CONFIG } from "@/lib/config";
import type { Backend, CommunityDetail, GenerateSlotInput, VkConnectResult } from "./types";
import { backendInfoFor } from "./types";

type Row = Record<string, unknown>;

const BUCKET = "media";
const SIGNED_TTL = 3600;
const SIGNED_CACHE_MS = 50 * 60 * 1000;
const COVERED_STATUSES: PostStatus[] = [
  "draft",
  "generating",
  "review",
  "needs_revision",
  "approved",
  "scheduled",
  "published",
];

// ---------------------------------------------------------------------------
// Приведение типов из БД (snake_case) в модель приложения (camelCase)
// ---------------------------------------------------------------------------

function str(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return typeof value === "string" ? value : String(value);
}

function strOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : String(value);
}

function toIso(value: unknown, fallback: string | null = null): string | null {
  if (value === null || value === undefined || value === "") return fallback;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function isoOrNull(value: unknown): string | null {
  return toIso(value, null);
}

function isoRequired(value: unknown): string {
  return toIso(value, new Date().toISOString()) as string;
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "t" || value === 1) return true;
  if (value === "false" || value === "f" || value === 0) return false;
  return fallback;
}

function strArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => str(item)).filter((item) => item !== "");
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}

function communityIdOf(value: unknown): CommunityId {
  const id = str(value) as CommunityId;
  return COMMUNITY_IDS.includes(id) ? id : "stories";
}

/** Понятные русские сообщения вместо технических текстов PostgREST/Postgres. */
function dbError(error: { message?: string; code?: string } | null): ApiError {
  const code = error?.code ?? "";
  if (code === "PGRST301" || code === "PGRST302") {
    return new ApiError(401, "Сессия истекла. Войдите заново.");
  }
  if (code === "42501" || /permission denied|row-level security/i.test(error?.message ?? "")) {
    return new ApiError(403, "Недостаточно прав для этого действия.");
  }
  if (code === "23505" || /duplicate key/i.test(error?.message ?? "")) {
    return new ApiError(409, "Такая запись уже существует (защита от дублей).");
  }
  return new ApiError(500, `Ошибка базы данных: ${error?.message ?? "неизвестная"}`);
}

async function functionsError(error: unknown): Promise<ApiError> {
  const candidate = error as { message?: string; context?: unknown };
  const context = candidate.context;
  if (context && typeof (context as Response).json === "function") {
    const response = context as Response;
    try {
      const payload = (await response.json()) as { error?: string; code?: string };
      if (payload?.error) return new ApiError(response.status || 500, payload.error);
    } catch {
      /* тело недоступно — уходим в общее сообщение */
    }
  }
  return new ApiError(500, candidate.message ?? "Серверная функция недоступна");
}

// ---------------------------------------------------------------------------

export class SupabaseBackend implements Backend {
  readonly info: BackendInfo;
  private client: SupabaseClient;
  private signed = new Map<string, { url: string; expiresAt: number }>();
  private ready: Promise<void>;

  constructor() {
    if (!CONFIG.supabaseUrl || !CONFIG.supabaseAnonKey) {
      throw new ApiError(500, "Supabase не настроен: нет VITE_SUPABASE_URL или VITE_SUPABASE_ANON_KEY");
    }

    this.client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: "vkai-supabase-auth",
      },
    });

    this.info = backendInfoFor("supabase", CONFIG.supabaseUrl, true, CONFIG.functionsUrl);

    // Профиль создаётся триггером при регистрации; для уже существующих сессий
    // просто убеждаемся, что сессия восстановлена.
    this.ready = this.client.auth
      .getSession()
      .then(() => undefined)
      .catch(() => undefined);
  }

  // -- инфраструктура -------------------------------------------------------

  private async invoke<T>(route: string, body?: Row | FormData): Promise<T> {
    await this.ready;
    const { data, error } = await this.client.functions.invoke(`vk-ai-api/${route}`, {
      body: body as never,
    });
    if (error) throw await functionsError(error);
    return data as T;
  }

  private async rpc<T>(fn: string, args?: Row): Promise<T> {
    await this.ready;
    const { data, error } = await this.client.rpc(fn, args as never);
    if (error) throw dbError(error);
    return data as T;
  }

  // PostgREST-запрос с человекочитаемым приведением ошибок. Типы строк приходят
  // из БД без генерации схемы, поэтому здесь используется структурный Row.
  private async select(table: string, build?: (query: any) => any): Promise<Row[]> {
    await this.ready;
    const base = this.client.from(table).select("*");
    const query = build ? build(base) : base;
    const { data, error } = await query;
    if (error) throw dbError(error);
    return (data ?? []) as Row[];
  }

  /** Приватные картинки доступны только по подписанным ссылкам (ТЗ §13). */
  private async signOne(path: string | null): Promise<string | null> {
    if (!path) return null;
    if (/^(https?:|data:|blob:|\/)/.test(path)) return path;
    const cached = this.signed.get(path);
    if (cached && cached.expiresAt > Date.now()) return cached.url;

    const { data, error } = await this.client.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL);
    if (error || !data?.signedUrl) return null;
    this.signed.set(path, { url: data.signedUrl, expiresAt: Date.now() + SIGNED_CACHE_MS });
    return data.signedUrl;
  }

  private async signMany(paths: Array<string | null>): Promise<Map<string, string>> {
    const unique = Array.from(
      new Set(
        paths
          .filter((path): path is string => Boolean(path))
          .filter((path) => !/^(https?:|data:|blob:|\/)/.test(path))
          .filter((path) => {
            const cached = this.signed.get(path);
            return !cached || cached.expiresAt <= Date.now();
          }),
      ),
    );

    for (let i = 0; i < unique.length; i += 100) {
      const batch = unique.slice(i, i + 100);
      const { data, error } = await this.client.storage.from(BUCKET).createSignedUrls(batch, SIGNED_TTL);
      if (error || !data) continue;
      for (const item of data) {
        if (item.signedUrl && item.path) {
          this.signed.set(item.path, { url: item.signedUrl, expiresAt: Date.now() + SIGNED_CACHE_MS });
        }
      }
    }

    const out = new Map<string, string>();
    for (const path of paths) {
      if (!path) continue;
      if (/^(https?:|data:|blob:|\/)/.test(path)) {
        out.set(path, path);
        continue;
      }
      const cached = this.signed.get(path);
      if (cached) out.set(path, cached.url);
    }
    return out;
  }

  // -- отображение строк ----------------------------------------------------

  private mapPost(row: Row): Post {
    return {
      id: str(row.id),
      communityId: communityIdOf(row.community_id),
      status: (str(row.status, "draft") as PostStatus) ?? "draft",
      scheduledAt: isoRequired(row.scheduled_at),
      publishedAt: isoOrNull(row.published_at),
      title: str(row.title),
      text: str(row.text),
      imagePath: strOrNull(row.image_path),
      imageUrl: null,
      imagePrompt: str(row.image_prompt),
      topic: str(row.topic),
      idea: str(row.idea),
      vkPostId: strOrNull(row.vk_post_id),
      contentHash: str(row.content_hash),
      approvedHash: strOrNull(row.approved_hash),
      approvedAt: isoOrNull(row.approved_at),
      approvedBy: strOrNull(row.approved_by),
      errorMessage: strOrNull(row.error_message),
      generationMeta: (row.generation_meta ?? null) as Post["generationMeta"],
      similarityScore: numOrNull(row.similarity_score),
      similarTo: strOrNull(row.similar_to),
      testMode: bool(row.test_mode, true),
      version: num(row.version, 1),
      createdAt: isoRequired(row.created_at),
      updatedAt: isoRequired(row.updated_at),
    };
  }

  private async mapPosts(rows: Row[]): Promise<Post[]> {
    const posts = rows.map((row) => this.mapPost(row));
    const urls = await this.signMany(posts.map((post) => post.imagePath));
    return posts.map((post) => ({
      ...post,
      imageUrl: post.imagePath ? urls.get(post.imagePath) ?? null : null,
    }));
  }

  private mapCommunity(row: Row): Community {
    return {
      id: communityIdOf(row.id),
      name: str(row.name),
      shortName: str(row.short_name, str(row.name)),
      tagline: str(row.tagline),
      description: str(row.description),
      theme: str(row.theme),
      color: str(row.color, "#3B7BD6"),
      avatarUrl: str(row.avatar_url),
      vkGroupId: strOrNull(row.vk_group_id),
      vkScreenName: strOrNull(row.vk_screen_name),
      // Реально подключённым считаем только подтверждённый токен (ТЗ §6, §17).
      vkConnected: bool(row.vk_connected) && Boolean(row.vk_verified_at),
      schedule: normalizeSlots(row.schedule),
      styleRules: (row.style_rules ?? {}) as StyleRules,
      generationSettings: (row.generation_settings ?? {}) as GenerationSettings,
      status: str(row.status, "active") === "paused" ? "paused" : "active",
      automationEnabled: bool(row.automation_enabled, true),
      createdAt: isoOrNull(row.created_at) ?? undefined,
      updatedAt: isoOrNull(row.updated_at) ?? undefined,
    };
  }

  private mapReference(row: Row, url: string | null): CharacterReference {
    const path = str(row.storage_path);
    return {
      id: str(row.id),
      characterId: str(row.character_id),
      filePath: path,
      url,
      approved: bool(row.approved),
      isPrimary: bool(row.is_primary),
      notes: str(row.notes),
      createdAt: isoRequired(row.created_at),
    };
  }

  private mapCharacter(row: Row, references: CharacterReference[]): Character {
    return {
      id: str(row.id),
      communityId: communityIdOf(row.community_id),
      name: str(row.name),
      role: str(row.role),
      description: str(row.description),
      appearance: (row.appearance ?? { distinctive: [], neverChange: [] }) as Character["appearance"],
      personality: str(row.personality),
      locked: bool(row.locked, true),
      appearanceStatus: str(row.appearance_status, "placeholder") === "approved" ? "approved" : "placeholder",
      primaryReferenceId: strOrNull(row.primary_reference_id),
      references,
      createdAt: isoRequired(row.created_at),
      updatedAt: isoRequired(row.updated_at),
    };
  }

  private async loadCharacters(where?: (query: unknown) => unknown): Promise<Character[]> {
    const rows = await this.select("characters", (query) => {
      const ordered = query.order("community_id").order("name");
      return where ? where(ordered) : ordered;
    });
    if (rows.length === 0) return [];

    const ids = rows.map((row) => str(row.id));
    const references = await this.select("character_references", (query) =>
      query.in("character_id", ids).order("created_at", { ascending: false }),
    );
    const urls = await this.signMany(references.map((row) => strOrNull(row.storage_path)));

    const byCharacter = new Map<string, CharacterReference[]>();
    for (const row of references) {
      const reference = this.mapReference(row, urls.get(str(row.storage_path)) ?? null);
      const list = byCharacter.get(reference.characterId) ?? [];
      list.push(reference);
      byCharacter.set(reference.characterId, list);
    }

    return rows.map((row) => this.mapCharacter(row, byCharacter.get(str(row.id)) ?? []));
  }

  private async loadRules(communityId: string): Promise<CommunityRuleSet | null> {
    const { data, error } = await this.client.from("community_rules").select("*").eq("community_id", communityId).maybeSingle();
    if (error) throw dbError(error);
    if (!data) return null;
    const row = data as Row;
    return {
      communityId: communityIdOf(row.community_id),
      version: num(row.version, 1),
      theme: str(row.theme),
      textStyle: str(row.text_style),
      audience: str(row.audience),
      forbidden: strArray(row.forbidden),
      preferredTopics: strArray(row.preferred_topics),
      unwantedTopics: strArray(row.unwanted_topics),
      successfulExamples: strArray(row.successful_examples),
      imageRules: str(row.image_rules),
      characterRules: str(row.character_rules),
      analyticsNotes: str(row.analytics_notes),
      sources: strArray(row.sources),
      updatedAt: isoOrNull(row.updated_at) ?? undefined,
      updatedBy: strOrNull(row.updated_by),
    };
  }

  private mapSettings(payload: Row): ApplicationSettings {
    return {
      mode: str(payload.mode, "test") === "approval" ? "approval" : "test",
      automationPaused: bool(payload.automationPaused),
      realPublishEnabled: bool(payload.realPublishEnabled),
      timezone: str(payload.timezone, "Europe/Moscow"),
      prepareHoursAhead: num(payload.prepareHoursAhead, 24),
      aiMonthlyLimitUsd: num(payload.aiMonthlyLimitUsd, 20),
      spendUsdMonth: num(payload.spendUsdMonth, 0),
      aiProvider: str(payload.aiProvider, "test") as ApplicationSettings["aiProvider"],
      aiTextModel: str(payload.aiTextModel, "test-writer-v1"),
      aiImageModel: str(payload.aiImageModel, "test-illustrator-v1"),
      aiBaseUrl: str(payload.aiBaseUrl),
      notificationsEnabled: bool(payload.notificationsEnabled, true),
      demoMode: false,
      updatedAt: isoOrNull(payload.updatedAt) ?? undefined,
    };
  }

  private mapIntegration(row: Row): IntegrationStatus {
    return {
      id: str(row.key),
      key: str(row.key) as IntegrationStatus["key"],
      label: str(row.label, str(row.key)),
      configured: bool(row.configured),
      verified: bool(row.verified),
      status: (str(row.status, "off") as IntegrationStatus["status"]) ?? "off",
      detail: str(row.detail),
      checkedAt: isoOrNull(row.checked_at),
    };
  }

  private mapJob(row: Row, type?: string): Job {
    return {
      id: str(row.id),
      type: type ?? str(row.kind ?? row.type, "job"),
      status: (str(row.status, "queued") as JobStatus) ?? "queued",
      attempts: num(row.attempts),
      maxAttempts: num(row.max_attempts, 3),
      runAt: isoRequired(row.run_at),
      error: strOrNull(row.error ?? row.last_error),
      idempotencyKey: strOrNull(row.idempotency_key),
      createdAt: isoRequired(row.created_at),
    };
  }

  // -- авторизация ----------------------------------------------------------

  private async profile(userId: string, email: string | null): Promise<UserPublic | null> {
    const { data, error } = await this.client.from("profiles").select("*").eq("id", userId).maybeSingle();
    if (error) throw dbError(error);
    if (!data) return null;
    const row = data as Row;
    return {
      id: str(row.id),
      email: str(row.email, email ?? ""),
      name: str(row.name, "Владелец"),
      role: str(row.role, "owner"),
    };
  }

  readonly auth = {
    status: async (): Promise<AuthStatus> => {
      await this.ready;
      let hasOwner = false;
      try {
        const state = await this.invoke<{ hasOwner: boolean }>("setup-state");
        hasOwner = Boolean(state?.hasOwner);
      } catch {
        hasOwner = true; // не смогли узнать — считаем, что владелец есть, и требуем вход
      }

      const { data } = await this.client.auth.getSession();
      const session = data.session;
      const user = session ? await this.profile(session.user.id, session.user.email ?? null) : null;

      return {
        setupComplete: hasOwner,
        user,
        backend: this.info,
        hints: [
          "Первый вход: создайте владельца один раз — после этого регистрация закрыта.",
          "Supabase Auth, RLS и RPC уже включены: браузер не может обойти одобрение публикаций.",
          "Реальные публикации VK и платные модели выключены, пока владелец не включит их отдельно.",
        ],
      };
    },

    signIn: async (email: string, password: string): Promise<UserPublic> => {
      await this.ready;
      const { data, error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) {
        throw new ApiError(401, "Не удалось войти: проверьте email и пароль.");
      }
      const user = await this.profile(data.user.id, data.user.email ?? null);
      if (!user) throw new ApiError(403, "Профиль не найден. Обратитесь к владельцу проекта.");
      if (user.role === "viewer") throw new ApiError(403, "У роли «наблюдатель» нет доступа к управлению.");
      return user;
    },

    createOwner: async (email: string, password: string, name: string): Promise<UserPublic> => {
      await this.ready;
      await this.invoke<{ ok: boolean }>("bootstrap/owner", { email, password, name });
      const { data, error } = await this.client.auth.signInWithPassword({ email, password });
      if (error) {
        throw new ApiError(500, "Владелец создан, но вход не выполнился. Войдите вручную.");
      }
      const user = await this.profile(data.user.id, data.user.email ?? null);
      if (!user) throw new ApiError(500, "Профиль владельца не создался (проверьте триггер app.handle_new_user).");
      return user;
    },

    signOut: async (): Promise<void> => {
      await this.ready;
      await this.client.auth.signOut();
    },

    onChange: (listener: () => void): (() => void) => {
      const { data } = this.client.auth.onAuthStateChange(() => listener());
      return () => data.subscription.unsubscribe();
    },
  };

  // -- дашборд и подключения ------------------------------------------------

  async dashboard(): Promise<DashboardData> {
    const payload = await this.rpc<Row>("dashboard_overview");
    const counts = (payload.counts ?? {}) as Record<string, number>;
    const settings = this.mapSettings((payload.settings ?? {}) as Row);
    const nextPosts = await this.mapPosts((payload.nextPosts ?? []) as Row[]);
    const moscow = moscowParts();

    return {
      ready: num(counts.draft) + num(counts.generating) + num(counts.approved),
      pendingReview: num(counts.review) + num(counts.needs_revision),
      scheduled: num(counts.scheduled),
      published: num(counts.published),
      errors: num(counts.error),
      missedSlots: num(payload.missedSlots),
      automationPaused: settings.automationPaused,
      mode: settings.mode,
      realPublishEnabled: settings.realPublishEnabled,
      nextPosts,
      byCommunity: ((payload.byCommunity ?? []) as Row[]).map((row) => ({
        id: communityIdOf(row.id),
        name: str(row.name),
        color: str(row.color, "#3B7BD6"),
        pending: num(row.pending),
        scheduled: num(row.scheduled),
        published: num(row.published),
        errors: num(row.errors),
      })),
      spendUsdMonth: settings.spendUsdMonth,
      spendLimitUsd: settings.aiMonthlyLimitUsd,
      unread: num(payload.unreadNotifications),
      jobs: ((payload.jobs ?? []) as Row[]).map((row) => ({
        id: str(row.id),
        type: str(row.type, "job"),
        status: (str(row.status, "queued") as JobStatus) ?? "queued",
        attempts: num(row.attempts),
        maxAttempts: num(row.maxAttempts, 3),
        runAt: isoRequired(row.runAt),
        error: strOrNull(row.error),
        idempotencyKey: strOrNull(row.idempotencyKey),
        createdAt: isoRequired(row.createdAt),
      })),
      integrations: (((payload.integrations ?? []) as Row[]).map((row) => this.mapIntegration(row))).sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
      backend: this.info,
      moscow: { dateStr: moscow.dateStr, timeStr: moscow.timeStr, weekday: moscow.weekday },
    };
  }

  async integrations(): Promise<IntegrationStatus[]> {
    const rows = await this.select("integration_status", (query) => query.order("key"));
    const list = rows.map((row) => this.mapIntegration(row));

    // Само наличие ответа Supabase — уже факт подключения, но «проверено» ставим
    // только там, где сервер действительно подтвердил вызовом.
    const hasSupabase = list.some((item) => item.key === "supabase");
    if (!hasSupabase) {
      list.push({
        id: "supabase",
        key: "supabase",
        label: "Supabase (БД, Auth, Storage)",
        configured: true,
        verified: true,
        status: "verified",
        detail: "Чтение через PostgREST выполнено успешно.",
        checkedAt: new Date().toISOString(),
      });
    }
    return list.sort((a, b) => a.key.localeCompare(b.key));
  }

  // -- сообщества -----------------------------------------------------------

  async communities(): Promise<Community[]> {
    const rows = await this.select("communities", (query) => query.order("name"));
    return rows.map((row) => this.mapCommunity(row));
  }

  async community(id: string): Promise<CommunityDetail> {
    const { data, error } = await this.client.from("communities").select("*").eq("id", id).maybeSingle();
    if (error) throw dbError(error);
    if (!data) throw new ApiError(404, "Сообщество не найдено");

    const [characters, rules, scheduleRow, postRows] = await Promise.all([
      this.loadCharacters((query) => (query as any).eq("community_id", id)),
      this.loadRules(id),
      this.client.from("schedules").select("*").eq("community_id", id).maybeSingle(),
      this.client.from("posts").select("status").eq("community_id", id).limit(3000),
    ]);

    const stats: Record<string, number> = {};
    for (const row of (postRows.data ?? []) as Row[]) {
      const status = str(row.status);
      stats[status] = (stats[status] ?? 0) + 1;
    }

    const scheduleRaw = scheduleRow?.data as Row | null;

    return {
      community: this.mapCommunity(data as Row),
      characters,
      rules,
      schedule: scheduleRaw
        ? {
            id: str(scheduleRaw.id),
            communityId: communityIdOf(scheduleRaw.community_id),
            slots: normalizeSlots(scheduleRaw.slots),
            timezone: str(scheduleRaw.timezone, "Europe/Moscow"),
            daysOfWeek: Array.isArray(scheduleRaw.days_of_week)
              ? (scheduleRaw.days_of_week as number[]).map((day) => num(day, 1))
              : [1, 2, 3, 4, 5, 6, 7],
            paused: bool(scheduleRaw.paused),
            skipUntil: toIso(scheduleRaw.skip_until, null),
            note: str(scheduleRaw.note),
          }
        : null,
      stats,
    };
  }

  async updateCommunity(id: string, patch: Row): Promise<Community> {
    await this.invoke("communities/update", { communityId: id, patch });
    const { data, error } = await this.client.from("communities").select("*").eq("id", id).maybeSingle();
    if (error) throw dbError(error);
    if (!data) throw new ApiError(404, "Сообщество не найдено");
    return this.mapCommunity(data as Row);
  }

  async saveCommunityRules(id: string, rules: Partial<CommunityRuleSet>, changeNote: string): Promise<{ version: number }> {
    const result = await this.invoke<Row>("communities/rules", { communityId: id, rules, changeNote });
    return { version: num(result?.version, 0) };
  }

  async connectVk(id: string, token: string, groupId: string): Promise<VkConnectResult> {
    const result = await this.invoke<Row>("communities/vk-token", { communityId: id, token, groupId });
    return {
      connected: bool(result?.connected),
      verified: bool(result?.verified),
      groupName: strOrNull(result?.groupName) ?? undefined,
      warning: strOrNull(result?.warning) ?? undefined,
      testMode: result?.testMode === undefined ? undefined : bool(result.testMode),
    };
  }

  async checkVk(id: string): Promise<{ ok: boolean; groupName?: string; error?: string }> {
    try {
      const result = await this.invoke<Row>("communities/vk-check", { communityId: id });
      const group = (result?.group ?? {}) as Row;
      return { ok: true, groupName: str(group.name) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Не удалось проверить токен" };
    }
  }

  // -- публикации -----------------------------------------------------------

  async posts(filters: PostFilters): Promise<Post[]> {
    await this.ready;
    let query = this.client.from("posts").select("*").order("scheduled_at", { ascending: false }).limit(filters.limit ?? 300);

    if (filters.communityId) query = query.eq("community_id", filters.communityId);
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.from) query = query.gte("scheduled_at", filters.from);
    if (filters.to) query = query.lte("scheduled_at", filters.to);
    if (filters.q && filters.q.trim() !== "") {
      const term = filters.q.trim().replace(/[%,()]/g, " ").slice(0, 80);
      query = query.or(`title.ilike.%${term}%,text.ilike.%${term}%,topic.ilike.%${term}%`);
    }

    const { data, error } = await query;
    if (error) throw dbError(error);
    return this.mapPosts((data ?? []) as Row[]);
  }

  private async loadPost(id: string): Promise<Post> {
    const { data, error } = await this.client.from("posts").select("*").eq("id", id).maybeSingle();
    if (error) throw dbError(error);
    if (!data) throw new ApiError(404, "Публикация не найдена");
    const [post] = await this.mapPosts([data as Row]);
    return post;
  }

  async post(id: string): Promise<PostDetailPayload> {
    const post = await this.loadPost(id);
    const [versions, approvals, community] = await Promise.all([
      this.client
        .from("post_versions")
        .select("*")
        .eq("post_id", id)
        .order("version", { ascending: false })
        .limit(40),
      this.client.from("approvals").select("*").eq("post_id", id).order("created_at", { ascending: false }).limit(40),
      this.client.from("communities").select("*").eq("id", post.communityId).maybeSingle(),
    ]);

    const mappedVersions: PostVersion[] = ((versions.data ?? []) as Row[]).map((row) => ({
      id: str(row.id),
      postId: str(row.post_id),
      version: num(row.version, 1),
      text: str(row.text),
      imagePath: strOrNull(row.image_path),
      imagePrompt: str(row.image_prompt),
      contentHash: str(row.content_hash),
      createdAt: isoRequired(row.created_at),
      createdBy: strOrNull(row.created_by),
      reason: str(row.reason, "edit"),
    }));

    const mappedApprovals: Approval[] = ((approvals.data ?? []) as Row[]).map((row) => ({
      id: str(row.id),
      postId: str(row.post_id),
      versionHash: str(row.version_hash),
      action: (str(row.action, "approve") as Approval["action"]) ?? "approve",
      comment: str(row.comment),
      userId: str(row.user_id),
      createdAt: isoRequired(row.created_at),
    }));

    return {
      post,
      versions: mappedVersions,
      approvals: mappedApprovals,
      community: community.data ? this.mapCommunity(community.data as Row) : null,
      imageUrl: post.imagePath ? await this.signOne(post.imagePath) : null,
    };
  }

  async createPost(input: { communityId: string; scheduledAt: string; title?: string; text?: string }): Promise<Post> {
    const result = await this.invoke<Row>("posts/create", {
      communityId: input.communityId,
      scheduledAt: input.scheduledAt,
      title: input.title,
      text: input.text,
    });
    const id = str(result?.id ?? (result?.post as Row | undefined)?.id);
    if (!id) throw new ApiError(500, "Сервер не вернул идентификатор публикации");
    return this.loadPost(id);
  }

  async editPost(id: string, patch: { text?: string; imagePath?: string | null; scheduledAt?: string; title?: string }): Promise<Post> {
    await this.invoke("posts/edit", {
      postId: id,
      text: patch.text,
      imagePath: patch.imagePath,
      scheduledAt: patch.scheduledAt,
      title: patch.title,
    });
    return this.loadPost(id);
  }

  async approvePost(id: string, comment = ""): Promise<Post> {
    await this.invoke("posts/approve", { postId: id, comment });
    return this.loadPost(id);
  }

  async rejectPost(id: string, comment = ""): Promise<Post> {
    await this.invoke("posts/reject", { postId: id, comment });
    return this.loadPost(id);
  }

  async revisePost(id: string, what: "text" | "image" | "all", comment = ""): Promise<Post> {
    await this.invoke("posts/revise", { postId: id, what, comment });
    return this.loadPost(id);
  }

  async regeneratePost(id: string, what: "text" | "image" | "all"): Promise<Post> {
    await this.invoke("posts/regenerate", { postId: id, what });
    // Генерация асинхронная: возвращаем текущее состояние (status = generating).
    return this.waitForGeneration(id, 20_000);
  }

  async schedulePost(id: string): Promise<{ post: Post; dryRun: boolean }> {
    const result = await this.invoke<Row>("posts/schedule", { postId: id });
    const post = await this.loadPost(id);
    // dryRun=true означает: постановка в очередь без реальной отправки в VK.
    return { post, dryRun: result?.dryRun === undefined ? !post.approvedHash : bool(result.dryRun) };
  }

  async unschedulePost(id: string, reason = ""): Promise<Post> {
    await this.invoke("posts/unschedule", { postId: id, reason });
    return this.loadPost(id);
  }

  async generateSlot(input: GenerateSlotInput): Promise<Post> {
    const result = await this.invoke<Row>("posts/generate", {
      communityId: input.communityId,
      scheduledAt: input.scheduledAt,
      kind: input.kind ?? "full_post",
      force: Boolean(input.force),
      prompt: input.prompt,
    });

    if (bool(result?.skipped) && (result?.post as Row | undefined)?.id) {
      return this.loadPost(str((result.post as Row).id));
    }

    const postId = str(result?.postId);
    if (!postId) throw new ApiError(500, "Сервер не вернул публикацию для генерации");
    return this.waitForGeneration(postId, 25_000);
  }

  /** Ждём завершения фоновой генерации; если не успела — отдаём состояние «генерируется». */
  private async waitForGeneration(postId: string, timeoutMs: number): Promise<Post> {
    const deadline = Date.now() + timeoutMs;
    let post = await this.loadPost(postId);
    while (post.status === "generating" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      post = await this.loadPost(postId);
    }
    return post;
  }

  async prepareUpcoming(): Promise<{ queued: number }> {
    const result = await this.invoke<Row>("planner/prepare");
    return { queued: num(result?.queued) };
  }

  async runWorker(task: "tick" | "planner" | "publish_due" | "stats"): Promise<unknown> {
    return this.invoke("worker/run", { task });
  }

  async jobs(): Promise<Job[]> {
    const [generation, publication, service] = await Promise.all([
      this.client.from("generation_jobs").select("*").order("created_at", { ascending: false }).limit(30),
      this.client.from("publication_jobs").select("*").order("created_at", { ascending: false }).limit(30),
      this.client.from("jobs").select("*").order("created_at", { ascending: false }).limit(30),
    ]);

    if (generation.error) throw dbError(generation.error);

    const jobs: Job[] = [
      ...((generation.data ?? []) as Row[]).map((row) => this.mapJob(row, str(row.kind, "generation"))),
      ...((publication.data ?? []) as Row[]).map((row) => this.mapJob(row, "publication")),
      ...((service.data ?? []) as Row[]).map((row) => this.mapJob(row, str(row.type, "service"))),
    ];

    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40);
  }

  async setAutomationPaused(paused: boolean): Promise<void> {
    await this.invoke("settings/save", { patch: { automationPaused: paused } });
  }

  // -- календарь ------------------------------------------------------------

  async calendar(from?: string, to?: string): Promise<CalendarPayload> {
    const now = new Date();
    const fromIso = from ?? new Date(now.getTime() - 7 * 864e5).toISOString();
    const toIso = to ?? new Date(now.getTime() + 21 * 864e5).toISOString();

    const [rows, communities] = await Promise.all([
      this.posts({ from: fromIso, to: toIso, limit: 600 }),
      this.communities(),
    ]);

    const expected: CalendarPayload["expected"] = [];
    const start = moscowParts(new Date(fromIso));
    const end = moscowParts(new Date(toIso));
    let dateStr = start.dateStr;
    let guard = 0;

    while (guard++ < 400) {
      for (const community of communities) {
        if (community.status === "paused" || !community.automationEnabled) continue;
        for (const slot of normalizeSlots(community.schedule)) {
          const iso = moscowSlotIso(dateStr, slot);
          if (iso >= fromIso && iso <= toIso) {
            expected.push({ communityId: community.id, scheduledAt: iso });
          }
        }
      }
      if (dateStr >= end.dateStr) break;
      dateStr = addDays(dateStr, 1);
    }

    expected.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

    const covered = new Set(
      rows
        .filter((post) => COVERED_STATUSES.includes(post.status))
        .map((post) => `${post.communityId}:${post.scheduledAt}`),
    );
    const nowIso = now.toISOString();
    const missed = expected.filter(
      (slot) => slot.scheduledAt < nowIso && !covered.has(`${slot.communityId}:${slot.scheduledAt}`),
    );

    return {
      posts: rows,
      expected,
      missed,
      timezone: "Europe/Moscow",
    };
  }

  // -- персонажи ------------------------------------------------------------

  async characters(): Promise<Character[]> {
    return this.loadCharacters();
  }

  async updateCharacter(id: string, patch: Row): Promise<Character> {
    await this.invoke("characters/update", { characterId: id, patch });
    const characters = await this.loadCharacters((query) => (query as any).eq("id", id));
    const character = characters[0];
    if (!character) throw new ApiError(404, "Персонаж не найден");
    return character;
  }

  async uploadReference(characterId: string, file: File, notes: string): Promise<void> {
    const uploaded = await this.uploadMedia(file, "characters", { characterId });
    await this.invoke("characters/references", {
      characterId,
      path: uploaded.path,
      notes,
      makePrimary: false,
      approved: false,
    });
  }

  async approveReference(referenceId: string): Promise<void> {
    await this.invoke("characters/references/approve", { referenceId });
  }

  async setPrimaryReference(referenceId: string): Promise<void> {
    await this.invoke("characters/references/primary", { referenceId });
  }

  async deleteReference(referenceId: string): Promise<void> {
    await this.invoke("characters/references/delete", { referenceId });
  }

  // -- аналитика ------------------------------------------------------------

  async analytics(): Promise<AnalyticsPayload> {
    const [overview, settings, published] = await Promise.all([
      this.rpc<Row>("analytics_overview"),
      this.settings(),
      this.posts({ status: "published", limit: 100 }),
    ]);

    return {
      points: ((overview.points ?? []) as Row[]).map((row) => ({
        date: str(row.date),
        communityId: communityIdOf(row.community_id),
        views: num(row.views),
        likes: num(row.likes),
        comments: num(row.comments),
        shares: num(row.shares),
        source: str(row.source, "vk"),
      })) as AnalyticsPoint[],
      published,
      best: ((overview.best ?? []) as Row[]).map((row) => ({
        postId: str(row.post_id),
        title: str(row.title),
        communityId: communityIdOf(row.community_id),
        score: num(row.score),
        views: num(row.views),
      })),
      note: str(overview.note),
      testMode: settings.mode === "test",
      insufficientData: bool(overview.insufficientData, true),
      thresholds: { postsForConclusions: num((overview.thresholds as Row | undefined)?.postsForConclusions, 12) },
    };
  }

  async importAnalytics(rows: Array<Row>, note: string): Promise<{ imported: number }> {
    const result = await this.invoke<Row>("analytics/import", { rows, note });
    return { imported: num(result?.imported) };
  }

  // -- настройки и AI -------------------------------------------------------

  async settings(): Promise<ApplicationSettings> {
    const payload = await this.rpc<Row>("get_settings");
    return this.mapSettings(payload ?? {});
  }

  async saveSettings(patch: Row): Promise<ApplicationSettings> {
    await this.invoke("settings/save", { patch });
    return this.settings();
  }

  async saveAiKey(key: string | null): Promise<{ hasKey: boolean }> {
    const result = await this.invoke<Row>("settings/ai-key", { key: key ?? "" });
    return { hasKey: bool(result?.hasKey) };
  }

  async testAi(): Promise<{ ok: boolean; sample?: string; error?: string; provider?: string; demo?: boolean; limitations?: string[] }> {
    try {
      const result = await this.invoke<Row>("settings/test-ai");
      const adapter = (result?.adapter ?? {}) as Row;
      return {
        ok: bool(result?.ok, true),
        sample: str(result?.sample),
        provider: str(adapter.id, "test"),
        demo: bool(adapter.demo, true),
        limitations: strArray(adapter.limitations),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Проверка не удалась" };
    }
  }

  async providers(): Promise<AiProvidersPayload> {
    const settings = await this.settings();
    const { data } = await this.client.from("ai_providers").select("*").eq("id", settings.aiProvider).maybeSingle();
    const rows = data ? [data as Row] : await this.select("ai_providers");
    const row = rows.find((item) => str(item.id) === settings.aiProvider) ?? rows[0] ?? {};

    const integrations = await this.select("integration_status", (query) => query.eq("key", "ai_text"));
    const configuredKey = bool(integrations[0]?.configured);
    const supportsIdentityLock = bool(row.supports_identity_lock);
    const limitations: string[] = [];
    if (str(row.notes)) limitations.push(str(row.notes));
    if (!supportsIdentityLock) {
      limitations.push(
        "Провайдер не поддерживает жёсткую фиксацию личности персонажа: повторы внешности между кадрами не гарантируются.",
      );
    }
    if (settings.aiProvider === "test") {
      limitations.push("Выбран тестовый движок: это не реальная языковая модель, вывод помечается как демонстрационный.");
    }

    return {
      active: settings.aiProvider,
      label: str(row.name, "Тестовый движок"),
      supportsReferences: bool(row.supports_references),
      supportsIdentityLock,
      configuredKey,
      demo: settings.aiProvider === "test" || !configuredKey,
      models: { text: settings.aiTextModel, image: settings.aiImageModel },
      limitations,
    };
  }

  async aiHistory(): Promise<AiGenerationRecord[]> {
    const rows = await this.select("ai_generations", (query) => query.order("created_at", { ascending: false }).limit(100));
    return rows.map((row) => ({
      id: str(row.id),
      communityId: row.community_id ? communityIdOf(row.community_id) : null,
      type: str(row.type, "text"),
      provider: str(row.provider, "test"),
      model: str(row.model),
      prompt: str(row.prompt),
      result: str(row.result),
      costUsd: num(row.cost_usd),
      status: str(row.status, "done"),
      error: strOrNull(row.error),
      createdAt: isoRequired(row.created_at),
    }));
  }

  async ideas(communityId: string, count = 6): Promise<Idea[]> {
    const result = await this.invoke<{ ideas: Idea[] }>("ai/ideas", { communityId, count });
    return (result.ideas ?? []).slice(0, count);
  }

  // -- уведомления, аудит, медиа -------------------------------------------

  async notifications(): Promise<{ items: NotificationItem[]; unread: number }> {
    const [rows, count] = await Promise.all([
      this.select("notifications", (query) => query.order("created_at", { ascending: false }).limit(100)),
      this.client.from("notifications").select("id", { count: "exact", head: true }).eq("read", false),
    ]);

    return {
      items: rows.map((row) => ({
        id: str(row.id),
        type: str(row.type, "system") as NotificationItem["type"],
        title: str(row.title),
        message: str(row.message),
        link: strOrNull(row.link),
        read: bool(row.read),
        createdAt: isoRequired(row.created_at),
      })),
      unread: count.count ?? 0,
    };
  }

  async markNotificationsRead(id?: string): Promise<void> {
    await this.invoke("notifications/read", id ? { id } : {});
  }

  async audit(): Promise<AuditEntry[]> {
    const rows = await this.select("audit_logs", (query) => query.order("created_at", { ascending: false }).limit(200));
    return rows.map((row) => ({
      id: str(row.id),
      userId: strOrNull(row.user_id),
      action: str(row.action),
      entityType: strOrNull(row.entity_type),
      entityId: strOrNull(row.entity_id),
      details: row.details ?? null,
      ip: strOrNull(row.ip),
      result: strOrNull(row.result),
      createdAt: isoRequired(row.created_at),
    }));
  }

  async uploadMedia(
    file: File,
    folder: "posts" | "characters" | "communities" | "generated" | "archive",
    context?: { postId?: string; characterId?: string; communityId?: string },
  ): Promise<UploadResult> {
    const form = new FormData();
    form.append("file", file);
    form.append("folder", folder);
    if (context?.postId) form.append("postId", context.postId);
    if (context?.characterId) form.append("characterId", context.characterId);
    if (context?.communityId) form.append("communityId", context.communityId);

    const result = await this.invoke<Row>("media/upload", form);
    const path = str(result?.path);
    return {
      path,
      url: strOrNull(result?.url),
      mime: str(result?.mime, file.type || "image/png"),
      sizeBytes: num(result?.sizeBytes, file.size),
      bucket: str(result?.bucket, BUCKET),
    };
  }

  subscribe(listener: (topic: string) => void): () => void {
    const channel = this.client
      .channel("vkai-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "posts" }, () => listener("posts"))
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, () => listener("notifications"))
      .on("postgres_changes", { event: "*", schema: "public", table: "publication_jobs" }, () => listener("jobs"))
      .on("postgres_changes", { event: "*", schema: "public", table: "generation_jobs" }, () => listener("jobs"))
      .subscribe();

    return () => {
      void this.client.removeChannel(channel);
    };
  }
}
