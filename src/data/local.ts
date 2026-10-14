/**
 * Локальный стенд разработки: адаптер к Node API (`server/`, /api/*).
 *
 * Это НЕ production: реальные публикации VK выключены, статистика демонстрационная,
 * Cloudflare не используется. Файл существует, чтобы разработчик мог поднять
 * полный стек локально (`npm run dev`) без облачных ключей.
 */
import type {
  AiGenerationRecord,
  AiProvidersPayload,
  AnalyticsPayload,
  ApplicationSettings,
  AuditEntry,
  AuthStatus,
  CalendarPayload,
  Character,
  Community,
  CommunityRuleSet,
  DashboardData,
  IntegrationStatus,
  Job,
  NotificationItem,
  Post,
  PostDetailPayload,
  PostFilters,
  UploadResult,
  UserPublic,
} from "@shared/types";
import type { Idea } from "@shared/content-engine";
import { CONFIG } from "@/lib/config";
import { ApiError, api } from "@/lib/api";
import type { Backend, CommunityDetail, GenerateSlotInput, VkConnectResult } from "./types";
import { backendInfoFor } from "./types";

const LOCAL_NOTE =
  "Локальный стенд: данные в SQLite, реальные публикации VK выключены, статистика демонстрационная.";

function unsupported(what: string): never {
  throw new Error(`${what} доступно только в облачном режиме Supabase (см. CODEX_SETUP.md).`);
}

function mapPost(raw: Record<string, unknown>): Post {
  return {
    id: String(raw.id),
    communityId: raw.communityId as Post["communityId"],
    status: raw.status as Post["status"],
    scheduledAt: String(raw.scheduledAt),
    publishedAt: (raw.publishedAt as string | null) ?? null,
    title: String(raw.title ?? ""),
    text: String(raw.text ?? ""),
    imagePath: (raw.imagePath as string | null) ?? null,
    imageUrl: (raw.imagePath as string | null) ?? null,
    imagePrompt: String(raw.imagePrompt ?? ""),
    topic: String(raw.topic ?? ""),
    idea: String(raw.idea ?? ""),
    vkPostId: (raw.vkPostId as string | null) ?? null,
    contentHash: String(raw.contentHash ?? ""),
    approvedHash: (raw.approvedHash as string | null) ?? null,
    approvedAt: (raw.approvedAt as string | null) ?? null,
    approvedBy: raw.approvedBy === null || raw.approvedBy === undefined ? null : String(raw.approvedBy),
    errorMessage: (raw.errorMessage as string | null) ?? null,
    generationMeta: (raw.generationMeta as Post["generationMeta"]) ?? null,
    similarityScore: (raw.similarityScore as number | null) ?? null,
    similarTo: (raw.similarTo as string | null) ?? null,
    testMode: Boolean(raw.testMode),
    version: Number(raw.version ?? 1),
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    updatedAt: String(raw.updatedAt ?? new Date().toISOString()),
  };
}

export class LocalBackend implements Backend {
  readonly info = backendInfoFor("local", null, false, null);

