import { test } from "node:test";
import assert from "node:assert/strict";
import { isWorkerTask, shouldProcessWorkerQueue } from "../../shared/worker-safety.ts";

test("worker health check is allowlisted but cannot process or enqueue jobs", () => {
  assert.equal(isWorkerTask("health"), true);
  assert.equal(shouldProcessWorkerQueue("health"), false);
  for (const task of ["tick", "planner", "publish_due", "stats"]) {
    assert.equal(isWorkerTask(task), true);
    assert.equal(shouldProcessWorkerQueue(task), true);
  }
  assert.equal(isWorkerTask("health-and-generate"), false);
  assert.equal(shouldProcessWorkerQueue("health-and-generate"), false);
});
