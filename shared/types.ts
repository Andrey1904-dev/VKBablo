/**
 * Общая модель данных VK AI Manager.
 * Используется frontend, Edge Functions и локальным стендом.
 */
export const POST_STATUSES = [
  "draft",
  "generating",
  "review",
  "needs_revision",
  "approved",
  "scheduled",
  "published",
  "error",
  "rejected",
] as const;

export type PostStatus = (typeof POST_STATUSES)[number];

export const STATUS_LABELS: Record<PostStatus, string> = {
  draft: "Черновик",
  generating: "Генерируется",
  review: "На проверке",
  needs_revision: "Требует доработки",
  approved: "Одобрен",
  scheduled: "Запланирован",
  published: "Опубликован",
  error: "Ошибка",
  rejected: "Отклонён",
};

export const COMMUNITY_IDS = ["stories", "milana", "life", "veronica"] as const;
export type CommunityId = (typeof COMMUNITY_IDS)[number];

export { MOSCOW_TZ, DEFAULT_SLOTS } from "./moscow.ts";

export type AppMode = "test" | "approval";

export type AiProviderId = "test" | "openai" | "compatible" | "custom";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export const JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "done", "failed", "cancelled"];

export type GenerationJobKind = "idea" | "text" | "image" | "full_post" | "regenerate" | "preview";