  private base = CONFIG.localApiBase;

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const url = this.base ? `${this.base.replace(/\/$/, "")}${path}` : path;
    return api<T>(url, init);
  }

  private async apiPost<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body === undefined ? "{}" : JSON.stringify(body),
    });
  }

  readonly auth = {
    status: async (): Promise<AuthStatus> => {
      const status = await this.request<{ setupComplete: boolean; user: UserPublic | null }>("/api/auth/status");
      return {
        setupComplete: status.setupComplete,
        user: status.user,
        backend: this.info,
        hints: [LOCAL_NOTE],
      };
    },
    signIn: async (email: string, password: string): Promise<UserPublic> => {
      const result = await this.apiPost<{ user: UserPublic }>("/api/auth/login", { email, password });
      return result.user;
    },
    createOwner: async (email: string, password: string, name: string): Promise<UserPublic> => {
      const result = await this.apiPost<{ user: UserPublic }>("/api/auth/setup", { email, password, name });
      return result.user;
    },
    signOut: async () => {
      await this.apiPost("/api/auth/logout");
    },
    onChange: () => () => undefined,
  };

  async dashboard(): Promise<DashboardData> {
    const data = await this.request<Record<string, unknown>>("/api/dashboard");
    const nextPosts = ((data.nextPosts ?? []) as Record<string, unknown>[]).map(mapPost);
    return {
      ready: Number(data.ready ?? 0),
      pendingReview: Number(data.pendingReview ?? 0),
      scheduled: Number(data.scheduled ?? 0),
      published: Number(data.published ?? 0),
      errors: Number(data.errors ?? 0),
      missedSlots: Number(data.missedSlots ?? 0),
      automationPaused: Boolean(data.automationPaused),
      mode: (data.mode as "test" | "approval") ?? "test",
      realPublishEnabled: false,
      nextPosts,
      byCommunity: ((data.byCommunity ?? []) as DashboardData["byCommunity"]),
      spendUsdMonth: Number(data.spendUsdMonth ?? 0),
      spendLimitUsd: Number(data.spendLimitUsd ?? 0),
      unread: Number(data.unread ?? 0),
      jobs: [],
      integrations: await this.integrations(),
      backend: this.info,
      moscow: (data.moscow as DashboardData["moscow"]) ?? { dateStr: "", timeStr: "", weekday: 0 },
    };
  }

  async integrations(): Promise<IntegrationStatus[]> {
    const item = (
      key: IntegrationStatus["key"],
      label: string,
      status: IntegrationStatus["status"],
      configured: boolean,
      detail: string,
    ): IntegrationStatus => ({ id: key, key, label, configured, verified: false, status, detail, checkedAt: new Date().toISOString() });

    return [
      item("supabase", "Supabase (БД, Auth, Storage)", "off", false, "Не подключён: локальный стенд на SQLite."),
      item("github_pages", "GitHub Pages", "off", false, "Локальная разработка."),
      item("vk", "VK API", "demo", false, "Реальные вызовы выключены в тестовом режиме."),
      item("ai_text", "AI: текст", "demo", false, "Тестовый движок либо локальные ключи в .env."),
      item("ai_image", "AI: изображения", "demo", false, "SVG-карточки либо локальные ключи в .env."),
      item("cron", "Планировщик", "demo", true, "Внутренний таймер Node-процесса каждые 8 секунд."),
      item("storage", "Хранилище файлов", "demo", true, "Локальный каталог data/uploads."),
      item("realtime", "Realtime", "off", false, "Обновление опросом."),
    ];
  }

  async communities(): Promise<Community[]> {
    const result = await this.request<{ communities: Community[] }>("/api/communities");
    return result.communities;
  }

  async community(id: string): Promise<CommunityDetail> {
    const result = await this.request<{
      community: Community;
      characters: Character[];
      stats: Array<{ status: string; c: number }>;
    }>(`/api/communities/${id}`);
    return {
      community: result.community,
      characters: result.characters,
      rules: null,
      schedule: null,
      stats: Object.fromEntries(result.stats.map((row) => [row.status, Number(row.c)])),
    };
  }

  async updateCommunity(id: string, patch: Record<string, unknown>): Promise<Community> {
    const result = await this.request<{ community: Community }>(`/api/communities/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return result.community;
  }

  async saveCommunityRules(): Promise<{ version: number }> {
    unsupported("Редактирование правил сообщества");
  }

  async connectVk(id: string, token: string, groupId: string): Promise<VkConnectResult> {
    const result = await this.apiPost<{ connected: boolean; name?: string; testMode?: boolean }>(
      `/api/communities/${id}/vk`,
      { token, groupId },
    );
    return {
      connected: result.connected,
      verified: false,
      groupName: result.name,
      testMode: result.testMode,
      warning: "Локальный стенд: реальные запросы к VK не отправляются.",
    };
  }

  async checkVk(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: "Проверка VK доступна в облачном режиме." };
  }

  async posts(filters: PostFilters): Promise<Post[]> {
    const params = new URLSearchParams();
    if (filters.communityId) params.set("communityId", String(filters.communityId));
    if (filters.status) params.set("status", String(filters.status));
    if (filters.q) params.set("q", filters.q);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    const result = await this.request<{ posts: Record<string, unknown>[] }>(`/api/posts?${params.toString()}`);
    return result.posts.map(mapPost);
  }

  async post(id: string): Promise<PostDetailPayload> {
    const result = await this.request<{
      post: Record<string, unknown>;
      versions: PostDetailPayload["versions"];
      approvals: PostDetailPayload["approvals"];
      community?: Community;
    }>(`/api/posts/${id}`);
    const post = mapPost(result.post);
    return {
      post,
      versions: result.versions ?? [],
      approvals: result.approvals ?? [],
      community: result.community ?? null,
      imageUrl: post.imagePath,
    };
  }

  async createPost(input: { communityId: string; scheduledAt: string; title?: string; text?: string }): Promise<Post> {
    const result = await this.apiPost<{ post: Record<string, unknown> }>("/api/posts", input);
    return mapPost(result.post);
  }

  async editPost(id: string, patch: Record<string, unknown>): Promise<Post> {
    const result = await this.request<{ post: Record<string, unknown> }>(`/api/posts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return mapPost(result.post);
  }

  private async postAction(id: string, action: string, body?: unknown): Promise<Post> {
    const result = await this.apiPost<{ post: Record<string, unknown> }>(`/api/posts/${id}/${action}`, body);
    return mapPost(result.post);
  }

  approvePost(id: string, comment = "") {
    return this.postAction(id, "approve", { comment });
  }

  rejectPost(id: string, comment = "") {
    return this.postAction(id, "reject", { comment });
  }

  revisePost(id: string, what: "text" | "image" | "all", comment = "") {
    return this.postAction(id, "revise", { what, comment });
  }

  regeneratePost(id: string, what: "text" | "image" | "all") {
    return this.postAction(id, "regenerate", { what });
  }

  async schedulePost(id: string): Promise<{ post: Post; dryRun: boolean }> {
    const result = await this.apiPost<{ post: Record<string, unknown>; dryRun: boolean }>(`/api/posts/${id}/schedule`);
    return { post: mapPost(result.post), dryRun: Boolean(result.dryRun) };
  }

  async unschedulePost(id: string, reason = ""): Promise<Post> {
    return this.postAction(id, "unschedule", { reason });
  }

  async generateSlot(input: GenerateSlotInput): Promise<Post> {
    const result = await this.apiPost<{ post: Record<string, unknown> }>("/api/ai/generate-slot", input);
    return mapPost(result.post);
  }

  async prepareUpcoming(): Promise<{ queued: number }> {
    return this.apiPost<{ queued: number }>("/api/automation/prepare");
  }

  async runWorker(task: string): Promise<unknown> {
    if (task === "publish_due" || task === "stats") {
      return { note: "Локальный стенд выполняет публикацию и статистику внутри своего таймера." };
    }
    return this.apiPost("/api/automation/tick");
  }

  async jobs(): Promise<Job[]> {
    const result = await this.request<{ jobs: Job[] }>("/api/jobs");
    return result.jobs ?? [];
  }

  async setAutomationPaused(paused: boolean): Promise<void> {
    await this.apiPost(paused ? "/api/automation/pause" : "/api/automation/resume");
  }

  async calendar(from?: string, to?: string): Promise<CalendarPayload> {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const result = await this.request<{
      posts: Record<string, unknown>[];
      expected: CalendarPayload["expected"];
      missed: CalendarPayload["missed"];
      timezone: string;
    }>(`/api/calendar?${params.toString()}`);
    return {
      posts: result.posts.map(mapPost),
      expected: result.expected ?? [],
      missed: result.missed ?? [],
      timezone: result.timezone ?? "Europe/Moscow",
    };
  }

  async characters(): Promise<Character[]> {
    const result = await this.request<{ characters: Character[] }>("/api/characters");
    return result.characters;
  }

  async updateCharacter(id: string, patch: Record<string, unknown>): Promise<Character> {
    const result = await this.request<{ character: Character }>(`/api/characters/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return result.character;
  }

  async uploadReference(characterId: string, file: File, notes: string): Promise<void> {
    const form = new FormData();
    form.append("file", file);
    form.append("notes", notes);
    await this.request(`/api/characters/${characterId}/references`, { method: "POST", body: form });
  }

  async approveReference(): Promise<void> {
    unsupported("Подтверждение референсов");
  }

  async setPrimaryReference(): Promise<void> {
    unsupported("Выбор основного референса");
  }

  async deleteReference(): Promise<void> {
    unsupported("Удаление референса");
  }

  async analytics(): Promise<AnalyticsPayload> {
    const result = await this.request<{
      points: AnalyticsPayload["points"];
      published: Record<string, unknown>[];
      note: string;
      testMode: boolean;
    }>("/api/analytics");
    return {
      points: result.points ?? [],
      published: (result.published ?? []).map(mapPost),
      best: [],
      note: result.note,
      testMode: result.testMode,
      insufficientData: (result.published ?? []).length < 12,
      thresholds: { postsForConclusions: 12 },
    };
  }

  async importAnalytics(): Promise<{ imported: number }> {
    unsupported("Импорт аналитики");
  }

  async settings(): Promise<ApplicationSettings> {
    const result = await this.request<Record<string, unknown>>("/api/settings");
    return {
      mode: (result.mode as "test" | "approval") ?? "test",
      automationPaused: Boolean(result.automationPaused),
      realPublishEnabled: (result.mode as string) === "approval",
      timezone: String(result.timezone ?? "Europe/Moscow"),
      prepareHoursAhead: Number(result.prepareHoursAhead ?? 24),
      aiMonthlyLimitUsd: Number(result.aiMonthlyLimitUsd ?? 20),
      spendUsdMonth: Number(result.spendUsdMonth ?? 0),
      aiProvider: (result.aiProvider as ApplicationSettings["aiProvider"]) ?? "test",
      aiTextModel: String(result.aiTextModel ?? "test-writer-v1"),
      aiImageModel: String(result.aiImageModel ?? "test-illustrator-v1"),
      aiBaseUrl: String(result.aiBaseUrl ?? ""),
      notificationsEnabled: Boolean(result.notificationsEnabled ?? true),
      demoMode: true,
    };
  }

  async saveSettings(patch: Record<string, unknown>): Promise<ApplicationSettings> {
    await this.request("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
    return this.settings();
  }

  async saveAiKey(key: string | null): Promise<{ hasKey: boolean }> {
    await this.request("/api/settings", { method: "PATCH", body: JSON.stringify({ aiApiKey: key ?? "" }) });
    return { hasKey: Boolean(key) };
  }

  async testAi(): Promise<{ ok: boolean; sample?: string; error?: string }> {
    const result = await this.apiPost<{ ok: boolean; sample?: string; error?: string }>("/api/settings/test-ai");
    return result;
  }

  async providers(): Promise<AiProvidersPayload> {
    const result = await this.request<Record<string, unknown>>("/api/ai/providers");
    return {
      active: (result.active as AiProvidersPayload["active"]) ?? "test",
      label: String(result.label ?? "Тестовый движок"),
      supportsReferences: Boolean(result.supportsReferences),
      supportsIdentityLock: false,
      configuredKey: Boolean(result.configuredKey),
      demo: !result.configuredKey,
      models: (result.models as { text: string; image: string }) ?? { text: "test", image: "test" },
      limitations: ["Локальный стенд: сохранение внешности персонажа не гарантируется."],
    };
  }

  async aiHistory(): Promise<AiGenerationRecord[]> {
    const result = await this.request<{ generations: AiGenerationRecord[] }>("/api/ai/history");
    return result.generations ?? [];
  }

  async ideas(communityId: string, count = 6): Promise<Idea[]> {
    const result = await this.apiPost<{ ideas: Idea[] }>("/api/ai/ideas", { communityId });
    return (result.ideas ?? []).slice(0, count);
  }

  async notifications(): Promise<{ items: NotificationItem[]; unread: number }> {
    const result = await this.request<{ items: NotificationItem[]; unread: number }>("/api/notifications");
    return { items: result.items ?? [], unread: Number(result.unread ?? 0) };
  }

  async markNotificationsRead(id?: string): Promise<void> {
    await this.apiPost("/api/notifications/read", id ? { id } : {});
  }

  async audit(): Promise<AuditEntry[]> {
    const result = await this.request<{ items: AuditEntry[] }>("/api/audit");
    return result.items ?? [];
  }

  async uploadMedia(file: File, folder: "posts" | "characters"): Promise<UploadResult> {
    const form = new FormData();
    form.append("file", file);
    form.append("folder", folder);
    const result = await this.request<{ path: string; url: string }>("/api/uploads", { method: "POST", body: form });
    return { path: result.path, url: result.url, mime: file.type, sizeBytes: file.size, bucket: "local" };
  }

  subscribe(): () => void {
    return () => undefined;
  }
}

export { ApiError };
