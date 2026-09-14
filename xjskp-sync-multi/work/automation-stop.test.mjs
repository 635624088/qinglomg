import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearAutomationStopRequest,
  readAutomationStopRequest,
  writeAutomationStopRequest,
} from "./automation-stop.mjs";
import {
  createTeamOrderArchive,
  createTeamOrderRunId,
} from "./team-order-archive.mjs";
import { runGardenCycle } from "./inspect-garden-dryrun.mjs";
import * as automation from "./inspect-garden-dryrun.mjs";

test("stop request is profile scoped and cleared before the next start", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-stop-"));
  try {
    const p1Path = path.join(dir, "p1-stop.json");
    const p2Path = path.join(dir, "p2-stop.json");
    await writeAutomationStopRequest(p1Path, "user-stop");
    assert.equal((await readAutomationStopRequest(p1Path)).reason, "user-stop");
    assert.equal(await readAutomationStopRequest(p2Path), null);
    await clearAutomationStopRequest(p1Path);
    assert.equal(await readAutomationStopRequest(p1Path), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("stop request persists only the stop contract and malformed data fails closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-stop-invalid-"));
  const stopPath = path.join(dir, "main", "team-order-stop.json");
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await writeAutomationStopRequest(stopPath, "user-stop");
    const raw = JSON.parse(await fs.readFile(stopPath, "utf8"));
    assert.deepEqual(Object.keys(raw).sort(), ["profileId", "reason", "requestedAt"]);
    assert.equal(raw.profileId, "main");
    assert.equal(typeof raw.requestedAt, "string");

    await fs.writeFile(stopPath, "{broken", "utf8");
    const malformed = await readAutomationStopRequest(stopPath);
    assert.equal(malformed.reason, "invalid-stop-request");
    assert.equal(malformed.profileId, "main");
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalConsoleError;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("an aborted garden cycle rejects before issuing another request", async () => {
  const controller = new AbortController();
  controller.abort("user-stop");
  let requestCount = 0;
  const ws = {
    async request() {
      requestCount++;
      return { d: {}, n: "test" };
    },
  };

  await assert.rejects(
    () => runGardenCycle(ws, "gs-token", {}, 1, { signal: controller.signal }),
    (error) => error?.reason === "user-stopped" && /用户停止/.test(error.message),
  );
  assert.equal(requestCount, 0);
});

test("heartbeat wait aborts immediately and issues no request after stop", async () => {
  const controller = new AbortController();
  let requestCount = 0;
  let waitStarted;
  const started = new Promise((resolve) => {
    waitStarted = resolve;
  });
  const waiting = automation.waitWithOnlineHeartTick(
    {
      async request() {
        requestCount++;
        return {};
      },
    },
    "gs-token",
    {},
    60_000,
    {
      signal: controller.signal,
      waitFn: async () => {
        waitStarted();
        await new Promise(() => {});
      },
      statusRefreshIntervalMs: 0,
      assetSyncIntervalMs: 0,
    },
  );

  await started;
  const requestCountAtStop = requestCount;
  controller.abort("user-stop");
  const outcome = await Promise.race([
    waiting.then(
      () => ({ kind: "resolved" }),
      (error) => ({ kind: "rejected", error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 100)),
  ]);

  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.error.reason, "user-stopped");
  assert.equal(requestCount, requestCountAtStop);
});

test("GS bootstrap stop between connect and login prevents the adjacent request", async () => {
  assert.equal(typeof automation.openGameWsSession, "function");
  const controller = new AbortController();
  let requestCount = 0;
  const ws = {
    async connect() {
      controller.abort("user-stop");
    },
    async request() {
      requestCount++;
      return {};
    },
  };

  await assert.rejects(
    () => automation.openGameWsSession(
      { host: "test.invalid", port_ssl: 443 },
      { token: "not-a-real-token" },
      null,
      {
        signal: controller.signal,
        wsFactory: () => ws,
      },
    ),
    (error) => error?.reason === "user-stopped",
  );
  assert.equal(requestCount, 0);
});

test("GS bootstrap abort wakes a pending connection request", async () => {
  const controller = new AbortController();
  let connectStarted;
  const started = new Promise((resolve) => {
    connectStarted = resolve;
  });
  const opening = automation.openGameWsSession(
    { host: "test.invalid", port_ssl: 443 },
    { token: "not-a-real-token" },
    null,
    {
      signal: controller.signal,
      wsFactory: () => ({
        async connect() {
          connectStarted();
          await new Promise(() => {});
        },
        async request() {
          throw new Error("login request must not start");
        },
        close() {},
      }),
    },
  );

  await started;
  controller.abort("user-stop");
  const outcome = await Promise.race([
    opening.then(
      () => ({ kind: "resolved" }),
      (error) => ({ kind: "rejected", error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 100)),
  ]);

  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.error.reason, "user-stopped");
});

test("a stop raised by the first reconnect attempt prevents the second attempt", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const reopening = automation.reopenGameWsSessionWithRetry({
    ws: { close() {} },
    gsInfo: {},
    gsLoginArg: {},
    syncValue: {},
    signal: controller.signal,
    openSession: async () => {
      attempts++;
      controller.abort("user-stop");
      throw new Error("controlled reconnect failure");
    },
  });

  const outcome = await Promise.race([
    reopening.then(
      () => ({ kind: "resolved" }),
      (error) => ({ kind: "rejected", error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 100)),
  ]);

  assert.equal(outcome.kind, "rejected");
  assert.equal(outcome.error.reason, "user-stopped");
  assert.equal(attempts, 1);
});

test("user stop finalization writes real status and team archive artifacts after flush", async () => {
  assert.equal(typeof automation.finalizeUserStopped, "function");
  assert.equal(typeof automation.createTeamOrderSessionRuntime, "function");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-user-stopped-artifacts-"));
  const previousEnv = Object.fromEntries(
    ["STATUS_DOC_DIR", "STATUS_JSON_PATH", "STATUS_HTML_PATH", "STATUS_MD_PATH", "PROFILE_ID"]
      .map((key) => [key, process.env[key]]),
  );
  const jsonPath = path.join(dir, "garden-status.json");
  const htmlPath = path.join(dir, "garden-status.html");
  const mdPath = path.join(dir, "garden-status.md");
  const archiveCalls = {
    instances: 0,
    commit: 0,
  };
  try {
    process.env.STATUS_DOC_DIR = dir;
    process.env.STATUS_JSON_PATH = jsonPath;
    process.env.STATUS_HTML_PATH = htmlPath;
    process.env.STATUS_MD_PATH = mdPath;
    process.env.PROFILE_ID = "main";
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
      $usrTot: {
        data: {
          id: "uid-main",
          bag: { 23_001: 15 },
        },
      },
    };
    const runtime = automation.createTeamOrderSessionRuntime(syncValue, {
      profileId: "main",
      statusDir: dir,
      teamOrderConfig: {
        durationSeconds: 50,
        maxOrderNum: 160,
        refreshPerSecond: 4,
        orders: new Map([[1, { orderNum: 1, flowerNum: 15 }]]),
      },
      createTeamOrderArchive(options) {
        archiveCalls.instances++;
        const archive = createTeamOrderArchive(options);
        return {
          commit(value) {
            archiveCalls.commit++;
            return archive.commit(value);
          },
        };
      },
    });

    await automation.finalizeUserStopped(syncValue, runtime, { cycle: 7 });

    const statusJson = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    const statusHtml = await fs.readFile(htmlPath, "utf8");
    assert.equal(statusJson.summary.automationStopped.reason, "user-stopped");
    assert.match(statusHtml, /用户停止/);
    assert.deepEqual(archiveCalls, {
      instances: 1,
      commit: 1,
    });

    const archiveDir = path.join(dir, "team-orders");
    const archiveNames = (await fs.readdir(archiveDir)).filter((name) => name.endsWith(".json"));
    assert.equal(archiveNames.length, 1);
    const ledger = JSON.parse(await fs.readFile(path.join(archiveDir, archiveNames[0]), "utf8"));
    const expectedRunId = createTeamOrderRunId({
      profileId: "main",
      uid: "uid-main",
      startTime,
      activeTime,
    });
    assert.equal(archiveNames[0], `${expectedRunId}.json`);
    assert.equal(ledger.runId, expectedRunId);
    assert.equal(ledger.finalStatus, "user-stopped");
    assert.equal(ledger.stopReason, "用户停止");
    assert.equal(ledger.events.at(-1).reason, "user-stopped");
    assert.equal(ledger.events.at(-1).message, "用户停止");
    const archiveHtml = await fs.readFile(path.join(archiveDir, ledger.htmlFile), "utf8");
    assert.match(archiveHtml, /用户停止/);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("finalizer does not append or finish the same user-stopped run twice", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-user-stop-idempotent-"));
  const previousEnv = Object.fromEntries(
    ["STATUS_DOC_DIR", "STATUS_JSON_PATH", "STATUS_HTML_PATH", "STATUS_MD_PATH", "PROFILE_ID"]
      .map((key) => [key, process.env[key]]),
  );
  const archiveCalls = {
    instances: 0,
    commit: 0,
  };
  const startTime = 1_800_000_000_000;
  const createdTime = 1_800_000_000_125;
  const expectedRunId = createTeamOrderRunId({
    profileId: "main",
    uid: "uid-main",
    startTime,
  });
  const syncValue = {
    orderTeamTot: {
      orderTeam: {
        status: 2,
        startTime,
        activeTime: "",
        createdTime,
        orderNum: 1,
        flowerId: 23_001,
      },
    },
    $usrTot: {
      data: {
        id: "uid-main",
        bag: { 23_001: 15 },
      },
    },
  };
  try {
    process.env.STATUS_DOC_DIR = dir;
    process.env.STATUS_JSON_PATH = path.join(dir, "garden-status.json");
    process.env.STATUS_HTML_PATH = path.join(dir, "garden-status.html");
    process.env.STATUS_MD_PATH = path.join(dir, "garden-status.md");
    process.env.PROFILE_ID = "main";
    const runtime = automation.createTeamOrderSessionRuntime(syncValue, {
      profileId: "main",
      statusDir: dir,
      teamOrderConfig: {
        durationSeconds: 50,
        maxOrderNum: 160,
        refreshPerSecond: 4,
        orders: new Map([[1, { orderNum: 1, flowerNum: 15 }]]),
      },
      createTeamOrderArchive(options) {
        archiveCalls.instances++;
        const archive = createTeamOrderArchive(options);
        return {
          commit(value) {
            archiveCalls.commit++;
            return archive.commit(value);
          },
        };
      },
    });

    runtime.requestStop("user-stop");
    const stopped = await runtime.handle(syncValue, {
      trigger: "cycle",
      config: runtime.config,
      capability: { ready: true },
      experienceGuard: { blocked: false },
    });
    assert.equal(stopped.finalReason, "user-stop");

    await automation.finalizeUserStopped(syncValue, runtime, { cycle: 7 });

    assert.deepEqual(archiveCalls, {
      instances: 1,
      commit: 1,
    });
    const archiveDir = path.join(dir, "team-orders");
    const archiveNames = (await fs.readdir(archiveDir)).filter((name) => name.endsWith(".json"));
    assert.deepEqual(archiveNames, [`${expectedRunId}.json`]);
    const ledger = JSON.parse(await fs.readFile(path.join(archiveDir, archiveNames[0]), "utf8"));
    assert.equal(ledger.runId, expectedRunId);
    assert.equal(ledger.finalStatus, "user-stopped");
    assert.equal(ledger.events.filter((event) => event.reason === "user-stopped").length, 1);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("finalizer does not pollute an already completed team-order ledger", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-completed-stop-idempotent-"));
  const previousEnv = Object.fromEntries(
    ["STATUS_DOC_DIR", "STATUS_JSON_PATH", "STATUS_HTML_PATH", "STATUS_MD_PATH", "PROFILE_ID"]
      .map((key) => [key, process.env[key]]),
  );
  const archiveCalls = {
    instances: 0,
    commit: 0,
  };
  const startTime = 1_800_000_000_000;
  const activeTime = 1_800_000_000_125;
  const expectedRunId = createTeamOrderRunId({
    profileId: "main",
    uid: "uid-main",
    startTime,
  });
  const syncValue = {
    orderTeamTot: {
      orderTeam: {
        status: 2,
        startTime,
        activeTime,
        orderNum: 161,
        flowerId: 23_001,
      },
    },
    $usrTot: {
      data: {
        id: "uid-main",
        bag: {},
      },
    },
  };
  try {
    process.env.STATUS_DOC_DIR = dir;
    process.env.STATUS_JSON_PATH = path.join(dir, "garden-status.json");
    process.env.STATUS_HTML_PATH = path.join(dir, "garden-status.html");
    process.env.STATUS_MD_PATH = path.join(dir, "garden-status.md");
    process.env.PROFILE_ID = "main";
    const runtime = automation.createTeamOrderSessionRuntime(syncValue, {
      profileId: "main",
      statusDir: dir,
      teamOrderConfig: {
        durationSeconds: 50,
        maxOrderNum: 160,
        refreshPerSecond: 4,
        orders: new Map(),
      },
      createTeamOrderArchive(options) {
        archiveCalls.instances++;
        const archive = createTeamOrderArchive(options);
        return {
          commit(value) {
            archiveCalls.commit++;
            return archive.commit(value);
          },
        };
      },
    });

    const completed = await runtime.handle(syncValue, {
      trigger: "cycle",
      config: runtime.config,
      capability: { ready: true },
      experienceGuard: { blocked: false },
    });
    assert.equal(completed.finalReason, "order-max-reached");
    const callsAfterCompletion = { ...archiveCalls };

    await automation.finalizeUserStopped(syncValue, runtime, { cycle: 7 });

    assert.deepEqual(archiveCalls, callsAfterCompletion);
    assert.deepEqual(callsAfterCompletion, {
      instances: 1,
      commit: 1,
    });
    const archiveDir = path.join(dir, "team-orders");
    const archiveNames = (await fs.readdir(archiveDir)).filter((name) => name.endsWith(".json"));
    assert.deepEqual(archiveNames, [`${expectedRunId}.json`]);
    const ledger = JSON.parse(await fs.readFile(path.join(archiveDir, archiveNames[0]), "utf8"));
    assert.equal(ledger.runId, expectedRunId);
    assert.equal(ledger.finalStatus, "completed");
    assert.equal(ledger.events.some((event) => event.reason === "user-stopped"), false);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("finalizer retries a failed one-shot commit on the same wrapper", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-stop-finish-retry-"));
  const previousEnv = Object.fromEntries(
    ["STATUS_DOC_DIR", "STATUS_JSON_PATH", "STATUS_HTML_PATH", "STATUS_MD_PATH", "PROFILE_ID"]
      .map((key) => [key, process.env[key]]),
  );
  const archiveCalls = {
    instances: 0,
    commit: 0,
  };
  const expectedRunId = createTeamOrderRunId({
    profileId: "main",
    uid: "uid-main",
    startTime: 1_800_000_000_000,
  });
  const syncValue = {
    orderTeamTot: {
      orderTeam: {
        status: 2,
        startTime: 1_800_000_000_000,
        activeTime: 1_800_000_000_125,
        orderNum: 1,
        flowerId: 23_001,
      },
    },
    $usrTot: {
      data: {
        id: "uid-main",
        bag: { 23_001: 15 },
      },
    },
  };
  try {
    process.env.STATUS_DOC_DIR = dir;
    process.env.STATUS_JSON_PATH = path.join(dir, "garden-status.json");
    process.env.STATUS_HTML_PATH = path.join(dir, "garden-status.html");
    process.env.STATUS_MD_PATH = path.join(dir, "garden-status.md");
    process.env.PROFILE_ID = "main";
    const runtime = automation.createTeamOrderSessionRuntime(syncValue, {
      profileId: "main",
      statusDir: dir,
      teamOrderConfig: {
        durationSeconds: 50,
        maxOrderNum: 160,
        refreshPerSecond: 4,
        orders: new Map([[1, { orderNum: 1, flowerNum: 15 }]]),
      },
      createTeamOrderArchive(options) {
        archiveCalls.instances++;
        const archive = createTeamOrderArchive(options);
        return {
          commit(value) {
            archiveCalls.commit++;
            if (archiveCalls.commit === 1) {
              throw new Error("controlled first commit failure");
            }
            return archive.commit(value);
          },
        };
      },
    });

    runtime.requestStop("user-stop");
    const stopped = await runtime.handle(syncValue, {
      trigger: "cycle",
      config: runtime.config,
      capability: { ready: true },
      experienceGuard: { blocked: false },
    });
    assert.equal(stopped.finalReason, "user-stop");
    assert.deepEqual(archiveCalls, {
      instances: 1,
      commit: 1,
    });

    await automation.finalizeUserStopped(syncValue, runtime, { cycle: 7 });

    assert.deepEqual(archiveCalls, {
      instances: 1,
      commit: 2,
    });
    const archiveDir = path.join(dir, "team-orders");
    const archiveNames = (await fs.readdir(archiveDir)).filter((name) => name.endsWith(".json"));
    assert.deepEqual(archiveNames, [`${expectedRunId}.json`]);
    const ledger = JSON.parse(await fs.readFile(path.join(archiveDir, archiveNames[0]), "utf8"));
    assert.equal(ledger.runId, expectedRunId);
    assert.equal(ledger.finalStatus, "user-stopped");
    assert.equal(ledger.events.filter((event) => event.reason === "user-stopped").length, 1);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("stored-order-only identity remains idempotent after stop finalization", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-stored-stop-idempotent-"));
  const previousEnv = Object.fromEntries(
    ["STATUS_DOC_DIR", "STATUS_JSON_PATH", "STATUS_HTML_PATH", "STATUS_MD_PATH", "PROFILE_ID"]
      .map((key) => [key, process.env[key]]),
  );
  const archiveCalls = {
    instances: 0,
    commit: 0,
  };
  const expectedRunId = createTeamOrderRunId({
    profileId: "main",
    uid: "uid-main",
    startTime: 1_800_000_000_000,
  });
  const syncValue = {
    orderTeamTot: {
      orderTeam: {
        status: 0,
        storedOrders: [{
          npcId: 1,
          expireTime: 1_900_000_000_000,
          startTime: 1_800_000_000_000,
          activeTime: 1_800_000_000_125,
        }],
      },
    },
    $usrTot: {
      data: {
        id: "uid-main",
        bag: {},
      },
    },
  };
  try {
    process.env.STATUS_DOC_DIR = dir;
    process.env.STATUS_JSON_PATH = path.join(dir, "garden-status.json");
    process.env.STATUS_HTML_PATH = path.join(dir, "garden-status.html");
    process.env.STATUS_MD_PATH = path.join(dir, "garden-status.md");
    process.env.PROFILE_ID = "main";
    const runtime = automation.createTeamOrderSessionRuntime(syncValue, {
      profileId: "main",
      statusDir: dir,
      teamOrderConfig: {
        durationSeconds: 50,
        maxOrderNum: 160,
        refreshPerSecond: 4,
        orders: new Map(),
      },
      createTeamOrderArchive(options) {
        archiveCalls.instances++;
        const archive = createTeamOrderArchive(options);
        return {
          commit(value) {
            archiveCalls.commit++;
            return archive.commit(value);
          },
        };
      },
    });

    runtime.requestStop("user-stop");
    const stopped = await runtime.handle(syncValue, {
      trigger: "cycle",
      config: runtime.config,
      capability: { ready: true },
      experienceGuard: { blocked: false },
    });
    assert.equal(stopped.finalReason, "user-stop");

    await automation.finalizeUserStopped(syncValue, runtime, { cycle: 7 });

    assert.deepEqual(archiveCalls, {
      instances: 1,
      commit: 1,
    });
    const archiveDir = path.join(dir, "team-orders");
    const archiveNames = (await fs.readdir(archiveDir)).filter((name) => name.endsWith(".json"));
    assert.deepEqual(archiveNames, [`${expectedRunId}.json`]);
    const ledger = JSON.parse(await fs.readFile(path.join(archiveDir, archiveNames[0]), "utf8"));
    assert.equal(ledger.runId, expectedRunId);
    assert.equal(ledger.finalStatus, "user-stopped");
    assert.equal(ledger.events.filter((event) => event.reason === "user-stopped").length, 1);
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("session archive lifecycle retains only the current identity across repeated rotations", async () => {
  const archiveCalls = {
    instances: 0,
    commit: 0,
  };
  const syncForIdentity = (index) => ({
    orderTeamTot: {
      orderTeam: {
        status: 2,
        startTime: 1_800_000_000_000 + index * 1_000,
        activeTime: 1_800_000_000_125 + index * 1_000,
        orderNum: 161,
        flowerId: 23_001,
      },
    },
    $usrTot: {
      data: {
        id: "uid-main",
        bag: {},
      },
    },
  });
  const syncValues = Array.from({ length: 6 }, (_, index) => syncForIdentity(index));
  const runtime = automation.createTeamOrderSessionRuntime(syncValues[0], {
    profileId: "main",
    teamOrderConfig: {
      durationSeconds: 50,
      maxOrderNum: 160,
      refreshPerSecond: 4,
      orders: new Map(),
    },
    createTeamOrderArchive() {
      archiveCalls.instances++;
      return {
        async commit() {
          archiveCalls.commit++;
        },
      };
    },
  });

  for (const syncValue of syncValues) {
    const completed = await runtime.handle(syncValue, {
      trigger: "cycle",
      config: runtime.config,
      capability: { ready: true },
      experienceGuard: { blocked: false },
    });
    assert.equal(completed.finalReason, "order-max-reached");
  }

  assert.deepEqual(archiveCalls, {
    instances: 6,
    commit: 6,
  });
  assert.deepEqual(runtime.archiveLifecycleState(), {
    activeIdentityCount: 1,
    pendingFinishCompensationCount: 0,
    retainedArchiveStateCount: 1,
  });

  await runtime.handle(syncValues[0], {
    trigger: "cycle",
    config: runtime.config,
    capability: { ready: true },
    experienceGuard: { blocked: false },
  });
  assert.deepEqual(archiveCalls, {
    instances: 7,
    commit: 7,
  });
});

test("active/create time differences cannot split one stable challenge identity", async () => {
  const archiveCalls = {
    instances: 0,
    commit: [],
  };
  const startTime = 1_800_000_000_000;
  const collidingTime = 1_800_000_000_125;
  const completedSync = {
    orderTeamTot: {
      orderTeam: {
        status: 2,
        startTime,
        activeTime: collidingTime,
        createdTime: 1_800_000_000_050,
        orderNum: 161,
        flowerId: 23_001,
      },
    },
    $usrTot: {
      data: {
        id: "uid-main",
        bag: {},
      },
    },
  };
  const newSyncWithSameRunId = {
    orderTeamTot: {
      orderTeam: {
        status: 2,
        startTime,
        activeTime: "",
        createdTime: collidingTime,
        orderNum: 1,
        flowerId: 23_001,
      },
    },
    $usrTot: {
      data: {
        id: "uid-main",
        bag: { 23_001: 15 },
      },
    },
  };
  const completedRunId = createTeamOrderRunId({
    profileId: "main",
    uid: "uid-main",
    startTime,
    activeTime: collidingTime,
    createdTime: 1_800_000_000_050,
  });
  const newRunId = createTeamOrderRunId({
    profileId: "main",
    uid: "uid-main",
    startTime,
    activeTime: null,
    createdTime: collidingTime,
  });
  assert.equal(newRunId, completedRunId);

  const runtime = automation.createTeamOrderSessionRuntime(completedSync, {
    profileId: "main",
    teamOrderConfig: {
      durationSeconds: 50,
      maxOrderNum: 160,
      refreshPerSecond: 4,
      orders: new Map([[1, { orderNum: 1, flowerNum: 15 }]]),
    },
    createTeamOrderArchive() {
      const wrapperId = ++archiveCalls.instances;
      return {
        async commit(value) {
          archiveCalls.commit.push({
            wrapperId,
            reason: value.result.stopReason,
            finalStatus: value.result.finalStatus,
          });
        },
      };
    },
  });

  const completed = await runtime.handle(completedSync, {
    trigger: "cycle",
    config: runtime.config,
    capability: { ready: true },
    experienceGuard: { blocked: false },
  });
  assert.equal(completed.finalReason, "order-max-reached");

  await runtime.finalizeUserStop(newSyncWithSameRunId);

  assert.equal(archiveCalls.instances, 1);
  assert.deepEqual(archiveCalls.commit, [
    { wrapperId: 1, reason: "order-max-reached", finalStatus: "completed" },
  ]);
  assert.deepEqual(runtime.archiveLifecycleState(), {
    activeIdentityCount: 1,
    pendingFinishCompensationCount: 0,
    retainedArchiveStateCount: 1,
  });
});

test("finalizer retries every retained one-shot commit after consecutive failures", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "automation-stop-ledger-recovery-"));
  const commitAttempts = Object.create(null);
  const archiveCalls = {
    commit: [],
  };
  const syncForIdentity = (index) => ({
    orderTeamTot: {
      orderTeam: {
        status: 2,
        startTime: 1_800_000_000_000 + index * 1_000,
        activeTime: 1_800_000_000_125 + index * 1_000,
        orderNum: 1,
        flowerId: 23_001,
      },
    },
    $usrTot: {
      data: {
        id: "uid-main",
        bag: { 23_001: 15 },
      },
    },
  });
  const syncValues = [0, 1, 2].map(syncForIdentity);
  const runIds = syncValues.map((syncValue) => createTeamOrderRunId({
    profileId: "main",
    uid: "uid-main",
    startTime: syncValue.orderTeamTot.orderTeam.startTime,
    activeTime: syncValue.orderTeamTot.orderTeam.activeTime,
  }));
  const [runA, runB, runC] = runIds;

  try {
    const runtime = automation.createTeamOrderSessionRuntime(syncValues[0], {
      profileId: "main",
      statusDir: dir,
      teamOrderConfig: {
        durationSeconds: 50,
        maxOrderNum: 160,
        refreshPerSecond: 4,
        orders: new Map([[1, { orderNum: 1, flowerNum: 15 }]]),
      },
      createTeamOrderArchive(options) {
        const archive = createTeamOrderArchive(options);
        return {
          commit(value) {
            const attempt = (commitAttempts[options.runId] || 0) + 1;
            commitAttempts[options.runId] = attempt;
            archiveCalls.commit.push({ runId: options.runId, attempt });
            if (
              attempt === 1
              || (options.runId === runB && attempt === 2)
            ) {
              throw new Error(`controlled commit failure ${options.runId}:${attempt}`);
            }
            return archive.commit(value);
          },
        };
      },
    });

    runtime.requestStop("user-stop");
    for (const syncValue of syncValues.slice(0, 2)) {
      const stopped = await runtime.handle(syncValue, {
        trigger: "cycle",
        config: runtime.config,
        capability: { ready: true },
        experienceGuard: { blocked: false },
      });
      assert.equal(stopped.finalReason, "user-stop");
    }

    await runtime.finalizeUserStop(syncValues[2]);

    assert.deepEqual(
      runIds.map((runId) => commitAttempts[runId]),
      [2, 3, 2],
    );
    assert.equal(
      archiveCalls.commit.some(({ runId, attempt }) => runId === runC && attempt === 1),
      true,
    );

    const ledgers = await Promise.all(runIds.map(async (runId) => JSON.parse(
      await fs.readFile(path.join(dir, "team-orders", `${runId}.json`), "utf8"),
    )));
    for (const ledger of ledgers) {
      assert.equal(ledger.finalStatus, "user-stopped");
      assert.equal(ledger.stopReason, "用户停止");
      assert.equal(typeof ledger.finishedAt, "string");
      assert.equal(
        ledger.events.filter((event) => event.reason === "user-stopped").length,
        1,
      );
    }
    assert.deepEqual(runtime.archiveLifecycleState(), {
      activeIdentityCount: 1,
      pendingFinishCompensationCount: 0,
      retainedArchiveStateCount: 1,
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
