import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createAutomationRunner } from "./system/process-manager.mjs";
import { writeActiveTask } from "./system/runtime-lock.mjs";

test("already-coordinated starts return post-Q tickets without legacy runtime or desired writes", async () => {
  const fixture = await createFixture();
  try {
    const tickets = [];
    for (const mode of ["loop", "once", "orders"]) {
      const profile = makeProfile(`profile-${mode}`);
      const ticket = await fixture.runner.beginAutomationAlreadyCoordinated(profile, mode);
      tickets.push(ticket);

      assert.equal(ticket.profileId, profile.id);
      assert.equal(ticket.mode, mode);
      assert.equal(ticket.active.profileId, profile.id);
      assert.equal(ticket.active.mode, mode);
      assert.equal(typeof ticket.confirmStartup, "function");
      assert.equal(typeof ticket.waitForExit, "function");
    }

    assert.equal(fixture.runtimeWrites.length, 0);
    assert.equal(fixture.runtimeDrains.length, 0);
    assert.equal(fixture.desiredWrites.length, 0);
    assert.deepEqual(
      fixture.activeWrites.map((record) => [record.profileId, record.mode]),
      [["profile-loop", "loop"], ["profile-once", "once"], ["profile-orders", "orders"]],
    );

    await assert.rejects(
      fixture.runner.beginAutomationAlreadyCoordinated(makeProfile("profile-loop"), "loop"),
      (err) => err?.code === "ACTIVE_AUTOMATION_RUNNING",
    );

    const loopConfirmation = tickets[0].confirmStartup();
    fixture.workers[0].emit("message", { type: "automationReady", step: "ready" });
    const confirmed = await loopConfirmation;
    assert.equal(confirmed.startupState, "ready");

    const exits = tickets.map((ticket) => ticket.waitForExit());
    fixture.workers.forEach((worker) => worker.emit("exit", 0));
    const summaries = await Promise.all(exits);
    assert.deepEqual(summaries.map((summary) => summary.exitCode), [0, 0, 0]);
  } finally {
    await fixture.cleanup();
  }
});

