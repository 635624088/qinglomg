import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  clearLastTaskExit,
  clearActiveTask,
  evaluateActiveTask,
  readActiveTask,
  readActiveTasks,
  readLastTaskExit,
  readLastTaskExits,
  writeLastTaskExit,
  writeActiveTask,
} from "./runtime-lock.mjs";
import { createRotatingLogWriter } from "./status-store.mjs";
import { createStaleWhileRevalidateSnapshot } from "./process-snapshot-cache.mjs";
import { createStartAdmission } from "./start-admission.mjs";
import { createRuntimeSettingsStore } from "./runtime-settings-store.mjs";
import {
  createDesiredRunStore,
  getRecoveryDelayMs,
  shouldAutoRecover,
} from "./automation-recovery.mjs";
import {
  clearAutomationStopRequest,
  writeAutomationStopRequest,
} from "../automation-stop.mjs";
import { cleanupRuntimeArtifactTemps } from "../runtime-artifact-completion.mjs";

const SESSION_EXPIRED_EXIT_CODE = 42;
const EXPERIENCE_GUARD_EXIT_CODE = 43;
const SESSION_EXPIRED_STOP_MESSAGE = "检测到账号在其他设备登录或会话已失效，自动化循环已自动停止。";
const EXPERIENCE_GUARD_STOP_MESSAGE = "经验保护已停止收益任务。";
const DEFAULT_MAX_PARALLEL_TASKS = null;
const DEFAULT_STARTUP_CONFIRM_MS = 0;
const STARTUP_NOT_READY_MESSAGE = "启动失败：worker 未完成启动确认，请稍后刷新状态。";

export function getActionForMode(mode) {
  if (mode === "loop") return "auto-loop";
  if (mode === "once") return "auto-loop";
  if (mode === "orders") return "orders-status";
  throw new Error(`Unsupported automation mode: ${mode}`);
}

export function getMaxParallelTasks(env = process.env) {
  return normalizeMaxParallelTasks(env.XJSKP_MAX_PARALLEL_TASKS);
}

export function normalizeMaxParallelTasks(value) {
  if (value == null || String(value).trim() === "") return DEFAULT_MAX_PARALLEL_TASKS;
  if (String(value).trim().toLowerCase() === "unlimited") return DEFAULT_MAX_PARALLEL_TASKS;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return DEFAULT_MAX_PARALLEL_TASKS;
  return Math.floor(number);
}

export function buildAutomationEnv({
  profileEnv,
  profileId,
  settingsPath,
  runtimeDir = null,
  mode,
  statusDir,
  logPath,
  baseEnv = process.env,
  loopMinIntervalSeconds = 30,
  loopMaxIntervalSeconds = 58,
  automationRunId = null,
}) {
  const action = getActionForMode(mode);
  const env = {
    ...baseEnv,
    ...profileEnv,
    ACTION: action,
    SUMMARY_ONLY: "1",
    XJSKP_MANAGED_LOGGING: "1",
    STATUS_DOC_DIR: statusDir,
    STATUS_HTML_PATH: path.join(statusDir, "garden-status.html"),
    STATUS_MD_PATH: pathDirJoin(statusDir, "garden-status.md"),
    STATUS_JSON_PATH: path.join(statusDir, "garden-status.json"),
    ORDER_STATUS_JSON_PATH: path.join(statusDir, "order-status.json"),
    TEAM_ORDER_STOP_PATH: path.join(statusDir, "team-order-stop.json"),
    ...(profileId ? { PROFILE_ID: profileId } : {}),
    ...(automationRunId ? { XJSKP_AUTOMATION_RUN_ID: automationRunId } : {}),
    ...(settingsPath ? { PROFILE_SETTINGS_PATH: settingsPath, FLOWER_RACK_SETTINGS_PATH: settingsPath } : {}),
    ...(profileId && runtimeDir ? {
      EXPERIENCE_GUARD_STATE_PATH: path.join(
        runtimeDir,
        "system",
        "experience-guards",
        `${profileId}.json`,
      ),
      EXPERIENCE_GUARD_REARM_PATH: path.join(
        runtimeDir,
        "system",
        "experience-guards",
        `${profileId}.rearm.json`,
      ),
    } : {}),
    LOOP_INTERVAL_MIN_SECONDS: String(loopMinIntervalSeconds),
    LOOP_INTERVAL_MAX_SECONDS: String(loopMaxIntervalSeconds),
    ...(mode === "once" ? { MAX_CYCLES: "1" } : {}),
  };
  delete env.AUTO_PLANT_LOG_PATH;
  delete env.STATIC_CONFIG_PATH;
  return env;
}

function pathDirJoin(...parts) {
  return path.join(...parts);
}

export function detectLegacyAutomationProcesses({
  processes,
  selfPid = process.pid,
  managedPids = new Set(),
  nodeScriptPath,
  runScriptPath,
}) {
  const nodeNeedle = normalizeForMatch(nodeScriptPath);
  const runNeedle = normalizeForMatch(runScriptPath);
  return processes
    .filter((item) => {
      const pid = Number(item.ProcessId ?? item.pid);
      if (!pid || pid === selfPid || managedPids.has(pid)) return false;
      const commandLine = normalizeForMatch(item.CommandLine ?? item.commandLine ?? "");
      if (!commandLine) return false;
      const isLoopScript = commandLine.includes(runNeedle) && /(^|\s)-loop(\s|$)/i.test(commandLine);
      const isNodeAutomation = commandLine.includes(nodeNeedle);
      return isLoopScript || isNodeAutomation;
    })
    .map((item) => ({
      pid: Number(item.ProcessId ?? item.pid),
      name: item.Name ?? item.name ?? "",
      commandLine: item.CommandLine ?? item.commandLine ?? "",
    }));
}

export async function getWindowsProcessSnapshot(options = {}) {
  const spawnProcess = options.spawnFn || spawn;
  const child = spawnProcess("powershell", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Depth 3",
  ], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding?.("utf8");
  child.stderr?.setEncoding?.("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout?.on?.("data", (chunk) => { stdout += chunk; });
  child.stderr?.on?.("data", (chunk) => { stderr += chunk; });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (status !== 0) {
    throw new Error((stderr || stdout || "Unable to inspect Windows processes").trim());
  }
  const text = String(stdout || "").trim();
  if (!text) return [];
  const json = JSON.parse(text);
  return Array.isArray(json) ? json : [json];
}

// Linux: build the same shape of snapshot from /proc instead of Win32_Process.
export async function getLinuxProcessSnapshot() {
  const root = "/proc";
  const snapshot = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return snapshot;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!pid) continue;
    let name = "";
    let ppid = 0;
    let commandLine = "";
    try {
      const stat = fs.readFileSync(path.join(root, entry, "stat"), "utf8");
      const statFields = parseProcStat(stat);
      name = statFields.comm || "";
      ppid = Number(statFields.ppid) || 0;
      const cmdlineRaw = fs.readFileSync(path.join(root, entry, "cmdline"));
      commandLine = cmdlineRaw
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ")
        .trim();
    } catch {
      continue;
    }
    if (!commandLine) continue;
    snapshot.push({ pid, ppid, name, commandLine });
  }
  return snapshot;
}

function parseProcStat(statText) {
  // comm can contain spaces/parens; parse from the last ")" then split the rest.
  const openIndex = statText.indexOf("(");
  const closeIndex = statText.lastIndexOf(")");
  if (openIndex < 0 || closeIndex < 0 || closeIndex < openIndex) {
    return { comm: "", ppid: 0 };
  }
  const comm = statText.slice(openIndex + 1, closeIndex);
  const rest = statText.slice(closeIndex + 2).split(/\s+/);
  // rest[0] is "state"; ppid is rest[1] in post-comm fields (field 4 overall).
  return { comm, ppid: Number(rest[1]) || 0 };
}

export function getDefaultProcessSnapshotProvider() {
  return process.platform === "win32" ? getWindowsProcessSnapshot : getLinuxProcessSnapshot;
}

