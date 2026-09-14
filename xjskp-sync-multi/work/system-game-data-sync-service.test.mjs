import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { syncGameDataCandidate } from "./game-data-candidate-sync.mjs";
import { readActiveGameDataBundle, readGameDataBundle } from "./game-data-version.mjs";
import { createGameDataOperationCoordinator } from "./system/game-data-operation-coordinator.mjs";
import { createGameDataSyncService } from "./system/game-data-sync-service.mjs";

test("GET data status is local-only and restores a persisted interrupted phase without writing", async (t) => {
  const fixture = await createFixture(t);
  await fs.mkdir(path.dirname(fixture.statusPath), { recursive: true });
  await fs.writeFile(fixture.statusPath, JSON.stringify({
    schemaVersion: 1,
    syncStatus: "downloading",
    phase: "download",
    candidateVersion: "bbb22",
    candidateSourceCodeVersion: "400.0.15",
    lastSuccessfulSyncAt: "2026-08-11T01:00:00.000Z",
  }), "utf8");
  const before = await fs.readFile(fixture.statusPath, "utf8");
  const service = createGameDataSyncService({
    ...fixture.options,
    profileStore: forbiddenProfileStore(),
    runner: { runtime: async () => assert.fail("GET must not inspect runtime") },
    queryOfficialMetadata: async () => assert.fail("GET must not query network"),
    syncCandidate: async () => assert.fail("GET must not sync"),
  });

  assert.deepEqual(await service.getStatus(), {
    activeVersion: "aaa11",
    activeSourceCodeVersion: "391.0.25",
    candidateVersion: "bbb22",
    candidateSourceCodeVersion: "400.0.15",
    compatibilityStatus: "unknown",
    syncStatus: "failed",
    phase: "download",
    lastSuccessfulSyncAt: "2026-08-11T01:00:00.000Z",
    lastAttemptAt: null,
    lastError: {
      code: "GAME_DATA_SYNC_INTERRUPTED",
      message: "上次数据同步因服务中断而未完成",
    },
    reportPath: null,
    sourceProfileId: null,
  });
  assert.equal(await fs.readFile(fixture.statusPath, "utf8"), before);
});

test("GET preserves the live phase while this service still owns the sync operation", async (t) => {
  const fixture = await createFixture(t);
  let releaseCandidate;
  const candidateReleased = new Promise((resolve) => { releaseCandidate = resolve; });
  let phaseWritten;
  const phaseReady = new Promise((resolve) => { phaseWritten = resolve; });
  const service = createGameDataSyncService({
    ...fixture.options,
    profileStore: { loadProfileCredentialFields: async () => credentials() },
    runner: { runtime: async () => quiescentRuntime() },
    queryOfficialMetadata: async () => ({
      appId: "2021004163668677",
      appVersion: "400.0.15",
      packageUrl: "https://mdn.alipayobjects.com/gamecenteruprod_pkg/afts/file/example",
    }),
    syncCandidate: async (options) => {
      await options.onPhase("download", { dataVersion: "bbb22" });
      phaseWritten();
      await candidateReleased;
      return {
        status: "latest",
        activeDataVersion: "aaa11",
        previousDataVersion: "aaa11",
        candidateDataVersion: "aaa11",
        sourceCodeVersion: "400.0.15",
        loaderCount: 17,
      };
    },
  });

  const sync = service.sync("main");
  await phaseReady;
  const live = await service.getStatus();
  assert.equal(live.syncStatus, "downloading");
  assert.equal(live.phase, "download");
  assert.equal(live.candidateVersion, "bbb22");
  releaseCandidate();
  await sync;
});

test("explicit startup initialization persists interrupted work as failed without credentials or network", async (t) => {
  const fixture = await createFixture(t);
  await fs.mkdir(path.dirname(fixture.statusPath), { recursive: true });
  await fs.writeFile(fixture.statusPath, JSON.stringify({
    schemaVersion: 1,
    syncStatus: "validating",
    phase: "validation",
    lastAttemptAt: "2026-08-12T01:00:00.000Z",
  }), "utf8");
  const service = createGameDataSyncService({
    ...fixture.options,
    profileStore: forbiddenProfileStore(),
    runner: { runtime: async () => assert.fail("initialize must not inspect runtime") },
    queryOfficialMetadata: async () => assert.fail("initialize must not query network"),
    syncCandidate: async () => assert.fail("initialize must not sync"),
    recoverPersistentLock: async () => false,
  });

  const recovered = await service.initialize();
  assert.equal(recovered.syncStatus, "failed");
  assert.equal(recovered.lastError.code, "GAME_DATA_SYNC_INTERRUPTED");
  assert.match(await fs.readFile(fixture.statusPath, "utf8"), /GAME_DATA_SYNC_INTERRUPTED/);
});

