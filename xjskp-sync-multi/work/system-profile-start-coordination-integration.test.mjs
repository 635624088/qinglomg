import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createDesiredRunStore } from "./system/automation-recovery.mjs";
import { createProfileCanonicalMigration } from "./system/profile-canonical-migration.mjs";
import { createProfileOperationCoordinator } from "./system/profile-operation-coordinator.mjs";
import { createProfileStartCoordination } from "./system/profile-start-coordination.mjs";
import { DEFAULT_PROFILE_SETTINGS, createProfileStore } from "./system/profile-store.mjs";
import { createAutomationRunner } from "./system/process-manager.mjs";
import { clearActiveTask, readActiveTask } from "./system/runtime-lock.mjs";
import { createRuntimeSettingsStore } from "./system/runtime-settings-store.mjs";

const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";

test("real T4 stores bind manual start and publish the authoritative runtime before runner admission", async (t) => {
  const fixture = await createFixture(t);
  await fixture.runtime.write("main", { ...DEFAULT_PROFILE_SETTINGS, pearlHireItemReserveCount: 7 });
  await fixture.runtime.drain("main");
  await fixture.desired.write("main", {
    desiredState: "stopped",
    recoveryStatus: "stopped",
    settingsEpoch: EPOCH_B,
  });

  let runnerCalls = 0;
  fixture.runner.beginAutomationAlreadyCoordinated = async (profile, mode) => {
    runnerCalls += 1;
    const runtime = await fixture.runtime.readVersionedForProtocol("main");
    const desired = await fixture.desired.readForProtocol("main");
    assert.equal(mode, "loop");
    assert.equal(profile.settingsEpoch, EPOCH_A);
    assert.equal(runtime._meta.settingsEpoch, EPOCH_A);
    assert.equal(runtime._meta.settingsRevision, profile.settingsRevision);
    assert.equal(runtime.pearlHireItemReserveCount, DEFAULT_PROFILE_SETTINGS.pearlHireItemReserveCount);
    assert.equal(desired.settingsEpoch, EPOCH_A);
    assert.equal(desired.recoveryStatus, "starting");
    return ticket(profile.id, mode);
  };

  const result = await fixture.coordination.startManualLoop("MAIN");
  assert.equal(result.profileId, "main");
  assert.equal(runnerCalls, 1);
  const desired = await fixture.desired.readForProtocol("main");
  assert.equal(desired.desiredState, "running");
  assert.equal(desired.recoveryStatus, "running");
  assert.equal(desired.settingsEpoch, EPOCH_A);
});

test("real T4 restore blocks an old incarnation before touching runtime and manual start is the only rebind", async (t) => {
  const fixture = await createFixture(t);
  await fixture.runtime.write("main", { ...DEFAULT_PROFILE_SETTINGS, pearlHireItemReserveCount: 7 });
  await fixture.runtime.drain("main");
  const runtimePath = fixture.runtime.settingsPath("main");
  const runtimeBefore = await fs.readFile(runtimePath, "utf8");
  await fixture.desired.write("main", {
    desiredState: "running",
    recoveryStatus: "scheduled",
    settingsEpoch: EPOCH_B,
  });

  const inspected = await fixture.coordination.handleRecoveryEvent({ phase: "restore-inspect" });
  assert.equal(inspected.status, "inspected");
  assert.deepEqual(inspected.records, []);
  assert.equal(await fs.readFile(runtimePath, "utf8"), runtimeBefore);
  const blocked = await fixture.desired.readForProtocol("main");
  assert.equal(blocked.desiredState, "stopped");
  assert.equal(blocked.recoveryStatus, "blocked");
  assert.equal(blocked.settingsEpoch, EPOCH_B);
  assert.equal(blocked.lastReason, "profile-recreated");

  fixture.runner.beginAutomationAlreadyCoordinated = async (profile, mode) => ticket(profile.id, mode);
  await fixture.coordination.startManualLoop("main");
  const rebound = await fixture.desired.readForProtocol("main");
  assert.equal(rebound.settingsEpoch, EPOCH_A);
  assert.equal(rebound.recoveryStatus, "running");
});

test("real coordinated manual startup failure blocks desired intent before process recovery can schedule", async (t) => {
  const fixture = await createRealRunnerFixture(t, { startupConfirmMs: 1_000 });
  const started = fixture.coordination.startManualLoop("main");
  const worker = await fixture.workerCreated;
  worker.emit("message", {
    type: "automationExit",
    classification: { reason: "network", category: "network", message: "network" },
  });
  worker.emit("exit", 1);

  await assert.rejects(started, (error) => error?.code === "AUTOMATION_START_FAILED");
  const desired = await fixture.desired.readForProtocol("main");
  assert.equal(desired.desiredState, "stopped");
  assert.equal(desired.recoveryStatus, "blocked");
  assert.equal(desired.lastReason, "network");
  assert.equal(fixture.recoveryCalls.filter((request) => request.phase === "schedule").length, 0);
  assert.equal(fixture.recoveryTimers.length, 0);
  await fixture.runner.shutdown();
});