export function createAutomationRunner(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const runtimeDir = options.runtimeDir || path.join(rootDir, "runtime");
  const nodeExe = options.nodeExe || process.execPath;
  const nodeScriptPath = options.nodeScriptPath || path.join(rootDir, "work", "inspect-garden-dryrun.mjs");
  const runScriptPath = options.runScriptPath || path.join(rootDir, "work", "run-auto-plant.ps1");
  const processProvider = options.processProvider || getDefaultProcessSnapshotProvider();
  const spawnFn = options.spawnFn || spawn;
  const runtimeMode = normalizeRuntimeMode(
    options.runtimeMode ?? process.env.XJSKP_RUNTIME_MODE ?? (options.spawnFn ? "process" : "worker"),
  );
  const workerFactory = options.workerFactory || ((workerData) => new Worker(new URL("./automation-worker.mjs", import.meta.url), {
    workerData,
  }));
  const killProcessFn = options.killProcessFn || defaultKillProcess;
  const writeActiveTaskFn = options.writeActiveTaskFn || writeActiveTask;
  const writeLastTaskExitFn = options.writeLastTaskExitFn || writeLastTaskExit;
  const clearActiveTaskFn = options.clearActiveTaskFn || clearActiveTask;
  const warnFn = options.warnFn || defaultWarn;
  const startupConfirmMs = normalizeNonNegativeInteger(options.startupConfirmMs ?? process.env.XJSKP_STARTUP_CONFIRM_MS, DEFAULT_STARTUP_CONFIRM_MS);
  const now = options.now || (() => new Date());
  const processSnapshotCacheMs = normalizeNonNegativeInteger(
    options.processSnapshotCacheMs ?? process.env.XJSKP_PROCESS_SNAPSHOT_CACHE_MS,
    5_000,
  );
  const processSnapshot = createStaleWhileRevalidateSnapshot({
    load: processProvider,
    maxAgeMs: processSnapshotCacheMs,
    now: () => now().getTime(),
    onError: (err) => warnFn(`[runtime-warning] process snapshot refresh failed: ${err?.message || err}`),
  });
  const loadProcessesFresh = () => processSnapshot.refresh();
  if (!options.processProvider) processSnapshot.prime();
  const configuredMaxParallelTasks = Object.prototype.hasOwnProperty.call(options, "maxParallelTasks")
    ? options.maxParallelTasks
    : process.env.XJSKP_MAX_PARALLEL_TASKS;
  const maxParallelTasks = normalizeMaxParallelTasks(configuredMaxParallelTasks);
  const startAdmission = createStartAdmission({ maxParallelTasks });
  const systemOperationCoordinator = options.systemOperationCoordinator || null;
  const activeRuns = new Map();
  const recentExits = new Map();
  const pendingExits = new Map();
  const recoveryJobs = new Map();
  const runningRecoveryJobs = new Map();
  const recoveryScheduleFlights = new Map();
  let recoveryPaused = false;
  const runtimeSettingsStore = options.runtimeSettingsStore || createRuntimeSettingsStore({ runtimeDir });
  const desiredRunStore = options.desiredRunStore || createDesiredRunStore({ runtimeDir, now });
  const profileLoader = options.profileLoader || null;
  const recoveryCoordinator = typeof options.recoveryCoordinator === "function"
    ? options.recoveryCoordinator
    : null;
  const setRecoveryTimerFn = options.setRecoveryTimerFn || setTimeout;
  const clearRecoveryTimerFn = options.clearRecoveryTimerFn || clearTimeout;
  const recoveryHealthyResetMs = normalizeNonNegativeInteger(
    options.recoveryHealthyResetMs ?? process.env.XJSKP_RECOVERY_HEALTHY_RESET_MS,
    10 * 60 * 1000,
  );
  const gracefulStopMs = normalizeNonNegativeInteger(options.gracefulStopMs, 2_000);
  const watchdogStaleMs = normalizeNonNegativeInteger(
    options.watchdogStaleMs ?? process.env.XJSKP_WATCHDOG_STALE_MS,
    180_000,
  );
  const watchdogIntervalMs = normalizeNonNegativeInteger(
    options.watchdogIntervalMs ?? process.env.XJSKP_WATCHDOG_INTERVAL_MS,
    30_000,
  );
  const watchdogTimer = watchdogIntervalMs > 0
    ? setInterval(() => {
      checkWatchdogs().catch((err) => warnFn(
        `[runtime-warning] watchdog check failed: ${err?.message || err}`,
      ));
    }, watchdogIntervalMs)
    : null;
  watchdogTimer?.unref?.();

  async function runtime() {
    await settlePendingExits();
    await settleProgressWrites();
    const processes = await loadProcessesFresh();
    await reconcileSessionExpiredActiveRuns();
    const statuses = await getPersistedActiveStatuses(processes);
    const reconciledStatuses = [];
    for (const status of statuses) {
      let nextStatus = await reconcileSessionExpiredPersistedTask(status);
      nextStatus = await reconcileDeadPersistedTask(nextStatus);
      reconciledStatuses.push(nextStatus);
    }
    const activeStatuses = reconciledStatuses.filter((status) => status.healthy);
    const activeTasks = activeStatuses.map((status) => {
      const task = summarizePersistedTask(status);
      const managedRun = activeRuns.get(task.profileId);
      return managedRun
        ? { ...task, teamOrderStatus: managedRun.teamOrderStatus || null }
        : task;
    });
    const activeTaskProfiles = new Set(activeTasks.map((task) => task.profileId));
    const memoryManagedTasks = Array.from(activeRuns.values())
      .filter((run) => run.registrationStatus === "startup-persistence-failed-pending-cleanup")
      .filter((run) => !activeTaskProfiles.has(run.profileId))
      .map(summarizeUnpersistedManagedRun);
    activeTasks.push(...memoryManagedTasks);
    const recoverySnapshot = await getRecoverySnapshot();
    applyRecoverySnapshot(activeTasks, recoverySnapshot.byProfile);
    const activeByProfile = Object.fromEntries(activeTasks.map((task) => [task.profileId, task]));
    const managedPids = getManagedPids(activeStatuses, processes);
    const legacyProcesses = detectLegacy(processes, managedPids);
    const lastTaskExits = {
      ...(await readLastTaskExits(runtimeDir)),
      ...Object.fromEntries(recentExits),
    };
    const lastExit = mostRecentExit(lastTaskExits) || await readLastTaskExit(runtimeDir);
    return {
      active: activeTasks[0] || null,
      activeTasks,
      activeByProfile,
      activeTask: activeStatuses[0]
        || (memoryManagedTasks[0] ? summarizeMemoryManagedTask(memoryManagedTasks[0]) : null)
        || reconciledStatuses[0]
        || { exists: false, healthy: false, reason: "not-found", task: null },
      lastExit,
      lastTaskExits,
      runningCount: activeTasks.length,
      maxParallelTasks,
      legacyProcesses,
      desiredRuns: recoverySnapshot.records,
      recoveryByProfile: recoverySnapshot.byProfile,
    };
  }

  async function startLoop(profile) {
    return await startLoopInternal(profile, { recovery: false });
  }

  async function startLoopInternal(profile, startOptions = {}) {
    const processes = await loadProcessesFresh();
    const reservation = await reserveStart(profile.id, processes, startOptions.recovery ? "recovery" : "start");
    let desiredWritten = false;
    try {
      const stoppedLegacyProcesses = await stopLegacyProcesses(processes);
      if (!startOptions.recovery) {
        cancelRecovery(profile.id);
        await desiredRunStore.write(profile.id, {
          desiredState: "running",
          restartAttempt: 0,
          recoveryStatus: "starting",
          nextRetryAt: null,
          lastReason: null,
        });
        desiredWritten = true;
      }
      const run = await spawnAutomation(profile, "loop");
      const confirmed = await confirmStartup(run);
      await desiredRunStore.write(profile.id, {
        desiredState: "running",
        recoveryStatus: "running",
        nextRetryAt: null,
        lastReason: null,
      });
      return {
        ...confirmed,
        ...(stoppedLegacyProcesses.length ? { stoppedLegacyProcesses } : {}),
      };
    } catch (err) {
      if (
        !startOptions.recovery
        && desiredWritten
        && !activeRuns.has(profile.id)
        && !recoveryJobs.has(profile.id)
      ) {
        await desiredRunStore.write(profile.id, {
          desiredState: "stopped",
          recoveryStatus: "blocked",
          nextRetryAt: null,
          lastReason: err?.reason || err?.code || "start-failed",
        });
      }
      throw err;
    } finally {
      reservation.release();
    }
  }

  async function snapshot() {
    await settleProgressWrites();
    const processes = await processSnapshot.get();
    const statuses = await getPersistedActiveStatuses(processes);
    const observedStatuses = [];
    for (const status of statuses) observedStatuses.push(await observePersistedTask(status));
    const activeStatuses = observedStatuses.filter((status) => status.healthy);
    const activeTasks = activeStatuses.map((status) => {
      const task = summarizePersistedTask(status);
      const managedRun = activeRuns.get(task.profileId);
      return managedRun
        ? { ...task, teamOrderStatus: managedRun.teamOrderStatus || null }
        : task;
    });
    const activeTaskProfiles = new Set(activeTasks.map((task) => task.profileId));
    const memoryManagedTasks = Array.from(activeRuns.values())
      .filter((run) => run.registrationStatus === "startup-persistence-failed-pending-cleanup")
      .filter((run) => !activeTaskProfiles.has(run.profileId))
      .map(summarizeUnpersistedManagedRun);
    activeTasks.push(...memoryManagedTasks);
    const recoverySnapshot = await getRecoverySnapshot();
    applyRecoverySnapshot(activeTasks, recoverySnapshot.byProfile);
    const activeByProfile = Object.fromEntries(activeTasks.map((task) => [task.profileId, task]));
    const lastTaskExits = { ...(await readLastTaskExits(runtimeDir)), ...Object.fromEntries(recentExits) };
    return {
      active: activeTasks[0] || null,
      activeTasks,
      activeByProfile,
      activeTask: activeStatuses[0]
        || (memoryManagedTasks[0] ? summarizeMemoryManagedTask(memoryManagedTasks[0]) : null)
        || observedStatuses[0]
        || { exists: false, healthy: false, reason: "not-found", task: null },
      lastExit: mostRecentExit(lastTaskExits) || await readLastTaskExit(runtimeDir),
      lastTaskExits,
      runningCount: activeTasks.length,
      maxParallelTasks,
      legacyProcesses: detectLegacy(processes, getManagedPids(activeStatuses, processes)),
      desiredRuns: recoverySnapshot.records,
      recoveryByProfile: recoverySnapshot.byProfile,
    };
  }

  async function runOnce(profile, mode) {
    const begun = await beginRunOnce(profile, mode);
    return await begun.waitForExit();
  }

  async function beginRunOnce(profile, mode) {
    const processes = await loadProcessesFresh();
    const reservation = await reserveStart(profile.id, processes, "start");
    try {
      await stopLegacyProcesses(processes);
      const run = await spawnAutomation(profile, mode);
      return { waitForExit: () => waitForExit(run) };
    } finally {
      reservation.release();
    }
  }

  async function beginAutomationAlreadyCoordinated(profile, mode, startOptions = {}) {
    getActionForMode(mode);
    const processes = await loadProcessesFresh();
    const reservation = await reserveStart(
      profile.id,
      processes,
      startOptions.startupOrigin === "recovery" ? "recovery" : "start",
    );
    try {
      await stopLegacyProcesses(processes);
      const run = await spawnAutomation(profile, mode, {
        skipRuntimeSettingsWrite: true,
        coordinationToken: startOptions.coordinationToken,
        startupOrigin: startOptions.startupOrigin || "manual",
      });
      return {
        profileId: run.profileId,
        mode: run.mode,
        active: summarizeActive(run),
        confirmStartup: () => confirmStartup(run),
        waitForExit: () => waitForExit(run),
        updateCoordinationToken: (coordinationToken) => updateRunCoordinationToken(run, coordinationToken),
        flushDeferredRecovery: () => handleDeferredRunExitRecovery(run),
      };
    } finally {
      reservation.release();
    }
  }

  function beginRecoveryAlreadyCoordinated(profile, mode, startOptions = {}) {
    return beginAutomationAlreadyCoordinated(profile, mode, {
      ...startOptions,
      startupOrigin: "recovery",
    });
  }

  async function stop(profileId = null, stopOptions = {}) {
    if (profileId == null) {
      const statuses = await getPersistedActiveStatuses(await loadProcessesFresh());
      const desiredRecords = await desiredRunStore.list();
      const ids = new Set([
        ...Array.from(activeRuns.keys()),
        ...statuses.filter((status) => status.exists && status.task?.profileId).map((status) => status.task.profileId),
        ...desiredRecords.map((record) => record.profileId),
      ]);
      const stoppedTasks = [];
      for (const id of ids) {
        const result = await stopProfile(id, stopOptions);
        if (result.stopped) stoppedTasks.push(result);
      }
      return {
        stopped: stoppedTasks.length > 0,
        count: stoppedTasks.length,
        stoppedTasks,
      };
    }
    return await stopProfile(profileId, stopOptions);
  }

  async function stopProfile(profileId, stopOptions = {}) {
    const systemReservation = systemOperationCoordinator?.reserveRuntimeTransition
      ? await systemOperationCoordinator.reserveRuntimeTransition(profileId, "stop")
      : null;
    try {
      cancelRecovery(profileId);
      let result = null;
      let stopError = null;
      try {
        result = await stopOne(profileId, stopOptions);
      } catch (err) {
        stopError = err;
      }
      const desiredOutcome = await stopDesiredRunSafely(profileId, stopOptions);
      if (stopError) throw stopError;
      const summary = desiredOutcome.stopped && !result.stopped
        ? {
          stopped: true,
          profileId,
          reason: stopOptions.preserveDesiredState ? "system-shutdown" : "desired-state-stopped",
        }
        : result;
      return desiredOutcome.error
        ? { ...summary, persistenceWarning: summarizePersistenceWarning(desiredOutcome.error) }
        : summary;
    } finally {
      systemReservation?.release();
    }
  }

  async function stopLegacy() {
    const processes = await loadProcessesFresh();
    const stoppedProcesses = await stopLegacyProcesses(processes);
    return {
      stopped: stoppedProcesses.length > 0,
      count: stoppedProcesses.length,
      stoppedProcesses,
    };
  }

  async function stopLegacyProcesses(processes) {
    const statuses = await getPersistedActiveStatuses(processes);
    const legacyProcesses = detectLegacy(processes, getManagedPids(statuses, processes));
    const stoppedProcesses = [];
    for (const item of legacyProcesses) {
      await killProcessFn(item.pid);
      stoppedProcesses.push(item);
    }
    return stoppedProcesses;
  }

  async function confirmStartup(run) {
    if (!startupConfirmMs) {
      await markStartupConfirmed(run);
      return summarizeActive(run);
    }
    let onExit = null;
    const exitPromise = new Promise((resolve) => {
      if (run.finalized || run.exitCode != null || run.signal) {
        resolve("exit");
        return;
      }
      onExit = () => resolve("exit");
      run.handle.once("exit", onExit);
    });
    const readyPromise = run.readyAt ? Promise.resolve("ready") : run.readyPromise.then(() => "ready");
    const timerPromise = delay(startupConfirmMs).then(() => "timer");
    const result = await Promise.race([readyPromise, exitPromise, timerPromise]);
    if (result !== "exit" && onExit && run.handle.off) run.handle.off("exit", onExit);

    await settlePendingExits();
    if (result === "ready" || run.readyAt) {
      await markStartupConfirmed(run);
      return summarizeActive(run);
    }
    if (result === "exit" || run.finalized || run.exitCode != null || run.signal) {
      const exit = run.exitRecord || recentExits.get(run.profileId) || await readLastTaskExit(runtimeDir, run.profileId);
      throw buildAutomationStartError(run.profileId, exit || buildLastTaskExit(run));
    }

    const status = await getPersistedActive(await loadProcessesFresh(), run.profileId);
    if (!status.healthy) {
      const exit = recentExits.get(run.profileId) || await readLastTaskExit(runtimeDir, run.profileId);
      if (exit?.startedAt === run.startedAt) throw buildAutomationStartError(run.profileId, exit);
      throw buildAutomationStartError(run.profileId, {
        profileId: run.profileId,
        mode: run.mode,
        runtimeMode: run.runtimeMode || "process",
        pid: run.pid,
        threadId: run.threadId ?? null,
        statusDir: run.statusDir,
        logDir: run.logDir,
        logPath: run.logPath,
        startedAt: run.startedAt,
        exitedAt: null,
        exitCode: null,
        signal: null,
        reason: status.reason || "not-running",
        category: "runtime",
        message: "启动失败：未检测到运行中的任务。",
      });
    }
    throw buildAutomationStartError(run.profileId, {
      profileId: run.profileId,
      mode: run.mode,
      runtimeMode: run.runtimeMode || "process",
      pid: run.pid,
      threadId: run.threadId ?? null,
      statusDir: run.statusDir,
      logDir: run.logDir,
      logPath: run.logPath,
      startedAt: run.startedAt,
      exitedAt: null,
      exitCode: null,
      signal: null,
      reason: "startup-not-ready",
      category: "startup",
      message: STARTUP_NOT_READY_MESSAGE,
    });
  }

  async function stopOne(profileId, stopOptions = {}) {
    const run = activeRuns.get(profileId);
    if (run) {
      const stopped = stopOptions.preserveDesiredState
        ? buildShutdownStop(now())
        : buildOperatorStop(now());
      run.stopOverride = stopped;
      const wait = waitForExit(run);
      await stopActiveRun(run, stopped);
      const result = await wait;
      activeRuns.delete(profileId);
      await safeClearActiveTask(profileId, run);
      return { stopped: true, ...result };
    }

    const persisted = await getPersistedActive(await loadProcessesFresh(), profileId);
    if (!persisted.exists) return { stopped: false, reason: "not-running", profileId };
    const stopped = stopOptions.preserveDesiredState
      ? buildShutdownStop(now())
      : buildOperatorStop(now());
    if (persisted.healthy) {
      const statusDir = persisted.task.statusDir
        || path.join(runtimeDir, "status", profileId);
      try {
        await writeAutomationStopRequest(
          path.join(statusDir, "team-order-stop.json"),
          "user-stop",
        );
      } catch (err) {
        await reportRuntimePersistenceWarning("write automation stop request", profileId, err, persisted.task);
      }
      await delay(gracefulStopMs);
      const afterGrace = await getPersistedActive(await loadProcessesFresh(), profileId);
      if (afterGrace.healthy) {
        await killProcessFn(Number(persisted.task.pid));
      }
    }
    const exit = buildLastTaskExit({
      ...persisted.task,
      exitedAt: now().toISOString(),
      exitCode: null,
      signal: null,
    }, stopped);
    await safeWriteLastTaskExit(exit, persisted.task);
    await safeClearActiveTask(profileId, persisted.task);
    return { stopped: true, ...summarizePersistedTask(persisted), ...stopped };
  }

  async function spawnAutomation(profile, mode, spawnOptions = {}) {
    const profileId = profile.id;
    const statusDir = path.join(runtimeDir, "status", profileId);
    const logDir = path.join(runtimeDir, "logs", profileId);
    await fsp.mkdir(statusDir, { recursive: true });
    await fsp.mkdir(logDir, { recursive: true });
    const timestamp = formatTimestamp(now());
    const logPath = path.join(logDir, `auto-plant-${timestamp}.log`);
    const settingsPath = runtimeSettingsStore.settingsPath(profileId);
    if (!spawnOptions.skipRuntimeSettingsWrite) {
      await runtimeSettingsStore.write(profileId, profile.settings);
      await runtimeSettingsStore.drain(profileId);
    }
    const runId = randomUUID();
    const env = buildAutomationEnv({
      profileEnv: profile.env,
      profileId,
      settingsPath,
      runtimeDir,
      mode,
      statusDir,
      logPath,
      automationRunId: runId,
      baseEnv: process.env,
    });
    await clearAutomationStopRequest(env.TEAM_ORDER_STOP_PATH);
    recentExits.delete(profileId);
    await clearLastTaskExit(runtimeDir, profileId);
    await fsp.writeFile(logPath, "", "utf8");
    const logWriter = createRotatingLogWriter(logPath);
    const run = runtimeMode === "process"
      ? startProcessAutomation({ profileId, mode, statusDir, logDir, logPath, env, logWriter, runId })
      : startWorkerAutomation({ profileId, mode, statusDir, logDir, logPath, env, logWriter, runId });
    run.coordinationToken = spawnOptions.coordinationToken;
    run.startupOrigin = spawnOptions.startupOrigin || "legacy";
    run.startupConfirmed = false;
    activeRuns.set(profileId, run);
    try {
      await writeActiveTaskFn(runtimeDir, buildActiveTaskRecord(run));
    } catch (err) {
      run.stopOverride = {
        reason: "startup-persistence-failed",
        category: "runtime",
        message: "启动任务登记失败，已停止未登记的执行实例。",
      };
      try {
        await stopActiveRun(run, run.stopOverride);
        await waitForExit(run);
      } catch (cleanupError) {
        run.registrationStatus = "startup-persistence-failed-pending-cleanup";
        run.registrationError = err;
        run.cleanupError = cleanupError;
        throw buildStartupPersistenceCleanupError(err, cleanupError, run);
      }
      await run.logWriter?.settle?.();
      throw err;
    }
    return run;
  }

  function startProcessAutomation({ profileId, mode, statusDir, logDir, logPath, env, logWriter, runId }) {
    const child = spawnFn(nodeExe, [nodeScriptPath], {
      cwd: rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let run = null;
    const parseReady = createAutomationReadyParser((payload) => markAutomationReady(run, payload));
    child.stdout?.on("data", (chunk) => {
      logWriter.write(chunk);
      parseReady(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      logWriter.write(chunk);
      parseReady(chunk);
    });
    run = {
      profileId,
      mode,
      runtimeMode: "process",
      pid: child.pid,
      statusDir,
      logDir,
      logPath,
      runId,
      startedAt: now().toISOString(),
      handle: child,
      child,
      logWriter,
      artifactCompletion: {},
    };
    attachRunReadyState(run);
    child.once("exit", (exitCode, signal) => {
      const forcedStop = run.forcedStop || null;
      const stopped = run.stopOverride || forcedStop;
      run.exitPromise = finalizeRunExit(
        run,
        forcedStop ? SESSION_EXPIRED_EXIT_CODE : exitCode,
        forcedStop ? null : signal,
        stopped,
      )
        .finally(() => pendingExits.delete(profileId));
      pendingExits.set(profileId, run.exitPromise);
    });
    return run;
  }

  function startWorkerAutomation({ profileId, mode, statusDir, logDir, logPath, env, logWriter, runId }) {
    const workerData = { rootDir, env, profileId, mode };
    const worker = workerFactory(workerData);
    const run = {
      profileId,
      mode,
      runtimeMode: "worker",
      pid: worker.pid || process.pid,
      threadId: worker.threadId ?? null,
      statusDir,
      logDir,
      logPath,
      runId,
      startedAt: now().toISOString(),
      handle: worker,
      worker,
      logWriter,
      artifactCompletion: {},
    };
    attachRunReadyState(run);
    worker.on("message", (message) => {
      if (message?.type === "log") {
        logWriter.write(message.text || "");
      }
      if (message?.type === "automationReady") {
        recordAutomationArtifactCompletion(run, message.artifactCompletion);
        markAutomationReady(run, message);
      }
      if (message?.type === "automationArtifactNotReady") {
        markAutomationArtifactNotReady(run, message);
      }
      if (message?.type === "artifactCompletion") {
        recordAutomationArtifactCompletion(run, message);
      }
      if (message?.type === "automationProgress") {
        queueAutomationProgress(run, message);
      }
      if (message?.type === "automationExit" && message.classification) {
        run.exitClassification = sanitizeExitClassification(message.classification);
      }
      if (
        message?.type === "teamOrderStatus"
        && message.profileId === run.profileId
      ) {
        run.teamOrderStatus = message.status || null;
      }
    });
    worker.once("error", (err) => {
      logWriter.write(`${JSON.stringify({
        step: "workerError",
        profileId,
        message: err?.message || String(err),
      })}\n`);
    });
    worker.once("exit", (exitCode) => {
      const forcedStop = run.forcedStop || null;
      const stopped = run.stopOverride || forcedStop;
      run.exitPromise = finalizeRunExit(
        run,
        forcedStop ? SESSION_EXPIRED_EXIT_CODE : exitCode,
        null,
        stopped,
      )
        .finally(() => pendingExits.delete(profileId));
      pendingExits.set(profileId, run.exitPromise);
    });
    return run;
  }

  async function finalizeRunExit(run, exitCode, signal, stopped = null) {
    if (run.finalized) return run.exitRecord || null;
    run.finalized = true;
    run.exitCode = exitCode;
    run.signal = signal;
    run.exitedAt = now().toISOString();
    await run.progressWritePromise?.catch(() => {});
    await run.coordinationWritePromise?.catch(() => {});
    await run.logWriter?.settle();
    await cleanupRuntimeArtifactTemps(run.statusDir).catch((err) => (
      reportRuntimePersistenceWarning("clean runtime artifact temp files", run.profileId, err, run)
    ));
    const statusStopped = stopped
      || await readAutomationStoppedForRun(run.statusDir, run)
      || run.exitClassification;
    const exit = buildLastTaskExit(run, statusStopped);
    run.exitRecord = exit;
    recentExits.set(run.profileId, exit);
    await safeWriteLastTaskExit(exit, run);
    await safeClearActiveTask(run.profileId, run);
    if (activeRuns.get(run.profileId) === run) activeRuns.delete(run.profileId);
    await handleRunExitRecovery(run, exit);
    return exit;
  }

  async function handleRunExitRecovery(run, exit, recoveryOptions = {}) {
    if (exit.category === "shutdown") return;
    if (run.mode !== "loop") return;
    if (recoveryCoordinator) {
      if (!recoveryOptions.startupOwnershipOverride && !run.startupRecoveryOwnedByProcessManager) {
        if (isInitialCoordinatedStartupSessionExpiry(run, exit)) {
          await scheduleRecovery(run.profileId, exit, {
            resetAttempt: false,
            coordinationToken: run.coordinationToken,
          });
          return;
        }
        run.deferredRecoveryExit = exit;
        return;
      }
      if (shouldAutoRecover(exit, recoveryIntentFromToken(run.coordinationToken))) {
        await scheduleRecovery(run.profileId, exit, {
          resetAttempt: didRunStayHealthy(run),
          coordinationToken: run.coordinationToken,
        });
      } else {
        await coordinateRecoveryPhase({
          phase: "terminal",
          profileId: run.profileId,
          cause: exit,
          coordinationToken: run.coordinationToken,
        });
      }
      return;
    }
    const desired = await desiredRunStore.read(run.profileId);
    if (shouldAutoRecover(exit, desired || {})) {
      await scheduleRecovery(run.profileId, exit, {
        resetAttempt: didRunStayHealthy(run),
      });
      return;
    }
    if (desired?.desiredState === "running") {
      cancelRecovery(run.profileId);
      try {
        await desiredRunStore.write(run.profileId, {
          desiredState: "stopped",
          recoveryStatus: exit.category === "operator" ? "stopped" : "blocked",
          nextRetryAt: null,
          lastReason: exit.reason || exit.category || "not-recoverable",
        });
      } catch (err) {
        await reportRuntimePersistenceWarning("write desired state after terminal exit", run.profileId, err, run);
      }
    }
  }

  async function scheduleRecovery(profileId, cause = {}, scheduleOptions = {}) {
    if (recoveryScheduleFlights.has(profileId)) return await recoveryScheduleFlights.get(profileId);
    const flight = scheduleRecoveryOnce(profileId, cause, scheduleOptions)
      .finally(() => {
        if (recoveryScheduleFlights.get(profileId) === flight) {
          recoveryScheduleFlights.delete(profileId);
        }
      });
    recoveryScheduleFlights.set(profileId, flight);
    return await flight;
  }

  async function scheduleRecoveryOnce(profileId, cause = {}, scheduleOptions = {}) {
    if (recoveryPaused || recoveryJobs.has(profileId) || activeRuns.has(profileId)) return null;
    let attempt;
    let delayMs;
    let nextRetryAt;
    if (recoveryCoordinator) {
      const result = await coordinateRecoveryPhase({
        phase: "schedule",
        profileId,
        cause,
        coordinationToken: scheduleOptions.coordinationToken,
        resetAttempt: Boolean(scheduleOptions.resetAttempt),
        ...(scheduleOptions.delayMs == null ? {} : { delayMs: scheduleOptions.delayMs }),
      });
      if (result?.status !== "scheduled") return result;
      if (!isScheduledRecoveryResult(result)) {
        const failed = buildRecoveryCoordinationFailure({
          phase: "schedule",
          profileId,
          reason: "invalid-schedule-result",
        });
        warnRecoveryCoordinationFailure(failed);
        return failed;
      }
      ({ attempt, delayMs, nextRetryAt } = result);
      scheduleOptions = {
        ...scheduleOptions,
        coordinationToken: result.coordinationToken ?? scheduleOptions.coordinationToken,
      };
    } else {
      const desired = await desiredRunStore.read(profileId);
      if (desired?.desiredState !== "running") return null;
      const previousAttempt = scheduleOptions.resetAttempt ? 0 : desired.restartAttempt;
      attempt = Math.max(1, previousAttempt + 1);
      delayMs = scheduleOptions.delayMs ?? getRecoveryDelayMs(attempt);
      const scheduledAt = now();
      nextRetryAt = new Date(scheduledAt.getTime() + delayMs).toISOString();
      await desiredRunStore.write(profileId, {
        desiredState: "running",
        restartAttempt: attempt,
        recoveryStatus: "scheduled",
        nextRetryAt,
        lastReason: cause.reason || cause.category || "recovery",
      });
    }

    const job = {
      profileId,
      attempt,
      delayMs,
      cause,
      timer: null,
      promise: null,
      cancelled: false,
      coordinationToken: scheduleOptions.coordinationToken,
    };
    const runRecovery = () => {
      if (job.cancelled) return Promise.resolve(null);
      if (recoveryJobs.get(profileId) === job) recoveryJobs.delete(profileId);
      runningRecoveryJobs.set(profileId, job);
      job.promise = performRecovery(job).finally(() => {
        if (runningRecoveryJobs.get(profileId) === job) {
          runningRecoveryJobs.delete(profileId);
        }
      });
      return job.promise;
    };
    const timerTrampoline = () => Promise.resolve().then(runRecovery).catch((error) => {
      const failed = buildRecoveryCoordinationFailure({
        phase: "attempt",
        profileId,
        attempt,
        error,
      });
      warnRecoveryCoordinationFailure(failed);
      return failed;
    });
    job.timer = setRecoveryTimerFn(timerTrampoline, delayMs);
    job.timer?.unref?.();
    recoveryJobs.set(profileId, job);
    const scheduled = {
      profileId,
      attempt,
      delayMs,
      nextRetryAt,
      ...(job.coordinationToken !== undefined
        ? { coordinationToken: job.coordinationToken }
        : {}),
    };
    return recoveryCoordinator ? { status: "scheduled", ...scheduled } : scheduled;
  }

  async function performRecovery(job) {
    if (recoveryCoordinator) {
      if (recoveryPaused || job.cancelled) return null;
      if (activeRuns.has(job.profileId)) return summarizeActive(activeRuns.get(job.profileId));
      const result = await coordinateRecoveryPhase({
        phase: "attempt",
        profileId: job.profileId,
        mode: "loop",
        attempt: job.attempt,
        cause: job.cause,
        coordinationToken: job.coordinationToken,
        beginAutomationAlreadyCoordinated: beginRecoveryAlreadyCoordinated,
      });
      if (result?.status !== "retry") return result;
      return await scheduleRecovery(job.profileId, {
        reason: result.reason || "coordinated-retry",
        category: result.category || "runtime",
      }, {
        ...(result.delayMs == null ? {} : { delayMs: result.delayMs }),
        coordinationToken: result.coordinationToken ?? job.coordinationToken,
      });
    }
    const desired = await desiredRunStore.read(job.profileId);
    if (recoveryPaused || job.cancelled || desired?.desiredState !== "running") return null;
    if (activeRuns.has(job.profileId)) return summarizeActive(activeRuns.get(job.profileId));
    if (!profileLoader) {
      await blockDesiredRecovery(job.profileId, "profile-loader-unavailable");
      return null;
    }

    try {
      const profile = await profileLoader(job.profileId);
      const latestDesired = await desiredRunStore.read(job.profileId);
      if (
        recoveryPaused
        || job.cancelled
        || latestDesired?.desiredState !== "running"
      ) {
        return null;
      }
      const started = await startLoopInternal(profile, { recovery: true });
      await desiredRunStore.write(job.profileId, {
        desiredState: "running",
        recoveryStatus: "running",
        nextRetryAt: null,
        lastReason: null,
      });
      return started;
    } catch (err) {
      if (recoveryPaused || job.cancelled) return null;
      if (err?.code === "ACTIVE_AUTOMATION_RUNNING") {
        await desiredRunStore.write(job.profileId, {
          desiredState: "running",
          recoveryStatus: "running",
          nextRetryAt: null,
          lastReason: null,
        });
        return null;
      }
      if (recoveryJobs.has(job.profileId)) return null;
      if (err?.code === "MAX_PARALLEL_TASKS_REACHED") {
        return await scheduleRecovery(job.profileId, {
          reason: "max-parallel-tasks",
          category: "runtime",
        });
      }
      if (isTransientRecoveryStartError(err)) {
        return await scheduleRecovery(job.profileId, {
          reason: err.reason || err.code || "transient-runtime",
          category: err.category || "runtime",
        });
      }
      await blockDesiredRecovery(
        job.profileId,
        err?.reason || err?.code || "recovery-start-failed",
      );
      return null;
    }
  }

  async function coordinateRecoveryPhase(request) {
    try {
      return await recoveryCoordinator(request);
    } catch (error) {
      const failed = buildRecoveryCoordinationFailure({
        phase: request.phase,
        profileId: request.profileId,
        attempt: request.attempt,
        error,
      });
      warnRecoveryCoordinationFailure(failed);
      return failed;
    }
  }

  function warnRecoveryCoordinationFailure(failed) {
    try {
      warnFn(
        `[runtime-warning] coordinated recovery ${failed.phase} failed for profile ${failed.profileId || "-"}: ${failed.code || ""} ${failed.message || failed.reason}`,
      );
    } catch {}
  }

  async function blockDesiredRecovery(profileId, reason) {
    cancelRecovery(profileId);
    await desiredRunStore.write(profileId, {
      desiredState: "stopped",
      recoveryStatus: "blocked",
      nextRetryAt: null,
      lastReason: reason,
    });
  }

  function cancelRecovery(profileId) {
    let cancelled = false;
    const scheduledJob = recoveryJobs.get(profileId);
    if (scheduledJob) {
      scheduledJob.cancelled = true;
      if (scheduledJob.timer) clearRecoveryTimerFn(scheduledJob.timer);
      recoveryJobs.delete(profileId);
      cancelled = true;
    }
    const runningJob = runningRecoveryJobs.get(profileId);
    if (runningJob) {
      runningJob.cancelled = true;
      cancelled = true;
    }
    return cancelled;
  }

  async function stopDesiredRun(profileId, stopOptions = {}) {
    cancelRecovery(profileId);
    if (stopOptions.preserveDesiredState) {
      return false;
    }
    if (recoveryCoordinator) {
      const result = await coordinateRecoveryPhase({
        phase: "stop",
        profileId,
        cause: { reason: "user-stopped", category: "operator" },
      });
      return result?.status === "stopped" && result.stopped !== false;
    }
    const previous = await desiredRunStore.read(profileId);
    if (!previous) return false;
    await desiredRunStore.write(profileId, {
      desiredState: "stopped",
      recoveryStatus: "stopped",
      nextRetryAt: null,
      lastReason: "user-stopped",
    });
    return previous.desiredState === "running";
  }

  async function stopDesiredRunSafely(profileId, stopOptions = {}) {
    try {
      return { stopped: await stopDesiredRun(profileId, stopOptions), error: null };
    } catch (err) {
      await reportRuntimePersistenceWarning(
        "write desired state for user stop",
        profileId,
        err,
        activeRuns.get(profileId) || {},
      );
      return { stopped: false, error: err };
    }
  }

  async function restoreDesiredLoops() {
    recoveryPaused = false;
    const inspection = recoveryCoordinator
      ? await coordinateRecoveryPhase({ phase: "restore-inspect" })
      : null;
    const records = recoveryCoordinator
      ? (inspection?.status === "inspected" && Array.isArray(inspection.records)
        ? inspection.records
        : [])
      : await desiredRunStore.list();
    const desiredRuns = records
      .filter((record) => record.desiredState === "running" && record.mode === "loop");
    let scheduled = 0;
    for (const desired of desiredRuns) {
      try {
        if (activeRuns.has(desired.profileId) || recoveryJobs.has(desired.profileId)) continue;
        const statusStopped = await readAutomationStopped(
          path.join(runtimeDir, "status", desired.profileId),
        );
        const lastExit = await readLastTaskExit(runtimeDir, desired.profileId);
        const terminalExit = lastExit?.reason
          ? lastExit
          : (statusStopped?.reason ? { mode: "loop", ...statusStopped } : null);
        if (
          terminalExit
          && !shouldAutoRecover({ mode: "loop", ...terminalExit }, desired)
          && !["completed", "system-shutdown"].includes(terminalExit.reason)
        ) {
          if (recoveryCoordinator) {
            await coordinateRecoveryPhase({
              phase: "terminal",
              profileId: desired.profileId,
              cause: terminalExit,
              coordinationToken: desired.coordinationToken,
            });
          } else {
            await blockDesiredRecovery(
              desired.profileId,
              terminalExit.reason || terminalExit.category || "not-recoverable",
            );
          }
          continue;
        }
        const recovery = await scheduleRecovery(
          desired.profileId,
          { reason: "server-restart", category: "worker" },
          { delayMs: 0, coordinationToken: desired.coordinationToken },
        );
        if (recovery && (!recoveryCoordinator || recovery.status === "scheduled")) scheduled += 1;
      } catch (error) {
        warnRecoveryCoordinationFailure(buildRecoveryCoordinationFailure({
          phase: "restore-profile",
          profileId: desired.profileId,
          error,
        }));
      }
    }
    return {
      desired: desiredRuns.length,
      scheduled,
    };
  }

  function didRunStayHealthy(run) {
    if (!recoveryHealthyResetMs) return true;
    const startedAtMs = Date.parse(run.startedAt || "");
    const exitedAtMs = Date.parse(run.exitedAt || "");
    return Number.isFinite(startedAtMs)
      && Number.isFinite(exitedAtMs)
      && exitedAtMs - startedAtMs >= recoveryHealthyResetMs;
  }

  async function getRecoverySnapshot() {
    const records = await desiredRunStore.list();
    const byProfile = Object.fromEntries(records.map((record) => [
      record.profileId,
      {
        ...record,
        recoveryPending: recoveryJobs.has(record.profileId)
          || runningRecoveryJobs.has(record.profileId),
      },
    ]));
    return { records: Object.values(byProfile), byProfile };
  }

  function applyRecoverySnapshot(tasks, byProfile) {
    for (const task of tasks) {
      const recovery = byProfile[task.profileId];
      if (!recovery) continue;
      task.desiredState = recovery.desiredState;
      task.recoveryStatus = recovery.recoveryStatus;
      task.restartAttempt = recovery.restartAttempt;
      task.nextRetryAt = recovery.nextRetryAt;
    }
  }

  function detectLegacy(processes, managedPids = getManagedPids([], processes)) {
    return detectLegacyAutomationProcesses({
      processes,
      selfPid: process.pid,
      managedPids,
      nodeScriptPath,
      runScriptPath,
    });
  }

  async function reserveStart(profileId, processes, kind = "start") {
    const systemReservation = systemOperationCoordinator?.reserveRuntimeTransition
      ? await systemOperationCoordinator.reserveRuntimeTransition(profileId, kind)
      : null;
    try {
      const profileReservation = await startAdmission.reserve(profileId, async () => {
        const statuses = await getPersistedActiveStatuses(processes);
        const sameProfile = statuses.find((status) => status.task?.profileId === profileId);
        if (sameProfile?.exists && !sameProfile.healthy) {
          await safeClearActiveTask(profileId, sameProfile.task);
        }
        const runningProfiles = new Set(
          statuses.filter((status) => status.healthy).map((status) => status.task.profileId),
        );
        for (const id of activeRuns.keys()) runningProfiles.add(id);
        return runningProfiles;
      });
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          profileReservation.release();
          systemReservation?.release();
        },
      };
    } catch (error) {
      systemReservation?.release();
      throw error;
    }
  }

  async function getPersistedActive(processes, profileId) {
    const task = await readActiveTask(runtimeDir, profileId);
    return evaluateRunnerActiveTask(task, processes);
  }

  async function getPersistedActiveStatuses(processes) {
    const tasks = await readActiveTasks(runtimeDir);
    return tasks.map((task) => evaluateRunnerActiveTask(task, processes));
  }

  function evaluateRunnerActiveTask(task, processes) {
    const status = evaluateActiveTask(task, { processes, rootDir });
    if (
      task?.runtimeMode === "worker"
      && task.profileId
      && !activeRuns.has(task.profileId)
      && status.exists
      && status.healthy
    ) {
      return { ...status, healthy: false, reason: "worker-handle-not-found" };
    }
    return status;
  }

  async function reconcileSessionExpiredActiveRuns() {
    for (const run of Array.from(activeRuns.values())) {
      const stopped = await readSessionExpiredStop(run.statusDir);
      if (!matchesAutomationStoppedRun(stopped, run)) continue;
      run.forcedStop = stopped;
      try {
        await stopActiveRun(run);
      } catch {}
      await finalizeRunExit(run, SESSION_EXPIRED_EXIT_CODE, null, stopped);
    }
  }

  async function reconcileSessionExpiredPersistedTask(activeTask) {
    if (!activeTask?.exists || !activeTask.task) return activeTask;
    const stopped = await readSessionExpiredStop(activeTask.task.statusDir);
    if (!matchesAutomationStoppedRun(stopped, activeTask.task)) return activeTask;
    if (activeTask.healthy && activeTask.task.pid) {
      await killProcessFn(Number(activeTask.task.pid));
    }
    const exit = buildLastTaskExit({
      ...activeTask.task,
      exitCode: SESSION_EXPIRED_EXIT_CODE,
      signal: null,
      exitedAt: now().toISOString(),
    }, stopped);
    recentExits.set(activeTask.task.profileId, exit);
    await safeWriteLastTaskExit(exit, activeTask.task);
    await safeClearActiveTask(activeTask.task.profileId, activeTask.task);
    if (activeTask.task.mode === "loop") {
      await handlePersistedExitRecovery(exit);
    }
    return { exists: false, healthy: false, reason: "session-expired", task: activeTask.task };
  }

  async function observePersistedTask(activeTask) {
    if (!activeTask?.exists || !activeTask.task) return activeTask;
    const stopped = await readSessionExpiredStop(activeTask.task.statusDir);
    return matchesAutomationStoppedRun(stopped, activeTask.task)
      ? { ...activeTask, healthy: false, reason: "session-expired" }
      : activeTask;
  }

  async function reconcileDeadPersistedTask(activeTask) {
    if (!activeTask?.exists || activeTask.healthy || !activeTask.task) return activeTask;
    if (!["pid-not-found", "worker-handle-not-found"].includes(activeTask.reason)) return activeTask;
    const stopped = activeTask.reason === "worker-handle-not-found"
      ? {
        reason: "worker-handle-not-found",
        category: "worker",
        message: "托管自动化 worker 已不存在，已自动清理运行锁。",
      }
      : {
        reason: "pid-not-found",
        category: "process",
        message: "托管自动化进程已不存在，已自动清理运行锁。",
      };
    const exit = buildLastTaskExit({
      ...activeTask.task,
      exitCode: null,
      signal: null,
      exitedAt: now().toISOString(),
    }, stopped);
    recentExits.set(activeTask.task.profileId, exit);
    await safeWriteLastTaskExit(exit, activeTask.task);
    await safeClearActiveTask(activeTask.task.profileId, activeTask.task);
    await handlePersistedExitRecovery(exit);
    return { exists: false, healthy: false, reason: "pid-not-found", task: activeTask.task };
  }

  async function handlePersistedExitRecovery(exit) {
    if (exit.mode !== "loop") return;
    if (recoveryCoordinator) {
      if (shouldAutoRecover(exit, recoveryIntentFromToken(exit.coordinationToken))) {
        await scheduleRecovery(exit.profileId, exit, {
          coordinationToken: exit.coordinationToken,
        });
      } else {
        await coordinateRecoveryPhase({
          phase: "terminal",
          profileId: exit.profileId,
          cause: exit,
          coordinationToken: exit.coordinationToken,
        });
      }
      return;
    }
    const desired = await desiredRunStore.read(exit.profileId);
    if (shouldAutoRecover(exit, desired || {})) {
      await scheduleRecovery(exit.profileId, exit);
      return;
    }
    if (desired?.desiredState === "running") {
      await blockDesiredRecovery(
        exit.profileId,
        exit.reason || exit.category || "not-recoverable",
      );
    }
  }

  async function safeWriteLastTaskExit(exit, run = {}) {
    try {
      await writeLastTaskExitFn(runtimeDir, exit);
    } catch (err) {
      await reportRuntimePersistenceWarning("write last task exit", exit.profileId, err, run);
    }
  }

  async function safeClearActiveTask(profileId, run = {}) {
    try {
      await clearActiveTaskFn(runtimeDir, profileId);
    } catch (err) {
      await reportRuntimePersistenceWarning("clear active task", profileId, err, run);
    }
  }

  async function reportRuntimePersistenceWarning(action, profileId, err, run = {}) {
    const message = `[runtime-warning] ${action} failed for profile ${profileId || "-"}: ${err?.code || ""} ${err?.message || err}`;
    warnFn(message);
    if (!run?.logPath) return;
    try {
      await run.logWriter?.write?.(`${JSON.stringify({
        step: "runtimePersistenceWarning",
        action,
        profileId,
        code: err?.code || null,
        message: err?.message || String(err),
      })}\n`);
    } catch {}
  }

  function getManagedPids(statuses = [], processes = []) {
    const managedPids = new Set();
    for (const run of activeRuns.values()) {
      if (run.pid) managedPids.add(Number(run.pid));
    }
    for (const status of statuses) {
      if (status?.healthy && status.task?.pid) managedPids.add(Number(status.task.pid));
    }
    addDescendantPids(managedPids, processes);
    return managedPids;
  }

  async function settlePendingExits() {
    if (!pendingExits.size) return;
    await Promise.allSettled(Array.from(pendingExits.values()));
  }

  async function settleProgressWrites() {
    await Promise.allSettled(
      Array.from(activeRuns.values())
        .map((run) => run.progressWritePromise)
        .filter(Boolean),
    );
  }

  function attachRunReadyState(run) {
    run.startupState = "starting";
    run.lastProgressAt = run.startedAt;
    run.lastProgressStep = "worker-started";
    run.readyPromise = new Promise((resolve) => {
      run.resolveReady = resolve;
    });
  }

  async function markAutomationReady(run, payload = {}) {
    if (!run || run.finalized) return;
    recordAutomationArtifactCompletion(run, payload.artifactCompletion);
    let shouldResolve = false;
    if (!run.readyAt) {
      run.readyAt = payload.readyAt || now().toISOString();
      run.readyStep = payload.step || "automationReady";
      run.startupState = "ready";
      shouldResolve = true;
    }
    applyAutomationProgress(run, {
      at: payload.readyAt || run.readyAt,
      step: payload.step || "automationReady",
      cycle: payload.cycle,
    });
    await writeActiveTaskFn(runtimeDir, buildActiveTaskRecord(run)).catch((err) => (
      reportRuntimePersistenceWarning("write active task ready", run.profileId, err, run)
    ));
    if (shouldResolve) run.resolveReady?.();
  }

  async function markAutomationArtifactNotReady(run, payload = {}) {
    if (!run || run.finalized) return;
    recordAutomationArtifactCompletion(run, payload);
    run.startupState = "not-ready";
    run.startupNotReadyReason = payload.reason || payload.status || "artifact-incomplete";
    await writeActiveTaskFn(runtimeDir, buildActiveTaskRecord(run)).catch((err) => (
      reportRuntimePersistenceWarning("write active task artifact not ready", run.profileId, err, run)
    ));
  }

  function recordAutomationArtifactCompletion(run, payload = {}) {
    if (!run || !payload?.chain) return false;
    run.artifactCompletion = {
      ...(run.artifactCompletion || {}),
      [payload.chain]: payload,
    };
    return true;
  }

  function applyAutomationProgress(run, payload = {}) {
    if (!run || run.finalized) return false;
    const candidate = new Date(payload.at || now());
    const progressAt = Number.isNaN(candidate.getTime()) ? now() : candidate;
    const previousMs = Date.parse(run.lastProgressAt || "");
    if (Number.isFinite(previousMs) && progressAt.getTime() < previousMs) return false;
    run.lastProgressAt = progressAt.toISOString();
    run.lastProgressStep = String(payload.step || "worker-progress");
    run.lastProgressCycle = payload.cycle ?? null;
    return true;
  }

  function queueAutomationProgress(run, payload = {}) {
    if (!applyAutomationProgress(run, payload)) return;
    run.progressWritePromise = Promise.resolve(run.progressWritePromise)
      .catch(() => {})
      .then(async () => {
        await writeActiveTaskFn(runtimeDir, buildActiveTaskRecord(run));
        await resetRecoveryAttemptAfterHealthyProgress(run);
      })
      .catch((err) => reportRuntimePersistenceWarning(
        "write active task progress",
        run.profileId,
        err,
        run,
      ));
  }

  async function resetRecoveryAttemptAfterHealthyProgress(run) {
    if (run.recoveryAttemptReset || !recoveryHealthyResetMs) return;
    const startedAtMs = Date.parse(run.startedAt || "");
    const progressAtMs = Date.parse(run.lastProgressAt || "");
    if (
      !Number.isFinite(startedAtMs)
      || !Number.isFinite(progressAtMs)
      || progressAtMs - startedAtMs < recoveryHealthyResetMs
    ) {
      return;
    }
    if (recoveryCoordinator) {
      const result = await coordinateRecoveryPhase({
        phase: "healthy-reset",
        profileId: run.profileId,
        coordinationToken: run.coordinationToken,
        cause: {
          startedAt: run.startedAt,
          lastProgressAt: run.lastProgressAt,
          lastProgressStep: run.lastProgressStep,
        },
      });
      if (result?.status !== "failed") {
        run.recoveryAttemptReset = true;
        if (result?.coordinationToken !== undefined) {
          await updateRunCoordinationToken(run, result.coordinationToken);
        }
      }
      return;
    }
    const desired = await desiredRunStore.read(run.profileId);
    if (desired?.desiredState !== "running" || desired.restartAttempt === 0) {
      run.recoveryAttemptReset = true;
      return;
    }
    await desiredRunStore.write(run.profileId, {
      desiredState: "running",
      restartAttempt: 0,
      recoveryStatus: "running",
      nextRetryAt: null,
      lastReason: null,
    });
    run.recoveryAttemptReset = true;
  }

  async function checkWatchdogs(referenceTime = now()) {
    if (watchdogStaleMs <= 0) return [];
    const checkedAt = new Date(referenceTime);
    const checkedAtMs = checkedAt.getTime();
    const stalledRuns = [];
    for (const run of Array.from(activeRuns.values())) {
      if (
        run.mode !== "loop"
        || run.finalized
        || run.watchdogStopping
        || run.stopOverride
      ) {
        continue;
      }
      const lastProgressAtMs = Date.parse(run.lastProgressAt || run.startedAt || "");
      if (!Number.isFinite(lastProgressAtMs)) continue;
      const staleForMs = checkedAtMs - lastProgressAtMs;
      if (staleForMs <= watchdogStaleMs) continue;
      const preservedExit = run.exitClassification || null;
      const stalled = preservedExit
        ? {
            ...preservedExit,
            stoppedAt: formatDateTime(checkedAt),
            step: run.lastProgressStep || null,
          }
        : {
            reason: "stalled",
            category: "stalled",
            message: `worker 超过 ${Math.ceil(watchdogStaleMs / 1000)} 秒无进展，已停止并等待恢复。`,
            stoppedAt: formatDateTime(checkedAt),
            step: run.lastProgressStep || null,
          };
      run.watchdogStopping = true;
      run.stopOverride = stalled;
      stalledRuns.push({
        profileId: run.profileId,
        staleForMs,
        lastProgressAt: run.lastProgressAt,
        lastProgressStep: run.lastProgressStep,
      });
      await run.logWriter?.write?.(`${JSON.stringify({
        step: "workerStalled",
        profileId: run.profileId,
        staleForMs,
        lastProgressAt: run.lastProgressAt,
        lastProgressStep: run.lastProgressStep,
        preservedExitReason: preservedExit?.reason || null,
      })}\n`);
      try {
        await stopActiveRun(run, stalled);
      } catch (err) {
        run.watchdogStopping = false;
        throw err;
      }
    }
    return stalledRuns;
  }

  function buildActiveTaskRecord(run) {
    return {
      profileId: run.profileId,
      mode: run.mode,
      runtimeMode: run.runtimeMode,
      pid: run.pid,
      threadId: run.threadId ?? undefined,
      rootDir,
      statusDir: run.statusDir,
      logDir: run.logDir,
      logPath: run.logPath,
      runId: run.runId,
      startedAt: run.startedAt,
      startupState: run.startupState || "starting",
      startupOrigin: run.startupOrigin || "legacy",
      startupConfirmed: Boolean(run.startupConfirmed),
      startupRecoveryOwner: run.startupRecoveryOwnedByProcessManager
        ? "process-manager"
        : "confirmation",
      readyAt: run.readyAt || undefined,
      readyStep: run.readyStep || undefined,
      lastProgressAt: run.lastProgressAt || undefined,
      lastProgressStep: run.lastProgressStep || undefined,
      ...(run.lastProgressCycle != null ? { lastProgressCycle: run.lastProgressCycle } : {}),
      ...(run.coordinationToken !== undefined ? { coordinationToken: run.coordinationToken } : {}),
      ...(run.artifactCompletion && Object.keys(run.artifactCompletion).length
        ? { artifactCompletion: run.artifactCompletion }
        : {}),
      ...(run.startupNotReadyReason ? { startupNotReadyReason: run.startupNotReadyReason } : {}),
    };
  }

  function updateRunCoordinationToken(run, coordinationToken) {
    run.coordinationToken = coordinationToken;
    run.startupRecoveryOwnershipRequested = true;
    if (run.startupConfirmed) run.startupRecoveryOwnedByProcessManager = true;
    if (run.finalized) return Promise.resolve(false);
    return queueRunStateWrite(run, "write active task coordination token");
  }

  async function markStartupConfirmed(run) {
    if (run.startupConfirmed) return true;
    run.startupConfirmed = true;
    if (run.startupRecoveryOwnershipRequested) {
      run.startupRecoveryOwnedByProcessManager = true;
    }
    if (run.finalized) {
      await handleDeferredRunExitRecovery(run);
      return false;
    }
    await queueRunStateWrite(run, "write active task startup confirmation");
    return true;
  }

  async function handleDeferredRunExitRecovery(run) {
    if (
      !run.startupRecoveryOwnedByProcessManager
      || !run.deferredRecoveryExit
      || run.deferredRecoveryHandled
    ) {
      return false;
    }
    run.deferredRecoveryHandled = true;
    await handleRunExitRecovery(run, run.deferredRecoveryExit, {
      startupOwnershipOverride: true,
    });
    return true;
  }

  function queueRunStateWrite(run, operation) {
    run.coordinationWritePromise = Promise.resolve(run.coordinationWritePromise)
      .catch(() => {})
      .then(() => writeActiveTaskFn(runtimeDir, buildActiveTaskRecord(run)))
      .catch((err) => reportRuntimePersistenceWarning(
        operation,
        run.profileId,
        err,
        run,
      ));
    return run.coordinationWritePromise;
  }

  async function stopActiveRun(run, stopped = null) {
    if (stopped) run.stopOverride = stopped;
    if (["user-stopped", "system-shutdown"].includes(stopped?.reason)) {
      const stopPath = path.join(run.statusDir, "team-order-stop.json");
      const stopReason = stopped.reason === "system-shutdown" ? "system-shutdown" : "user-stop";
      try {
        await writeAutomationStopRequest(stopPath, stopReason);
      } catch (err) {
        await reportRuntimePersistenceWarning("write automation stop request", run.profileId, err, run);
      }
      if (run.runtimeMode === "worker" && run.worker?.postMessage) {
        run.worker.postMessage({ type: "stop", reason: stopReason });
      }
      const canRequestGracefulStop = run.runtimeMode !== "worker" || Boolean(run.worker?.postMessage);
      if (canRequestGracefulStop && await waitForGracefulExit(run, gracefulStopMs)) return;
    }
    if (run.runtimeMode === "worker" && run.worker?.terminate) {
      await run.worker.terminate();
      return;
    }
    await killProcessFn(Number(run.pid));
  }

  async function shutdown() {
    recoveryPaused = true;
    return await stop(null, { preserveDesiredState: true });
  }

  return {
    runtime,
    snapshot,
    startLoop,
    beginAutomationAlreadyCoordinated,
    beginRunOnce,
    runOnce,
    stop,
    stopLegacy,
    checkWatchdogs,
    restoreDesiredLoops,
    shutdown,
  };
}

function normalizeNonNegativeInteger(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function isScheduledRecoveryResult(result) {
  return Boolean(
    result
    && Number.isSafeInteger(result.attempt)
    && result.attempt > 0
    && Number.isSafeInteger(result.delayMs)
    && result.delayMs >= 0
    && typeof result.nextRetryAt === "string"
    && Number.isFinite(Date.parse(result.nextRetryAt)),
  );
}

function recoveryIntentFromToken(token) {
  return {
    desiredState: "running",
    restartAttempt: token?.restartAttempt ?? 0,
  };
}

function isInitialCoordinatedStartupSessionExpiry(run, exit) {
  return Boolean(
    run?.coordinationToken
    && !run.startupConfirmed
    && exit?.reason === "session-expired"
    && exit?.category === "login-state"
    && shouldAutoRecover(exit, recoveryIntentFromToken(run.coordinationToken)),
  );
}

function buildRecoveryCoordinationFailure({ phase, profileId, attempt, error, reason }) {
  return {
    status: "failed",
    phase,
    profileId,
    ...(attempt == null ? {} : { attempt }),
    reason: reason || error?.reason || error?.code || "recovery-coordination-failed",
    code: error?.code || null,
    message: error?.message || (error ? String(error) : null),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(run) {
  if (run.exitPromise || run.exitCode != null || run.signal) {
    return Promise.resolve(run.exitPromise).then(() => summarizeActive(run));
  }
  return new Promise((resolve) => {
    run.handle.once("exit", () => {
      Promise.resolve(run.exitPromise).then(() => resolve(summarizeActive(run)));
    });
  });
}

async function waitForGracefulExit(run, timeoutMs) {
  if (run.finalized || run.exitCode != null || run.signal) return true;
  if (timeoutMs <= 0) return false;
  return await new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      run.handle.off?.("exit", onExit);
      resolve(false);
    }, timeoutMs);
    run.handle.once("exit", onExit);
  });
}

