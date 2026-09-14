import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRuntimeSettingsStore } from "./system/runtime-settings-store.mjs";

test("runtime settings store serializes one profile and drains the newest queued settings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runtime-settings-store-"));
  let releaseFirstWrite;
  const firstWriteGate = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  let firstWriteStarted;
  const firstWriteStartedPromise = new Promise((resolve) => {
    firstWriteStarted = resolve;
  });
  let writeCount = 0;
  const fileSystem = {
    ...fsPromises,
    async writeFile(filePath, data, options) {
      const result = await fsPromises.writeFile(filePath, data, options);
      if (++writeCount === 1) {
        firstWriteStarted();
        await firstWriteGate;
      }
      return result;
    },
  };
  const store = createRuntimeSettingsStore({ runtimeDir: dir, fs: fileSystem });
  try {
    const first = store.write("main", { pearlHireItemReserveCount: 6 });
    await firstWriteStartedPromise;
    const second = store.write("main", {
      experienceGuardThresholdPercent: 0.37,
      pearlHireItemReserveCount: 20,
      teamOrderTriggerProtectionEnabled: false,
    });
    releaseFirstWrite();
    await first;
    await store.drain("main");
    await second;

    const settings = JSON.parse(await fsPromises.readFile(store.settingsPath("main"), "utf8"));
    assert.equal(settings.experienceGuardThresholdPercent, 0.37);
    assert.equal(settings.pearlHireItemReserveCount, 20);
    assert.equal(settings.teamOrderTriggerProtectionEnabled, false);
  } finally {
    releaseFirstWrite();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime settings store keeps waterwheel switches isolated per profile", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-runtime-waterwheel-settings-"));
  const store = createRuntimeSettingsStore({ runtimeDir: dir });
  try {
    await Promise.all([
      store.write("main", {
        autoReceiveWaterwheelBuckets: false,
        skipWaterwheelVideoBuckets: true,
      }),
      store.write("alt", {
        autoReceiveWaterwheelBuckets: true,
        skipWaterwheelVideoBuckets: false,
      }),
    ]);

    const [main, alt] = await Promise.all([
      fsPromises.readFile(store.settingsPath("main"), "utf8").then(JSON.parse),
      fsPromises.readFile(store.settingsPath("alt"), "utf8").then(JSON.parse),
    ]);
    assert.deepEqual(
      {
        autoReceiveWaterwheelBuckets: main.autoReceiveWaterwheelBuckets,
        skipWaterwheelVideoBuckets: main.skipWaterwheelVideoBuckets,
      },
      {
        autoReceiveWaterwheelBuckets: false,
        skipWaterwheelVideoBuckets: true,
      },
    );
    assert.deepEqual(
      {
        autoReceiveWaterwheelBuckets: alt.autoReceiveWaterwheelBuckets,
        skipWaterwheelVideoBuckets: alt.skipWaterwheelVideoBuckets,
      },
      {
        autoReceiveWaterwheelBuckets: true,
        skipWaterwheelVideoBuckets: false,
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