export interface Community {
  id: CommunityId;
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  theme: string;
  color: string;
  avatarUrl: string;
  vkGroupId: string | null;
  vkScreenName: string | null;
  /** true только если проверенный токен реально сохранён (в тестовом режиме всегда false). */
  vkConnected: boolean;
  schedule: string[];
  styleRules: StyleRules;
  generationSettings: GenerationSettings;
  status: "active" | "paused";
  automationEnabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface StyleRules {
  voice: string;
  hook: string;
  language: string;
  mustInclude: string[];
  mustAvoid: string[];
  ending: string;
  notes: string[];
  seriesAllowed: boolean;
  firstPerson?: boolean;
  characterNames: string[];
  forbiddenFacts: string[];
}

export interface GenerationSettings {
  textProvider: AiProviderId;
  textModel: string;
  imageProvider: AiProviderId;
  imageModel: string;
  temperature: number;
  maxTokens: number;
  imageSize: string;
  useReferences: boolean;
  prepareHoursAhead: number;
}

/** Долговременная память сообщества (ТЗ §6). Версионируется в community_rule_versions. */
export interface CommunityRuleSet {
  communityId: CommunityId;
  version: number;
  theme: string;
  textStyle: string;
  audience: string;
  forbidden: string[];
  preferredTopics: string[];
  unwantedTopics: string[];
  successfulExamples: string[];
  imageRules: string;
  characterRules: string;
  analyticsNotes: string;
  sources: string[];
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface CommunityRuleVersion {
  id: string;
  communityId: CommunityId;
  version: number;
  rules: CommunityRuleSet;
  changeNote: string;
  createdAt: string;
  createdBy: string | null;
}

export interface Schedule {
  id: string;
  communityId: CommunityId;
  slots: string[];
  timezone: string;
  daysOfWeek: number[];
  paused: boolean;
  skipUntil: string | null;
  note: string;
}

export interface Character {
  id: string;
  communityId: CommunityId;
  name: string;
  role: string;
  description: string;
  appearance: AppearanceLock;
  personality: string;
  locked: boolean;
  /** placeholder — черновое описание, approved — владелец утвердил и загрузил референсы. */
  appearanceStatus: "placeholder" | "approved";
  primaryReferenceId: string | null;
  references: CharacterReference[];
  createdAt: string;
  updatedAt: string;
}

export interface AppearanceLock {
  age?: string;
  hair?: string;
  eyes?: string;
  face?: string;
  body?: string;
  style?: string;
  distinctive: string[];
  neverChange: string[];
}

export interface CharacterReference {
  id: string;
  characterId: string;
  /** Путь в Storage (bucket media, префикс characters/) или локальный путь /uploads/... */
  filePath: string;
  /** Готовая ссылка для просмотра (signed URL или локальный путь). */
  url?: string | null;
  approved: boolean;
  isPrimary: boolean;
  notes: string;
  createdAt: string;
}

export interface Post {
  id: string;
  communityId: CommunityId;
  status: PostStatus;
  scheduledAt: string;
  publishedAt: string | null;
  title: string;
  text: string;
  imagePath: string | null;
  imageUrl?: string | null;
  imagePrompt: string;
  topic: string;
  idea: string;
  vkPostId: string | null;
  contentHash: string;
  approvedHash: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  errorMessage: string | null;
  generationMeta: GenerationMeta | null;
  similarityScore: number | null;
  similarTo: string | null;
  /** true — публикация никогда не уйдёт в VK (демо/dry-run/mock). */
  testMode: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationMeta {
  provider: string;
  model: string;
  imageProvider?: string;
  imageModel?: string;
  costUsd: number;
  ideaSource: string;
  warnings: string[];
  /** Честные ограничения выбранного провайдера (например, отсутствие identity-lock). */
  providerLimitations?: string[];
  demo?: boolean;
}

export interface PostVersion {
  id: string;
  postId: string;
  version: number;
  text: string;
  imagePath: string | null;
  imagePrompt: string;
  contentHash: string;
  createdAt: string;
  createdBy: string | null;
  reason: string;
}

export interface Approval {
  id: string;
  postId: string;
  versionHash: string;
  action: "approve" | "reject" | "revise";
  comment: string;
  userId: string;
  createdAt: string;
}

export interface MediaAsset {
  id: string;
  communityId: CommunityId | null;
  postId: string | null;
  characterId: string | null;
  bucket: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  kind: "post_image" | "character_reference" | "community_logo" | "generated" | "archive";
  createdAt: string;
  createdBy: string | null;
}

export interface AiProviderConfig {
  id: string;
  name: AiProviderId | string;
  kind: "text" | "image" | "both";
  baseUrl: string;
  textModel: string;
  imageModel: string;
  supportsReferences: boolean;
  supportsIdentityLock: boolean;
  enabled: boolean;
  pricePerImageUsd: number;
  pricePer1kTokensUsd: number;
  notes: string;
  /** Ключ никогда не возвращается наружу — только факт наличия. */
  hasKey: boolean;
}

export interface AiPromptTemplate {
  id: string;
  communityId: CommunityId | null;
  kind: "idea" | "text" | "image" | "revise" | "quality";
  version: number;
  name: string;
  template: string;
  active: boolean;
  createdAt: string;
}

export interface PostStatistics {
  id: string;
  postId: string;
  communityId: CommunityId;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  collectedAt: string;
  source: "vk" | "manual" | "demo";
}

export interface AnalyticsSnapshot {
  id: string;
  communityId: CommunityId | null;
  periodStart: string;
  periodEnd: string;
  totals: { views: number; likes: number; comments: number; shares: number; published: number };
  note: string;
  createdAt: string;
}

export interface AnalyticsPoint {
  date: string;
  communityId?: CommunityId;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  source?: string;
}

export interface AnalyticsPayload {
  points: AnalyticsPoint[];
  published: Post[];
  /** Топ по вовлечённости среди опубликованных. */
  best: Array<{ postId: string; title: string; communityId: CommunityId; score: number; views: number }>;
  note: string;
  testMode: boolean;
  /** Честно: данных мало для выводов. */
  insufficientData: boolean;
  thresholds: { postsForConclusions: number };
}

export interface IntegrationStatus {
  id: string;
  key: "supabase" | "github_pages" | "vk" | "ai_text" | "ai_image" | "cron" | "storage" | "realtime";
  label: string;
  configured: boolean;
  /** Проверено реальным вызовом в этой сессии, а не только наличием ключа. */
  verified: boolean;
  status: "off" | "configured" | "verified" | "error" | "demo";
  detail: string;
  checkedAt: string | null;
}

export interface ApplicationSettings {
  mode: AppMode;
  automationPaused: boolean;
  /** Глобальный предохранитель: реальные публикации VK разрешены. По умолчанию false. */
  realPublishEnabled: boolean;
  timezone: string;
  prepareHoursAhead: number;
  aiMonthlyLimitUsd: number;
  spendUsdMonth: number;
  aiProvider: AiProviderId;
  aiTextModel: string;
  aiImageModel: string;
  aiBaseUrl: string;
  notificationsEnabled: boolean;
  demoMode: boolean;
  updatedAt?: string;
}

export interface NotificationItem {
  id: string;
  type:
    | "review"
    | "generation_error"
    | "publish_error"
    | "scheduled"
    | "published"
    | "missed_slot"
    | "vk_connection"
    | "system";
  title: string;
  message: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}

export interface DashboardData {
  ready: number;
  pendingReview: number;
  scheduled: number;
  published: number;
  errors: number;
  missedSlots: number;
  automationPaused: boolean;
  mode: AppMode;
  realPublishEnabled: boolean;
  nextPosts: Post[];
  byCommunity: Array<{
    id: CommunityId;
    name: string;
    color: string;
    pending: number;
    scheduled: number;
    published: number;
    errors: number;
  }>;
  spendUsdMonth: number;
  spendLimitUsd: number;
  unread: number;
  jobs: Job[];
  integrations: IntegrationStatus[];
  backend: BackendInfo;
  moscow: { dateStr: string; timeStr: string; weekday: number };
}

export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  error: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  userId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  details: unknown;
  ip: string | null;
  result?: string | null;
  createdAt: string;
}

export interface CalendarPayload {
  posts: Post[];
  expected: Array<{ communityId: CommunityId; scheduledAt: string }>;
  missed: Array<{ communityId: CommunityId; scheduledAt: string }>;
  timezone: string;
}

export interface PostDetailPayload {
  post: Post;
  versions: PostVersion[];
  approvals: Approval[];
  community: Community | null;
  imageUrl: string | null;
}

export interface AiGenerationRecord {
  id: string;
  communityId: CommunityId | null;
  type: string;
  provider: string;
  model: string;
  prompt: string;
  result: string;
  costUsd: number;
  status: string;
  error: string | null;
  createdAt: string;
}

export interface AiProvidersPayload {
  active: AiProviderId;
  label: string;
  supportsReferences: boolean;
  supportsIdentityLock: boolean;
  configuredKey: boolean;
  demo: boolean;
  models: { text: string; image: string };
  limitations: string[];
}

export interface UserPublic {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface AuthStatus {
  setupComplete: boolean;
  user: UserPublic | null;
  backend: BackendInfo;
  /** Куда владельцу нужно смотреть при подключении (без секретов). */
  hints: string[];
}

export type BackendKind = "supabase" | "local" | "demo";

export interface BackendInfo {
  kind: BackendKind;
  label: string;
  /** true — данные демонстрационные, публикация в VK невозможна в принципе. */
  demo: boolean;
  realPublishPossible: boolean;
  supabaseUrl: string | null;
  hasAnonKey: boolean;
  functionsUrl: string | null;
  note: string;
}

export interface PostFilters {
  communityId?: CommunityId | "";
  status?: PostStatus | "";
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface UploadResult {
  path: string;
  url: string | null;
  mime: string;
  sizeBytes: number;
  bucket: string;
}

export interface ApiErrorShape {
  error: string;
  code?: string;
}
