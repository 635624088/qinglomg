import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  ACCOUNT_RUNTIME_ARTIFACT_REGISTRY,
  inventoryAccountRuntimeTargets,
} from "./system/account-runtime-artifacts.mjs";
import { createAccountResetService } from "./system/account-reset-service.mjs";
import { createProfileStore } from "./system/profile-store.mjs";
import { PROFILE_SETTINGS_CANONICAL_KEYS } from "./system/profile-settings-protocol.mjs";
import { createSystemServer } from "./system/server.mjs";

test("artifact registry stays tied to every current profile-indexed runtime source", async () => {
  const kinds = new Set(ACCOUNT_RUNTIME_ARTIFACT_REGISTRY.map((entry) => entry.kind));
  assert.deepEqual(kinds, new Set([
    "profile",
    "runtime-settings",
    "desired-run",
    "experience-guard",
    "waterwheel-bucket",
    "active-task",
    "last-exit",
    "status",
    "logs",
  ]));

  for (const entry of ACCOUNT_RUNTIME_ARTIFACT_REGISTRY) {
    for (const evidence of entry.evidence) {
      const source = await readFile(new URL(evidence.file, import.meta.url), "utf8");
      assert.match(source, new RegExp(evidence.pattern), `${entry.kind}: ${evidence.file}`);
    }
  }
});

