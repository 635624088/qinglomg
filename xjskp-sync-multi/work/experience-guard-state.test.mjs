import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createExperienceGuardRearmRequest,
  createExperienceGuardSettlementRecoveryRequest,
  createPersistentExperienceLevelGuard,
  resolveExperienceGuardStatePath,
} from "./experience-guard-state.mjs";

function withTempGuard(t, profileId = "p1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "experience-level-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let nowMs = Date.parse("2026-08-11T00:00:00.000Z");
  const statePath = path.join(dir, `${profileId}.json`);
  const create = () => createPersistentExperienceLevelGuard({
    profileId,
    statePath,
    nowFn: () => nowMs++,
  });
  return { dir, statePath, create };
}

test("experience level guard arms the first protected level and sticks after a same-session level breach", (t) => {
  const { create } = withTempGuard(t);
  const guard = create();

  guard.observeAuthoritative({
    level: 19,
    currentExp: 79_290,
    requiredExp: 81_400,
    enabled: true,
    source: "session-start",
  });
  const armedDecision = guard.getDecision({ enabled: true });
  assert.equal(armedDecision.blocked, false);
  assert.equal(armedDecision.reason, "experience-level-ceiling-ok");
  assert.equal(armedDecision.state.armedLevel, 19);

  guard.observeAuthoritative({
    level: 20,
    currentExp: 100,
    requiredExp: 100_000,
    enabled: true,
    source: "gs.usrLand.harvest",
  });
  guard.observeAuthoritative({
    level: 20,
    currentExp: 1,
    requiredExp: 100_000,
    enabled: true,
    source: "gs.usr.lazySync",
  });

  const state = guard.getState();
  assert.equal(state.armedLevel, 19);
  assert.equal(state.ceilingLevel, 19);
  assert.equal(state.breached, true);
  assert.equal(state.lastAuthoritativeLevel, 20);
  assert.equal(state.breachEvidence.observedLevel, 20);
  assert.equal(guard.getDecision({ enabled: true }).blocked, true);
});

test("experience level breach survives process restart and a low-exp snapshot on the new level", (t) => {
  const { create, statePath } = withTempGuard(t);
  const first = create();
  first.observeAuthoritative({ level: 21, currentExp: 99_900, requiredExp: 100_000, enabled: true, source: "start" });
  first.observeAuthoritative({ level: 22, currentExp: 3, requiredExp: 120_000, enabled: true, source: "settlement" });

  assert.equal(fs.existsSync(statePath), true);
  const restarted = create();
  assert.equal(restarted.getDecision({ enabled: true }).blocked, true);
  restarted.observeAuthoritative({ level: 22, currentExp: 0, requiredExp: 120_000, enabled: true, source: "restart-login" });
  assert.equal(restarted.getDecision({ enabled: true }).blocked, true);
  assert.equal(restarted.getState().ceilingLevel, 21);
});

test("a level observed by another session is reloaded and blocks the original guard", (t) => {
  const { create } = withTempGuard(t);
  const original = create();
  const otherSession = create();
  original.observeAuthoritative({ level: 30, currentExp: 100, requiredExp: 1_000, enabled: true, source: "original" });
  otherSession.observeAuthoritative({ level: 31, currentExp: 5, requiredExp: 2_000, enabled: true, source: "other-session" });

  const decision = original.getDecision({ enabled: true });
  assert.equal(decision.blocked, true);
  assert.equal(decision.state.breachEvidence.source, "other-session");
});

test("zero-percent mode disables blocking without clearing a stored breach", (t) => {
  const { create } = withTempGuard(t);
  const guard = create();
  guard.observeAuthoritative({ level: 40, currentExp: 999, requiredExp: 1_000, enabled: true, source: "armed" });
  guard.observeAuthoritative({ level: 41, currentExp: 1, requiredExp: 2_000, enabled: true, source: "breach" });

  assert.equal(guard.getDecision({ enabled: false }).blocked, false);
  assert.equal(guard.getState().breached, true);
  assert.equal(guard.getDecision({ enabled: true }).blocked, true);
});

