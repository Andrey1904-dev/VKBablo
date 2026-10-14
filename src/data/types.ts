/**
 * Единый интерфейс слоя данных.
 *
 * Три реализации:
 *   • supabase — production: Auth + RLS-чтение + RPC/Edge Functions для изменений;
 *   • local    — локальный стенд разработки (Node API, /api/*);
 *   • demo     — полностью автономный режим в браузере для GitHub Pages без ключей.
 *
 * Инварианты (одобрение, сброс одобрения, запрет реальной публикации в демо)
 * реализованы на сервере для supabase и продублированы в demo/local для UX.
 */
import type {
  AiGenerationRecord,
  AiProvidersPayload,
  AnalyticsPayload,
  ApplicationSettings,
  AuditEntry,
  AuthStatus,
  BackendInfo,
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
  Schedule,
  UploadResult,
  UserPublic,
} from "@shared/types";
import type { Idea } from "@shared/content-engine";

export interface CommunityDetail {
  community: Community;
  characters: Character[];
  rules: CommunityRuleSet | null;
  schedule: Schedule | null;
  stats: Record<string, number>;
}

export interface VkConnectResult {
  connected: boolean;
  verified: boolean;
  groupName?: string;
  warning?: string;
  testMode?: boolean;
}

export interface GenerateSlotInput {
  communityId: Community["id"];
  scheduledAt: string;
  kind?: "full_post" | "text" | "image" | "idea" | "preview";
  force?: boolean;
  prompt?: string;
}

export interface Backend {
  readonly info: BackendInfo;

  auth: {
    status(): Promise<AuthStatus>;
    signIn(email: string, password: string): Promise<UserPublic>;
    createOwner(email: string, password: string, name: string): Promise<UserPublic>;
    signOut(): Promise<void>;
    /** Подписка на изменение сессии (для Realtime-токена в Supabase). */
    onChange(listener: () => void): () => void;
  };

  dashboard(): Promise<DashboardData>;
  integrations(): Promise<IntegrationStatus[]>;

  communities(): Promise<Community[]>;
  community(id: string): Promise<CommunityDetail>;
  updateCommunity(id: string, patch: Record<string, unknown>): Promise<Community>;
  saveCommunityRules(id: string, rules: Partial<CommunityRuleSet>, changeNote: string): Promise<{ version: number }>;
  connectVk(id: string, token: string, groupId: string): Promise<VkConnectResult>;
  checkVk(id: string): Promise<{ ok: boolean; groupName?: string; error?: string }>;

  posts(filters: PostFilters): Promise<Post[]>;
  post(id: string): Promise<PostDetailPayload>;
  createPost(input: { communityId: string; scheduledAt: string; title?: string; text?: string }): Promise<Post>;
  editPost(id: string, patch: { text?: string; imagePath?: string | null; scheduledAt?: string; title?: string }): Promise<Post>;
  approvePost(id: string, comment?: string): Promise<Post>;
  rejectPost(id: string, comment?: string): Promise<Post>;
  revisePost(id: string, what: "text" | "image" | "all", comment?: string): Promise<Post>;
  regeneratePost(id: string, what: "text" | "image" | "all"): Promise<Post>;
  schedulePost(id: string): Promise<{ post: Post; dryRun: boolean }>;
  unschedulePost(id: string, reason?: string): Promise<Post>;
  generateSlot(input: GenerateSlotInput): Promise<Post>;
  prepareUpcoming(): Promise<{ queued: number }>;
  runWorker(task: "tick" | "planner" | "publish_due" | "stats"): Promise<unknown>;
  jobs(): Promise<Job[]>;
  setAutomationPaused(paused: boolean): Promise<void>;

  calendar(from?: string, to?: string): Promise<CalendarPayload>;

  characters(): Promise<Character[]>;
  updateCharacter(id: string, patch: Record<string, unknown>): Promise<Character>;
  uploadReference(characterId: string, file: File, notes: string): Promise<void>;
  approveReference(referenceId: string): Promise<void>;
  setPrimaryReference(referenceId: string): Promise<void>;
  deleteReference(referenceId: string): Promise<void>;

  analytics(): Promise<AnalyticsPayload>;
  importAnalytics(rows: Array<Record<string, unknown>>, note: string): Promise<{ imported: number }>;

  settings(): Promise<ApplicationSettings>;
  saveSettings(patch: Record<string, unknown>): Promise<ApplicationSettings>;
  saveAiKey(key: string | null): Promise<{ hasKey: boolean }>;
  testAi(): Promise<{ ok: boolean; sample?: string; error?: string; provider?: string; demo?: boolean; limitations?: string[] }>;
  providers(): Promise<AiProvidersPayload>;
  aiHistory(): Promise<AiGenerationRecord[]>;
  ideas(communityId: string, count?: number): Promise<Idea[]>;

  notifications(): Promise<{ items: NotificationItem[]; unread: number }>;
  markNotificationsRead(id?: string): Promise<void>;
  audit(): Promise<AuditEntry[]>;

  uploadMedia(file: File, folder: "posts" | "characters" | "communities" | "generated" | "archive", context?: {
    postId?: string;
    characterId?: string;
    communityId?: string;
  }): Promise<UploadResult>;

  /** Подписка на изменения (Realtime в Supabase, события хранилища в демо). */
  subscribe(listener: (topic: string) => void): () => void;
}

export function backendInfoFor(
  kind: "supabase" | "local" | "demo",
  supabaseUrl: string | null,
  hasAnonKey: boolean,
  functionsUrl: string | null,
): BackendInfo {
  if (kind === "supabase") {
    return {
      kind,
      label: "Supabase",
      demo: false,
      realPublishPossible: true,
      supabaseUrl,
      hasAnonKey,
      functionsUrl,
      note: "Данные в PostgreSQL, доступ по RLS, изменения — через RPC и Edge Functions.",
    };
  }

  if (kind === "local") {
    return {
      kind,
      label: "Локальный стенд",
      demo: true,
      realPublishPossible: false,
      supabaseUrl,
      hasAnonKey,
      functionsUrl,
      note: "Локальный API для разработки. Реальные публикации VK невозможны, статистика помечена как демонстрационная.",
    };
  }

  return {
    kind: "demo",
    label: "ДЕМО-РЕЖИМ",
    demo: true,
    realPublishPossible: false,
    supabaseUrl,
    hasAnonKey,
    functionsUrl,
    note:
      "Демонстрационные данные в браузере. Публикация в VK технически невозможна, платные API не вызываются. " +
      "Подключите Supabase (CODEX_SETUP.md), чтобы работать с реальными данными.",
  };
}
