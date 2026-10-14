/**
 * Референсы персонажей (§7 ТЗ).
 * Используем ТОЛЬКО подтверждённые владельцем файлы. Пока референс не утверждён,
 * генерация честно сообщает ограничение, а не «рисует похожее».
 */
import { admin } from "./db.ts";
import { signedUrl } from "./storage.ts";

export interface CharacterRef {
  characterId: string;
  name: string;
  referenceId: string;
  signedUrl: string;
  approved: boolean;
}

export async function resolveReferences(
  characters: Array<{ id: string; name: string; appearanceStatus: string; primaryReferenceId: string | null }>,
): Promise<string[]> {
  const urls: string[] = [];

  for (const character of characters) {
    const reference = await primaryReferenceFor(character.id, character.primaryReferenceId);
    if (!reference) continue;
    const url = await signedUrl(reference.storage_path, 1800);
    if (url) urls.push(url);
  }

  return urls;
}

export async function primaryReferenceFor(
  characterId: string,
  primaryReferenceId?: string | null,
): Promise<{ id: string; storage_path: string; approved: boolean } | null> {
  if (primaryReferenceId) {
    const { data } = await admin()
      .from("character_references")
      .select("id, storage_path, approved")
      .eq("id", primaryReferenceId)
      .maybeSingle();
    if (data?.approved) return data as { id: string; storage_path: string; approved: boolean };
  }

  const { data } = await admin()
    .from("character_references")
    .select("id, storage_path, approved")
    .eq("character_id", characterId)
    .eq("approved", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as { id: string; storage_path: string; approved: boolean } | null) ?? null;
}

/** Отчёт о готовности референсов — показывается владельцу в разделе «Персонажи». */
export async function referencesReadiness(): Promise<
  Array<{ characterId: string; name: string; approvedRefs: number; status: string }>
> {
  const { data: characters } = await admin().from("characters").select("id, name, appearance_status");
  const out: Array<{ characterId: string; name: string; approvedRefs: number; status: string }> = [];

  for (const character of characters ?? []) {
    const { count } = await admin()
      .from("character_references")
      .select("id", { count: "exact", head: true })
      .eq("character_id", character.id)
      .eq("approved", true);
    out.push({
      characterId: String(character.id),
      name: String(character.name ?? ""),
      approvedRefs: count ?? 0,
      status: String(character.appearance_status ?? "placeholder"),
    });
  }

  return out;
}
