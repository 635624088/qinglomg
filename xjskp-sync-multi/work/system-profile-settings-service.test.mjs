import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_PROFILE_SETTINGS,
  createProfileStore,
} from "./system/profile-store.mjs";
import { createProfileOperationCoordinator } from "./system/profile-operation-coordinator.mjs";
import { createRuntimeSettingsStore } from "./system/runtime-settings-store.mjs";
import {
  completeProfileSettingsMutation,
  createProfileSettingsKernel,
  createProfileSettingsService,
  prepareProfileSettingsMutationEnvelope,
  prepareProfileSettingsMutation,
} from "./system/profile-settings-service.mjs";

const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";
const TX_A = "txn_aaaaaaaaaaaaaaaa";
const TX_B = "txn_bbbbbbbbbbbbbbbb";

function keyRevisions(revision = 0) {
  return Object.fromEntries(
    Object.keys(DEFAULT_PROFILE_SETTINGS).map((key) => [key, revision]),
  );
}

function makeSnapshot(overrides = {}) {
  return {
    settings: { ...DEFAULT_PROFILE_SETTINGS },
    settingsEpoch: EPOCH_A,
    settingsRevision: 0,
    settingsKeyRevisions: keyRevisions(0),
    ...overrides,
  };
}

async function createFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-settings-t3-service-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const accountsDir = path.join(root, "accounts");
  const runtimeDir = path.join(root, "runtime");
  await fs.mkdir(accountsDir, { recursive: true });
  const profileStore = createProfileStore({
    accountsDir,
    fs: options.profileFs || fs,
    createSettingsEpoch: options.createSettingsEpoch || (() => EPOCH_A),
    now: options.now || (() => new Date("2026-08-10T00:00:00.000Z")),
    protect: (value) => `protected:${value}`,
    unprotect: (value) => value.replace(/^protected:/, ""),
  });
  const runtimeSettingsStore = createRuntimeSettingsStore({
    runtimeDir,
    fs: options.runtimeFs || fs,
  });
  const kernel = createProfileSettingsKernel({
    profileStore,
    runtimeSettingsStore,
    inspectCanonicalSources: options.inspectCanonicalSources || (async () => ({ status: "clear" })),
  });
  const coordinator = createProfileOperationCoordinator();
  let coordinatedCalls = 0;
  const runCoordinated = options.runCoordinated || ((profileId, operation) => {
    coordinatedCalls += 1;
    return coordinator.run(profileId, operation);
  });
  const service = createProfileSettingsService({ kernel, runCoordinated });
  return {
    root,
    accountsDir,
    runtimeDir,
    profileStore,
    runtimeSettingsStore,
    kernel,
    service,
    getCoordinatedCalls: () => coordinatedCalls,
  };
}

