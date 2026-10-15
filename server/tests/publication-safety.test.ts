import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertCurrentApproval,
  fetchRequiredPublicationImage,
  hasCurrentApproval,
  isRemoteVkPostId,
  remoteCancellationWarning,
  shouldRetryDefinitePublicationFailure,
  shouldSkipClaimedPublication,
  stalePublicationDisposition,
} from "../../shared/publication-safety.ts";
import { contentHash } from "../../shared/hash.ts";

// Edge modules read Deno env at import time. The test supplies an empty runtime
// shim and injects a mock fetcher into every VK method exercised below.
type DenoRuntimeShim = { env: { get: (name: string) => string | undefined } };
const runtime = globalThis as typeof globalThis & { Deno?: DenoRuntimeShim };
runtime.Deno ??= { env: { get: () => undefined } };
const vk = await import("../../supabase/functions/_shared/vk.ts");
const { redactSecrets } = await import("../../supabase/functions/_shared/http.ts");

function approvedSnapshot() {
  const post = {
    id: "post-1",
    communityId: "stories",
    status: "scheduled",
    text: "Approved text",
    imagePath: "posts/post-1.png",
    scheduledAt: "2026-10-15T10:30:00.000Z",
  };
  const hash = contentHash({
    communityId: post.communityId,
    text: post.text,
    imagePath: post.imagePath,
    scheduledAt: post.scheduledAt,
  });
  return {
    post: { ...post, contentHash: hash, approvedHash: hash },
    job: {
      postId: post.id,
      communityId: post.communityId,
      versionHash: hash,
      scheduledAt: post.scheduledAt,
      status: "running",
    },
  };
}

test("provider error details redact bearer, VK and AI secrets", () => {
  const safe = redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz vk1.supersecretvalue sk-live-secret-value access_token=token-secret");
  assert.doesNotMatch(safe, /abcdefghijklmnopqrstuvwxyz|vk1\.supersecretvalue|sk-live-secret-value|token-secret/);
  assert.equal((safe.match(/\*\*\*/g) ?? []).length >= 4, true);
});

