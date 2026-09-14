import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDesiredRunStore } from "./system/automation-recovery.mjs";
import { createProfileCanonicalMigration } from "./system/profile-canonical-migration.mjs";
import { DEFAULT_PROFILE_SETTINGS } from "./system/profile-store.mjs";
import { createRuntimeSettingsStore } from "./system/runtime-settings-store.mjs";

const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";

test("desired protocol writes require canonical IDs and a valid epoch", async (t) => {
  const fixture = await createFixture(t);
  assert.throws(
    () => fixture.desired.writeForProtocol("MAIN", {
      desiredState: "running",
      settingsEpoch: EPOCH_A,
    }),
    (error) => error.code === "INVALID_PROFILE_ID_CANONICAL_FORM",
  );
  await assert.rejects(
    () => fixture.desired.writeForProtocol("main", { desiredState: "running" }),
    (error) => error.code === "PROFILE_SETTINGS_EPOCH_INVALID",
  );
  await assert.rejects(
    () => fixture.desired.writeForProtocol("main", {
      desiredState: "running",
      settingsEpoch: "old-epoch",
    }),
    (error) => error.code === "PROFILE_SETTINGS_EPOCH_INVALID",
  );

  const written = await fixture.desired.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "running",
    settingsEpoch: EPOCH_A,
  });
  assert.equal(written.profileId, "main");
  assert.equal((await fixture.desired.readForProtocol("main")).settingsEpoch, EPOCH_A);
});

test("desired protocol rejects invalid candidate fields before changing the durable record", async (t) => {
  const fixture = await createFixture(t);
  const running = await fixture.desired.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "scheduled",
    restartAttempt: 0,
    nextRetryAt: "2026-08-10T00:00:02.000Z",
    settingsEpoch: EPOCH_A,
  });
  const target = fixture.desired.filePath("main");
  const before = await readFile(target, "utf8");

  await assert.rejects(
    () => fixture.desired.conditionalWriteForProtocol("main", {
      expectedUpdatedAt: running.updatedAt,
      expectedSettingsEpoch: EPOCH_A,
      expectedDesiredState: "running",
      expectedRecoveryStatus: "scheduled",
      expectedRestartAttempt: 0,
      expectedNextRetryAt: "2026-08-10T00:00:02.000Z",
      patch: { restartAttempt: Number.MAX_SAFE_INTEGER + 1 },
    }),
    (error) => error.code === "DESIRED_RUN_STATE_INVALID",
  );
  assert.equal(await readFile(target, "utf8"), before);

  for (const [profileId, patch] of [
    ["bad-state", { desiredState: "paused", settingsEpoch: EPOCH_A }],
    ["bad-status", { desiredState: "running", recoveryStatus: "future", settingsEpoch: EPOCH_A }],
    ["bad-retry", { desiredState: "running", nextRetryAt: 123, settingsEpoch: EPOCH_A }],
    ["bad-reason", { desiredState: "stopped", lastReason: {}, settingsEpoch: EPOCH_A }],
  ]) {
    await assert.rejects(
      () => fixture.desired.writeForProtocol(profileId, patch),
      (error) => error.code === "DESIRED_RUN_STATE_INVALID",
    );
    await assert.rejects(() => readFile(fixture.desired.filePath(profileId), "utf8"), { code: "ENOENT" });
  }
});

test("canonical migration requires an explicit alias activity authority", () => {
  const runtimeDir = path.join(os.tmpdir(), "xjskp-t4-canonical-authority-probe");
  const runtimeSettingsStore = {
    runtimeDir,
    settingsPath: (profileId) => path.join(runtimeDir, "settings", `${profileId}.json`),
    runCanonicalMigrationExclusive() {},
  };
  const desiredRunStore = {
    dir: path.join(runtimeDir, "system", "desired-runs"),
    filePath: (profileId) => path.join(runtimeDir, "system", "desired-runs", `${profileId}.json`),
    runCanonicalMigrationExclusive() {},
  };

  assert.throws(
    () => createProfileCanonicalMigration({
      runtimeSettingsStore,
      desiredRunStore,
      runtimeDir,
    }),
    /isAliasActive.*required/i,
  );
});

