/**
 * Хранилище секретов на сервере.
 * Таблицы community_secrets / integration_secrets не имеют политик RLS:
 * читать их может только service role (Edge Function), браузер — никогда.
 */
import { admin } from "./db.ts";
import { decryptSecret, encryptSecret, maskSecret } from "./crypto.ts";
import { AI_API_KEY } from "./env.ts";

export async function saveCommunityToken(
  communityId: string,
  token: string | null,
  hint = "",
): Promise<void> {
  if (!token) {
    await admin().from("community_secrets").delete().eq("community_id", communityId);
    await admin().from("communities").update({ vk_connected: false, vk_verified_at: null }).eq("id", communityId);
    return;
  }
  const encrypted = await encryptSecret(token);
  const { error } = await admin().from("community_secrets").upsert({
    community_id: communityId,
    vk_token_enc: encrypted,
    vk_token_hint: hint || maskSecret(token),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Не удалось сохранить VK-токен: ${error.message}`);
}

export async function readCommunityToken(communityId: string): Promise<string | null> {
  const { data, error } = await admin()
    .from("community_secrets")
    .select("vk_token_enc")
    .eq("community_id", communityId)
    .maybeSingle();
  if (error || !data?.vk_token_enc) return null;
  try {
    return await decryptSecret(String(data.vk_token_enc));
  } catch {
    return null;
  }
}

export async function saveAiKey(plain: string | null): Promise<void> {
  if (!plain) {
    await admin().from("integration_secrets").delete().eq("key", "ai_api_key");
    return;
  }
  const encrypted = await encryptSecret(plain);
  const { error } = await admin().from("integration_secrets").upsert({
    key: "ai_api_key",
    value_enc: encrypted,
    hint: maskSecret(plain),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Не удалось сохранить AI-ключ: ${error.message}`);
}

/** Ключ AI: сначала серверный секрет функции, затем значение из БД. */
export async function readAiKey(): Promise<string | null> {
  if (AI_API_KEY) return AI_API_KEY;
  const { data } = await admin()
    .from("integration_secrets")
    .select("value_enc")
    .eq("key", "ai_api_key")
    .maybeSingle();
  if (!data?.value_enc) return null;
  try {
    return await decryptSecret(String(data.value_enc));
  } catch {
    return null;
  }
}

export async function aiKeyHint(): Promise<{ hasKey: boolean; hint: string }> {
  const fromDb = await admin()
    .from("integration_secrets")
    .select("hint")
    .eq("key", "ai_api_key")
    .maybeSingle();
  const hasKey = Boolean(AI_API_KEY) || Boolean(fromDb.data?.hint);
  return { hasKey, hint: AI_API_KEY ? "ключ в окружении функции" : String(fromDb.data?.hint ?? "") };
}
