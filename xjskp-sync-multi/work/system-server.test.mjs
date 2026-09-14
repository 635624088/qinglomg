import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProfileStore } from "./system/profile-store.mjs";
import { createProfileOperationCoordinator } from "./system/profile-operation-coordinator.mjs";
import { writeActiveTask } from "./system/runtime-lock.mjs";
import { createSystemServer } from "./system/server.mjs";
import {
  createPersistentExperienceLevelGuard,
} from "./experience-guard-state.mjs";

test("fixed runtime settings tmp fails when controlled writes overlap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-fixed-runtime-settings-"));
  let resolveFirstWriteStarted;
  let releaseFirstWrite;
  let resolveSecondWriteStarted;
  let releaseSecondWrite;
  const firstWriteStarted = new Promise((resolve) => {
    resolveFirstWriteStarted = resolve;
  });
  const firstWriteGate = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  const secondWriteStarted = new Promise((resolve) => {
    resolveSecondWriteStarted = resolve;
  });
  const secondWriteGate = new Promise((resolve) => {
    releaseSecondWrite = resolve;
  });
  let writeCount = 0;
  const fileSystem = {
    ...fsPromises,
    async writeFile(filePath, data, writeOptions) {
      await fsPromises.writeFile(filePath, data, writeOptions);
      const writeNumber = ++writeCount;
      if (writeNumber === 1) {
        resolveFirstWriteStarted();
        await firstWriteGate;
      }
      if (writeNumber === 2) {
        resolveSecondWriteStarted();
        await secondWriteGate;
      }
    },
  };
  try {
    const first = writeRuntimeSettingsWithFixedTmp(fileSystem, dir, { flowerRackTargetArtId: 305101 });
    await firstWriteStarted;
    const second = writeRuntimeSettingsWithFixedTmp(fileSystem, dir, { flowerRackTargetArtId: 302003 });
    await secondWriteStarted;
    releaseFirstWrite();
    await first;
    releaseSecondWrite();
    await assert.rejects(second, /ENOENT/);
  } finally {
    releaseFirstWrite();
    releaseSecondWrite();
    await rm(dir, { recursive: true, force: true });
  }
});

test("system API rolls profile settings back when the runtime settings write fails", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-settings-rollback-"));
  let server = null;
  t.after(async () => {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const profileStore = createProfileStore({
    accountsDir: path.join(dir, "runtime", "accounts"),
    protect: (value) => `p:${value}`,
    unprotect: (value) => value.slice(2),
  });
  await profileStore.importProfile({
    id: "main",
    credentials: {
      CTOKEN: "ct",
      PC_USER_ID: "main",
      PC_TOKEN: "pc",
      BABI_TOKEN: "babi",
      OPEN_ID: "open",
    },
  });
  const runtimeSettingsStore = {
    runtimeDir: path.join(dir, "runtime"),
    settingsPath(profileId) {
      return path.join(dir, "runtime", "settings", `${profileId}.json`);
    },
    async runCanonicalMigrationExclusive(profileId, operation) {
      return operation({
        kind: "runtime",
        directory: path.join(dir, "runtime", "settings"),
        targetPath: this.settingsPath(profileId),
      });
    },
    async compareVersionedForProtocol() {
      return { classification: "legacy" };
    },
    async publishVersionedForProtocol() {
      throw new Error("controlled runtime settings failure");
    },
    async reconcileVersionedForProtocol() {
      throw new Error("controlled runtime settings failure");
    },
    async drain() {},
  };
  const runner = {
    async runtime() {
      return { active: null, activeTasks: [], activeByProfile: {} };
    },
    async stop() {
      return { stopped: false };
    },
  };
  server = createSystemServer({
    profileStore,
    runtimeSettingsStore,
    runner,
    coordinatedRunner: createTestCoordinatedRunner(runner),
    rootDir: dir,
    localRequestToken: "test-local-token",
  });
  await server.listen(0);

  const loaded = await profileStore.readSettingsStateForProtocol("main");
  const response = await postJsonResponse(
    `http://127.0.0.1:${server.port}/api/profiles/main/settings`,
    { teamOrderTriggerProtectionEnabled: false },
    "test-local-token",
    loaded.snapshot,
  );

  assert.equal(response.status, 503);
  assert.equal(response.json.commitState, "not-applied");
  assert.equal(
    (await profileStore.getProfileSettings("main"))
      .teamOrderTriggerProtectionEnabled,
    true,
  );
});

test("system API rejects cross-site mutations before invoking the runner", async () => {
  const fixture = await createGuardedServerFixture({ localRequestToken: "test-local-token" });
  try {
    const rsp = await fetch(`${fixture.base}/api/system/stop`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
        "x-xjskp-session-token": "test-local-token",
      },
      body: "{}",
    });
    assert.equal(rsp.status, 403);
    assert.equal(fixture.stopCalls.length, 0);
  } finally {
    await fixture.close();
  }
});

test("system API rejects encoded profile ids and traversal log names", async () => {
  const fixture = await createGuardedServerFixture({ localRequestToken: "test-local-token" });
  try {
    const statusRsp = await fetch(`${fixture.base}/api/profiles/..%2Faccounts/status`);
    assert.equal(statusRsp.status, 400);
    const logRsp = await fetch(`${fixture.base}/api/profiles/main/logs?name=${encodeURIComponent("auto-plant-/../../../outside.log")}`);
    assert.equal(logRsp.status, 400);
  } finally {
    await fixture.close();
  }
});

test("team order artifact routes paginate one profile and reject traversal", async () => {
  const fixture = await createGuardedServerFixture({ localRequestToken: "test-local-token" });
  const p1Dir = path.join(fixture.runtimeDir, "status", "p1", "team-orders");
  const p2Dir = path.join(fixture.runtimeDir, "status", "p2", "team-orders");
  const p1HtmlName = "team-order-20260724T000000000Z-aaaaaaaaaaaaaaaaaaaaaaaa.html";
  const p2HtmlName = "team-order-20260725T000000000Z-bbbbbbbbbbbbbbbbbbbbbbbb.html";
  try {
    await mkdir(p1Dir, { recursive: true });
    await mkdir(p2Dir, { recursive: true });
    await writeFile(path.join(p1Dir, "aaaaaaaaaaaaaaaaaaaaaaaa.json"), JSON.stringify({
      runId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      profileId: "p1",
      startedAt: "2026-07-24T00:00:00.000Z",
      finishedAt: null,
      finalStatus: "running",
      htmlFile: p1HtmlName,
    }), "utf8");
    await writeFile(path.join(p1Dir, p1HtmlName), "<h1>p1 archive</h1>", "utf8");
    await writeFile(path.join(p1Dir, "broken.json"), "{broken", "utf8");
    await writeFile(path.join(p2Dir, "bbbbbbbbbbbbbbbbbbbbbbbb.json"), JSON.stringify({
      runId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      profileId: "p2",
      startedAt: "2026-07-25T00:00:00.000Z",
      finishedAt: "2026-07-25T00:01:00.000Z",
      finalStatus: "completed",
      htmlFile: p2HtmlName,
    }), "utf8");
    await writeFile(path.join(p2Dir, p2HtmlName), "<h1>p2 secret</h1>", "utf8");

    const listedRsp = await fetch(`${fixture.base}/api/profiles/p1/team-orders?page=1&pageSize=20`);
    assert.equal(listedRsp.status, 200);
    const listed = await listedRsp.json();
    assert.equal(listed.total, 2);
    assert.equal(listed.items.some((item) => item.profileId === "p2"), false);
    assert.equal(listed.items.some((item) => item.readError === true), true);

    const artifactRsp = await fetch(`${fixture.base}/artifacts/p1/team-orders/${p1HtmlName}`);
    assert.equal(artifactRsp.status, 200);
    assert.equal(await artifactRsp.text(), "<h1>p1 archive</h1>");

    const traversalRsp = await fetch(`${fixture.base}/artifacts/p1/team-orders/..%2Fp2%2Fsecret.html`);
    assert.equal(traversalRsp.status, 400);
  } finally {
    await fixture.close();
  }
});

test("team order list and HTML routes reject a p1 junction that resolves into p2", async () => {
  const fixture = await createGuardedServerFixture({ localRequestToken: "test-local-token" });
  const p1StatusDir = path.join(fixture.runtimeDir, "status", "p1");
  const p1Dir = path.join(p1StatusDir, "team-orders");
  const p2Dir = path.join(fixture.runtimeDir, "status", "p2", "team-orders");
  const runId = "eeeeeeeeeeeeeeeeeeeeeeee";
  const htmlName = `team-order-20260725T000000000Z-${runId}.html`;
  try {
    await mkdir(p1StatusDir, { recursive: true });
    await mkdir(p2Dir, { recursive: true });
    await writeFile(path.join(p2Dir, `${runId}.json`), JSON.stringify({
      runId,
      profileId: "p2",
      startedAt: "2026-07-25T00:00:00.000Z",
      finishedAt: null,
      finalStatus: "running",
      htmlFile: htmlName,
    }), "utf8");
    await writeFile(path.join(p2Dir, htmlName), "<h1>p2 junction secret</h1>", "utf8");
    await fsPromises.symlink(p2Dir, p1Dir, process.platform === "win32" ? "junction" : "dir");

    const listedRsp = await fetch(`${fixture.base}/api/profiles/p1/team-orders`);
    assert.equal(listedRsp.status, 400);
    assert.doesNotMatch(await listedRsp.text(), /p2|junction secret/);

    const artifactRsp = await fetch(`${fixture.base}/artifacts/p1/team-orders/${htmlName}`);
    assert.equal(artifactRsp.status, 400);
    assert.doesNotMatch(await artifactRsp.text(), /junction secret/);
  } finally {
    await fixture.close();
  }
});