test("desired protocol conditional writes prevent stale confirmation from overwriting stop", async (t) => {
  const fixture = await createFixture(t);
  const running = await fixture.desired.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "starting",
    settingsEpoch: EPOCH_A,
  });
  const stopped = await fixture.desired.conditionalWriteForProtocol("main", {
    expectedUpdatedAt: running.updatedAt,
    expectedSettingsEpoch: EPOCH_A,
    expectedDesiredState: "running",
    expectedRecoveryStatus: "starting",
    patch: {
      desiredState: "stopped",
      recoveryStatus: "stopped",
      lastReason: "user-stopped",
    },
  });
  assert.equal(stopped.matched, true);

  const late = await fixture.desired.conditionalWriteForProtocol("main", {
    expectedUpdatedAt: running.updatedAt,
    expectedSettingsEpoch: EPOCH_A,
    expectedDesiredState: "running",
    expectedRecoveryStatus: "starting",
    patch: { recoveryStatus: "running" },
  });
  assert.equal(late.matched, false);
  assert.equal(late.record.desiredState, "stopped");
  assert.equal(late.record.recoveryStatus, "stopped");
});

test("desired protocol timestamps strictly increase under a fixed clock and stale schedule tokens fail", async (t) => {
  const fixedNow = new Date("2026-08-10T00:00:00.000Z");
  const fixture = await createFixture(t, { now: () => fixedNow });
  const first = await fixture.desired.writeForProtocol("main", {
    desiredState: "running",
    recoveryStatus: "scheduled",
    restartAttempt: 0,
    nextRetryAt: "2026-08-10T00:00:02.000Z",
    settingsEpoch: EPOCH_A,
  });
  const advanced = await fixture.desired.conditionalWriteForProtocol("main", {
    expectedUpdatedAt: first.updatedAt,
    expectedSettingsEpoch: EPOCH_A,
    expectedDesiredState: "running",
    expectedRecoveryStatus: "scheduled",
    expectedRestartAttempt: 0,
    expectedNextRetryAt: "2026-08-10T00:00:02.000Z",
    patch: {
      restartAttempt: 1,
      nextRetryAt: "2026-08-10T00:00:05.000Z",
    },
  });
  assert.equal(advanced.matched, true);
  assert.equal(advanced.record.desiredState, first.desiredState);
  assert.equal(advanced.record.recoveryStatus, first.recoveryStatus);

  const starting = await fixture.desired.conditionalWriteForProtocol("main", {
    expectedUpdatedAt: advanced.record.updatedAt,
    expectedSettingsEpoch: EPOCH_A,
    expectedDesiredState: "running",
    expectedRecoveryStatus: "scheduled",
    expectedRestartAttempt: 1,
    expectedNextRetryAt: "2026-08-10T00:00:05.000Z",
    patch: { recoveryStatus: "starting", nextRetryAt: null },
  });
  assert.equal(starting.matched, true);
  assert.deepEqual([
    first.updatedAt,
    advanced.record.updatedAt,
    starting.record.updatedAt,
  ], [
    "2026-08-10T00:00:00.000Z",
    "2026-08-10T00:00:00.001Z",
    "2026-08-10T00:00:00.002Z",
  ]);

  const stale = await fixture.desired.conditionalWriteForProtocol("main", {
    expectedUpdatedAt: first.updatedAt,
    expectedSettingsEpoch: EPOCH_A,
    expectedDesiredState: "running",
    expectedRecoveryStatus: "scheduled",
    expectedRestartAttempt: 0,
    expectedNextRetryAt: "2026-08-10T00:00:02.000Z",
    patch: { recoveryStatus: "running", nextRetryAt: null },
  });
  assert.equal(stale.matched, false);
  assert.equal(stale.record.restartAttempt, 1);
  assert.equal(stale.record.recoveryStatus, "starting");
  assert.equal(stale.record.nextRetryAt, null);
});

