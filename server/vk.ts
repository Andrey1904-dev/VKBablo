import { get, run, setSetting, setting } from "./db.ts";
import { decrypt, encrypt, nowIso } from "./lib.ts";
import type { CommunityId } from "../shared/types.ts";

export interface VkAdapter {
  testMode: boolean;
  checkToken(token: string): Promise<{ ok: boolean; name?: string; error?: string }>;
  uploadAndSchedule(input: {
    communityId: CommunityId;
    groupId: string;
    token: string;
    text: string;
    imagePath: string | null;
    publishAtUnix: number;
  }): Promise<{ postId: string; raw?: unknown }>;
  fetchStats(input: {
    groupId: string;
    token: string;
    postId: string;
  }): Promise<{ views: number; likes: number; comments: number; shares: number } | null>;
}

function testVk(): VkAdapter {
  return {
    testMode: true,
    async checkToken() {
      return { ok: true, name: "Тестовое сообщество" };
    },
    async uploadAndSchedule(input) {
      return { postId: `test_${input.communityId}_${input.publishAtUnix}` };
    },
    async fetchStats() {
      return null;
    },
  };
}

async function vkApi(method: string, token: string, params: Record<string, string | number>) {
  const body = new URLSearchParams({
    access_token: token,
    v: "5.199",
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  const res = await fetch(`https://api.vk.com/method/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const data = (await res.json()) as { response?: unknown; error?: { error_msg?: string; error_code?: number } };
  if (data.error) {
    throw new Error(`VK API: ${data.error.error_msg || data.error.error_code}`);
  }
  return data.response;
}

function liveVk(): VkAdapter {
  return {
    testMode: false,
    async checkToken(token) {
      try {
        const r = (await vkApi("groups.getById", token, {})) as Array<{ name?: string }> | { groups?: Array<{ name?: string }> };
        const groups = Array.isArray(r) ? r : r.groups ?? [];
        return { ok: true, name: groups[0]?.name };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async uploadAndSchedule(input) {
      if (input.imagePath?.endsWith(".svg")) {
        throw new Error(
          "VK не принимает SVG. Загрузите PNG/JPEG или подключите AI-провайдер изображений, который возвращает растр.",
        );
      }
      const ownerId = input.groupId.startsWith("-") ? input.groupId : `-${input.groupId}`;
      let attachments = "";
      if (input.imagePath && !input.imagePath.startsWith("/uploads/")) {
        // remote skip
      }
      // Wall post with publish_date. Photo upload requires extra steps (photos.getWallUploadServer).
      // Implemented for raster files stored locally.
      if (input.imagePath?.startsWith("/uploads/") && !input.imagePath.endsWith(".svg")) {
        const server = (await vkApi("photos.getWallUploadServer", input.token, {
          group_id: String(input.groupId).replace("-", ""),
        })) as { upload_url: string };
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { UPLOAD_DIR } = await import("./db.ts");
        const file = input.imagePath.replace("/uploads/", "");
        const buf = readFileSync(join(UPLOAD_DIR, file));
        const form = new FormData();
        form.append("photo", new Blob([buf]), file);
        const up = await fetch(server.upload_url, { method: "POST", body: form });
        const upJson = (await up.json()) as { photo: string; server: number; hash: string };
        const saved = (await vkApi("photos.saveWallPhoto", input.token, {
          group_id: String(input.groupId).replace("-", ""),
          photo: upJson.photo,
          server: upJson.server,
          hash: upJson.hash,
        })) as Array<{ id: number; owner_id: number }>;
        if (saved?.[0]) attachments = `photo${saved[0].owner_id}_${saved[0].id}`;
      }
      const resp = (await vkApi("wall.post", input.token, {
        owner_id: ownerId,
        from_group: 1,
        message: input.text,
        attachments,
        publish_date: input.publishAtUnix,
      })) as { post_id: number };
      return { postId: String(resp.post_id), raw: resp };
    },
    async fetchStats(input) {
      try {
        const ownerId = input.groupId.startsWith("-") ? input.groupId : `-${input.groupId}`;
        const r = (await vkApi("wall.getById", input.token, {
          posts: `${ownerId}_${input.postId}`,
        })) as Array<{
          views?: { count?: number };
          likes?: { count?: number };
          comments?: { count?: number };
          reposts?: { count?: number };
        }>;
        const p = r?.[0];
        if (!p) return null;
        return {
          views: p.views?.count ?? 0,
          likes: p.likes?.count ?? 0,
          comments: p.comments?.count ?? 0,
          shares: p.reposts?.count ?? 0,
        };
      } catch {
        return null;
      }
    },
  };
}

export function getVk(): VkAdapter {
  const mode = setting("app_mode", "test");
  if (mode !== "approval") return testVk();
  return liveVk();
}

export function communityToken(communityId: string): string | null {
  const row = get<{ vk_token_enc: string | null }>(
    "SELECT vk_token_enc FROM communities WHERE id = ?",
    communityId,
  );
  if (!row?.vk_token_enc) return null;
  try {
    return decrypt(row.vk_token_enc);
  } catch {
    return null;
  }
}

export function saveCommunityToken(communityId: string, token: string | null, groupId?: string, screen?: string) {
  if (!token) {
    run(
      "UPDATE communities SET vk_token_enc = NULL, vk_connected = 0 WHERE id = ?",
      communityId,
    );
    return;
  }
  run(
    "UPDATE communities SET vk_token_enc = ?, vk_connected = 1, vk_group_id = COALESCE(?, vk_group_id), vk_screen_name = COALESCE(?, vk_screen_name) WHERE id = ?",
    encrypt(token),
    groupId ?? null,
    screen ?? null,
    communityId,
  );
}

export function saveGlobalVkToken(token: string | null) {
  setSetting("vk_token_enc", token ? encrypt(token) : "");
}

export { nowIso };