function summarizeActive(run) {
  const exit = run.exitRecord || null;
  return {
    profileId: run.profileId,
    mode: run.mode,
    runtimeMode: run.runtimeMode || "process",
    pid: run.pid,
    threadId: run.threadId ?? null,
    statusDir: run.statusDir,
    logDir: run.logDir,
    logPath: run.logPath,
    startedAt: run.startedAt,
    startupState: run.startupState || (run.readyAt ? "ready" : undefined),
    readyAt: run.readyAt || null,
    readyStep: run.readyStep || null,
    lastProgressAt: run.lastProgressAt || null,
    lastProgressStep: run.lastProgressStep || null,
    lastProgressCycle: run.lastProgressCycle ?? null,
    teamOrderStatus: run.teamOrderStatus || null,
    exitedAt: run.exitedAt || null,
    exitCode: run.exitCode ?? null,
    signal: run.signal || null,
    ...(exit?.reason ? { reason: exit.reason } : {}),
    ...(exit?.category ? { category: exit.category } : {}),
    ...(exit?.message ? { message: exit.message } : {}),
    ...(exit?.stoppedAt ? { stoppedAt: exit.stoppedAt } : {}),
      ...(run.coordinationToken !== undefined ? { coordinationToken: run.coordinationToken } : {}),
      ...(run.artifactCompletion && Object.keys(run.artifactCompletion).length
        ? { artifactCompletion: run.artifactCompletion }
        : {}),
      ...(run.startupNotReadyReason ? { startupNotReadyReason: run.startupNotReadyReason } : {}),
    };
}

