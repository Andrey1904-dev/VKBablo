import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { get, openMemoryDb, UPLOAD_DIR } from "../db.ts";
import { seedCore } from "../seed.ts";
import { createApp } from "../app.ts";

test("local reference upload, owner approval and primary selection persist through API", async () => {
  openMemoryDb();
  seedCore();
  const app = createApp();
  const setup = await app.request("/api/auth/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "refs-owner@example.com", password: "strong-owner-password", name: "Owner" }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const vkConnect = await app.request("/api/communities/stories/vk", {
    method: "POST",
    headers: { Cookie: cookie!, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "mock-token-never-sent", groupId: "123" }),
  });
  assert.equal(vkConnect.status, 501);
  assert.equal(get<{ vk_token_enc: string | null }>("SELECT vk_token_enc FROM communities WHERE id = 'stories'")?.vk_token_enc, null);
  const liveMode = await app.request("/api/settings", {
    method: "PATCH",
    headers: { Cookie: cookie!, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "approval", realPublishEnabled: true }),
  });
  assert.equal(liveMode.status, 501);

  const storedPaths: string[] = [];
  async function uploadAndApprove(filename: string) {
    const form = new FormData();
    form.set("file", new File([new Uint8Array([137, 80, 78, 71])], filename, { type: "image/png" }));
    form.set("notes", "owner supplied test reference");
    const upload = await app.request("/api/characters/milana/references", {
      method: "POST",
      headers: { Cookie: cookie! },
      body: form,
    });
    assert.equal(upload.status, 200);
    const item = await upload.json() as { id: string; path: string };
    storedPaths.push(item.path);
    const approve = await app.request(`/api/characters/references/${item.id}/approve`, {
      method: "POST",
      headers: { Cookie: cookie!, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(approve.status, 200);
    return item.id;
  }

  try {
    const firstId = await uploadAndApprove("first.png");
    let result = await app.request("/api/characters?communityId=milana", { headers: { Cookie: cookie! } });
    assert.equal(result.status, 200);
    let character = (await result.json() as { characters: Array<Record<string, unknown>> }).characters.find((item) => item.id === "milana");
    assert.ok(character);
    assert.equal(character.appearanceStatus, "approved");
    assert.equal(character.primaryReferenceId, firstId);
    let refs = character.references as Array<Record<string, unknown>>;
    assert.equal(refs.find((item) => item.id === firstId)?.approved, true);
    assert.equal(refs.find((item) => item.id === firstId)?.isPrimary, true);

    const secondId = await uploadAndApprove("second.png");
    const select = await app.request(`/api/characters/references/${secondId}/primary`, {
      method: "POST",
      headers: { Cookie: cookie!, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(select.status, 200);

    result = await app.request("/api/characters?communityId=milana", { headers: { Cookie: cookie! } });
    character = (await result.json() as { characters: Array<Record<string, unknown>> }).characters.find((item) => item.id === "milana");
    assert.equal(character?.primaryReferenceId, secondId);
    refs = character?.references as Array<Record<string, unknown>>;
    assert.equal(refs.find((item) => item.id === firstId)?.isPrimary, false);
    assert.equal(refs.find((item) => item.id === secondId)?.isPrimary, true);
  } finally {
    for (const path of storedPaths) {
      const name = path.replace(/^\/uploads\//, "");
      rmSync(join(UPLOAD_DIR, name), { force: true });
    }
  }
});