test("all-target inventory uses the union of every store and retains artifact-only orphans", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-reset-inventory-"));
  const runtimeDir = path.join(rootDir, "runtime");
  try {
    await writeJson(path.join(runtimeDir, "accounts", "main.json"), { id: "main", secrets: {} });
    await writeJson(path.join(runtimeDir, "settings", "settings-only.json"), { enabled: true });
    await writeJson(path.join(runtimeDir, "system", "desired-runs", "desired-only.json"), {
      profileId: "desired-only",
      desiredState: "running",
    });
    await writeJson(path.join(runtimeDir, "system", "experience-guards", "guard-only.json"), {
      version: 1,
      profileId: "guard-only",
      stateRevision: 1,
      breached: true,
    });
    await writeJson(path.join(runtimeDir, "system", "active-tasks", "active-only.json"), {
      profileId: "active-only",
      pid: 1234,
    });
    await writeJson(path.join(runtimeDir, "system", "last-task-exits", "exit-only.json"), {
      profileId: "exit-only",
      reason: "error",
    });
    await mkdir(path.join(runtimeDir, "status", "status-only"), { recursive: true });
    await writeJson(path.join(runtimeDir, "status", "status-only", "team-order-stop.json"), { stop: true });
    await mkdir(path.join(runtimeDir, "logs", "logs-only"), { recursive: true });
    await writeJson(path.join(runtimeDir, "status", "game-version-status.json"), { version: "system-wide" });

    const inventory = await inventoryAccountRuntimeTargets({ runtimeDir });

    assert.equal(inventory.writable, true);
    assert.deepEqual(
      inventory.targets.map((target) => target.profileId),
      ["active-only", "desired-only", "exit-only", "guard-only", "logs-only", "main", "settings-only", "status-only"],
    );
    assert.equal(inventory.targets.find((target) => target.profileId === "main").profilePresent, true);
    assert.equal(inventory.targets.find((target) => target.profileId === "settings-only").profilePresent, false);
    assert.equal(inventory.targets.find((target) => target.profileId === "status-only").artifacts[0].kind, "status");
    assert.equal(inventory.targets.some((target) => target.profileId === "game-version-status"), false);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("inventory fails closed for canonical alias collisions and unowned legacy records", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-reset-collision-"));
  const runtimeDir = path.join(rootDir, "runtime");
  try {
    await writeJson(path.join(runtimeDir, "accounts", "main.json"), { id: "main", secrets: {} });
    await mkdir(path.join(runtimeDir, "status", "Main"), { recursive: true });
    await mkdir(path.join(runtimeDir, "system"), { recursive: true });
    await writeFile(path.join(runtimeDir, "system", "active-task.json"), "{broken", "utf8");

    const inventory = await inventoryAccountRuntimeTargets({ runtimeDir });

    assert.equal(inventory.writable, false);
    assert.equal(inventory.targets.find((target) => target.profileId === "main").collision, true);
    assert.ok(inventory.errors.some((error) => error.code === "ACCOUNT_RUNTIME_ARTIFACT_UNOWNED"));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("offline credential reset delegates to a Node service instead of deleting account files", async () => {
  const source = await readFile(new URL("./reset-system-accounts.ps1", import.meta.url), "utf8");
  const command = await readFile(new URL("../重置账号凭据.cmd", import.meta.url), "utf8");

  assert.match(source, /account-reset-cli\.mjs/i);
  assert.doesNotMatch(source, /Get-ChildItem[^\r\n]+accounts[^\r\n]+Remove-Item|runtime\\accounts[^\r\n]*Remove-Item/is);
  assert.match(command, /reset-system-accounts\.ps1" %\*/i);
});

test("online reset rejects an active profile without clearing credentials", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-reset-active-"));
  const runtimeDir = path.join(rootDir, "runtime");
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
  const runner = {
    async beginAutomationAlreadyCoordinated() {
      throw new Error("unexpected coordinated start in reset fixture");
    },
    async runtime() {
      return {
        active: { profileId: "main", pid: 1234 },
        activeTasks: [{ profileId: "main", pid: 1234 }],
        activeByProfile: { main: { profileId: "main", pid: 1234 } },
        runningCount: 1,
        legacyProcesses: [],
      };
    },
    async restoreDesiredLoops() {},
    async stop() {
      return { stopped: false };
    },
  };
  const server = createSystemServer({
    rootDir,
    runtimeDir,
    profileStore,
    runner,
    gameVersionScheduler: { start() {}, stop() {}, getStatus: () => null },
    localRequestToken: "reset-test-token",
  });
  try {
    await server.listen(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/profiles/main/reset`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xjskp-session-token": "reset-test-token",
      },
      body: "{}",
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.error, "PROFILE_RESET_REQUIRES_STOP");
    assert.equal((await profileStore.loadProfileEnv("main")).PC_TOKEN, "pc");
  } finally {
    await server.close().catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("online reset rejects persisted desired-running state without clearing credentials", async () => {
  const fixture = await createOnlineFixture("desired-running", {
    runtime: {
      active: null,
      activeTasks: [],
      activeByProfile: {},
      desiredRuns: [{ profileId: "main", desiredState: "running", recoveryStatus: "scheduled" }],
      recoveryByProfile: {
        main: { profileId: "main", desiredState: "running", recoveryStatus: "scheduled" },
      },
    },
  });
  try {
    await writeJson(path.join(fixture.runtimeDir, "system", "desired-runs", "main.json"), {
      profileId: "main",
      desiredState: "running",
      recoveryStatus: "scheduled",
    });
    const before = await readFile(fixture.accountPath, "utf8");
    const { response, body } = await postReset(fixture.server);

    assert.equal(response.status, 409);
    assert.equal(body.error, "PROFILE_RESET_REQUIRES_STOP");
    assert.equal(await readFile(fixture.accountPath, "utf8"), before);
  } finally {
    await fixture.cleanup();
  }
});

test("online stopped reset preserves profile settings identity and cleans runtime artifacts", async () => {
  const fixture = await createOnlineFixture("stopped");
  try {
    const before = JSON.parse(await readFile(fixture.accountPath, "utf8"));
    before.settings = Object.fromEntries(
      PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => [key, before.settings[key]]),
    );
    before.settingsEpoch = "11111111-1111-4111-8111-111111111111";
    before.settingsRevision = 9;
    before.settingsKeyRevisions = Object.fromEntries(
      PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => [key, 0]),
    );
    await writeJson(fixture.accountPath, before);
    await writeJson(path.join(fixture.runtimeDir, "settings", "main.json"), { autoPlantEnabled: true });
    await writeJson(path.join(fixture.runtimeDir, "system", "last-task-exits", "main.json"), {
      profileId: "main",
      reason: "user-stopped",
    });
    await writeJson(path.join(fixture.runtimeDir, "system", "waterwheel-buckets", "main.json"), {
      version: 1,
      profileId: "main",
      accountUid: "account-main",
      storedBucketCount: 1,
      nextGenerationAtMs: null,
      lastObservedAtMs: 0,
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
    await writeJson(path.join(fixture.runtimeDir, "status", "main", "garden-status.json"), { ok: true });
    await writeJson(path.join(fixture.runtimeDir, "logs", "main", "events.json"), { event: "old" });
    const experienceGuardPath = path.join(
      fixture.runtimeDir,
      "system",
      "experience-guards",
      "main.json",
    );
    await writeJson(experienceGuardPath, {
      version: 1,
      profileId: "main",
      stateRevision: 3,
      breached: true,
    });

    const { response, body } = await postReset(fixture.server);
    const after = JSON.parse(await readFile(fixture.accountPath, "utf8"));

    assert.equal(response.status, 200);
    assert.equal(body.resetState, "credentials-cleared");
    assert.ok(body.operationId);
    assert.equal(body.profile.id, "main");
    assert.equal(body.profile.hasCredentials, false);
    assert.deepEqual(after.settings, before.settings);
    assert.equal(after.settingsEpoch, "11111111-1111-4111-8111-111111111111");
    assert.equal(after.settingsRevision, 9);
    assert.deepEqual(after.settingsKeyRevisions, before.settingsKeyRevisions);
    assert.deepEqual(after.secrets, {});
    const rebuiltRuntimeSettings = JSON.parse(await readFile(
      path.join(fixture.runtimeDir, "settings", "main.json"),
      "utf8",
    ));
    assert.equal(
      rebuiltRuntimeSettings._meta.settingsEpoch,
      "11111111-1111-4111-8111-111111111111",
    );
    assert.equal(rebuiltRuntimeSettings._meta.settingsRevision, 9);
    assert.deepEqual(
      Object.fromEntries(
        PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => [key, rebuiltRuntimeSettings[key]]),
      ),
      before.settings,
    );
    await assert.rejects(access(path.join(fixture.runtimeDir, "system", "last-task-exits", "main.json")), /ENOENT/);
    await assert.rejects(access(path.join(fixture.runtimeDir, "system", "waterwheel-buckets", "main.json")), /ENOENT/);
    const desired = JSON.parse(await readFile(
      path.join(fixture.runtimeDir, "system", "desired-runs", "main.json"),
      "utf8",
    ));
    assert.equal(desired.desiredState, "stopped");
    assert.equal(desired.settingsEpoch, "11111111-1111-4111-8111-111111111111");
    assert.equal(JSON.parse(await readFile(experienceGuardPath, "utf8")).breached, true);
  } finally {
    await fixture.cleanup();
  }
});

test("online reset returns 404 for a missing profile without creating reset state", async () => {
  const fixture = await createOnlineFixture("missing", { importProfile: false });
  try {
    const { response, body } = await postReset(fixture.server);
    assert.equal(response.status, 404);
    assert.equal(body.error, "PROFILE_NOT_FOUND");
    await assert.rejects(access(path.join(fixture.runtimeDir, "system", "account-reset")), /ENOENT/);
  } finally {
    await fixture.cleanup();
  }
});

test("incomplete reset journal blocks settings reads and profile starts", async () => {
  const fixture = await createOnlineFixture("barrier");
  try {
    await writeJson(path.join(
      fixture.runtimeDir,
      "system",
      "account-reset",
      "operations",
      "operation-incomplete.json",
    ), {
      version: 1,
      operationId: "operation-incomplete",
      state: "incomplete",
      targets: [{ profileId: "main", completedSteps: [] }],
    });
    const settingsResponse = await fetch(`http://127.0.0.1:${fixture.server.port}/api/profiles/main/settings`);
    const settingsBody = await settingsResponse.json();
    assert.equal(settingsResponse.status, 503);
    assert.equal(settingsBody.error, "PROFILE_RESET_INCOMPLETE");

    const startResponse = await fetch(`http://127.0.0.1:${fixture.server.port}/api/profiles/main/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xjskp-session-token": "reset-test-token",
      },
      body: "{}",
    });
    const startBody = await startResponse.json();
    assert.equal(startResponse.status, 503);
    assert.equal(startBody.error, "PROFILE_RESET_INCOMPLETE");
  } finally {
    await fixture.cleanup();
  }
});

test("online mid-reset failure returns 503 with safe resumable step summary", async () => {
  let injected = false;
  const fixture = await createOnlineFixture("incomplete-response", {
    resetAfterStep({ step }) {
      if (!injected && step === "desired-stopped") {
        injected = true;
        throw new Error("controlled reset failure");
      }
    },
  });
  try {
    const { response, body } = await postReset(fixture.server);
    assert.equal(response.status, 503);
    assert.equal(body.error, "PROFILE_RESET_INCOMPLETE");
    assert.match(body.operationId, /^[A-Za-z0-9-]+$/);
    assert.deepEqual(body.completedSteps, [{
      profileId: "main",
      completedSteps: ["desired-stopped"],
    }]);
    assert.doesNotMatch(JSON.stringify(body), /PC_TOKEN|pc-secret|ct-secret|babi-secret|open-secret/i);
  } finally {
    await fixture.cleanup();
  }
});

async function createOnlineFixture(name, options = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), `xjskp-reset-online-${name}-`));
  const runtimeDir = path.join(rootDir, "runtime");
  const profileStore = createProfileStore({
    accountsDir: path.join(runtimeDir, "accounts"),
    protect: (value) => `p:${value}`,
    unprotect: (value) => value.slice(2),
  });
  if (options.importProfile !== false) {
    await profileStore.importProfile({
      id: "main",
      label: "Main",
      credentials: {
        CTOKEN: "ct",
        PC_USER_ID: "main",
        PC_TOKEN: "pc",
        BABI_TOKEN: "babi",
        OPEN_ID: "open",
      },
    });
  }
  const runtime = options.runtime || {
    active: null,
    activeTasks: [],
    activeByProfile: {},
    desiredRuns: [],
    recoveryByProfile: {},
    runningCount: 0,
    legacyProcesses: [],
  };
  const runner = {
    async beginAutomationAlreadyCoordinated() {
      throw new Error("unexpected coordinated start in reset fixture");
    },
    async runtime() { return runtime; },
    async restoreDesiredLoops() {},
    async stop() { return { stopped: false }; },
  };
  const accountResetService = options.resetAfterStep
    ? createAccountResetService({ runtimeDir, profileStore, afterStep: options.resetAfterStep })
    : undefined;
  const server = createSystemServer({
    rootDir,
    runtimeDir,
    profileStore,
    runner,
    accountResetService,
    gameVersionScheduler: { start() {}, stop() {}, getStatus: () => null },
    localRequestToken: "reset-test-token",
  });
  await server.listen(0);
  return {
    rootDir,
    runtimeDir,
    profileStore,
    server,
    accountPath: path.join(runtimeDir, "accounts", "main.json"),
    async cleanup() {
      await server.close().catch(() => {});
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

async function postReset(server) {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/profiles/main/reset`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-xjskp-session-token": "reset-test-token",
    },
    body: "{}",
  });
  return { response, body: await response.json() };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