function summarizePersistedTask(status) {
  const task = status.task || {};
  return {
    profileId: task.profileId,
    mode: task.mode,
    runtimeMode: task.runtimeMode || "process",
    pid: task.pid,
    threadId: task.threadId ?? null,
    statusDir: task.statusDir,
    logDir: task.logDir,
    logPath: task.logPath,
    startedAt: task.startedAt,
    startupState: task.startupState || (task.readyAt ? "ready" : undefined),
    readyAt: task.readyAt || null,
    readyStep: task.readyStep || null,
    lastProgressAt: task.lastProgressAt || null,
    lastProgressStep: task.lastProgressStep || null,
    lastProgressCycle: task.lastProgressCycle ?? null,
    exitedAt: null,
    exitCode: null,
    signal: null,
    lockStatus: status.reason,
    ...(task.coordinationToken !== undefined ? { coordinationToken: task.coordinationToken } : {}),
    ...(task.artifactCompletion ? { artifactCompletion: task.artifactCompletion } : {}),
    ...(task.startupNotReadyReason ? { startupNotReadyReason: task.startupNotReadyReason } : {}),
  };
}

function summarizeUnpersistedManagedRun(run) {
  return {
    ...summarizeActive(run),
    lockStatus: "not-persisted",
    registrationStatus: run.registrationStatus,
    registrationError: summarizeRuntimeError(run.registrationError),
    cleanupError: summarizeRuntimeError(run.cleanupError),
  };
}

