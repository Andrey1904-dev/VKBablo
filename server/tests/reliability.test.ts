import { test } from "node:test";
import assert from "node:assert/strict";
import { get, openMemoryDb, run } from "../db.ts";
import { createFirstOwner, userCount } from "../auth.ts";
import { seedCore } from "../seed.ts";
import { claimNextJob, enqueue, recoverStaleJobs } from "../queue.ts";

test("local owner bootstrap is one-time and persists the latch atomically", () => {
  openMemoryDb();
  seedCore();
  const owner = createFirstOwner("OWNER@example.com", "a-strong-owner-password", "Owner");
  assert.equal(owner.email, "owner@example.com");
  assert.equal(userCount(), 1);
  assert.equal(get<{ value: string }>("SELECT value FROM settings WHERE key = 'setup_complete'")?.value, "1");
  assert.throws(
    () => createFirstOwner("second@example.com", "another-strong-password", "Second"),
    /владелец уже создан/i,
  );
  assert.equal(userCount(), 1);
});

test("stale local worker leases are recovered and a durable claim is exclusive", () => {
  openMemoryDb();
  seedCore();
  const id = enqueue({
    type: "generate_post",
    payload: { communityId: "stories", scheduledAt: "2026-10-17T10:30:00.000Z" },
    idempotencyKey: "gen:stories:recovery-test",
  });
  assert.equal(enqueue({
    type: "generate_post",
    payload: { communityId: "stories", scheduledAt: "2026-10-17T10:30:00.000Z" },
    idempotencyKey: "gen:stories:recovery-test",
  }), id);

  run(
    "UPDATE jobs SET status='running', attempts=1, started_at=?, lock_token=? WHERE id=?",
    "2000-01-01T00:00:00.000Z",
    "expired-lease",
    id,
  );
  assert.deepEqual(recoverStaleJobs(), { requeued: 1, failed: 0 });

  const claimed = claimNextJob();
  assert.ok(claimed);
  assert.equal(claimed.id, id);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.attempts, 2);
  assert.ok(claimed.lock_token);
  assert.equal(claimNextJob(), null, "a second worker cannot claim the running row");
});

test("stale jobs at the retry limit become terminal instead of looping", () => {
  openMemoryDb();
  seedCore();
  const id = enqueue({ type: "generate_post", payload: { communityId: "life", scheduledAt: "2026-10-18T10:30:00.000Z" } });
  run(
    "UPDATE jobs SET status='running', attempts=3, max_attempts=3, started_at=?, lock_token=? WHERE id=?",
    "2000-01-01T00:00:00.000Z",
    "expired-lease",
    id,
  );
  assert.deepEqual(recoverStaleJobs(), { requeued: 0, failed: 1 });
  assert.equal(get<{ status: string }>("SELECT status FROM jobs WHERE id = ?", id)?.status, "failed");
});
