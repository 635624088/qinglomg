import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_PROFILE_SETTINGS,
  createProfileStore,
} from "./system/profile-store.mjs";

const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";

async function createFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-settings-t3-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const accountsDir = path.join(root, "accounts");
  await fs.mkdir(accountsDir, { recursive: true });
  const epochs = [...(options.epochs || [EPOCH_A, EPOCH_B])];
  const store = createProfileStore({
    accountsDir,
    createSettingsEpoch: () => epochs.shift(),
    fs: options.fileSystem || fs,
    protect: (value) => `protected:${value}`,
    unprotect: (value) => value.replace(/^protected:/, ""),
  });
  return { root, accountsDir, store };
}

async function writeRecord(accountsDir, id, overrides = {}) {
  const record = {
    version: 1,
    id,
    label: id,
    settings: { ...DEFAULT_PROFILE_SETTINGS },
    secrets: { CTOKEN: "protected-value" },
    ...overrides,
  };
  await fs.writeFile(
    path.join(accountsDir, `${id}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  return record;
}

async function readRecord(accountsDir, id) {
  return JSON.parse(await fs.readFile(path.join(accountsDir, `${id}.json`), "utf8"));
}

test("R0 load initializes only the epoch and exposes logical revision zero", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1");

  const loaded = await store.readSettingsStateForProtocol("p1");
  assert.equal(loaded.snapshot.settingsEpoch, EPOCH_A);
  assert.equal(loaded.snapshot.settingsRevision, 0);
  assert.deepEqual(
    loaded.snapshot.settingsKeyRevisions,
    Object.fromEntries(Object.keys(DEFAULT_PROFILE_SETTINGS).map((key) => [key, 0])),
  );
  const persisted = await readRecord(accountsDir, "p1");
  assert.equal(persisted.settingsEpoch, EPOCH_A);
  assert.equal(Object.hasOwn(persisted, "settingsRevision"), false);
  assert.equal(Object.hasOwn(persisted, "settingsKeyRevisions"), false);
});

test("R0 with an existing epoch is a compatible read with no repair write", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1", { settingsEpoch: EPOCH_A });
  const filePath = path.join(accountsDir, "p1.json");
  const before = await fs.readFile(filePath, "utf8");

  const loaded = await store.readSettingsStateForProtocol("p1");
  assert.equal(loaded.snapshot.settingsRevision, 0);
  assert.equal(loaded.persisted, false);
  assert.equal(await fs.readFile(filePath, "utf8"), before);
});

test("revision repair fills canonical keys conservatively and removes the legacy alias", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1", {
    settingsEpoch: EPOCH_A,
    settingsRevision: 7,
    settingsKeyRevisions: {
      pearlHireItemReserveCount: 3,
      autoSubmitOrdinaryResidentOrders: 2,
      autoSubmitCyclicStoryOrders: -1,
    },
  });

  const loaded = await store.readSettingsStateForProtocol("p1");
  assert.equal(loaded.snapshot.settingsKeyRevisions.pearlHireItemReserveCount, 3);
  assert.equal(loaded.snapshot.settingsKeyRevisions.autoSubmitCyclicStoryOrders, 7);
  assert.equal(
    loaded.snapshot.settingsKeyRevisions.autoSubmitOrdinaryResidentOrdersForLevelUp,
    7,
  );
  assert.equal(
    Object.keys(loaded.snapshot.settingsKeyRevisions).length,
    Object.keys(DEFAULT_PROFILE_SETTINGS).length,
  );
  const persisted = await readRecord(accountsDir, "p1");
  assert.equal(Object.hasOwn(persisted.settingsKeyRevisions, "autoSubmitOrdinaryResidentOrders"), false);
});

test("coordinated protocol load atomically repairs a mismatched record ID", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  const settings = { ...DEFAULT_PROFILE_SETTINGS, pearlHireItemReserveCount: 66 };
  await writeRecord(accountsDir, "p1", {
    id: "P 1",
    settings,
    settingsEpoch: EPOCH_A,
    settingsRevision: 4,
    settingsKeyRevisions: keyRevisionsForTest(4),
  });
  const loaded = await store.readSettingsStateForProtocol("p1");
  assert.equal(loaded.profile.id, "p1");
  assert.equal(loaded.snapshot.settingsEpoch, EPOCH_A);
  assert.equal(loaded.snapshot.settingsRevision, 4);
  assert.deepEqual(loaded.snapshot.settings, settings);
  const persisted = await readRecord(accountsDir, "p1");
  assert.equal(persisted.id, "p1");
  assert.equal(persisted.settingsEpoch, EPOCH_A);
  assert.equal(persisted.settingsRevision, 4);
  assert.deepEqual(persisted.settingsKeyRevisions, keyRevisionsForTest(4));
  assert.deepEqual(persisted.settings, settings);
});

test("invalid revision models fail closed without changing the record", async (t) => {
  const invalidModels = [
    { settingsKeyRevisions: {} },
    { settingsRevision: -1 },
    { settingsRevision: 1, settingsKeyRevisions: [] },
    { settingsRevision: 1, settingsKeyRevisions: { pearlHireItemReserveCount: 2 } },
    { settingsRevision: 1, settingsKeyRevisions: { unknownSetting: 0 } },
  ];
  for (let index = 0; index < invalidModels.length; index += 1) {
    const id = `p${index}`;
    const { accountsDir, store } = await createFixture(t);
    await writeRecord(accountsDir, id, { settingsEpoch: EPOCH_A, ...invalidModels[index] });
    const filePath = path.join(accountsDir, `${id}.json`);
    const before = await fs.readFile(filePath, "utf8");
    await assert.rejects(
      store.readSettingsStateForProtocol(id),
      (error) => error?.code === "PROFILE_SETTINGS_REVISION_INVALID",
    );
    assert.equal(await fs.readFile(filePath, "utf8"), before);
  }

  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "bad-id-and-revision", {
    id: "Bad Record ID",
    settingsEpoch: EPOCH_A,
    settingsKeyRevisions: {},
  });
  const filePath = path.join(accountsDir, "bad-id-and-revision.json");
  const before = await fs.readFile(filePath, "utf8");
  await assert.rejects(
    store.readSettingsStateForProtocol("bad-id-and-revision"),
    (error) => error?.code === "PROFILE_SETTINGS_REVISION_INVALID",
  );
  assert.equal(await fs.readFile(filePath, "utf8"), before);
});

test("invalid epoch and revision overflow fail closed", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "bad-epoch", {
    settingsEpoch: "not-a-uuid",
  });
  await assert.rejects(
    store.readSettingsStateForProtocol("bad-epoch"),
    (error) => error?.code === "PROFILE_SETTINGS_EPOCH_INVALID",
  );

  await writeRecord(accountsDir, "max-revision", {
    settingsEpoch: EPOCH_A,
    settingsRevision: Number.MAX_SAFE_INTEGER,
    settingsKeyRevisions: keyRevisionsForTest(Number.MAX_SAFE_INTEGER),
  });
  const loaded = await store.readSettingsStateForProtocol("max-revision");
  await assert.rejects(
    store.compareAndWriteTentativeSettingsForProtocol("max-revision", {
      expectedSnapshot: loaded.snapshot,
      patch: { pearlHireItemReserveCount: 77 },
    }),
    (error) => error?.code === "PROFILE_SETTINGS_REVISION_INVALID",
  );
  assert.equal((await readRecord(accountsDir, "max-revision")).settingsRevision, Number.MAX_SAFE_INTEGER);
});

test("protocol writes reject snapshots outside the exact canonical schema", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1", { settingsEpoch: EPOCH_A });
  const loaded = (await store.readSettingsStateForProtocol("p1")).snapshot;
  const filePath = path.join(accountsDir, "p1.json");
  const before = await fs.readFile(filePath, "utf8");

  await assert.rejects(
    store.compareAndWriteTentativeSettingsForProtocol("p1", {
      expectedSnapshot: {
        ...loaded,
        settings: { ...loaded.settings, unknownSetting: true },
      },
      patch: { pearlHireItemReserveCount: 77 },
    }),
    TypeError,
  );
  await assert.rejects(
    store.conditionalRollbackSettingsForProtocol("p1", {
      tentativeSnapshot: loaded,
      previousSnapshot: {
        ...loaded,
        settingsKeyRevisions: {
          ...loaded.settingsKeyRevisions,
          unknownSetting: 0,
        },
      },
    }),
    TypeError,
  );
  assert.equal(await fs.readFile(filePath, "utf8"), before);
});

test("epoch initialization rename failure leaves the legacy record and no tmp file", async (t) => {
  const fileSystem = {
    ...fs,
    rename: async () => {
      throw new Error("controlled epoch initialization failure");
    },
  };
  const { accountsDir, store } = await createFixture(t, { fileSystem });
  await writeRecord(accountsDir, "p1");
  const filePath = path.join(accountsDir, "p1.json");
  const before = await fs.readFile(filePath, "utf8");
  await assert.rejects(
    store.readSettingsStateForProtocol("p1"),
    /controlled epoch initialization failure/,
  );
  assert.equal(await fs.readFile(filePath, "utf8"), before);
  assert.deepEqual(
    (await fs.readdir(accountsDir)).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("deleting and rebuilding the same profile ID creates a new epoch", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1");
  assert.equal((await store.readSettingsStateForProtocol("p1")).snapshot.settingsEpoch, EPOCH_A);
  await fs.rm(path.join(accountsDir, "p1.json"));
  await writeRecord(accountsDir, "p1");
  assert.equal((await store.readSettingsStateForProtocol("p1")).snapshot.settingsEpoch, EPOCH_B);
});

test("tentative multi-field writes one revision and no-op writes nothing", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1", { settingsEpoch: EPOCH_A });
  const base = (await store.readSettingsStateForProtocol("p1")).snapshot;
  const changed = await store.compareAndWriteTentativeSettingsForProtocol("p1", {
    expectedSnapshot: base,
    patch: {
      autoSubmitCyclicStoryOrders: true,
      pearlHireItemReserveCount: 77,
    },
  });
  assert.equal(changed.applied, true);
  assert.equal(changed.snapshot.settingsRevision, 1);
  assert.equal(changed.snapshot.settingsKeyRevisions.autoSubmitCyclicStoryOrders, 1);
  assert.equal(changed.snapshot.settingsKeyRevisions.pearlHireItemReserveCount, 1);
  assert.equal(changed.snapshot.settingsKeyRevisions.teamOrderGuardMultiplier, 0);

  const filePath = path.join(accountsDir, "p1.json");
  const beforeNoop = await fs.readFile(filePath, "utf8");
  const noOp = await store.compareAndWriteTentativeSettingsForProtocol("p1", {
    expectedSnapshot: changed.snapshot,
    patch: { pearlHireItemReserveCount: 77 },
  });
  assert.equal(noOp.applied, false);
  assert.equal(await fs.readFile(filePath, "utf8"), beforeNoop);
});

test("conditional rollback restores settings state and preserves newer metadata", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1", {
    settingsEpoch: EPOCH_A,
    lastValidatedAt: null,
  });
  const previous = (await store.readSettingsStateForProtocol("p1")).snapshot;
  const tentative = await store.compareAndWriteTentativeSettingsForProtocol("p1", {
    expectedSnapshot: previous,
    patch: { pearlHireItemReserveCount: 55 },
  });
  const currentRecord = await readRecord(accountsDir, "p1");
  currentRecord.lastValidatedAt = "2026-08-10T00:00:00.000Z";
  currentRecord.label = "new label";
  await fs.writeFile(
    path.join(accountsDir, "p1.json"),
    `${JSON.stringify(currentRecord, null, 2)}\n`,
    "utf8",
  );

  const rolledBack = await store.conditionalRollbackSettingsForProtocol("p1", {
    tentativeSnapshot: tentative.snapshot,
    previousSnapshot: previous,
  });
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(rolledBack.snapshot.settingsRevision, 0);
  assert.equal(rolledBack.snapshot.settings.pearlHireItemReserveCount, 100);
  const persisted = await readRecord(accountsDir, "p1");
  assert.equal(persisted.lastValidatedAt, "2026-08-10T00:00:00.000Z");
  assert.equal(persisted.label, "new label");
  assert.deepEqual(persisted.secrets, { CTOKEN: "protected-value" });
});

test("conditional rollback refuses to overwrite a different current tuple", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1", { settingsEpoch: EPOCH_A });
  const previous = (await store.readSettingsStateForProtocol("p1")).snapshot;
  const tentative = await store.compareAndWriteTentativeSettingsForProtocol("p1", {
    expectedSnapshot: previous,
    patch: { pearlHireItemReserveCount: 55 },
  });
  const record = await readRecord(accountsDir, "p1");
  record.settings.pearlHireItemReserveCount = 66;
  await fs.writeFile(
    path.join(accountsDir, "p1.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  const result = await store.conditionalRollbackSettingsForProtocol("p1", {
    tentativeSnapshot: tentative.snapshot,
    previousSnapshot: previous,
  });
  assert.equal(result.rolledBack, false);
  assert.equal((await readRecord(accountsDir, "p1")).settings.pearlHireItemReserveCount, 66);
});

test("protocol settings writes share the legacy profile metadata queue", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1", {
    settingsEpoch: EPOCH_A,
    settingsRevision: 0,
    settingsKeyRevisions: Object.fromEntries(
      Object.keys(DEFAULT_PROFILE_SETTINGS).map((key) => [key, 0]),
    ),
  });
  const base = (await store.readSettingsStateForProtocol("p1")).snapshot;
  const tentativePromise = store.compareAndWriteTentativeSettingsForProtocol("p1", {
    expectedSnapshot: base,
    patch: { pearlHireItemReserveCount: 44 },
  });
  const validatedPromise = store.markValidated(
    "p1",
    new Date("2026-08-10T01:02:03.000Z"),
    { serverIdx: 9 },
  );
  const [tentative] = await Promise.all([tentativePromise, validatedPromise]);
  assert.equal(tentative.applied, true);
  const persisted = await readRecord(accountsDir, "p1");
  assert.equal(persisted.settings.pearlHireItemReserveCount, 44);
  assert.equal(persisted.settingsRevision, 1);
  assert.equal(persisted.lastValidatedAt, "2026-08-10T01:02:03.000Z");
  assert.equal(persisted.serverIdx, 9);
});

test("validation and credential reset preserve an existing protocol tuple", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1", {
    settingsEpoch: EPOCH_A,
    settingsRevision: 4,
    settingsKeyRevisions: keyRevisionsForTest(4),
  });
  await store.markValidated("p1", new Date("2026-08-10T02:03:04.000Z"), { serverIdx: 8 });
  await store.resetCredentials("p1");
  const persisted = await readRecord(accountsDir, "p1");
  assert.equal(persisted.settingsEpoch, EPOCH_A);
  assert.equal(persisted.settingsRevision, 4);
  assert.deepEqual(persisted.settingsKeyRevisions, keyRevisionsForTest(4));
  assert.deepEqual(persisted.secrets, {});
});

test("credential-only re-import preserves an existing protocol tuple and settings", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  const settings = { ...DEFAULT_PROFILE_SETTINGS, pearlHireItemReserveCount: 66 };
  await writeRecord(accountsDir, "p1", {
    settings,
    settingsEpoch: EPOCH_A,
    settingsRevision: 4,
    settingsKeyRevisions: keyRevisionsForTest(4),
  });
  await store.importProfile({
    id: "p1",
    label: "updated label",
    credentials: { PC_USER_ID: "p1" },
  });
  const persisted = await readRecord(accountsDir, "p1");
  assert.equal(persisted.label, "updated label");
  assert.equal(persisted.settingsEpoch, EPOCH_A);
  assert.equal(persisted.settingsRevision, 4);
  assert.deepEqual(persisted.settingsKeyRevisions, keyRevisionsForTest(4));
  assert.deepEqual(persisted.settings, settings);
});

test("legacy settings entry points fail closed for any existing protocol marker", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1", {
    settingsEpoch: EPOCH_A,
    settingsRevision: 1,
    settingsKeyRevisions: keyRevisionsForTest(1),
  });
  const filePath = path.join(accountsDir, "p1.json");
  const before = await fs.readFile(filePath, "utf8");
  await assert.rejects(
    store.updateProfileSettings("p1", { pearlHireItemReserveCount: 77 }),
    (error) => error?.code === "PROFILE_SETTINGS_PRECONDITION_REQUIRED" && error?.statusCode === 428,
  );
  assert.equal(await fs.readFile(filePath, "utf8"), before);
  await assert.rejects(
    store.importProfile({
      id: "p1",
      credentials: { PC_USER_ID: "p1" },
      settings: {},
    }),
    (error) => error?.code === "PROFILE_SETTINGS_IMPORT_NOT_SUPPORTED" && error?.statusCode === 400,
  );
  assert.equal(await fs.readFile(filePath, "utf8"), before);

  await writeRecord(accountsDir, "partial", { settingsRevision: 1 });
  const partialPath = path.join(accountsDir, "partial.json");
  const partialBefore = await fs.readFile(partialPath, "utf8");
  await assert.rejects(
    store.updateProfileSettings("partial", { pearlHireItemReserveCount: 77 }),
    (error) => error?.code === "PROFILE_SETTINGS_PRECONDITION_REQUIRED",
  );
  assert.equal(await fs.readFile(partialPath, "utf8"), partialBefore);
});

test("legacy settings methods do not initialize protocol metadata in T3", async (t) => {
  const { accountsDir, store } = await createFixture(t);
  await writeRecord(accountsDir, "p1");
  await store.getProfile("p1");
  await store.updateProfileSettings("p1", { pearlHireItemReserveCount: 88 });
  const persisted = await readRecord(accountsDir, "p1");
  assert.equal(persisted.settings.pearlHireItemReserveCount, 88);
  assert.equal(Object.hasOwn(persisted, "settingsEpoch"), false);
  assert.equal(Object.hasOwn(persisted, "settingsRevision"), false);
  assert.equal(Object.hasOwn(persisted, "settingsKeyRevisions"), false);
});

function keyRevisionsForTest(revision) {
  return Object.fromEntries(
    Object.keys(DEFAULT_PROFILE_SETTINGS).map((key) => [key, revision]),
  );
}