function summarizeMemoryManagedTask(task) {
  return {
    exists: true,
    healthy: true,
    reason: task.registrationStatus,
    task,
  };
}

function summarizeRuntimeError(err) {
  if (!err) return null;
  return {
    code: err.code || null,
    message: err.message || String(err),
  };
}

function buildLastTaskExit(run, stopped = null) {
  const classified = classifyTaskExit(run.exitCode, run.signal);
  return {
    profileId: run.profileId,
    mode: run.mode,
    runtimeMode: run.runtimeMode || "process",
    pid: run.pid,
    threadId: run.threadId ?? null,
    statusDir: run.statusDir,
    logDir: run.logDir,
    logPath: run.logPath,
    startedAt: run.startedAt,
    startupState: run.startupState || (run.readyAt ? "ready" : undefined),
    readyAt: run.readyAt || null,
    readyStep: run.readyStep || null,
    exitedAt: run.exitedAt || null,
    exitCode: run.exitCode ?? null,
    signal: run.signal || null,
    ...classified,
    ...(stopped?.message ? { message: stopped.message } : {}),
    ...(stopped?.category ? { category: stopped.category } : {}),
    ...(stopped?.reason ? { reason: stopped.reason } : {}),
    ...(stopped?.stoppedAt ? { stoppedAt: stopped.stoppedAt } : {}),
    ...(stopped?.cycle != null ? { cycle: stopped.cycle } : {}),
    ...(stopped?.step ? { step: stopped.step } : {}),
    ...(stopped?.experienceGuard ? { experienceGuard: stopped.experienceGuard } : {}),
    ...(run.coordinationToken !== undefined ? { coordinationToken: run.coordinationToken } : {}),
  };
}