async function seedProfile(accountsDir, profileId = "p1", overrides = {}) {
  const record = {
    version: 1,
    id: profileId,
    label: profileId,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    settings: { ...DEFAULT_PROFILE_SETTINGS },
    settingsEpoch: EPOCH_A,
    settingsRevision: 0,
    settingsKeyRevisions: keyRevisions(0),
    secrets: { CTOKEN: "protected" },
    ...overrides,
  };
  await fs.writeFile(
    path.join(accountsDir, `${profileId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  return record;
}

async function seedRuntime(runtimeDir, profileId = "p1", snapshot = makeSnapshot()) {
  const filePath = path.join(runtimeDir, "settings", `${profileId}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify({
      ...snapshot.settings,
      _meta: {
        settingsEpoch: snapshot.settingsEpoch,
        settingsRevision: snapshot.settingsRevision,
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

async function readProfile(accountsDir, profileId = "p1") {
  return JSON.parse(await fs.readFile(path.join(accountsDir, `${profileId}.json`), "utf8"));
}

function mutation(overrides = {}) {
  return {
    profileId: "p1",
    ifMatch: `"${EPOCH_A}:0"`,
    transactionId: TX_A,
    body: { pearlHireItemReserveCount: 77 },
    ...overrides,
  };
}

test("mutation preparation enforces canonical, precondition, then patch order before Q", async () => {
  assert.equal(
    prepareProfileSettingsMutation(mutation({ profileId: "P 1", ifMatch: "bad", body: {} })).result.body.error,
    "INVALID_PROFILE_ID_CANONICAL_FORM",
  );
  assert.equal(
    prepareProfileSettingsMutation(mutation({ ifMatch: "bad", body: {} })).result.body.error,
    "PROFILE_SETTINGS_PRECONDITION_REQUIRED",
  );
  assert.equal(
    prepareProfileSettingsMutation(mutation({ body: {} })).result.body.error,
    "INVALID_PROFILE_SETTINGS",
  );
  let bodyReads = 0;
  const invalidEnvelope = {
    profileId: "p1",
    ifMatch: "bad",
    transactionId: TX_A,
  };
  Object.defineProperty(invalidEnvelope, "body", {
    get() {
      bodyReads += 1;
      throw new Error("body must not be read before precondition acceptance");
    },
  });
  assert.equal(
    prepareProfileSettingsMutation(invalidEnvelope).result.statusCode,
    428,
  );
  assert.equal(bodyReads, 0);

  let coordinated = 0;
  const service = createProfileSettingsService({
    kernel: {
      mutateAlreadyCoordinated: async () => {
        throw new Error("must not run");
      },
      readCommittedAlreadyCoordinated: async () => {
        throw new Error("must not run");
      },
    },
    runCoordinated: async () => {
      coordinated += 1;
      throw new Error("must not enter Q");
    },
  });
  assert.equal((await service.mutate(mutation({ ifMatch: "bad" }))).statusCode, 428);
  assert.equal((await service.mutate(mutation({ body: {} }))).statusCode, 400);
  assert.equal(coordinated, 0);

  const envelope = prepareProfileSettingsMutationEnvelope(mutation());
  assert.equal(envelope.ok, true);
  const completed = completeProfileSettingsMutation(
    envelope.envelope,
    { pearlHireItemReserveCount: 77 },
  );
  assert.equal(completed.ok, true);
  assert.equal(completed.prepared.patch.pearlHireItemReserveCount, 77);
  assert.throws(
    () => completeProfileSettingsMutation(
      { ...envelope.envelope, precondition: {} },
      { pearlHireItemReserveCount: 77 },
    ),
    /prepared profile settings mutation envelope/,
  );
  await assert.rejects(
    service.mutatePrepared({
      ...completed.prepared,
      precondition: { settingsEpoch: EPOCH_A, settingsRevision: -1 },
    }),
    /completed profile settings mutation/,
  );
  await assert.rejects(
    service.mutatePrepared({ ...completed.prepared, patch: {} }),
    /completed profile settings mutation/,
  );
  assert.equal(coordinated, 0);
});

test("protocol profile and runtime stores reject the same non-canonical IDs before paths", async (t) => {
  const fixture = await createFixture(t);
  for (const profileId of ["P 1", "../p1", "p1%2fchild"]) {
    await assert.rejects(
      fixture.profileStore.readSettingsStateForProtocol(profileId),
      (error) => error?.code === "INVALID_PROFILE_ID_CANONICAL_FORM",
    );
    assert.throws(
      () => fixture.runtimeSettingsStore.reconcileVersionedForProtocol(
        profileId,
        makeSnapshot(),
      ),
      (error) => error?.code === "INVALID_PROFILE_ID_CANONICAL_FORM",
    );
  }
  assert.deepEqual(await fs.readdir(fixture.accountsDir), []);
  assert.deepEqual(
    await fs.readdir(path.join(fixture.runtimeDir, "settings")).catch(() => []),
    [],
  );
});

test("partial commit and no-op keep profile/runtime on one snapshot", async (t) => {
  const fixture = await createFixture(t);
  await seedProfile(fixture.accountsDir);
  await seedRuntime(fixture.runtimeDir);

  const committed = await fixture.service.mutate(mutation());
  assert.equal(committed.statusCode, 200);
  assert.equal(committed.body.applied, true);
  assert.equal(committed.body.commitState, "committed");
  assert.equal(committed.body.settingsRevision, 1);
  assert.equal(committed.body.settings.pearlHireItemReserveCount, 77);
  assert.equal(committed.body.settingsKeyRevisions.pearlHireItemReserveCount, 1);
  assert.equal(committed.body.settingsKeyRevisions.autoSubmitCyclicStoryOrders, 0);
  assert.equal(committed.body.profile.secrets, undefined);
  assert.equal(
    (await fixture.runtimeSettingsStore.compareVersionedForProtocol("p1", committed.body)).classification,
    "synced",
  );

  const beforeNoop = await fs.readFile(path.join(fixture.accountsDir, "p1.json"), "utf8");
  const noOp = await fixture.service.mutate(mutation({
    ifMatch: `"${EPOCH_A}:1"`,
    transactionId: TX_A,
  }));
  assert.equal(noOp.statusCode, 200);
  assert.equal(noOp.body.applied, false);
  assert.equal(noOp.body.settingsRevision, 1);
  assert.equal(await fs.readFile(path.join(fixture.accountsDir, "p1.json"), "utf8"), beforeNoop);

  const reused = await fixture.service.mutate(mutation({
    ifMatch: `"${EPOCH_A}:1"`,
    transactionId: TX_A,
    body: { autoSubmitCyclicStoryOrders: true },
  }));
  assert.equal(reused.statusCode, 200);
  assert.equal(reused.body.applied, true);
  assert.equal(reused.body.transactionId, TX_A);
  assert.equal(reused.body.settingsRevision, 2);
});

test("no-op repairs a legacy runtime without writing the profile", async (t) => {
  const fixture = await createFixture(t);
  await seedProfile(fixture.accountsDir);
  const runtimePath = path.join(fixture.runtimeDir, "settings", "p1.json");
  await fs.mkdir(path.dirname(runtimePath), { recursive: true });
  await fs.writeFile(
    runtimePath,
    `${JSON.stringify(DEFAULT_PROFILE_SETTINGS, null, 2)}\n`,
    "utf8",
  );
  const beforeProfile = await fs.readFile(path.join(fixture.accountsDir, "p1.json"), "utf8");
  const result = await fixture.service.mutate(mutation({
    body: { pearlHireItemReserveCount: 100 },
  }));
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.applied, false);
  assert.equal(result.body.settingsRevision, 0);
  assert.equal(await fs.readFile(path.join(fixture.accountsDir, "p1.json"), "utf8"), beforeProfile);
  assert.equal(
    (await fixture.runtimeSettingsStore.compareVersionedForProtocol("p1", result.body)).classification,
    "synced",
  );
});

test("stale CAS repairs runtime first and distinguishes recreated epoch", async (t) => {
  const fixture = await createFixture(t);
  const settings = { ...DEFAULT_PROFILE_SETTINGS, pearlHireItemReserveCount: 55 };
  await seedProfile(fixture.accountsDir, "p1", {
    settings,
    settingsRevision: 2,
    settingsKeyRevisions: { ...keyRevisions(0), pearlHireItemReserveCount: 2 },
  });
  await seedRuntime(fixture.runtimeDir, "p1", {
    ...makeSnapshot(),
    settings: { ...DEFAULT_PROFILE_SETTINGS },
  });

  const stale = await fixture.service.mutate(mutation());
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.reason, undefined);
  assert.equal(stale.body.settingsRevision, 2);
  assert.equal(stale.body.settings.pearlHireItemReserveCount, 55);
  assert.equal(
    (await fixture.runtimeSettingsStore.compareVersionedForProtocol("p1", stale.body)).classification,
    "synced",
  );

  const recreated = await fixture.service.mutate(mutation({
    ifMatch: `"${EPOCH_B}:2"`,
    transactionId: TX_B,
  }));
  assert.equal(recreated.statusCode, 409);
  assert.equal(recreated.body.reason, "profile-recreated");
});

test("stale pages merge through residual retry and key revisions expose ABA", async (t) => {
  const fixture = await createFixture(t);
  await seedProfile(fixture.accountsDir);
  await seedRuntime(fixture.runtimeDir);

  const first = await fixture.service.mutate(mutation({
    body: { pearlHireItemReserveCount: 200 },
  }));
  assert.equal(first.body.settingsRevision, 1);
  const stale = await fixture.service.mutate(mutation({
    transactionId: TX_B,
    body: { teamOrderTriggerProtectionEnabled: false },
  }));
  assert.equal(stale.statusCode, 409);
  const retried = await fixture.service.mutate(mutation({
    ifMatch: `"${EPOCH_A}:1"`,
    transactionId: TX_B,
    body: { teamOrderTriggerProtectionEnabled: false },
  }));
  assert.equal(retried.body.settingsRevision, 2);
  assert.equal(retried.body.settings.pearlHireItemReserveCount, 200);
  assert.equal(retried.body.settings.teamOrderTriggerProtectionEnabled, false);

  const back = await fixture.service.mutate(mutation({
    ifMatch: `"${EPOCH_A}:2"`,
    body: { pearlHireItemReserveCount: 100 },
  }));
  assert.equal(back.body.settingsRevision, 3);
  const aba = await fixture.service.mutate(mutation({
    transactionId: TX_B,
    body: { pearlHireItemReserveCount: 300 },
  }));
  assert.equal(aba.statusCode, 409);
  assert.equal(aba.body.settings.pearlHireItemReserveCount, 100);
  assert.equal(aba.body.settingsKeyRevisions.pearlHireItemReserveCount, 3);
});

test("missing profile and canonical collision never create or expose settings", async (t) => {
  const missingFixture = await createFixture(t);
  const missing = await missingFixture.service.mutate(mutation());
  assert.equal(missing.statusCode, 404);
  await assert.rejects(fs.access(missingFixture.runtimeSettingsStore.settingsPath("p1")));

  const collisionFixture = await createFixture(t, {
    inspectCanonicalSources: async () => ({
      status: "collision",
      sources: [{ kind: "profile", profileId: "p1-alias", active: false }],
    }),
  });
  await seedProfile(collisionFixture.accountsDir);
  const collision = await collisionFixture.service.mutate(mutation());
  assert.equal(collision.statusCode, 409);
  assert.equal(collision.body.error, "PROFILE_ID_CANONICAL_COLLISION");
  assert.equal(Object.hasOwn(collision.body, "settings"), false);
  await assert.rejects(fs.access(collisionFixture.runtimeSettingsStore.settingsPath("p1")));
});

test("invalid profile settings state returns its dedicated degraded schema", async (t) => {
  const fixture = await createFixture(t);
  await seedProfile(fixture.accountsDir, "p1", {
    settingsRevision: 1,
    settingsKeyRevisions: { unknownSetting: 0 },
  });
  const result = await fixture.service.mutate(mutation({
    ifMatch: `"${EPOCH_A}:1"`,
  }));
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error, "PROFILE_SETTINGS_REVISION_INVALID");
  assert.equal(result.body.commitState, "not-applied");
  assert.equal(Object.hasOwn(result.body, "settings"), false);
  await assert.rejects(fs.access(fixture.runtimeSettingsStore.settingsPath("p1")));
});

test("runtime precondition repair failure is not-applied before tentative profile write", async (t) => {
  const runtimeFs = {
    ...fs,
    rename: async () => {
      throw new Error("controlled precondition repair failure");
    },
  };
  const fixture = await createFixture(t, { runtimeFs });
  await seedProfile(fixture.accountsDir);
  const before = await fs.readFile(path.join(fixture.accountsDir, "p1.json"), "utf8");
  const result = await fixture.service.mutate(mutation());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.commitState, "not-applied");
  assert.equal(result.body.settingsRevision, 0);
  assert.equal(await fs.readFile(path.join(fixture.accountsDir, "p1.json"), "utf8"), before);
});

test("runtime publish failure rolls back synchronously to the old synced snapshot", async (t) => {
  let runtimeRenames = 0;
  const runtimeFs = {
    ...fs,
    rename: async (...args) => {
      runtimeRenames += 1;
      if (runtimeRenames === 1) throw new Error("controlled publish failure");
      return fs.rename(...args);
    },
  };
  const fixture = await createFixture(t, { runtimeFs });
  await seedProfile(fixture.accountsDir);
  await seedRuntime(fixture.runtimeDir);
  const result = await fixture.service.mutate(mutation());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.commitState, "rolled-back");
  assert.equal(result.body.runtimeSyncStatus, "synced");
  assert.equal(result.body.settingsRevision, 0);
  assert.equal((await readProfile(fixture.accountsDir)).settings.pearlHireItemReserveCount, 100);
  const renameCountAtResponse = runtimeRenames;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtimeRenames, renameCountAtResponse);
});

