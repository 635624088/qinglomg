import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDesiredRunStore } from "./system/automation-recovery.mjs";
import { createProfileStore } from "./system/profile-store.mjs";
import { createSystemServer } from "./system/server.mjs";

const TOKEN = "test-local-token";

test("T5 server exposes protocol v2 and rejects missing CAS before reading the body", async (t) => {
  const fixture = await createFixture(t);

  const session = await fetchJson(`${fixture.base}/api/session`);
  assert.equal(session.status, 200);
  assert.equal(session.json.settingsProtocolVersion, 2);

  const response = await postIncompleteBodyWithoutPrecondition(fixture.port);
  assert.equal(response.status, 428);
  assert.equal(response.json.error, "PROFILE_SETTINGS_PRECONDITION_REQUIRED");
  assert.equal(response.json.settingsProtocolVersion, 2);
  assert.equal(response.json.commitState, "not-applied");
});

test("T5 settings GET/POST use the committed v2 snapshot contract", async (t) => {
  const fixture = await createFixture(t, { importProfile: true });

  const before = await fetchJson(`${fixture.base}/api/profiles/main/settings`);
  assert.equal(before.status, 200);
  assert.equal(before.json.settingsProtocolVersion, 2);
  assert.equal(before.json.runtimeSyncStatus, "synced");

  const transactionId = "00000000-0000-4000-8000-000000000501";
  const changed = await fetchJson(`${fixture.base}/api/profiles/main/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-xjskp-session-token": TOKEN,
      "x-xjskp-settings-transaction-id": transactionId,
      "if-match": `"${before.json.settingsEpoch}:${before.json.settingsRevision}"`,
    },
    body: JSON.stringify({ teamOrderTriggerProtectionEnabled: false }),
  });

  assert.equal(changed.status, 200);
  assert.equal(changed.json.settingsProtocolVersion, 2);
  assert.equal(changed.json.transactionId, transactionId);
  assert.equal(changed.json.commitState, "committed");
  assert.equal(changed.json.settings.teamOrderTriggerProtectionEnabled, false);
  assert.equal(changed.json.settingsRevision, before.json.settingsRevision + 1);
});

test("T5 rejects non-canonical profile routes before profile access", async (t) => {
  const fixture = await createFixture(t, { importProfile: true });
  const response = await fetchJson(`${fixture.base}/api/profiles/MAIN/settings`);
  assert.equal(response.status, 400);
  assert.equal(response.json.error, "INVALID_PROFILE_ID_CANONICAL_FORM");
});

test("T5 profile summaries use committed snapshots and import rejects settings", async (t) => {
  const fixture = await createFixture(t, { importProfile: true });
  const listed = await fetchJson(`${fixture.base}/api/profiles`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.settingsProtocolVersion, 2);
  assert.equal(listed.json.profiles[0].settingsRevision, 0);
  assert.equal(listed.json.profiles[0].runtimeSyncStatus, "synced");

  const rejected = await fetchJson(`${fixture.base}/api/profiles/import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-xjskp-session-token": TOKEN,
    },
    body: JSON.stringify({ id: "other", settings: { pearlHireItemReserveCount: 20 } }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.json.error, "PROFILE_SETTINGS_IMPORT_NOT_SUPPORTED");
});

test("T5 profiles isolates a canonical collision without exposing a candidate snapshot", async (t) => {
  const fixture = await createFixture(t, {
    importProfile: true,
    profileId: "a-b",
    beforeListen: async ({ runtimeDir }) => {
      const dir = path.join(runtimeDir, "system", "desired-runs");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "a-b.json"), JSON.stringify({
        version: 1,
        profileId: "a-b",
        mode: "loop",
        desiredState: "stopped",
        restartAttempt: 0,
        recoveryStatus: "stopped",
        nextRetryAt: null,
        lastReason: null,
        updatedAt: "2026-08-11T00:00:00.000Z",
      }));
      await writeFile(path.join(dir, "a--b.json"), JSON.stringify({
        version: 1,
        profileId: "a--b",
        mode: "loop",
        desiredState: "running",
        restartAttempt: 0,
        recoveryStatus: "running",
        nextRetryAt: null,
        lastReason: null,
        updatedAt: "2026-08-11T00:00:01.000Z",
      }));
    },
  });

  const listed = await fetchJson(`${fixture.base}/api/profiles`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.profiles.length, 1);
  assert.equal(listed.json.profiles[0].settingsStateError, "PROFILE_ID_CANONICAL_COLLISION");
  assert.equal(Object.hasOwn(listed.json.profiles[0], "settings"), false);
  assert.equal(Object.hasOwn(listed.json.profiles[0], "settingsEpoch"), false);

  const settings = await fetchJson(`${fixture.base}/api/profiles/a-b/settings`);
  assert.equal(settings.status, 409);
  assert.equal(settings.json.error, "PROFILE_ID_CANONICAL_COLLISION");
  assert.equal(Object.hasOwn(settings.json, "settings"), false);
});

