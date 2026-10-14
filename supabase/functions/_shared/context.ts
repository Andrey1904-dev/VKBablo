/**
 * Контекст сообщества для генерации: правила (версионированные), персонажи,
 * последние тексты (для проверки повторов) и честные ограничения провайдера.
 */
import { admin } from "./db.ts";
import { describeAdapter } from "./ai.ts";
import type { CommunityId } from "./core/types.ts";

export interface CommunityContext {
  communityId: CommunityId;
  name: string;
  rules: {
    theme: string;
    textStyle: string;
    audience: string;
    forbidden: string[];
    preferredTopics: string[];
    unwantedTopics: string[];
    imageRules: string;
    characterRules: string;
    analyticsNotes: string;
    version: number;
  } | null;
  characters: Array<{
    id: string;
    name: string;
    appearanceStatus: string;
    primaryReferenceId: string | null;
    appearance: Record<string, unknown>;
  }>;
  limitations: string[];
  adapterCanUseReferences: boolean;
  providerId: string;
  demo: boolean;
}

export async function loadCommunityContext(communityId: CommunityId): Promise<CommunityContext> {
  const adapter = await describeAdapter();

  const [{ data: community }, { data: rules }, { data: characters }] = await Promise.all([
    admin().from("communities").select("id, name").eq("id", communityId).maybeSingle(),
    admin()
      .from("community_rules")
      .select(
        "theme, text_style, audience, forbidden, preferred_topics, unwanted_topics, image_rules, character_rules, analytics_notes, version",
      )
      .eq("community_id", communityId)
      .maybeSingle(),
    admin()
      .from("characters")
      .select("id, name, appearance_status, primary_reference_id, appearance")
      .eq("community_id", communityId),
  ]);

  return {
    communityId,
    name: String(community?.name ?? communityId),
    rules: rules
      ? {
          theme: String(rules.theme ?? ""),
          textStyle: String(rules.text_style ?? ""),
          audience: String(rules.audience ?? ""),
          forbidden: (rules.forbidden ?? []) as string[],
          preferredTopics: (rules.preferred_topics ?? []) as string[],
          unwantedTopics: (rules.unwanted_topics ?? []) as string[],
          imageRules: String(rules.image_rules ?? ""),
          characterRules: String(rules.character_rules ?? ""),
          analyticsNotes: String(rules.analytics_notes ?? ""),
          version: Number(rules.version ?? 1),
        }
      : null,
    characters: (characters ?? []).map((row: Record<string, unknown>) => ({
      id: String(row.id),
      name: String(row.name ?? ""),
      appearanceStatus: String(row.appearance_status ?? "placeholder"),
      primaryReferenceId: (row.primary_reference_id as string | null) ?? null,
      appearance: (row.appearance as Record<string, unknown>) ?? {},
    })),
    limitations: adapter.limitations,
    adapterCanUseReferences: adapter.supportsReferences,
    providerId: adapter.id,
    demo: adapter.demo,
  };
}

export async function loadRecentTexts(
  communityId: string,
  excludePostId?: string | null,
  limit = 60,
): Promise<Array<{ id: string; text: string }>> {
  const { data } = await admin()
    .from("posts")
    .select("id, text")
    .eq("community_id", communityId)
    .neq("status", "rejected")
    .order("scheduled_at", { ascending: false })
    .limit(limit);

  return (data ?? [])
    .filter((row: { id: string; text: string | null }) => row.id !== excludePostId && (row.text ?? "").trim().length > 0)
    .map((row: { id: string; text: string | null }) => ({ id: row.id, text: String(row.text ?? "") }));
}
