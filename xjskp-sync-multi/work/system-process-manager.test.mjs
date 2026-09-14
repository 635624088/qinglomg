import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildAutomationEnv,
  createAutomationRunner,
  detectLegacyAutomationProcesses,
  getActionForMode,
  getMaxParallelTasks,
} from "./system/process-manager.mjs";
import {
  readActiveTask,
  readActiveTasks,
  readLastTaskExit,
  readLastTaskExits,
  writeActiveTask,
} from "./system/runtime-lock.mjs";
import {
  readAutomationStopRequest,
  writeAutomationStopRequest,
} from "./automation-stop.mjs";
import { createTeamOrderRunId } from "./team-order-archive.mjs";
import {
  createTeamOrderSessionRuntime,
  finalizeUserStopped,
} from "./inspect-garden-dryrun.mjs";
import { parseAutomationProgressLine } from "./system/automation-progress.mjs";
import {
  createDesiredRunStore,
  shouldAutoRecover,
} from "./system/automation-recovery.mjs";

test("detectLegacyAutomationProcesses ignores self and known managed child but reports old loops", () => {
  const rootDir = "E:\\00__company_code\\Codex\\xjskp";
  const nodeScriptPath = path.join(rootDir, "work", "inspect-garden-dryrun.mjs");
  const runScriptPath = path.join(rootDir, "work", "run-auto-plant.ps1");
  const processes = [
    { ProcessId: 100, Name: "powershell.exe", CommandLine: `powershell -File "${runScriptPath}" -Loop` },
    { ProcessId: 101, Name: "node.exe", CommandLine: `"C:\\node\\node.exe" "${nodeScriptPath}"` },
    { ProcessId: 102, Name: "node.exe", CommandLine: `"C:\\node\\node.exe" "${nodeScriptPath}"` },
    { ProcessId: 103, Name: "powershell.exe", CommandLine: "powershell -File unrelated.ps1" },
  ];

  const legacy = detectLegacyAutomationProcesses({
    processes,
    selfPid: 100,
    managedPids: new Set([102]),
    nodeScriptPath,
    runScriptPath,
  });

  assert.deepEqual(legacy.map((item) => item.pid), [101]);
  assert.equal(legacy[0].name, "node.exe");
});

test("buildAutomationEnv routes one profile into isolated runtime paths", () => {
  const env = buildAutomationEnv({
    profileEnv: {
      CTOKEN: "ct",
      PC_USER_ID: "2088",
      PC_TOKEN: "pc",
      BABI_TOKEN: "babi",
      OPEN_ID: "open",
      STATIC_CONFIG_PATH: "E:\\unsafe-profile-override.text",
    },
    mode: "orders",
    statusDir: "runtime/status/main",
    logPath: "runtime/logs/main/auto.log",
    profileId: "main",
    settingsPath: "runtime/settings/main.json",
    runtimeDir: "runtime",
    baseEnv: { PATH: "C:\\node", STATIC_CONFIG_PATH: "E:\\unsafe-parent-override.text" },
  });

  assert.equal(env.ACTION, "orders-status");
  assert.equal(env.SUMMARY_ONLY, "1");
  assert.equal(env.STATUS_DOC_DIR, "runtime/status/main");
  assert.equal(env.STATUS_JSON_PATH, path.join("runtime/status/main", "garden-status.json"));
  assert.equal(env.ORDER_STATUS_JSON_PATH, path.join("runtime/status/main", "order-status.json"));
  assert.equal(env.TEAM_ORDER_STOP_PATH, path.join("runtime/status/main", "team-order-stop.json"));
  assert.equal(env.AUTO_PLANT_LOG_PATH, undefined);
  assert.equal(env.STATIC_CONFIG_PATH, undefined);
  assert.equal(env.XJSKP_MANAGED_LOGGING, "1");
  assert.equal(env.PROFILE_ID, "main");
  assert.equal(env.PROFILE_SETTINGS_PATH, "runtime/settings/main.json");
  assert.equal(env.FLOWER_RACK_SETTINGS_PATH, "runtime/settings/main.json");
  assert.equal(
    env.EXPERIENCE_GUARD_STATE_PATH,
    path.join("runtime", "system", "experience-guards", "main.json"),
  );
  assert.equal(
    env.EXPERIENCE_GUARD_REARM_PATH,
    path.join("runtime", "system", "experience-guards", "main.rearm.json"),
  );
  assert.equal(env.PC_USER_ID, "2088");
  assert.equal(env.PATH, "C:\\node");
});

test("parallel admission is unlimited unless explicitly configured", () => {
  assert.equal(getMaxParallelTasks({}), null);
  assert.equal(getMaxParallelTasks({ XJSKP_MAX_PARALLEL_TASKS: "4" }), 4);
  assert.equal(getMaxParallelTasks({ XJSKP_MAX_PARALLEL_TASKS: "invalid" }), null);
});