test("system server rejects invalid Host before API, artifact, and static dispatch", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-host-guard-"));
  const publicDir = path.join(dir, "public");
  const runtimeDir = path.join(dir, "runtime");
  const runner = {
    snapshot: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [] }),
    runtime: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [] }),
    stop: async () => ({ stopped: false }),
  };
  await mkdir(path.join(runtimeDir, "status", "main"), { recursive: true });
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, "index.html"), "public-safe", "utf8");
  await writeFile(path.join(runtimeDir, "status", "main", "garden-status.json"), "artifact-secret", "utf8");
  const server = createSystemServer({ rootDir: dir, runtimeDir, publicDir, runner, coordinatedRunner: createTestCoordinatedRunner(runner), localRequestToken: "test-local-token" });
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const pathname of ["/api/runtime", "/artifacts/main/garden-status.json", "/"]) {
      const rsp = await rawGet(server.port, pathname, { host: `attacker.invalid:${server.port}` });
      assert.equal(rsp.status, 403);
      assert.doesNotMatch(rsp.body, /artifact-secret|public-safe/);
    }
    const publicIp = await rawGet(server.port, "/api/health", { host: `8.8.8.8:${server.port}` });
    assert.equal(publicIp.status, 403);
    const lan = await rawGet(server.port, "/api/health", { host: `192.168.1.50:${server.port}` });
    assert.equal(lan.status, 200);
    // 双栈监听（::）同时接受 IPv4 与 IPv6，满足局域网与代理访问。
    assert.equal(server.host, "::");
    const legal = await fetch(`${base}/artifacts/main/garden-status.json`);
    assert.equal(legal.status, 200);
    assert.equal(await legal.text(), "artifact-secret");
  } finally {
    await server.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("system server allows a whitelisted CGN host and rejects others", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-allowed-hosts-"));
  const publicDir = path.join(dir, "public");
  const runtimeDir = path.join(dir, "runtime");
  const runner = {
    snapshot: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [] }),
    runtime: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [] }),
    stop: async () => ({ stopped: false }),
  };
  await mkdir(path.join(runtimeDir, "status", "main"), { recursive: true });
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, "index.html"), "public-safe", "utf8");
  const server = createSystemServer({
    rootDir: dir,
    runtimeDir,
    publicDir,
    runner,
    coordinatedRunner: createTestCoordinatedRunner(runner),
    localRequestToken: "test-local-token",
    allowedHosts: ["100.110.1.2"],
  });
  await server.listen(0);
  try {
    const cgn = await rawGet(server.port, "/api/health", { host: `100.110.1.2:${server.port}` });
    assert.equal(cgn.status, 200);
    const other = await rawGet(server.port, "/api/health", { host: `100.110.1.3:${server.port}` });
    assert.equal(other.status, 403);
  } finally {
    await server.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("system API saves allowed hosts and applies them without a restart", async () => {
  const fixture = await createGuardedServerFixture({ localRequestToken: "test-local-token" });
  const port = Number(new URL(fixture.base).port);
  try {
    const denied = await rawGet(port, "/api/health", { host: `100.110.1.2:${port}` });
    assert.equal(denied.status, 403);

    const saved = await postJsonResponse(`${fixture.base}/api/system/settings`, { allowedHosts: ["100.110.1.2"] });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json, { allowedHosts: ["100.110.1.2"] });

    const allowed = await rawGet(port, "/api/health", { host: `100.110.1.2:${port}` });
    assert.equal(allowed.status, 200);
    const other = await rawGet(port, "/api/health", { host: `100.110.1.3:${port}` });
    assert.equal(other.status, 403);

    const current = await (await fetch(`${fixture.base}/api/system/settings`)).json();
    assert.deepEqual(current, { allowedHosts: ["100.110.1.2"] });

    const persisted = JSON.parse(
      await fsPromises.readFile(path.join(fixture.runtimeDir, "settings", "system.json"), "utf8"),
    );
    assert.deepEqual(persisted, { allowedHosts: ["100.110.1.2"] });
  } finally {
    await fixture.close();
  }
});

test("system API rejects invalid allowed hosts with 400 and does not persist them", async () => {
  const fixture = await createGuardedServerFixture({ localRequestToken: "test-local-token" });
  try {
    const outOfRange = await postJsonResponse(`${fixture.base}/api/system/settings`, { allowedHosts: ["999.999.1.1"] });
    assert.equal(outOfRange.status, 400);
    assert.equal(outOfRange.json.error, "INVALID_SYSTEM_SETTINGS");

    const notArray = await postJsonResponse(`${fixture.base}/api/system/settings`, { allowedHosts: "100.66.1.2" });
    assert.equal(notArray.status, 400);

    const badFormat = await postJsonResponse(`${fixture.base}/api/system/settings`, { allowedHosts: ["http://evil.example"] });
    assert.equal(badFormat.status, 400);

    const settingsPath = path.join(fixture.runtimeDir, "settings", "system.json");
    const persisted = await fsPromises.readFile(settingsPath, "utf8").then(() => true).catch(() => false);
    assert.equal(persisted, false);
  } finally {
    await fixture.close();
  }
});