test("failed rollback with a proven tentative profile becomes committed-degraded", async (t) => {
  let profileRenames = 0;
  const profileFs = {
    ...fs,
    rename: async (...args) => {
      profileRenames += 1;
      if (profileRenames === 2) throw new Error("controlled rollback failure");
      return fs.rename(...args);
    },
  };
  const runtimeFs = {
    ...fs,
    rename: async () => {
      throw new Error("controlled publish failure");
    },
  };
  const fixture = await createFixture(t, { profileFs, runtimeFs });
  await seedProfile(fixture.accountsDir);
  await seedRuntime(fixture.runtimeDir);
  const result = await fixture.service.mutate(mutation());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.commitState, "profile-committed-runtime-degraded");
  assert.equal(result.body.settingsRevision, 1);
  assert.equal(result.body.settings.pearlHireItemReserveCount, 77);
  assert.equal((await readProfile(fixture.accountsDir)).settingsRevision, 1);
});

test("unprovable rollback result stays unknown without a snapshot", async (t) => {
  let profileRenames = 0;
  let failReads = false;
  const profileFs = {
    ...fs,
    rename: async (...args) => {
      profileRenames += 1;
      if (profileRenames === 2) {
        failReads = true;
        throw new Error("controlled rollback failure");
      }
      return fs.rename(...args);
    },
    readFile: async (...args) => {
      if (failReads) throw new Error("controlled verification failure");
      return fs.readFile(...args);
    },
  };
  const runtimeFs = {
    ...fs,
    rename: async () => {
      throw new Error("controlled publish failure");
    },
  };
  const fixture = await createFixture(t, { profileFs, runtimeFs });
  await seedProfile(fixture.accountsDir);
  await seedRuntime(fixture.runtimeDir);
  const result = await fixture.service.mutate(mutation());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.commitState, "unknown");
  assert.equal(Object.hasOwn(result.body, "settings"), false);
  assert.equal(Object.hasOwn(result.body, "settingsEpoch"), false);
});