test("desired protocol can block an existing missing-epoch legacy record without binding it", async (t) => {
  const fixture = await createFixture(t);
  const legacy = await fixture.desired.write("main", {
    desiredState: "running",
    recoveryStatus: "scheduled",
  });
  const blocked = await fixture.desired.conditionalWriteForProtocol("main", {
    expectedUpdatedAt: legacy.updatedAt,
    expectedSettingsEpoch: undefined,
    expectedDesiredState: "running",
    expectedRecoveryStatus: "scheduled",
    patch: {
      desiredState: "stopped",
      recoveryStatus: "blocked",
      nextRetryAt: null,
      lastReason: "settings-epoch-confirmation-required",
    },
  });

  assert.equal(blocked.matched, true);
  assert.equal(Object.hasOwn(blocked.record, "settingsEpoch"), false);
  await assert.rejects(
    () => fixture.desired.writeForProtocol("new-profile", {
      desiredState: "stopped",
      recoveryStatus: "blocked",
      lastReason: "settings-epoch-confirmation-required",
    }),
    (error) => error.code === "PROFILE_SETTINGS_EPOCH_INVALID",
  );
});

test("desired protocol can conditionally stop a missing-epoch running legacy record", async (t) => {
  const fixture = await createFixture(t);
  const legacy = await fixture.desired.write("main", {
    desiredState: "running",
    recoveryStatus: "running",
    restartAttempt: 2,
    nextRetryAt: "2026-08-10T00:00:05.000Z",
  });

  const stopped = await fixture.desired.conditionalWriteForProtocol("main", {
    expectedUpdatedAt: legacy.updatedAt,
    expectedSettingsEpoch: undefined,
    expectedDesiredState: "running",
    expectedRecoveryStatus: "running",
    expectedRestartAttempt: 2,
    expectedNextRetryAt: "2026-08-10T00:00:05.000Z",
    patch: {
      desiredState: "stopped",
      recoveryStatus: "stopped",
      nextRetryAt: null,
      lastReason: "user-stopped",
    },
  });
  assert.equal(stopped.matched, true);
  assert.equal(stopped.record.desiredState, "stopped");
  assert.equal(stopped.record.lastReason, "user-stopped");
  assert.equal(Object.hasOwn(stopped.record, "settingsEpoch"), false);
});

test("legacy store APIs never scan or migrate canonical aliases by default", async (t) => {
  const fixture = await createFixture(t);
  await writeRuntimeSource(fixture, "a--b", runtimeSnapshot());
  await writeDesiredSource(fixture, "a--b", desiredRecord("a--b", { settingsEpoch: EPOCH_A }));
  const before = await fixtureTree(fixture.runtimeDir);

  assert.equal(await fixture.desired.read("a-b"), null);
  assert.equal((await fixture.desired.read("a--b")).profileId, "a--b");
  assert.equal((await fixture.desired.list()).length, 1);
  await fixture.runtime.drain("a-b");
  assert.deepEqual(await fixtureTree(fixture.runtimeDir), before);
});

test("read-only canonical inventory discovers aliases and malformed groups without writes", async (t) => {
  let activeCalls = 0;
  const fixture = await createFixture(t, {
    isAliasActive: async () => {
      activeCalls++;
      return false;
    },
  });
  await writeRuntimeSource(fixture, "MAIN", runtimeSnapshot());
  await mkdir(fixture.desired.dir, { recursive: true });
  await writeFile(fixture.desired.filePath("a--b"), "{broken", "utf8");
  await writeDesiredSource(
    fixture,
    "unrelated",
    desiredRecord("OWNER--ID", { settingsEpoch: EPOCH_A }),
  );
  await writeFile(path.join(fixture.desired.dir, "ignored.tmp"), "temporary", "utf8");
  const before = await fixtureTree(fixture.runtimeDir);

  assert.deepEqual(await fixture.migration.listCanonicalIds(), [
    "a-b",
    "main",
    "owner-id",
    "unrelated",
  ]);
  assert.equal(activeCalls, 0);
  assert.deepEqual(await fixtureTree(fixture.runtimeDir), before);
  const malformed = await fixture.migration.reconcile("a-b");
  assert.equal(malformed.status, "collision");
  assert.equal(malformed.reason, "invalid-source");
});

