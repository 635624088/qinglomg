import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createSystemSettingsStore } from "./system/system-settings-store.mjs";

test("system settings store writes allowed hosts and reads them back", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-system-settings-store-"));
  const store = createSystemSettingsStore({ runtimeDir: dir });
  try {
    await store.write({ allowedHosts: ["100.66.1.2"] });
    assert.deepEqual(await store.read(), { allowedHosts: ["100.66.1.2"] });

    const onDisk = JSON.parse(await fsPromises.readFile(store.settingsPath(), "utf8"));
    assert.deepEqual(onDisk, { allowedHosts: ["100.66.1.2"] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system settings store overwrites previous values with the latest write", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-system-settings-store-"));
  const store = createSystemSettingsStore({ runtimeDir: dir });
  try {
    await store.write({ allowedHosts: ["100.66.1.2"] });
    await store.write({ allowedHosts: ["100.66.1.2", "xxx.jdxb.com:8080"] });
    assert.deepEqual(await store.read(), {
      allowedHosts: ["100.66.1.2", "xxx.jdxb.com:8080"],
    });

    await store.write({ allowedHosts: [] });
    assert.deepEqual(await store.read(), { allowedHosts: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system settings store normalizes entries and drops unsupported keys", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-system-settings-store-"));
  const store = createSystemSettingsStore({ runtimeDir: dir });
  try {
    await store.write({
      allowedHosts: [" 100.66.1.2 ", "", null, 123, "xxx.jdxb.com"],
      extraKey: "ignored",
    });
    assert.deepEqual(await store.read(), {
      allowedHosts: ["100.66.1.2", "xxx.jdxb.com"],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system settings store read returns defaults for missing, empty, or corrupt files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-system-settings-store-"));
  const store = createSystemSettingsStore({ runtimeDir: dir });
  try {
    assert.deepEqual(await store.read(), { allowedHosts: [] });

    await fsPromises.mkdir(path.dirname(store.settingsPath()), { recursive: true });
    await fsPromises.writeFile(store.settingsPath(), "", "utf8");
    assert.deepEqual(await store.read(), { allowedHosts: [] });

    await fsPromises.writeFile(store.settingsPath(), "{ not valid json", "utf8");
    assert.deepEqual(await store.read(), { allowedHosts: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system settings store exists reports whether the settings file is present", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-system-settings-store-"));
  const store = createSystemSettingsStore({ runtimeDir: dir });
  try {
    assert.equal(await store.exists(), false);
    await store.write({ allowedHosts: [] });
    assert.equal(await store.exists(), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("system settings store serializes queued writes and keeps the latest content", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-system-settings-store-"));
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
  const store = createSystemSettingsStore({ runtimeDir: dir, fs: fileSystem });
  try {
    const first = store.write({ allowedHosts: ["100.66.1.2"] });
    await firstWriteStartedPromise;
    const second = store.write({ allowedHosts: ["100.66.1.3"] });
    releaseFirstWrite();
    await first;
    await store.drain();
    await second;

    assert.deepEqual(await store.read(), { allowedHosts: ["100.66.1.3"] });
  } finally {
    releaseFirstWrite();
    await rm(dir, { recursive: true, force: true });
  }
});
