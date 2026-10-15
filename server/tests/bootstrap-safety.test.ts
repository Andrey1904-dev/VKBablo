import { test } from "node:test";
import assert from "node:assert/strict";
import { constantTimeTextEqual } from "../../shared/bootstrap-safety.ts";

test("owner setup secret comparison accepts only the exact value", () => {
  const secret = "not-a-real-setup-secret-for-unit-tests-only-0123456789";
  assert.equal(constantTimeTextEqual(secret, secret), true);
  assert.equal(constantTimeTextEqual(`${secret}x`, secret), false);
  assert.equal(constantTimeTextEqual(secret.slice(0, -1), secret), false);
  assert.equal(constantTimeTextEqual(secret.replace("unit", "Unit"), secret), false);
  assert.equal(constantTimeTextEqual(`${secret}${"x".repeat(256)}`, `${secret}${"y".repeat(256)}`), false);
});