test("single runtime and desired aliases migrate jointly with verified backups and value-free journal", async (t) => {
  const fixture = await createFixture(t);
  await writeRuntimeSource(fixture, "a--b", runtimeSnapshot({ revision: 3 }));
  await writeDesiredSource(fixture, "a--b", desiredRecord("a--b", {
    settingsEpoch: EPOCH_A,
    updatedAt: "2026-08-09T00:00:00.000Z",
  }));

  const first = await fixture.migration.reconcile("a-b");
  assert.equal(first.status, "clear");
  assert.equal(first.canonicalId, "a-b");
  assert.equal(first.migrated, true);
  assert.deepEqual(first.sources.map((source) => source.kind).sort(), ["desired", "runtime"]);
  assert.equal(JSON.stringify(first).includes("teamOrderGuardMultiplier"), false);

  assert.deepEqual(await readJson(fixture.runtime.settingsPath("a-b")), runtimeSnapshot({ revision: 3 }));
  assert.equal((await fixture.desired.readForProtocol("a-b")).profileId, "a-b");
  assert.equal(await exactEntryExists(path.dirname(fixture.runtime.settingsPath("a-b")), "a--b.json"), false);
  assert.equal(await exactEntryExists(fixture.desired.dir, "a--b.json"), false);

  const artifactsBefore = await listFilesRecursive(fixture.backupDir);
  assert.equal(artifactsBefore.some((name) => name.includes("runtime")), true);
  assert.equal(artifactsBefore.some((name) => name.includes("desired")), true);
  const journalName = artifactsBefore.find((name) => name.includes("records") && name.endsWith(".json"));
  assert.ok(journalName);
  const journalText = await readFile(path.join(fixture.backupDir, journalName), "utf8");
  const journal = JSON.parse(journalText);
  assert.deepEqual(Object.keys(journal).sort(), [
    "backupRelativePath",
    "canonicalId",
    "kind",
    "sourceRelativePath",
    "status",
    "timestamp",
    "version",
  ]);
  assert.equal(journal.canonicalId, "a-b");
  assert.equal(journal.status, "complete");
  for (const forbidden of [
    "teamOrderGuardMultiplier",
    "settingsEpoch",
    "desiredState",
    EPOCH_A,
  ]) {
    assert.equal(journalText.includes(forbidden), false, `journal leaked ${forbidden}`);
  }

  const second = await fixture.migration.reconcile("a-b");
  assert.equal(second.status, "clear");
  assert.equal(second.migrated, false);
  assert.deepEqual(await listFilesRecursive(fixture.backupDir), artifactsBefore);
});

test("semantically equal multiple aliases merge despite legacy aliases, formatting, and updatedAt", async (t) => {
  const fixture = await createFixture(t);
  const runtimeA = runtimeSnapshot({ revision: 2 });
  const runtimeB = {
    ...runtimeA,
    autoSubmitOrdinaryResidentOrders: runtimeA.autoSubmitOrdinaryResidentOrdersForLevelUp,
  };
  await writeRuntimeSource(fixture, "a--b", runtimeA);
  await writeRuntimeSource(fixture, "a---b", runtimeB, 0);
  await writeDesiredSource(fixture, "a--b", desiredRecord("a--b", {
    settingsEpoch: EPOCH_A,
    updatedAt: "2026-08-09T00:00:00.000Z",
  }));
  await writeDesiredSource(fixture, "a---b", desiredRecord("a---b", {
    settingsEpoch: EPOCH_A,
    updatedAt: "2026-08-10T00:00:00.000Z",
  }), 0);

  const result = await fixture.migration.reconcile("a-b");
  assert.equal(result.status, "clear");
  assert.equal(result.migrated, true);
  assert.equal((await fixture.desired.readForProtocol("a-b")).settingsEpoch, EPOCH_A);
  assert.equal((await fixture.runtime.readVersionedForProtocol("a-b"))._meta.settingsRevision, 2);
});

test("two missing desired epochs merge but stay missing", async (t) => {
  const fixture = await createFixture(t);
  await writeDesiredSource(fixture, "a--b", desiredRecord("a--b", {
    updatedAt: "2026-08-09T00:00:00.000Z",
  }));
  await writeDesiredSource(fixture, "a---b", desiredRecord("a---b", {
    updatedAt: "2026-08-10T00:00:00.000Z",
  }));

  const result = await fixture.migration.reconcile("a-b");
  assert.equal(result.status, "clear");
  assert.equal(result.migrated, true);
  assert.equal(Object.hasOwn(await fixture.desired.readForProtocol("a-b"), "settingsEpoch"), false);
});