test("real coordinated startup session expiry schedules one relogin before readiness and honors the recovery token", async (t) => {
  const fixture = await createRealRunnerFixture(t, { startupConfirmMs: 1_000 });
  const started = fixture.coordination.startManualLoop("main");
  const worker = await fixture.workerCreated;
  worker.emit("message", {
    type: "automationExit",
    classification: { reason: "session-expired", category: "login-state", exitCode: 42 },
  });
  worker.emit("exit", 42);

  await assert.rejects(started, (error) => error?.code === "AUTOMATION_START_FAILED");
  const scheduled = await fixture.desired.readForProtocol("main");
  assert.equal(scheduled.desiredState, "running");
  assert.equal(scheduled.recoveryStatus, "scheduled");
  assert.equal(scheduled.restartAttempt, 1);
  assert.equal(fixture.recoveryCalls.filter((request) => request.phase === "schedule").length, 1);
  assert.equal(fixture.recoveryTimers.length, 1);

  const relogin = fixture.recoveryTimers[0].callback();
  while (fixture.workers.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  fixture.workers[1].emit("message", { type: "automationReady", step: "ready" });
  await relogin;
  const running = await fixture.desired.readForProtocol("main");
  assert.equal(running.desiredState, "running");
  assert.equal(running.recoveryStatus, "running");
  assert.equal(fixture.recoveryCalls.filter((request) => request.phase === "schedule").length, 1);
  await fixture.runner.shutdown();
});

test("real coordinated startup session expiry does not recover after its intent is stopped", async (t) => {
  const fixture = await createRealRunnerFixture(t, { startupConfirmMs: 1_000 });
  const started = fixture.coordination.startManualLoop("main");
  const worker = await fixture.workerCreated;
  await fixture.desired.writeForProtocol("main", {
    desiredState: "stopped",
    recoveryStatus: "stopped",
    restartAttempt: 0,
    nextRetryAt: null,
  });
  worker.emit("message", {
    type: "automationExit",
    classification: { reason: "session-expired", category: "login-state", exitCode: 42 },
  });
  worker.emit("exit", 42);

  await assert.rejects(started, (error) => error?.code === "AUTOMATION_START_FAILED");
  assert.equal(fixture.recoveryCalls.filter((request) => request.phase === "schedule").length, 1);
  assert.equal(fixture.recoveryTimers.length, 0);
  const stopped = await fixture.desired.readForProtocol("main");
  assert.equal(stopped.desiredState, "stopped");
  await fixture.runner.shutdown();
});

test("real coordinated startup session expiry does not recover after its settings epoch changes", async (t) => {
  const fixture = await createRealRunnerFixture(t, { startupConfirmMs: 1_000 });
  const started = fixture.coordination.startManualLoop("main");
  const worker = await fixture.workerCreated;
  await fixture.desired.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "starting",
    restartAttempt: 0,
    nextRetryAt: null,
    settingsEpoch: EPOCH_B,
  });
  worker.emit("message", {
    type: "automationExit",
    classification: { reason: "session-expired", category: "login-state", exitCode: 42 },
  });
  worker.emit("exit", 42);

  await assert.rejects(started, (error) => error?.code === "AUTOMATION_START_FAILED");
  assert.equal(fixture.recoveryCalls.filter((request) => request.phase === "schedule").length, 1);
  assert.equal(fixture.recoveryTimers.length, 0);
  const current = await fixture.desired.readForProtocol("main");
  assert.equal(current.settingsEpoch, EPOCH_B);
  assert.equal(current.recoveryStatus, "starting");
  await fixture.runner.shutdown();
});