test("publish that reached disk before throwing is verified as committed", async (t) => {
  let runtimeRenames = 0;
  const runtimeFs = {
    ...fs,
    rename: async (...args) => {
      runtimeRenames += 1;
      await fs.rename(...args);
      if (runtimeRenames === 1) throw new Error("throw after durable rename");
    },
  };
  const fixture = await createFixture(t, { runtimeFs });
  await seedProfile(fixture.accountsDir);
  await seedRuntime(fixture.runtimeDir);
  const result = await fixture.service.mutate(mutation());
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.commitState, "committed");
  assert.equal(result.body.settingsRevision, 1);
});

test("tentative profile rename that reached disk before throwing still converges", async (t) => {
  let profileRenames = 0;
  const profileFs = {
    ...fs,
    rename: async (...args) => {
      profileRenames += 1;
      await fs.rename(...args);
      if (profileRenames === 1) throw new Error("throw after tentative profile rename");
    },
  };
  const fixture = await createFixture(t, { profileFs });
  await seedProfile(fixture.accountsDir);
  await seedRuntime(fixture.runtimeDir);
  const result = await fixture.service.mutate(mutation());
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.commitState, "committed");
  assert.equal(result.body.settingsRevision, 1);
  assert.equal(result.body.settings.pearlHireItemReserveCount, 77);
  assert.equal(
    (await fixture.runtimeSettingsStore.compareVersionedForProtocol("p1", result.body)).classification,
    "synced",
  );
});

