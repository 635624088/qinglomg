import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_PROFILE_SETTINGS,
  normalizeProfileSettings,
} from "./system/profile-store.mjs";
import { createRuntimeSettingsStore } from "./system/runtime-settings-store.mjs";

const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";

function snapshot(overrides = {}) {
  return {
    settings: { ...DEFAULT_PROFILE_SETTINGS },
    settingsEpoch: EPOCH_A,
    settingsRevision: 2,
    settingsKeyRevisions: Object.fromEntries(
      Object.keys(DEFAULT_PROFILE_SETTINGS).map((key) => [key, 2]),
    ),
    ...overrides,
  };
}

async function createFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-settings-t3-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const store = createRuntimeSettingsStore({
    runtimeDir,
    fs: options.fileSystem || fs,
  });
  return { root, runtimeDir, store };
}

async function writeRaw(runtimeDir, profileId, value) {
  const filePath = path.join(runtimeDir, "settings", `${profileId}.json`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return filePath;
}

test("versioned runtime publish writes 13 flat keys plus epoch/revision metadata", async (t) => {
  const { store } = await createFixture(t);
  const expected = snapshot();
  await store.publishVersionedForProtocol("p1", expected);
  const raw = JSON.parse(await fs.readFile(store.settingsPath("p1"), "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), [...Object.keys(DEFAULT_PROFILE_SETTINGS), "_meta"].sort());
  assert.deepEqual(raw._meta, {
    settingsEpoch: EPOCH_A,
    settingsRevision: 2,
  });
  assert.deepEqual(
    Object.fromEntries(Object.keys(DEFAULT_PROFILE_SETTINGS).map((key) => [key, raw[key]])),
    expected.settings,
  );
  assert.equal(normalizeProfileSettings(raw).pearlHireItemReserveCount, 100);
});

test("versioned runtime publish carries the customer order reward release mask as a scalar", async (t) => {
  const { store } = await createFixture(t);
  const expected = snapshot({
    settings: {
      ...DEFAULT_PROFILE_SETTINGS,
      customerOrderFlowerCurrencyRewardReleaseMask: 5,
    },
  });
  await store.publishVersionedForProtocol("p1", expected);
  const raw = JSON.parse(await fs.readFile(store.settingsPath("p1"), "utf8"));
  assert.equal(raw.customerOrderFlowerCurrencyRewardReleaseMask, 5);
  assert.equal(
    (await store.compareVersionedForProtocol("p1", expected)).classification,
    "synced",
  );
});

test("versioned runtime comparison distinguishes every synchronization class", async (t) => {
  const { runtimeDir, store } = await createFixture(t);
  const expected = snapshot();
  assert.equal((await store.compareVersionedForProtocol("p1", expected)).classification, "missing");

  await writeRaw(runtimeDir, "p1", expected.settings);
  assert.equal((await store.compareVersionedForProtocol("p1", expected)).classification, "legacy");

  await writeRaw(runtimeDir, "p1", {
    _meta: { settingsEpoch: EPOCH_A, settingsRevision: 2 },
  });
  assert.equal((await store.compareVersionedForProtocol("p1", expected)).classification, "content-mismatch");

  await writeRaw(runtimeDir, "p1", {
    ...expected.settings,
    pearlHireItemReserveCount: -1,
    _meta: { settingsEpoch: EPOCH_A, settingsRevision: 2 },
  });
  assert.equal((await store.compareVersionedForProtocol("p1", expected)).classification, "content-mismatch");

  await writeRaw(runtimeDir, "p1", {
    ...expected.settings,
    _meta: { settingsEpoch: EPOCH_B, settingsRevision: 2 },
  });
  assert.equal((await store.compareVersionedForProtocol("p1", expected)).classification, "epoch-mismatch");

  await writeRaw(runtimeDir, "p1", {
    ...expected.settings,
    _meta: { settingsEpoch: EPOCH_A, settingsRevision: 1 },
  });
  assert.equal((await store.compareVersionedForProtocol("p1", expected)).classification, "revision-mismatch");

  await writeRaw(runtimeDir, "p1", {
    ...expected.settings,
    pearlHireItemReserveCount: 1,
    _meta: { settingsEpoch: EPOCH_A, settingsRevision: 2 },
  });
  assert.equal((await store.compareVersionedForProtocol("p1", expected)).classification, "content-mismatch");

  await store.publishVersionedForProtocol("p1", expected);
  assert.equal((await store.compareVersionedForProtocol("p1", expected)).classification, "synced");
});

test("versioned runtime APIs reject an invalid or non-canonical expected snapshot", async (t) => {
  const { store } = await createFixture(t);
  for (const invalidSettings of [
    { ...DEFAULT_PROFILE_SETTINGS, pearlHireItemReserveCount: -1 },
    { ...DEFAULT_PROFILE_SETTINGS, unknownSetting: true },
  ]) {
    const invalid = snapshot({ settings: invalidSettings });
    assert.throws(
      () => store.compareVersionedForProtocol("p1", invalid),
      /complete versioned runtime settings snapshot/,
    );
    assert.throws(
      () => store.publishVersionedForProtocol("p1", invalid),
      /complete versioned runtime settings snapshot/,
    );
    assert.throws(
      () => store.reconcileVersionedForProtocol("p1", invalid),
      /complete versioned runtime settings snapshot/,
    );
  }
});

test("versioned reconcile repairs once and performs no write when already synced", async (t) => {
  let writes = 0;
  const fileSystem = {
    ...fs,
    writeFile: async (...args) => {
      writes += 1;
      return fs.writeFile(...args);
    },
  };
  const { store } = await createFixture(t, { fileSystem });
  const expected = snapshot();
  const repaired = await store.reconcileVersionedForProtocol("p1", expected);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.previousClassification, "missing");
  assert.equal(writes, 1);
  const unchanged = await store.reconcileVersionedForProtocol("p1", expected);
  assert.equal(unchanged.repaired, false);
  assert.equal(unchanged.previousClassification, "synced");
  assert.equal(writes, 1);
});

test("versioned reconcile rebuilds syntactically damaged and non-object derived files", async (t) => {
  const { runtimeDir, store } = await createFixture(t);
  const filePath = path.join(runtimeDir, "settings", "p1.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  for (const damagedContent of ["{broken-json", "[]\n"]) {
    await fs.writeFile(filePath, damagedContent, "utf8");
    const result = await store.reconcileVersionedForProtocol("p1", snapshot());
    assert.equal(result.repaired, true);
    assert.equal(result.previousClassification, "content-mismatch");
    assert.equal(
      (await store.compareVersionedForProtocol("p1", snapshot())).classification,
      "synced",
    );
  }
});

test("six concurrent versioned reconciles join one actual repair", async (t) => {
  let writes = 0;
  const fileSystem = {
    ...fs,
    writeFile: async (...args) => {
      writes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return fs.writeFile(...args);
    },
  };
  const { store } = await createFixture(t, { fileSystem });
  const results = await Promise.all(
    Array.from({ length: 6 }, () => store.reconcileVersionedForProtocol("p1", snapshot())),
  );
  assert.equal(writes, 1);
  assert.equal(results.filter((result) => result.repaired).length, 6);
  assert.equal((await store.compareVersionedForProtocol("p1", snapshot())).classification, "synced");
});

test("failed versioned repair is atomic and clears its single-flight", async (t) => {
  let renames = 0;
  const fileSystem = {
    ...fs,
    rename: async (...args) => {
      renames += 1;
      if (renames === 1) throw new Error("controlled runtime rename failure");
      return fs.rename(...args);
    },
  };
  const { runtimeDir, store } = await createFixture(t, { fileSystem });
  await assert.rejects(
    store.reconcileVersionedForProtocol("p1", snapshot()),
    /controlled runtime rename failure/,
  );
  assert.equal((await store.compareVersionedForProtocol("p1", snapshot())).classification, "missing");
  assert.deepEqual(
    (await fs.readdir(path.join(runtimeDir, "settings")).catch(() => []))
      .filter((name) => name.includes(".tmp")),
    [],
  );
  assert.equal((await store.reconcileVersionedForProtocol("p1", snapshot())).repaired, true);
  assert.equal(renames, 2);
});

test("failed versioned repair preserves an existing legacy runtime file", async (t) => {
  const fileSystem = {
    ...fs,
    rename: async () => {
      throw new Error("controlled replacement failure");
    },
  };
  const { runtimeDir, store } = await createFixture(t, { fileSystem });
  const filePath = await writeRaw(runtimeDir, "p1", {
    ...DEFAULT_PROFILE_SETTINGS,
    pearlHireItemReserveCount: 9,
  });
  const before = await fs.readFile(filePath, "utf8");
  await assert.rejects(
    store.reconcileVersionedForProtocol("p1", snapshot()),
    /controlled replacement failure/,
  );
  assert.equal(await fs.readFile(filePath, "utf8"), before);
  assert.deepEqual(
    (await fs.readdir(path.dirname(filePath))).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("a newer queued runtime target still runs when the older flight fails", async (t) => {
  let renames = 0;
  const fileSystem = {
    ...fs,
    rename: async (...args) => {
      renames += 1;
      if (renames === 1) throw new Error("controlled older target failure");
      return fs.rename(...args);
    },
  };
  const { store } = await createFixture(t, { fileSystem });
  const older = snapshot({ settingsRevision: 1 });
  const newer = snapshot({
    settings: { ...DEFAULT_PROFILE_SETTINGS, pearlHireItemReserveCount: 77 },
    settingsRevision: 2,
  });
  const first = store.reconcileVersionedForProtocol("p1", older);
  const second = store.reconcileVersionedForProtocol("p1", newer);
  await assert.rejects(first, /controlled older target failure/);
  assert.equal((await second).repaired, true);
  assert.equal((await store.compareVersionedForProtocol("p1", newer)).classification, "synced");
  assert.equal(renames, 2);
});