test("injected recovery coordinator owns the recovery attempt and receives the already-coordinated seam", async () => {
  const calls = [];
  const fixture = await createFixture({
    desiredRecords: [makeDesiredRun("recover-me")],
    profileLoader: async () => {
      throw new Error("legacy profileLoader must not run when recoveryCoordinator is injected");
    },
    recoveryCoordinator: async (request) => {
      calls.push(request);
      if (request.phase === "restore-inspect") {
        return { status: "inspected", records: [makeDesiredRun("recover-me")] };
      }
      if (request.phase === "schedule") return scheduledRecovery(request, 1);
      return { status: "started", profileId: request.profileId };
    },
  });
  try {
    assert.deepEqual(await fixture.runner.restoreDesiredLoops(), { desired: 1, scheduled: 1 });
    assert.equal(fixture.recoveryTimers.length, 1);
    assert.deepEqual(await fixture.recoveryTimers[0].callback(), {
      status: "started",
      profileId: "recover-me",
    });

    assert.deepEqual(calls.map((call) => call.phase), ["restore-inspect", "schedule", "attempt"]);
    assert.equal(calls[2].profileId, "recover-me");
    assert.equal(calls[2].attempt, 1);
    assert.equal(calls[2].cause.reason, "server-restart");
    assert.equal(typeof calls[2].beginAutomationAlreadyCoordinated, "function");
    assert.notEqual(
      calls[2].beginAutomationAlreadyCoordinated,
      fixture.runner.beginAutomationAlreadyCoordinated,
    );
    assert.equal(fixture.workers.length, 0);
    assert.equal(fixture.runtimeWrites.length, 0);
    assert.equal(fixture.desiredReads.length, 0);
    assert.equal(fixture.desiredLists.length, 0);
    assert.equal(fixture.desiredWrites.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("injected recovery coordinator failures bypass legacy desired writes and recovery scheduling", async () => {
  const coordinatedError = Object.assign(new Error("coordinated recovery failed"), {
    code: "MAX_PARALLEL_TASKS_REACHED",
  });
  const fixture = await createFixture({
    desiredRecords: [makeDesiredRun("coordinated-failure")],
    profileLoader: async () => {
      throw new Error("legacy profileLoader must not run when recoveryCoordinator is injected");
    },
    recoveryCoordinator: async (request) => {
      if (request.phase === "restore-inspect") {
        return { status: "inspected", records: [makeDesiredRun("coordinated-failure")] };
      }
      if (request.phase === "schedule") return scheduledRecovery(request, 1);
      throw coordinatedError;
    },
  });
  try {
    assert.deepEqual(await fixture.runner.restoreDesiredLoops(), { desired: 1, scheduled: 1 });
    const writesBeforeAttempt = fixture.desiredWrites.length;
    const timersBeforeAttempt = fixture.recoveryTimers.length;

    const result = await fixture.recoveryTimers[0].callback();

    assert.equal(result.status, "failed");
    assert.equal(result.phase, "attempt");
    assert.equal(result.code, "MAX_PARALLEL_TASKS_REACHED");
    assert.equal(fixture.desiredWrites.length, writesBeforeAttempt);
    assert.equal(fixture.recoveryTimers.length, timersBeforeAttempt);
    assert.equal(fixture.warnings.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("injected exit phases schedule recoverable runs and settle terminal runs without desired reads or writes", async () => {
  const calls = [];
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      if (request.phase === "schedule") return scheduledRecovery(request, 2);
      return { status: "settled", profileId: request.profileId };
    },
  });
  try {
    const recoverable = await fixture.runner.beginAutomationAlreadyCoordinated(
      makeProfile("recoverable-exit"),
      "loop",
    );
    const terminal = await fixture.runner.beginAutomationAlreadyCoordinated(
      makeProfile("terminal-exit"),
      "loop",
    );
    const confirmations = [recoverable.confirmStartup(), terminal.confirmStartup()];
    fixture.workers[0].emit("message", { type: "automationReady", step: "ready" });
    fixture.workers[1].emit("message", { type: "automationReady", step: "ready" });
    await Promise.all(confirmations);
    await recoverable.updateCoordinationToken(undefined);
    await terminal.updateCoordinationToken(undefined);
    const waits = [recoverable.waitForExit(), terminal.waitForExit()];
    fixture.workers[0].emit("message", {
      type: "automationExit",
      classification: { reason: "network", category: "network", message: "network" },
    });
    fixture.workers[1].emit("message", {
      type: "automationExit",
      classification: { reason: "session-expired", category: "account", message: "expired" },
    });
    fixture.workers[0].emit("exit", 1);
    fixture.workers[1].emit("exit", 42);
    await Promise.all(waits);

    assert.deepEqual(calls.map((call) => call.phase).sort(), ["schedule", "terminal"]);
    const scheduled = calls.find((call) => call.phase === "schedule");
    const terminalCall = calls.find((call) => call.phase === "terminal");
    assert.equal(scheduled.profileId, "recoverable-exit");
    assert.equal(scheduled.cause.reason, "network");
    assert.equal(terminalCall.profileId, "terminal-exit");
    assert.equal(terminalCall.cause.reason, "session-expired");
    assert.equal(fixture.recoveryTimers.length, 1);
    assert.equal(fixture.desiredReads.length, 0);
    assert.equal(fixture.desiredWrites.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("injected persisted exit recovery schedules through the phase callback only", async () => {
  const calls = [];
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      return request.phase === "schedule"
        ? scheduledRecovery(request, 3)
        : { status: "settled" };
    },
  });
  try {
    const profileId = "persisted-exit";
    await writeActiveTask(fixture.runtimeDir, {
      profileId,
      mode: "loop",
      runtimeMode: "process",
      pid: 987654,
      rootDir: fixture.tempRoot,
      statusDir: path.join(fixture.runtimeDir, "status", profileId),
      logDir: path.join(fixture.runtimeDir, "logs", profileId),
      logPath: path.join(fixture.runtimeDir, "logs", profileId, "auto.log"),
      startedAt: "2026-08-09T23:00:00.000Z",
    });

    await fixture.runner.runtime();

    assert.equal(calls[0].phase, "schedule");
    assert.equal(calls[0].profileId, profileId);
    assert.equal(calls[0].cause.reason, "pid-not-found");
    assert.equal(fixture.recoveryTimers.length, 1);
    assert.equal(fixture.desiredReads.length, 0);
    assert.equal(fixture.desiredWrites.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("injected healthy reset and stop phases never use the legacy desired store", async () => {
  const calls = [];
  const fixture = await createFixture({
    gracefulStopMs: 0,
    recoveryHealthyResetMs: 10 * 60 * 1_000,
    recoveryCoordinator: async (request) => {
      calls.push(request);
      if (request.phase === "terminal") return { status: "settled" };
      if (request.phase === "stop") return { status: "stopped", stopped: true };
      return { status: "reset" };
    },
  });
  try {
    const ticket = await fixture.runner.beginAutomationAlreadyCoordinated(makeProfile("healthy-stop"), "loop");
    const confirmation = ticket.confirmStartup();
    fixture.workers[0].emit("message", { type: "automationReady", step: "ready" });
    await confirmation;
    await ticket.updateCoordinationToken(undefined);
    fixture.workers[0].emit("message", {
      type: "automationProgress",
      profileId: "healthy-stop",
      at: "2026-08-10T00:11:00.000Z",
      step: "healthy-progress",
    });
    await fixture.runner.snapshot();
    await fixture.runner.stop("healthy-stop");

    assert.deepEqual(
      calls.map((call) => call.phase),
      ["healthy-reset", "terminal", "stop"],
    );
    assert.equal(fixture.desiredReads.length, 0);
    assert.equal(fixture.desiredWrites.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("injected attempt retry is rescheduled through the external schedule phase", async () => {
  const calls = [];
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      if (request.phase === "restore-inspect") {
        return { status: "inspected", records: [makeDesiredRun("retry-me")] };
      }
      if (request.phase === "schedule") {
        return scheduledRecovery(request, calls.filter((call) => call.phase === "schedule").length);
      }
      return { status: "retry", reason: "max-parallel-tasks", category: "runtime" };
    },
  });
  try {
    await fixture.runner.restoreDesiredLoops();
    const result = await fixture.recoveryTimers[0].callback();

    assert.equal(result.status, "scheduled");
    assert.deepEqual(
      calls.map((call) => call.phase),
      ["restore-inspect", "schedule", "attempt", "schedule"],
    );
    assert.equal(fixture.recoveryTimers.length, 2);
    assert.equal(fixture.desiredReads.length, 0);
    assert.equal(fixture.desiredWrites.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("refreshed coordination token is persisted and used by the later loop exit", async () => {
  const calls = [];
  const startingToken = { profileId: "token-loop", epoch: 4, status: "starting" };
  const runningToken = { profileId: "token-loop", epoch: 4, status: "running" };
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      return request.phase === "schedule"
        ? { ...scheduledRecovery(request, 1), coordinationToken: request.coordinationToken }
        : { status: "settled" };
    },
  });
  try {
    const ticket = await fixture.runner.beginAutomationAlreadyCoordinated(
      makeProfile("token-loop"),
      "loop",
      { coordinationToken: startingToken },
    );
    await ticket.updateCoordinationToken(runningToken);
    const confirmation = ticket.confirmStartup();
    fixture.workers[0].emit("message", { type: "automationReady", step: "ready" });
    await confirmation;
    assert.deepEqual(fixture.activeWrites.at(-1).coordinationToken, runningToken);

    const exit = ticket.waitForExit();
    fixture.workers[0].emit("message", {
      type: "automationExit",
      classification: { reason: "network", category: "network", message: "network" },
    });
    fixture.workers[0].emit("exit", 1);
    await exit;

    const scheduled = calls.find((request) => request.phase === "schedule");
    assert.deepEqual(scheduled.coordinationToken, runningToken);
  } finally {
    await fixture.cleanup();
  }
});

test("a stale run exit keeps its own token and cannot borrow a newer intent token", async () => {
  const scheduleCalls = [];
  const staleToken = { profileId: "late-exit", epoch: 7, status: "running" };
  const newerToken = { profileId: "late-exit", epoch: 8, status: "running" };
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      if (request.phase === "schedule") scheduleCalls.push(request);
      return scheduledRecovery(request, 1);
    },
  });
  try {
    const stale = await fixture.runner.beginAutomationAlreadyCoordinated(
      makeProfile("late-exit"),
      "loop",
      { coordinationToken: staleToken },
    );
    const confirmation = stale.confirmStartup();
    fixture.workers[0].emit("message", { type: "automationReady", step: "ready" });
    await confirmation;
    await stale.updateCoordinationToken(staleToken);
    const wait = stale.waitForExit();
    fixture.workers[0].emit("message", {
      type: "automationExit",
      classification: { reason: "network", category: "network", message: "network" },
    });
    fixture.workers[0].emit("exit", 1);
    await wait;

    assert.deepEqual(scheduleCalls[0].coordinationToken, staleToken);
    assert.notDeepEqual(scheduleCalls[0].coordinationToken, newerToken);
  } finally {
    await fixture.cleanup();
  }
});

test("duplicate coordinated schedules share one callback and one timer per profile", async () => {
  const calls = [];
  let releaseSchedule;
  let markScheduleStarted;
  const scheduleGate = new Promise((resolve) => { releaseSchedule = resolve; });
  const scheduleStarted = new Promise((resolve) => { markScheduleStarted = resolve; });
  const token = { profileId: "singleflight", epoch: 9, status: "running" };
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      if (request.phase === "restore-inspect") {
        return { status: "inspected", records: [{ ...makeDesiredRun("singleflight"), coordinationToken: token }] };
      }
      if (request.phase === "schedule") {
        markScheduleStarted();
        await scheduleGate;
        return { ...scheduledRecovery(request, 1), coordinationToken: token };
      }
      return { status: "started" };
    },
  });
  try {
    const first = fixture.runner.restoreDesiredLoops();
    const second = fixture.runner.restoreDesiredLoops();
    await scheduleStarted;
    assert.equal(calls.filter((request) => request.phase === "schedule").length, 1);
    releaseSchedule();
    const restored = await Promise.all([first, second]);
    assert.deepEqual(restored.map((result) => result.desired), [1, 1]);
    assert.deepEqual(restored.map((result) => result.scheduled).sort(), [0, 1]);
    assert.equal(fixture.recoveryTimers.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("restore isolates a malformed profile exit record and still schedules later profiles", async () => {
  const calls = [];
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      if (request.phase === "restore-inspect") {
        return {
          status: "inspected",
          records: [makeDesiredRun("broken-restore"), makeDesiredRun("healthy-restore")],
        };
      }
      return scheduledRecovery(request, 1);
    },
  });
  try {
    const exitsDir = path.join(fixture.runtimeDir, "system", "last-task-exits");
    await mkdir(exitsDir, { recursive: true });
    await writeFile(path.join(exitsDir, "broken-restore.json"), "{not-json", "utf8");

    assert.deepEqual(await fixture.runner.restoreDesiredLoops(), { desired: 2, scheduled: 1 });
    assert.deepEqual(
      calls.filter((request) => request.phase === "schedule").map((request) => request.profileId),
      ["healthy-restore"],
    );
    assert.equal(fixture.recoveryTimers.length, 1);
    assert.match(fixture.warnings[0], /restore-profile failed for profile broken-restore/);
  } finally {
    await fixture.cleanup();
  }
});

test("persisted coordination token survives active-task reconciliation and recovery attempt", async () => {
  const calls = [];
  const token = { profileId: "persisted-token", epoch: 11, status: "running" };
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      if (request.phase === "schedule") {
        return { ...scheduledRecovery(request, 2), coordinationToken: request.coordinationToken };
      }
      return { status: "started" };
    },
  });
  try {
    const profileId = "persisted-token";
    await writeActiveTask(fixture.runtimeDir, {
      profileId,
      mode: "loop",
      runtimeMode: "process",
      pid: 987655,
      rootDir: fixture.tempRoot,
      statusDir: path.join(fixture.runtimeDir, "status", profileId),
      logDir: path.join(fixture.runtimeDir, "logs", profileId),
      logPath: path.join(fixture.runtimeDir, "logs", profileId, "auto.log"),
      startedAt: "2026-08-09T23:00:00.000Z",
      coordinationToken: token,
    });

    await fixture.runner.runtime();
    assert.deepEqual(calls[0].coordinationToken, token);
    await fixture.recoveryTimers[0].callback();
    assert.deepEqual(calls.find((request) => request.phase === "attempt").coordinationToken, token);
  } finally {
    await fixture.cleanup();
  }
});

test("a second persisted session expiry settles only loop intent with its persisted token", async () => {
  const calls = [];
  const token = { profileId: "expired-loop", epoch: 14, status: "running", restartAttempt: 1 };
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      return { status: "settled" };
    },
  });
  try {
    for (const [profileId, mode, coordinationToken] of [
      ["expired-loop", "loop", token],
      ["expired-once", "once", { profileId: "expired-once", epoch: 2 }],
    ]) {
      const statusDir = path.join(fixture.runtimeDir, "status", profileId);
      await mkdir(statusDir, { recursive: true });
      await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
        summary: {
          automationStopped: {
            reason: "session-expired",
            category: "account",
            message: "expired",
          },
        },
      }), "utf8");
      await writeActiveTask(fixture.runtimeDir, {
        profileId,
        mode,
        runtimeMode: "process",
        pid: 987656,
        rootDir: fixture.tempRoot,
        statusDir,
        logDir: path.join(fixture.runtimeDir, "logs", profileId),
        logPath: path.join(fixture.runtimeDir, "logs", profileId, "auto.log"),
        startedAt: "2026-08-09T23:00:00.000Z",
        coordinationToken,
      });
    }

    await fixture.runner.runtime();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].phase, "terminal");
    assert.equal(calls[0].profileId, "expired-loop");
    assert.deepEqual(calls[0].coordinationToken, token);
  } finally {
    await fixture.cleanup();
  }
});