function buildAutomationStartError(profileId, exit = null) {
  const reason = exit?.reason || "start-failed";
  const message = reason === "session-expired"
    ? "账号会话失效，请先验证账号。"
    : (exit?.message || "启动失败：未检测到运行中的任务。");
  const err = new Error(message);
  err.code = "AUTOMATION_START_FAILED";
  err.statusCode = reason === "session-expired" ? 422 : 409;
  err.profileId = profileId;
  err.reason = reason;
  err.category = exit?.category || "runtime";
  err.exitCode = exit?.exitCode ?? null;
  err.lastExit = exit || null;
  return err;
}

function buildStartupPersistenceCleanupError(persistenceError, cleanupError, run) {
  const persistenceMessage = persistenceError?.message || String(persistenceError);
  const cleanupMessage = cleanupError?.message || String(cleanupError);
  const err = new Error(
    `启动任务登记失败，且未能停止执行实例：${persistenceMessage}; 清理失败：${cleanupMessage}`,
    { cause: persistenceError },
  );
  err.code = persistenceError?.code || "ACTIVE_TASK_PERSISTENCE_FAILED";
  err.profileId = run.profileId;
  err.runtimeMode = run.runtimeMode;
  err.persistenceError = persistenceError;
  err.cleanupError = cleanupError;
  return err;
}