test("zero-delay real coordination transfers the running token after an early exit without recreating active task", async (t) => {
  let releaseRunningSettlement;
  let markRunningSettlement;
  const runningSettlementGate = new Promise((resolve) => { releaseRunningSettlement = resolve; });
  const runningSettlementStarted = new Promise((resolve) => { markRunningSettlement = resolve; });
  const fixture = await createRealRunnerFixture(t, {
    startupConfirmMs: 0,
    beforeRunningSettlement: async () => {
      markRunningSettlement();
      await runningSettlementGate;
    },
  });
  const started = fixture.coordination.startManualLoop("main");
  started.catch(() => {});
  const worker = await withTimeout(fixture.workerCreated, 2_000, "worker admission did not start");
  await withTimeout(runningSettlementStarted, 2_000, "running settlement did not start");
  worker.emit("message", {
    type: "automationExit",
    classification: { reason: "network", category: "network", message: "network" },
  });
  worker.emit("exit", 1);
  await withTimeout(fixture.activeTaskCleared, 2_000, "active task cleanup did not finish");
  releaseRunningSettlement();
  await withTimeout(started, 2_000, "running-token handoff deadlocked with deferred recovery");

  const schedules = fixture.recoveryCalls.filter((request) => request.phase === "schedule");
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].coordinationToken.recoveryStatus, "running");
  assert.equal(fixture.recoveryTimers.length, 1);
  assert.equal(await readActiveTask(fixture.runtimeDir, "main"), null);
  await fixture.runner.shutdown();
});

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-t4-start-integration-"));
  const accountsDir = path.join(root, "accounts");
  const runtimeDir = path.join(root, "runtime");
  await fs.mkdir(accountsDir, { recursive: true });
  await fs.writeFile(path.join(accountsDir, "main.json"), `${JSON.stringify({
    version: 1,
    id: "main",
    label: "main",
    settings: { ...DEFAULT_PROFILE_SETTINGS },
    secrets: {},
  }, null, 2)}\n`, "utf8");
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const profileStore = createProfileStore({
    accountsDir,
    createSettingsEpoch: () => EPOCH_A,
    protect: (value) => value,
    unprotect: (value) => value,
  });
  const runtime = createRuntimeSettingsStore({ runtimeDir });
  let clock = 0;
  const desired = createDesiredRunStore({
    runtimeDir,
    now: () => new Date(Date.UTC(2026, 7, 10, 0, 0, clock++)),
  });
  const migration = createProfileCanonicalMigration({
    runtimeSettingsStore: runtime,
    desiredRunStore: desired,
    runtimeDir,
    isAliasActive: async () => false,
  });
  const coordinator = createProfileOperationCoordinator();
  const runner = { beginAutomationAlreadyCoordinated: async () => { throw new Error("runner not configured"); } };
  const coordination = createProfileStartCoordination({
    runCanonical: (profileId, operation) => coordinator.runCanonical(profileId, operation),
    profileStore,
    runtimeSettingsStore: runtime,
    desiredRunStore: desired,
    canonicalMigration: migration,
    loadExecutableProfile: async (profileId) => ({
      id: profileId,
      env: { PC_USER_ID: profileId },
    }),
    runner,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  return { root, runtimeDir, profileStore, runtime, desired, migration, coordinator, runner, coordination };
}

async function createRealRunnerFixture(t, options = {}) {
  const fixture = await createFixture(t);
  let resolveWorker;
  let resolveActiveTaskCleared;
  const workerCreated = new Promise((resolve) => { resolveWorker = resolve; });
  const activeTaskCleared = new Promise((resolve) => { resolveActiveTaskCleared = resolve; });
  const recoveryCalls = [];
  const recoveryTimers = [];
  const workers = [];
  const desired = options.beforeRunningSettlement
    ? {
      ...fixture.desired,
      conditionalWriteForProtocol: async (profileId, request) => {
        if (request.patch?.recoveryStatus === "running") {
          await options.beforeRunningSettlement();
        }
        return fixture.desired.conditionalWriteForProtocol(profileId, request);
      },
    }
    : fixture.desired;
  let coordination;
  const runner = createAutomationRunner({
    rootDir: fixture.root,
    runtimeDir: fixture.runtimeDir,
    runtimeMode: "worker",
    processProvider: async () => [],
    workerFactory: () => {
      const worker = new EventEmitter();
      worker.threadId = 101;
      worker.pid = process.pid;
      worker.postMessage = () => {};
      worker.terminate = async () => {
        setImmediate(() => worker.emit("exit", 1));
        return 1;
      };
      workers.push(worker);
      resolveWorker(worker);
      return worker;
    },
    runtimeSettingsStore: fixture.runtime,
    desiredRunStore: desired,
    recoveryCoordinator: async (request) => {
      recoveryCalls.push(request);
      return coordination.handleRecoveryEvent(request);
    },
    clearActiveTaskFn: async (runtimeDir, profileId) => {
      await clearActiveTask(runtimeDir, profileId);
      resolveActiveTaskCleared();
    },
    setRecoveryTimerFn: (callback, delayMs) => {
      const timer = { callback, delayMs, unref() {} };
      recoveryTimers.push(timer);
      return timer;
    },
    clearRecoveryTimerFn: () => {},
    startupConfirmMs: options.startupConfirmMs,
    watchdogIntervalMs: 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  coordination = createProfileStartCoordination({
    runCanonical: (profileId, operation) => fixture.coordinator.runCanonical(profileId, operation),
    profileStore: fixture.profileStore,
    runtimeSettingsStore: fixture.runtime,
    desiredRunStore: desired,
    canonicalMigration: fixture.migration,
    loadExecutableProfile: async (profileId) => ({
      id: profileId,
      env: { PC_USER_ID: profileId },
    }),
    runner,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  return {
    ...fixture,
    desired,
    runner,
    coordination,
    coordinator: fixture.coordinator,
    workerCreated,
    activeTaskCleared,
    recoveryCalls,
    recoveryTimers,
    workers,
  };
}

function ticket(profileId, mode) {
  return {
    profileId,
    mode,
    active: { profileId, mode },
    confirmStartup: async () => ({ profileId, mode, startupState: "ready" }),
    waitForExit: async () => ({ profileId, mode, exitCode: 0 }),
  };
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
