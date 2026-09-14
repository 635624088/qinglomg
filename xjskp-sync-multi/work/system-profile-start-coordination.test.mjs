import test from "node:test";
import assert from "node:assert/strict";

import { createProfileOperationCoordinator } from "./system/profile-operation-coordinator.mjs";
import { createProfileStartCoordination } from "./system/profile-start-coordination.mjs";

const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function coordinationToken(record) {
  return {
    profileId: record.profileId,
    settingsEpoch: record.settingsEpoch,
    updatedAt: record.updatedAt,
    desiredState: record.desiredState,
    recoveryStatus: record.recoveryStatus,
    restartAttempt: record.restartAttempt,
    nextRetryAt: record.nextRetryAt,
  };
}

function snapshot(overrides = {}) {
  const settings = {
    autoReceiveWaterwheelBuckets: true,
    skipWaterwheelVideoBuckets: false,
    autoSubmitOrdinaryResidentOrdersForLevelUp: false,
    autoSubmitCyclicStoryOrders: false,
    cyclicStoryOnlyHighestExperienceOrder: false,
    experienceGuardThresholdPercent: 90,
    flowerRackTargetArtId: null,
    materialShopMidnightRefreshEnabled: false,
    materialShopRefreshWindowStart: "23:50",
    materialShopRefreshMaxCostYuanbao: 4,
    pearlHireItemReserveCount: 100,
    teamOrderTriggerProtectionEnabled: true,
    teamOrderPaidRenewProtectionEnabled: true,
    teamOrderGuardMultiplier: 1,
  };
  return {
    settings,
    settingsEpoch: EPOCH_A,
    settingsRevision: 2,
    settingsKeyRevisions: Object.fromEntries(Object.keys(settings).map((key) => [key, 2])),
    ...overrides,
  };
}

function createHarness(options = {}) {
  const coordinator = createProfileOperationCoordinator();
  const events = [];
  const desired = new Map();
  let sequence = 0;
  let currentSnapshot = options.snapshot || snapshot();
  const startupGate = options.startupGate || deferred();
  const exitGate = options.exitGate || deferred();
  let runnerCalls = 0;
  let runtimeCalls = 0;
  let runnerToken = null;

  const desiredRunStore = {
    async readForProtocol(profileId) {
      const value = desired.get(profileId);
      return value ? structuredClone(value) : null;
    },
    async writeForProtocol(profileId, patch) {
      const record = {
        ...(desired.get(profileId) || {}),
        profileId,
        mode: "loop",
        ...patch,
        updatedAt: `sequence-${++sequence}`,
      };
      desired.set(profileId, record);
      events.push(["desired-write", profileId, record.desiredState, record.recoveryStatus, record.settingsEpoch]);
      return structuredClone(record);
    },
    async conditionalWriteForProtocol(profileId, condition = {}) {
      if (
        options.conditionalWriteError
        && condition.patch?.recoveryStatus === options.conditionalWriteError.status
      ) {
        throw options.conditionalWriteError.error;
      }
      const current = desired.get(profileId) || null;
      const matched = Boolean(
        current
        && current.updatedAt === condition.expectedUpdatedAt
        && current.settingsEpoch === condition.expectedSettingsEpoch
        && current.desiredState === condition.expectedDesiredState
        && current.recoveryStatus === condition.expectedRecoveryStatus
        && current.restartAttempt === condition.expectedRestartAttempt
        && current.nextRetryAt === condition.expectedNextRetryAt
      );
      if (!matched) return { matched: false, record: current ? structuredClone(current) : null };
      const record = await this.writeForProtocol(profileId, condition.patch);
      return { matched: true, record };
    },
  };

  const runner = {
    async beginAutomationAlreadyCoordinated(profile, mode, beginOptions = {}) {
      runnerCalls += 1;
      if (options.runnerError) throw options.runnerError;
      runnerToken = beginOptions.coordinationToken || null;
      events.push(["runner-begin", profile.id, mode, profile.settingsRevision]);
      return {
        profileId: profile.id,
        mode,
        active: { profileId: profile.id, mode },
        confirmStartup: () => startupGate.promise,
        waitForExit: () => exitGate.promise,
        async updateCoordinationToken(value) {
          runnerToken = value;
        },
      };
    },
  };

  const runtimeSettingsStore = {
    async reconcileVersionedForProtocol(profileId, expectedSnapshot) {
      runtimeCalls += 1;
      events.push(["runtime", profileId, expectedSnapshot.settingsEpoch, expectedSnapshot.settingsRevision]);
      if (options.runtimeError) throw options.runtimeError;
      return { repaired: true };
    },
  };

  const coordination = createProfileStartCoordination({
    runCanonical: (profileId, operation) => coordinator.runCanonical(profileId, operation),
    profileStore: {
      async readSettingsStateForProtocol(profileId) {
        events.push(["profile-read", profileId, currentSnapshot.settingsRevision]);
        return {
          profile: { id: profileId, label: profileId },
          snapshot: structuredClone(currentSnapshot),
        };
      },
    },
    runtimeSettingsStore,
    desiredRunStore,
    canonicalMigration: {
      async listCanonicalIds() {
        return [...desired.keys()].sort();
      },
      async reconcile(profileId) {
        events.push(["migration", profileId]);
        if (options.migrationErrors?.[profileId]) throw options.migrationErrors[profileId];
        return options.migrationResult || { status: "clear", canonicalId: profileId, migrated: false };
      },
    },
    loadExecutableProfile: async (profileId) => ({
      id: profileId,
      label: profileId,
      env: { PC_USER_ID: profileId },
      settings: { pearlHireItemReserveCount: -1 },
    }),
    runner,
    now: options.now,
  });

  return {
    coordinator,
    coordination,
    desired,
    desiredRunStore,
    events,
    startupGate,
    exitGate,
    setSnapshot(value) {
      currentSnapshot = value;
    },
    getRunnerCalls: () => runnerCalls,
    getRuntimeCalls: () => runtimeCalls,
    getRunnerToken: () => runnerToken,
  };
}