test("system server loads persisted allowed hosts at startup", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-load-settings-"));
  const publicDir = path.join(dir, "public");
  const runtimeDir = path.join(dir, "runtime");
  const runner = {
    snapshot: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [] }),
    runtime: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [] }),
    stop: async () => ({ stopped: false }),
  };
  await mkdir(path.join(runtimeDir, "settings"), { recursive: true });
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, "index.html"), "public-safe", "utf8");
  await writeFile(
    path.join(runtimeDir, "settings", "system.json"),
    JSON.stringify({ allowedHosts: ["100.110.1.2"] }),
    "utf8",
  );
  const server = createSystemServer({
    rootDir: dir,
    runtimeDir,
    publicDir,
    runner,
    coordinatedRunner: createTestCoordinatedRunner(runner),
    localRequestToken: "test-local-token",
  });
  await server.listen(0);
  try {
    const allowed = await rawGet(server.port, "/api/health", { host: `100.110.1.2:${server.port}` });
    assert.equal(allowed.status, 200);
    const other = await rawGet(server.port, "/api/health", { host: `100.110.1.3:${server.port}` });
    assert.equal(other.status, 403);
  } finally {
    await server.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("system API profile listing does not trigger legacy migration", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-legacy-list-"));
  let migrationCalls = 0;
  const profileStore = createProfileStore({
    accountsDir: path.join(dir, "runtime", "accounts"),
    protect: (value) => `p:${value}`,
    unprotect: (value) => value.slice(2),
  });
  const legacyMigrator = {
    inspect: async () => ({ exists: true, complete: true, profileId: "legacy-main" }),
    migrate: async () => {
      migrationCalls += 1;
      return {
        profile: await profileStore.importProfile({
          id: "legacy-main",
          credentials: {
            CTOKEN: "ct",
            PC_USER_ID: "legacy-main",
            PC_TOKEN: "pc",
            BABI_TOKEN: "babi",
            OPEN_ID: "open",
          },
        }),
      };
    },
  };
  const runner = {
    runtime: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [] }),
    stop: async () => ({ stopped: false }),
  };
  const server = createSystemServer({
    rootDir: dir,
    runtimeDir: path.join(dir, "runtime"),
    profileStore,
    runner,
    coordinatedRunner: createTestCoordinatedRunner(runner),
    legacyMigrator,
    localRequestToken: "test-local-token",
  });
  await server.listen(0);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const listed = await (await fetch(`${base}/api/profiles`)).json();
    assert.deepEqual(listed.profiles, []);
    assert.deepEqual(listed.legacyMigration, {
      attempted: false,
      migrated: false,
      status: { exists: true, complete: true, profileId: "legacy-main" },
    });
    assert.equal(migrationCalls, 0);

    const missingToken = await fetch(`${base}/api/migration/legacy-credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(missingToken.status, 403);
    const crossSite = await fetch(`${base}/api/migration/legacy-credentials`, {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "content-type": "application/json",
        "x-xjskp-session-token": "test-local-token",
      },
      body: "{}",
    });
    assert.equal(crossSite.status, 403);
    assert.equal(migrationCalls, 0);

    const migrated = await postJson(`${base}/api/migration/legacy-credentials`, {});
    assert.equal(migrated.profile.id, "legacy-main");
    assert.equal(migrationCalls, 1);
  } finally {
    await server.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("system API imports a profile, lists it, and triggers one-shot execution", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-api-"));
  const calls = [];
  try {
    const profileStore = createProfileStore({
      accountsDir: path.join(dir, "accounts"),
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
      now: () => new Date("2026-06-29T10:00:00.000Z"),
    });
    const runner = {
      runtime: async () => ({ active: null, legacyProcesses: [] }),
      startLoop: async (profile) => {
        calls.push(["startLoop", profile.id]);
        return { pid: 9001, profileId: profile.id, mode: "loop" };
      },
      stop: async (profileId) => {
        calls.push(["stop", profileId]);
        return { stopped: true };
      },
      runOnce: async (profile, mode) => {
        calls.push(["runOnce", profile.id, mode]);
        if (mode === "orders") {
          const statusDir = path.join(dir, "runtime", "status", profile.id);
          await mkdir(statusDir, { recursive: true });
          await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
            summary: {
              accountLevel: {
                level: 40,
                currentExp: 123,
                requiredExp: 456,
                serverIdx: 726,
                serverText: "区服 726",
              },
            },
            automationQueue: { rows: [] },
          }), "utf8");
        }
        return { exitCode: 0, logPath: path.join(dir, "run.log") };
      },
    };

    const server = createSystemServer({ profileStore, runner, coordinatedRunner: createTestCoordinatedRunner(runner), rootDir: dir, localRequestToken: "test-local-token" });
    await server.listen(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const health = await (await fetch(`${base}/api/health`)).json();
      assert.equal(health.ok, true);
      assert.equal(health.rootDir, dir);
      assert.equal(health.port, server.port);
      assert.equal(health.pid, process.pid);

      const imported = await postJson(`${base}/api/profiles/import`, {
        label: "主号",
        credentialText: "CTOKEN=ct\nPC_USER_ID=2088\nPC_TOKEN=pc\nBABI_TOKEN=babi\nOPEN_ID=open",
      });
      assert.equal(imported.profile.id, "2088");
      assert.deepEqual(imported.profile.missingFields, []);
      assert.equal(imported.profile.settings.autoSubmitOrdinaryResidentOrdersForLevelUp, false);

      const profiles = await (await fetch(`${base}/api/profiles`)).json();
      assert.equal(profiles.profiles.length, 1);
      assert.equal(profiles.profiles[0].label, "主号");
      assert.equal(profiles.profiles[0].settings.autoSubmitOrdinaryResidentOrdersForLevelUp, false);
      assert.equal(JSON.stringify(profiles).includes("pc-token"), false);

      const defaultSettings = await (await fetch(`${base}/api/profiles/2088/settings`)).json();
      assert.deepEqual(defaultSettings.settings, {
        autoReceiveWaterwheelBuckets: true,
        skipWaterwheelVideoBuckets: false,
        autoSubmitOrdinaryResidentOrdersForLevelUp: false,
        autoSubmitCyclicStoryOrders: false,
        cyclicStoryOnlyHighestExperienceOrder: false,
        autoHandleCyclicNote: false,
        autoCompleteCyclicNoteHighestRewardTask: false,
        customerOrderFlowerCurrencyRewardReleaseMask: 4,
        experienceGuardThresholdPercent: 0.5,
        flowerRackTargetArtId: null,
        materialShopMidnightRefreshEnabled: false,
        materialShopRefreshWindowStart: "23:50",
        materialShopRefreshMaxCostYuanbao: 4,
        pearlHireItemReserveCount: 100,
        teamOrderTriggerProtectionEnabled: true,
        teamOrderPaidRenewProtectionEnabled: true,
        teamOrderGuardMultiplier: 2,
      });

      const savedSettings = await postJson(`${base}/api/profiles/2088/settings/`, {
        autoReceiveWaterwheelBuckets: false,
        skipWaterwheelVideoBuckets: true,
        autoSubmitOrdinaryResidentOrdersForLevelUp: true,
        autoHandleCyclicNote: true,
        autoCompleteCyclicNoteHighestRewardTask: true,
        experienceGuardThresholdPercent: 0.37,
        flowerRackTargetArtId: null,
        materialShopMidnightRefreshEnabled: true,
        materialShopRefreshWindowStart: "23:40",
        materialShopRefreshMaxCostYuanbao: 16,
        pearlHireItemReserveCount: 20,
        teamOrderTriggerProtectionEnabled: false,
        teamOrderPaidRenewProtectionEnabled: true,
      });
      assert.equal(savedSettings.profile.settings.autoSubmitOrdinaryResidentOrdersForLevelUp, true);
      assert.deepEqual(savedSettings.settings, {
        autoReceiveWaterwheelBuckets: false,
        skipWaterwheelVideoBuckets: true,
        autoSubmitOrdinaryResidentOrdersForLevelUp: true,
        autoSubmitCyclicStoryOrders: false,
        cyclicStoryOnlyHighestExperienceOrder: false,
        autoHandleCyclicNote: true,
        autoCompleteCyclicNoteHighestRewardTask: true,
        customerOrderFlowerCurrencyRewardReleaseMask: 4,
        experienceGuardThresholdPercent: 0.37,
        flowerRackTargetArtId: null,
        materialShopMidnightRefreshEnabled: true,
        materialShopRefreshWindowStart: "23:40",
        materialShopRefreshMaxCostYuanbao: 16,
        pearlHireItemReserveCount: 20,
        teamOrderTriggerProtectionEnabled: false,
        teamOrderPaidRenewProtectionEnabled: true,
        teamOrderGuardMultiplier: 2,
      });
      assert.equal(savedSettings.settings.teamOrderTriggerProtectionEnabled, false);
      assert.equal(savedSettings.settings.experienceGuardThresholdPercent, 0.37);
      assert.equal(savedSettings.settings.autoHandleCyclicNote, true);
      assert.equal(savedSettings.settings.autoCompleteCyclicNoteHighestRewardTask, true);
      const runtimeWaterwheelSettings = JSON.parse(await fsPromises.readFile(
        path.join(dir, "runtime", "settings", "2088.json"),
        "utf8",
      ));
      assert.deepEqual(
        {
          autoReceiveWaterwheelBuckets:
            runtimeWaterwheelSettings.autoReceiveWaterwheelBuckets,
          skipWaterwheelVideoBuckets:
            runtimeWaterwheelSettings.skipWaterwheelVideoBuckets,
        },
        {
          autoReceiveWaterwheelBuckets: false,
          skipWaterwheelVideoBuckets: true,
        },
      );

      const flowerSettings = await postJson(`${base}/api/profiles/2088/settings/`, {
        flowerRackTargetArtId: 305101,
      });
      assert.equal(flowerSettings.settings.flowerRackTargetArtId, 305101);
      assert.equal(flowerSettings.settings.pearlHireItemReserveCount, 20);

      const ordinarySettings = await postJsonResponse(
        `${base}/api/profiles/2088/settings/`,
        { autoSubmitOrdinaryResidentOrdersForLevelUp: false },
      );
      assert.equal(ordinarySettings.status, 200);
      const afterOrdinarySettings = await (await fetch(`${base}/api/profiles/2088/settings`)).json();
      assert.equal(afterOrdinarySettings.settings.flowerRackTargetArtId, 305101);
      assert.equal(afterOrdinarySettings.settings.autoSubmitOrdinaryResidentOrdersForLevelUp, false);
      assert.equal(afterOrdinarySettings.settings.pearlHireItemReserveCount, 20);
      assert.equal(afterOrdinarySettings.settings.teamOrderTriggerProtectionEnabled, false);

      const teamProtectionSettings = await postJsonResponse(
        `${base}/api/profiles/2088/settings/`,
        { teamOrderTriggerProtectionEnabled: true },
      );
      assert.equal(teamProtectionSettings.status, 200);
      assert.equal(
        teamProtectionSettings.json.settings.teamOrderTriggerProtectionEnabled,
        true,
      );
      assert.equal(
        JSON.parse(await fsPromises.readFile(
          path.join(dir, "runtime", "settings", "2088.json"),
          "utf8",
        )).teamOrderTriggerProtectionEnabled,
        true,
      );

      const paidRenewProtectionSettings = await postJsonResponse(
        `${base}/api/profiles/2088/settings/`,
        { teamOrderPaidRenewProtectionEnabled: false },
      );
      assert.equal(paidRenewProtectionSettings.status, 200);
      assert.equal(
        paidRenewProtectionSettings.json.settings
          .teamOrderPaidRenewProtectionEnabled,
        false,
      );
      assert.equal(
        JSON.parse(await fsPromises.readFile(
          path.join(dir, "runtime", "settings", "2088.json"),
          "utf8",
        )).teamOrderPaidRenewProtectionEnabled,
        false,
      );

      const invalidPaidRenewProtection = await postJsonResponse(
        `${base}/api/profiles/2088/settings/`,
        { teamOrderPaidRenewProtectionEnabled: "false" },
      );
      assert.equal(invalidPaidRenewProtection.status, 400);
      assert.equal(
        (await profileStore.getProfileSettings("2088"))
          .teamOrderPaidRenewProtectionEnabled,
        false,
      );

      const invalidTeamProtection = await postJsonResponse(
        `${base}/api/profiles/2088/settings/`,
        { teamOrderTriggerProtectionEnabled: "false" },
      );
      assert.equal(invalidTeamProtection.status, 400);
      assert.equal(
        (await profileStore.getProfileSettings("2088"))
          .teamOrderTriggerProtectionEnabled,
        true,
      );

      const invalidOrdinarySwitch = await postJsonResponse(
        `${base}/api/profiles/2088/settings/`,
        { autoSubmitOrdinaryResidentOrdersForLevelUp: "true" },
      );
      assert.equal(invalidOrdinarySwitch.status, 400);
      assert.equal(
        (await profileStore.getProfileSettings("2088"))
          .autoSubmitOrdinaryResidentOrdersForLevelUp,
        false,
      );

      for (const [key, value] of [
        ["autoReceiveWaterwheelBuckets", "false"],
        ["skipWaterwheelVideoBuckets", 1],
      ]) {
        const invalidWaterwheelSwitch = await postJsonResponse(
          `${base}/api/profiles/2088/settings/`,
          { [key]: value },
        );
        assert.equal(invalidWaterwheelSwitch.status, 400);
        assert.equal(invalidWaterwheelSwitch.json.error, "INVALID_PROFILE_SETTINGS");
      }
      const waterwheelSettingsAfterInvalid = await profileStore.getProfileSettings("2088");
      assert.equal(waterwheelSettingsAfterInvalid.autoReceiveWaterwheelBuckets, false);
      assert.equal(waterwheelSettingsAfterInvalid.skipWaterwheelVideoBuckets, true);

      const cyclicStorySettings = await postJsonResponse(
        `${base}/api/profiles/2088/settings/`,
        { autoSubmitCyclicStoryOrders: true },
      );
      assert.equal(cyclicStorySettings.status, 200);
      assert.equal(
        cyclicStorySettings.json.settings.autoSubmitCyclicStoryOrders,
        true,
      );
      assert.equal(
        (await profileStore.getProfileSettings("2088"))
          .autoSubmitCyclicStoryOrders,
        true,
      );

      const invalidCyclicStorySwitch = await postJsonResponse(
        `${base}/api/profiles/2088/settings/`,
        { autoSubmitCyclicStoryOrders: "true" },
      );
      assert.equal(invalidCyclicStorySwitch.status, 400);
      assert.equal(
        (await profileStore.getProfileSettings("2088"))
          .autoSubmitCyclicStoryOrders,
        true,
      );

      const invalidExperienceGuardThreshold = await postJsonResponse(
        `${base}/api/profiles/2088/settings/`,
        { experienceGuardThresholdPercent: 0.001 },
      );
      assert.equal(invalidExperienceGuardThreshold.status, 400);
      assert.equal(
        invalidExperienceGuardThreshold.json.error,
        "INVALID_PROFILE_SETTINGS",
      );
      assert.equal(
        (await profileStore.getProfileSettings("2088"))
          .experienceGuardThresholdPercent,
        0.37,
      );

      const unknownSettings = await postJsonResponse(
        `${base}/api/profiles/2088/settings/`,
        { unsupportedSetting: true },
      );
      assert.equal(unknownSettings.status, 400);

      const badSettings = await postJsonResponse(
        `${base}/api/profiles/2088/settings/`,
        { flowerRackTargetArtId: 123456 },
      );
      assert.equal(badSettings.status, 400);
      const afterBadSettings = await (await fetch(`${base}/api/profiles/2088/settings`)).json();
      assert.equal(afterBadSettings.settings.flowerRackTargetArtId, 305101);

      const validated = await postJson(`${base}/api/profiles/2088/validate`, {});
      assert.equal(validated.profile.serverIdx, 726);

      const once = await postJson(`${base}/api/profiles/2088/once`, {});
      assert.equal(once.exitCode, 0);
      assert.deepEqual(calls, [["runOnce", "2088", "orders"], ["runOnce", "2088", "once"]]);

      const statusDir = path.join(dir, "runtime", "status", "2088");
      await mkdir(statusDir, { recursive: true });
      await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
        updatedAt: "2026-06-29 18:00:00",
        summary: {
          totalLand: 60,
          emptyCount: 0,
          growingCount: 60,
          matureCount: 0,
          waterDropText: "37/65",
          accountLevel: {
            level: 40,
            currentExp: 123,
            requiredExp: 456,
            progressText: "123/456",
          },
        },
        automationQueue: {
          nextMatureText: "3分钟8秒",
          rows: [{ area: "土地补种", pending: 0, status: "空" }],
        },
      }), "utf8");
      await writeFile(path.join(statusDir, "order-status.json"), JSON.stringify({
        ordinary: { readyCount: 2 },
      }), "utf8");

      const status = await (await fetch(`${base}/api/profiles/2088/status`)).json();
      assert.equal(status.summary.land.total, 60);
      assert.equal(status.summary.resources.waterDropText, "37/65");
      assert.equal(status.summary.orders.ordinaryReadyCount, 2);
      assert.equal(status.summary.accountLevel.progressText, "123/456（27.0%）");
    }
    finally {
      await server.close();
    }
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system API serializes concurrent runtime settings writes per profile", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-api-runtime-settings-"));
  let resolveFirstRuntimeWriteStarted;
  let releaseFirstRuntimeWrite;
  let resolveSecondRuntimeWriteQueued;
  const firstRuntimeWriteStarted = new Promise((resolve) => {
    resolveFirstRuntimeWriteStarted = resolve;
  });
  const firstRuntimeWriteGate = new Promise((resolve) => {
    releaseFirstRuntimeWrite = resolve;
  });
  const secondRuntimeWriteQueued = new Promise((resolve) => {
    resolveSecondRuntimeWriteQueued = resolve;
  });
  let firstRuntimeWriteBlocked = false;
  let blockRuntimeWrites = false;
  let runtimeWriteQueueCount = 0;
  const runtimeSettingsFs = {
    ...fsPromises,
    async writeFile(filePath, data, writeOptions) {
      const result = await fsPromises.writeFile(filePath, data, writeOptions);
      if (blockRuntimeWrites && !firstRuntimeWriteBlocked && String(filePath).includes(`${path.sep}settings${path.sep}main.json.`)) {
        firstRuntimeWriteBlocked = true;
        resolveFirstRuntimeWriteStarted();
        await firstRuntimeWriteGate;
      }
      return result;
    },
  };
  try {
    const profileStore = createProfileStore({
      accountsDir: path.join(dir, "runtime", "accounts"),
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
    });
    await profileStore.importProfile({
      id: "main",
      credentials: {
        CTOKEN: "ct",
        PC_USER_ID: "main",
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
    });
    const runner = {
      runtime: async () => ({ active: null, activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [] }),
      startLoop: async () => ({ profileId: "main" }),
      stop: async () => ({ stopped: false }),
      runOnce: async () => ({ exitCode: 0 }),
    };
    const server = createSystemServer({
      profileStore,
      runner,
      coordinatedRunner: createTestCoordinatedRunner(runner),
      rootDir: dir,
      localRequestToken: "test-local-token",
      runtimeSettingsFs,
      profileOperationCoordinator: instrumentProfileOperationCoordinator(
        createProfileOperationCoordinator(),
        () => {
          runtimeWriteQueueCount += 1;
          if (runtimeWriteQueueCount === 2) resolveSecondRuntimeWriteQueued();
        },
      ),
    });
    await server.listen(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      assert.equal((await fetch(`${base}/api/profiles/main/settings`)).status, 200);
      runtimeWriteQueueCount = 0;
      blockRuntimeWrites = true;
      const first = postJsonResponse(`${base}/api/profiles/main/settings`, { flowerRackTargetArtId: 305101 });
      await firstRuntimeWriteStarted;
      const second = postJsonResponse(`${base}/api/profiles/main/settings`, { flowerRackTargetArtId: 302003 });
      await secondRuntimeWriteQueued;
      releaseFirstRuntimeWrite();
      const responses = await Promise.all([first, second]);
      assert.deepEqual(responses.map((response) => response.status), [200, 200]);
      const runtimeSettings = JSON.parse(await fsPromises.readFile(path.join(dir, "runtime", "settings", "main.json"), "utf8"));
      const finalSnapshot = await (await fetch(`${base}/api/profiles/main/settings`)).json();
      const { _meta, ...runtimeBody } = runtimeSettings;
      assert.deepEqual(runtimeBody, finalSnapshot.settings);
      assert.equal(_meta.settingsRevision, finalSnapshot.settingsRevision);
    } finally {
      releaseFirstRuntimeWrite();
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system start drains shared runtime settings writes before spawning the worker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-api-runtime-settings-start-"));
  let releaseFirstWrite;
  const firstWriteGate = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  let notifyFirstWriteStarted;
  const firstWriteStarted = new Promise((resolve) => {
    notifyFirstWriteStarted = resolve;
  });
  let notifySecondWriteQueued;
  const secondWriteQueued = new Promise((resolve) => {
    notifySecondWriteQueued = resolve;
  });
  let writeCount = 0;
  let queueCount = 0;
  const runtimeSettingsFs = {
    ...fsPromises,
    async writeFile(filePath, data, options) {
      const result = await fsPromises.writeFile(filePath, data, options);
      if (++writeCount === 1) {
        notifyFirstWriteStarted();
        await firstWriteGate;
      }
      return result;
    },
  };
  const worker = new EventEmitter();
  worker.threadId = 91;
  worker.pid = 9001;
  worker.terminate = async () => {
    setImmediate(() => worker.emit("exit", 0));
    return 0;
  };
  let workerData = null;
  try {
    const profileStore = createProfileStore({
      accountsDir: path.join(dir, "runtime", "accounts"),
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
    });
    await profileStore.importProfile({
      id: "main",
      credentials: {
        CTOKEN: "ct",
        PC_USER_ID: "main",
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
    });
    await profileStore.markValidated("main", undefined, { serverIdx: 726 });
    const server = createSystemServer({
      profileStore,
      rootDir: dir,
      localRequestToken: "test-local-token",
      startupConfirmMs: 0,
      runtimeSettingsFs,
      profileOperationCoordinator: instrumentProfileOperationCoordinator(
        createProfileOperationCoordinator(),
        () => {
          if (++queueCount === 2) notifySecondWriteQueued();
        },
      ),
      runnerOptions: {
        processProvider: async () => [],
        workerFactory(data) {
          workerData = data;
          return worker;
        },
      },
    });
    await server.listen(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const start = postJsonResponse(`${base}/api/profiles/main/start`, {});
      await firstWriteStarted;
      const save = postJsonResponse(`${base}/api/profiles/main/settings`, { pearlHireItemReserveCount: 20 });
      await secondWriteQueued;
      releaseFirstWrite();
      const [startResponse, saveResponse] = await Promise.all([start, save]);

      assert.equal(startResponse.status, 200);
      assert.equal(saveResponse.status, 200);
      const settingsPath = workerData.env.PROFILE_SETTINGS_PATH;
      assert.equal(
        JSON.parse(await fsPromises.readFile(settingsPath, "utf8")).pearlHireItemReserveCount,
        20,
      );
    } finally {
      releaseFirstWrite();
      await server.close();
    }
  } finally {
    releaseFirstWrite();
    await rm(dir, { recursive: true, force: true });
  }
});

test("system start reloads settings updated after its old profile snapshot and before spawn", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-api-runtime-settings-reverse-"));
  let releaseOldSnapshot;
  const oldSnapshotGate = new Promise((resolve) => {
    releaseOldSnapshot = resolve;
  });
  let notifyOldSnapshot;
  const oldSnapshotCaptured = new Promise((resolve) => {
    notifyOldSnapshot = resolve;
  });
  const worker = new EventEmitter();
  worker.threadId = 92;
  worker.pid = 9002;
  worker.terminate = async () => {
    setImmediate(() => worker.emit("exit", 0));
    return 0;
  };
  let oldSnapshotPending = true;
  let workerData = null;
  let workerVisibleSettings = null;
  try {
    const baseProfileStore = createProfileStore({
      accountsDir: path.join(dir, "runtime", "accounts"),
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
    });
    await baseProfileStore.importProfile({
      id: "main",
      credentials: {
        CTOKEN: "ct",
        PC_USER_ID: "main",
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
    });
    await baseProfileStore.markValidated("main", undefined, { serverIdx: 726 });
    const profileStore = {
      ...baseProfileStore,
      async getProfile(profileId) {
        const profile = await baseProfileStore.getProfile(profileId);
        if (oldSnapshotPending) {
          oldSnapshotPending = false;
          assert.equal(profile.settings.pearlHireItemReserveCount, 100);
          notifyOldSnapshot();
          await oldSnapshotGate;
        }
        return profile;
      },
    };
    const server = createSystemServer({
      profileStore,
      rootDir: dir,
      localRequestToken: "test-local-token",
      startupConfirmMs: 0,
      runnerOptions: {
        processProvider: async () => [],
        workerFactory(data) {
          workerData = data;
          workerVisibleSettings = JSON.parse(readFileSync(data.env.PROFILE_SETTINGS_PATH, "utf8"));
          return worker;
        },
      },
    });
    await server.listen(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const start = postJsonResponse(`${base}/api/profiles/main/start`, {});
      await oldSnapshotCaptured;
      const save = await postJsonResponse(`${base}/api/profiles/main/settings`, { pearlHireItemReserveCount: 20 });
      assert.equal(save.status, 200);
      assert.equal(save.json.settings.pearlHireItemReserveCount, 20);
      releaseOldSnapshot();
      const started = await start;

      assert.equal(started.status, 200);
      const settingsPath = workerData.env.PROFILE_SETTINGS_PATH;
      assert.equal(JSON.parse(await fsPromises.readFile(settingsPath, "utf8")).pearlHireItemReserveCount, 20);
      assert.equal(workerVisibleSettings.pearlHireItemReserveCount, 20);
    } finally {
      releaseOldSnapshot();
      await server.close();
    }
  } finally {
    releaseOldSnapshot();
    await rm(dir, { recursive: true, force: true });
  }
});

test("system once releases the profile settings coordinator after spawning", { timeout: 1500 }, async (t) => {
  await assertOneShotSettingsCanSaveBeforeExit(t, "once");
});

test("system orders releases the profile settings coordinator after spawning", { timeout: 1500 }, async (t) => {
  await assertOneShotSettingsCanSaveBeforeExit(t, "orders");
});

test("system validate releases the profile settings coordinator after spawning", { timeout: 1500 }, async (t) => {
  await assertOneShotSettingsCanSaveBeforeExit(t, "validate");
});

test("system one-shot completion failures do not poison later profile settings operations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-one-shot-completion-failure-"));
  let beginCalls = 0;
  let server = null;
  try {
    const profileStore = createProfileStore({
      accountsDir: path.join(dir, "runtime", "accounts"),
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
    });
    await profileStore.importProfile({
      id: "main",
      credentials: {
        CTOKEN: "ct",
        PC_USER_ID: "main",
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
    });
    await profileStore.markValidated("main", undefined, { serverIdx: 726 });
    const runner = {
      runtime: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [] }),
      startLoop: async () => ({ profileId: "main" }),
      beginRunOnce: async () => {
        beginCalls++;
        return { waitForExit: async () => { throw new Error("one-shot completion failed"); } };
      },
      runOnce: async () => ({ exitCode: 0 }),
      stop: async () => ({ stopped: false }),
    };
    server = createSystemServer({ profileStore, runner, coordinatedRunner: createTestCoordinatedRunner(runner), rootDir: dir, localRequestToken: "test-local-token" });
    await server.listen(0);
    const base = `http://127.0.0.1:${server.port}`;

    const first = await postJsonResponse(`${base}/api/profiles/main/once`, {});
    assert.equal(first.status, 500);
    const settings = await postJsonResponse(`${base}/api/profiles/main/settings`, { pearlHireItemReserveCount: 20 });
    assert.equal(settings.status, 200);
    const second = await postJsonResponse(`${base}/api/profiles/main/orders`, {});
    assert.equal(second.status, 500);
    assert.equal(beginCalls, 2);
  } finally {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("system API stop endpoint stops the runner before closing the local console", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-api-"));
  const calls = [];
  let server = null;
  try {
    const profileStore = createProfileStore({
      accountsDir: path.join(dir, "accounts"),
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
    });
    const runner = {
      runtime: async () => ({ active: { profileId: "main", pid: 9001 }, legacyProcesses: [] }),
      startLoop: async () => ({ pid: 9001 }),
      stop: async (profileId = null) => {
        calls.push(["stop", profileId]);
        return { stopped: true };
      },
      runOnce: async () => ({ exitCode: 0 }),
    };

    server = createSystemServer({ profileStore, runner, coordinatedRunner: createTestCoordinatedRunner(runner), rootDir: dir, localRequestToken: "test-local-token" });
    await server.listen(0);
    const base = `http://127.0.0.1:${server.port}`;

    const stopped = await postJson(`${base}/api/system/stop`, {});

    assert.equal(stopped.stopped, true);
    assert.deepEqual(calls, [["stop", null]]);
  } finally {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("system API supports selected-profile bulk start and stop with multi-account runtime shape", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-api-"));
  const calls = [];
  const active = new Map();
  let concurrentStarts = 0;
  let maxConcurrentStarts = 0;
  let nextPid = 9000;
  try {
    const profileStore = createProfileStore({
      accountsDir: path.join(dir, "accounts"),
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
      now: () => new Date("2026-07-04T00:00:00.000Z"),
    });
    for (const id of ["main", "alt", "third", "fourth"]) {
      await profileStore.importProfile({
        id,
        label: id,
        credentialText: `CTOKEN=ct-${id}\nPC_USER_ID=${id}\nPC_TOKEN=pc-${id}\nBABI_TOKEN=babi-${id}\nOPEN_ID=open-${id}`,
      });
      await profileStore.markValidated(id, undefined, { serverIdx: 726 });
    }
    const runner = {
      runtime: async () => {
        const activeTasks = Array.from(active.values());
        return {
          active: activeTasks[0] || null,
          activeTasks,
          activeByProfile: Object.fromEntries(activeTasks.map((task) => [task.profileId, task])),
          lastTaskExits: {},
          runningCount: activeTasks.length,
          maxParallelTasks: null,
          legacyProcesses: [],
        };
      },
      startLoop: async (profile) => {
        calls.push(["startLoop", profile.id]);
        concurrentStarts += 1;
        maxConcurrentStarts = Math.max(maxConcurrentStarts, concurrentStarts);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const task = { pid: nextPid++, profileId: profile.id, mode: "loop" };
        active.set(profile.id, task);
        concurrentStarts -= 1;
        return task;
      },
      stop: async (profileId = null) => {
        calls.push(["stop", profileId]);
        if (profileId == null) {
          const count = active.size;
          active.clear();
          return { stopped: count > 0, count };
        }
        const task = active.get(profileId);
        active.delete(profileId);
        return { stopped: Boolean(task), ...(task || { profileId }) };
      },
      runOnce: async () => ({ exitCode: 0 }),
    };

    const server = createSystemServer({ profileStore, runner, coordinatedRunner: createTestCoordinatedRunner(runner), rootDir: dir, localRequestToken: "test-local-token" });
    await server.listen(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;

      const started = await postJson(`${base}/api/profiles/bulk/start`, {
        profileIds: ["main", "alt", "third", "fourth"],
      });
      assert.deepEqual(started.started.map((task) => task.profileId).sort(), ["alt", "fourth", "main", "third"]);
      assert.deepEqual(started.skipped, []);
      assert.equal(started.runningCount, 4);
      assert.equal(started.maxParallelTasks, null);
      assert.equal(maxConcurrentStarts, 4);

      const runtime = await (await fetch(`${base}/api/runtime`)).json();
      assert.equal(runtime.runningCount, 4);
      assert.equal(runtime.maxParallelTasks, null);
      assert.ok(["alt", "fourth", "main", "third"].includes(runtime.active?.profileId));
      assert.deepEqual(Object.keys(runtime.activeByProfile).sort(), ["alt", "fourth", "main", "third"]);
      assert.deepEqual(runtime.activeTasks.map((task) => task.profileId).sort(), ["alt", "fourth", "main", "third"]);

      const stopped = await postJson(`${base}/api/profiles/bulk/stop`, {
        profileIds: ["alt"],
      });
      assert.deepEqual(stopped.stopped.map((task) => task.profileId), ["alt"]);
      assert.equal(stopped.runningCount, 3);
      assert.equal(active.has("main"), true);
      assert.equal(active.has("alt"), false);

      const stoppedAll = await postJson(`${base}/api/profiles/bulk/stop`, {});
      assert.equal(stoppedAll.stopped.length, 3);
      assert.equal(stoppedAll.runningCount, 0);
      assert.deepEqual(
        calls.filter(([action]) => action === "startLoop").map(([, profileId]) => profileId).sort(),
        ["alt", "fourth", "main", "third"],
      );
      assert.deepEqual(calls.filter(([action, profileId]) => action === "stop" && profileId === "alt"), [["stop", "alt"]]);
      assert.ok(calls.some(([action, profileId]) => action === "stop" && profileId === null));
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system server close stops the runner before clearing the local console lock", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-api-"));
  const calls = [];
  let server = null;
  try {
    const profileStore = createProfileStore({
      accountsDir: path.join(dir, "accounts"),
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
    });
    const runner = {
      runtime: async () => ({ active: { profileId: "main", pid: 9001 }, legacyProcesses: [] }),
      startLoop: async () => ({ pid: 9001 }),
      stop: async (profileId = null) => {
        calls.push(["stop", profileId]);
        return { stopped: true };
      },
      runOnce: async () => ({ exitCode: 0 }),
    };

    server = createSystemServer({ profileStore, runner, coordinatedRunner: createTestCoordinatedRunner(runner), rootDir: dir, localRequestToken: "test-local-token" });
    await server.listen(0);

    await server.close();
    server = null;

    assert.deepEqual(calls, [["stop", null]]);
  } finally {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("system API migrates legacy game-secrets and validates a profile with read-only orders", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-api-"));
  const calls = [];
  try {
    await mkdir(path.join(dir, "work"), { recursive: true });
    await writeFile(path.join(dir, "work", "game-secrets.json"), JSON.stringify({
      CTOKEN: "old:ctoken-secret",
      PC_USER_ID: "2088123456789012",
      PC_TOKEN: "old:pc-token-secret",
      BABI_TOKEN: "old:babi-token-secret",
      OPEN_ID: "old:open-id-secret",
    }), "utf8");

    const profileStore = createProfileStore({
      accountsDir: path.join(dir, "runtime", "accounts"),
      protect: (value) => `new:${value}`,
      unprotect: (value) => value.slice("new:".length),
      now: () => new Date("2026-06-30T05:00:00.000Z"),
    });
    const runner = {
      runtime: async () => ({ active: null, legacyProcesses: [] }),
      startLoop: async () => ({ pid: 9001 }),
      stop: async () => ({ stopped: true }),
      runOnce: async (profile, mode) => {
        calls.push(["runOnce", profile.id, mode, profile.env.PC_USER_ID]);
        const statusDir = path.join(dir, "runtime", "status", profile.id);
        await mkdir(statusDir, { recursive: true });
        await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
          summary: {
            accountLevel: {
              level: 35,
              currentExp: 99,
              requiredExp: 100,
              serverIdx: 726,
              serverText: "区服 726",
            },
          },
          automationQueue: { rows: [] },
        }), "utf8");
        return { exitCode: 0, logPath: path.join(dir, "orders.log") };
      },
    };

    const server = createSystemServer({
      profileStore,
      runner,
      coordinatedRunner: createTestCoordinatedRunner(runner),
      rootDir: dir,
      localRequestToken: "test-local-token",
      legacyUnprotect: (value) => value.slice("old:".length),
    });
    await server.listen(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;

      const legacyStatus = await (await fetch(`${base}/api/migration/legacy-credentials`)).json();
      assert.equal(legacyStatus.exists, true);
      assert.equal(legacyStatus.complete, true);
      assert.equal(legacyStatus.profileId, "2088123456789012");
      assert.equal(JSON.stringify(legacyStatus).includes("ctoken-secret"), false);

      const profilesBeforeMigration = await (await fetch(`${base}/api/profiles`)).json();
      assert.equal(profilesBeforeMigration.profiles.length, 0);
      assert.equal(profilesBeforeMigration.legacyMigration.attempted, false);
      assert.equal(profilesBeforeMigration.legacyMigration.migrated, false);
      assert.equal(profilesBeforeMigration.legacyMigration.status.complete, true);

      const migrated = await postJson(`${base}/api/migration/legacy-credentials`, {});
      assert.equal(migrated.profile.hasCredentials, true);

      const validated = await postJson(`${base}/api/profiles/2088123456789012/validate`, {});
      assert.equal(validated.result.exitCode, 0);
      assert.equal(validated.profile.lastValidatedAt, "2026-06-30T05:00:00.000Z");
      assert.equal(validated.profile.serverIdx, 726);
      assert.equal(validated.profile.serverText, "区服 726");
      assert.deepEqual(calls, [["runOnce", "2088123456789012", "orders", "2088123456789012"]]);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system API rejects single-profile run actions after a session-expired exit but still allows validation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-api-session-expired-"));
  const calls = [];
  try {
    const profileStore = createProfileStore({
      accountsDir: path.join(dir, "accounts"),
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
      now: () => new Date("2026-07-07T04:00:00.000Z"),
    });
    await profileStore.importProfile({
      label: "主号",
      credentialText: "CTOKEN=ct\nPC_USER_ID=2088\nPC_TOKEN=pc\nBABI_TOKEN=babi\nOPEN_ID=open",
    });
    await profileStore.markValidated("2088", undefined, { serverIdx: 726 });

    const runner = {
      runtime: async () => ({
        active: null,
        activeTasks: [],
        activeByProfile: {},
        lastTaskExits: {
          2088: {
            profileId: "2088",
            reason: "session-expired",
            exitCode: 42,
            message: "检测到账号在其他设备登录或会话已失效，自动化循环已自动停止。",
          },
        },
        legacyProcesses: [],
      }),
      startLoop: async (profile) => {
        calls.push(["startLoop", profile.id]);
        return { pid: 9001, profileId: profile.id, mode: "loop" };
      },
      stop: async () => ({ stopped: false }),
      runOnce: async (profile, mode) => {
        calls.push(["runOnce", profile.id, mode]);
        const statusDir = path.join(dir, "runtime", "status", profile.id);
        await mkdir(statusDir, { recursive: true });
        await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
          summary: {
            accountLevel: {
              level: 41,
              currentExp: 100,
              requiredExp: 1000,
              serverIdx: 726,
              serverText: "区服 726",
            },
          },
          automationQueue: { rows: [] },
        }), "utf8");
        return { exitCode: 0, logPath: path.join(dir, "orders.log") };
      },
    };

    const server = createSystemServer({ profileStore, runner, coordinatedRunner: createTestCoordinatedRunner(runner), rootDir: dir, localRequestToken: "test-local-token" });
    await server.listen(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;

      const start = await postJsonResponse(`${base}/api/profiles/2088/start`, {});
      assert.equal(start.status, 422);
      assert.equal(start.json.reason, "session-expired");
      assert.match(start.json.message, /请先验证账号/);

      const orders = await postJsonResponse(`${base}/api/profiles/2088/orders`, {});
      assert.equal(orders.status, 422);
      assert.equal(orders.json.reason, "session-expired");

      const once = await postJsonResponse(`${base}/api/profiles/2088/once`, {});
      assert.equal(once.status, 422);
      assert.equal(once.json.reason, "session-expired");

      const validated = await postJsonResponse(`${base}/api/profiles/2088/validate`, {});
      assert.equal(validated.status, 200);
      assert.deepEqual(calls, [["runOnce", "2088", "orders"]]);
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system API validate reports session-expired instead of missing server", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-api-validate-session-expired-"));
  try {
    const profileStore = createProfileStore({
      accountsDir: path.join(dir, "accounts"),
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
      now: () => new Date("2026-07-07T08:00:00.000Z"),
    });
    await profileStore.importProfile({
      id: "2088",
      label: "言若",
      credentialText: "CTOKEN=ct\nPC_USER_ID=2088\nPC_TOKEN=pc\nBABI_TOKEN=babi\nOPEN_ID=open",
    });

    const runner = {
      runtime: async () => ({
        active: null,
        activeTasks: [],
        activeByProfile: {},
        lastExit: {
          profileId: "2088",
          reason: "session-expired",
          exitCode: 42,
          category: "login-state",
          message: "检测到账号在其他设备登录或会话已失效，自动化循环已自动停止。",
        },
        lastTaskExits: {
          2088: {
            profileId: "2088",
            reason: "session-expired",
            exitCode: 42,
            category: "login-state",
            message: "检测到账号在其他设备登录或会话已失效，自动化循环已自动停止。",
          },
        },
        legacyProcesses: [],
      }),
      startLoop: async () => ({ pid: 9001 }),
      stop: async () => ({ stopped: false }),
      runOnce: async () => ({ exitCode: 42, logPath: path.join(dir, "orders.log") }),
    };

    const server = createSystemServer({ profileStore, runner, coordinatedRunner: createTestCoordinatedRunner(runner), rootDir: dir, localRequestToken: "test-local-token" });
    await server.listen(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const validated = await postJsonResponse(`${base}/api/profiles/2088/validate`, {});

      assert.equal(validated.status, 422);
      assert.equal(validated.json.valid, false);
      assert.equal(validated.json.error, "SESSION_EXPIRED");
      assert.equal(validated.json.reason, "session-expired");
      assert.equal(validated.json.exitCode, 42);
      assert.equal(validated.json.message, "验证失败：会话已过期，请重新导入最新凭据。");
      assert.notEqual(validated.json.error, "MISSING_ACCOUNT_SERVER");
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system API validate reports missing server only after a successful orders check", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-api-validate-missing-server-"));
  try {
    const profileStore = createProfileStore({
      accountsDir: path.join(dir, "accounts"),
      protect: (value) => `p:${value}`,
      unprotect: (value) => value.slice(2),
      now: () => new Date("2026-07-07T08:00:00.000Z"),
    });
    await profileStore.importProfile({
      id: "2088",
      label: "言若",
      credentialText: "CTOKEN=ct\nPC_USER_ID=2088\nPC_TOKEN=pc\nBABI_TOKEN=babi\nOPEN_ID=open",
    });

    const runner = {
      runtime: async () => ({
        active: null,
        activeTasks: [],
        activeByProfile: {},
        lastTaskExits: {},
        legacyProcesses: [],
      }),
      startLoop: async () => ({ pid: 9001 }),
      stop: async () => ({ stopped: false }),
      runOnce: async (profile) => {
        const statusDir = path.join(dir, "runtime", "status", profile.id);
        await mkdir(statusDir, { recursive: true });
        await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
          summary: {
            accountLevel: {
              level: 41,
              currentExp: 100,
              requiredExp: 1000,
            },
          },
        }), "utf8");
        return { exitCode: 0, logPath: path.join(dir, "orders.log") };
      },
    };

    const server = createSystemServer({ profileStore, runner, coordinatedRunner: createTestCoordinatedRunner(runner), rootDir: dir, localRequestToken: "test-local-token" });
    await server.listen(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const validated = await postJsonResponse(`${base}/api/profiles/2088/validate`, {});

      assert.equal(validated.status, 422);
      assert.equal(validated.json.valid, false);
      assert.equal(validated.json.error, "MISSING_ACCOUNT_SERVER");
      assert.equal(validated.json.message, "验证失败：未能确认账号区服，请重新导入最新凭据。");
    } finally {
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("game version API is cache-only on GET, checks the selected profile on POST, and starts the scheduler", async () => {
  const checkedProfiles = [];
  let schedulerStarts = 0;
  let schedulerStops = 0;
  const fixture = await createGuardedServerFixture({
    localRequestToken: "test-local-token",
    gameVersionService: {
      getStatus: async () => ({ localVersion: "391.0.17", remoteVersion: "392.0.1", comparison: "newer" }),
      check: async (profileId) => {
        checkedProfiles.push(profileId);
        return { localVersion: "391.0.17", remoteVersion: "392.0.1", comparison: "newer" };
      },
    },
    gameVersionScheduler: {
      start() { schedulerStarts += 1; },
      stop() { schedulerStops += 1; },
      getStatus: () => ({ running: true, nextCheckAt: "2026-08-03T07:00:00.000Z", hours: [3, 15] }),
    },
  });
  try {
    assert.equal(schedulerStarts, 1);
    const status = await (await fetch(`${fixture.base}/api/system/game-version`)).json();
    assert.equal(status.localVersion, "391.0.17");
    assert.equal(status.remoteVersion, "392.0.1");
    assert.deepEqual(status.schedule.hours, [3, 15]);
    assert.deepEqual(checkedProfiles, []);

    const checked = await postJsonResponse(
      `${fixture.base}/api/system/game-version/check`,
      { profileId: "main" },
    );
    assert.equal(checked.status, 200);
    assert.equal(checked.json.comparison, "newer");
    assert.deepEqual(checkedProfiles, ["main"]);
    assert.deepEqual(fixture.stopCalls, []);
  } finally {
    await fixture.close();
  }
  assert.equal(schedulerStops, 1);
});

test("game version GET preserves legacy fields and adds independent code and data projections", async () => {
  let dataReads = 0;
  const fixture = await createGuardedServerFixture({
    localRequestToken: "test-local-token",
    gameVersionService: {
      getStatus: async () => ({ localVersion: "391.0.25", remoteVersion: "400.0.15", comparison: "newer" }),
      check: async () => assert.fail("GET must not check upstream"),
    },
    gameVersionScheduler: { start() {}, stop() {}, getStatus: () => ({ running: true }) },
    gameDataSyncService: {
      initialize: async () => {},
      getStatus: async () => {
        dataReads += 1;
        return {
          activeVersion: "2f3f6",
          activeSourceCodeVersion: "391.0.25",
          candidateVersion: null,
          candidateSourceCodeVersion: null,
          compatibilityStatus: "unknown",
          syncStatus: "idle",
          lastSuccessfulSyncAt: null,
          lastError: null,
        };
      },
      sync: async () => assert.fail("GET must not sync"),
    },
  });
  try {
    const response = await fetch(`${fixture.base}/api/system/game-version`);
    const status = await response.json();
    assert.equal(status.localVersion, "391.0.25");
    assert.equal(status.remoteVersion, "400.0.15");
    assert.equal(status.code.localVersion, "391.0.25");
    assert.equal(status.code.officialVersion, "400.0.15");
    assert.equal(status.code.reviewStatus, "pending-analysis");
    assert.equal(status.data.activeVersion, "2f3f6");
    assert.equal(dataReads, 1);
  } finally {
    await fixture.close();
  }
});

test("game data sync API is a thin protected route and exposes stable failure evidence", async () => {
  const syncCalls = [];
  const dataStatus = {
    activeVersion: "bbb22",
    activeSourceCodeVersion: "400.0.15",
    candidateVersion: "bbb22",
    candidateSourceCodeVersion: "400.0.15",
    compatibilityStatus: "compatible",
    syncStatus: "latest",
    lastSuccessfulSyncAt: "2026-08-12T05:00:00.000Z",
    lastError: null,
  };
  const service = {
    initialize: async () => {},
    getStatus: async () => dataStatus,
    sync: async (profileId) => {
      syncCalls.push(profileId);
      if (profileId === "blocked") {
        throw Object.assign(new Error("请先停止全部账号任务并等待运行状态收敛"), {
          statusCode: 409,
          code: "GAME_DATA_SYNC_RUNTIME_ACTIVE",
          activeDataVersion: "aaa11",
          phase: "preflight",
        });
      }
      return { previousDataVersion: "aaa11", activeDataVersion: "bbb22", loaderCount: 17 };
    },
  };
  const fixture = await createGuardedServerFixture({
    localRequestToken: "test-local-token",
    gameDataSyncService: service,
    gameVersionService: { getStatus: async () => ({}) },
    gameVersionScheduler: { start() {}, stop() {}, getStatus: () => ({}) },
  });
  try {
    const invalid = await postJsonResponse(`${fixture.base}/api/system/game-data/sync`, { profileId: "bad/id" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error, "INVALID_PROFILE_ID");

    const blocked = await postJsonResponse(`${fixture.base}/api/system/game-data/sync`, { profileId: "blocked" });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error, "GAME_DATA_SYNC_RUNTIME_ACTIVE");
    assert.equal(blocked.json.activeDataVersion, "aaa11");
    assert.equal(blocked.json.phase, "preflight");

    const success = await postJsonResponse(`${fixture.base}/api/system/game-data/sync`, { profileId: "main" });
    assert.equal(success.status, 200);
    assert.equal(success.json.codeUpdated, false);
    assert.equal(success.json.data.activeVersion, "bbb22");
    assert.equal(success.json.data.previousVersion, "aaa11");
    assert.equal(success.json.data.loaderCount, 17);
    assert.deepEqual(syncCalls, ["blocked", "main"]);
  } finally {
    await fixture.close();
  }
});

test("profile status defaults to a compact projection and supports full compatibility plus ETag", async () => {
  const fixture = await createGuardedServerFixture({ localRequestToken: "test-local-token" });
  const statusDir = path.join(fixture.runtimeDir, "status", "main");
  const logDir = path.join(fixture.runtimeDir, "logs", "main");
  try {
    await mkdir(statusDir, { recursive: true });
    await mkdir(logDir, { recursive: true });
    await writeFile(path.join(statusDir, "garden-status.json"), JSON.stringify({
      updatedAt: "2026-08-11 18:30:00",
      cycle: 9,
      summary: {
        totalLand: 60,
        doubleGoldRemainingText: "9分50秒",
        waterDropNeedText: "还需 8",
      },
      automationQueue: { rows: [] },
      waterwheel: { status: "ready" },
      flowerRack: {
        recommendedArts: [
          { artId: 305101, label: "305101(青瓷瓶+红玫瑰)", salePrice: 200 },
        ],
      },
      inventorySorted: Array.from({ length: 1000 }, (_, index) => ({ index, secret: "heavy" })),
      runHistory: Array.from({ length: 1000 }, (_, index) => ({ index, secret: "heavy" })),
    }), "utf8");
    await writeFile(path.join(statusDir, "order-status.json"), JSON.stringify({
      residentBoard: { completedCount: 425 },
      runHistory: Array.from({ length: 1000 }, (_, index) => ({ index, secret: "heavy" })),
    }), "utf8");
    await writeFile(path.join(logDir, "auto-plant-20260811-183000.log"), "log secret", "utf8");

    const compactRsp = await fetch(`${fixture.base}/api/profiles/main/status`);
    assert.equal(compactRsp.status, 200);
    const etag = compactRsp.headers.get("etag");
    assert.match(etag, /^"[a-f0-9]{64}"$/);
    const compactText = await compactRsp.text();
    const compact = JSON.parse(compactText);
    assert.equal(compact.summary.land.total, 60);
    assert.equal(compact.projection.garden.waterwheel.status, "ready");
    assert.deepEqual(compact.projection.garden.flowerRack.recommendedArts, [
      { artId: 305101, label: "305101(青瓷瓶+红玫瑰)", salePrice: 200 },
    ]);
    assert.equal(compact.projection.order.residentBoard.completedCount, 425);
    assert.equal(typeof compact.revision, "string");
    assert.equal(Object.hasOwn(compact, "gardenStatus"), false);
    assert.equal(Object.hasOwn(compact, "orderStatus"), false);
    assert.equal(Object.hasOwn(compact, "logs"), false);
    assert.doesNotMatch(compactText, /log secret|inventorySorted|runHistory/);

    const unchangedRsp = await fetch(`${fixture.base}/api/profiles/main/status`, {
      headers: { "if-none-match": etag },
    });
    assert.equal(unchangedRsp.status, 304);
    assert.equal(await unchangedRsp.text(), "");

    const fullRsp = await fetch(`${fixture.base}/api/profiles/main/status?full=1&trigger=manual-refresh&generation=7`);
    assert.equal(fullRsp.status, 200);
    const full = await fullRsp.json();
    assert.equal(full.summary.land.total, 60);
    assert.equal(full.projection.order.residentBoard.completedCount, 425);
    assert.deepEqual(full.readMeta, {
      full: true,
      trigger: "manual-refresh",
      generation: "7",
      source: "local-runtime-artifacts",
    });
    assert.equal(full.gardenStatus.data.inventorySorted.length, 1000);
    assert.equal(full.orderStatus.data.runHistory.length, 1000);
    assert.equal(full.logs[0].name, "auto-plant-20260811-183000.log");
  } finally {
    await fixture.close();
  }
});

test("experience guard API requires explicit revisioned rearm and waits for worker authority", async () => {
  const fixture = await createGuardedServerFixture({ localRequestToken: "test-local-token" });
  try {
    const statePath = path.join(
      fixture.runtimeDir,
      "system",
      "experience-guards",
      "main.json",
    );
    const guard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
    guard.observeAuthoritative({ level: 19, currentExp: 80_000, requiredExp: 81_400, enabled: true });
    guard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });

    const beforeRsp = await fetch(`${fixture.base}/api/profiles/main/experience-guard`);
    assert.equal(beforeRsp.status, 200);
    const before = await beforeRsp.json();
    assert.equal(before.state.breached, true);

    const unconfirmed = await postJsonResponse(
      `${fixture.base}/api/profiles/main/experience-guard`,
      { expectedStateRevision: before.state.stateRevision, confirm: false },
      "test-local-token",
    );
    assert.equal(unconfirmed.status, 400);
    assert.equal(unconfirmed.json.error, "EXPERIENCE_GUARD_REARM_CONFIRMATION_REQUIRED");

    const accepted = await postJsonResponse(
      `${fixture.base}/api/profiles/main/experience-guard`,
      { expectedStateRevision: before.state.stateRevision, confirm: true },
      "test-local-token",
    );
    assert.equal(accepted.status, 202);
    assert.equal(accepted.json.rearmState, "pending-authoritative-confirmation");
    assert.equal(guard.getDecision({ enabled: true }).blocked, true);

    guard.observeAuthoritative({
      level: 20,
      currentExp: 2,
      requiredExp: 100_000,
      enabled: true,
      source: "worker-authority",
      eligibleRearmRequestId: accepted.json.request.requestId,
    });
    assert.equal(guard.getDecision({ enabled: true }).blocked, false);
    assert.equal(guard.getState().ceilingLevel, 20);
  } finally {
    await fixture.close();
  }
});

