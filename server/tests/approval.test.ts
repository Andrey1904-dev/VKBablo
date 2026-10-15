import { test } from "node:test";
import assert from "node:assert/strict";
import { get, openMemoryDb, run, setSetting } from "../db.ts";
import { seedCore } from "../seed.ts";
import { createUser } from "../auth.ts";
import {
  approvePost,
  assertApprovedVersion,
  generateForSlot,
  getPost,
  scheduleToVk,
  unscheduleLocalPost,
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

test("local dry-run cancellation persists the cancelled state and retains valid human approval", async () => {
  openMemoryDb();
  seedCore();
  const owner = createUser("cancel-local@example.com", "super-secret-pass", "Owner");
  const post = await generateForSlot({ communityId: "stories", scheduledAt: slotTomorrow("13:30") });
  const approved = approvePost(post.id, owner.id);
  const scheduled = await scheduleToVk(post.id, owner.id);
  assert.equal(scheduled.status, "scheduled");
  assert.ok(scheduled.vkPostId?.startsWith("test_"));

  const cancelled = unscheduleLocalPost(post.id, owner.id, "regression test");
  assert.equal(cancelled.status, "approved");
  assert.equal(cancelled.approvedHash, approved.approvedHash);
  assert.equal(cancelled.vkPostId, null);
  assert.equal(get<{ status: string }>("SELECT status FROM publication_jobs WHERE post_id = ?", post.id)?.status, "cancelled");
});

test("local backend rejects live-publish mode before any VK side effect", async () => {
  openMemoryDb();
  seedCore();
  const owner = createUser("local-live-block@example.com", "super-secret-pass", "Owner");
  const post = await generateForSlot({ communityId: "life", scheduledAt: slotTomorrow("17:30") });
  approvePost(post.id, owner.id);
  setSetting("app_mode", "approval");
  await assert.rejects(() => scheduleToVk(post.id, owner.id), /локальный.*не выполняет реальные публикации/i);
  assert.equal(get<{ count: number }>("SELECT COUNT(*) AS count FROM publication_jobs")?.count, 0);
});

test("queue retry re-runs a generating post left behind by a crashed worker", async () => {
  openMemoryDb();
  seedCore();
  const at = slotTomorrow("13:30");
  const original = await generateForSlot({ communityId: "stories", scheduledAt: at });
  run("UPDATE posts SET status = 'generating' WHERE id = ?", original.id);

  const readOnlyRetry = await generateForSlot({ communityId: "stories", scheduledAt: at });
  assert.equal(readOnlyRetry.status, "generating", "a non-queue duplicate request must not race the active job");
  const recovered = await generateForSlot({ communityId: "stories", scheduledAt: at, retryInterrupted: true });
  assert.equal(recovered.id, original.id);
  assert.equal(recovered.status, "review");
  assert.ok(recovered.version > original.version);
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