test("canonical coordinator serializes aliases, keeps other profiles parallel, and rejects empty keys", async () => {
  const coordinator = createProfileOperationCoordinator();
  const firstGate = deferred();
  const events = [];
  const first = coordinator.runCanonical("MAIN", async () => {
    events.push("main-start");
    await firstGate.promise;
    events.push("main-end");
  });
  const second = coordinator.runCanonical("main", async () => events.push("main-second"));
  await coordinator.runCanonical("other", async () => events.push("other"));
  assert.deepEqual(events, ["main-start", "other"]);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["main-start", "other", "main-end", "main-second"]);

  const dashGate = deferred();
  const dashed = [];
  const a = coordinator.runCanonical("a--b", async () => {
    dashed.push("a");
    await dashGate.promise;
  });
  const b = coordinator.runCanonical("a-b", async () => dashed.push("b"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(dashed, ["a"]);
  dashGate.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(dashed, ["a", "b"]);
  assert.throws(
    () => coordinator.runCanonical("---", async () => {}),
    (error) => error?.code === "INVALID_PROFILE_ID_CANONICAL_FORM",
  );
});

test("manual loop binds the lock-time epoch, reconciles runtime, and waits for startup outside Q", async () => {
  const harness = createHarness();
  const started = harness.coordination.startManualLoop("MAIN");
  while (!harness.events.some(([event]) => event === "runner-begin")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  let secondEntered = false;
  await harness.coordinator.runCanonical("main", async () => {
    secondEntered = true;
  });
  assert.equal(secondEntered, true);
  assert.deepEqual(
    harness.events.slice(0, 5).map(([event]) => event),
    ["migration", "profile-read", "desired-write", "runtime", "runner-begin"],
  );
  assert.equal(harness.desired.get("main").settingsEpoch, EPOCH_A);
  assert.equal(harness.desired.get("main").recoveryStatus, "starting");
  harness.startupGate.resolve({ profileId: "main", startupState: "ready" });
  const result = await started;
  assert.equal(result.startupState, "ready");
  assert.equal(harness.desired.get("main").recoveryStatus, "running");
  assert.equal(harness.getRunnerToken().recoveryStatus, "running");
});

test("manual runtime failure blocks the bound intent and never registers a worker", async () => {
  const error = new Error("controlled runtime failure");
  error.code = "PROFILE_SETTINGS_RUNTIME_DEGRADED";
  const harness = createHarness({ runtimeError: error });
  await assert.rejects(harness.coordination.startManualLoop("main"), /controlled runtime failure/);
  assert.equal(harness.getRunnerCalls(), 0);
  assert.equal(harness.desired.get("main").desiredState, "stopped");
  assert.equal(harness.desired.get("main").recoveryStatus, "blocked");
  assert.equal(harness.desired.get("main").settingsEpoch, EPOCH_A);
});

for (const [label, desiredRecord, reason] of [
  ["missing epoch", { desiredState: "running", recoveryStatus: "scheduled" }, "settings-epoch-confirmation-required"],
  ["old epoch", { desiredState: "running", recoveryStatus: "scheduled", settingsEpoch: EPOCH_B }, "profile-recreated"],
]) {
  test(`recovery with ${label} blocks before runtime reconciliation`, async () => {
    const harness = createHarness();
    await harness.desiredRunStore.writeForProtocol("main", desiredRecord);
    const result = await harness.coordination.recover({
      profileId: "MAIN",
      attempt: 1,
      cause: {},
      coordinationToken: coordinationToken(harness.desired.get("main")),
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, reason);
    assert.equal(harness.getRuntimeCalls(), 0);
    assert.equal(harness.getRunnerCalls(), 0);
    assert.equal(harness.desired.get("main").desiredState, "stopped");
    assert.equal(harness.desired.get("main").lastReason, reason);
    assert.equal(Object.hasOwn(harness.desired.get("main"), "settingsEpoch"), Object.hasOwn(desiredRecord, "settingsEpoch"));
  });
}

test("recovery rereads current profile and desired in Q, then confirms startup outside Q", async () => {
  const harness = createHarness({ snapshot: snapshot({ settingsRevision: 7 }) });
  await harness.desiredRunStore.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "scheduled",
    settingsEpoch: EPOCH_A,
  });
  const recovery = harness.coordination.recover({
    profileId: "MAIN",
    attempt: 2,
    cause: { reason: "network" },
    coordinationToken: coordinationToken(harness.desired.get("main")),
  });
  while (!harness.events.some(([event]) => event === "runner-begin")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await harness.coordinator.runCanonical("main", async () => harness.events.push(["q-after-begin"]));
  assert.equal(harness.events.find(([event]) => event === "runner-begin")[3], 7);
  assert.equal(harness.events.find(([event]) => event === "runtime")[3], 7);
  harness.startupGate.resolve({ profileId: "main", startupState: "ready" });
  const result = await recovery;
  assert.equal(result.startupState, "ready");
  assert.equal(harness.desired.get("main").recoveryStatus, "running");
});

test("recovery runtime failure conditionally blocks the current intent without rejecting the timer callback", async () => {
  const error = Object.assign(new Error("controlled recovery runtime failure"), {
    code: "PROFILE_SETTINGS_RUNTIME_DEGRADED",
  });
  const harness = createHarness({ runtimeError: error });
  await harness.desiredRunStore.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "scheduled",
    settingsEpoch: EPOCH_A,
  });

  const result = await harness.coordination.recover({
    profileId: "main",
    attempt: 2,
    cause: { reason: "network" },
    coordinationToken: coordinationToken(harness.desired.get("main")),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.reason, "PROFILE_SETTINGS_RUNTIME_DEGRADED");
  assert.equal(harness.getRunnerCalls(), 0);
  assert.equal(harness.desired.get("main").desiredState, "stopped");
  assert.equal(harness.desired.get("main").recoveryStatus, "blocked");
});

test("recovery admission pressure returns retry without blocking the running intent", async () => {
  const error = Object.assign(new Error("controlled admission pressure"), {
    code: "MAX_PARALLEL_TASKS_REACHED",
  });
  const harness = createHarness({ runnerError: error });
  await harness.desiredRunStore.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "scheduled",
    settingsEpoch: EPOCH_A,
  });

  const result = await harness.coordination.handleRecoveryEvent({
    phase: "attempt",
    profileId: "main",
    attempt: 2,
    cause: { reason: "network" },
    coordinationToken: coordinationToken(harness.desired.get("main")),
  });

  assert.equal(result.status, "retry");
  assert.equal(result.code, "MAX_PARALLEL_TASKS_REACHED");
  assert.equal(harness.desired.get("main").desiredState, "running");
  assert.equal(harness.desired.get("main").recoveryStatus, "starting");
});

