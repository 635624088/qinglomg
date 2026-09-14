import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { createAccountResetService } from "./system/account-reset-service.mjs";
import { createProfileStore } from "./system/profile-store.mjs";

test("reset service preserves profile settings identity and cleans every current artifact", async () => {
  const fixture = await createResetFixture("complete");
  try {
    const before = JSON.parse(await readFile(fixture.accountPath, "utf8"));
    const plan = await fixture.service.plan(["main"]);
    const result = await fixture.service.execute(plan, {
      operationId: "operation-complete",
      validateQuiescent: async () => {},
    });
    const after = JSON.parse(await readFile(fixture.accountPath, "utf8"));

    assert.equal(result.state, "completed");
    assert.deepEqual(after.settings, before.settings);
    assert.equal(after.settingsEpoch, before.settingsEpoch);
    assert.equal(after.settingsRevision, before.settingsRevision);
    assert.deepEqual(after.settingsKeyRevisions, before.settingsKeyRevisions);
    assert.deepEqual(after.secrets, {});
    assert.equal(after.lastValidatedAt, null);
    assert.equal(after.serverIdx, null);
    assert.equal(after.serverText, null);

    for (const relative of [
      "settings/main.json",
      "system/active-tasks/main.json",
      "system/last-task-exits/main.json",
      "status/main",
      "logs/main",
    ]) {
      await assert.rejects(access(path.join(fixture.runtimeDir, ...relative.split("/"))), /ENOENT/);
    }
    const desired = JSON.parse(await readFile(
      path.join(fixture.runtimeDir, "system", "desired-runs", "main.json"),
      "utf8",
    ));
    assert.equal(desired.desiredState, "stopped");
    assert.equal(desired.lastReason, "credentials-reset");
    assert.equal(desired.settingsEpoch, "epoch-main");
    assert.equal(Object.hasOwn(desired, "env"), false);
    assert.equal(Object.hasOwn(desired, "token"), false);
    await access(path.join(
      fixture.runtimeDir,
      "system",
      "account-reset",
      "archive",
      "operation-complete",
      "main",
      "status",
      "garden-status.json",
    ));
    await access(path.join(
      fixture.runtimeDir,
      "system",
      "account-reset",
      "archive",
      "operation-complete",
      "main",
      "logs",
      "auto.log",
    ));
    const journalText = await readFile(path.join(
      fixture.runtimeDir,
      "system",
      "account-reset",
      "operations",
      "operation-complete.json",
    ), "utf8");
    assert.doesNotMatch(journalText, /pc-secret|ct-secret|babi-secret|open-secret/);
  } finally {
    await fixture.cleanup();
  }
});

test("reset service resumes idempotently after a controlled mid-operation crash", async () => {
  let injected = false;
  const fixture = await createResetFixture("resume", {
    afterStep({ step }) {
      if (!injected && step === "status-archived") {
        injected = true;
        throw new Error("controlled reset crash");
      }
    },
  });
  try {
    const plan = await fixture.service.plan(["main"]);
    await assert.rejects(
      fixture.service.execute(plan, {
        operationId: "operation-resume",
        validateQuiescent: async () => {},
      }),
      { code: "PROFILE_RESET_INCOMPLETE" },
    );
    await assert.rejects(
      fixture.service.assertProfileReady("main"),
      { code: "PROFILE_RESET_INCOMPLETE" },
    );

    const resumedService = createAccountResetService({
      runtimeDir: fixture.runtimeDir,
      profileStore: fixture.profileStore,
    });
    const result = await resumedService.resume("operation-resume", {
      validateQuiescent: async () => {},
    });
    assert.equal(result.state, "completed");
    await assert.doesNotReject(resumedService.assertProfileReady("main"));
    assert.deepEqual(JSON.parse(await readFile(fixture.accountPath, "utf8")).secrets, {});
  } finally {
    await fixture.cleanup();
  }
});