test("experience guard API exposes a settlement residue and requires its account-bound recovery route", async () => {
  const fixture = await createGuardedServerFixture({ localRequestToken: "test-local-token" });
  try {
    const statePath = path.join(
      fixture.runtimeDir,
      "system",
      "experience-guards",
      "main.json",
    );
    const guard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
    guard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
    guard.beginProtectedAction({
      requestId: "server-pending-harvest",
      iface: "gs.usrLand.harvest",
      actionArgs: { landId: 1028 },
      actionEvidence: {
        land: {
          landId: 1028,
          snapshot: {
            landId: 1028,
            flowerId: 23001,
            state: 3,
            harvestCnt: 1,
            nextTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
    });
    guard.markProtectedActionUncertain({ requestId: "server-pending-harvest", message: "用户停止" });

    const beforeRsp = await fetch(`${fixture.base}/api/profiles/main/experience-guard`);
    assert.equal(beforeRsp.status, 200);
    const before = await beforeRsp.json();
    assert.equal(before.pendingSettlement.requestId, "server-pending-harvest");
    assert.equal(before.pendingSettlementRecovery, null);

    const generic = await postJsonResponse(
      `${fixture.base}/api/profiles/main/experience-guard`,
      { expectedStateRevision: before.state.stateRevision, confirm: true },
      "test-local-token",
    );
    assert.equal(generic.status, 409);
    assert.equal(generic.json.error, "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_REQUIRED");

    const unconfirmed = await postJsonResponse(
      `${fixture.base}/api/profiles/main/experience-guard/recover-settlement`,
      {
        expectedStateRevision: before.state.stateRevision,
        pendingRequestId: "server-pending-harvest",
        confirm: false,
      },
      "test-local-token",
    );
    assert.equal(unconfirmed.status, 400);
    assert.equal(
      unconfirmed.json.error,
      "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_CONFIRMATION_REQUIRED",
    );

    const accepted = await postJsonResponse(
      `${fixture.base}/api/profiles/main/experience-guard/recover-settlement`,
      {
        expectedStateRevision: before.state.stateRevision,
        pendingRequestId: "server-pending-harvest",
        confirm: true,
      },
      "test-local-token",
    );
    assert.equal(accepted.status, 202);
    assert.equal(accepted.json.recoveryState, "pending-authoritative-settlement-confirmation");
    assert.equal(accepted.json.request.pendingRequestId, "server-pending-harvest");
    assert.equal(guard.getDecision({ enabled: true }).blocked, true);

    const afterRsp = await fetch(`${fixture.base}/api/profiles/main/experience-guard`);
    const after = await afterRsp.json();
    assert.equal(after.pendingSettlementRecovery.requestId, accepted.json.request.requestId);
    assert.equal(after.pendingSettlement.requestId, "server-pending-harvest");
  } finally {
    await fixture.close();
  }
});

test("experience guard API resolves a no-fingerprint residue only through stopped-account legacy confirmation", async () => {
  const fixture = await createGuardedServerFixture({ localRequestToken: "test-local-token" });
  try {
    const statePath = path.join(
      fixture.runtimeDir,
      "system",
      "experience-guards",
      "main.json",
    );
    const guard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
    guard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
    guard.beginProtectedAction({
      requestId: "legacy-server-pending",
      iface: "gs.usrLand.harvest",
      actionArgs: { landId: 1028 },
    });
    guard.markProtectedActionUncertain({ requestId: "legacy-server-pending", message: "用户停止" });
    const beforeRsp = await fetch(`${fixture.base}/api/profiles/main/experience-guard`);
    const before = await beforeRsp.json();

    const missingReason = await postJsonResponse(
      `${fixture.base}/api/profiles/main/experience-guard/resolve-legacy-settlement`,
      {
        confirm: true,
        legacyUnverified: true,
        expectedStateRevision: before.state.stateRevision,
        pendingRequestId: "legacy-server-pending",
      },
      "test-local-token",
    );
    assert.equal(missingReason.status, 400);
    assert.equal(
      missingReason.json.error,
      "EXPERIENCE_GUARD_SETTLEMENT_LEGACY_OPERATOR_REASON_REQUIRED",
    );

    const accepted = await postJsonResponse(
      `${fixture.base}/api/profiles/main/experience-guard/resolve-legacy-settlement`,
      {
        confirm: true,
        legacyUnverified: true,
        expectedStateRevision: before.state.stateRevision,
        pendingRequestId: "legacy-server-pending",
        operatorReason: "历史请求缺少执行前快照，人工接受远端可能已执行的风险",
      },
      "test-local-token",
    );
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.resolutionState, "resolved-operator-confirmed-legacy-recovery");
    assert.equal(accepted.json.request.recoveryMode, "legacy-unverified");
    assert.equal(accepted.json.state.invalid, false);
    assert.equal(accepted.json.state.settlementResolution.recoveryMode, "legacy-unverified");
    assert.equal(guard.getPendingSettlement(), null);
    assert.equal(guard.getDecision({ enabled: true }).blocked, false);
  } finally {
    await fixture.close();
  }
});

test("experience guard API refuses legacy resolution while the account is active", async () => {
  const fixture = await createGuardedServerFixture({
    localRequestToken: "test-local-token",
    activeByProfile: { main: { profileId: "main", pid: 321 } },
  });
  try {
    const statePath = path.join(
      fixture.runtimeDir,
      "system",
      "experience-guards",
      "main.json",
    );
    const guard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
    guard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
    guard.beginProtectedAction({
      requestId: "active-legacy-server-pending",
      iface: "gs.usrLand.harvest",
      actionArgs: { landId: 1028 },
    });
    guard.markProtectedActionUncertain({ requestId: "active-legacy-server-pending" });
    const before = await (await fetch(`${fixture.base}/api/profiles/main/experience-guard`)).json();

    const response = await postJsonResponse(
      `${fixture.base}/api/profiles/main/experience-guard/resolve-legacy-settlement`,
      {
        confirm: true,
        legacyUnverified: true,
        expectedStateRevision: before.state.stateRevision,
        pendingRequestId: "active-legacy-server-pending",
        operatorReason: "人工接受历史请求无法核实的远端执行风险",
      },
      "test-local-token",
    );
    assert.equal(response.status, 409);
    assert.equal(response.json.error, "EXPERIENCE_GUARD_SETTLEMENT_LEGACY_ACCOUNT_RUNNING");
    assert.equal(guard.getPendingSettlement().requestId, "active-legacy-server-pending");
    assert.equal(guard.getPendingSettlementRecovery(), null);
  } finally {
    await fixture.close();
  }
});

test("game version POST rejects an invalid profile id before invoking the service", async () => {
  const checkedProfiles = [];
  const fixture = await createGuardedServerFixture({
    localRequestToken: "test-local-token",
    gameVersionService: {
      getStatus: async () => ({}),
      check: async (profileId) => { checkedProfiles.push(profileId); return {}; },
    },
    gameVersionScheduler: { start() {}, stop() {}, getStatus: () => ({}) },
  });
  try {
    const response = await postJsonResponse(
      `${fixture.base}/api/system/game-version/check`,
      { profileId: "bad/id" },
    );
    assert.equal(response.status, 400);
    assert.equal(response.json.error, "INVALID_PROFILE_ID");
    assert.deepEqual(checkedProfiles, []);
  } finally {
    await fixture.close();
  }
});

async function createGuardedServerFixture(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-guarded-server-"));
  const runtimeDir = path.join(dir, "runtime");
  const stopCalls = [];
  const profileStore = {
    listProfiles: async () => [],
    getProfile: async (id) => ({ id, hasCredentials: false, settings: {} }),
    loadProfileEnv: async () => ({}),
    readSettingsStateForProtocol: async () => {
      throw Object.assign(new Error("profile not found"), { code: "PROFILE_NOT_FOUND" });
    },
    compareAndWriteTentativeSettingsForProtocol: async () => {
      throw new Error("unexpected settings mutation");
    },
    conditionalRollbackSettingsForProtocol: async () => {
      throw new Error("unexpected settings rollback");
    },
  };
  const runner = {
    runtime: async () => ({
      activeTasks: [],
      activeByProfile: options.activeByProfile || {},
      runningCount: Object.keys(options.activeByProfile || {}).length,
      legacyProcesses: [],
    }),
    startLoop: async () => ({ profileId: "main" }),
    runOnce: async () => ({ exitCode: 0 }),
    stop: async (profileId = null) => {
      stopCalls.push(profileId);
      return { stopped: true };
    },
    stopLegacy: async () => ({ stopped: false }),
  };
  const server = createSystemServer({
    rootDir: dir,
    runtimeDir,
    profileStore,
    runner,
    coordinatedRunner: createTestCoordinatedRunner(runner),
    gameVersionService: options.gameVersionService,
    gameVersionScheduler: options.gameVersionScheduler,
    gameDataSyncService: options.gameDataSyncService,
    localRequestToken: options.localRequestToken,
    legacyMigrator: {
      inspect: async () => ({ complete: false }),
      migrate: async () => ({ migrated: false }),
    },
  });
  await server.listen(0);
  return {
    base: `http://127.0.0.1:${server.port}`,
    runtimeDir,
    stopCalls,
    async close() {
      await server.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function postJson(url, body, token = "test-local-token") {
  const settingsHeaders = await buildProfileSettingsTestHeaders(url, token);
  const rsp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-xjskp-session-token": token,
      ...settingsHeaders,
    },
    body: JSON.stringify(body),
  });
  const json = await rsp.json();
  if (!rsp.ok) {
    throw new Error(JSON.stringify(json));
  }
  return json;
}

async function postJsonResponse(url, body, token = "test-local-token", snapshot = null) {
  const settingsHeaders = await buildProfileSettingsTestHeaders(url, token, snapshot);
  const rsp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-xjskp-session-token": token,
      ...settingsHeaders,
    },
    body: JSON.stringify(body),
  });
  const json = await rsp.json();
  return { status: rsp.status, json };
}