test("transient recovery startup confirmation returns retry without blocking the starting intent", async () => {
  const harness = createHarness();
  await harness.desiredRunStore.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "scheduled",
    settingsEpoch: EPOCH_A,
  });
  const recovery = harness.coordination.recover({
    profileId: "main",
    attempt: 2,
    cause: { reason: "network" },
    coordinationToken: coordinationToken(harness.desired.get("main")),
  });
  while (!harness.events.some(([event]) => event === "runner-begin")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const error = Object.assign(new Error("controlled network startup failure"), {
    category: "network",
  });
  harness.startupGate.reject(error);

  const result = await recovery;
  assert.equal(result.status, "retry");
  assert.equal(result.category, "network");
  assert.equal(result.coordinationToken.recoveryStatus, "starting");
  assert.equal(harness.desired.get("main").desiredState, "running");
  assert.equal(harness.desired.get("main").recoveryStatus, "starting");
});

test("external recovery lifecycle schedules, resets, and terminally blocks with conditional writes", async () => {
  const harness = createHarness({
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  await harness.desiredRunStore.writeForProtocol("main", {
    desiredState: "running",
    restartAttempt: 3,
    recoveryStatus: "running",
    settingsEpoch: EPOCH_A,
  });

  const scheduled = await harness.coordination.handleRecoveryEvent({
    phase: "schedule",
    profileId: "main",
    cause: { reason: "network", category: "network" },
    delayMs: 25,
    coordinationToken: coordinationToken(harness.desired.get("main")),
  });
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.attempt, 4);
  assert.equal(scheduled.nextRetryAt, "2026-08-10T00:00:00.025Z");
  assert.equal(harness.desired.get("main").recoveryStatus, "scheduled");

  const reset = await harness.coordination.handleRecoveryEvent({
    phase: "healthy-reset",
    profileId: "main",
    coordinationToken: scheduled.coordinationToken,
  });
  assert.equal(reset.status, "reset");
  assert.equal(harness.desired.get("main").restartAttempt, 0);

  const terminal = await harness.coordination.handleRecoveryEvent({
    phase: "terminal",
    profileId: "main",
    cause: { reason: "session-expired", category: "login-state" },
    coordinationToken: reset.coordinationToken,
  });
  assert.equal(terminal.status, "blocked");
  assert.equal(harness.desired.get("main").desiredState, "stopped");
  assert.equal(harness.desired.get("main").lastReason, "session-expired");
});

test("a stale session-expiry token cannot schedule or block a newer desired intent", async () => {
  const harness = createHarness();
  await harness.desiredRunStore.writeForProtocol("main", {
    desiredState: "running",
    restartAttempt: 0,
    recoveryStatus: "running",
    settingsEpoch: EPOCH_A,
  });
  const staleToken = coordinationToken(harness.desired.get("main"));
  await harness.desiredRunStore.writeForProtocol("main", {
    desiredState: "running",
    restartAttempt: 0,
    recoveryStatus: "running",
    settingsEpoch: EPOCH_A,
  });

  const scheduled = await harness.coordination.handleRecoveryEvent({
    phase: "schedule",
    profileId: "main",
    cause: { reason: "session-expired", category: "login-state" },
    coordinationToken: staleToken,
  });
  const terminal = await harness.coordination.handleRecoveryEvent({
    phase: "terminal",
    profileId: "main",
    cause: { reason: "session-expired", category: "login-state" },
    coordinationToken: staleToken,
  });

  assert.equal(scheduled.status, "skipped");
  assert.equal(scheduled.reason, "desired-intent-changed");
  assert.equal(terminal.status, "skipped");
  assert.equal(terminal.reason, "desired-intent-changed");
  assert.equal(harness.desired.get("main").desiredState, "running");
});

test("external restore inspection blocks legacy epochs before runtime and stop uses a conditional transition", async () => {
  const harness = createHarness();
  await harness.desiredRunStore.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "scheduled",
    settingsEpoch: EPOCH_B,
  });

  const restore = await harness.coordination.handleRecoveryEvent({
    phase: "restore-inspect",
    profileId: "MAIN",
  });
  assert.equal(restore.status, "blocked");
  assert.equal(restore.reason, "profile-recreated");
  assert.equal(harness.getRuntimeCalls(), 0);

  await harness.desiredRunStore.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "running",
    settingsEpoch: EPOCH_A,
  });
  const stopped = await harness.coordination.handleRecoveryEvent({
    phase: "stop",
    profileId: "main",
  });
  assert.equal(stopped.status, "stopped");
  assert.equal(harness.desired.get("main").desiredState, "stopped");
  assert.equal(harness.desired.get("main").lastReason, "user-stopped");
});