test("T5 manual loop and one-shot routes use the coordinated runner path", async (t) => {
  const fixture = await createFixture(t, { importProfile: true, validated: true });

  const loop = await fetchJson(`${fixture.base}/api/profiles/main/start`, mutation({}));
  const once = await fetchJson(`${fixture.base}/api/profiles/main/once`, mutation({}));
  const orders = await fetchJson(`${fixture.base}/api/profiles/main/orders`, mutation({}));

  assert.equal(loop.status, 200);
  assert.equal(once.status, 200);
  assert.equal(orders.status, 200);
  assert.deepEqual(fixture.coordinatedStarts.map((entry) => entry.mode), ["loop", "once", "orders"]);
  assert.equal(fixture.coordinatedStarts[0].coordinationToken.settingsEpoch.length, 36);
  assert.equal(fixture.coordinatedStarts[1].coordinationToken, undefined);
});

test("T5 reset returns its profile only after the committed read barrier", async (t) => {
  const fixture = await createFixture(t, { importProfile: true });
  const response = await fetchJson(
    `${fixture.base}/api/profiles/main/reset`,
    mutation({}),
  );
  assert.equal(response.status, 200);
  assert.equal(response.json.settingsProtocolVersion, 2);
  assert.equal(response.json.profile.id, "main");
  assert.equal(response.json.profile.hasCredentials, false);
  assert.equal(typeof response.json.profile.settingsEpoch, "string");
  assert.equal(response.json.profile.settingsRevision, 0);
});

test("T5 bulk rejects one non-canonical id before any start", async (t) => {
  const fixture = await createFixture(t, { importProfile: true, validated: true });
  const response = await fetchJson(
    `${fixture.base}/api/profiles/bulk/start`,
    mutation({ profileIds: ["main", "MAIN"] }),
  );
  assert.equal(response.status, 400);
  assert.equal(response.json.error, "INVALID_PROFILE_ID_CANONICAL_FORM");
  assert.deepEqual(fixture.coordinatedStarts, []);
});

test("T5 default runner recovery is wired to the shared coordinated desired store", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-server-t5-recovery-"));
  let server = null;
  t.after(async () => {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const runtimeDir = path.join(dir, "runtime");
  const profileStore = createProfileStore({
    accountsDir: path.join(runtimeDir, "accounts"),
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
  const desiredRunStore = createDesiredRunStore({ runtimeDir });
  await desiredRunStore.write("main", {
    desiredState: "running",
    recoveryStatus: "running",
    restartAttempt: 0,
  });
  let workerStarts = 0;
  server = createSystemServer({
    rootDir: dir,
    runtimeDir,
    profileStore,
    desiredRunStore,
    localRequestToken: TOKEN,
    runnerOptions: {
      processProvider: async () => [],
      workerFactory() {
        workerStarts += 1;
        throw new Error("legacy desired intent must not start a worker");
      },
    },
  });
  await server.listen(0);

  const desired = await desiredRunStore.readForProtocol("main");
  assert.equal(desired.desiredState, "stopped");
  assert.equal(desired.recoveryStatus, "blocked");
  assert.equal(desired.lastReason, "settings-epoch-confirmation-required");
  assert.equal(workerStarts, 0);
});

async function createFixture(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-server-t5-"));
  let server = null;
  t.after(async () => {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const runtimeDir = path.join(dir, "runtime");
  const profileId = options.profileId || "main";
  const profileStore = createProfileStore({
    accountsDir: path.join(runtimeDir, "accounts"),
    protect: (value) => `p:${value}`,
    unprotect: (value) => value.slice(2),
  });
  if (options.importProfile) {
    await profileStore.importProfile({
      id: profileId,
      credentials: {
        CTOKEN: "ct",
        PC_USER_ID: profileId,
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
    });
    if (options.validated) {
      await profileStore.markValidated(profileId, undefined, { serverIdx: 726 });
    }
  }
  const coordinatedStarts = [];
  const runner = {
    runtime: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0 }),
    snapshot: async () => ({ activeTasks: [], activeByProfile: {}, runningCount: 0 }),
    restoreDesiredLoops: async () => ({ desired: 0, scheduled: 0 }),
    stop: async () => ({ stopped: false }),
    beginAutomationAlreadyCoordinated: async (profile, mode, startOptions = {}) => {
      coordinatedStarts.push({ profile, mode, coordinationToken: startOptions.coordinationToken });
      return {
      confirmStartup: async () => ({ started: true }),
      waitForExit: async () => ({ exitCode: 0 }),
      };
    },
  };
  server = createSystemServer({
    rootDir: dir,
    runtimeDir,
    profileStore,
    runner,
    localRequestToken: TOKEN,
  });
  await options.beforeListen?.({ dir, runtimeDir, profileStore });
  await server.listen(0);
  return {
    base: `http://127.0.0.1:${server.port}`,
    port: server.port,
    coordinatedStarts,
  };
}

function mutation(body) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-xjskp-session-token": TOKEN,
    },
    body: JSON.stringify(body),
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  return { status: response.status, json: await response.json() };
}

function postIncompleteBodyWithoutPrecondition(port) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/profiles/main/settings",
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/json",
        "content-length": "128",
        "x-xjskp-session-token": TOKEN,
      },
    });
    request.on("error", reject);
    request.on("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        request.destroy();
        resolve({
          status: response.statusCode,
          json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      });
    });
    request.write('{"partial":');
    setTimeout(() => {
      request.destroy(new Error("server read the request body before returning 428"));
    }, 1_000).unref();
  });
}