test("mock VK confirms remote cancellation only on wall.delete response 1", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.match(url, /\/wall\.delete$/);
    assert.equal(init?.method, "POST");
    const body = new URLSearchParams(String(init?.body ?? ""));
    assert.equal(body.get("owner_id"), "-12345");
    assert.equal(body.get("post_id"), "987");
    return new Response(JSON.stringify({ response: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const result = await vk.wallDelete(
    { token: "mock-token-never-sent", groupId: "12345", postId: "987" },
    { fetcher },
  );
  assert.deepEqual(result, { deleted: true });
  assert.equal(calls.length, 1);

  const notConfirmed = await assert.rejects(
    () => vk.wallDelete(
      { token: "mock-token-never-sent", groupId: "12345", postId: "987" },
      { fetcher: async () => new Response(JSON.stringify({ response: 0 }), { status: 200 }) },
    ),
  );
  assert.equal(notConfirmed, undefined);
  assert.match(remoteCancellationWarning("unknown"), /может остаться/);
});

test("lost wall.post response is an unknown outcome and must not retry", async () => {
  let acceptedByMockVk = false;
  let requestCount = 0;
  const futurePublishAt = Math.floor(Date.now() / 1000) + 30;
  const fetcher: typeof fetch = async (input, init) => {
    requestCount += 1;
    assert.match(String(input), /\/wall\.post$/);
    assert.equal(new URLSearchParams(String(init?.body ?? "")).get("publish_date"), String(futurePublishAt));
    // Simulate VK accepting the request while the response is lost in transit.
    acceptedByMockVk = true;
    throw new TypeError("mock response dropped after acceptance");
  };

  await assert.rejects(
    () => vk.wallPost(
      { token: "mock-token-never-sent", groupId: "12345", message: "test", publishDateUnix: futurePublishAt },
      { fetcher },
    ),
    (error: unknown) => error instanceof vk.VkOutcomeUnknownError && error.outcomeUnknown,
  );
  assert.equal(acceptedByMockVk, true);
  assert.equal(requestCount, 1, "the adapter must not retry wall.post");

  let ambiguousErrorCalls = 0;
  await assert.rejects(
    () => vk.wallPost(
      { token: "mock-token-never-sent", groupId: "12345", message: "test" },
      { fetcher: async () => {
        ambiguousErrorCalls += 1;
        return new Response(JSON.stringify({ error: { error_code: 10, error_msg: "Internal error" } }), { status: 200 });
      } },
    ),
    (error: unknown) => error instanceof vk.VkOutcomeUnknownError && error.outcomeUnknown,
  );
  assert.equal(ambiguousErrorCalls, 1, "generic server errors are ambiguous, not retryable");
  assert.equal(stalePublicationDisposition({ status: "running", dispatchStartedAt: "2026-10-14T12:00:00Z" }), "unknown");
  assert.equal(shouldRetryDefinitePublicationFailure({
    outcomeUnknown: true,
    retryable: true,
    attempts: 1,
    maxAttempts: 5,
  }), false);
});

test("repeat processing skips unknown jobs and known VK ids", () => {
  assert.equal(shouldSkipClaimedPublication({ cancelled: true, unknown: true }), true);
  assert.equal(shouldSkipClaimedPublication({ alreadyPosted: true, vkPostId: "456" }), true);
  assert.equal(shouldSkipClaimedPublication({ status: "unknown" }), true);
  assert.equal(shouldSkipClaimedPublication({ status: "running", vkPostId: "test_demo" }), false);
  assert.equal(isRemoteVkPostId("test_demo"), false);
  assert.equal(isRemoteVkPostId("456"), true);
  assert.equal(stalePublicationDisposition({ status: "running" }), "requeue");
  assert.equal(stalePublicationDisposition({ status: "done", dispatchStartedAt: null }), "leave_terminal");
});

test("approved snapshot is invalidated by text, image, community, or schedule change", () => {
  const { post, job } = approvedSnapshot();
  assert.equal(hasCurrentApproval(post, job), true);
  assert.doesNotThrow(() => assertCurrentApproval(post, job));

  const textHash = contentHash({ ...post, text: "Edited text" });
  assert.equal(hasCurrentApproval({ ...post, text: "Edited text", contentHash: textHash }, job), false);
  const imageHash = contentHash({ ...post, imagePath: "posts/other.png" });
  assert.equal(hasCurrentApproval({ ...post, imagePath: "posts/other.png", contentHash: imageHash }, job), false);
  const communityHash = contentHash({ ...post, communityId: "life" });
  assert.equal(hasCurrentApproval({ ...post, communityId: "life", contentHash: communityHash }, job), false);
  const timeHash = contentHash({ ...post, scheduledAt: "2026-10-15T14:30:00.000Z" });
  assert.equal(hasCurrentApproval({ ...post, scheduledAt: "2026-10-15T14:30:00.000Z", contentHash: timeHash }, job), false);
  assert.equal(hasCurrentApproval({ ...post, approvedHash: null }, job), false);
});

test("missing or unavailable approved image blocks publication before VK", async () => {
  await assert.rejects(
    () => fetchRequiredPublicationImage(null, async () => null),
    /отсутствует изображение/,
  );
  await assert.rejects(
    () => fetchRequiredPublicationImage("posts/post.png", async () => null),
    /недоступно в Supabase Storage/,
  );
  await assert.rejects(
    () => fetchRequiredPublicationImage(
      "posts/post.png",
      async () => "https://mock-storage.invalid/signed",
      async () => new Response("missing", { status: 404 }),
    ),
    /HTTP 404/,
  );

  const image = await fetchRequiredPublicationImage(
    "posts/post.png",
    async () => "https://mock-storage.invalid/signed",
    async () => new Response(new Uint8Array([137, 80, 78, 71]), {
      status: 200,
      headers: { "content-type": "image/png" },
    }),
  );
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.filename, "post.png");
  assert.deepEqual([...image.bytes], [137, 80, 78, 71]);
});