test("quiescent validation fails before journal or profile writes", async () => {
  const fixture = await createResetFixture("quiescent");
  try {
    const before = await readFile(fixture.accountPath, "utf8");
    const plan = await fixture.service.plan(["main"]);
    const error = new Error("active");
    error.code = "PROFILE_RESET_REQUIRES_STOP";
    await assert.rejects(
      fixture.service.execute(plan, {
        operationId: "operation-active",
        validateQuiescent: async () => {
          throw error;
        },
      }),
      { code: "PROFILE_RESET_REQUIRES_STOP" },
    );
    assert.equal(await readFile(fixture.accountPath, "utf8"), before);
    await assert.rejects(access(path.join(
      fixture.runtimeDir,
      "system",
      "account-reset",
      "operations",
      "operation-active.json",
    )), /ENOENT/);
  } finally {
    await fixture.cleanup();
  }
});

test("reset service refuses writes when the caller omits quiescence validation", async () => {
  const fixture = await createResetFixture("validator-required");
  try {
    const before = await readFile(fixture.accountPath, "utf8");
    await assert.rejects(
      fixture.service.execute(await fixture.service.plan(["main"]), {
        operationId: "operation-no-validator",
      }),
      { code: "ACCOUNT_RESET_QUIESCENCE_VALIDATOR_REQUIRED" },
    );
    assert.equal(await readFile(fixture.accountPath, "utf8"), before);
    await assert.rejects(access(path.join(
      fixture.runtimeDir,
      "system",
      "account-reset",
      "operations",
      "operation-no-validator.json",
    )), /ENOENT/);
  } finally {
    await fixture.cleanup();
  }
});