test("only explicit confirmed rearm clears the breach and the new ceiling survives restart", (t) => {
  const { create, statePath } = withTempGuard(t);
  const guard = create();
  guard.observeAuthoritative({ level: 50, currentExp: 900, requiredExp: 1_000, enabled: true, source: "armed" });
  guard.observeAuthoritative({ level: 51, currentExp: 10, requiredExp: 2_000, enabled: true, source: "breach" });

  assert.throws(
    () => createExperienceGuardRearmRequest({
      profileId: "p1",
      statePath,
      expectedStateRevision: guard.getState().stateRevision,
      confirmed: false,
    }),
    (error) => error?.code === "EXPERIENCE_GUARD_REARM_CONFIRMATION_REQUIRED",
  );
  assert.equal(guard.getDecision({ enabled: true }).blocked, true);

  const request = createExperienceGuardRearmRequest({
    profileId: "p1",
    statePath,
    expectedStateRevision: guard.getState().stateRevision,
    confirmed: true,
    requestId: "explicit-rearm",
  });
  guard.observeAuthoritative({
    level: 51,
    currentExp: 11,
    requiredExp: 2_000,
    enabled: true,
    eligibleRearmRequestId: request.requestId,
  });
  const rearmed = guard.getState();
  assert.equal(rearmed.armedLevel, 51);
  assert.equal(rearmed.ceilingLevel, 51);
  assert.equal(rearmed.breached, false);
  assert.equal(rearmed.rearmCount, 1);
  assert.equal(create().getDecision({ enabled: true }).blocked, false);
});

test("experience level guard state is isolated by account path", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "experience-level-guard-accounts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guardA = createPersistentExperienceLevelGuard({ profileId: "a", statePath: path.join(dir, "a.json") });
  const guardB = createPersistentExperienceLevelGuard({ profileId: "b", statePath: path.join(dir, "b.json") });
  guardA.observeAuthoritative({ level: 10, currentExp: 90, requiredExp: 100, enabled: true, source: "a" });
  guardB.observeAuthoritative({ level: 20, currentExp: 10, requiredExp: 100, enabled: true, source: "b" });
  guardA.observeAuthoritative({ level: 11, currentExp: 1, requiredExp: 200, enabled: true, source: "a-breach" });

  assert.equal(guardA.getDecision({ enabled: true }).blocked, true);
  assert.equal(guardB.getDecision({ enabled: true }).blocked, false);
  assert.equal(guardB.getState().armedLevel, 20);
});

test("managed experience guard state resolves outside runtime settings", () => {
  const statePath = resolveExperienceGuardStatePath({
    profileId: "main",
    settingsPath: path.join("C:\\runtime", "settings", "main.json"),
  });
  assert.equal(
    statePath,
    path.resolve("C:\\runtime", "system", "experience-guards", "main.json"),
  );
});

test("control-plane rearm uses revision CAS and applies only after fresh authority", (t) => {
  const { create, statePath } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({ level: 60, currentExp: 999, requiredExp: 1_000, enabled: true });
  guard.observeAuthoritative({ level: 61, currentExp: 1, requiredExp: 2_000, enabled: true });
  const revision = guard.getState().stateRevision;

  assert.throws(
    () => createExperienceGuardRearmRequest({
      profileId: "main",
      statePath,
      expectedStateRevision: revision - 1,
      confirmed: true,
    }),
    (error) => error?.code === "EXPERIENCE_GUARD_REARM_REVISION_CONFLICT",
  );
  const request = createExperienceGuardRearmRequest({
    profileId: "main",
    statePath,
    expectedStateRevision: revision,
    confirmed: true,
    requestId: "rearm-1",
  });
  assert.equal(request.requestId, "rearm-1");
  assert.equal(guard.getDecision({ enabled: true }).blocked, true);

  guard.observeAuthoritative({
    level: 61,
    currentExp: 2,
    requiredExp: 2_000,
    enabled: true,
    source: "post-rearm-authority",
    eligibleRearmRequestId: request.requestId,
  });
  assert.equal(guard.getDecision({ enabled: true }).blocked, false);
  assert.equal(guard.getState().ceilingLevel, 61);
  assert.equal(guard.getState().lastAppliedRearmRequestId, "rearm-1");
  assert.equal(guard.getPendingRearm(), null);
});