test("global restore inspection returns only current-epoch running records", async () => {
  const harness = createHarness();
  await harness.desiredRunStore.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "running",
    settingsEpoch: EPOCH_A,
  });
  const inspected = await harness.coordination.handleRecoveryEvent({
    phase: "restore-inspect",
  });
  assert.equal(inspected.status, "inspected");
  assert.deepEqual(inspected.records.map((record) => record.profileId), ["main"]);
  assert.equal(harness.getRuntimeCalls(), 0);
});

test("global restore isolates one damaged profile and still returns healthy candidates", async () => {
  const damaged = Object.assign(new Error("controlled damaged profile"), {
    code: "PROFILE_SETTINGS_REVISION_INVALID",
  });
  const harness = createHarness({ migrationErrors: { bad: damaged } });
  for (const profileId of ["bad", "good"]) {
    await harness.desiredRunStore.writeForProtocol(profileId, {
      desiredState: "running",
      recoveryStatus: "running",
      settingsEpoch: EPOCH_A,
    });
  }

  const inspected = await harness.coordination.handleRecoveryEvent({ phase: "restore-inspect" });
  assert.deepEqual(inspected.records.map((record) => record.profileId), ["good"]);
  assert.deepEqual(inspected.blocked, [{
    profileId: "bad",
    reason: "PROFILE_SETTINGS_REVISION_INVALID",
  }]);
});

