import assert from "node:assert/strict";
import test from "node:test";

import {
  getLoopIntervalConfig,
  getLoopSleepSeconds,
} from "./loop-interval.mjs";

test("getLoopIntervalConfig defaults to a 30 to 58 second random range", () => {
  assert.deepEqual(getLoopIntervalConfig({}), {
    mode: "random",
    minSeconds: 30,
    maxSeconds: 58,
  });
});

test("getLoopSleepSeconds returns inclusive random seconds in the configured range", () => {
  const env = {
    LOOP_INTERVAL_MIN_SECONDS: "30",
    LOOP_INTERVAL_MAX_SECONDS: "58",
  };

  assert.equal(getLoopSleepSeconds(env, () => 0), 30);
  assert.equal(getLoopSleepSeconds(env, () => 0.5), 44);
  assert.equal(getLoopSleepSeconds(env, () => 0.999999), 58);
});

test("fixed LOOP_INTERVAL_SECONDS remains supported", () => {
  assert.equal(getLoopSleepSeconds({ LOOP_INTERVAL_SECONDS: "45" }, () => 0), 45);
});
