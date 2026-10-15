import { test } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "../db.ts";
import { seedCore } from "../seed.ts";
import { createUser } from "../auth.ts";
import {
  approvePost,
  assertApprovedVersion,
  generateForSlot,
  getPost,
  scheduleToVk,
  updatePost,
} from "../posts.ts";
import { moscowSlotIso, addDays, moscowParts, HttpError } from "../lib.ts";

function slotTomorrow(time: string) {
  const { dateStr } = moscowParts();
  return moscowSlotIso(addDays(dateStr, 2), time);
}

test("неодобренный пост нельзя отправить в VK", async () => {
  openMemoryDb();
  seedCore();
  const user = createUser("owner@example.com", "super-secret-pass", "Owner");
  const post = await generateForSlot({
    communityId: "stories",
    scheduledAt: slotTomorrow("13:30"),
  });
  assert.equal(post.status, "review");
  assert.equal(post.approvedHash, null);
  assert.throws(() => assertApprovedVersion(post), HttpError);
  await assert.rejects(() => scheduleToVk(post.id, user.id), /одобрен/i);
});

test("одобрение привязано к хешу версии и сбрасывается при правке", async () => {
  openMemoryDb();
  seedCore();
  const user = createUser("owner2@example.com", "super-secret-pass", "Owner");
  const post = await generateForSlot({
    communityId: "life",
    scheduledAt: slotTomorrow("17:30"),
  });
  const approved = approvePost(post.id, user.id, "ок");
  assert.equal(approved.status, "approved");
  assert.ok(approved.approvedHash);
  assert.equal(approved.approvedHash, approved.contentHash);

  const edited = updatePost(post.id, { text: approved.text + "\n\nправка" }, user.id);
  assert.equal(edited.status, "review");
  assert.equal(edited.approvedHash, null);
  assert.throws(() => assertApprovedVersion(edited), HttpError);
});

test("после повторного одобрения dry-run планирование проходит", async () => {
  openMemoryDb();
  seedCore();
  const user = createUser("owner3@example.com", "super-secret-pass", "Owner");
  const post = await generateForSlot({
    communityId: "veronica",
    scheduledAt: slotTomorrow("21:30"),
  });
  approvePost(post.id, user.id);
  const scheduled = await scheduleToVk(post.id, user.id);
  assert.equal(scheduled.status, "scheduled");
  assert.ok(scheduled.vkPostId?.startsWith("test_"));
});

test("local text/image modes preserve untouched components and invalidate approval", async () => {
  openMemoryDb();
  seedCore();
  const scheduledAt = slotTomorrow("13:30");
  const full = await generateForSlot({ communityId: "stories", scheduledAt });
  const owner = createUser("partial-generation@example.com", "super-secret-pass", "Owner");
  approvePost(full.id, owner.id);

  const textOnly = await generateForSlot({
    communityId: "stories",
    scheduledAt,
    kind: "text",
    prompt: "Сделай тон добрее",
    force: true,
  });
  assert.equal(textOnly.imagePath, full.imagePath);
  assert.equal(textOnly.title, full.title);
  assert.equal(textOnly.topic, full.topic);
  assert.equal(textOnly.status, "review");
  assert.equal(textOnly.approvedHash, null);

  const imageOnly = await generateForSlot({
    communityId: "stories",
    scheduledAt,
    kind: "image",
    prompt: "Тёплый вечерний свет",
    force: true,
  });
  assert.equal(imageOnly.text, textOnly.text);
  assert.equal(imageOnly.title, textOnly.title);
  assert.equal(imageOnly.topic, textOnly.topic);
  assert.notEqual(imageOnly.imagePath, textOnly.imagePath);
  assert.match(imageOnly.imagePrompt, /Тёплый вечерний свет/);
  assert.equal(imageOnly.approvedHash, null);
  assert.equal(imageOnly.testMode, true);
});

test("слоты Москвы 13:30 17:30 21:30", () => {
  const iso = moscowSlotIso("2026-10-15", "13:30");
  const p = moscowParts(iso);
  assert.equal(p.timeStr, "13:30");
  assert.equal(p.dateStr, "2026-10-15");
  const iso2 = moscowSlotIso("2026-10-15", "21:30");
  assert.equal(moscowParts(iso2).timeStr, "21:30");
});

test("force regeneration cannot overwrite a scheduled post", async () => {
  openMemoryDb();
  seedCore();
  const owner = createUser("scheduled-safety@example.com", "super-secret-pass", "Owner");
  const post = await generateForSlot({
    communityId: "stories",
    scheduledAt: slotTomorrow("13:30"),
  });
  approvePost(post.id, owner.id);
  const scheduled = await scheduleToVk(post.id, owner.id);
  assert.equal(scheduled.status, "scheduled");
  await assert.rejects(
    () => generateForSlot({
      communityId: "stories",
      scheduledAt: post.scheduledAt,
      kind: "full_post",
      force: true,
    }),
    /нельзя генерировать заново/i,
  );
  assert.equal(getPost(post.id).status, "scheduled");
});

test("идемпотентность слота: повторная генерация не плодит дубли", async () => {
  openMemoryDb();
  seedCore();
  const at = slotTomorrow("13:30");
  const a = await generateForSlot({ communityId: "milana", scheduledAt: at });
  const b = await generateForSlot({ communityId: "milana", scheduledAt: at });
  assert.equal(a.id, b.id);
});
