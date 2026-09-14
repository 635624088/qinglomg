import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  compareGameVersions,
  createGameVersionService,
} from "./system/game-version-service.mjs";

test("compareGameVersions covers unknown, same, newer, older, and different", () => {
  assert.equal(compareGameVersions("391.0.17", null), "unknown");
  assert.equal(compareGameVersions("391.0.17", "391.0.17"), "same");
  assert.equal(compareGameVersions("391.0.17", "392.0.1"), "newer");
  assert.equal(compareGameVersions("391.0.17", "390.9.9"), "older");
  assert.equal(compareGameVersions("391.0.17", "release-next"), "different");
});

test("getStatus reads the local manifest and cache without credentials or network", async (t) => {
  const fixture = await createFixture(t);
  const service = createGameVersionService({
    ...fixture.options,
    profileStore: {
      loadProfileCredentialFields: async () => assert.fail("GET must not read credentials"),
      listProfiles: async () => assert.fail("GET must not select profiles"),
    },
    queryLatestVersion: async () => assert.fail("GET must not query the network"),
  });

  assert.deepEqual(await service.getStatus(), {
    localVersion: "391.0.17",
    remoteVersion: null,
    comparison: "unknown",
    lastSuccessfulCheckAt: null,
    lastAttemptAt: null,
    lastError: null,
    sourceProfileId: null,
    checking: false,
  });
});

test("manual check reads only three required fields and writes a secret-free global cache", async (t) => {
  const fixture = await createFixture(t);
  const requestedFields = [];
  const service = createGameVersionService({
    ...fixture.options,
    now: () => new Date("2026-08-03T05:00:00.000Z"),
    profileStore: {
      async loadProfileCredentialFields(profileId, fields) {
        assert.equal(profileId, "main");
        requestedFields.push(...fields);
        return completeCredentials();
      },
    },
    async queryLatestVersion({ credentials, signal }) {
      assert.deepEqual(credentials, completeCredentials());
      assert.equal(signal.aborted, false);
      return "392.0.1";
    },
  });

  const status = await service.check("main");
  const cacheText = await fs.readFile(fixture.cachePath, "utf8");
  assert.deepEqual(requestedFields, ["CTOKEN", "PC_USER_ID", "PC_TOKEN"]);
  assert.equal(status.comparison, "newer");
  assert.equal(status.remoteVersion, "392.0.1");
  assert.doesNotMatch(cacheText, /ct-secret|pc-secret|2088/);
});

test("scheduled check prefers the last successful complete profile then falls back deterministically", async (t) => {
  const fixture = await createFixture(t, {
    cache: {
      remoteVersion: "391.0.17",
      lastSuccessfulCheckAt: "2026-08-02T07:00:00.000Z",
      sourceProfileId: "preferred",
    },
  });
  const loaded = [];
  const profiles = [
    { id: "first", hasCredentials: true },
    { id: "preferred", hasCredentials: true },
    { id: "broken", hasCredentials: false },
  ];
  const service = createGameVersionService({
    ...fixture.options,
    profileStore: {
      listProfiles: async () => profiles,
      async loadProfileCredentialFields(profileId) {
        loaded.push(profileId);
        return completeCredentials();
      },
    },
    queryLatestVersion: async () => "391.0.17",
  });

  await service.checkScheduled();
  assert.deepEqual(loaded, ["preferred"]);

  profiles.splice(1, 1);
  await service.checkScheduled();
  assert.deepEqual(loaded, ["preferred", "first"]);
});

test("failed check retains the last successful remote version and uses a safe error", async (t) => {
  const fixture = await createFixture(t, {
    cache: {
      localVersion: "391.0.17",
      remoteVersion: "392.0.1",
      lastSuccessfulCheckAt: "2026-08-02T07:00:00.000Z",
      sourceProfileId: "main",
    },
  });
  const service = createGameVersionService({
    ...fixture.options,
    profileStore: { loadProfileCredentialFields: async () => completeCredentials() },
    queryLatestVersion: async () => {
      const error = new Error("upstream secret body");
      error.code = "VERSION_CHECK_UPSTREAM_ERROR";
      throw error;
    },
  });

  await assert.rejects(service.check("main"), (error) => (
    error.code === "VERSION_CHECK_UPSTREAM_ERROR"
    && error.message === "官方版本服务暂不可用"
  ));
  const status = await service.getStatus();
  assert.equal(status.remoteVersion, "392.0.1");
  assert.equal(status.comparison, "newer");
  assert.deepEqual(status.lastError, {
    code: "VERSION_CHECK_UPSTREAM_ERROR",
    message: "官方版本服务暂不可用",
  });
  assert.doesNotMatch(await fs.readFile(fixture.cachePath, "utf8"), /upstream secret body/);
});

test("version check aborts and returns a safe timeout after the configured deadline", async (t) => {
  const fixture = await createFixture(t);
  let querySignal;
  const service = createGameVersionService({
    ...fixture.options,
    timeoutMs: 5,
    profileStore: { loadProfileCredentialFields: async () => completeCredentials() },
    queryLatestVersion: ({ signal }) => {
      querySignal = signal;
      return new Promise(() => {});
    },
  });

  await assert.rejects(service.check("main"), (error) => (
    error.statusCode === 504 && error.code === "VERSION_CHECK_TIMEOUT"
  ));
  assert.equal(querySignal.aborted, true);
});

function completeCredentials() {
  return { CTOKEN: "ct-secret", PC_USER_ID: "2088", PC_TOKEN: "pc-secret" };
}

async function createFixture(t, { cache } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-version-service-"));
  const runtimeDir = path.join(rootDir, "runtime");
  const manifestDir = path.join(rootDir, "work", "game-pkg-latest");
  const cachePath = path.join(runtimeDir, "status", "game-version-status.json");
  await fs.mkdir(manifestDir, { recursive: true });
  await fs.writeFile(
    path.join(manifestDir, "Manifest.xml"),
    "<package><appVersion>391.0.17</appVersion></package>",
    "utf8",
  );
  if (cache) {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, `${JSON.stringify(cache)}\n`, "utf8");
  }
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  return { options: { rootDir, runtimeDir }, cachePath };
}