test("tentative profile failure before rename is proven not applied", async (t) => {
  const profileFs = {
    ...fs,
    rename: async () => {
      throw new Error("controlled failure before tentative rename");
    },
  };
  const fixture = await createFixture(t, { profileFs });
  await seedProfile(fixture.accountsDir);
  await seedRuntime(fixture.runtimeDir);
  const before = await fs.readFile(path.join(fixture.accountsDir, "p1.json"), "utf8");
  const result = await fixture.service.mutate(mutation());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.commitState, "not-applied");
  assert.equal(result.body.settingsRevision, 0);
  assert.equal(await fs.readFile(path.join(fixture.accountsDir, "p1.json"), "utf8"), before);
});

test("unreadable tentative write verification stays unknown without a snapshot", async (t) => {
  let failReads = false;
  const profileFs = {
    ...fs,
    rename: async () => {
      failReads = true;
      throw new Error("controlled tentative rename uncertainty");
    },
    readFile: async (...args) => {
      if (failReads) throw new Error("controlled tentative verification failure");
      return fs.readFile(...args);
    },
  };
  const fixture = await createFixture(t, { profileFs });
  await seedProfile(fixture.accountsDir);
  await seedRuntime(fixture.runtimeDir);
  const result = await fixture.service.mutate(mutation());
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.commitState, "unknown");
  assert.equal(Object.hasOwn(result.body, "settings"), false);
  assert.equal(Object.hasOwn(result.body, "settingsEpoch"), false);
});