let profileSettingsTransactionSequence = 0;

async function buildProfileSettingsTestHeaders(url, token, snapshot = null) {
  if (!/\/api\/profiles\/[^/]+\/settings\/?$/.test(String(url))) return {};
  let current = snapshot;
  if (!current) {
    const response = await fetch(url, {
      headers: { "x-xjskp-session-token": token },
    });
    current = await response.json();
  }
  profileSettingsTransactionSequence += 1;
  return {
    "if-match": `"${current.settingsEpoch}:${current.settingsRevision}"`,
    "x-xjskp-settings-transaction-id": `server-test-transaction-${profileSettingsTransactionSequence}`,
  };
}

function instrumentProfileOperationCoordinator(coordinator, onQueued) {
  return {
    run(profileId, operation) {
      onQueued(profileId);
      return coordinator.run(profileId, operation);
    },
    runCanonical(profileId, operation) {
      onQueued(profileId);
      return coordinator.runCanonical(profileId, operation);
    },
  };
}

function createTestCoordinatedRunner(runner) {
  if (typeof runner.beginAutomationAlreadyCoordinated === "function") return runner;
  return {
    ...runner,
    async beginAutomationAlreadyCoordinated(profile, mode) {
      if (mode === "loop") {
        const started = await runner.startLoop(profile);
        return {
          confirmStartup: async () => started,
          waitForExit: async () => started,
        };
      }
      if (typeof runner.beginRunOnce === "function") {
        return runner.beginRunOnce(profile, mode);
      }
      return {
        waitForExit: async () => runner.runOnce(profile, mode),
      };
    },
  };
}