test("runtime conflict blocks the joint migration before desired writes", async (t) => {
  const fixture = await createFixture(t);
  await writeRuntimeSource(fixture, "a--b", runtimeSnapshot({ revision: 1 }));
  await writeRuntimeSource(fixture, "a---b", runtimeSnapshot({ revision: 2 }));
  await writeDesiredSource(fixture, "a--b", desiredRecord("a--b", { settingsEpoch: EPOCH_A }));

  const before = await fixtureTree(fixture.runtimeDir);
  const result = await fixture.migration.reconcile("a-b");
  assert.deepEqual({ status: result.status, code: result.code, reason: result.reason }, {
    status: "collision",
    code: "PROFILE_ID_CANONICAL_COLLISION",
    reason: "semantic-conflict",
  });
  assert.deepEqual(await fixtureTree(fixture.runtimeDir), before);
});

test("missing and present desired epochs collide without touching runtime aliases", async (t) => {
  const fixture = await createFixture(t);
  await writeRuntimeSource(fixture, "a--b", runtimeSnapshot());
  await writeDesiredSource(fixture, "a--b", desiredRecord("a--b"));
  await writeDesiredSource(fixture, "a---b", desiredRecord("a---b", { settingsEpoch: EPOCH_A }));

  const before = await fixtureTree(fixture.runtimeDir);
  const result = await fixture.migration.reconcile("a-b");
  assert.equal(result.status, "collision");
  assert.equal(result.reason, "semantic-conflict");
  assert.deepEqual(await fixtureTree(fixture.runtimeDir), before);
});

test("owner mismatch and malformed raw sources fail closed instead of being ignored", async (t) => {
  await t.test("owner mismatch", async (t) => {
    const fixture = await createFixture(t);
    await writeDesiredSource(fixture, "a--b", desiredRecord("other", { settingsEpoch: EPOCH_A }));
    const before = await fixtureTree(fixture.runtimeDir);
    const result = await fixture.migration.reconcile("a-b");
    assert.equal(result.status, "collision");
    assert.equal(result.reason, "owner-mismatch");
    assert.deepEqual(await fixtureTree(fixture.runtimeDir), before);
  });

  await t.test("malformed runtime JSON", async (t) => {
    const fixture = await createFixture(t);
    await mkdir(path.dirname(fixture.runtime.settingsPath("a--b")), { recursive: true });
    await writeFile(fixture.runtime.settingsPath("a--b"), "{broken", "utf8");
    await writeDesiredSource(fixture, "a--b", desiredRecord("a--b", { settingsEpoch: EPOCH_A }));
    const before = await fixtureTree(fixture.runtimeDir);
    const result = await fixture.migration.reconcile("a-b");
    assert.equal(result.status, "collision");
    assert.equal(result.reason, "invalid-source");
    assert.deepEqual(await fixtureTree(fixture.runtimeDir), before);
  });

  await t.test("unknown future fields", async (t) => {
    const fixture = await createFixture(t);
    await writeRuntimeSource(fixture, "a--b", {
      ...runtimeSnapshot(),
      futureRuntimeSetting: true,
    });
    await writeDesiredSource(fixture, "a--b", {
      ...desiredRecord("a--b", { settingsEpoch: EPOCH_A }),
      futureDesiredState: "unknown",
    });
    const before = await fixtureTree(fixture.runtimeDir);
    const result = await fixture.migration.reconcile("a-b");
    assert.equal(result.status, "collision");
    assert.equal(result.reason, "invalid-source");
    assert.deepEqual(await fixtureTree(fixture.runtimeDir), before);
  });
});

test("active alias blocks both stores with a dedicated code before writes", async (t) => {
  const activeCalls = [];
  const fixture = await createFixture(t, {
    isAliasActive: async (aliasId, context) => {
      activeCalls.push({ aliasId, kind: context.kind });
      return aliasId === "a--b" && context.kind === "desired";
    },
  });
  await writeRuntimeSource(fixture, "a--b", runtimeSnapshot());
  await writeDesiredSource(fixture, "a--b", desiredRecord("a--b", { settingsEpoch: EPOCH_A }));
  const before = await fixtureTree(fixture.runtimeDir);

  const result = await fixture.migration.reconcile("a-b");
  assert.deepEqual({ status: result.status, code: result.code, reason: result.reason }, {
    status: "collision",
    code: "PROFILE_ID_CANONICAL_ALIAS_ACTIVE",
    reason: "active-alias",
  });
  assert.equal(activeCalls.some((call) => call.kind === "runtime"), true);
  assert.equal(activeCalls.some((call) => call.kind === "desired"), true);
  assert.deepEqual(await fixtureTree(fixture.runtimeDir), before);
});

