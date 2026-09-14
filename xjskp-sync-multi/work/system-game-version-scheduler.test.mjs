import test from "node:test";
import assert from "node:assert/strict";

import {
  createGameVersionScheduler,
  getNextGameVersionCheckAt,
} from "./system/game-version-scheduler.mjs";

test("getNextGameVersionCheckAt uses local 03:00 and 15:00 boundaries", () => {
  assert.equal(
    getNextGameVersionCheckAt(new Date(2026, 7, 3, 2, 30)).getTime(),
    new Date(2026, 7, 3, 3, 0).getTime(),
  );
  assert.equal(
    getNextGameVersionCheckAt(new Date(2026, 7, 3, 3, 0)).getTime(),
    new Date(2026, 7, 3, 3, 0).getTime(),
  );
  assert.equal(
    getNextGameVersionCheckAt(new Date(2026, 7, 3, 3, 0, 1)).getTime(),
    new Date(2026, 7, 3, 15, 0).getTime(),
  );
  assert.equal(
    getNextGameVersionCheckAt(new Date(2026, 7, 3, 15, 0, 1)).getTime(),
    new Date(2026, 7, 4, 3, 0).getTime(),
  );
});

test("scheduler starts one server-side timer, runs the check, reschedules, and stops cleanly", async () => {
  const scheduled = [];
  const cleared = [];
  let checks = 0;
  const scheduler = createGameVersionScheduler({
    now: () => new Date(2026, 7, 3, 2, 0),
    check: async () => { checks += 1; },
    setTimeoutFn(callback, delay) {
      const handle = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      scheduled.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) {
      cleared.push(handle);
    },
  });

  scheduler.start();
  scheduler.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 60 * 60 * 1000);
  assert.equal(scheduled[0].unrefCalled, true);
  assert.equal(scheduler.getStatus().nextCheckAt, new Date(2026, 7, 3, 3, 0).toISOString());

  await scheduled[0].callback();
  assert.equal(checks, 1);
  assert.equal(scheduled.length, 2);

  scheduler.stop();
  assert.equal(cleared.at(-1), scheduled[1]);
  assert.equal(scheduler.getStatus().running, false);
  assert.equal(scheduler.getStatus().nextCheckAt, null);
});

test("scheduler records safe failure state and still schedules the next fixed time", async () => {
  const scheduled = [];
  const scheduler = createGameVersionScheduler({
    now: () => new Date(2026, 7, 3, 14, 0),
    check: async () => {
      const error = new Error("secret transport detail");
      error.code = "VERSION_CHECK_UPSTREAM_ERROR";
      throw error;
    },
    setTimeoutFn(callback, delay) {
      const handle = { callback, delay, unref() {} };
      scheduled.push(handle);
      return handle;
    },
    clearTimeoutFn() {},
  });

  scheduler.start();
  await scheduled[0].callback();
  const status = scheduler.getStatus();
  assert.equal(status.lastErrorCode, "VERSION_CHECK_UPSTREAM_ERROR");
  assert.equal(JSON.stringify(status).includes("secret transport detail"), false);
  assert.equal(scheduled.length, 2);
  scheduler.stop();
});