test("startup success settlement failure does not rewrite the live worker intent as blocked", async () => {
  const persistenceError = Object.assign(new Error("controlled success settlement failure"), {
    code: "DESIRED_WRITE_FAILED",
  });
  const harness = createHarness({
    conditionalWriteError: { status: "running", error: persistenceError },
  });
  const start = harness.coordination.startManualLoop("main");
  while (!harness.events.some(([event]) => event === "runner-begin")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  harness.startupGate.resolve({ profileId: "main", startupState: "ready" });

  await assert.rejects(start, /controlled success settlement failure/);
  assert.equal(harness.desired.get("main").desiredState, "running");
  assert.equal(harness.desired.get("main").recoveryStatus, "starting");
});

test("late startup success cannot overwrite a user-stopped desired record", async () => {
  const harness = createHarness();
  const start = harness.coordination.startManualLoop("main");
  while (!harness.events.some(([event]) => event === "runner-begin")) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  await harness.desiredRunStore.writeForProtocol("main", {
    desiredState: "stopped",
    recoveryStatus: "stopped",
    settingsEpoch: EPOCH_A,
    lastReason: "user-stopped",
  });
  harness.startupGate.resolve({ profileId: "main", startupState: "ready" });
  await start;
  assert.equal(harness.desired.get("main").desiredState, "stopped");
  assert.equal(harness.desired.get("main").lastReason, "user-stopped");
});

test("once and orders reconcile the latest runtime but wait for completion outside Q", async () => {
  for (const mode of ["once", "orders"]) {
    const harness = createHarness();
    const run = harness.coordination.runManualOnce("main", mode);
    while (!harness.events.some(([event]) => event === "runner-begin")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await harness.coordinator.runCanonical("main", async () => harness.events.push(["q-after-begin"]));
    assert.equal(harness.desired.size, 0);
    harness.exitGate.resolve({ profileId: "main", mode, exitCode: 0 });
    assert.equal((await run).mode, mode);
  }
});