test("case-only aliases stage, verify backup and journal, then promote exact canonical casing", async (t) => {
  const steps = [];
  const fixture = await createFixture(t, {
    onMigrationStep: (step) => steps.push(step),
  });
  await writeRuntimeSource(fixture, "MAIN", runtimeSnapshot());
  await writeDesiredSource(fixture, "MAIN", desiredRecord("MAIN", { settingsEpoch: EPOCH_A }));

  const result = await fixture.migration.reconcile("main");
  assert.equal(result.status, "clear");
  assert.equal(result.migrated, true);
  assert.equal(await exactEntryExists(path.dirname(fixture.runtime.settingsPath("main")), "main.json"), true);
  assert.equal(await exactEntryExists(path.dirname(fixture.runtime.settingsPath("main")), "MAIN.json"), false);
  assert.equal(await exactEntryExists(fixture.desired.dir, "main.json"), true);
  assert.equal(await exactEntryExists(fixture.desired.dir, "MAIN.json"), false);
  assert.ok(steps.indexOf("case-stage-verified") < steps.indexOf("backup-verified"));
  assert.ok(steps.indexOf("backup-verified") < steps.indexOf("journal-prepared"));
  assert.ok(steps.indexOf("journal-prepared") < steps.indexOf("case-promoted"));
});

test("canonical filenames with same-owner aliases are atomically corrected", async (t) => {
  const fixture = await createFixture(t);
  await writeRuntimeSource(fixture, "main", {
    ...runtimeSnapshot(),
    profileId: "MAIN",
  });
  await writeDesiredSource(fixture, "main", desiredRecord("MAIN", { settingsEpoch: EPOCH_A }));

  const result = await fixture.migration.reconcile("main");
  assert.equal(result.status, "clear");
  assert.equal(result.migrated, true);
  assert.equal(Object.hasOwn(await readJson(fixture.runtime.settingsPath("main")), "profileId"), false);
  assert.equal((await fixture.desired.readForProtocol("main")).profileId, "main");
});

test("prepared case-only journal resumes promotion idempotently after an injected interruption", async (t) => {
  let failPromotion = true;
  const fixture = await createFixture(t, {
    beforeMigrationStep(step) {
      if (step === "case-promote" && failPromotion) {
        failPromotion = false;
        throw Object.assign(new Error("injected promotion interruption"), { code: "EINJECT" });
      }
    },
  });
  await writeRuntimeSource(fixture, "MAIN", runtimeSnapshot());
  await writeDesiredSource(fixture, "MAIN", desiredRecord("MAIN", { settingsEpoch: EPOCH_A }));

  await assert.rejects(() => fixture.migration.reconcile("main"), /injected promotion interruption/);
  const resumed = await fixture.migration.reconcile("main");
  assert.equal(resumed.status, "clear");
  assert.equal(await exactEntryExists(path.dirname(fixture.runtime.settingsPath("main")), "main.json"), true);
  assert.equal((await fixture.desired.readForProtocol("main")).profileId, "main");
});

test("prepared recovery rebuilds a canonical desired record from backup when its stage is missing", async (t) => {
  let desiredDir;
  let interrupted = false;
  const fixture = await createFixture(t, {
    async beforeMigrationStep(step) {
      if (step !== "case-promote" || interrupted) return;
      interrupted = true;
      const stage = (await readdir(desiredDir)).find((name) => name.endsWith(".stage"));
      assert.ok(stage);
      await rm(path.join(desiredDir, stage), { force: true });
      throw Object.assign(new Error("injected missing desired stage"), { code: "EINJECT" });
    },
  });
  desiredDir = fixture.desired.dir;
  await writeRuntimeSource(fixture, "MAIN", runtimeSnapshot());
  await writeDesiredSource(fixture, "MAIN", desiredRecord("MAIN", { settingsEpoch: EPOCH_A }));

  await assert.rejects(() => fixture.migration.reconcile("main"), /injected missing desired stage/);
  const resumed = await fixture.migration.reconcile("main");
  assert.equal(resumed.status, "clear");
  assert.equal((await fixture.desired.readForProtocol("main")).profileId, "main");
  const records = (await listFilesRecursive(fixture.backupDir))
    .filter((name) => name.includes("records") && name.endsWith(".json"));
  assert.equal(records.length, 2);
});