test("a first persisted session expiry schedules one relogin with its persisted token", async () => {
  const calls = [];
  const token = { profileId: "expired-first", epoch: 15, status: "running", restartAttempt: 0 };
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      return request.phase === "schedule"
        ? { ...scheduledRecovery(request, 1), coordinationToken: request.coordinationToken }
        : { status: "settled" };
    },
  });
  try {
    const profileId = "expired-first";
    const statusDir = path.join(fixture.runtimeDir, "status", profileId);
    await mkdir(statusDir, { recursive: true });
    await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
      summary: { automationStopped: { reason: "session-expired", category: "login-state" } },
    }), "utf8");
    await writeActiveTask(fixture.runtimeDir, {
      profileId,
      mode: "loop",
      runtimeMode: "process",
      pid: 987657,
      rootDir: fixture.tempRoot,
      statusDir,
      logDir: path.join(fixture.runtimeDir, "logs", profileId),
      logPath: path.join(fixture.runtimeDir, "logs", profileId, "auto.log"),
      startedAt: "2026-08-09T23:00:00.000Z",
      coordinationToken: token,
    });

    await fixture.runner.runtime();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].phase, "schedule");
    assert.deepEqual(calls[0].coordinationToken, token);
    assert.equal(fixture.recoveryTimers.length, 1);
    assert.equal(fixture.recoveryTimers[0].delayMs, 2_000);
  } finally {
    await fixture.cleanup();
  }
});

