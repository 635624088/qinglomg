import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { commitCompatibleGameCodeBundle } from "./game-code-version.mjs";
import { commitCompatibleGameDataBundle } from "./game-data-version.mjs";
import {
  readActiveGameRelease,
  readActiveGameReleasePointerSnapshot,
  restoreActiveGameReleasePointer,
  writeActiveGameReleasePointer,
} from "./game-release-version.mjs";

test("one release pointer resolves a complete code and data pair", async (t) => {
  const fixture = await createFixture(t);
  const code = await makeCodeBundle(fixture, "401.0.1", "candidate-code");
  const data = await makeDataBundle(fixture, "abc12", "401.0.1");
  const active = await writeActiveGameReleasePointer({
    rootDir: fixture.rootDir,
    codeBundleId: code.bundleId,
    dataVersion: data.dataVersion,
  });
  assert.equal(active.code.bundleId, code.bundleId);
  assert.equal(active.data.dataVersion, "abc12");
  assert.equal(active.code.appVersion, active.data.sourceCodeVersion);
});

test("caches one active release and invalidates it when bundle content changes", async (t) => {
  const fixture = await createFixture(t);
  const code = await makeCodeBundle(fixture, "401.0.1", "cached-code");
  const data = await makeDataBundle(fixture, "abc12", "401.0.1");
  await writeActiveGameReleasePointer({
    rootDir: fixture.rootDir,
    codeBundleId: code.bundleId,
    dataVersion: data.dataVersion,
  });

  const first = readActiveGameRelease({ rootDir: fixture.rootDir });
  const second = readActiveGameRelease({ rootDir: fixture.rootDir });
  assert.ok(first);
  assert.strictEqual(second, first);

  const gameJs = first.code.gameJsPath;
  const original = await fsp.readFile(gameJs);
  await fsp.writeFile(gameJs, Buffer.concat([original, Buffer.from("\nchanged")]));
  try {
    assert.equal(readActiveGameRelease({ rootDir: fixture.rootDir }), null);
  } finally {
    await fsp.writeFile(gameJs, original);
  }

  const recovered = readActiveGameRelease({ rootDir: fixture.rootDir });
  assert.ok(recovered);
  assert.notStrictEqual(recovered, first);
});

test("release pointer rejects mixed sources and preserves old release on rename failure", async (t) => {
  const fixture = await createFixture(t);
  const oldCode = await makeCodeBundle(fixture, "391.0.25", "old-code");
  const oldData = await makeDataBundle(fixture, "aaa11", "391.0.25");
  await writeActiveGameReleasePointer({ rootDir: fixture.rootDir, codeBundleId: oldCode.bundleId, dataVersion: oldData.dataVersion });
  const snapshot = readActiveGameReleasePointerSnapshot({ rootDir: fixture.rootDir });
  const newCode = await makeCodeBundle(fixture, "401.0.1", "new-code");
  const wrongData = await makeDataBundle(fixture, "bbb22", "400.0.1");
  await assert.rejects(
    writeActiveGameReleasePointer({ rootDir: fixture.rootDir, codeBundleId: newCode.bundleId, dataVersion: wrongData.dataVersion }),
    { code: "GAME_RELEASE_SOURCE_MISMATCH" },
  );
  const renameFailureFs = { ...fsp, async rename() { const error = new Error("busy"); error.code = "EPERM"; throw error; } };
  const newData = await makeDataBundle(fixture, "ccc33", "401.0.1");
  await assert.rejects(writeActiveGameReleasePointer({
    rootDir: fixture.rootDir,
    codeBundleId: newCode.bundleId,
    dataVersion: newData.dataVersion,
    fileSystem: renameFailureFs,
    renameRetryDelaysMs: [],
  }), /busy/);
  assert.deepEqual(readActiveGameReleasePointerSnapshot({ rootDir: fixture.rootDir }), snapshot);
  await restoreActiveGameReleasePointer(snapshot, { rootDir: fixture.rootDir });
  assert.equal(readActiveGameRelease({ rootDir: fixture.rootDir }).code.appVersion, "391.0.25");
});

async function createFixture(t) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-release-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  await fsp.mkdir(path.join(rootDir, "candidates"), { recursive: true });
  return { rootDir };
}

async function makeCodeBundle(fixture, appVersion, content) {
  const packageDir = path.join(fixture.rootDir, "candidates", `${appVersion}-${content}`);
  await fsp.mkdir(path.join(packageDir, "tar"), { recursive: true });
  await fsp.writeFile(path.join(packageDir, "Manifest.xml"), `<package><appVersion>${appVersion}</appVersion></package>`);
  await fsp.writeFile(path.join(packageDir, "tar", "game.js"), content);
  await fsp.writeFile(path.join(packageDir, "tar", "modules.json"), "{}");
  return commitCompatibleGameCodeBundle({
    rootDir: fixture.rootDir,
    packageDir,
    appVersion,
    compatibilityReport: { status: "compatible" },
  });
}

async function makeDataBundle(fixture, dataVersion, sourceCodeVersion) {
  const configPath = path.join(fixture.rootDir, "candidates", `g-data.${dataVersion}.text`);
  await fsp.writeFile(configPath, JSON.stringify({ dataVersion }));
  return commitCompatibleGameDataBundle({
    rootDir: fixture.rootDir,
    dataVersion,
    sourceCodeVersion,
    configPath,
    flowerNames: { 1: "花" },
    compatibilityReport: { schemaVersion: 1, status: "compatible", dataVersion, file: {
      bytes: Buffer.byteLength(JSON.stringify({ dataVersion })),
      sha256: crypto.createHash("sha256").update(JSON.stringify({ dataVersion })).digest("hex"),
    } },
  });
}
