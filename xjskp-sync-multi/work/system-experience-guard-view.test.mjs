import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExperienceGuardView,
  formatExperienceGuardThresholdPercent,
  parseExperienceGuardThresholdPercentInput,
} from "./system/public/experience-guard-view.js";

test("experience guard percentage input accepts the frozen numeric contract", () => {
  for (const [input, expected] of [
    ["0", 0],
    ["0.01", 0.01],
    [".5", 0.5],
    ["0.50", 0.5],
    ["0.37", 0.37],
    ["1", 1],
    ["100.01", 100.01],
    ["123.45", 123.45],
  ]) {
    assert.equal(parseExperienceGuardThresholdPercentInput(input), expected, input);
  }

  for (const input of ["", "0.001", "0.011", "1.234", "-1", "1e2", "Infinity", "abc"]) {
    assert.equal(parseExperienceGuardThresholdPercentInput(input), null, input);
  }
});

test("experience guard percentage always formats with two decimal places", () => {
  assert.equal(formatExperienceGuardThresholdPercent(0.5), "0.50");
  assert.equal(formatExperienceGuardThresholdPercent(0.01), "0.01");
  assert.equal(formatExperienceGuardThresholdPercent(0), "0.00");
  assert.equal(formatExperienceGuardThresholdPercent(1.2), "1.20");
  assert.equal(formatExperienceGuardThresholdPercent(Number.NaN), "0.50");
  assert.equal(formatExperienceGuardThresholdPercent(null), "0.50");
});

test("experience guard view calculates status, line, and distance from the account percentage", () => {
  assert.deepEqual(buildExperienceGuardView({
    accountLevel: { currentExp: 98_000, requiredExp: 100_000 },
    thresholdPercent: 1.25,
  }), {
    thresholdPercent: 1.25,
    thresholdPercentText: "1.25",
    known: true,
    blocked: false,
    statusText: "正常",
    thresholdRemainingExp: 1_250,
    remainingToProtectionExp: 750,
  });

  assert.deepEqual(buildExperienceGuardView({
    accountLevel: { currentExp: 98_750, requiredExp: 100_000 },
    thresholdPercent: 1.25,
  }), {
    thresholdPercent: 1.25,
    thresholdPercentText: "1.25",
    known: true,
    blocked: true,
    statusText: "有经验动作暂停，无经验动作继续",
    thresholdRemainingExp: 1_250,
    remainingToProtectionExp: 0,
  });
});

test("experience guard view keeps the frozen default and unknown empty state", () => {
  assert.deepEqual(buildExperienceGuardView({
    accountLevel: { currentExp: null, requiredExp: 100_000 },
  }), {
    thresholdPercent: 0.5,
    thresholdPercentText: "0.50",
    known: false,
    blocked: false,
    statusText: "待刷新",
    thresholdRemainingExp: null,
    remainingToProtectionExp: null,
  });
});

test("experience guard view shows no-threshold copy and dashes at 0 percent", () => {
  assert.deepEqual(buildExperienceGuardView({
    accountLevel: { currentExp: 99_500, requiredExp: 100_000 },
    thresholdPercent: 0,
  }), {
    thresholdPercent: 0,
    thresholdPercentText: "0.00",
    known: true,
    blocked: false,
    statusText: "不设门槛",
    thresholdRemainingExp: null,
    remainingToProtectionExp: null,
  });

  const guarded = buildExperienceGuardView({
    accountLevel: { currentExp: 99_500, requiredExp: 100_000 },
    thresholdPercent: 0,
    experienceGuard: { thresholdPercent: 0, known: true, blocked: true },
  });
  assert.equal(guarded.blocked, false);
  assert.equal(guarded.statusText, "不设门槛");
});

test("experience guard view preserves a matching fail-close status", () => {
  const view = buildExperienceGuardView({
    accountLevel: { currentExp: 90_000, requiredExp: 100_000 },
    thresholdPercent: 1.25,
    experienceGuard: { thresholdPercent: 1.25, known: true, blocked: true },
  });

  assert.equal(view.blocked, true);
  assert.equal(view.statusText, "有经验动作暂停，无经验动作继续");
  assert.equal(view.remainingToProtectionExp, 8_750);
});