test("corrupt persisted state fails closed when enabled but leaves zero-percent mode open", (t) => {
  const { create, statePath } = withTempGuard(t);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "{not-json", "utf8");
  const guard = create();
  assert.equal(guard.getDecision({ enabled: true }).blocked, true);
  assert.equal(guard.getDecision({ enabled: true }).reason, "experience-guard-state-invalid-json");
  assert.equal(guard.getDecision({ enabled: false }).blocked, false);
  assert.equal(fs.readFileSync(statePath, "utf8"), "{not-json");
});

test("rearm waits past a stale lower-level snapshot and applies at the latest authoritative level", (t) => {
  const { create, statePath } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({ level: 30, currentExp: 900, requiredExp: 1_000, enabled: true });
  guard.observeAuthoritative({ level: 31, currentExp: 1, requiredExp: 2_000, enabled: true });
  createExperienceGuardRearmRequest({
    profileId: "main",
    statePath,
    expectedStateRevision: guard.getState().stateRevision,
    confirmed: true,
    requestId: "rearm-stale-authority",
  });

  guard.observeAuthoritative({ level: 30, currentExp: 950, requiredExp: 1_000, enabled: true, source: "stale", eligibleRearmRequestId: "rearm-stale-authority" });
  assert.equal(guard.getDecision({ enabled: true }).blocked, true);
  assert.equal(guard.getState().lastAuthoritativeLevel, 31);
  assert.equal(guard.getPendingRearm().requestId, "rearm-stale-authority");

  guard.observeAuthoritative({ level: 31, currentExp: 2, requiredExp: 2_000, enabled: true, source: "fresh", eligibleRearmRequestId: "rearm-stale-authority" });
  assert.equal(guard.getDecision({ enabled: true }).blocked, false);
  assert.equal(guard.getState().ceilingLevel, 31);
});

test("an accepted rearm remains applicable after ordinary state revision advances", (t) => {
  const { create, statePath } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({ level: 40, currentExp: 900, requiredExp: 1_000, enabled: true });
  guard.observeAuthoritative({ level: 41, currentExp: 1, requiredExp: 2_000, enabled: true });
  const revision = guard.getState().stateRevision;
  createExperienceGuardRearmRequest({
    profileId: "main",
    statePath,
    expectedStateRevision: revision,
    confirmed: true,
    requestId: "rearm-revision-race",
  });
  const advanced = JSON.parse(fs.readFileSync(statePath, "utf8"));
  advanced.stateRevision += 1;
  fs.writeFileSync(statePath, `${JSON.stringify(advanced, null, 2)}\n`, "utf8");

  guard.observeAuthoritative({ level: 41, currentExp: 2, requiredExp: 2_000, enabled: true, eligibleRearmRequestId: "rearm-revision-race" });
  assert.equal(guard.getDecision({ enabled: true }).blocked, false);
  assert.equal(guard.getState().lastAppliedRearmRequestId, "rearm-revision-race");
});

test("a previously initialized guard fails closed if its main state file disappears", (t) => {
  const { create, statePath } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({ level: 50, currentExp: 100, requiredExp: 1_000, enabled: true });
  assert.equal(fs.existsSync(`${statePath}.initialized.json`), true);
  fs.rmSync(statePath);

  const restarted = create();
  assert.equal(restarted.getDecision({ enabled: true }).blocked, true);
  assert.equal(restarted.getDecision({ enabled: true }).reason, "experience-guard-state-missing");
});