test("orphan desired state without an epoch is quarantined without creating a profile", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-reset-orphan-"));
  const runtimeDir = path.join(rootDir, "runtime");
  await writeJson(path.join(runtimeDir, "system", "desired-runs", "orphan.json"), {
    profileId: "orphan",
    desiredState: "running",
  });
  const service = createAccountResetService({
    runtimeDir,
    profileStore: createProfileStore({ accountsDir: path.join(runtimeDir, "accounts") }),
  });
  try {
    const result = await service.execute(await service.plan("all"), {
      operationId: "operation-orphan",
      validateQuiescent: async () => {},
    });
    assert.equal(result.state, "completed");
    await assert.rejects(access(path.join(runtimeDir, "accounts", "orphan.json")), /ENOENT/);
    await assert.rejects(access(path.join(runtimeDir, "system", "desired-runs", "orphan.json")), /ENOENT/);
    await access(path.join(
      runtimeDir,
      "system",
      "account-reset",
      "archive",
      "operation-orphan",
      "orphan",
      "desired",
      "orphan.json",
    ));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("credential reset is idempotent and never creates new settings revision fields", async () => {
  const fixture = await createResetFixture("idempotent");
  try {
    const first = await fixture.service.execute(await fixture.service.plan(["main"]), {
      operationId: "operation-idempotent-1",
      validateQuiescent: async () => {},
    });
    const afterFirst = JSON.parse(await readFile(fixture.accountPath, "utf8"));
    const second = await fixture.service.execute(await fixture.service.plan(["main"]), {
      operationId: "operation-idempotent-2",
      validateQuiescent: async () => {},
    });
    const afterSecond = JSON.parse(await readFile(fixture.accountPath, "utf8"));

    assert.equal(first.state, "completed");
    assert.equal(second.state, "completed");
    assert.equal(afterSecond.settingsEpoch, afterFirst.settingsEpoch);
    assert.equal(afterSecond.settingsRevision, afterFirst.settingsRevision);
    assert.deepEqual(afterSecond.settingsKeyRevisions, afterFirst.settingsKeyRevisions);
    assert.deepEqual(afterSecond.secrets, {});
  } finally {
    await fixture.cleanup();
  }
});

test("legacy profile reset preserves missing epoch and revision field presence", async () => {
  const fixture = await createResetFixture("legacy-fields");
  try {
    const legacy = JSON.parse(await readFile(fixture.accountPath, "utf8"));
    delete legacy.settingsEpoch;
    delete legacy.settingsRevision;
    delete legacy.settingsKeyRevisions;
    await writeJson(fixture.accountPath, legacy);

    await fixture.service.execute(await fixture.service.plan(["main"]), {
      operationId: "operation-legacy-fields",
      validateQuiescent: async () => {},
    });
    const after = JSON.parse(await readFile(fixture.accountPath, "utf8"));
    assert.equal(Object.hasOwn(after, "settingsEpoch"), false);
    assert.equal(Object.hasOwn(after, "settingsRevision"), false);
    assert.equal(Object.hasOwn(after, "settingsKeyRevisions"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("every journaled reset step can be resumed without repeating completed work", async (t) => {
  const steps = [
    "desired-stopped",
    "control-cleared",
    "status-archived",
    "logs-archived",
    "credentials-cleared",
    "verified",
  ];
  for (const stepToCrash of steps) {
    await t.test(stepToCrash, async () => {
      let injected = false;
      const fixture = await createResetFixture(`step-${stepToCrash}`, {
        afterStep({ step }) {
          if (!injected && step === stepToCrash) {
            injected = true;
            throw new Error(`controlled crash after ${step}`);
          }
        },
      });
      const operationId = `operation-step-${stepToCrash}`;
      try {
        await assert.rejects(
          fixture.service.execute(await fixture.service.plan(["main"]), {
            operationId,
            validateQuiescent: async () => {},
          }),
          (error) => (
            error?.code === "PROFILE_RESET_INCOMPLETE"
            && error.operationId === operationId
            && Array.isArray(error.completedSteps)
          ),
        );
        const resumed = createAccountResetService({
          runtimeDir: fixture.runtimeDir,
          profileStore: fixture.profileStore,
        });
        assert.equal((await resumed.resume(operationId, { validateQuiescent: async () => {} })).state, "completed");
        assert.equal((await resumed.verify(operationId)).state, "completed");
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

async function createResetFixture(name, options = {}) {
  const rootDir = await mkdtemp(path.join(tmpdir(), `xjskp-reset-service-${name}-`));
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
      CTOKEN: "ct-secret",
      PC_USER_ID: "main",
      PC_TOKEN: "pc-secret",
      BABI_TOKEN: "babi-secret",
      OPEN_ID: "open-secret",
    },
  });
  await profileStore.markValidated("main", undefined, { serverIdx: 726 });
  const accountPath = path.join(runtimeDir, "accounts", "main.json");
  const account = JSON.parse(await readFile(accountPath, "utf8"));
  account.settingsEpoch = "epoch-main";
  account.settingsRevision = 7;
  account.settingsKeyRevisions = { autoSubmitCyclicStoryOrders: 3 };
  await writeJson(accountPath, account);
  await writeJson(path.join(runtimeDir, "settings", "main.json"), { autoSubmitCyclicStoryOrders: true });
  await writeJson(path.join(runtimeDir, "system", "desired-runs", "main.json"), {
    profileId: "main",
    desiredState: "running",
    settingsEpoch: "stale-epoch",
    env: { PC_TOKEN: "desired-secret" },
    token: "desired-secret",
  });
  await writeJson(path.join(runtimeDir, "system", "active-tasks", "main.json"), {
    profileId: "main",
    pid: 1234,
  });
  await writeJson(path.join(runtimeDir, "system", "last-task-exits", "main.json"), {
    profileId: "main",
    reason: "error",
  });
  await writeJson(path.join(runtimeDir, "status", "main", "garden-status.json"), { ok: true });
  await writeText(path.join(runtimeDir, "logs", "main", "auto.log"), "log\n");
  const service = createAccountResetService({
    runtimeDir,
    profileStore,
    afterStep: options.afterStep,
  });
  return {
    rootDir,
    runtimeDir,
    accountPath,
    profileStore,
    service,
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}