async function rawGet(port, pathname, headers = {}) {
  return await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end();
  });
}

async function assertOneShotSettingsCanSaveBeforeExit(t, action) {
  const dir = await mkdtemp(path.join(tmpdir(), `xjskp-one-shot-settings-${action}-`));
  const worker = new EventEmitter();
  worker.threadId = action === "once" ? 93 : 94;
  worker.pid = process.pid;
  worker.terminate = async () => {
    setImmediate(() => worker.emit("exit", 1));
    return 1;
  };
  let notifyTaskRegistered;
  const taskRegistered = new Promise((resolve) => {
    notifyTaskRegistered = resolve;
  });
  let exited = false;
  let server = null;
  t.after(async () => {
    if (!exited) worker.emit("exit", 1);
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const profileStore = createProfileStore({
    accountsDir: path.join(dir, "runtime", "accounts"),
    protect: (value) => `p:${value}`,
    unprotect: (value) => value.slice(2),
  });
  await profileStore.importProfile({
    id: "main",
    credentials: {
      CTOKEN: "ct",
      PC_USER_ID: "main",
      PC_TOKEN: "pc",
      BABI_TOKEN: "babi",
      OPEN_ID: "open",
    },
  });
  await profileStore.markValidated("main", undefined, { serverIdx: 726 });
  server = createSystemServer({
    profileStore,
    rootDir: dir,
    localRequestToken: "test-local-token",
    startupConfirmMs: 0,
    runnerOptions: {
      processProvider: async () => [{
        ProcessId: process.pid,
        Name: "node.exe",
        CommandLine: "node work/system/server.mjs",
      }],
      workerFactory() {
        return worker;
      },
      async writeActiveTaskFn(runtimeDir, task) {
        const record = await writeActiveTask(runtimeDir, task);
        notifyTaskRegistered();
        return record;
      },
    },
  });
  await server.listen(0);
  const base = `http://127.0.0.1:${server.port}`;
  const oneShot = postJsonResponse(`${base}/api/profiles/main/${action}`, {});
  await taskRegistered;

  const beforeSave = await (await fetch(`${base}/api/runtime`)).json();
  assert.equal(beforeSave.runningCount, 1);
  assert.equal(beforeSave.activeByProfile.main?.mode, action === "validate" ? "orders" : action);
  const saved = await postJsonResponse(`${base}/api/profiles/main/settings`, { pearlHireItemReserveCount: 20 });
  assert.equal(saved.status, 200);
  assert.equal(
    JSON.parse(await fsPromises.readFile(path.join(dir, "runtime", "settings", "main.json"), "utf8")).pearlHireItemReserveCount,
    20,
  );
  const whilePending = await (await fetch(`${base}/api/runtime`)).json();
  assert.equal(whilePending.runningCount, 1);
  assert.equal(whilePending.activeByProfile.main?.mode, action === "validate" ? "orders" : action);

  exited = true;
  worker.emit("exit", 0);
  const completed = await oneShot;
  assert.equal(completed.status, action === "validate" ? 422 : 200);
  assert.equal(action === "validate" ? completed.json.result.exitCode : completed.json.exitCode, 0);
}

async function writeRuntimeSettingsWithFixedTmp(fileSystem, runtimeDir, settings) {
  const settingsDir = path.join(runtimeDir, "settings");
  const settingsPath = path.join(settingsDir, "main.json");
  const tmpPath = `${settingsPath}.tmp`;
  await fileSystem.mkdir(settingsDir, { recursive: true });
  await fileSystem.writeFile(tmpPath, `${JSON.stringify(settings)}\n`, "utf8");
  await fileSystem.rename(tmpPath, settingsPath);
}