test("system data-sync admission blocks every managed start before creating a worker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-system-gate-"));
  try {
    let workerCreations = 0;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir: path.join(dir, "runtime"),
      processProvider: async () => [],
      workerFactory: () => {
        workerCreations += 1;
        throw new Error("worker must not be created");
      },
      systemOperationCoordinator: {
        async reserveRuntimeTransition() {
          const error = new Error("syncing");
          error.statusCode = 409;
          error.code = "GAME_DATA_SYNC_IN_PROGRESS";
          throw error;
        },
      },
    });

    await assert.rejects(
      runner.startLoop(makeProfile("main")),
      (error) => error.code === "GAME_DATA_SYNC_IN_PROGRESS",
    );
    await assert.rejects(
      runner.beginRunOnce(makeProfile("main"), "orders"),
      (error) => error.code === "GAME_DATA_SYNC_IN_PROGRESS",
    );
    assert.equal(workerCreations, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner clears a stale profile stop request before worker start", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-stale-stop-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const stopPath = path.join(runtimeDir, "status", "main", "team-order-stop.json");
    await writeAutomationStopRequest(stopPath, "user-stop");
    const worker = new EventEmitter();
    worker.threadId = 23;
    worker.pid = process.pid;
    worker.terminate = async () => {
      setImmediate(() => worker.emit("exit", 1));
      return 1;
    };
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      workerFactory: () => worker,
      processProvider: async () => [],
    });

    await runner.startLoop(makeProfile("main"));

    assert.equal(await readAutomationStopRequest(stopPath), null);
    worker.emit("exit", 0);
    await waitForLastTaskExit(runtimeDir);
    await runner.runtime();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner marks and messages a worker before graceful stop without terminate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-graceful-stop-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const worker = new EventEmitter();
    worker.threadId = 24;
    worker.pid = process.pid;
    worker.terminateCalls = 0;
    worker.messages = [];
    worker.postMessage = (message) => {
      worker.messages.push(message);
      setImmediate(() => worker.emit("exit", 0));
    };
    worker.terminate = async () => {
      worker.terminateCalls++;
      worker.emit("exit", 1);
      return 1;
    };
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      workerFactory: () => worker,
      processProvider: async () => [],
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });

    await runner.startLoop(makeProfile("main"));
    const stopped = await runner.stop("main");
    const marker = await readAutomationStopRequest(
      path.join(runtimeDir, "status", "main", "team-order-stop.json"),
    );

    assert.deepEqual(worker.messages, [{ type: "stop", reason: "user-stop" }]);
    assert.equal(worker.terminateCalls, 0);
    assert.equal(marker.reason, "user-stop");
    assert.equal(stopped.reason, "user-stopped");
    assert.equal(await readActiveTask(runtimeDir, "main"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner force-terminates an unresponsive active worker only once after grace", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-active-stop-timeout-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const worker = new EventEmitter();
    worker.threadId = 25;
    worker.pid = process.pid;
    worker.messages = [];
    worker.terminateCalls = 0;
    worker.postMessage = (message) => worker.messages.push(message);
    worker.terminate = async () => {
      worker.terminateCalls++;
      setImmediate(() => worker.emit("exit", 1));
      return 1;
    };
    let killCalls = 0;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      gracefulStopMs: 5,
      workerFactory: () => worker,
      processProvider: async () => [],
      killProcessFn: async () => {
        killCalls++;
      },
    });

    await runner.startLoop(makeProfile("main"));
    await runner.stop("main");

    assert.deepEqual(worker.messages, [{ type: "stop", reason: "user-stop" }]);
    assert.equal(worker.terminateCalls, 1);
    assert.equal(killCalls, 0);
    assert.equal(await readActiveTask(runtimeDir, "main"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persisted stop writes the account marker, waits grace, and kills only once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-persisted-stop-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const statusDir = path.join(runtimeDir, "status", "main");
    await mkdir(statusDir, { recursive: true });
    await writeActiveTask(runtimeDir, {
      profileId: "main",
      mode: "loop",
      runtimeMode: "process",
      pid: 8825,
      rootDir: dir,
      statusDir,
      logDir: path.join(runtimeDir, "logs", "main"),
      logPath: path.join(runtimeDir, "logs", "main", "auto.log"),
      startedAt: "2026-07-26T00:00:00.000Z",
    });
    const processes = [{
      ProcessId: 8825,
      Name: "node.exe",
      CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
    }];
    let killCalls = 0;
    let markerAtKill = null;
    const startedAt = Date.now();
    let killedAt = null;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      gracefulStopMs: 20,
      processProvider: async () => processes,
      killProcessFn: async () => {
        killCalls++;
        killedAt = Date.now();
        markerAtKill = await readAutomationStopRequest(
          path.join(statusDir, "team-order-stop.json"),
        );
      },
    });

    const stopped = await runner.stop("main");

    assert.equal(markerAtKill?.reason, "user-stop");
    assert.ok(killedAt - startedAt >= 15);
    assert.equal(killCalls, 1);
    assert.equal(stopped.reason, "user-stopped");
    assert.equal(stopped.category, "operator");
    assert.equal(await readActiveTask(runtimeDir, "main"), null);
    assert.equal((await readLastTaskExit(runtimeDir, "main")).reason, "user-stopped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("active worker stop flushes real user-stopped artifacts before releasing its lock", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-real-stop-artifacts-"));
  const previousEnv = Object.fromEntries(
    ["STATUS_DOC_DIR", "STATUS_JSON_PATH", "STATUS_HTML_PATH", "STATUS_MD_PATH", "PROFILE_ID"]
      .map((key) => [key, process.env[key]]),
  );
  try {
    const runtimeDir = path.join(dir, "runtime");
    const statusDir = path.join(runtimeDir, "status", "main");
    process.env.STATUS_DOC_DIR = statusDir;
    process.env.STATUS_JSON_PATH = path.join(statusDir, "garden-status.json");
    process.env.STATUS_HTML_PATH = path.join(statusDir, "garden-status.html");
    process.env.STATUS_MD_PATH = path.join(statusDir, "garden-status.md");
    process.env.PROFILE_ID = "main";
    const worker = new EventEmitter();
    worker.threadId = 26;
    worker.pid = process.pid;
    worker.terminateCalls = 0;
    let finalizePromise = null;
    const startTime = Date.now();
    const activeTime = startTime + 125;
    const syncValue = {
      orderTeamTot: {
        orderTeam: {
          status: 2,
          startTime,
          activeTime,
          orderNum: 1,
          flowerId: 23_001,
        },
      },
      $usrTot: { data: { id: "uid-main", bag: { 23_001: 15 } } },
    };
    const teamOrderRuntime = createTeamOrderSessionRuntime(syncValue, {
      profileId: "main",
      statusDir,
      teamOrderConfig: {
        durationSeconds: 50,
        maxOrderNum: 160,
        refreshPerSecond: 4,
        orders: new Map([[1, { orderNum: 1, flowerNum: 15 }]]),
      },
    });
    worker.postMessage = (message) => {
      finalizePromise = finalizeUserStopped(
        syncValue,
        teamOrderRuntime,
        { cycle: 9, statusDir, profileId: "main" },
      ).then(() => {
        worker.emit("exit", 0);
      });
    };
    worker.terminate = async () => {
      worker.terminateCalls++;
      worker.emit("exit", 1);
      return 1;
    };
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      workerFactory: () => worker,
      processProvider: async () => [],
    });

    await runner.startLoop(makeProfile("main"));
    await runner.stop("main");
    await finalizePromise;

    const statusJson = JSON.parse(await readFile(process.env.STATUS_JSON_PATH, "utf8"));
    const statusHtml = await readFile(process.env.STATUS_HTML_PATH, "utf8");
    assert.equal(statusJson.summary.automationStopped.reason, "user-stopped");
    assert.match(statusHtml, /用户停止/);
    const expectedRunId = createTeamOrderRunId({
      profileId: "main",
      uid: "uid-main",
      startTime,
      activeTime,
    });
    const archiveDir = path.join(statusDir, "team-orders");
    const archiveNames = await readdir(archiveDir);
    assert.deepEqual(
      archiveNames.filter((name) => name.endsWith(".json")),
      [`${expectedRunId}.json`],
    );
    const ledger = JSON.parse(
      await readFile(path.join(archiveDir, `${expectedRunId}.json`), "utf8"),
    );
    assert.equal(ledger.runId, expectedRunId);
    assert.equal(ledger.finalStatus, "user-stopped");
    assert.equal(ledger.stopReason, "用户停止");
    assert.equal(worker.terminateCalls, 0);
    assert.equal(await readActiveTask(runtimeDir, "main"), null);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner defaults to worker runtime and sends logs through the parent writer", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-worker-runner-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const worker = new EventEmitter();
    worker.threadId = 12;
    worker.pid = 6120;
    worker.terminate = async () => {
      setImmediate(() => worker.emit("exit", 1));
      return 1;
    };
    let workerData = null;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      workerFactory: (data) => {
        workerData = data;
        return worker;
      },
      processProvider: async () => [
        {
          ProcessId: 6120,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "system", "server.mjs")}"`,
        },
      ],
      now: () => new Date("2026-07-07T00:00:00.000Z"),
    });

    const started = await runner.startLoop(makeProfile("main"));

    assert.equal(started.runtimeMode, "worker");
    assert.equal(workerData.env.XJSKP_MANAGED_LOGGING, "1");
    assert.equal(workerData.env.AUTO_PLANT_LOG_PATH, undefined);
    assert.equal(workerData.env.PROFILE_ID, "main");

    worker.emit("message", { type: "log", text: "worker diagnostic\n" });
    worker.emit("exit", 0);

    const exit = await waitForLastTaskExit(runtimeDir);
    const logText = await waitForLogText(started.logPath, "worker diagnostic");

    assert.equal(exit.reason, "completed");
    assert.match(logText, /worker diagnostic/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("automation worker closes its parent port after flushing status so one-shot runs can exit", async () => {
  const source = await readFile("work/system/automation-worker.mjs", "utf8");
  const finallyBlock = source.match(/finally\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  const flushIndex = finallyBlock.indexOf("await statusWriter.flush()");
  const closeIndex = finallyBlock.indexOf("parentPort?.close()");

  assert.ok(flushIndex >= 0, "worker must flush pending status artifacts");
  assert.ok(closeIndex > flushIndex, "worker must close the parent port after the final flush");
});

test("createAutomationRunner can explicitly use process fallback mode", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-process-runner-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const child = new EventEmitter();
    child.pid = 7777;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let spawnedOptions = null;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      runtimeMode: "process",
      nodeExe: "C:\\node\\node.exe",
      nodeScriptPath: path.join(dir, "work", "inspect-garden-dryrun.mjs"),
      processProvider: async () => [
        {
          ProcessId: 7777,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
        },
      ],
      spawnFn: (_nodeExe, _args, options) => {
        spawnedOptions = options;
        return child;
      },
      now: () => new Date("2026-07-07T01:00:00.000Z"),
    });

    const started = await runner.startLoop(makeProfile("main"));

    assert.equal(started.runtimeMode, "process");
    assert.equal(spawnedOptions.env.XJSKP_MANAGED_LOGGING, "1");
    assert.equal(spawnedOptions.env.AUTO_PLANT_LOG_PATH, undefined);
    child.emit("exit", 0, null);
    const exit = await waitForLastTaskExit(runtimeDir);
    assert.equal(exit.reason, "completed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getActionForMode maps system commands to existing automation actions", () => {
  assert.equal(getActionForMode("loop"), "auto-loop");
  assert.equal(getActionForMode("once"), "auto-loop");
  assert.equal(getActionForMode("orders"), "orders-status");
  assert.throws(() => getActionForMode("parallel"), /Unsupported automation mode/);
});

test("buildAutomationEnv runs one-shot mode as one safe automation cycle", () => {
  const env = buildAutomationEnv({
    profileEnv: {},
    mode: "once",
    statusDir: "runtime/status/main",
    logPath: "runtime/logs/main/auto.log",
    baseEnv: {},
  });

  assert.equal(env.ACTION, "auto-loop");
  assert.equal(env.MAX_CYCLES, "1");
});

test("createAutomationRunner writes active-task lock and excludes managed child from legacy detection", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const child = new EventEmitter();
    child.pid = 7777;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => setImmediate(() => child.emit("exit", 0, null));
    let spawned = false;
    let spawnedOptions = null;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      nodeExe: "C:\\node\\node.exe",
      nodeScriptPath: path.join(dir, "work", "inspect-garden-dryrun.mjs"),
      runScriptPath: path.join(dir, "work", "run-auto-plant.ps1"),
      processProvider: async () => spawned ? [
        {
          ProcessId: 7777,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
        },
      ] : [],
      spawnFn: (_nodeExe, _args, options) => {
        spawned = true;
        spawnedOptions = options;
        return child;
      },
      killProcessFn: async () => setImmediate(() => child.emit("exit", 0, null)),
      now: () => new Date("2026-06-29T12:00:00.000Z"),
    });

    const started = await runner.startLoop({
      id: "main",
      env: {
        CTOKEN: "ct",
        PC_USER_ID: "2088",
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
      settings: {
        autoSubmitOrdinaryResidentOrdersForLevelUp: true,
        flowerRackTargetArtId: 302003,
      },
    });

    assert.equal(started.pid, 7777);
    assert.equal((await readActiveTask(runtimeDir)).profileId, "main");
    const settingsPath = path.join(runtimeDir, "settings", "main.json");
    assert.equal(spawnedOptions.env.PROFILE_SETTINGS_PATH, settingsPath);
    assert.equal(spawnedOptions.env.FLOWER_RACK_SETTINGS_PATH, settingsPath);
    assert.equal(spawnedOptions.env.PROFILE_ID, "main");
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      autoReceiveWaterwheelBuckets: true,
      skipWaterwheelVideoBuckets: false,
      autoSubmitOrdinaryResidentOrdersForLevelUp: true,
      autoSubmitOrdinaryResidentOrders: true,
      autoSubmitCyclicStoryOrders: false,
      customerOrderFlowerCurrencyRewardReleaseMask: 4,
      cyclicStoryOnlyHighestExperienceOrder: false,
      experienceGuardThresholdPercent: 0.5,
      flowerRackTargetArtId: 302003,
      materialShopMidnightRefreshEnabled: false,
      materialShopRefreshWindowStart: "23:50",
      materialShopRefreshMaxCostYuanbao: 4,
      pearlHireItemReserveCount: 100,
      teamOrderTriggerProtectionEnabled: true,
      teamOrderPaidRenewProtectionEnabled: true,
      teamOrderGuardMultiplier: 2,
    });
    const runtime = await runner.runtime();
    assert.equal(runtime.active.profileId, "main");
    assert.deepEqual(runtime.legacyProcesses, []);
    await runner.stop("main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner stops legacy automation before starting the selected profile", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-legacy-takeover-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const nodeScriptPath = path.join(dir, "work", "inspect-garden-dryrun.mjs");
    const runScriptPath = path.join(dir, "work", "run-auto-plant.ps1");
    const child = new EventEmitter();
    child.pid = 7001;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const events = [];
    const killed = [];
    let legacyRunning = true;
    let spawned = false;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      nodeExe: "C:\\node\\node.exe",
      nodeScriptPath,
      runScriptPath,
      processProvider: async () => {
        const processes = [];
        if (legacyRunning) {
          processes.push({
            ProcessId: 6001,
            Name: "node.exe",
            CommandLine: `"C:\\node\\node.exe" "${nodeScriptPath}"`,
          });
        }
        if (spawned) {
          processes.push({
            ProcessId: 7001,
            Name: "node.exe",
            CommandLine: `"C:\\node\\node.exe" "${nodeScriptPath}"`,
          });
        }
        return processes;
      },
      spawnFn: () => {
        events.push("spawn");
        spawned = true;
        return child;
      },
      killProcessFn: async (pid) => {
        events.push(`kill:${pid}`);
        killed.push(pid);
        if (pid === 6001) legacyRunning = false;
        if (pid === 7001) {
          spawned = false;
          setImmediate(() => child.emit("exit", null, "SIGTERM"));
        }
      },
      now: () => new Date("2026-07-04T07:20:00.000Z"),
    });

    const started = await runner.startLoop(makeProfile("main"));

    assert.equal(started.pid, 7001);
    assert.deepEqual(killed, [6001]);
    assert.deepEqual(events.slice(0, 2), ["kill:6001", "spawn"]);
    assert.equal((await readActiveTask(runtimeDir, "main")).pid, 7001);
    assert.deepEqual((await runner.runtime()).legacyProcesses, []);

    await runner.stop("main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner does not report managed task descendants as legacy automation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-managed-descendant-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const nodeScriptPath = path.join(dir, "work", "inspect-garden-dryrun.mjs");
    await writeActiveTask(runtimeDir, {
      profileId: "main",
      mode: "loop",
      pid: 29816,
      rootDir: dir,
      statusDir: path.join(runtimeDir, "status", "main"),
      logDir: path.join(runtimeDir, "logs", "main"),
      logPath: path.join(runtimeDir, "logs", "main", "auto.log"),
      startedAt: "2026-07-04T07:18:14.016Z",
    });
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      nodeScriptPath,
      processProvider: async () => [
        {
          ProcessId: 29816,
          ParentProcessId: 16556,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${nodeScriptPath}"`,
        },
        {
          ProcessId: 29964,
          ParentProcessId: 29816,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${nodeScriptPath}"`,
        },
      ],
    });

    const runtime = await runner.runtime();

    assert.equal(runtime.runningCount, 1);
    assert.equal(runtime.activeByProfile.main.pid, 29816);
    assert.deepEqual(runtime.legacyProcesses, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner stopLegacy does not kill managed task descendants", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-stop-legacy-descendant-"));
  const killed = [];
  try {
    const runtimeDir = path.join(dir, "runtime");
    const nodeScriptPath = path.join(dir, "work", "inspect-garden-dryrun.mjs");
    await writeActiveTask(runtimeDir, {
      profileId: "main",
      mode: "loop",
      pid: 29816,
      rootDir: dir,
      statusDir: path.join(runtimeDir, "status", "main"),
      logDir: path.join(runtimeDir, "logs", "main"),
      logPath: path.join(runtimeDir, "logs", "main", "auto.log"),
      startedAt: "2026-07-04T07:18:14.016Z",
    });
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      nodeScriptPath,
      processProvider: async () => [
        {
          ProcessId: 29816,
          ParentProcessId: 16556,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${nodeScriptPath}"`,
        },
        {
          ProcessId: 29964,
          ParentProcessId: 29816,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${nodeScriptPath}"`,
        },
      ],
      killProcessFn: async (pid) => killed.push(pid),
    });

    const result = await runner.stopLegacy();

    assert.equal(result.stopped, false);
    assert.equal(result.count, 0);
    assert.deepEqual(killed, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner can run multiple profile loops at the same time", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const spawnedChildren = new Map();
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      nodeExe: "C:\\node\\node.exe",
      nodeScriptPath: path.join(dir, "work", "inspect-garden-dryrun.mjs"),
      runScriptPath: path.join(dir, "work", "run-auto-plant.ps1"),
      processProvider: async () => Array.from(spawnedChildren.values()).map((child) => ({
        ProcessId: child.pid,
        Name: "node.exe",
        CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
      })),
      spawnFn: () => {
        const child = new EventEmitter();
        child.pid = 8000 + spawnedChildren.size;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        spawnedChildren.set(child.pid, child);
        return child;
      },
      killProcessFn: async (pid) => {
        const child = spawnedChildren.get(pid);
        spawnedChildren.delete(pid);
        if (child) setImmediate(() => child.emit("exit", null, "SIGTERM"));
      },
      now: () => new Date("2026-07-04T00:00:00.000Z"),
    });

    await runner.startLoop(makeProfile("main"));
    await runner.startLoop(makeProfile("alt"));

    const runtime = await runner.runtime();
    assert.equal(runtime.runningCount, 2);
    assert.equal(runtime.maxParallelTasks, null);
    assert.deepEqual(Object.keys(runtime.activeByProfile).sort(), ["alt", "main"]);
    assert.deepEqual(runtime.activeTasks.map((task) => task.profileId).sort(), ["alt", "main"]);
    assert.equal((await readActiveTasks(runtimeDir)).length, 2);
    assert.deepEqual(runtime.legacyProcesses, []);

    const stopped = await runner.stop("main");
    assert.equal(stopped.stopped, true);

    const afterStop = await runner.runtime();
    assert.equal(afterStop.runningCount, 1);
    assert.equal(afterStop.activeByProfile.alt.profileId, "alt");
    assert.equal(afterStop.activeByProfile.main, undefined);
    await runner.stop(null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner rejects a fourth simultaneous profile when explicitly configured", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const spawnedChildren = new Map();
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      maxParallelTasks: 3,
      nodeExe: "C:\\node\\node.exe",
      nodeScriptPath: path.join(dir, "work", "inspect-garden-dryrun.mjs"),
      processProvider: async () => Array.from(spawnedChildren.values()).map((child) => ({
        ProcessId: child.pid,
        Name: "node.exe",
        CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
      })),
      spawnFn: () => {
        const child = new EventEmitter();
        child.pid = 8100 + spawnedChildren.size;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        spawnedChildren.set(child.pid, child);
        return child;
      },
      killProcessFn: async (pid) => {
        const child = spawnedChildren.get(pid);
        spawnedChildren.delete(pid);
        if (child) setImmediate(() => child.emit("exit", null, "SIGTERM"));
      },
    });

    await runner.startLoop(makeProfile("a"));
    await runner.startLoop(makeProfile("b"));
    await runner.startLoop(makeProfile("c"));

    await assert.rejects(
      () => runner.startLoop(makeProfile("d")),
      (err) => err.code === "MAX_PARALLEL_TASKS_REACHED"
        && err.runningCount === 3
        && err.maxParallelTasks === 3,
    );

    await runner.stop(null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner stops an active child through the configured process-tree killer", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-"));
  const killed = [];
  try {
    const runtimeDir = path.join(dir, "runtime");
    const child = new EventEmitter();
    child.pid = 7777;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      throw new Error("child.kill should not be used for managed task shutdown");
    };
    let spawned = false;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      nodeExe: "C:\\node\\node.exe",
      nodeScriptPath: path.join(dir, "work", "inspect-garden-dryrun.mjs"),
      processProvider: async () => spawned ? [
        {
          ProcessId: 7777,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
        },
      ] : [],
      spawnFn: () => {
        spawned = true;
        return child;
      },
      killProcessFn: async (pid) => {
        killed.push(pid);
        setImmediate(() => child.emit("exit", null, "SIGTERM"));
      },
      now: () => new Date("2026-06-29T12:00:00.000Z"),
    });

    await runner.startLoop({
      id: "main",
      env: {
        CTOKEN: "ct",
        PC_USER_ID: "2088",
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
    });

    const result = await runner.stop("main");

    assert.equal(result.stopped, true);
    assert.deepEqual(killed, [7777]);
    assert.equal(await readActiveTask(runtimeDir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner can stop a persisted active task after server restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-"));
  const killed = [];
  try {
    const runtimeDir = path.join(dir, "runtime");
    await writeActiveTask(runtimeDir, {
      profileId: "main",
      mode: "loop",
      pid: 8888,
      rootDir: dir,
      statusDir: path.join(runtimeDir, "status", "main"),
      logDir: path.join(runtimeDir, "logs", "main"),
      logPath: path.join(runtimeDir, "logs", "main", "auto.log"),
      startedAt: "2026-06-29T12:00:00.000Z",
    });
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      processProvider: async () => [
        {
          ProcessId: 8888,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
        },
      ],
      killProcessFn: async (pid) => killed.push(pid),
    });

    const result = await runner.stop("main");

    assert.equal(result.stopped, true);
    assert.deepEqual(killed, [8888]);
    assert.equal(await readActiveTask(runtimeDir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner reconciles session-expired status into a stopped runtime", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-"));
  const killed = [];
  try {
    const runtimeDir = path.join(dir, "runtime");
    const statusDir = path.join(runtimeDir, "status", "main");
    await mkdir(statusDir, { recursive: true });
    await writeActiveTask(runtimeDir, {
      profileId: "main",
      mode: "loop",
      pid: 8888,
      rootDir: dir,
      statusDir,
      logDir: path.join(runtimeDir, "logs", "main"),
      logPath: path.join(runtimeDir, "logs", "main", "auto.log"),
      startedAt: "2026-06-29T12:00:00.000Z",
    });
    await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
      summary: {
        automationStopped: {
          stopped: true,
          reason: "session-expired",
          category: "login-state",
          message: "session expired",
          exitCode: 42,
          stoppedAt: "2026-06-30 16:00:00",
        },
      },
    }), "utf8");

    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      processProvider: async () => [
        {
          ProcessId: 8888,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
        },
      ],
      killProcessFn: async (pid) => killed.push(pid),
      now: () => new Date("2026-06-30T08:00:00.000Z"),
    });

    const runtime = await runner.runtime();

    assert.equal(runtime.active, null);
    assert.equal(runtime.activeTask.reason, "session-expired");
    assert.deepEqual(killed, [8888]);
    assert.equal(await readActiveTask(runtimeDir), null);
    assert.equal(runtime.lastExit.reason, "session-expired");
    assert.equal(runtime.lastExit.exitCode, 42);
    assert.equal(runtime.lastExit.profileId, "main");
    assert.equal(runtime.lastExit.exitedAt, "2026-06-30T08:00:00.000Z");
    assert.equal((await readLastTaskExit(runtimeDir)).reason, "session-expired");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner reconciles session-expired for one profile without stopping other profiles", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-"));
  const killed = [];
  try {
    const runtimeDir = path.join(dir, "runtime");
    const mainStatusDir = path.join(runtimeDir, "status", "main");
    const altStatusDir = path.join(runtimeDir, "status", "alt");
    await mkdir(mainStatusDir, { recursive: true });
    await mkdir(altStatusDir, { recursive: true });
    await writeActiveTask(runtimeDir, {
      profileId: "main",
      mode: "loop",
      pid: 8888,
      rootDir: dir,
      statusDir: mainStatusDir,
      logDir: path.join(runtimeDir, "logs", "main"),
      logPath: path.join(runtimeDir, "logs", "main", "auto.log"),
      startedAt: "2026-07-04T00:00:00.000Z",
    });
    await writeActiveTask(runtimeDir, {
      profileId: "alt",
      mode: "loop",
      pid: 9999,
      rootDir: dir,
      statusDir: altStatusDir,
      logDir: path.join(runtimeDir, "logs", "alt"),
      logPath: path.join(runtimeDir, "logs", "alt", "auto.log"),
      startedAt: "2026-07-04T00:00:00.000Z",
    });
    await writeFile(path.join(mainStatusDir, "garden-status.json"), JSON.stringify({
      summary: {
        automationStopped: {
          stopped: true,
          reason: "session-expired",
          category: "login-state",
          message: "session expired",
          exitCode: 42,
          stoppedAt: "2026-07-04 08:00:00",
        },
      },
    }), "utf8");

    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      processProvider: async () => [
        {
          ProcessId: 8888,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
        },
        {
          ProcessId: 9999,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
        },
      ],
      killProcessFn: async (pid) => killed.push(pid),
      now: () => new Date("2026-07-04T00:00:00.000Z"),
    });

    const runtime = await runner.runtime();

    assert.deepEqual(killed, [8888]);
    assert.equal(runtime.runningCount, 1);
    assert.equal(runtime.activeByProfile.alt.profileId, "alt");
    assert.equal(runtime.activeByProfile.main, undefined);
    assert.equal(runtime.lastTaskExits.main.reason, "session-expired");
    assert.equal((await readLastTaskExits(runtimeDir)).main.reason, "session-expired");
    assert.deepEqual((await readActiveTasks(runtimeDir)).map((task) => task.profileId), ["alt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner keeps session-expired classification when killing one active profile emits a later exit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-active-session-expired-"));
  const killed = [];
  try {
    const runtimeDir = path.join(dir, "runtime");
    const children = new Map();
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      nodeExe: "C:\\node\\node.exe",
      nodeScriptPath: path.join(dir, "work", "inspect-garden-dryrun.mjs"),
      runScriptPath: path.join(dir, "work", "run-auto-plant.ps1"),
      processProvider: async () => Array.from(children.values()).map((child) => ({
        ProcessId: child.pid,
        Name: "node.exe",
        CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
      })),
      spawnFn: () => {
        const child = new EventEmitter();
        child.pid = 9000 + children.size;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        children.set(child.pid, child);
        return child;
      },
      killProcessFn: async (pid) => {
        killed.push(pid);
        const child = children.get(pid);
        children.delete(pid);
        if (child) setImmediate(() => child.emit("exit", null, "SIGTERM"));
      },
      now: () => new Date("2026-07-04T06:40:00.000Z"),
    });

    const main = await runner.startLoop(makeProfile("main"));
    const alt = await runner.startLoop(makeProfile("alt"));
    const mainTask = await readActiveTask(runtimeDir, "main");
    await mkdir(main.statusDir, { recursive: true });
    await writeFile(path.join(main.statusDir, "garden-status.json"), JSON.stringify({
      automationRunId: mainTask.runId,
      summary: {
        automationStopped: {
          stopped: true,
          reason: "session-expired",
          category: "login-state",
          message: "session expired",
          exitCode: 42,
          stoppedAt: "2026-07-04 14:40:00",
          runId: mainTask.runId,
        },
      },
    }), "utf8");

    await runner.runtime();
    await new Promise((resolve) => setImmediate(resolve));
    const afterExitEvent = await runner.runtime();

    assert.deepEqual(killed, [main.pid]);
    assert.equal(afterExitEvent.runningCount, 1);
    assert.equal(afterExitEvent.activeByProfile.alt.pid, alt.pid);
    assert.equal(afterExitEvent.activeByProfile.main, undefined);
    assert.equal(afterExitEvent.lastTaskExits.main.reason, "session-expired");
    assert.equal(afterExitEvent.lastTaskExits.main.exitCode, 42);
    assert.equal((await readActiveTask(runtimeDir, "main")), null);
    assert.equal((await readActiveTask(runtimeDir, "alt")).pid, alt.pid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner clears a stale active task when the managed pid is gone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    await writeActiveTask(runtimeDir, {
      profileId: "main",
      mode: "loop",
      pid: 9999,
      rootDir: dir,
      statusDir: path.join(runtimeDir, "status", "main"),
      logDir: path.join(runtimeDir, "logs", "main"),
      logPath: path.join(runtimeDir, "logs", "main", "auto.log"),
      startedAt: "2026-06-29T12:00:00.000Z",
    });
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      processProvider: async () => [],
      now: () => new Date("2026-06-30T08:00:00.000Z"),
    });

    const runtime = await runner.runtime();

    assert.equal(runtime.active, null);
    assert.equal(runtime.activeTask.reason, "pid-not-found");
    assert.equal(await readActiveTask(runtimeDir), null);
    assert.equal(runtime.lastExit.reason, "pid-not-found");
    assert.equal(runtime.lastExit.profileId, "main");
    assert.equal(runtime.lastExit.exitedAt, "2026-06-30T08:00:00.000Z");
    assert.equal((await readLastTaskExit(runtimeDir)).reason, "pid-not-found");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner clears a stale worker task when only the server pid remains", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-stale-worker-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    await writeActiveTask(runtimeDir, {
      profileId: "main",
      mode: "loop",
      runtimeMode: "worker",
      pid: 4321,
      threadId: 1,
      rootDir: dir,
      statusDir: path.join(runtimeDir, "status", "main"),
      logDir: path.join(runtimeDir, "logs", "main"),
      logPath: path.join(runtimeDir, "logs", "main", "auto.log"),
      startedAt: "2026-07-07T02:52:46.610Z",
    });
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      processProvider: async () => [
        {
          ProcessId: 4321,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "system", "server.mjs")}"`,
        },
      ],
      now: () => new Date("2026-07-07T03:20:00.000Z"),
    });

    const runtime = await runner.runtime();

    assert.equal(runtime.runningCount, 0);
    assert.equal(runtime.activeByProfile.main, undefined);
    assert.equal(await readActiveTask(runtimeDir, "main"), null);
    assert.equal(runtime.lastTaskExits.main.reason, "worker-handle-not-found");
    assert.equal(runtime.lastTaskExits.main.category, "worker");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner records session-expired task exits for runtime display", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    let spawned = false;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      nodeExe: "C:\\node\\node.exe",
      nodeScriptPath: path.join(dir, "work", "inspect-garden-dryrun.mjs"),
      runScriptPath: path.join(dir, "work", "run-auto-plant.ps1"),
      processProvider: async () => spawned ? [
        {
          ProcessId: 4242,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
        },
      ] : [],
      spawnFn: () => {
        spawned = true;
        return child;
      },
      now: () => new Date("2026-06-30T08:00:00.000Z"),
    });

    await runner.startLoop({
      id: "main",
      env: {
        CTOKEN: "ct",
        PC_USER_ID: "2088",
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
    });

    child.emit("exit", 42, null);

    const runtime = await runner.runtime();
    assert.equal(runtime.active, null);
    assert.equal(runtime.lastExit.reason, "session-expired");

    const exit = await waitForLastTaskExit(runtimeDir);
    assert.equal(exit.profileId, "main");
    assert.equal(exit.mode, "loop");
    assert.equal(exit.pid, 4242);
    assert.equal(exit.exitCode, 42);
    assert.equal(exit.reason, "session-expired");
    assert.equal(exit.category, "login-state");
    assert.match(exit.message, /其他设备登录|会话已失效/);
    assert.equal(exit.exitedAt, "2026-06-30T08:00:00.000Z");

    assert.equal(await readActiveTask(runtimeDir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner rejects startLoop when the worker exits during startup confirmation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-start-confirm-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const worker = new EventEmitter();
    worker.threadId = 44;
    worker.pid = 9440;
    worker.terminate = async () => 42;
    let spawned = false;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      startupConfirmMs: 20,
      workerFactory: () => {
        spawned = true;
        setImmediate(() => worker.emit("exit", 42));
        return worker;
      },
      processProvider: async () => spawned ? [
        {
          ProcessId: 9440,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "system", "server.mjs")}"`,
        },
      ] : [],
      now: () => new Date("2026-07-07T04:10:00.000Z"),
    });

    await assert.rejects(
      () => runner.startLoop(makeProfile("main")),
      (err) => err.code === "AUTOMATION_START_FAILED"
        && err.reason === "session-expired"
        && err.exitCode === 42
        && /会话.*失效|其他设备登录/.test(err.message),
    );

    const runtime = await runner.runtime();
    assert.equal(runtime.runningCount, 0);
    assert.equal(runtime.lastTaskExits.main.reason, "session-expired");
    assert.equal(await readActiveTask(runtimeDir, "main"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner waits for worker automationReady before confirming startLoop", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-start-ready-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const worker = new EventEmitter();
    worker.threadId = 45;
    worker.pid = 9450;
    worker.terminate = async () => 1;
    let spawned = false;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      startupConfirmMs: 100,
      workerFactory: () => {
        spawned = true;
        return worker;
      },
      processProvider: async () => spawned ? [
        {
          ProcessId: 9450,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "system", "server.mjs")}"`,
        },
      ] : [],
      now: () => new Date("2026-07-07T04:12:00.000Z"),
    });

    const startedPromise = runner.startLoop(makeProfile("main"));
    while (!spawned) await new Promise((resolve) => setImmediate(resolve));
    await assert.doesNotReject(() => Promise.race([
      startedPromise.then(() => {
        throw new Error("startLoop resolved before automationReady");
      }),
      new Promise((resolve) => setTimeout(resolve, 20)),
    ]));

    worker.emit("message", {
      type: "automationReady",
      readyAt: "2026-07-07T04:12:03.000Z",
      step: "startupReady",
    });

    const started = await startedPromise;
    assert.equal(started.readyAt, "2026-07-07T04:12:03.000Z");
    assert.equal(started.startupState, "ready");
    assert.equal((await readActiveTask(runtimeDir, "main")).readyAt, "2026-07-07T04:12:03.000Z");

    const teamOrderStatus = {
      active: true,
      profileId: "main",
      flowerName: "白玫瑰",
      need: 15,
      remainingMs: 31_000,
    };
    worker.emit("message", {
      type: "teamOrderStatus",
      profileId: "main",
      status: teamOrderStatus,
    });
    assert.deepEqual(
      (await runner.runtime()).activeByProfile.main.teamOrderStatus,
      teamOrderStatus,
    );

    worker.emit("message", {
      type: "teamOrderStatus",
      profileId: "main",
      status: null,
    });
    assert.equal(
      (await runner.runtime()).activeByProfile.main.teamOrderStatus,
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner records incomplete artifact state without promoting worker to ready", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-artifact-not-ready-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const worker = new EventEmitter();
    worker.threadId = 91;
    worker.pid = process.pid;
    worker.terminate = async () => {
      worker.emit("exit", 1);
      return 1;
    };
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      startupConfirmMs: 0,
      processProvider: async () => [],
      workerFactory: () => worker,
    });

    await runner.startLoop(makeProfile("main"));
    worker.emit("message", {
      type: "automationArtifactNotReady",
      chain: "garden",
      status: "incomplete",
      complete: false,
      reason: "rename-failed",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const active = await readActiveTask(runtimeDir);
    assert.equal(active.startupState, "not-ready");
    assert.equal(active.readyAt, undefined);
    assert.equal(active.artifactCompletion.garden.status, "incomplete");
    assert.equal(active.startupNotReadyReason, "rename-failed");

    await runner.stop("main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("process fallback removes only known runtime artifact temps after exit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-process-artifact-temps-"));
  try {
    const child = new EventEmitter();
    child.pid = 9901;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir: path.join(dir, "runtime"),
      runtimeMode: "process",
      startupConfirmMs: 0,
      processProvider: async () => [],
      spawnFn: () => child,
    });

    const started = await runner.startLoop(makeProfile("main"));
    await Promise.all([
      fs.writeFile(path.join(started.statusDir, "garden-status.json.9901.1.tmp"), "late"),
      fs.writeFile(path.join(started.statusDir, "unrelated.tmp"), "keep"),
    ]);
    child.emit("exit", 0, null);
    await waitForLastTaskExit(path.join(dir, "runtime"));

    await assert.rejects(
      () => fs.stat(path.join(started.statusDir, "garden-status.json.9901.1.tmp")),
      (error) => error.code === "ENOENT",
    );
    assert.equal((await fs.stat(path.join(started.statusDir, "unrelated.tmp"))).isFile(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("automation progress parser forwards successful structured worker steps", () => {
  const progress = parseAutomationProgressLine(
    JSON.stringify({ step: "cycleSummary", cycle: 12, err: null }),
    () => new Date("2026-07-30T03:01:00.000Z"),
  );

  assert.deepEqual(progress, {
    step: "cycleSummary",
    cycle: 12,
    at: "2026-07-30T03:01:00.000Z",
  });
  assert.equal(parseAutomationProgressLine("plain text"), null);
  assert.equal(parseAutomationProgressLine(JSON.stringify({
    step: "cycleStatusError",
    warn: "temporary failure",
  })), null);
});

test("createAutomationRunner persists worker progress time and step", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-progress-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const worker = new EventEmitter();
    worker.threadId = 48;
    worker.pid = process.pid;
    worker.terminate = async () => {
      setImmediate(() => worker.emit("exit", 1));
      return 1;
    };
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      workerFactory: () => worker,
      processProvider: async () => [{
        ProcessId: process.pid,
        Name: "node.exe",
        CommandLine: `"node" "${path.join(dir, "work", "system", "server.mjs")}"`,
      }],
      now: () => new Date("2026-07-30T03:00:00.000Z"),
      watchdogIntervalMs: 0,
    });

    await runner.startLoop(makeProfile("main"));
    worker.emit("message", {
      type: "automationProgress",
      step: "cycleSummary",
      cycle: 12,
      at: "2026-07-30T03:01:00.000Z",
    });
    await new Promise((resolve) => setImmediate(resolve));

    const active = (await runner.runtime()).activeByProfile.main;
    const task = await readActiveTask(runtimeDir, "main");
    assert.equal(task.lastProgressAt, "2026-07-30T03:01:00.000Z");
    assert.equal(task.lastProgressStep, "cycleSummary");
    assert.equal(task.lastProgressCycle, 12);
    assert.equal(active.lastProgressAt, "2026-07-30T03:01:00.000Z");
    await runner.stop("main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner watchdog stops a stale loop as stalled but ignores one-shot runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-watchdog-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    let currentTime = new Date("2026-07-30T03:00:00.000Z");
    const workers = [];
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      workerFactory: () => {
        const worker = new EventEmitter();
        worker.threadId = workers.length + 60;
        worker.pid = process.pid;
        worker.terminateCalls = 0;
        worker.terminate = async () => {
          worker.terminateCalls += 1;
          setImmediate(() => worker.emit("exit", 1));
          return 1;
        };
        workers.push(worker);
        return worker;
      },
      processProvider: async () => [{
        ProcessId: process.pid,
        Name: "node.exe",
        CommandLine: `"node" "${path.join(dir, "work", "system", "server.mjs")}"`,
      }],
      now: () => currentTime,
      watchdogIntervalMs: 0,
      watchdogStaleMs: 180_000,
    });

    await runner.startLoop(makeProfile("loop-profile"));
    const once = await runner.beginRunOnce(makeProfile("once-profile"), "once");
    currentTime = new Date("2026-07-30T03:03:01.000Z");
    const stalled = await runner.checkWatchdogs();
    await new Promise((resolve) => setImmediate(resolve));
    await runner.runtime();

    assert.deepEqual(stalled.map((item) => item.profileId), ["loop-profile"]);
    assert.equal(workers[0].terminateCalls, 1);
    assert.equal(workers[1].terminateCalls, 0);
    assert.equal((await readLastTaskExit(runtimeDir, "loop-profile")).reason, "stalled");
    assert.equal(await readActiveTask(runtimeDir, "loop-profile"), null);

    workers[1].emit("exit", 0);
    await once.waitForExit();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("desired run store persists only recovery metadata without profile credentials", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-desired-run-store-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const store = createDesiredRunStore({
      runtimeDir,
      now: () => new Date("2026-07-30T03:00:00.000Z"),
    });
    await store.write("main", {
      desiredState: "running",
      restartAttempt: 2,
      recoveryStatus: "scheduled",
      nextRetryAt: "2026-07-30T03:00:15.000Z",
      env: { PC_TOKEN: "must-not-be-written" },
      token: "must-not-be-written",
    });

    const record = await store.read("main");
    assert.deepEqual(record, {
      version: 1,
      profileId: "main",
      mode: "loop",
      desiredState: "running",
      restartAttempt: 2,
      recoveryStatus: "scheduled",
      nextRetryAt: "2026-07-30T03:00:15.000Z",
      lastReason: null,
      updatedAt: "2026-07-30T03:00:00.000Z",
    });
    const raw = await readFile(store.filePath("main"), "utf8");
    assert.doesNotMatch(raw, /PC_TOKEN|must-not-be-written|token/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("desired run store preserves the optional profile settings epoch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-desired-run-epoch-"));
  try {
    const store = createDesiredRunStore({ runtimeDir: path.join(dir, "runtime") });
    await store.write("main", {
      desiredState: "stopped",
      recoveryStatus: "stopped",
      settingsEpoch: "epoch-main",
    });

    assert.equal((await store.read("main")).settingsEpoch, "epoch-main");
    await store.write("main", { lastReason: "credentials-reset" });
    assert.equal((await store.read("main")).settingsEpoch, "epoch-main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("desired run store retries transient Windows rename locks and cleans its temp file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-desired-run-store-eperm-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    let renameCalls = 0;
    const store = createDesiredRunStore({
      runtimeDir,
      retryDelayMs: 0,
      fs: {
        mkdir,
        readFile,
        readdir,
        rename: async (...args) => {
          renameCalls++;
          if (renameCalls < 3) {
            const error = new Error("simulated Windows file lock");
            error.code = "EPERM";
            throw error;
          }
          return await rename(...args);
        },
        rm,
        writeFile,
      },
    });

    await store.write("main", {
      desiredState: "stopped",
      recoveryStatus: "stopped",
      lastReason: "user-stopped",
    });

    assert.equal(renameCalls, 3);
    assert.equal((await store.read("main")).desiredState, "stopped");
    assert.deepEqual(
      (await readdir(path.dirname(store.filePath("main"))))
        .filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("desired run store serializes concurrent patches for the same profile", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-desired-run-store-queue-"));
  try {
    const store = createDesiredRunStore({ runtimeDir: path.join(dir, "runtime") });

    await Promise.all([
      store.write("main", {
        desiredState: "running",
        restartAttempt: 1,
      }),
      store.write("main", {
        recoveryStatus: "scheduled",
        nextRetryAt: "2026-08-04T03:00:00.000Z",
      }),
    ]);

    const record = await store.read("main");
    assert.equal(record.desiredState, "running");
    assert.equal(record.restartAttempt, 1);
    assert.equal(record.recoveryStatus, "scheduled");
    assert.equal(record.nextRetryAt, "2026-08-04T03:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("desired run store removes its temp file after rename retries are exhausted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-desired-run-store-eperm-final-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const store = createDesiredRunStore({
      runtimeDir,
      maxWriteAttempts: 2,
      retryDelayMs: 0,
      fs: {
        mkdir,
        readFile,
        readdir,
        rename: async () => {
          const error = new Error("simulated persistent Windows file lock");
          error.code = "EPERM";
          throw error;
        },
        rm,
        writeFile,
      },
    });

    await assert.rejects(
      () => store.write("main", { desiredState: "stopped" }),
      (error) => error?.code === "EPERM",
    );
    assert.deepEqual(
      (await readdir(path.dirname(store.filePath("main"))))
        .filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery policy allows one session-expired relogin but rejects a second before the health reset", () => {
  for (const exit of [
    { mode: "loop", category: "network", reason: "ws-timeout" },
    { mode: "loop", category: "stalled", reason: "stalled" },
    { mode: "loop", category: "worker", reason: "worker-handle-not-found" },
  ]) {
    assert.equal(shouldAutoRecover(exit, { desiredState: "running" }), true);
  }
  const sessionExpired = { mode: "loop", category: "login-state", reason: "session-expired" };
  assert.equal(shouldAutoRecover(sessionExpired, { desiredState: "running", restartAttempt: 0 }), true);
  assert.equal(shouldAutoRecover(sessionExpired, { desiredState: "running", restartAttempt: 1 }), false);
  for (const exit of [
    { mode: "loop", category: "operator", reason: "user-stopped" },
    { mode: "loop", category: "experience-guard", reason: "experience-guard" },
    { mode: "loop", category: "runtime", reason: "missing-account-server" },
    { mode: "once", category: "network", reason: "ws-timeout" },
  ]) {
    assert.equal(shouldAutoRecover(exit, { desiredState: "running" }), false);
  }
});

test("createAutomationRunner restarts a desired loop after a structured network exit", async () => {
  const fixture = await createRecoveryRunnerFixture();
  try {
    await fixture.runner.startLoop(makeProfile("main"));
    fixture.workers[0].emit("message", {
      type: "automationExit",
      classification: {
        reason: "ws-timeout",
        category: "network",
        message: "WS request timeout gs.usrLand.refresh",
        exitCode: 1,
      },
    });
    fixture.workers[0].exit(1);
    await fixture.runner.runtime();

    const scheduled = fixture.nextTimer();
    assert.equal(scheduled.delayMs, 2_000);
    await scheduled.run();
    assert.equal(fixture.workers.length, 2);
    assert.equal((await fixture.store.read("main")).desiredState, "running");
    assert.equal((await fixture.runner.runtime()).activeByProfile.main.profileId, "main");
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner turns a stalled watchdog exit into scheduled recovery", async () => {
  let currentTime = new Date("2026-07-30T03:00:00.000Z");
  const fixture = await createRecoveryRunnerFixture({
    now: () => currentTime,
    watchdogStaleMs: 180_000,
  });
  try {
    await fixture.runner.startLoop(makeProfile("stalled"));
    currentTime = new Date("2026-07-30T03:03:01.000Z");
    const stalled = await fixture.runner.checkWatchdogs();
    await new Promise((resolve) => setImmediate(resolve));
    await fixture.runner.runtime();

    assert.deepEqual(stalled.map((item) => item.profileId), ["stalled"]);
    assert.equal(fixture.nextTimer().delayMs, 2_000);
    assert.equal((await fixture.store.read("stalled")).recoveryStatus, "scheduled");
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner schedules exactly one fresh-worker relogin after session expiry", async () => {
  let currentTime = new Date("2026-07-30T03:00:00.000Z");
  const fixture = await createRecoveryRunnerFixture({
    now: () => currentTime,
    watchdogStaleMs: 180_000,
  });
  try {
    await fixture.runner.startLoop(makeProfile("expired-stale"));
    fixture.workers[0].emit("message", {
      type: "automationExit",
      classification: {
        reason: "session-expired",
        category: "login-state",
        message: "session expired",
        exitCode: 42,
      },
    });
    currentTime = new Date("2026-07-30T03:03:01.000Z");

    await fixture.runner.checkWatchdogs();
    await new Promise((resolve) => setImmediate(resolve));
    await fixture.runner.runtime();

    assert.equal((await readLastTaskExit(fixture.runtimeDir, "expired-stale")).reason, "session-expired");
    const scheduled = fixture.nextTimer();
    assert.equal(scheduled.delayMs, 2_000);
    assert.equal((await fixture.store.read("expired-stale")).restartAttempt, 1);
    await scheduled.run();
    assert.equal(fixture.workers.length, 2);
    assert.equal(fixture.workers[1].profileId, "expired-stale");
    assert.deepEqual(fixture.workers[0].messages, []);
    assert.deepEqual(fixture.workers[1].messages, []);
    assert.equal(fixture.pendingTimers().length, 0);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner ignores an old session-expired status after relogin and stops only the matching generation", async () => {
  const fixture = await createRecoveryRunnerFixture();
  try {
    await fixture.runner.startLoop(makeProfile("expired-generation"));
    const statusDir = path.join(fixture.runtimeDir, "status", "expired-generation");
    fixture.workers[0].emit("message", {
      type: "automationExit",
      classification: {
        reason: "session-expired",
        category: "login-state",
        message: "first generation session expired",
        exitCode: 42,
      },
    });
    fixture.workers[0].exit(42);
    await fixture.runner.runtime();
    await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
      automationRunId: fixture.workers[0].runId,
      summary: {
        automationStopped: {
          stopped: true,
          reason: "session-expired",
          category: "login-state",
          exitCode: 42,
          runId: fixture.workers[0].runId,
        },
      },
    }), "utf8");

    await fixture.nextTimer().run();
    assert.equal(fixture.workers.length, 2);
    assert.notEqual(fixture.workers[1].runId, fixture.workers[0].runId);

    await fixture.runner.runtime();
    assert.equal(fixture.workers[1].exited, false);
    fixture.workers[1].emit("message", { type: "automationReady", step: "ready" });
    await fixture.runner.runtime();
    assert.equal(fixture.workers[1].exited, false);

    await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
      automationRunId: fixture.workers[1].runId,
      summary: {
        automationStopped: {
          stopped: true,
          reason: "session-expired",
          category: "login-state",
          exitCode: 42,
          runId: fixture.workers[1].runId,
        },
      },
    }), "utf8");
    fixture.workers[1].exit(1);
    await fixture.runner.runtime();
    const desired = await fixture.store.read("expired-generation");
    assert.equal(desired.desiredState, "stopped");
    assert.equal(desired.recoveryStatus, "blocked");
    assert.equal(fixture.pendingTimers().length, 0);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner blocks a second session expiry before the health-reset window", async () => {
  const fixture = await createRecoveryRunnerFixture();
  try {
    await fixture.runner.startLoop(makeProfile("expired-twice"));
    fixture.workers[0].emit("message", {
      type: "automationExit",
      classification: {
        reason: "session-expired",
        category: "login-state",
        message: "session expired",
        exitCode: 42,
      },
    });
    fixture.workers[0].exit(42);
    await fixture.runner.runtime();
    await fixture.nextTimer().run();

    fixture.workers[1].emit("message", {
      type: "automationExit",
      classification: {
        reason: "session-expired",
        category: "login-state",
        message: "session expired again",
        exitCode: 42,
      },
    });
    fixture.workers[1].exit(42);
    await fixture.runner.runtime();

    const desired = await fixture.store.read("expired-twice");
    assert.equal(desired.desiredState, "stopped");
    assert.equal(desired.recoveryStatus, "blocked");
    assert.equal(desired.lastReason, "session-expired");
    assert.equal(fixture.pendingTimers().length, 0);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner resets the session-expiry allowance only after healthy progress", async () => {
  let currentTime = new Date("2026-07-30T03:00:00.000Z");
  const fixture = await createRecoveryRunnerFixture({ now: () => currentTime });
  try {
    await fixture.runner.startLoop(makeProfile("expired-healthy"));
    fixture.workers[0].emit("message", {
      type: "automationExit",
      classification: { reason: "session-expired", category: "login-state", message: "expired", exitCode: 42 },
    });
    fixture.workers[0].exit(42);
    await fixture.runner.runtime();
    await fixture.nextTimer().run();

    currentTime = new Date("2026-07-30T03:10:00.001Z");
    fixture.workers[1].emit("message", {
      type: "automationProgress",
      at: currentTime.toISOString(),
      step: "authoritative-sync",
    });
    await fixture.runner.runtime();
    assert.equal((await fixture.store.read("expired-healthy")).restartAttempt, 0);

    fixture.workers[1].emit("message", {
      type: "automationExit",
      classification: { reason: "session-expired", category: "login-state", message: "expired", exitCode: 42 },
    });
    fixture.workers[1].exit(42);
    await fixture.runner.runtime();
    assert.equal(fixture.nextTimer().delayMs, 2_000);
    assert.equal((await fixture.store.read("expired-healthy")).restartAttempt, 1);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner still stops the active worker when desired-state persistence fails", async () => {
  const warnings = [];
  const fixture = await createRecoveryRunnerFixture({
    warnFn: (message) => warnings.push(String(message)),
  });
  try {
    await fixture.runner.startLoop(makeProfile("stop-write-failure"));
    const originalWrite = fixture.store.write;
    fixture.store.write = async (profileId, patch) => {
      if (patch?.desiredState === "stopped") {
        const error = new Error("simulated desired state EPERM");
        error.code = "EPERM";
        throw error;
      }
      return await originalWrite(profileId, patch);
    };
    const stopped = await fixture.runner.stop("stop-write-failure");
    await fixture.runner.runtime();

    assert.equal(stopped.stopped, true);
    assert.equal(stopped.reason, "user-stopped");
    assert.equal(stopped.persistenceWarning?.code, "EPERM");
    assert.equal(fixture.workers[0].exited, true);
    assert.equal((await readLastTaskExit(fixture.runtimeDir, "stop-write-failure")).reason, "user-stopped");
    assert.equal(fixture.pendingTimers().length, 0);
    assert.match(warnings.join("\n"), /desired state|EPERM/i);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner distinguishes user stop, session expiry, and control shutdown intent", async () => {
  const fixture = await createRecoveryRunnerFixture();
  try {
    await fixture.runner.startLoop(makeProfile("manual-stop"));
    await fixture.runner.stop("manual-stop");
    assert.equal((await fixture.store.read("manual-stop")).desiredState, "stopped");
    assert.equal(fixture.pendingTimers().length, 0);

    await fixture.runner.startLoop(makeProfile("expired"));
    fixture.workers[1].emit("message", {
      type: "automationExit",
      classification: {
        reason: "session-expired",
        category: "login-state",
        message: "session expired",
        exitCode: 42,
      },
    });
    fixture.workers[1].exit(42);
    await fixture.runner.runtime();
    assert.equal((await fixture.store.read("expired")).desiredState, "running");
    assert.equal(fixture.nextTimer().delayMs, 2_000);

    await fixture.runner.startLoop(makeProfile("shutdown"));
    await fixture.runner.shutdown();
    assert.equal((await fixture.store.read("shutdown")).desiredState, "running");
    assert.equal((await readLastTaskExit(fixture.runtimeDir, "shutdown")).category, "shutdown");
    assert.equal(fixture.pendingTimers().length, 0);
    const restored = await fixture.runner.restoreDesiredLoops();
    assert.equal(restored.scheduled, 1);
    assert.equal(fixture.nextTimer().delayMs, 0);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner restores desired loops through single-instance and concurrency admission", async () => {
  const fixture = await createRecoveryRunnerFixture({ maxParallelTasks: 3 });
  try {
    for (const id of ["p1", "p2", "p3", "p4"]) {
      await fixture.store.write(id, { desiredState: "running" });
    }

    const restored = await fixture.runner.restoreDesiredLoops();
    assert.equal(restored.scheduled, 4);
    const initial = fixture.pendingTimers();
    assert.equal(initial.length, 4);
    for (const timer of initial) await timer.run();

    assert.equal(fixture.workers.length, 3);
    assert.equal((await fixture.runner.runtime()).runningCount, 3);
    const retry = fixture.pendingTimers();
    assert.equal(retry.length, 1);
    assert.equal(retry[0].delayMs, 5_000);
    assert.equal(new Set(fixture.workers.map((worker) => worker.profileId)).size, 3);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner rejects startLoop when startup readiness times out", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-start-timeout-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const worker = new EventEmitter();
    worker.threadId = 46;
    worker.pid = 9460;
    worker.terminate = async () => 1;
    let spawned = false;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      startupConfirmMs: 20,
      workerFactory: () => {
        spawned = true;
        return worker;
      },
      processProvider: async () => spawned ? [
        {
          ProcessId: 9460,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "system", "server.mjs")}"`,
        },
      ] : [],
      now: () => new Date("2026-07-07T04:13:00.000Z"),
    });

    await assert.rejects(
      () => runner.startLoop(makeProfile("main")),
      (err) => err.code === "AUTOMATION_START_FAILED"
        && err.reason === "startup-not-ready"
        && /未完成启动确认/.test(err.message),
    );

    const runtime = await runner.runtime();
    assert.equal(runtime.runningCount, 1);
    assert.equal(runtime.activeByProfile.main.pid, 9460);
    assert.equal(runtime.lastTaskExits.main, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner records operator stop instead of runtime error when terminating a worker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-worker-stop-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const worker = new EventEmitter();
    worker.threadId = 47;
    worker.pid = 9470;
    worker.terminate = async () => {
      setImmediate(() => worker.emit("exit", 1));
      return 1;
    };
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      workerFactory: () => worker,
      processProvider: async () => [
        {
          ProcessId: 9470,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "system", "server.mjs")}"`,
        },
      ],
      now: () => new Date("2026-07-07T04:14:00.000Z"),
    });

    await runner.startLoop(makeProfile("main"));
    const stopped = await runner.stop("main");

    assert.equal(stopped.stopped, true);
    assert.equal(stopped.reason, "user-stopped");
    assert.equal(stopped.category, "operator");
    const exit = await readLastTaskExit(runtimeDir, "main");
    assert.equal(exit.reason, "user-stopped");
    assert.equal(exit.category, "operator");
    assert.notStrictEqual(exit.reason, "error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner clears a session-expired active task even when exit summary write fails", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-exit-write-fail-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const child = new EventEmitter();
    child.pid = 6262;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const warnings = [];
    let spawned = false;
    let writeCalls = 0;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      nodeExe: "C:\\node\\node.exe",
      nodeScriptPath: path.join(dir, "work", "inspect-garden-dryrun.mjs"),
      processProvider: async () => spawned ? [
        {
          ProcessId: 6262,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
        },
      ] : [],
      spawnFn: () => {
        spawned = true;
        return child;
      },
      writeLastTaskExitFn: async () => {
        writeCalls++;
        const err = new Error("simulated EPERM");
        err.code = "EPERM";
        throw err;
      },
      warnFn: (message) => warnings.push(String(message)),
      now: () => new Date("2026-07-04T06:38:05.000Z"),
    });

    await runner.startLoop(makeProfile("main"));
    spawned = false;
    child.emit("exit", 42, null);

    const runtime = await runner.runtime();

    assert.equal(writeCalls, 1);
    assert.equal(runtime.runningCount, 0);
    assert.equal(runtime.activeByProfile.main, undefined);
    assert.equal(await readActiveTask(runtimeDir, "main"), null);
    assert.match(warnings.join("\n"), /last task exit|EPERM/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner appends child stdout and stderr to the profile log", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const child = new EventEmitter();
    child.pid = 5252;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let spawned = false;
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir,
      nodeExe: "C:\\node\\node.exe",
      nodeScriptPath: path.join(dir, "work", "inspect-garden-dryrun.mjs"),
      processProvider: async () => spawned ? [
        {
          ProcessId: 5252,
          Name: "node.exe",
          CommandLine: `"C:\\node\\node.exe" "${path.join(dir, "work", "inspect-garden-dryrun.mjs")}"`,
        },
      ] : [],
      spawnFn: () => {
        spawned = true;
        return child;
      },
      now: () => new Date("2026-07-04T05:32:24.000Z"),
    });

    const started = await runner.startLoop(makeProfile("main"));

    child.stdout.emit("data", Buffer.from("stdout diagnostic\n"));
    child.stderr.emit("data", Buffer.from("stderr stack\n"));
    child.emit("exit", 1, null);

    const exit = await waitForLastTaskExit(runtimeDir);
    const logText = await waitForLogText(started.logPath, "stderr stack");
    const exits = await readLastTaskExits(runtimeDir);

    assert.match(logText, /stdout diagnostic/);
    assert.match(logText, /stderr stack/);
    assert.equal(exit.profileId, "main");
    assert.equal(exit.exitCode, 1);
    assert.equal(exit.reason, "error");
    assert.equal(exits.main.profileId, "main");
    assert.equal(exits.main.reason, "error");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner snapshot observes session-expired locks without reconciliation side effects", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-snapshot-session-expired-"));
  const killed = [];
  const writes = [];
  const clears = [];
  try {
    const runtimeDir = path.join(dir, "runtime");
    const statusDir = path.join(runtimeDir, "status", "main");
    await mkdir(statusDir, { recursive: true });
    await writeActiveTask(runtimeDir, {
      profileId: "main", mode: "loop", pid: 8888, rootDir: dir, statusDir,
      logDir: path.join(runtimeDir, "logs", "main"), logPath: path.join(runtimeDir, "logs", "main", "auto.log"),
      startedAt: "2026-07-20T00:00:00.000Z",
    });
    await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
      summary: { automationStopped: { stopped: true, reason: "session-expired", category: "login-state", exitCode: 42 } },
    }), "utf8");
    const runner = createAutomationRunner({
      rootDir: dir, runtimeDir,
      processProvider: async () => [{ ProcessId: 8888, Name: "node.exe", CommandLine: `node ${path.join(dir, "work", "inspect-garden-dryrun.mjs")}` }],
      killProcessFn: async (pid) => killed.push(pid),
      writeLastTaskExitFn: async (...args) => writes.push(args),
      clearActiveTaskFn: async (...args) => clears.push(args),
    });

    const snapshot = await runner.snapshot();

    assert.equal(snapshot.active, null);
    assert.equal(snapshot.activeTask.reason, "session-expired");
    assert.deepEqual(killed, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(clears, []);
    assert.equal((await readActiveTask(runtimeDir)).profileId, "main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAutomationRunner admits only one concurrent start for the same profile", async () => {
  const fixture = await createConcurrentWorkerRunner({ maxParallelTasks: 3 });
  try {
    const results = await Promise.allSettled([
      fixture.runner.startLoop(makeProfile("main")),
      fixture.runner.startLoop(makeProfile("main")),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected").length, 1);
    assert.equal(fixture.workers.length, 1);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner enforces maxParallelTasks across concurrent starts", async () => {
  const fixture = await createConcurrentWorkerRunner({ maxParallelTasks: 1 });
  try {
    const results = await Promise.allSettled([
      fixture.runner.startLoop(makeProfile("main")),
      fixture.runner.startLoop(makeProfile("alt")),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected").length, 1);
    assert.equal(fixture.workers.length, 1);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner terminates an execution handle when active-task persistence fails", async () => {
  const fixture = await createConcurrentWorkerRunner({
    writeActiveTaskFn: async () => {
      throw Object.assign(new Error("lock write failed"), { code: "EIO" });
    },
  });
  try {
    await assert.rejects(() => fixture.runner.startLoop(makeProfile("main")), /lock write failed/);
    assert.equal(fixture.workers.length, 1);
    assert.equal(fixture.workers[0].terminated, true);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner keeps a worker managed when active-task persistence and cleanup both fail", async () => {
  const fixture = await createCleanupFailureWorkerRunner();
  try {
    await assert.rejects(
      () => fixture.runner.startLoop(makeProfile("main")),
      (err) => err.code === "EIO"
        && err.cause?.code === "EIO"
        && err.cleanupError?.code === "EWORKERSTOP",
    );
    assert.equal(fixture.worker.terminateCalls, 1);
    await assert.rejects(
      () => fixture.runner.startLoop(makeProfile("main")),
      (err) => err.code === "ACTIVE_AUTOMATION_RUNNING",
    );
    await assert.rejects(
      () => fixture.runner.startLoop(makeProfile("alt")),
      (err) => err.code === "MAX_PARALLEL_TASKS_REACHED",
    );
    const runtime = await fixture.runner.runtime();
    assert.equal(runtime.runningCount, 1);
    assert.equal(runtime.active?.profileId, "main");
    assert.equal(runtime.activeByProfile.main?.profileId, "main");
    assert.equal(runtime.activeTask.reason, "startup-persistence-failed-pending-cleanup");
    assert.equal(runtime.activeTask.task?.profileId, "main");
    assert.equal(runtime.active?.registrationStatus, "startup-persistence-failed-pending-cleanup");
    assert.equal(runtime.active?.lockStatus, "not-persisted");
    assert.equal(runtime.active?.registrationError?.code, "EIO");
    assert.equal(runtime.active?.cleanupError?.code, "EWORKERSTOP");

    const stopped = await fixture.runner.stop("main");
    assert.equal(stopped.stopped, true);
    const afterStop = await fixture.runner.runtime();
    assert.equal(afterStop.runningCount, 0);
    assert.equal(afterStop.active, null);
    assert.equal(afterStop.activeByProfile.main, undefined);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner keeps a process fallback managed when active-task persistence and cleanup both fail", async () => {
  const fixture = await createCleanupFailureProcessRunner();
  try {
    await assert.rejects(
      () => fixture.runner.startLoop(makeProfile("main")),
      (err) => err.code === "EIO"
        && err.cause?.code === "EIO"
        && err.cleanupError?.code === "EPROCESSSTOP",
    );
    assert.equal(fixture.killCalls, 1);
    await assert.rejects(
      () => fixture.runner.startLoop(makeProfile("main")),
      (err) => err.code === "ACTIVE_AUTOMATION_RUNNING",
    );
    await assert.rejects(
      () => fixture.runner.startLoop(makeProfile("alt")),
      (err) => err.code === "MAX_PARALLEL_TASKS_REACHED",
    );
    const runtime = await fixture.runner.runtime();
    assert.equal(runtime.runningCount, 1);
    assert.equal(runtime.activeByProfile.main?.registrationStatus, "startup-persistence-failed-pending-cleanup");
    assert.equal(runtime.activeByProfile.main?.lockStatus, "not-persisted");

    const stopped = await fixture.runner.stop(null);
    assert.equal(stopped.stopped, true);
    const afterStop = await fixture.runner.runtime();
    assert.equal(afterStop.runningCount, 0);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner runOnce admits only one concurrent start for the same profile", async () => {
  const fixture = await createControlledWorkerRunner({ maxParallelTasks: 3 });
  try {
    const first = fixture.runner.runOnce(makeProfile("main"), "once");
    const worker = await fixture.waitForWorker(0);
    await assert.rejects(
      () => fixture.runner.runOnce(makeProfile("main"), "once"),
      (err) => err.code === "ACTIVE_AUTOMATION_RUNNING",
    );
    worker.exit(0);
    await first;
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner beginRunOnce keeps the task managed while its completion is awaited separately", async () => {
  const fixture = await createControlledWorkerRunner({
    maxParallelTasks: 3,
    processProvider: async () => [{
      ProcessId: process.pid,
      Name: "node.exe",
      CommandLine: "node work/system/server.mjs",
    }],
  });
  try {
    const begun = await fixture.runner.beginRunOnce(makeProfile("main"), "once");
    const worker = await fixture.waitForWorker(0);
    const runtime = await fixture.runner.runtime();

    assert.equal(runtime.runningCount, 1);
    assert.equal(runtime.activeByProfile.main?.mode, "once");
    assert.equal(typeof begun.waitForExit, "function");
    worker.exit(0);
    assert.equal((await begun.waitForExit()).exitCode, 0);
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner beginRunOnce can stop a pending one-shot task", async () => {
  const fixture = await createControlledWorkerRunner();
  try {
    const begun = await fixture.runner.beginRunOnce(makeProfile("main"), "orders");
    await fixture.waitForWorker(0);
    const stopped = await fixture.runner.stop("main");

    assert.equal(stopped.stopped, true);
    assert.equal((await begun.waitForExit()).profileId, "main");
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner runOnce enforces maxParallelTasks across concurrent starts", async () => {
  const fixture = await createControlledWorkerRunner({ maxParallelTasks: 1 });
  try {
    const first = fixture.runner.runOnce(makeProfile("main"), "once");
    const worker = await fixture.waitForWorker(0);
    await assert.rejects(
      () => fixture.runner.runOnce(makeProfile("alt"), "once"),
      (err) => err.code === "MAX_PARALLEL_TASKS_REACHED",
    );
    worker.exit(0);
    await first;
  } finally {
    await fixture.close();
  }
});

test("createAutomationRunner beginRunOnce releases admission after startup failure so the profile can retry", async () => {
  let writeCalls = 0;
  const fixture = await createControlledWorkerRunner({
    writeActiveTaskFn: async (runtimeDir, task) => {
      writeCalls++;
      if (writeCalls === 1) throw Object.assign(new Error("first lock write failed"), { code: "EIO" });
      await writeActiveTask(runtimeDir, task);
    },
  });
  try {
    const failedStart = fixture.runner.beginRunOnce(makeProfile("main"), "once");
    await fixture.waitForWorker(0);
    await assert.rejects(failedStart, /first lock write failed/);

    const retry = await fixture.runner.beginRunOnce(makeProfile("main"), "once");
    const retryWorker = await fixture.waitForWorker(1);
    retryWorker.exit(0);
    await retry.waitForExit();
    assert.equal(writeCalls, 2);
  } finally {
    await fixture.close();
  }
});

async function waitForLastTaskExit(runtimeDir) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const exit = await readLastTaskExit(runtimeDir);
    if (exit) return exit;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return await readLastTaskExit(runtimeDir);
}

async function waitForLogText(logPath, expectedText) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const text = await readFile(logPath, "utf8");
    if (text.includes(expectedText)) return text;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return await readFile(logPath, "utf8");
}

function makeProfile(id) {
  return {
    id,
    env: {
      CTOKEN: `ct-${id}`,
      PC_USER_ID: `2088-${id}`,
      PC_TOKEN: `pc-${id}`,
      BABI_TOKEN: `babi-${id}`,
      OPEN_ID: `open-${id}`,
    },
    settings: {},
  };
}

async function createConcurrentWorkerRunner(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-race-"));
  const workers = [];
  class FakeWorker extends EventEmitter {
    constructor() {
      super();
      this.threadId = workers.length + 1;
      this.pid = process.pid;
      this.terminated = false;
    }

    async terminate() {
      if (this.terminated) return 1;
      this.terminated = true;
      setImmediate(() => this.emit("exit", 1));
      return 1;
    }
  }
  const runner = createAutomationRunner({
    rootDir: dir,
    runtimeDir: path.join(dir, "runtime"),
    startupConfirmMs: 0,
    maxParallelTasks: options.maxParallelTasks ?? 3,
    processProvider: async () => [],
    writeActiveTaskFn: options.writeActiveTaskFn,
    workerFactory: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  return {
    runner,
    workers,
    async close() {
      await runner.stop(null).catch(() => {});
      for (const worker of workers) await worker.terminate();
      await new Promise((resolve) => setImmediate(resolve));
      await runner.runtime().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function createCleanupFailureWorkerRunner() {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-cleanup-worker-"));
  const worker = new EventEmitter();
  worker.threadId = 1;
  worker.pid = process.pid;
  worker.terminateCalls = 0;
  worker.terminate = async () => {
    worker.terminateCalls++;
    if (worker.terminateCalls === 1) {
      throw Object.assign(new Error("worker cleanup failed"), { code: "EWORKERSTOP" });
    }
    setImmediate(() => worker.emit("exit", 1));
    return 1;
  };
  const runner = createAutomationRunner({
    rootDir: dir,
    runtimeDir: path.join(dir, "runtime"),
    startupConfirmMs: 0,
    maxParallelTasks: 1,
    processProvider: async () => [],
    workerFactory: () => worker,
    writeActiveTaskFn: async () => {
      throw Object.assign(new Error("lock write failed"), { code: "EIO" });
    },
  });
  return {
    runner,
    worker,
    async close() {
      worker.emit("exit", 1);
      await new Promise((resolve) => setImmediate(resolve));
      await runner.runtime().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function createCleanupFailureProcessRunner() {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-cleanup-process-"));
  const child = new EventEmitter();
  child.pid = 8912;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killCalls = 0;
  const runner = createAutomationRunner({
    rootDir: dir,
    runtimeDir: path.join(dir, "runtime"),
    runtimeMode: "process",
    startupConfirmMs: 0,
    maxParallelTasks: 1,
    processProvider: async () => [],
    spawnFn: () => child,
    killProcessFn: async () => {
      killCalls++;
      if (killCalls === 1) {
        throw Object.assign(new Error("process cleanup failed"), { code: "EPROCESSSTOP" });
      }
      setImmediate(() => child.emit("exit", 1, null));
    },
    writeActiveTaskFn: async () => {
      throw Object.assign(new Error("lock write failed"), { code: "EIO" });
    },
  });
  return {
    runner,
    get killCalls() {
      return killCalls;
    },
    async close() {
      child.emit("exit", 1, null);
      await new Promise((resolve) => setImmediate(resolve));
      await runner.runtime().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function createControlledWorkerRunner(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-once-"));
  const workers = [];
  const workerWaiters = [];
  class ControlledWorker extends EventEmitter {
    constructor() {
      super();
      this.threadId = workers.length + 1;
      this.pid = process.pid;
      this.exited = false;
    }

    exit(code = 0) {
      if (this.exited) return;
      this.exited = true;
      this.emit("exit", code);
    }

    async terminate() {
      this.exit(1);
      return 1;
    }
  }
  const runner = createAutomationRunner({
    rootDir: dir,
    runtimeDir: path.join(dir, "runtime"),
    startupConfirmMs: 0,
    maxParallelTasks: options.maxParallelTasks ?? 3,
    processProvider: options.processProvider || (async () => []),
    writeActiveTaskFn: options.writeActiveTaskFn,
    workerFactory: () => {
      const worker = new ControlledWorker();
      const index = workers.push(worker) - 1;
      workerWaiters[index]?.(worker);
      return worker;
    },
  });
  return {
    runner,
    waitForWorker(index) {
      return workers[index]
        ? Promise.resolve(workers[index])
        : new Promise((resolve) => {
          workerWaiters[index] = resolve;
        });
    },
    async close() {
      for (const worker of workers) worker.exit(1);
      await new Promise((resolve) => setImmediate(resolve));
      await runner.runtime().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function createRecoveryRunnerFixture(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runner-recovery-"));
  const runtimeDir = path.join(dir, "runtime");
  const store = createDesiredRunStore({ runtimeDir });
  const workers = [];
  const timers = [];

  class RecoveryWorker extends EventEmitter {
    constructor(data) {
      super();
      this.threadId = workers.length + 80;
      this.pid = process.pid;
      this.profileId = data.profileId;
      this.runId = data.env.XJSKP_AUTOMATION_RUN_ID;
      this.exited = false;
      this.messages = [];
    }

    exit(code = 0) {
      if (this.exited) return;
      this.exited = true;
      this.emit("exit", code);
    }

    async terminate() {
      this.exit(1);
      return 1;
    }

    postMessage(message) {
      this.messages.push(message);
    }
  }

  const setRecoveryTimerFn = (callback, delayMs) => {
    const timer = {
      callback,
      delayMs,
      cancelled: false,
      ran: false,
      unref() {},
      async run() {
        if (this.cancelled || this.ran) return;
        this.ran = true;
        await this.callback();
      },
    };
    timers.push(timer);
    return timer;
  };
  const runner = createAutomationRunner({
    rootDir: dir,
    runtimeDir,
    startupConfirmMs: 0,
    maxParallelTasks: options.maxParallelTasks ?? 3,
    desiredRunStore: store,
    profileLoader: async (profileId) => makeProfile(profileId),
    setRecoveryTimerFn,
    clearRecoveryTimerFn: (timer) => {
      timer.cancelled = true;
    },
    watchdogIntervalMs: 0,
    watchdogStaleMs: options.watchdogStaleMs,
    now: options.now,
    warnFn: options.warnFn,
    processProvider: async () => [{
      ProcessId: process.pid,
      Name: "node.exe",
      CommandLine: `"node" "${path.join(dir, "work", "system", "server.mjs")}"`,
    }],
    workerFactory: (data) => {
      const worker = new RecoveryWorker(data);
      workers.push(worker);
      return worker;
    },
  });

  return {
    dir,
    runtimeDir,
    runner,
    store,
    workers,
    timers,
    pendingTimers: () => timers.filter((timer) => !timer.cancelled && !timer.ran),
    nextTimer() {
      const timer = timers.find((item) => !item.cancelled && !item.ran);
      assert.ok(timer, "expected a pending recovery timer");
      return timer;
    },
    async close() {
      await runner.stop(null).catch(() => {});
      for (const worker of workers) worker.exit(1);
      await new Promise((resolve) => setImmediate(resolve));
      await runner.runtime().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}