test("prepared recovery repeats active and semantic preflight before any resumed writes", async (t) => {
  await t.test("new active alias", async (t) => {
    let failPromotion = true;
    let active = false;
    const fixture = await createFixture(t, {
      isAliasActive: async () => active,
      beforeMigrationStep(step) {
        if (step === "case-promote" && failPromotion) {
          failPromotion = false;
          throw Object.assign(new Error("pause before promotion"), { code: "EINJECT" });
        }
      },
    });
    await writeRuntimeSource(fixture, "MAIN", runtimeSnapshot());
    await writeDesiredSource(fixture, "MAIN", desiredRecord("MAIN", { settingsEpoch: EPOCH_A }));
    await assert.rejects(() => fixture.migration.reconcile("main"), /pause before promotion/);
    active = true;
    const before = await fixtureTree(fixture.runtimeDir);

    const blocked = await fixture.migration.reconcile("main");
    assert.equal(blocked.code, "PROFILE_ID_CANONICAL_ALIAS_ACTIVE");
    assert.deepEqual(await fixtureTree(fixture.runtimeDir), before);
  });

  await t.test("new conflicting alias", async (t) => {
    let pauseCompletion = true;
    const fixture = await createFixture(t, {
      beforeMigrationStep(step) {
        if (step === "journal-complete" && pauseCompletion) {
          pauseCompletion = false;
          throw Object.assign(new Error("pause before completion"), { code: "EINJECT" });
        }
      },
    });
    await writeRuntimeSource(fixture, "a--b", runtimeSnapshot({ revision: 1 }));
    await writeDesiredSource(fixture, "a--b", desiredRecord("a--b", { settingsEpoch: EPOCH_A }));
    await assert.rejects(() => fixture.migration.reconcile("a-b"), /pause before completion/);
    await writeRuntimeSource(fixture, "a---b", runtimeSnapshot({ revision: 2 }));
    const before = await fixtureTree(fixture.runtimeDir);

    const blocked = await fixture.migration.reconcile("a-b");
    assert.equal(blocked.status, "collision");
    assert.equal(blocked.reason, "semantic-conflict");
    assert.deepEqual(await fixtureTree(fixture.runtimeDir), before);
  });
});

test("normal migration verifies target before backup and safely retries a backup interruption", async (t) => {
  let failBackup = true;
  const steps = [];
  const fixture = await createFixture(t, {
    beforeMigrationStep(step) {
      if (step === "backup-write" && failBackup) {
        failBackup = false;
        throw Object.assign(new Error("injected backup interruption"), { code: "EINJECT" });
      }
    },
    onMigrationStep: (step) => steps.push(step),
  });
  await writeRuntimeSource(fixture, "a--b", runtimeSnapshot());
  await writeDesiredSource(fixture, "a--b", desiredRecord("a--b", { settingsEpoch: EPOCH_A }));

  await assert.rejects(() => fixture.migration.reconcile("a-b"), /injected backup interruption/);
  assert.equal(await exactEntryExists(path.dirname(fixture.runtime.settingsPath("a-b")), "a--b.json"), true);
  assert.equal(await exactEntryExists(fixture.desired.dir, "a--b.json"), true);

  const result = await fixture.migration.reconcile("a-b");
  assert.equal(result.status, "clear");
  assert.ok(steps.indexOf("target-verified") < steps.indexOf("backup-verified"));
});