test("committed accessor is one whole-Q single-flight and repairs crash state", async (t) => {
  let runtimeWrites = 0;
  const runtimeFs = {
    ...fs,
    writeFile: async (...args) => {
      runtimeWrites += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return fs.writeFile(...args);
    },
  };
  const fixture = await createFixture(t, { runtimeFs });
  await seedProfile(fixture.accountsDir, "p1", {
    settings: { ...DEFAULT_PROFILE_SETTINGS, pearlHireItemReserveCount: 66 },
    settingsRevision: 4,
    settingsKeyRevisions: { ...keyRevisions(0), pearlHireItemReserveCount: 4 },
  });
  const results = await Promise.all(
    Array.from({ length: 6 }, () => fixture.service.readCommitted("p1")),
  );
  assert.equal(fixture.getCoordinatedCalls(), 1);
  assert.equal(runtimeWrites, 1);
  assert.equal(results.every((result) => result.statusCode === 200), true);
  assert.equal(results[0].body.settingsRevision, 4);
  assert.equal(results[0].body.settings.pearlHireItemReserveCount, 66);
});

test("failed committed accessor single-flight clears and a later read can repair", async (t) => {
  let runtimeRenames = 0;
  const runtimeFs = {
    ...fs,
    rename: async (...args) => {
      runtimeRenames += 1;
      if (runtimeRenames === 1) throw new Error("controlled first repair failure");
      return fs.rename(...args);
    },
  };
  const fixture = await createFixture(t, { runtimeFs });
  await seedProfile(fixture.accountsDir);
  const failed = await Promise.all(
    Array.from({ length: 4 }, () => fixture.service.readCommitted("p1")),
  );
  assert.equal(failed.every((result) => result.statusCode === 503), true);
  assert.equal(fixture.getCoordinatedCalls(), 1);
  const repaired = await fixture.service.readCommitted("p1");
  assert.equal(repaired.statusCode, 200);
  assert.equal(fixture.getCoordinatedCalls(), 2);
  assert.equal(runtimeRenames, 2);
});

