import assert from "node:assert/strict";
import test from "node:test";

import {
  createRateLimitGuard,
  isRequestRateLimitedError,
} from "./rate-limit-guard.mjs";

function createFakeClock() {
  let current = 1_000_000;
  return {
    now() {
      return current;
    },
    advance(ms) {
      current += ms;
    },
  };
}

test("isRequestRateLimitedError recognizes errCode 263 payload", () => {
  const err = new Error("submit failed");
  err.errMsg = { code: 263, msg: "操作过于频繁" };
  assert.equal(isRequestRateLimitedError(err), true);
});

test("isRequestRateLimitedError recognizes type 263 payload", () => {
  const err = new Error("submit failed");
  err.errMsg = { type: 263 };
  assert.equal(isRequestRateLimitedError(err), true);
});

test("isRequestRateLimitedError recognizes rate limit text hint", () => {
  const err = new Error('OrderFlower enter failed: {"msg":"操作频繁，请稍后再试"}');
  assert.equal(isRequestRateLimitedError(err), true);
});

test("isRequestRateLimitedError rejects unrelated errors", () => {
  const err = new Error("water drop shortage");
  err.errMsg = { code: 301, param: { iid: 7 } };
  assert.equal(isRequestRateLimitedError(err), false);
  assert.equal(isRequestRateLimitedError(null), false);
  assert.equal(isRequestRateLimitedError(new Error("session expired")), false);
});

test("rate limit guard enforces a per-iface sliding window", async () => {
  const clock = createFakeClock();
  let slept = 0;
  const guard = createRateLimitGuard({
    windowMs: 1_000,
    maxRequestsPerWindow: 2,
    nowFn: clock.now,
    sleepFn: async (ms) => {
      slept += ms;
    },
  });

  assert.deepEqual(guard.requestAllowed("gs.orderTeam.submitOrder"), { allowed: true, waitMs: 0 });
  guard.recordRequest("gs.orderTeam.submitOrder");
  assert.deepEqual(guard.requestAllowed("gs.orderTeam.submitOrder"), { allowed: true, waitMs: 0 });
  guard.recordRequest("gs.orderTeam.submitOrder");
  // 窗口已满（最新请求刚发出，需等满整个窗口）
  assert.deepEqual(guard.requestAllowed("gs.orderTeam.submitOrder"), { allowed: false, waitMs: 1_000 });

  // 窗口滚动后恢复
  clock.advance(1_001);
  assert.deepEqual(guard.requestAllowed("gs.orderTeam.submitOrder"), { allowed: true, waitMs: 0 });

  // 不同接口互不影响
  assert.deepEqual(guard.requestAllowed("gs.usrLand.plant"), { allowed: true, waitMs: 0 });
});

test("rate limit guard backoff is per-interface and exponential", async () => {
  const clock = createFakeClock();
  const guard = createRateLimitGuard({
    windowMs: 1_000,
    minBackoffMs: 300,
    maxBackoffMs: 30_000,
    nowFn: clock.now,
  });

  const backoff1 = guard.recordRateLimited("gs.orderTeam.submitOrder");
  assert.equal(backoff1, 300);
  assert.equal(guard.requestAllowed("gs.orderTeam.submitOrder").allowed, false);

  // 退避结束后第二次限频 → 指数增长
  clock.advance(300);
  const backoff2 = guard.recordRateLimited("gs.orderTeam.submitOrder");
  assert.equal(backoff2, 600);
  assert.equal(guard.requestAllowed("gs.orderTeam.submitOrder").allowed, false);

  // 另一接口不受退避影响
  assert.equal(guard.requestAllowed("gs.usrLand.harvest").allowed, true);
});

test("rate limit guard backoff resets after sustained success", async () => {
  const clock = createFakeClock();
  const guard = createRateLimitGuard({
    minBackoffMs: 300,
    nowFn: clock.now,
  });
  guard.recordRateLimited("gs.orderTeam.submitOrder");
  assert.equal(guard.requestAllowed("gs.orderTeam.submitOrder").allowed, false);

  clock.advance(61_000);
  guard.observeSuccess("gs.orderTeam.submitOrder");
  assert.equal(guard.requestAllowed("gs.orderTeam.submitOrder").allowed, true);
});

test("rate limit guard snapshot exposes observable state", async () => {
  const clock = createFakeClock();
  const guard = createRateLimitGuard({
    windowMs: 1_000,
    maxRequestsPerWindow: 3,
    nowFn: clock.now,
  });
  guard.recordRequest("gs.orderTeam.submitOrder");
  guard.recordRateLimited("gs.orderTeam.submitOrder");

  const snap = guard.snapshot();
  assert.ok(snap["gs.orderTeam.submitOrder"]);
  assert.equal(snap["gs.orderTeam.submitOrder"].rateLimitedCount, 1);
  assert.equal(snap["gs.orderTeam.submitOrder"].backoffCount, 1);
  assert.equal(snap["gs.orderTeam.submitOrder"].recentRequestCount, 1);
  assert.ok(snap["gs.orderTeam.submitOrder"].backoffRemainingMs > 0);
});

test("rate limit guard acquire waits then records the request", async () => {
  const clock = createFakeClock();
  let slept = 0;
  const guard = createRateLimitGuard({
    windowMs: 1_000,
    maxRequestsPerWindow: 1,
    minBackoffMs: 300,
    nowFn: clock.now,
    sleepFn: async (ms) => {
      slept += ms;
      clock.advance(ms);
    },
  });

  assert.equal(await guard.acquire("gs.orderTeam.submitOrder"), 0);
  // 第二个 acquire 会等待窗口过期
  const pending = guard.acquire("gs.orderTeam.submitOrder");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(slept >= 1_000);
  await pending;
});