test("a failed normal target verification removes the bad target and leaves all aliases recoverable", async (t) => {
  let corruptTarget = true;
  let fixture;
  fixture = await createFixture(t, {
    async beforeMigrationStep(step, context) {
      if (step !== "target-verify" || context.kind !== "runtime" || !corruptTarget) return;
      corruptTarget = false;
      await writeFile(fixture.runtime.settingsPath("a-b"), "{corrupt", "utf8");
    },
  });
  await writeRuntimeSource(fixture, "a--b", runtimeSnapshot());
  await writeDesiredSource(fixture, "a--b", desiredRecord("a--b", { settingsEpoch: EPOCH_A }));

  await assert.rejects(
    () => fixture.migration.reconcile("a-b"),
    (error) => error.code === "PROFILE_CANONICAL_MIGRATION_TARGET_VERIFY_FAILED",
  );
  assert.equal(await exactEntryExists(path.dirname(fixture.runtime.settingsPath("a-b")), "a-b.json"), false);
  assert.equal(await exactEntryExists(path.dirname(fixture.runtime.settingsPath("a-b")), "a--b.json"), true);
  assert.equal(await exactEntryExists(fixture.desired.dir, "a--b.json"), true);

  const recovered = await fixture.migration.reconcile("a-b");
  assert.equal(recovered.status, "clear");
});

test("concurrent reconcile calls share canonical store locks and migrate only once", async (t) => {
  const fixture = await createFixture(t);
  await writeRuntimeSource(fixture, "a--b", runtimeSnapshot());
  await writeDesiredSource(fixture, "a--b", desiredRecord("a--b", { settingsEpoch: EPOCH_A }));

  const results = await Promise.all([
    fixture.migration.reconcile("a-b"),
    fixture.migration.reconcile("a-b"),
  ]);
  assert.deepEqual(results.map((result) => result.migrated).sort(), [false, true]);
  const records = (await listFilesRecursive(fixture.backupDir))
    .filter((name) => name.includes("records") && name.endsWith(".json"));
  assert.equal(records.length, 2);
});

async function createFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xjskp-t4-canonical-"));
  const runtimeDir = path.join(root, "runtime");
  const runtime = createRuntimeSettingsStore({ runtimeDir });
  let clock = 0;
  const desired = createDesiredRunStore({
    runtimeDir,
    now: options.now || (() => new Date(Date.UTC(2026, 7, 10, 0, 0, clock++))),
  });
  const backupDir = path.join(runtimeDir, "system", "canonical-migration-backups");
  const migration = createProfileCanonicalMigration({
    runtimeSettingsStore: runtime,
    desiredRunStore: desired,
    runtimeDir,
    backupDir,
    isAliasActive: options.isAliasActive || (async () => false),
    beforeMigrationStep: options.beforeMigrationStep,
    onMigrationStep: options.onMigrationStep,
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, runtimeDir, runtime, desired, migration, backupDir };
}

function runtimeSnapshot(options = {}) {
  return {
    ...DEFAULT_PROFILE_SETTINGS,
    _meta: {
      settingsEpoch: options.epoch || EPOCH_A,
      settingsRevision: options.revision ?? 1,
    },
  };
}

function desiredRecord(profileId, options = {}) {
  return {
    version: 1,
    profileId,
    mode: "loop",
    desiredState: options.desiredState || "running",
    restartAttempt: options.restartAttempt ?? 0,
    recoveryStatus: options.recoveryStatus || "scheduled",
    nextRetryAt: options.nextRetryAt ?? null,
    lastReason: options.lastReason ?? "network",
    updatedAt: options.updatedAt || "2026-08-10T00:00:00.000Z",
    ...(Object.hasOwn(options, "settingsEpoch")
      ? { settingsEpoch: options.settingsEpoch }
      : {}),
  };
}

async function writeRuntimeSource(fixture, sourceId, value, spaces = 2) {
  const filePath = fixture.runtime.settingsPath(sourceId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, spaces)}\n`, "utf8");
}

async function writeDesiredSource(fixture, sourceId, value, spaces = 2) {
  await mkdir(fixture.desired.dir, { recursive: true });
  await writeFile(fixture.desired.filePath(sourceId), `${JSON.stringify(value, null, spaces)}\n`, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function exactEntryExists(directory, name) {
  try {
    return (await readdir(directory)).includes(name);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function listFilesRecursive(root, relative = "") {
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFilesRecursive(root, next));
    else files.push(next);
  }
  return files;
}

async function fixtureTree(root) {
  const files = await listFilesRecursive(root);
  return await Promise.all(files.map(async (name) => [
    name,
    await readFile(path.join(root, name), "utf8"),
  ]));
}