function buildOperatorStop(now) {
  return {
    reason: "user-stopped",
    category: "operator",
    message: "用户停止。",
    stoppedAt: formatDateTime(now),
  };
}

function summarizePersistenceWarning(error) {
  return {
    code: error?.code || null,
    message: error?.message || String(error),
  };
}

function buildShutdownStop(now) {
  return {
    reason: "system-shutdown",
    category: "shutdown",
    message: "控制端关闭，保留循环任务恢复意图。",
    stoppedAt: formatDateTime(now),
  };
}

function sanitizeExitClassification(value = {}) {
  return {
    reason: String(value.reason || "error"),
    category: String(value.category || "runtime"),
    message: String(value.message || "任务异常退出。"),
    ...(value.rawMessage ? { rawMessage: String(value.rawMessage) } : {}),
  };
}

function isTransientRecoveryStartError(err) {
  if (err?.category === "network" || err?.category === "stalled") return true;
  return ["EBUSY", "EMFILE", "ENFILE"].includes(err?.code);
}

function createAutomationReadyParser(onReady) {
  let buffer = "";
  return (chunk) => {
    buffer += String(chunk || "");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const payload = parseAutomationReadyLine(line);
      if (payload) onReady(payload);
    }
  };
}

function parseAutomationReadyLine(line) {
  const text = String(line || "").trim();
  if (!text || !text.startsWith("{")) return null;
  try {
    const payload = JSON.parse(text);
    return payload?.step === "automationReady" ? payload : null;
  } catch {
    return null;
  }
}