test("once and orders exits never enter loop recovery phases", async () => {
  const calls = [];
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      return scheduledRecovery(request, 1);
    },
  });
  try {
    const once = await fixture.runner.beginAutomationAlreadyCoordinated(makeProfile("once-exit"), "once");
    const orders = await fixture.runner.beginAutomationAlreadyCoordinated(makeProfile("orders-exit"), "orders");
    const waits = [once.waitForExit(), orders.waitForExit()];
    fixture.workers.forEach((worker) => worker.emit("exit", 0));
    await Promise.all(waits);
    assert.deepEqual(calls, []);
    assert.equal(fixture.recoveryTimers.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("manual coordinated startup failure is owned by confirmation and never schedules recovery", async () => {
  const calls = [];
  const fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      return scheduledRecovery(request, 1);
    },
  });
  try {
    const ticket = await fixture.runner.beginAutomationAlreadyCoordinated(
      makeProfile("manual-startup-exit"),
      "loop",
      { coordinationToken: { profileId: "manual-startup-exit", epoch: 15 } },
    );
    const confirmation = ticket.confirmStartup();
    fixture.workers[0].emit("message", {
      type: "automationExit",
      classification: { reason: "network", category: "network", message: "network" },
    });
    fixture.workers[0].emit("exit", 1);

    await assert.rejects(confirmation, (error) => error?.code === "AUTOMATION_START_FAILED");
    assert.deepEqual(calls, []);
    assert.equal(fixture.recoveryTimers.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("zero-delay confirmation defers exit recovery until running-token ownership transfer", async () => {
  const calls = [];
  const startingToken = { profileId: "zero-delay-handoff", epoch: 17, status: "starting" };
  const runningToken = { profileId: "zero-delay-handoff", epoch: 17, status: "running" };
  const fixture = await createFixture({
    startupConfirmMs: 0,
    recoveryCoordinator: async (request) => {
      calls.push(request);
      return { ...scheduledRecovery(request, 1), coordinationToken: request.coordinationToken };
    },
  });
  try {
    const ticket = await fixture.runner.beginAutomationAlreadyCoordinated(
      makeProfile("zero-delay-handoff"),
      "loop",
      { coordinationToken: startingToken },
    );
    await ticket.confirmStartup();
    const exit = ticket.waitForExit();
    fixture.workers[0].emit("message", {
      type: "automationExit",
      classification: { reason: "network", category: "network", message: "network" },
    });
    fixture.workers[0].emit("exit", 1);
    await exit;

    assert.deepEqual(calls, []);
    assert.equal(fixture.recoveryTimers.length, 0);
    const writesAfterFinalize = fixture.activeWrites.length;

    assert.equal(await ticket.updateCoordinationToken(runningToken), false);
    assert.equal(fixture.activeWrites.length, writesAfterFinalize);
    assert.equal(await ticket.flushDeferredRecovery(), true);
    assert.equal(await ticket.flushDeferredRecovery(), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].phase, "schedule");
    assert.deepEqual(calls[0].coordinationToken, runningToken);
    assert.equal(fixture.recoveryTimers.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("recovery-origin startup failure returns retry before creating the next recovery timer", async () => {
  const calls = [];
  const token = { profileId: "recovery-startup-exit", epoch: 16, status: "scheduled" };
  let fixture;
  fixture = await createFixture({
    recoveryCoordinator: async (request) => {
      calls.push(request);
      if (request.phase === "restore-inspect") {
        return {
          status: "inspected",
          records: [{ ...makeDesiredRun("recovery-startup-exit"), coordinationToken: token }],
        };
      }
      if (request.phase === "schedule") {
        return { ...scheduledRecovery(request, calls.filter((call) => call.phase === "schedule").length), coordinationToken: token };
      }
      if (request.phase === "attempt") {
        const ticket = await request.beginAutomationAlreadyCoordinated(
          makeProfile(request.profileId),
          "loop",
          { coordinationToken: token },
        );
        const confirmation = ticket.confirmStartup();
        const worker = fixture.workers.at(-1);
        worker.emit("message", {
          type: "automationExit",
          classification: { reason: "network", category: "network", message: "network" },
        });
        worker.emit("exit", 1);
        await assert.rejects(confirmation, (error) => error?.code === "AUTOMATION_START_FAILED");
        return {
          status: "retry",
          reason: "startup-confirmation-failed",
          category: "runtime",
          coordinationToken: token,
        };
      }
      return { status: "settled" };
    },
  });
  try {
    await fixture.runner.restoreDesiredLoops();
    const result = await fixture.recoveryTimers[0].callback();

    assert.equal(result.status, "scheduled");
    const schedules = calls.filter((request) => request.phase === "schedule");
    assert.equal(schedules.length, 2);
    assert.equal(schedules[1].cause.reason, "startup-confirmation-failed");
    assert.equal(fixture.recoveryTimers.length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("an old finalize keeps same-profile admission closed until its active-task cleanup ends", async () => {
  let releaseClear;
  let markClearStarted;
  const clearGate = new Promise((resolve) => { releaseClear = resolve; });
  const clearStarted = new Promise((resolve) => { markClearStarted = resolve; });
  const fixture = await createFixture({
    clearActiveTaskFn: async () => {
      markClearStarted();
      await clearGate;
    },
    recoveryCoordinator: async (request) => (
      request.phase === "schedule" ? scheduledRecovery(request, 1) : { status: "settled" }
    ),
  });
  try {
    const oldTicket = await fixture.runner.beginAutomationAlreadyCoordinated(
      makeProfile("cleanup-race"),
      "loop",
      { coordinationToken: { profileId: "cleanup-race", epoch: 12 } },
    );
    const oldExit = oldTicket.waitForExit();
    fixture.workers[0].emit("exit", 0);
    await clearStarted;

    await assert.rejects(
      fixture.runner.beginAutomationAlreadyCoordinated(
        makeProfile("cleanup-race"),
        "loop",
        { coordinationToken: { profileId: "cleanup-race", epoch: 13 } },
      ),
      (error) => error?.code === "ACTIVE_AUTOMATION_RUNNING",
    );

    releaseClear();
    await oldExit;
    const newTicket = await fixture.runner.beginAutomationAlreadyCoordinated(
      makeProfile("cleanup-race"),
      "loop",
      { coordinationToken: { profileId: "cleanup-race", epoch: 13 } },
    );
    assert.equal(newTicket.profileId, "cleanup-race");
    assert.deepEqual(fixture.activeWrites.at(-1).coordinationToken, {
      profileId: "cleanup-race",
      epoch: 13,
    });
  } finally {
    releaseClear();
    await fixture.cleanup();
  }
});

test("recovery without an injected coordinator preserves the legacy profileLoader and runtime-write path", async () => {
  const loadedProfiles = [];
  const fixture = await createFixture({
    startupConfirmMs: 0,
    desiredRecords: [makeDesiredRun("legacy-recovery")],
    profileLoader: async (profileId) => {
      loadedProfiles.push(profileId);
      return makeProfile(profileId);
    },
  });
  try {
    assert.deepEqual(await fixture.runner.restoreDesiredLoops(), { desired: 1, scheduled: 1 });
    await fixture.recoveryTimers[0].callback();

    assert.deepEqual(loadedProfiles, ["legacy-recovery"]);
    assert.equal(fixture.workers.length, 1);
    assert.deepEqual(fixture.runtimeWrites.map((item) => item.profileId), ["legacy-recovery"]);
    assert.deepEqual(fixture.runtimeDrains, ["legacy-recovery"]);

    const running = await fixture.desiredRunStore.read("legacy-recovery");
    assert.equal(running.desiredState, "running");
    assert.equal(running.recoveryStatus, "running");

    fixture.workers[0].emit("exit", 0);
    await fixture.runner.shutdown();
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture(options = {}) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "xjskp-t4-runner-seam-"));
  const runtimeDir = path.join(tempRoot, "runtime");
  const workers = [];
  const activeWrites = [];
  const runtimeWrites = [];
  const runtimeDrains = [];
  const recoveryTimers = [];
  const warnings = [];
  const desiredRunStore = createMemoryDesiredRunStore(options.desiredRecords || []);
  let nextThreadId = 100;

  const runner = createAutomationRunner({
    rootDir: tempRoot,
    runtimeDir,
    runtimeMode: "worker",
    processProvider: options.processProvider || (async () => []),
    workerFactory: () => {
      const worker = new EventEmitter();
      worker.threadId = nextThreadId++;
      worker.pid = process.pid;
      worker.postMessage = () => {};
      worker.terminate = async () => {
        setImmediate(() => worker.emit("exit", 1));
        return 1;
      };
      workers.push(worker);
      return worker;
    },
    runtimeSettingsStore: {
      settingsPath: (profileId) => path.join(runtimeDir, "settings", `${profileId}.json`),
      write: async (profileId, settings) => runtimeWrites.push({ profileId, settings }),
      drain: async (profileId) => runtimeDrains.push(profileId),
    },
    desiredRunStore,
    profileLoader: options.profileLoader,
    recoveryCoordinator: options.recoveryCoordinator,
    writeActiveTaskFn: async (_runtimeDir, record) => activeWrites.push(record),
    clearActiveTaskFn: options.clearActiveTaskFn || (async () => {}),
    writeLastTaskExitFn: async () => {},
    setRecoveryTimerFn: (callback, delayMs) => {
      const timer = { callback, delayMs, unref() {} };
      recoveryTimers.push(timer);
      return timer;
    },
    clearRecoveryTimerFn: () => {},
    warnFn: (message) => warnings.push(message),
    startupConfirmMs: options.startupConfirmMs ?? 1_000,
    gracefulStopMs: options.gracefulStopMs,
    recoveryHealthyResetMs: options.recoveryHealthyResetMs,
    watchdogIntervalMs: 0,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  });

  return {
    tempRoot,
    runtimeDir,
    runner,
    workers,
    activeWrites,
    runtimeWrites,
    runtimeDrains,
    desiredWrites: desiredRunStore.writes,
    desiredReads: desiredRunStore.reads,
    desiredLists: desiredRunStore.lists,
    desiredRunStore,
    recoveryTimers,
    warnings,
    cleanup: async () => {
      for (const worker of workers) {
        if (worker.listenerCount("exit") > 0) worker.emit("exit", 0);
      }
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

function createMemoryDesiredRunStore(initialRecords) {
  const records = new Map(initialRecords.map((record) => [record.profileId, { ...record }]));
  const writes = [];
  const reads = [];
  const lists = [];
  return {
    writes,
    reads,
    lists,
    async read(profileId) {
      reads.push(profileId);
      const record = records.get(profileId);
      return record ? { ...record } : null;
    },
    async list() {
      lists.push(true);
      return Array.from(records.values(), (record) => ({ ...record }));
    },
    async write(profileId, patch) {
      writes.push({ profileId, patch: { ...patch } });
      const previous = records.get(profileId) || makeDesiredRun(profileId);
      const next = { ...previous, ...patch, profileId };
      records.set(profileId, next);
      return { ...next };
    },
  };
}

function makeProfile(id) {
  return {
    id,
    env: {
      CTOKEN: `ct-${id}`,
      PC_USER_ID: `pc-user-${id}`,
      PC_TOKEN: `pc-${id}`,
      BABI_TOKEN: `babi-${id}`,
      OPEN_ID: `open-${id}`,
    },
    settings: { forceLoop: true },
  };
}

function makeDesiredRun(profileId) {
  return {
    profileId,
    mode: "loop",
    desiredState: "running",
    restartAttempt: 0,
    recoveryStatus: "running",
    nextRetryAt: null,
    lastReason: null,
  };
}

function scheduledRecovery(request, attempt) {
  const delayMs = request.delayMs ?? 2_000;
  return {
    status: "scheduled",
    attempt,
    delayMs,
    nextRetryAt: new Date(Date.parse("2026-08-10T00:00:00.000Z") + delayMs).toISOString(),
  };
}
