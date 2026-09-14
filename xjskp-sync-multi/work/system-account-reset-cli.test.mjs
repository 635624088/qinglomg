import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { runAccountResetCli } from "./system/account-reset-cli.mjs";
import { createProfileStore } from "./system/profile-store.mjs";
import { writeActiveTask } from "./system/runtime-lock.mjs";

test("offline reset cancellation performs no writes and does not acquire the guard", async () => {
  const fixture = await createCliFixture("cancel");
  let guardCalls = 0;
  try {
    const before = await readFile(fixture.accountPath, "utf8");
    const result = await runAccountResetCli({
      args: [`--root=${fixture.rootDir}`],
      profileStore: fixture.profileStore,
      confirmFn: async () => false,
      output() {},
      processInspector: async () => [],
      guardFactory: async () => {
        guardCalls++;
        return { async release() {} };
      },
    });

    assert.equal(result.state, "cancelled");
    assert.equal(guardCalls, 0);
    assert.equal(await readFile(fixture.accountPath, "utf8"), before);
    await assert.rejects(access(path.join(fixture.runtimeDir, "system", "account-reset", "operations")), /ENOENT/);
  } finally {
    await fixture.cleanup();
  }
});

test("non-interactive offline reset requires an explicit confirmation argument", async () => {
  const fixture = await createCliFixture("non-interactive-confirmation");
  try {
    const before = await readFile(fixture.accountPath, "utf8");
    await assert.rejects(
      runAccountResetCli({
        args: [`--root=${fixture.rootDir}`],
        profileStore: fixture.profileStore,
        output() {},
      }),
      { code: "ACCOUNT_RESET_CONFIRMATION_REQUIRED" },
    );
    assert.equal(await readFile(fixture.accountPath, "utf8"), before);
  } finally {
    await fixture.cleanup();
  }
});

test("confirmed offline reset preserves the profile and releases maintenance ownership", async () => {
  const fixture = await createCliFixture("complete");
  let releases = 0;
  try {
    const result = await runAccountResetCli({
      args: [`--root=${fixture.rootDir}`, "--confirm=RESET-CREDENTIALS"],
      profileStore: fixture.profileStore,
      output() {},
      processInspector: async () => [],
      identityResolver: async () => ({ canonicalRuntimeDir: fixture.runtimeDir, guardName: "test", instanceId: "cli" }),
      inspectOwner: async () => null,
      guardFactory: async () => ({ async release() { releases++; } }),
    });

    assert.equal(result.state, "completed");
    assert.equal(releases, 1);
    const after = JSON.parse(await readFile(fixture.accountPath, "utf8"));
    assert.deepEqual(after.secrets, {});
    assert.equal(after.label, "Main");
  } finally {
    await fixture.cleanup();
  }
});

test("offline reset rejects unresolved active-task before journal or credential writes", async () => {
  const fixture = await createCliFixture("active");
  try {
    await writeActiveTask(fixture.runtimeDir, { profileId: "main", pid: 1234 });
    const before = await readFile(fixture.accountPath, "utf8");
    await assert.rejects(
      runAccountResetCli({
        args: [`--root=${fixture.rootDir}`, "--confirm=RESET-CREDENTIALS"],
        profileStore: fixture.profileStore,
        output() {},
        processInspector: async () => [],
        identityResolver: async () => ({ canonicalRuntimeDir: fixture.runtimeDir, guardName: "test", instanceId: "cli" }),
        inspectOwner: async () => null,
        guardFactory: async () => ({ async release() {} }),
      }),
      { code: "PROFILE_RESET_REQUIRES_STOP" },
    );
    assert.equal(await readFile(fixture.accountPath, "utf8"), before);
    await assert.rejects(access(path.join(fixture.runtimeDir, "system", "account-reset", "operations")), /ENOENT/);
  } finally {
    await fixture.cleanup();
  }
});