test("sync reads only official-query credentials and passes ephemeral metadata to the candidate core", async (t) => {
  const fixture = await createFixture(t);
  const requestedFields = [];
  let received = null;
  let activeVersion = "aaa11";
  const service = createGameDataSyncService({
    ...fixture.options,
    readActiveDataBundle: () => ({
      dataVersion: activeVersion,
      sourceCodeVersion: activeVersion === "aaa11" ? "391.0.25" : "400.0.15",
    }),
    now: () => new Date("2026-08-12T05:00:00.000Z"),
    profileStore: {
      async loadProfileCredentialFields(profileId, fields) {
        assert.equal(profileId, "main");
        requestedFields.push(...fields);
        return credentials();
      },
      loadProfileEnv: async () => assert.fail("sync must not decrypt the full profile"),
    },
    runner: { runtime: async () => quiescentRuntime() },
    queryOfficialMetadata: async ({ credentials: value }) => {
      assert.deepEqual(value, credentials());
      return {
        appId: "2021004163668677",
        appVersion: "400.0.15",
        packageUrl: "https://mdn.alipayobjects.com/gamecenteruprod_pkg/afts/file/example",
      };
    },
    syncCandidate: async (options) => {
      received = options;
      await options.onPhase("download");
      await options.onPhase("stage");
      activeVersion = "bbb22";
      return {
        status: "latest",
        activeDataVersion: "bbb22",
        previousDataVersion: "aaa11",
        candidateDataVersion: "bbb22",
        sourceCodeVersion: "400.0.15",
        loaderCount: 17,
        reportPath: path.join(fixture.rootDir, "runtime", "game-data", "versions", "bbb22", "compatibility-report.json"),
      };
    },
  });

  const result = await service.sync("main");
  assert.deepEqual(requestedFields, ["CTOKEN", "PC_USER_ID", "PC_TOKEN"]);
  assert.equal(received.packageUrl.includes("alipayobjects.com"), true);
  assert.deepEqual(received.baseUrls, [
    "https://hygncdn.babigame.cn/",
    "https://hyhmcl.babigame.cn/",
  ]);
  assert.equal(received.sourceCodeVersion, "400.0.15");
  assert.equal(Object.hasOwn(received, "currentStaticConfigPath"), false);
  assert.equal(result.activeDataVersion, "bbb22");
  const persisted = await fs.readFile(fixture.statusPath, "utf8");
  assert.doesNotMatch(persisted, /ct-secret|pc-secret|2088|alipayobjects\.com/);
  assert.match(persisted, /"syncStatus": "latest"/);
});

test("real service and candidate core register a legacy baseline before activating an offline candidate", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-game-data-legacy-composition-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const workDir = path.join(rootDir, "work");
  const manifestDir = path.join(workDir, "game-pkg-latest");
  const legacyConfigPath = path.join(workDir, "g-data.aaa11.text");
  const legacyFlowerNamesPath = path.join(workDir, "flower-names.json");
  await fs.mkdir(manifestDir, { recursive: true });
  await Promise.all([
    fs.copyFile(path.resolve("work", "g-data.2f3f6.text"), legacyConfigPath),
    fs.copyFile(path.resolve("work", "flower-names.json"), legacyFlowerNamesPath),
    fs.writeFile(
      path.join(manifestDir, "Manifest.xml"),
      "<package><appVersion>391.0.25</appVersion></package>",
      "utf8",
    ),
  ]);

  let receivedBaseline = null;
  const service = createGameDataSyncService({
    rootDir,
    runtimeDir: path.join(rootDir, "runtime"),
    operationCoordinator: createGameDataOperationCoordinator(),
    profileStore: { loadProfileCredentialFields: async () => credentials() },
    runner: { runtime: async () => quiescentRuntime() },
    queryOfficialMetadata: async () => ({
      appId: "2021004163668677",
      appVersion: "400.0.15",
      packageUrl: "https://mdn.alipayobjects.com/gamecenteruprod_pkg/afts/file/example",
    }),
    syncCandidate: async (options) => {
      receivedBaseline = {
        currentStaticConfigPath: options.currentStaticConfigPath,
        currentFlowerNamesPath: options.currentFlowerNamesPath,
        currentSourceCodeVersion: options.currentSourceCodeVersion,
      };
      return syncGameDataCandidate({
        ...options,
        jobId: "offline-legacy-composition",
        discoverCandidate: async ({ candidateDir }) => {
          const configPath = path.join(candidateDir, "g-data.bbb22.text");
          await fs.mkdir(candidateDir, { recursive: true });
          await fs.copyFile(legacyConfigPath, configPath);
          const content = await fs.readFile(configPath);
          return {
            dataVersion: "bbb22",
            sourceCodeVersion: options.sourceCodeVersion,
            configPath,
            bytes: content.length,
            sha256: crypto.createHash("sha256").update(content).digest("hex"),
            calls: ["static-file"],
          };
        },
      });
    },
  });

  assert.equal(readActiveGameDataBundle({ rootDir }), null);
  const result = await service.sync("main");

  assert.deepEqual(receivedBaseline, {
    currentStaticConfigPath: legacyConfigPath,
    currentFlowerNamesPath: legacyFlowerNamesPath,
    currentSourceCodeVersion: "391.0.25",
  });
  assert.equal(result.previousDataVersion, "aaa11");
  assert.equal(result.activeDataVersion, "bbb22");
  assert.equal(readGameDataBundle({ rootDir, dataVersion: "aaa11" }).sourceCodeVersion, "391.0.25");
  const active = readActiveGameDataBundle({ rootDir });
  assert.equal(active.dataVersion, "bbb22");
  assert.equal(path.dirname(active.staticConfigPath), path.dirname(active.flowerNamesPath));
});