test("committed GET keeps missing, collision, invalid, and degraded schemas distinct", async (t) => {
  const missingFixture = await createFixture(t);
  const missing = await missingFixture.service.readCommitted("p1");
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.error, "PROFILE_NOT_FOUND");
  assert.equal(Object.hasOwn(missing.body, "transactionId"), false);
  assert.equal(Object.hasOwn(missing.body, "commitState"), false);

  const collisionFixture = await createFixture(t, {
    inspectCanonicalSources: async () => ({ status: "collision", sources: [] }),
  });
  await seedProfile(collisionFixture.accountsDir);
  const collision = await collisionFixture.service.readCommitted("p1");
  assert.equal(collision.statusCode, 409);
  assert.equal(collision.body.error, "PROFILE_ID_CANONICAL_COLLISION");
  assert.equal(Object.hasOwn(collision.body, "settings"), false);
  assert.equal(Object.hasOwn(collision.body, "transactionId"), false);
  assert.equal(Object.hasOwn(collision.body, "commitState"), false);

  const invalidFixture = await createFixture(t);
  await seedProfile(invalidFixture.accountsDir, "p1", {
    settingsEpoch: "invalid",
  });
  const invalid = await invalidFixture.service.readCommitted("p1");
  assert.equal(invalid.statusCode, 503);
  assert.equal(invalid.body.error, "PROFILE_SETTINGS_EPOCH_INVALID");
  assert.equal(Object.hasOwn(invalid.body, "settings"), false);
  assert.equal(Object.hasOwn(invalid.body, "transactionId"), false);
  assert.equal(Object.hasOwn(invalid.body, "commitState"), false);

  const runtimeFs = {
    ...fs,
    rename: async () => {
      throw new Error("controlled GET runtime failure");
    },
  };
  const degradedFixture = await createFixture(t, { runtimeFs });
  await seedProfile(degradedFixture.accountsDir);
  const degraded = await degradedFixture.service.readCommitted("p1");
  assert.equal(degraded.statusCode, 503);
  assert.equal(degraded.body.error, "PROFILE_SETTINGS_RUNTIME_DEGRADED");
  assert.equal(degraded.body.settingsEpoch, EPOCH_A);
  assert.equal(Object.hasOwn(degraded.body, "transactionId"), false);
  assert.equal(Object.hasOwn(degraded.body, "commitState"), false);
});

test("T5 server is the only production composition root for the settings service", async () => {
  const serverSource = await fs.readFile(new URL("./system/server.mjs", import.meta.url), "utf8");
  assert.equal(serverSource.includes("profile-settings-service"), true);
  assert.equal(serverSource.includes("createProfileSettingsService"), true);
  const productionFiles = [
    "./system/process-manager.mjs",
    "./system/automation-recovery.mjs",
    "./system/start-admission.mjs",
    "./system/public/app.js",
  ];
  const forbidden = [
    "profile-settings-service",
    "readSettingsStateForProtocol",
    "compareAndWriteTentativeSettingsForProtocol",
    "conditionalRollbackSettingsForProtocol",
    "publishVersionedForProtocol",
    "reconcileVersionedForProtocol",
  ];
  for (const file of productionFiles) {
    const source = await fs.readFile(new URL(file, import.meta.url), "utf8");
    for (const token of forbidden) {
      assert.equal(source.includes(token), false, `${file} must not reference ${token}`);
    }
  }
});