test("profile reuse with another authoritative account identity fails closed without overwriting state", (t) => {
  const { create, statePath } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({
    level: 60,
    currentExp: 10,
    requiredExp: 1_000,
    accountUid: "account-a",
    enabled: true,
  });
  const before = fs.readFileSync(statePath, "utf8");
  guard.observeAuthoritative({
    level: 10,
    currentExp: 1,
    requiredExp: 100,
    accountUid: "account-b",
    enabled: true,
  });

  assert.equal(guard.getDecision({ enabled: true }).blocked, true);
  assert.equal(guard.getDecision({ enabled: true }).reason, "experience-guard-account-identity-mismatch");
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
});

test("profile reuse across server partitions fails closed without overwriting state", (t) => {
  const { create, statePath } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({
    level: 60,
    currentExp: 10,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  const before = fs.readFileSync(statePath, "utf8");
  guard.observeAuthoritative({
    level: 10,
    currentExp: 1,
    requiredExp: 100,
    accountUid: "account-a",
    serverIdx: 2,
    enabled: true,
  });

  assert.equal(guard.getDecision({ enabled: true }).blocked, true);
  assert.equal(guard.getDecision({ enabled: true }).reason, "experience-guard-server-identity-mismatch");
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
});

test("a bound persistent identity fails closed when a later authority snapshot omits identity", (t) => {
  const { create, statePath } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({
    level: 60,
    currentExp: 10,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  const before = fs.readFileSync(statePath, "utf8");
  guard.observeAuthoritative({
    level: 60,
    currentExp: 11,
    requiredExp: 1_000,
    enabled: true,
  });

  assert.equal(guard.getDecision({ enabled: true }).blocked, true);
  assert.equal(guard.getDecision({ enabled: true }).reason, "experience-guard-account-identity-mismatch");
  assert.equal(fs.readFileSync(statePath, "utf8"), before);
});

test("a managed guard waits fail-closed for complete authority identity before first arm", (t) => {
  const { statePath } = withTempGuard(t, "main");
  const guard = createPersistentExperienceLevelGuard({
    profileId: "main",
    statePath,
    requireIdentity: true,
  });
  guard.observeAuthoritative({
    level: 60,
    currentExp: 10,
    requiredExp: 1_000,
    enabled: true,
  });
  assert.equal(guard.getDecision({ enabled: true }).blocked, true);
  assert.equal(
    guard.getDecision({ enabled: true }).reason,
    "experience-guard-authority-identity-required",
  );
  assert.equal(fs.existsSync(statePath), false);

  guard.observeAuthoritative({
    level: 60,
    currentExp: 11,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  assert.equal(guard.getDecision({ enabled: true }).blocked, false);
  assert.equal(guard.getState().accountUid, "account-a");
  assert.equal(guard.getState().serverIdx, 1);
});

test("an unresolved protected settlement requires dedicated recovery and explicit outcome", (t) => {
  const { create, statePath } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({
    level: 70,
    currentExp: 100,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
    source: "start",
  });
  guard.beginProtectedAction({ requestId: "reward-1", iface: "gs.usrLand.harvest" });
  guard.markProtectedActionUncertain({ requestId: "reward-1" });

  assert.equal(guard.getDecision({ enabled: true }).blocked, true);
  assert.equal(guard.getDecision({ enabled: true }).reason, "experience-guard-settlement-unresolved");
  assert.equal(fs.existsSync(guard.settlementPendingPath), true);

  assert.throws(
    () => guard.resolveProtectedAction({
      requestId: "reward-1",
      outcome: "rejected",
      source: "untrusted-test",
    }),
    (error) => error?.code === "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_REQUIRED",
  );

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.throws(
    () => createExperienceGuardRearmRequest({
      profileId: "main",
      statePath,
      expectedStateRevision: persisted.stateRevision,
      confirmed: true,
      requestId: "generic-rearm-forbidden",
    }),
    (error) => error?.code === "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_REQUIRED",
  );
  const request = createExperienceGuardSettlementRecoveryRequest({
    profileId: "main",
    statePath,
    pendingRequestId: "reward-1",
    expectedStateRevision: persisted.stateRevision,
    confirmed: true,
    requestId: "recover-settlement",
  });
  guard.resolveProtectedAction({
    requestId: "reward-1",
    outcome: "rejected",
    recoveryRequestId: request.requestId,
    source: "fresh-land-authority",
    reason: "harvest-land-still-mature-matches-before-action",
  });

  assert.equal(guard.getDecision({ enabled: true }).blocked, false);
  assert.equal(guard.getState().settlementResolution.outcome, "rejected");
  assert.equal(guard.getPendingSettlementRecovery(), null);
  assert.equal(fs.existsSync(guard.settlementPendingPath), false);
});

test("legacy settlement recovery requires an operator reason and records its unverified mode", (t) => {
  const { create } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({
    level: 70,
    currentExp: 100,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  guard.beginProtectedAction({
    requestId: "legacy-reward",
    iface: "gs.usrLand.harvest",
    actionArgs: { landId: 1028 },
  });
  guard.markProtectedActionUncertain({ requestId: "legacy-reward", message: "用户停止" });
  const stateRevision = guard.getState().stateRevision;

  assert.throws(
    () => createExperienceGuardSettlementRecoveryRequest({
      profileId: "main",
      statePath: guard.statePath,
      pendingRequestId: "legacy-reward",
      expectedStateRevision: stateRevision,
      confirmed: true,
      legacyUnverified: true,
      requestId: "legacy-recovery-without-reason",
    }),
    (error) => error?.code === "EXPERIENCE_GUARD_SETTLEMENT_LEGACY_OPERATOR_REASON_REQUIRED",
  );

  const operatorReason = "历史请求缺少执行前快照，人工接受远端可能已执行的风险";
  const recovery = createExperienceGuardSettlementRecoveryRequest({
    profileId: "main",
    statePath: guard.statePath,
    pendingRequestId: "legacy-reward",
    expectedStateRevision: stateRevision,
    confirmed: true,
    legacyUnverified: true,
    operatorReason,
    requestId: "legacy-recovery",
  });
  assert.equal(recovery.recoveryMode, "legacy-unverified");
  assert.equal(recovery.operatorReason, operatorReason);

  guard.resolveProtectedAction({
    requestId: "legacy-reward",
    outcome: "rejected",
    recoveryRequestId: recovery.requestId,
    source: "operator-confirmed-legacy-recovery",
    reason: operatorReason,
  });

  assert.equal(guard.getPendingSettlement(), null);
  assert.equal(guard.getDecision({ enabled: true }).blocked, false);
  const resolution = guard.getState().settlementResolution;
  assert.equal(resolution.requestId, "legacy-reward");
  assert.equal(resolution.outcome, "rejected");
  assert.equal(resolution.source, "operator-confirmed-legacy-recovery");
  assert.equal(resolution.reason, operatorReason);
  assert.equal(resolution.recoveryMode, "legacy-unverified");
  assert.equal(resolution.operatorReason, operatorReason);
  assert.match(resolution.resolvedAt, /^2026-08-11T00:00:00\.\d{3}Z$/);
});

test("a user stop before transport send cancels only the durable intent", (t) => {
  const { create } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({
    level: 70,
    currentExp: 100,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  guard.beginProtectedAction({
    requestId: "pre-send-stop",
    iface: "gs.usrLand.harvest",
    actionArgs: { landId: 1028 },
  });
  guard.cancelProtectedActionBeforeSend({
    requestId: "pre-send-stop",
    reason: "user-stopped-before-send",
    message: "用户停止",
  });

  assert.equal(guard.getDecision({ enabled: true }).blocked, false);
  assert.equal(guard.getPendingSettlement(), null);
  assert.equal(guard.getState().settlementResolution.outcome, "cancelled-before-send");
});

test("settlement recovery cannot rebind a persistent guard to another account", (t) => {
  const { create, statePath } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({
    level: 80,
    currentExp: 100,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  guard.beginProtectedAction({ requestId: "reward-a", iface: "gs.usrLand.harvest" });
  guard.markProtectedActionUncertain({ requestId: "reward-a" });
  const persistedBefore = fs.readFileSync(statePath, "utf8");
  const persisted = JSON.parse(persistedBefore);
  const request = createExperienceGuardSettlementRecoveryRequest({
    profileId: "main",
    statePath,
    pendingRequestId: "reward-a",
    expectedStateRevision: persisted.stateRevision,
    confirmed: true,
    requestId: "cross-account-rearm",
  });

  guard.observeAuthoritative({
    level: 10,
    currentExp: 1,
    requiredExp: 100,
    accountUid: "account-b",
    serverIdx: 2,
    enabled: true,
    eligibleRearmRequestId: request.requestId,
  });

  assert.equal(guard.getDecision({ enabled: true }).blocked, true);
  assert.equal(guard.getDecision({ enabled: true }).reason, "experience-guard-account-identity-mismatch");
  assert.equal(fs.readFileSync(statePath, "utf8"), persistedBefore);
  assert.equal(guard.getPendingSettlementRecovery().requestId, "cross-account-rearm");
  assert.equal(fs.existsSync(guard.settlementPendingPath), true);
});

test("a committed recovery idempotently finishes sidecar cleanup after a crash window", (t) => {
  const { create, statePath } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({
    level: 90,
    currentExp: 100,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  guard.beginProtectedAction({ requestId: "reward-crash", iface: "gs.usrLand.harvest" });
  guard.markProtectedActionUncertain({ requestId: "reward-crash" });
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const recovery = createExperienceGuardSettlementRecoveryRequest({
    profileId: "main",
    statePath,
    pendingRequestId: "reward-crash",
    expectedStateRevision: persisted.stateRevision,
    confirmed: true,
    requestId: "rearm-crash-window",
  });

  const committed = {
    ...persisted,
    stateRevision: persisted.stateRevision + 1,
    armedLevel: 90,
    ceilingLevel: 90,
    breached: false,
    invalid: false,
    invalidReason: null,
    rearmCount: persisted.rearmCount + 1,
    lastAppliedRearmRequestId: "rearm-crash-window",
  };
  fs.writeFileSync(statePath, `${JSON.stringify(committed, null, 2)}\n`, "utf8");

  const restarted = create();
  assert.equal(restarted.getDecision({ enabled: true }).blocked, true);
  restarted.resolveProtectedAction({
    requestId: "reward-crash",
    outcome: "rejected",
    recoveryRequestId: recovery.requestId,
    source: "recovery-authority",
    reason: "same-land-mature-fingerprint",
  });

  assert.equal(restarted.getDecision({ enabled: true }).blocked, false);
  assert.equal(restarted.getPendingSettlementRecovery(), null);
  assert.equal(fs.existsSync(restarted.settlementPendingPath), false);
});

test("rearm stays fail-closed and retryable when recovery sidecar cleanup fails", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "experience-level-guard-clear-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const settlementPath = `${statePath}.settlement-pending.json`;
  let failSettlementClear = false;
  const guardedFs = {
    ...fs,
    rmSync(target, options) {
      if (failSettlementClear && path.resolve(target) === path.resolve(settlementPath)) {
        const error = new Error("controlled clear failure");
        error.code = "EACCES";
        throw error;
      }
      return fs.rmSync(target, options);
    },
  };
  const guard = createPersistentExperienceLevelGuard({
    profileId: "main",
    statePath,
    fileSystem: guardedFs,
  });
  guard.observeAuthoritative({
    level: 91,
    currentExp: 100,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  guard.beginProtectedAction({ requestId: "reward-clear", iface: "gs.usrLand.harvest" });
  guard.markProtectedActionUncertain({ requestId: "reward-clear" });
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const recovery = createExperienceGuardSettlementRecoveryRequest({
    profileId: "main",
    statePath,
    pendingRequestId: "reward-clear",
    expectedStateRevision: persisted.stateRevision,
    confirmed: true,
    requestId: "rearm-clear-retry",
  });

  failSettlementClear = true;
  assert.throws(
    () => guard.resolveProtectedAction({
      requestId: "reward-clear",
      outcome: "rejected",
      recoveryRequestId: recovery.requestId,
      source: "recovery-authority",
      reason: "same-land-mature-fingerprint",
    }),
    (error) => error?.code === "EXPERIENCE_GUARD_SETTLEMENT_INTENT_CLEAR_FAILED",
  );
  assert.equal(guard.getDecision({ enabled: true }).blocked, true);
  assert.match(guard.getDecision({ enabled: true }).reason, /experience-guard-settlement-unresolved|experience-guard-settlement-intent-clear-failed:EACCES/);
  assert.equal(guard.getPendingSettlementRecovery().requestId, "rearm-clear-retry");

  failSettlementClear = false;
  guard.resolveProtectedAction({
    requestId: "reward-clear",
    outcome: "rejected",
    recoveryRequestId: recovery.requestId,
    source: "recovery-authority",
    reason: "same-land-mature-fingerprint",
  });
  assert.equal(guard.getDecision({ enabled: true }).blocked, false);
  assert.equal(guard.getPendingSettlementRecovery(), null);
  assert.equal(fs.existsSync(settlementPath), false);
});

function createStaleClockGuard(t, profileId = "main") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "experience-guard-stale-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, `${profileId}.json`);
  let nowMs = Date.parse("2026-08-11T00:00:00.000Z");
  const nowFn = () => nowMs;
  const advance = (ms) => {
    nowMs += ms;
  };
  const create = () => createPersistentExperienceLevelGuard({
    profileId,
    statePath,
    nowFn,
  });
  return { statePath, advance, create };
}

test("a stale settlement-pending residue from an interrupted request stays blocked until authority resolves it", (t) => {
  const { statePath, advance, create } = createStaleClockGuard(t, "main");
  const settlementPath = `${statePath}.settlement-pending.json`;

  // 第一次会话：开始一个收益请求，然后进程被外部中断（用户停止/崩溃），
  // 既不 complete 也不 mark uncertain，settlement-pending 残留。
  const session = create();
  session.observeAuthoritative({
    level: 70,
    currentExp: 100,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  session.beginProtectedAction({ requestId: "interrupted-harvest", iface: "gs.usrLand.harvest" });
  assert.equal(fs.existsSync(settlementPath), true);
  // 丢弃 session 模拟进程退出

  // 时间流逝超过 stale 阈值（默认 5 分钟）
  advance(6 * 60 * 1_000);

  // 重启后的新会话：时间经过不能证明动作是否已结算，仍必须 fail-closed。
  const restarted = create();
  const decision = restarted.getDecision({ enabled: true });
  assert.equal(decision.blocked, true);
  assert.equal(decision.reason, "experience-guard-settlement-unresolved");
  assert.equal(fs.existsSync(settlementPath), true);
});

test("a settlement-pending residue stays fail-closed across time and restart", (t) => {
  const { statePath, advance, create } = createStaleClockGuard(t, "main");
  const settlementPath = `${statePath}.settlement-pending.json`;

  const session = create();
  session.observeAuthoritative({
    level: 70,
    currentExp: 100,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  session.beginProtectedAction({ requestId: "recent-harvest", iface: "gs.usrLand.harvest" });
  // 不推进时间，重启：未过期的残留仍必须 fail-closed（不冒险放行收益动作）
  const restarted = create();
  assert.equal(restarted.getDecision({ enabled: true }).blocked, true);
  assert.equal(
    restarted.getDecision({ enabled: true }).reason,
    "experience-guard-settlement-unresolved",
  );
  assert.equal(fs.existsSync(settlementPath), true);

  // 时间超过阈值后再重启：仍不能用时间代替动作权威核对。
  advance(6 * 60 * 1_000);
  const restartedAgain = create();
  assert.equal(restartedAgain.getDecision({ enabled: true }).blocked, true);
  assert.equal(
    restartedAgain.getDecision({ enabled: true }).reason,
    "experience-guard-settlement-unresolved",
  );
  assert.equal(fs.existsSync(settlementPath), true);
});

test("an unresolved settlement records its action and resolves only after explicit authority proof", (t) => {
  const { statePath, create } = withTempGuard(t, "main");
  const guard = create();
  guard.observeAuthoritative({
    level: 70,
    currentExp: 100,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  guard.beginProtectedAction({
    requestId: "unknown-harvest",
    iface: "gs.usrLand.harvest",
    actionArgs: { landId: 1001 },
  });
  guard.markProtectedActionUncertain({
    requestId: "unknown-harvest",
    category: "settlement-unknown",
    reason: "ws-timeout",
    message: "WS closed while waiting for gs.usrLand.harvest",
  });

  const pending = guard.getPendingSettlement();
  assert.equal(pending.status, "unknown");
  assert.equal(pending.iface, "gs.usrLand.harvest");
  assert.deepEqual(pending.actionArgs, { landId: 1001 });
  assert.equal(pending.failureCategory, "settlement-unknown");

  const restarted = create();
  assert.equal(restarted.getDecision({ enabled: true }).blocked, true);
  assert.throws(
    () => restarted.resolveProtectedAction({
      requestId: "unknown-harvest",
      outcome: "unknown",
      source: "land-refresh",
    }),
    /explicit settlement outcome/i,
  );

  restarted.resolveProtectedAction({
    requestId: "unknown-harvest",
    outcome: "confirmed",
    source: "land-refresh",
    reason: "land-no-longer-mature",
  });
  assert.equal(restarted.getDecision({ enabled: true }).blocked, false);
  assert.equal(restarted.getPendingSettlement(), null);
  assert.equal(fs.existsSync(`${statePath}.settlement-pending.json`), false);
});

test("a normal protected action never leaves stale settlement residue", (t) => {
  const { statePath, advance, create } = createStaleClockGuard(t, "main");
  const settlementPath = `${statePath}.settlement-pending.json`;

  const guard = create();
  guard.observeAuthoritative({
    level: 70,
    currentExp: 100,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  guard.beginProtectedAction({ requestId: "normal-harvest", iface: "gs.usrLand.harvest" });
  guard.completeProtectedAction({ requestId: "normal-harvest" });
  assert.equal(fs.existsSync(settlementPath), false);

  // 即使时间流逝很久，也没有任何残留可被误清理
  advance(60 * 60 * 1_000);
  const decision = guard.getDecision({ enabled: true });
  assert.equal(decision.blocked, false);
  assert.equal(fs.existsSync(settlementPath), false);
});

test("a residue from a previous session stays blocked after this guard already read disk", (t) => {
  const { statePath, advance, create } = createStaleClockGuard(t, "main");
  const settlementPath = `${statePath}.settlement-pending.json`;
  const currentMs = () => Date.parse("2026-08-11T00:00:00.000Z");

  // guard 已初始化（hadPersistedState 已置 true，模拟同服务进程内已运行过的实例）
  const guard = create();
  guard.observeAuthoritative({
    level: 70,
    currentExp: 100,
    requiredExp: 1_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  assert.equal(guard.getDecision({ enabled: true }).blocked, false);

  // 外部（另一会话）残留 settlement-pending：请求被外部中断，
  // 且已超过旧的时间阈值。时间本身不能证明动作是否已结算。
  advance(10 * 60 * 1_000);
  fs.writeFileSync(settlementPath, JSON.stringify({
    version: 1,
    profileId: "main",
    requestId: "external-interrupted",
    iface: "gs.usrLand.harvest",
    stateRevision: 1,
    startedAt: new Date(currentMs() - 6 * 60 * 1_000).toISOString(),
  }), "utf8");

  // 再次读取（模拟下一次权威同步/读盘）：仍必须进入 unresolved，等待权威核对。
  const decision = guard.getDecision({ enabled: true });
  assert.equal(decision.blocked, true);
  assert.equal(decision.reason, "experience-guard-settlement-unresolved");
  assert.equal(fs.existsSync(settlementPath), true);
});
