import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createProfileStore } from "../system/profile-store.mjs";
import { createSystemServer } from "../system/server.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_DIR = path.join(PROJECT_ROOT, "work", "system", "public");

export async function startTask4GameVersionVisibleServer(options = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-task4-version-"));
  const runtimeDir = path.join(tempRoot, "runtime");
  const profileStore = createProfileStore({
    accountsDir: path.join(runtimeDir, "accounts"),
    protect: (value) => `fixture:${value}`,
    unprotect: (value) => String(value).replace(/^fixture:/, ""),
  });
  await profileStore.importProfile({
    id: "task4",
    label: "Task 4 虚拟账号",
    credentials: {
      CTOKEN: "fixture",
      PC_USER_ID: "2088000000000000",
      PC_TOKEN: "fixture",
      BABI_TOKEN: "fixture",
      OPEN_ID: "fixture",
    },
  });

  let externalGameCalls = 0;
  let workerStarts = 0;
  const codeStatus = {
    localVersion: "391.0.25",
    remoteVersion: "400.0.15",
    comparison: "newer",
    lastSuccessfulCheckAt: "2026-08-12T03:00:00.000Z",
    checking: false,
    lastError: null,
  };
  let dataStatus = scenarioStatus(options.scenario || "idle");
  const runner = {
    runtime: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [], desiredRuns: [], recoveryByProfile: {} }),
    snapshot: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [], desiredRuns: [], recoveryByProfile: {} }),
    restoreDesiredLoops: async () => ({ desired: 0, scheduled: 0 }),
    stop: async () => ({ stopped: false }),
    beginAutomationAlreadyCoordinated: async () => {
      workerStarts += 1;
      throw Object.assign(new Error("Task4 fixture blocks workers"), { statusCode: 409 });
    },
  };
  const gameVersionService = {
    getStatus: async () => ({ ...codeStatus }),
    checkScheduled: async () => ({ status: "disabled" }),
    check: async () => ({ ...codeStatus }),
  };
  const gameDataSyncService = {
    initialize: async () => dataStatus,
    getStatus: async () => ({ ...dataStatus }),
    sync: async () => {
      dataStatus = {
        ...dataStatus,
        candidateVersion: "abc12",
        candidateSourceCodeVersion: "400.0.15",
        compatibilityStatus: "checking",
        syncStatus: "validating",
        phase: "validation",
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
      };
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const previousDataVersion = dataStatus.activeVersion;
      dataStatus = {
        ...dataStatus,
        activeVersion: "abc12",
        activeSourceCodeVersion: "400.0.15",
        compatibilityStatus: "compatible",
        syncStatus: "latest",
        phase: "complete",
        lastSuccessfulSyncAt: new Date().toISOString(),
      };
      return {
        status: "latest",
        previousDataVersion,
        activeDataVersion: "abc12",
        candidateDataVersion: "abc12",
        sourceCodeVersion: "400.0.15",
        loaderCount: 17,
      };
    },
  };
  const scheduler = { start() {}, async stop() {}, getStatus: () => ({ running: false }) };
  const server = createSystemServer({
    rootDir: tempRoot,
    runtimeDir,
    publicDir: PUBLIC_DIR,
    listenHost: "127.0.0.1",
    profileStore,
    runner,
    coordinatedRunner: runner,
    gameVersionService,
    gameVersionScheduler: scheduler,
    gameDataSyncService,
  });
  await server.listen(options.port || 0);
  let closed = false;
  return {
    url: `http://127.0.0.1:${server.port}/`,
    tempRoot,
    counters: () => ({ externalGameCalls, workerStarts }),
    async close() {
      if (closed) return;
      closed = true;
      await server.close();
      if (externalGameCalls !== 0 || workerStarts !== 0) {
        throw new Error(`Task4 fixture safety counters changed: external=${externalGameCalls}, workers=${workerStarts}`);
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
}

function scenarioStatus(scenario) {
  const base = {
    activeVersion: "2f3f6",
    activeSourceCodeVersion: "391.0.25",
    candidateVersion: null,
    candidateSourceCodeVersion: null,
    compatibilityStatus: "unknown",
    syncStatus: "idle",
    phase: null,
    lastSuccessfulSyncAt: null,
    lastAttemptAt: null,
    lastError: null,
    reportPath: null,
    sourceProfileId: null,
  };
  if (scenario === "manual-review") return {
    ...base,
    candidateVersion: "abc12",
    candidateSourceCodeVersion: "400.0.15",
    compatibilityStatus: "manual-review",
    syncStatus: "blocked",
    phase: "validation",
    lastError: { code: "GAME_DATA_MANUAL_REVIEW_REQUIRED", message: "候选数据需要人工复核，未启用" },
    reportPath: "runtime/game-data/versions/abc12/compatibility-report.json",
  };
  return base;
}

async function runCli() {
  const scenario = process.argv.find((arg) => arg.startsWith("--scenario="))?.slice(11) || "idle";
  const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) || 0);
  const fixture = await startTask4GameVersionVisibleServer({ scenario, port });
  console.log(`TASK4_READY url=${fixture.url} scenario=${scenario} workers=0 externalCalls=0`);
  console.log("仅用于 Task 4 本地界面验收；Ctrl+C 可安全关闭并清理临时目录。");
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await fixture.close();
    console.log("TASK4_CLEANUP complete=true workers=0 externalCalls=0");
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.once(signal, stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
