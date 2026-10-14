/**
 * ДЕМО-РЕЖИМ — полностью автономный backend в браузере.
 *
 * Зачем: интерфейс на GitHub Pages работает без сервера и без ключей, честно
 * помечая все данные как демонстрационные (ТЗ §19).
 *
 * Что здесь строго запрещено и потому невозможно технически:
 *   • публикация в VK (нет клиента VK, статус публикации всегда test_*);
 *   • платные вызовы AI (используется детерминированный движок shared/content-engine);
 *   • показ фиктивных подключений как активных (integration_status = demo/off).
 *
 * Инварианты одобрения продублированы здесь, чтобы поведение совпадало с сервером,
 * но источником истины в production остаётся PostgreSQL (см. supabase/migrations).
 */
import {
  COMMUNITY_IDS,
  type AiGenerationRecord,
  type AiProvidersPayload,
  type AnalyticsPayload,
  type ApplicationSettings,
  type AuditEntry,
  type AuthStatus,
  type CalendarPayload,
  type Character,
  type Community,
  type CommunityId,
  type CommunityRuleSet,
  type DashboardData,
  type IntegrationStatus,
  type Job,
  type NotificationItem,
  type Post,
  type PostDetailPayload,
  type PostFilters,
  type PostStatus,
  type PostVersion,
  type Schedule,
  type UploadResult,
  type UserPublic,
} from "@shared/types";
import { COMMUNITY_META, COMMUNITY_RULE_SETS, DEFAULT_APP_SETTINGS, DEFAULT_GENERATION, DEMO, STYLE_RULES } from "@shared/constants";
import { generateIdeas, generateIdea, generateText, type Idea } from "@shared/content-engine";
import { contentHash, normalizeText } from "@shared/hash";
import { STATUS_LABELS } from "@shared/types";
import { DEFAULT_SLOTS, addDays, moscowParts, moscowSlotIso, normalizeSlots, upcomingSlots } from "@shared/moscow";
import { mulberry32, seedFrom, uid } from "@shared/prng";
import { similarity } from "@shared/similarity";
import { validateCommunityText } from "@shared/rules";
import { demoIllustrationDataUrl } from "@shared/demo-image";
import { CONFIG } from "@/lib/config";
import type { Backend, CommunityDetail, GenerateSlotInput, VkConnectResult } from "./types";
import { backendInfoFor } from "./types";

interface DemoState {
  schema: number;
  user: { id: string; email: string; name: string; role: string } | null;
  communities: Record<
    string,
    { schedule: string[]; status: "active" | "paused"; vkGroupId: string; vkConnected: boolean; paused: boolean; skipUntil: string | null; note: string }
  >;
  rules: Record<string, CommunityRuleSet>;
  characters: Character[];
  posts: Post[];
  versions: PostVersion[];
  approvals: PostDetailPayload["approvals"];
  notifications: NotificationItem[];
  jobs: Job[];
  generations: AiGenerationRecord[];
  audit: AuditEntry[];
  settings: ApplicationSettings;
  statistics: Record<string, { views: number; likes: number; comments: number; shares: number }>;
}

const SCHEMA_VERSION = 2;

function nowIso() {
  return new Date().toISOString();
}

function seedCharacters(): Character[] {
  const base = [
    {
      id: "milana",
      communityId: "milana" as CommunityId,
      name: "Милана",
      role: "Главная героиня",
      description: "Милана живёт в деревне, но держит планку столичного гламура. Добродушная, немного театральная.",
      personality: "Добродушная, немного театральная. Не злая. Спорит с бытом, а не с людьми.",
      never: ["возрастную группу", "не делать персонажа ребёнком", "никакой эротики и наготы"],
    },
    {
      id: "tolechka",
      communityId: "milana" as CommunityId,
      name: "Толечка",
      role: "Постоянный персонаж",
      description: "Толечка — сосед и вечный напарник по деревенским делам. Добрый, слегка растерянный.",
      personality: "Застенчивый, работящий, с сухим юмором. Говорит коротко.",
      never: ["не превращать в злодея или карикатуру", "никакой эротики"],
    },
    {
      id: "veronica",
      communityId: "veronica" as CommunityId,
      name: "Вероника",
      role: "Рассказчица и героиня",
      description: "Вероника, 38 лет. Пишет от первого лица. Город проживания не упоминается.",
      personality: "Честная, тёплая, наблюдательная, с самоиронией.",
      never: ["возраст 38 лет", "не указывать город", "не менять биографию", "никакой эротики и наготы"],
    },
  ];

  return base.map((item) => ({
    id: item.id,
    communityId: item.communityId,
    name: item.name,
    role: item.role,
    description: item.description,
    personality: item.personality,
    appearance: {
      distinctive: [],
      neverChange: item.never,
      note: "Внешность ожидает утверждённых референсов владельца.",
    },
    locked: true,
    appearanceStatus: "placeholder" as const,
    primaryReferenceId: null,
    references: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }));
}

function initialState(): DemoState {
  const communities: DemoState["communities"] = {};
  const rules: Record<string, CommunityRuleSet> = {};
  for (const id of COMMUNITY_IDS) {
    communities[id] = {
      schedule: [...DEFAULT_SLOTS],
      status: "active",
      vkGroupId: "",
      vkConnected: false,
      paused: false,
      skipUntil: null,
      note: "",
    };
    rules[id] = { ...COMMUNITY_RULE_SETS[id] };
  }

  return {
    schema: SCHEMA_VERSION,
    user: null,
    communities,
    rules,
    characters: seedCharacters(),
    posts: [],
    versions: [],
    approvals: [],
    notifications: [
      {
        id: uid("nt"),
        type: "system",
        title: "Демонстрационный режим",
        message:
          "Данные хранятся только в этом браузере. Реальная публикация в VK невозможна. " +
          "Для работы с реальными данными подключите Supabase по инструкции CODEX_SETUP.md.",
        link: "/settings",
        read: false,
        createdAt: nowIso(),
      },
    ],
    jobs: [],
    generations: [],
    audit: [],
    settings: { ...DEFAULT_APP_SETTINGS, spendUsdMonth: 0, demoMode: true },
    statistics: {},
  };
}