test("offline reset rejects a verified server owner before acquiring maintenance ownership", async () => {
  const fixture = await createCliFixture("owner");
  let acquired = false;
  try {
    await assert.rejects(
      runAccountResetCli({
        args: [`--root=${fixture.rootDir}`, "--confirm=RESET-CREDENTIALS"],
        profileStore: fixture.profileStore,
        output() {},
        processInspector: async () => [],
        identityResolver: async () => ({ canonicalRuntimeDir: fixture.runtimeDir, guardName: "test", instanceId: "cli" }),
        inspectOwner: async () => ({ status: "ready", version: 2, healthy: true, pid: 1234, port: 43722 }),
        guardFactory: async () => {
          acquired = true;
          return { async release() {} };
        },
      }),
      { code: "ACCOUNT_RESET_SERVER_RUNNING" },
    );
    assert.equal(acquired, false);
  } finally {
    await fixture.cleanup();
  }
});

test("offline reset rejects a related worker discovered after guard acquisition", async () => {
  const fixture = await createCliFixture("worker");
  let releases = 0;
  try {
    await assert.rejects(
      runAccountResetCli({
        args: [`--root=${fixture.rootDir}`, "--confirm=RESET-CREDENTIALS"],
        profileStore: fixture.profileStore,
        output() {},
        identityResolver: async () => ({ canonicalRuntimeDir: fixture.runtimeDir, guardName: "test", instanceId: "cli" }),
        inspectOwner: async () => null,
        processInspector: async () => [{ pid: 4321, name: "node.exe" }],
        guardFactory: async () => ({ async release() { releases++; } }),
      }),
      { code: "ACCOUNT_RESET_WORKER_RUNNING" },
    );
    assert.equal(releases, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("Windows offline reset performs the real related-process preflight", { skip: process.platform !== "win32" }, async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-reset-cli-process-scan-"));
  const runtimeDir = path.join(rootDir, "runtime");
  try {
    const result = await runAccountResetCli({
      args: [`--root=${rootDir}`, "--confirm=RESET-CREDENTIALS"],
      output() {},
      identityResolver: async () => ({ canonicalRuntimeDir: runtimeDir, guardName: "test", instanceId: "cli" }),
      inspectOwner: async () => null,
      guardFactory: async () => ({ async release() {} }),
    });
    assert.equal(result.state, "completed");
    assert.deepEqual(result.targets, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("offline all-target reset covers multiple profiles and artifact-only orphans", async () => {
  const fixture = await createCliFixture("all-targets");
  try {
    await fixture.profileStore.importProfile({
      id: "second",
      label: "Second",
      credentials: {
        CTOKEN: "ct-2",
        PC_USER_ID: "second",
        PC_TOKEN: "pc-2",
        BABI_TOKEN: "babi-2",
        OPEN_ID: "open-2",
      },
    });
    const orphanDesired = path.join(fixture.runtimeDir, "system", "desired-runs", "orphan.json");
    await writeJson(orphanDesired, { profileId: "orphan", desiredState: "running" });
    const result = await runAccountResetCli({
      args: [`--root=${fixture.rootDir}`, "--confirm=RESET-CREDENTIALS"],
      profileStore: fixture.profileStore,
      output() {},
      identityResolver: async () => ({ canonicalRuntimeDir: fixture.runtimeDir, guardName: "test", instanceId: "cli" }),
      inspectOwner: async () => null,
      processInspector: async () => [],
      guardFactory: async () => ({ async release() {} }),
    });

    assert.deepEqual(result.targets.map((target) => target.profileId), ["main", "orphan", "second"]);
    assert.equal((await fixture.profileStore.getProfile("main")).hasCredentials, false);
    assert.equal((await fixture.profileStore.getProfile("second")).hasCredentials, false);
    await assert.rejects(access(orphanDesired), /ENOENT/);
    await assert.rejects(access(path.join(fixture.runtimeDir, "accounts", "orphan.json")), /ENOENT/);
  } finally {
    await fixture.cleanup();
  }
});

async function createCliFixture(name) {
  const rootDir = await mkdtemp(path.join(tmpdir(), `xjskp-reset-cli-${name}-`));
  const runtimeDir = path.join(rootDir, "runtime");
  const profileStore = createProfileStore({
    accountsDir: path.join(runtimeDir, "accounts"),
    protect: (value) => `p:${value}`,
    unprotect: (value) => value.slice(2),
  });
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
  return {
    rootDir,
    runtimeDir,
    profileStore,
    accountPath: path.join(runtimeDir, "accounts", "main.json"),
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
