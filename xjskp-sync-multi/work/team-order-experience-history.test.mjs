import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateTeamOrderTrigger,
  loadTeamOrderExperienceHistory,
  recordCompletedTeamOrderExperience,
  saveTeamOrderExperienceHistory,
} from "./team-order-experience-history.mjs";

test("team trigger keeps 49/99 protection when no history and protection is enabled", () => {
  const result = evaluateTeamOrderTrigger({
    remainingLevelExp: 100_000,
    triggeringResidentOrderMaxExp: 500,
    triggerProtectionEnabled: true,
    history: null,
  });

  assert.equal(result.blocked, true);
  assert.equal(result.coldStartBypass, false);
  assert.equal(result.reason, "trigger-protection-enabled");
});

test("team trigger allows an explicitly authorized no-history cold start", () => {
  const result = evaluateTeamOrderTrigger({
    remainingLevelExp: null,
    triggeringResidentOrderMaxExp: null,
    triggerProtectionEnabled: false,
    history: null,
  });

  assert.equal(result.blocked, false);
  assert.equal(result.coldStartBypass, true);
  assert.equal(result.reason, "cold-start-user-authorized");
});

test("team trigger enforces historical maximum times two even when protection is disabled", () => {
  const history = { accountHistoricalMaxFinalExp: 5_000 };

  const enough = evaluateTeamOrderTrigger({
    remainingLevelExp: 11_001,
    minimumRemainingExp: 500,
    triggeringResidentOrderMaxExp: 500,
    triggerProtectionEnabled: false,
    history,
  });
  const equal = evaluateTeamOrderTrigger({
    remainingLevelExp: 11_000,
    minimumRemainingExp: 500,
    triggeringResidentOrderMaxExp: 500,
    triggerProtectionEnabled: false,
    history,
  });

  assert.equal(enough.blocked, false);
  assert.equal(enough.minimumRemainingExp, 500);
  assert.equal(enough.teamOrderGuardExp, 10_000);
  assert.equal(enough.requiredExperienceSpace, 11_000);
  assert.equal(equal.blocked, true);
  assert.equal(equal.forceTriggerProtectionEnabled, true);
  assert.equal(equal.reason, "insufficient-experience-space");
});

test("team trigger uses the configured guard multiplier when provided", () => {
  const history = { accountHistoricalMaxFinalExp: 5_000 };
  const base = {
    remainingLevelExp: 50_000,
    minimumRemainingExp: 500,
    triggeringResidentOrderMaxExp: 500,
    triggerProtectionEnabled: false,
    history,
  };

  const tripled = evaluateTeamOrderTrigger({ ...base, guardMultiplier: 3 });
  assert.equal(tripled.teamOrderGuardExp, 15_000);
  assert.equal(tripled.requiredExperienceSpace, 16_000);

  const zero = evaluateTeamOrderTrigger({ ...base, guardMultiplier: 0 });
  assert.equal(zero.teamOrderGuardExp, 0);
  assert.equal(zero.requiredExperienceSpace, 1_000);

  const fractional = evaluateTeamOrderTrigger({ ...base, guardMultiplier: 2.25 });
  assert.equal(fractional.teamOrderGuardExp, 11_250);
  assert.equal(fractional.requiredExperienceSpace, 12_250);

  const maxBoundary = evaluateTeamOrderTrigger({ ...base, guardMultiplier: 10 });
  assert.equal(maxBoundary.teamOrderGuardExp, 50_000);
  assert.equal(maxBoundary.requiredExperienceSpace, 51_000);
});

test("team trigger falls back to the default multiplier for invalid guard values", () => {
  const history = { accountHistoricalMaxFinalExp: 5_000 };
  const base = {
    remainingLevelExp: 50_000,
    minimumRemainingExp: 500,
    triggeringResidentOrderMaxExp: 500,
    triggerProtectionEnabled: false,
    history,
  };

  for (const guardMultiplier of [-1, 10.01, 1.234, "3", null, undefined, NaN]) {
    const result = evaluateTeamOrderTrigger({ ...base, guardMultiplier });
    assert.equal(
      result.teamOrderGuardExp,
      10_000,
      `guardMultiplier=${String(guardMultiplier)} should fall back to default`,
    );
    assert.equal(result.requiredExperienceSpace, 11_000);
  }
});

test("team trigger keeps the guard exp null while historical maximum is unknown", () => {
  const result = evaluateTeamOrderTrigger({
    remainingLevelExp: 50_000,
    minimumRemainingExp: 500,
    triggeringResidentOrderMaxExp: 500,
    triggerProtectionEnabled: false,
    history: null,
    guardMultiplier: 3,
  });

  assert.equal(result.teamOrderGuardExp, null);
  assert.equal(result.accountHistoricalMaxFinalExp, null);
  assert.equal(result.reason, "cold-start-user-authorized");
});

test("team trigger fails closed for damaged history or unknown trigger experience", () => {
  assert.equal(evaluateTeamOrderTrigger({
    remainingLevelExp: 100_000,
    triggeringResidentOrderMaxExp: 500,
    triggerProtectionEnabled: false,
    history: { accountHistoricalMaxFinalExp: -1 },
  }).blocked, true);

  assert.equal(evaluateTeamOrderTrigger({
    remainingLevelExp: 100_000,
    minimumRemainingExp: 500,
    triggeringResidentOrderMaxExp: null,
    triggerProtectionEnabled: false,
    history: { accountHistoricalMaxFinalExp: 5_000 },
  }).blocked, true);

  assert.equal(evaluateTeamOrderTrigger({
    remainingLevelExp: 100_000,
    minimumRemainingExp: null,
    triggeringResidentOrderMaxExp: 500,
    triggerProtectionEnabled: false,
    history: { accountHistoricalMaxFinalExp: 5_000 },
  }).blocked, true);
});

test("completed team settlement updates only the current account historical maximum", () => {
  let history = {};
  history = recordCompletedTeamOrderExperience({
    history,
    accountId: "account-a",
    actualExpDelta: 4_000,
    completed: true,
    settlementStatus: "completed",
  });
  history = recordCompletedTeamOrderExperience({
    history,
    accountId: "account-a",
    actualExpDelta: 3_000,
    completed: true,
    settlementStatus: "completed",
  });
  history = recordCompletedTeamOrderExperience({
    history,
    accountId: "account-b",
    actualExpDelta: 9_000,
    completed: true,
    settlementStatus: "completed",
  });

  assert.equal(history.accounts["account-a"].accountHistoricalMaxFinalExp, 4_000);
  assert.equal(history.accounts["account-b"].accountHistoricalMaxFinalExp, 9_000);
});

test("failed or pending team settlement does not create a historical sample", () => {
  for (const settlementStatus of ["failed", "settlement-pending"]) {
    const history = recordCompletedTeamOrderExperience({
      history: {},
      accountId: "account-a",
      actualExpDelta: 4_000,
      completed: false,
      settlementStatus,
    });
    assert.equal(history.accounts?.["account-a"], undefined);
  }
});

test("team experience history persists per account", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-order-exp-history-"));
  const filePath = path.join(dir, "history.json");

  try {
    const history = recordCompletedTeamOrderExperience({
      history: {},
      accountId: "account-a",
      actualExpDelta: 4_000,
      completed: true,
      settlementStatus: "completed",
    });
    saveTeamOrderExperienceHistory(filePath, history);

    assert.deepEqual(loadTeamOrderExperienceHistory(filePath), history);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