function classifyTaskExit(exitCode, signal) {
  if (Number(exitCode) === SESSION_EXPIRED_EXIT_CODE) {
    return {
      reason: "session-expired",
      category: "login-state",
      message: SESSION_EXPIRED_STOP_MESSAGE,
    };
  }
  if (Number(exitCode) === EXPERIENCE_GUARD_EXIT_CODE) {
    return {
      reason: "experience-guard",
      category: "experience-guard",
      message: EXPERIENCE_GUARD_STOP_MESSAGE,
    };
  }
  if (signal) {
    return {
      reason: "stopped",
      category: "operator",
      message: "任务已停止。",
    };
  }
  if (Number(exitCode || 0) === 0) {
    return {
      reason: "completed",
      category: "normal",
      message: "任务已完成。",
    };
  }
  return {
    reason: "error",
    category: "runtime",
    message: `任务异常退出，退出码 ${exitCode ?? "-"}`,
  };
}

function mostRecentExit(lastTaskExits = {}) {
  return Object.values(lastTaskExits)
    .sort((a, b) => String(b.updatedAt || b.exitedAt || "").localeCompare(String(a.updatedAt || a.exitedAt || "")))[0] || null;
}

function normalizeRuntimeMode(value) {
  return value === "process" ? "process" : "worker";
}

function normalizeForMatch(value) {
  return String(value ?? "").replace(/\//g, "\\").toLowerCase();
}

function addDescendantPids(managedPids, processes = []) {
  if (!managedPids?.size || !Array.isArray(processes) || !processes.length) return managedPids;
  const childrenByParent = new Map();
  for (const item of processes) {
    const pid = Number(item.ProcessId ?? item.pid);
    const parentPid = Number(item.ParentProcessId ?? item.parentProcessId ?? item.ppid);
    if (!pid || !parentPid) continue;
    if (!childrenByParent.has(parentPid)) childrenByParent.set(parentPid, []);
    childrenByParent.get(parentPid).push(pid);
  }

  const queue = Array.from(managedPids);
  for (let index = 0; index < queue.length; index++) {
    const parentPid = queue[index];
    for (const childPid of childrenByParent.get(parentPid) || []) {
      if (managedPids.has(childPid)) continue;
      managedPids.add(childPid);
      queue.push(childPid);
    }
  }
  return managedPids;
}

function formatTimestamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

function formatDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function defaultKillProcess(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 0) return;
  }
  try {
    process.kill(pid);
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
}

function defaultWarn(message) {
  console.warn(message);
}

async function readSessionExpiredStop(statusDir) {
  return readAutomationStopped(statusDir, "session-expired");
}

async function readAutomationStoppedForRun(statusDir, run) {
  const stopped = await readAutomationStopped(statusDir);
  return matchesAutomationStoppedRun(stopped, run) ? stopped : null;
}

function matchesAutomationStoppedRun(stopped, run) {
  if (!stopped?.reason || !run) return false;
  const expectedRunId = normalizeAutomationRunId(run.runId);
  const observedRunId = normalizeAutomationRunId(stopped.runId);
  return expectedRunId ? observedRunId === expectedRunId : !observedRunId;
}

function normalizeAutomationRunId(value) {
  const runId = String(value || "").trim();
  return runId || null;
}

async function readAutomationStopped(statusDir, expectedReason = null) {
  if (!statusDir) return null;
  try {
    const statusPath = path.join(statusDir, "garden-status.json");
    const json = JSON.parse(await fsp.readFile(statusPath, "utf8"));
    const stopped = json?.summary?.automationStopped || json?.automationStopped || null;
    if (!stopped?.reason) return null;
    if (expectedReason && stopped.reason !== expectedReason) return null;
    return {
      ...stopped,
      runId: normalizeAutomationRunId(stopped.runId || json?.automationRunId || json?.runId),
    };
  } catch (err) {
    if (err.code === "ENOENT") return null;
    return null;
  }
}