function loadState(): DemoState {
  try {
    const raw = localStorage.getItem(CONFIG.demoStorageKey);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as DemoState;
    if (parsed.schema !== SCHEMA_VERSION) return initialState();
    return { ...initialState(), ...parsed, settings: { ...DEFAULT_APP_SETTINGS, ...parsed.settings, demoMode: true } };
  } catch {
    return initialState();
  }
}

export class DemoBackend implements Backend {
  readonly info = backendInfoFor("demo", null, false, null);

  private state: DemoState;

  private listeners = new Set<(topic: string) => void>();

  constructor() {
    this.state = loadState();
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (event) => {
        if (event.key === CONFIG.demoStorageKey) {
          this.state = loadState();
          this.emit("reload");
        }
      });
    }
  }

  private emit(topic: string) {
    for (const listener of this.listeners) listener(topic);
  }

  private persist() {
    try {
      localStorage.setItem(CONFIG.demoStorageKey, JSON.stringify(this.state));
    } catch {
      /* приватный режим: продолжаем в памяти */
    }
    this.emit("state");
  }

  private notify(type: NotificationItem["type"], title: string, message: string, link?: string) {
    this.state.notifications.unshift({ id: uid("nt"), type, title, message, link: link ?? null, read: false, createdAt: nowIso() });
    this.state.notifications = this.state.notifications.slice(0, 200);
  }

  private logAudit(action: string, entityType?: string, entityId?: string, details?: unknown) {
    this.state.audit.unshift({
      id: uid("aud"),
      userId: this.state.user?.id ?? null,
      action,
      entityType: entityType ?? null,
      entityId: entityId ?? null,
      details: details ?? null,
      ip: null,
      result: "demo",
      createdAt: nowIso(),
    });
    this.state.audit = this.state.audit.slice(0, 300);
  }

  private buildCommunity(id: string): Community {
    const meta = COMMUNITY_META[id as CommunityId];
    const runtime = this.state.communities[id];
    return {
      id: id as CommunityId,
      name: meta.name,
      shortName: meta.shortName,
      tagline: meta.tagline,
      description: meta.description,
      theme: meta.theme,
      color: meta.color,
      avatarUrl: `/avatars/${id}.svg`,
      vkGroupId: runtime?.vkGroupId || null,
      vkScreenName: null,
      vkConnected: Boolean(runtime?.vkConnected),
      schedule: normalizeSlots(runtime?.schedule ?? DEFAULT_SLOTS),
      styleRules: STYLE_RULES[id as CommunityId],
      generationSettings: { ...DEFAULT_GENERATION, prepareHoursAhead: this.state.settings.prepareHoursAhead },
      status: runtime?.status ?? "active",
      automationEnabled: !(runtime?.paused ?? false),
      updatedAt: nowIso(),
    };
  }

  private decorate(post: Post): Post {
    return {
      ...post,
      imageUrl: post.imagePath ? this.imageUrl(post) : null,
    };
  }

  private imageUrl(post: Post): string {
    return demoIllustrationDataUrl({
      communityId: post.communityId,
      title: post.title || post.topic,
      topic: post.topic,
      seed: post.id,
    });
  }

  private postOrThrow(id: string): Post {
    const post = this.state.posts.find((p) => p.id === id);
    if (!post) throw new Error("Публикация не найдена");
    return post;
  }

  private hash(post: Pick<Post, "communityId" | "text" | "imagePath" | "scheduledAt">): string {
    return contentHash({
      communityId: post.communityId,
      text: post.text,
      imagePath: post.imagePath && post.imagePath.startsWith("demo://") ? post.imagePath : post.imagePath,
      scheduledAt: post.scheduledAt,
    });
  }

  /** Общий гейт: любое изменение материала сбрасывает одобрение. */
  private syncHash(post: Post, reason: string): Post {
    const nextHash = this.hash(post);
    const materialStatuses: PostStatus[] = ["approved", "scheduled"];
    const wasApproved = Boolean(post.approvedHash) || materialStatuses.includes(post.status);

    if (post.contentHash !== nextHash) {
      post.contentHash = nextHash;
      post.updatedAt = nowIso();
      if (wasApproved) {
        post.approvedHash = null;
        post.approvedAt = null;
        post.approvedBy = null;
        if (materialStatuses.includes(post.status)) {
          post.status = "review";
          post.vkPostId = null;
          post.testMode = true;
        }
        this.logAudit("approval_reset", "post", post.id, { reason });
        this.notify("review", "Нужно новое одобрение", `«${post.title || post.topic}» изменена и снова на проверке.`, `/posts/${post.id}`);
      }
    } else {
      post.contentHash = nextHash;
    }
    return post;
  }

  private version(post: Post, reason: string) {
    this.state.versions.unshift({
      id: uid("ver"),
      postId: post.id,
      version: post.version,
      text: post.text,
      imagePath: post.imagePath,
      imagePrompt: post.imagePrompt,
      contentHash: post.contentHash,
      createdAt: nowIso(),
      createdBy: this.state.user?.id ?? null,
      reason,
    });
    this.state.versions = this.state.versions.slice(0, 500);
  }

  private generateForSlot(input: GenerateSlotInput): Post {
    const communityId = input.communityId as CommunityId;
    const existing = this.state.posts.find(
      (p) => p.communityId === communityId && p.scheduledAt === input.scheduledAt && p.status !== "rejected",
    );

    const id = existing?.id ?? uid("post");
    const idea: Idea = generateIdea(
      communityId,
      this.state.posts.filter((p) => p.communityId === communityId).map((p) => p.topic),
      id,
    );
    const text = generateText(communityId, idea, id);
    const demoImagePath = `demo://${communityId}/${id}`;
    const warnings = validateCommunityText(communityId, text).map((v) => `${v.severity === "error" ? "⛔" : "⚠"} ${v.message}`);
    warnings.push("⚠ ДЕМО-РЕЖИМ: текст создан детерминированным тестовым движком, а не платной моделью.");

    const timestamp = nowIso();
    const post: Post = existing ?? {
      id,
      communityId,
      status: "generating",
      scheduledAt: input.scheduledAt,
      publishedAt: null,
      title: "",
      text: "",
      imagePath: null,
      imageUrl: null,
      imagePrompt: "",
      topic: "",
      idea: "",
      vkPostId: null,
      contentHash: "",
      approvedHash: null,
      approvedAt: null,
      approvedBy: null,
      errorMessage: null,
      generationMeta: null,
      similarityScore: null,
      similarTo: null,
      testMode: true,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (existing) this.version(existing, "regenerate:all");

    post.status = "review";
    post.title = idea.title;
    post.text = text;
    post.topic = idea.topic;
    post.idea = idea.angle;
    post.imagePath = demoImagePath;
    post.imagePrompt = `Демонстрационная иллюстрация: ${idea.topic}`;
    post.approvedHash = null;
    post.approvedAt = null;
    post.approvedBy = null;
    post.errorMessage = null;
    post.testMode = true;
    post.version = existing ? post.version + 1 : 1;
    post.updatedAt = nowIso();
    post.generationMeta = {
      provider: "test",
      model: "test-writer-v1",
      imageProvider: "test",
      imageModel: "test-illustrator-v1",
      costUsd: 0,
      ideaSource: idea.key,
      warnings,
      demo: true,
      providerLimitations: ["ДЕМО-РЕЖИМ: платные AI-провайдеры не вызываются."],
    };

    const previous = this.state.posts.filter((p) => p.communityId === communityId && p.id !== post.id);
    let best = 0;
    for (const row of previous) best = Math.max(best, similarity(text, row.text));
    post.similarityScore = Number(best.toFixed(4));

    if (!existing) this.state.posts.push(post);
    this.syncHash(post, "generation");
    this.state.jobs.unshift({
      id: uid("job"),
      type: "generation",
      status: "done",
      attempts: 1,
      maxAttempts: 3,
      runAt: timestamp,
      error: null,
      idempotencyKey: `gen:${communityId}:${input.scheduledAt}:full_post`,
      createdAt: timestamp,
    });
    this.state.jobs = this.state.jobs.slice(0, 100);
    this.state.generations.unshift({
      id: uid("gen"),
      communityId,
      type: "full_post",
      provider: "test",
      model: "test-writer-v1",
      prompt: idea.topic,
      result: text.slice(0, 500),
      costUsd: 0,
      status: "done",
      error: null,
      createdAt: timestamp,
    });
    this.state.generations = this.state.generations.slice(0, 100);
    this.notify("review", "Новый пост на проверке", `${COMMUNITY_META[communityId].shortName}: «${idea.title}»`, `/posts/${post.id}`);
    this.logAudit("generate", "post", post.id, { demo: true });

    return post;
  }

  // -------------------------------------------------------------------------
  // Backend API
  // -------------------------------------------------------------------------
  readonly auth = {
    status: async (): Promise<AuthStatus> => ({
      setupComplete: Boolean(this.state.user),
      user: this.state.user as UserPublic | null,
      backend: this.info,
      hints: [
        "Демо-режим: пароль не сохраняется и не проверяется, данные не покидают браузер.",
        "Для реальной работы подключите Supabase (CODEX_SETUP.md) — тогда вход идёт через Supabase Auth.",
      ],
    }),
    signIn: async (email: string): Promise<UserPublic> => {
      if (!this.state.user) throw new Error("Владелец ещё не создан. Сначала создайте аккаунт владельца.");
      if (this.state.user.email !== email.trim().toLowerCase()) {
        throw new Error("В демо-режиме доступен только созданный владелец.");
      }
      return this.state.user as UserPublic;
    },
    createOwner: async (email: string, password: string, name: string): Promise<UserPublic> => {
      if (password.trim().length < 10) throw new Error("Пароль не короче 10 символов");
      if (!email.includes("@")) throw new Error("Укажите корректный email");
      this.state.user = { id: uid("demo-user"), email: email.trim().toLowerCase(), name: name.trim() || "Владелец", role: "owner" };
      this.persist();
      return this.state.user;
    },
    signOut: async () => {
      this.persist();
    },
    onChange: () => () => undefined,
  };

  async dashboard(): Promise<DashboardData> {
    const counts = new Map<string, number>();
    for (const post of this.state.posts) counts.set(post.status, (counts.get(post.status) ?? 0) + 1);

    const nextPosts = this.state.posts
      .filter((p) => new Date(p.scheduledAt).getTime() >= Date.now())
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
      .slice(0, 8)
      .map((p) => this.decorate(p));

    const moscow = moscowParts();

    return {
      ready: counts.get("approved") ?? 0,
      pendingReview: (counts.get("review") ?? 0) + (counts.get("needs_revision") ?? 0),
      scheduled: counts.get("scheduled") ?? 0,
      published: counts.get("published") ?? 0,
      errors: counts.get("error") ?? 0,
      missedSlots: (await this.calendar()).missed.length,
      automationPaused: this.state.settings.automationPaused,
      mode: "test",
      realPublishEnabled: false,
      nextPosts,
      byCommunity: COMMUNITY_IDS.map((id) => {
        const posts = this.state.posts.filter((p) => p.communityId === id);
        return {
          id,
          name: COMMUNITY_META[id].name,
          color: COMMUNITY_META[id].color,
          pending: posts.filter((p) => ["review", "needs_revision"].includes(p.status)).length,
          scheduled: posts.filter((p) => ["scheduled", "approved"].includes(p.status)).length,
          published: posts.filter((p) => p.status === "published").length,
          errors: posts.filter((p) => p.status === "error").length,
        };
      }),
      spendUsdMonth: 0,
      spendLimitUsd: this.state.settings.aiMonthlyLimitUsd,
      unread: this.state.notifications.filter((n) => !n.read).length,
      jobs: this.state.jobs.slice(0, 20),
      integrations: await this.integrations(),
      backend: this.info,
      moscow: { dateStr: moscow.dateStr, timeStr: moscow.timeStr, weekday: moscow.weekday },
    };
  }

  async integrations(): Promise<IntegrationStatus[]> {
    const checkedAt = nowIso();
    const item = (
      key: IntegrationStatus["key"],
      label: string,
      status: IntegrationStatus["status"],
      configured: boolean,
      detail: string,
    ): IntegrationStatus => ({ id: key, key, label, configured, verified: false, status, detail, checkedAt });

    return [
      item("supabase", "Supabase (БД, Auth, Storage)", "demo", false, "Не подключён. Демо-режим работает в браузере."),
      item("github_pages", "GitHub Pages (интерфейс)", "demo", true, "Интерфейс открыт в демо-режиме."),
      item("vk", "VK API (4 сообщества)", "demo", false, "Токены не подключены. Реальные публикации выключены."),
      item("ai_text", "AI: генерация текста", "demo", false, "Работает детерминированный тестовый движок, платные вызовы запрещены."),
      item("ai_image", "AI: генерация изображений", "demo", false, "Рисуются демонстрационные SVG-карточки."),
      item("cron", "Supabase Cron", "off", false, "Доступен только в облачном режиме."),
      item("storage", "Supabase Storage", "off", false, "Файлы в демо-режиме не загружаются на сервер."),
      item("realtime", "Supabase Realtime", "off", false, "В демо-режиме обновления приходят через события браузера."),
    ];
  }

  async communities(): Promise<Community[]> {
    return COMMUNITY_IDS.map((id) => this.buildCommunity(id));
  }

  async community(id: string): Promise<CommunityDetail> {
    const stats = new Map<string, number>();
    for (const post of this.state.posts.filter((p) => p.communityId === id)) {
      stats.set(post.status, (stats.get(post.status) ?? 0) + 1);
    }
    const runtime = this.state.communities[id];
    return {
      community: this.buildCommunity(id),
      characters: this.state.characters.filter((c) => c.communityId === id),
      rules: this.state.rules[id] ?? null,
      schedule: {
        id: uid("sch"),
        communityId: id as CommunityId,
        slots: normalizeSlots(runtime?.schedule ?? DEFAULT_SLOTS),
        timezone: "Europe/Moscow",
        daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
        paused: runtime?.paused ?? false,
        skipUntil: runtime?.skipUntil ?? null,
        note: runtime?.note ?? "",
      },
      stats: Object.fromEntries(stats),
    };
  }

  async updateCommunity(id: string, patch: Record<string, unknown>): Promise<Community> {
    const runtime = this.state.communities[id];
    if (!runtime) throw new Error("Сообщество не найдено");
    if (patch.schedule) runtime.schedule = normalizeSlots(patch.schedule);
    if (typeof patch.status === "string" && ["active", "paused"].includes(patch.status)) {
      runtime.status = patch.status as "active" | "paused";
    }
    if (typeof patch.paused === "boolean") runtime.paused = patch.paused;
    if (typeof patch.vkGroupId === "string") runtime.vkGroupId = patch.vkGroupId;
    this.logAudit("community_update", "community", id, patch);
    this.persist();
    return this.buildCommunity(id);
  }

  async saveCommunityRules(id: string, rules: Partial<CommunityRuleSet>, changeNote: string): Promise<{ version: number }> {
    const current = this.state.rules[id];
    const version = (current?.version ?? 0) + 1;
    this.state.rules[id] = { ...(current as CommunityRuleSet), ...rules, communityId: id as CommunityId, version, updatedAt: nowIso() };
    this.logAudit("community_rules_update", "community", id, { version, changeNote });
    this.persist();
    return { version };
  }

  async connectVk(id: string, token: string, groupId: string): Promise<VkConnectResult> {
    if (!token.trim()) {
      const runtime = this.state.communities[id];
      if (runtime) runtime.vkConnected = false;
      this.persist();
      return { connected: false, verified: false, warning: "Токен удалён" };
    }
    // Демо-режим: токен НЕ сохраняется и не проверяется — нет сети к VK.
    throw new Error(
      "ДЕМО-РЕЖИМ: подключение VK недоступно. Токены хранятся только в защищённом серверном окружении Supabase. " +
        "Подключите проект Supabase (CODEX_SETUP.md) и вводите токен там.",
    );
  }

  async checkVk(): Promise<{ ok: boolean; groupName?: string; error?: string }> {
    return { ok: false, error: "ДЕМО-РЕЖИМ: проверка VK недоступна без подключённого Supabase." };
  }

  async posts(filters: PostFilters): Promise<Post[]> {
    let list = [...this.state.posts];
    if (filters.communityId) list = list.filter((p) => p.communityId === filters.communityId);
    if (filters.status) list = list.filter((p) => p.status === filters.status);
    if (filters.q) {
      const needle = filters.q.toLowerCase();
      list = list.filter((p) => `${p.title} ${p.text} ${p.topic}`.toLowerCase().includes(needle));
    }
    if (filters.from) list = list.filter((p) => p.scheduledAt >= String(filters.from));
    if (filters.to) list = list.filter((p) => p.scheduledAt <= String(filters.to));
    return list
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
      .slice(0, filters.limit ?? 200)
      .map((p) => this.decorate(p));
  }

  async post(id: string): Promise<PostDetailPayload> {
    const post = this.postOrThrow(id);
    return {
      post: this.decorate(post),
      versions: this.state.versions.filter((v) => v.postId === id),
      approvals: this.state.approvals.filter((a) => a.postId === id),
      community: this.buildCommunity(post.communityId),
      imageUrl: post.imagePath ? this.imageUrl(post) : null,
    };
  }

  async createPost(input: { communityId: string; scheduledAt: string; title?: string; text?: string }): Promise<Post> {
    if (this.state.posts.some((p) => p.communityId === input.communityId && p.scheduledAt === input.scheduledAt && p.status !== "rejected")) {
      throw new Error("Слот занят: в этом сообществе уже есть публикация на это время");
    }
    const timestamp = nowIso();
    const post: Post = {
      id: uid("post"),
      communityId: input.communityId as CommunityId,
      status: "draft",
      scheduledAt: input.scheduledAt,
      publishedAt: null,
      title: input.title || "Черновик",
      text: input.text ?? "",
      imagePath: null,
      imageUrl: null,
      imagePrompt: "",
      topic: input.title || "Черновик",
      idea: "",
      vkPostId: null,
      contentHash: "",
      approvedHash: null,
      approvedAt: null,
      approvedBy: null,
      errorMessage: null,
      generationMeta: null,
      similarityScore: null,
      similarTo: null,
      testMode: true,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.state.posts.push(post);
    this.syncHash(post, "create");
    this.logAudit("create_draft", "post", post.id);
    this.persist();
    return this.decorate(post);
  }

  async editPost(
    id: string,
    patch: { text?: string; imagePath?: string | null; scheduledAt?: string; title?: string },
  ): Promise<Post> {
    const post = this.postOrThrow(id);
    if (post.status === "published") throw new Error("Опубликованный пост нельзя редактировать");
    this.version(post, "edit");
    if (typeof patch.text === "string") post.text = normalizeText(patch.text) === "" ? patch.text : patch.text;
    if (typeof patch.title === "string") post.title = patch.title;
    if (patch.imagePath !== undefined) post.imagePath = patch.imagePath;
    if (typeof patch.scheduledAt === "string" && patch.scheduledAt !== post.scheduledAt) {
      const clash = this.state.posts.some(
        (p) => p.id !== id && p.communityId === post.communityId && p.scheduledAt === patch.scheduledAt && p.status !== "rejected",
      );
      if (clash) throw new Error("Слот занят другим постом");
      post.scheduledAt = patch.scheduledAt;
    }
    post.version += 1;
    this.syncHash(post, "edit");
    this.logAudit("edit", "post", id);
    this.persist();
    return this.decorate(post);
  }

  async approvePost(id: string, comment = ""): Promise<Post> {
    const post = this.postOrThrow(id);
    if (!["review", "needs_revision", "draft", "approved"].includes(post.status)) {
      throw new Error(`Эту публикацию нельзя одобрить в статусе «${STATUS_LABELS[post.status]}»`);
    }
    if (!post.text.trim()) throw new Error("Пустой текст нельзя одобрить");
    if (!post.imagePath) throw new Error("Нужно изображение: без картинки публикация не одобряется");

    post.contentHash = this.hash(post);
    post.approvedHash = post.contentHash;
    post.approvedAt = nowIso();
    post.approvedBy = this.state.user?.id ?? null;
    post.status = "approved";
    post.testMode = true; // ДЕМО: реальная публикация невозможна
    post.errorMessage = null;
    post.updatedAt = nowIso();
    this.state.approvals.unshift({
      id: uid("ap"),
      postId: id,
      versionHash: post.contentHash,
      action: "approve",
      comment,
      userId: this.state.user?.id ?? "demo",
      createdAt: nowIso(),
    });
    this.logAudit("approve", "post", id, { hash: post.contentHash });
    this.persist();
    return this.decorate(post);
  }

  async rejectPost(id: string, comment = ""): Promise<Post> {
    const post = this.postOrThrow(id);
    if (post.status === "published") throw new Error("Опубликованное нельзя отклонить");
    post.status = "rejected";
    post.approvedHash = null;
    post.approvedAt = null;
    post.approvedBy = null;
    post.vkPostId = null;
    post.updatedAt = nowIso();
    this.state.approvals.unshift({
      id: uid("ap"),
      postId: id,
      versionHash: post.contentHash,
      action: "reject",
      comment,
      userId: this.state.user?.id ?? "demo",
      createdAt: nowIso(),
    });
    this.logAudit("reject", "post", id, { comment });
    this.persist();
    return this.decorate(post);
  }

  async revisePost(id: string, what: "text" | "image" | "all", comment = ""): Promise<Post> {
    const post = this.postOrThrow(id);
    post.status = "needs_revision";
    post.approvedHash = null;
    post.approvedAt = null;
    post.approvedBy = null;
    post.errorMessage = `Доработка (${what}): ${comment}`;
    post.updatedAt = nowIso();
    this.state.approvals.unshift({
      id: uid("ap"),
      postId: id,
      versionHash: post.contentHash,
      action: "revise",
      comment: `${what}: ${comment}`,
      userId: this.state.user?.id ?? "demo",
      createdAt: nowIso(),
    });
    this.logAudit("revise", "post", id, { what, comment });
    this.persist();
    return this.decorate(post);
  }

  async regeneratePost(id: string, what: "text" | "image" | "all"): Promise<Post> {
    const post = this.postOrThrow(id);
    if (["published", "scheduled"].includes(post.status)) {
      throw new Error("Сначала снимите публикацию с планирования");
    }
    return this.generateForSlot({ communityId: post.communityId, scheduledAt: post.scheduledAt, force: true, kind: what === "image" ? "image" : "full_post" });
  }

  async schedulePost(id: string): Promise<{ post: Post; dryRun: boolean }> {
    const post = this.postOrThrow(id);
    if (this.state.settings.automationPaused) throw new Error("Автоматизация на паузе. Снимите паузу, чтобы планировать публикации.");
    if (!post.approvedHash) throw new Error("Публикация без одобрения невозможна");
    if (post.approvedHash !== this.hash(post)) {
      throw new Error("Одобрение не соответствует текущей версии контента. Одобрите публикацию заново.");
    }
    if (!["approved", "scheduled"].includes(post.status)) throw new Error("Статус не позволяет отправку в VK");
    if (new Date(post.scheduledAt).getTime() < Date.now() + 60_000) {
      throw new Error("Время публикации уже прошло или слишком близко");
    }

    const key = `pub:${post.id}:${post.approvedHash}`;
    if (this.state.jobs.some((j) => j.idempotencyKey === key && ["done", "running"].includes(j.status))) {
      throw new Error("Эта версия уже отправлена или отправляется");
    }

    post.status = "scheduled";
    post.testMode = true;
    // Демонстрационный идентификатор: никогда не выдаётся за реальную публикацию.
    post.vkPostId = `test_${post.communityId}_${Math.floor(new Date(post.scheduledAt).getTime() / 1000)}`;
    post.updatedAt = nowIso();

    this.state.jobs.unshift({
      id: uid("job"),
      type: "publication",
      status: "done",
      attempts: 1,
      maxAttempts: 5,
      runAt: nowIso(),
      error: null,
      idempotencyKey: key,
      createdAt: nowIso(),
    });
    this.logAudit("schedule", "post", id, { dryRun: true });
    this.notify("scheduled", "Пост запланирован (ДЕМО)", `${post.title || post.topic} — реальная отправка в VK не выполняется.`, `/posts/${id}`);
    this.persist();
    return { post: this.decorate(post), dryRun: true };
  }

  async unschedulePost(id: string, reason = ""): Promise<Post> {
    const post = this.postOrThrow(id);
    if (post.status === "published") throw new Error("Опубликованный пост нельзя снять с планирования");
    post.status = post.approvedHash ? "approved" : "review";
    post.vkPostId = null;
    post.updatedAt = nowIso();
    for (const job of this.state.jobs) {
      if (job.type === "publication" && job.idempotencyKey?.includes(post.id) && ["queued", "running"].includes(job.status)) {
        job.status = "cancelled";
        job.error = reason || "отменено владельцем";
      }
    }
    this.logAudit("unschedule", "post", id, { reason });
    this.persist();
    return this.decorate(post);
  }

  async generateSlot(input: GenerateSlotInput): Promise<Post> {
    if (this.state.settings.automationPaused) throw new Error("Автоматизация на паузе");
    const post = this.generateForSlot({ ...input, force: input.force ?? true });
    this.persist();
    return this.decorate(post);
  }

  async prepareUpcoming(): Promise<{ queued: number }> {
    if (this.state.settings.automationPaused) throw new Error("Автоматизация на паузе");
    const specs = COMMUNITY_IDS.map((id) => ({
      communityId: id,
      schedule: normalizeSlots(this.state.communities[id]?.schedule ?? DEFAULT_SLOTS),
      active: this.state.communities[id]?.status === "active",
    }));

    const slots = upcomingSlots(specs, this.state.settings.prepareHoursAhead).slice(0, 12);
    let queued = 0;
    for (const slot of slots) {
      const exists = this.state.posts.some(
        (p) => p.communityId === slot.communityId && p.scheduledAt === slot.scheduledAt && p.status !== "rejected",
      );
      if (exists) continue;
      this.generateForSlot({ communityId: slot.communityId as CommunityId, scheduledAt: slot.scheduledAt });
      queued += 1;
    }
    this.logAudit("planner_enqueue", "generation_jobs", undefined, { queued, demo: true });
    this.persist();
    return { queued };
  }

  async runWorker(task: "tick" | "planner" | "publish_due" | "stats"): Promise<unknown> {
    // В демо-режиме «воркер» только отмечает прошедшие демонстрационные посты опубликованными.
    let marked = 0;
    for (const post of this.state.posts) {
      if (post.status !== "scheduled") continue;
      if (new Date(post.scheduledAt).getTime() > Date.now()) continue;
      post.status = "published";
      post.publishedAt = post.scheduledAt;
      post.testMode = true;
      if (!this.state.statistics[post.id]) {
        const rand = mulberry32(seedFrom(post.id));
        this.state.statistics[post.id] = {
          views: 400 + Math.floor(rand() * 2600),
          likes: 20 + Math.floor(rand() * 220),
          comments: 3 + Math.floor(rand() * 40),
          shares: 1 + Math.floor(rand() * 25),
        };
      }
      this.notify("published", "Пост «опубликован» (ДЕМО)", `${post.title || post.topic} — это имитация, VK не задействован.`, `/posts/${post.id}`);
      marked += 1;
    }
    this.persist();
    return { task, demo: true, markedPublished: marked, note: DEMO.note };
  }

  async jobs(): Promise<Job[]> {
    return this.state.jobs.slice(0, 80);
  }

  async setAutomationPaused(paused: boolean): Promise<void> {
    this.state.settings.automationPaused = paused;
    this.logAudit(paused ? "automation_pause" : "automation_resume");
    this.persist();
  }

  async calendar(from?: string, to?: string): Promise<CalendarPayload> {
    const specs = COMMUNITY_IDS.map((id) => ({
      communityId: id,
      schedule: normalizeSlots(this.state.communities[id]?.schedule ?? DEFAULT_SLOTS),
      active: this.state.communities[id]?.status === "active",
    }));

    const now = new Date();
    const fromIso = from ?? new Date(now.getTime() - 7 * 864e5).toISOString();
    const toIso = to ?? new Date(now.getTime() + 21 * 864e5).toISOString();

    // Ожидаемые слоты за весь видимый период — тем же алгоритмом, что и в локальном
    // API и в Supabase-режиме (иначе календарь показывал бы разные наборы слотов).
    const expected: CalendarPayload["expected"] = [];
    const start = moscowParts(new Date(fromIso));
    const end = moscowParts(new Date(toIso));
    let dateStr = start.dateStr;
    let guard = 0;
    while (guard++ < 400) {
      for (const spec of specs) {
        if (!spec.active) continue;
        for (const slot of spec.schedule) {
          const iso = moscowSlotIso(dateStr, slot);
          if (iso >= fromIso && iso <= toIso) {
            expected.push({ communityId: spec.communityId as CommunityId, scheduledAt: iso });
          }
        }
      }
      if (dateStr >= end.dateStr) break;
      dateStr = addDays(dateStr, 1);
    }
    expected.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

    const posts = this.state.posts
      .filter((p) => p.scheduledAt >= fromIso && p.scheduledAt <= toIso)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
      .map((p) => this.decorate(p));

    const taken = new Set(this.state.posts.filter((p) => p.status !== "rejected").map((p) => `${p.communityId}:${p.scheduledAt}`));
    const missed: CalendarPayload["missed"] = [];
    for (const dayOffset of [-2, -1, 0]) {
      const dateStr = addDays(moscowParts(now).dateStr, dayOffset);
      for (const spec of specs) {
        for (const slot of spec.schedule) {
          const iso = moscowSlotIso(dateStr, slot);
          if (new Date(iso).getTime() >= now.getTime()) continue;
          if (taken.has(`${spec.communityId}:${iso}`)) continue;
          missed.push({ communityId: spec.communityId as CommunityId, scheduledAt: iso });
        }
      }
    }

    return { posts, expected, missed, timezone: "Europe/Moscow" };
  }

  async characters(): Promise<Character[]> {
    return this.state.characters;
  }

  async updateCharacter(id: string, patch: Record<string, unknown>): Promise<Character> {
    const character = this.state.characters.find((c) => c.id === id);
    if (!character) throw new Error("Персонаж не найден");
    const wantsAppearance = patch.appearance !== undefined;
    if (wantsAppearance && character.locked && patch.unlockConfirmed !== true) {
      throw new Error("Внешность заблокирована. Снимите замок явным подтверждением, чтобы изменить.");
    }
    if (typeof patch.description === "string") character.description = patch.description;
    if (typeof patch.personality === "string") character.personality = patch.personality;
    if (typeof patch.name === "string") character.name = patch.name;
    if (typeof patch.locked === "boolean") character.locked = patch.locked;
    if (wantsAppearance) {
      character.appearance = patch.appearance as Character["appearance"];
      character.appearanceStatus = "placeholder";
      character.primaryReferenceId = null;
      character.references = character.references.map((r) => ({ ...r, approved: false, isPrimary: false }));
      this.notify("system", "Внешность изменена", "Подтверждение референсов сброшено — загрузите и подтвердите эталон заново.", "/characters");
    }
    character.updatedAt = nowIso();
    this.logAudit("character_update", "character", id, { appearanceChanged: wantsAppearance });
    this.persist();
    return character;
  }

  async uploadReference(characterId: string, file: File): Promise<void> {
    if (file.size > 12 * 1024 * 1024) throw new Error("Файл больше 12 МБ");
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
      reader.readAsDataURL(file);
    });

    const character = this.state.characters.find((c) => c.id === characterId);
    if (!character) throw new Error("Персонаж не найден");
    character.references.unshift({
      id: uid("ref"),
      characterId,
      filePath: dataUrl.slice(0, 64) + "…",
      url: dataUrl,
      approved: false,
      isPrimary: false,
      notes: "ДЕМО: файл хранится только в браузере и никуда не отправляется.",
      createdAt: nowIso(),
    });
    character.appearanceStatus = character.appearanceStatus === "approved" ? "approved" : "placeholder";
    this.logAudit("character_reference_add", "character", characterId, { demo: true });
    this.persist();
  }

  async approveReference(referenceId: string): Promise<void> {
    for (const character of this.state.characters) {
      const reference = character.references.find((r) => r.id === referenceId);
      if (!reference) continue;
      reference.approved = true;
      if (!character.references.some((r) => r.isPrimary)) {
        reference.isPrimary = true;
        character.primaryReferenceId = reference.id;
        character.appearanceStatus = "approved";
      }
      this.logAudit("character_reference_approve", "character", character.id, { referenceId });
      this.persist();
      return;
    }
    throw new Error("Референс не найден");
  }

  async setPrimaryReference(referenceId: string): Promise<void> {
    for (const character of this.state.characters) {
      const reference = character.references.find((r) => r.id === referenceId);
      if (!reference) continue;
      if (!reference.approved) throw new Error("Основным можно сделать только подтверждённый референс");
      for (const other of character.references) other.isPrimary = false;
      reference.isPrimary = true;
      character.primaryReferenceId = reference.id;
      character.appearanceStatus = "approved";
      this.logAudit("character_reference_primary", "character", character.id, { referenceId });
      this.persist();
      return;
    }
    throw new Error("Референс не найден");
  }

  async deleteReference(referenceId: string): Promise<void> {
    for (const character of this.state.characters) {
      if (!character.references.some((r) => r.id === referenceId)) continue;
      character.references = character.references.filter((r) => r.id !== referenceId);
      if (character.primaryReferenceId === referenceId) {
        character.primaryReferenceId = null;
        character.appearanceStatus = character.appearanceStatus === "approved" ? "placeholder" : character.appearanceStatus;
      }
      this.logAudit("character_reference_delete", "character", character.id, { referenceId });
      this.persist();
      return;
    }
    throw new Error("Референс не найден");
  }

  async analytics(): Promise<AnalyticsPayload> {
    const published = this.state.posts.filter((p) => p.status === "published");
    const points = published.map((post) => {
      const stats = this.state.statistics[post.id] ?? { views: 0, likes: 0, comments: 0, shares: 0 };
      return {
        date: post.publishedAt ?? post.scheduledAt,
        communityId: post.communityId,
        views: stats.views,
        likes: stats.likes,
        comments: stats.comments,
        shares: stats.shares,
        source: "demo",
      };
    });

    const best = published
      .map((post) => {
        const stats = this.state.statistics[post.id] ?? { views: 0, likes: 0, comments: 0, shares: 0 };
        return {
          postId: post.id,
          title: post.title || post.topic,
          communityId: post.communityId,
          views: stats.views,
          score: stats.views + stats.likes * 3 + stats.comments * 5 + stats.shares * 4,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    return {
      points,
      published,
      best,
      testMode: true,
      insufficientData: published.length < 12,
      thresholds: { postsForConclusions: 12 },
      note:
        "ДЕМО-РЕЖИМ: числа сгенерированы детерминированно для демонстрации интерфейса. " +
        "Это не статистика VK и не результат анализа конкурентов. Реальные данные появятся после подключения VK API.",
    };
  }

  async importAnalytics(): Promise<{ imported: number }> {
    throw new Error(
      "ДЕМО-РЕЖИМ: импорт аналитики доступен в облачном режиме (Supabase). Файл аналитики владельца загружается там.",
    );
  }

  async settings(): Promise<ApplicationSettings> {
    return {
      ...this.state.settings,
      mode: "test",
      realPublishEnabled: false,
      demoMode: true,
      spendUsdMonth: 0,
    };
  }

  async saveSettings(patch: Record<string, unknown>): Promise<ApplicationSettings> {
    if (patch.mode === "approval") {
      throw new Error("ДЕМО-РЕЖИМ: переключение в режим реальных публикаций недоступно. Нужен подключённый Supabase и VK-токены.");
    }
    if (patch.realPublishEnabled === true) {
      throw new Error("ДЕМО-РЕЖИМ: реальные публикации VK включить нельзя.");
    }
    if (typeof patch.automationPaused === "boolean") this.state.settings.automationPaused = patch.automationPaused;
    if (typeof patch.prepareHoursAhead === "number") {
      this.state.settings.prepareHoursAhead = Math.max(1, Math.min(720, patch.prepareHoursAhead));
    }
    if (typeof patch.aiMonthlyLimitUsd === "number") {
      this.state.settings.aiMonthlyLimitUsd = Math.max(0, patch.aiMonthlyLimitUsd);
    }
    if (typeof patch.notificationsEnabled === "boolean") this.state.settings.notificationsEnabled = patch.notificationsEnabled;
    this.logAudit("settings_update", undefined, undefined, patch);
    this.persist();
    return this.settings();
  }

  async saveAiKey(key: string | null): Promise<{ hasKey: boolean }> {
    if (key) {
      throw new Error(
        "ДЕМО-РЕЖИМ: ключи AI не принимаются и не сохраняются в браузере. Ключ задаётся только в серверных секретах Supabase.",
      );
    }
    return { hasKey: false };
  }

  async testAi(): Promise<{ ok: boolean; sample?: string; error?: string; provider?: string; demo?: boolean; limitations?: string[] }> {
    const idea = generateIdeas("stories", [], uid("demo"), 1)[0];
    return {
      ok: true,
      sample: generateText("stories", idea, uid("demo")).slice(0, 280),
      provider: "test",
      demo: true,
      limitations: [
        "Ключ AI не задан: это детерминированный демонстрационный текст, а не ответ языковой модели.",
        "Платные вызовы в демо-режиме запрещены.",
      ],
    };
  }

  async providers(): Promise<AiProvidersPayload> {
    return {
      active: "test",
      label: "Тестовый движок (ДЕМО-РЕЖИМ)",
      supportsReferences: false,
      supportsIdentityLock: false,
      configuredKey: false,
      demo: true,
      models: { text: "test-writer-v1", image: "test-illustrator-v1" },
      limitations: [
        "Демонстрационный контент: детерминированный движок, а не языковая модель.",
        "Сохранение внешности персонажа не гарантируется ни одним доступным сейчас провайдером.",
      ],
    };
  }

  async aiHistory(): Promise<AiGenerationRecord[]> {
    return this.state.generations.slice(0, 80);
  }

  async ideas(communityId: string, count = 6): Promise<Idea[]> {
    const used = this.state.posts.filter((p) => p.communityId === communityId).map((p) => p.topic);
    return generateIdeas(communityId as CommunityId, used, uid("idea"), count);
  }

  async notifications(): Promise<{ items: NotificationItem[]; unread: number }> {
    return {
      items: this.state.notifications.slice(0, 80),
      unread: this.state.notifications.filter((n) => !n.read).length,
    };
  }

  async markNotificationsRead(id?: string): Promise<void> {
    for (const item of this.state.notifications) {
      if (!id || item.id === id) item.read = true;
    }
    this.persist();
  }

  async audit(): Promise<AuditEntry[]> {
    return this.state.audit.slice(0, 200);
  }

  async uploadMedia(
    file: File,
    folder: "posts" | "characters" | "communities" | "generated" | "archive",
  ): Promise<UploadResult> {
    if (file.size > 12 * 1024 * 1024) throw new Error("Файл больше 12 МБ");
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
      reader.readAsDataURL(file);
    });
    const path = `demo://${folder}/${uid("f")}`;
    this.logAudit("media_upload", "media", path, { demo: true });
    this.persist();
    return { path, url: dataUrl, mime: file.type || "image/png", sizeBytes: file.size, bucket: "demo" };
  }

  subscribe(listener: (topic: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export class DemoPostStorage {
  static readonly key = DEMO.storageKey;
}