test("runtime activity blocks sync before credentials or discovery and reports the active version", async (t) => {
  const runtimes = [
    { ...quiescentRuntime(), runningCount: 1, activeTasks: [{ profileId: "main" }] },
    { ...quiescentRuntime(), legacyProcesses: [{ pid: 99 }] },
    { ...quiescentRuntime(), desiredRuns: [{ profileId: "main", desiredState: "running" }] },
    { ...quiescentRuntime(), desiredRuns: [{ profileId: "main", desiredState: "unresolved" }] },
    { ...quiescentRuntime(), recoveryByProfile: { main: { recoveryPending: true, recoveryStatus: "scheduled" } } },
  ];
  for (const runtime of runtimes) {
    const fixture = await createFixture(t);
    const service = createGameDataSyncService({
      ...fixture.options,
      profileStore: forbiddenProfileStore(),
      runner: { runtime: async () => runtime },
      queryOfficialMetadata: async () => assert.fail("blocked sync must not query"),
      syncCandidate: async () => assert.fail("blocked sync must not discover"),
    });

    await assert.rejects(service.sync("main"), (error) => (
      error.statusCode === 409
      && error.code === "GAME_DATA_SYNC_RUNTIME_ACTIVE"
      && error.activeDataVersion === "aaa11"
    ));
  }
});

test("unsafe upstream failures are persisted and returned as stable redacted errors", async (t) => {
  const fixture = await createFixture(t);
  const service = createGameDataSyncService({
    ...fixture.options,
    profileStore: { loadProfileCredentialFields: async () => credentials() },
    runner: { runtime: async () => quiescentRuntime() },
    queryOfficialMetadata: async () => { throw new Error("HTTP body pc-secret https://bad.example/path?token=ct-secret"); },
    syncCandidate: async () => assert.fail("discovery must not start"),
  });

  await assert.rejects(service.sync("main"), (error) => (
    error.statusCode === 502
    && error.code === "GAME_DATA_DISCOVERY_FAILED"
    && error.activeDataVersion === "aaa11"
    && error.message === "官方游戏数据发现失败"
  ));
  const persisted = await fs.readFile(fixture.statusPath, "utf8");
  assert.doesNotMatch(persisted, /pc-secret|ct-secret|bad\.example|HTTP body/);
});

test("manual-review and incompatible results never become success and retain the active version", async (t) => {
  for (const candidateStatus of ["manual-review", "incompatible"]) {
    const fixture = await createFixture(t);
    const service = createGameDataSyncService({
      ...fixture.options,
      profileStore: { loadProfileCredentialFields: async () => credentials() },
      runner: { runtime: async () => quiescentRuntime() },
      queryOfficialMetadata: async () => ({
        appId: "2021004163668677",
        appVersion: "400.0.15",
        packageUrl: "https://mdn.alipayobjects.com/gamecenteruprod_pkg/afts/file/example",
      }),
      syncCandidate: async () => ({
        status: candidateStatus,
        activeDataVersion: "aaa11",
        candidateDataVersion: "bbb22",
        reportPath: path.join(fixture.rootDir, "runtime", "game-data", "candidates", "job", "compatibility-report.json"),
      }),
    });
    const expectedCode = candidateStatus === "manual-review"
      ? "GAME_DATA_MANUAL_REVIEW_REQUIRED"
      : "GAME_DATA_INCOMPATIBLE";
    await assert.rejects(service.sync("main"), (error) => (
      error.statusCode === 422
      && error.code === expectedCode
      && error.activeDataVersion === "aaa11"
    ));
  }
});

function credentials() {
  return { CTOKEN: "ct-secret", PC_USER_ID: "2088", PC_TOKEN: "pc-secret" };
}

function forbiddenProfileStore() {
  return {
    loadProfileCredentialFields: async () => assert.fail("credentials must not be read"),
    loadProfileEnv: async () => assert.fail("full credentials must not be read"),
  };
}

function quiescentRuntime() {
  return {
    runningCount: 0,
    activeTasks: [],
    legacyProcesses: [],
    desiredRuns: [],
    recoveryByProfile: {},
  };
}

async function createFixture(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-game-data-service-"));
  const runtimeDir = path.join(rootDir, "runtime");
  const statusPath = path.join(runtimeDir, "status", "game-data-status.json");
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  return {
    rootDir,
    runtimeDir,
    statusPath,
    options: {
      rootDir,
      runtimeDir,
      operationCoordinator: createGameDataOperationCoordinator(),
      readActiveDataBundle: () => ({
        dataVersion: "aaa11",
        sourceCodeVersion: "391.0.25",
      }),
    },
  };
}
