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

export const DEFAULT_SLOTS = ["13:30", "17:30", "21:30"] as const;
export const MOSCOW_TZ = "Europe/Moscow";

export type AppMode = "test" | "approval";

export type AiProviderId = "test" | "openai" | "compatible";

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
  vkConnected: boolean;
  schedule: string[];
  styleRules: StyleRules;
  generationSettings: GenerationSettings;
  status: "active" | "paused";
  createdAt: string;
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

export interface Character {
  id: string;
  communityId: CommunityId;
  name: string;
  role: string;
  description: string;
  appearance: AppearanceLock;
  personality: string;
  locked: boolean;
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
  filePath: string;
  approved: boolean;
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
  imagePrompt: string;
  topic: string;
  idea: string;
  vkPostId: string | null;
  contentHash: string;
  approvedHash: string | null;
  approvedAt: string | null;
  approvedBy: number | null;
  errorMessage: string | null;
  generationMeta: GenerationMeta | null;
  similarityScore: number | null;
  similarTo: string | null;
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
  createdBy: number | null;
  reason: string;
}

export interface Approval {
  id: string;
  postId: string;
  versionHash: string;
  action: "approve" | "reject" | "revise";
  comment: string;
  userId: number;
  createdAt: string;
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

export interface DashboardStats {
  ready: number;
  pendingReview: number;
  scheduled: number;
  published: number;
  errors: number;
  missedSlots: number;
  automationPaused: boolean;
  mode: AppMode;
  nextPosts: Post[];
  byCommunity: Array<{
    id: CommunityId;
    name: string;
    pending: number;
    scheduled: number;
    published: number;
    errors: number;
  }>;
  spendUsdMonth: number;
  spendLimitUsd: number;
}

export interface AnalyticsPoint {
  date: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

export interface UserPublic {
  id: number;
  email: string;
  name: string;
  role: string;
}

export interface SettingsPublic {
  mode: AppMode;
  automationPaused: boolean;
  timezone: typeof MOSCOW_TZ;
  prepareHoursAhead: number;
  aiMonthlyLimitUsd: number;
  spendUsdMonth: number;
  vkConfigured: boolean;
  aiConfigured: boolean;
  aiProvider: AiProviderId;
  aiTextModel: string;
  aiImageModel: string;
  aiBaseUrl: string;
  notificationsEnabled: boolean;
  telegramConfigured: boolean;
  backupLastAt: string | null;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

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
