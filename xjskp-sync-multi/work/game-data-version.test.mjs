import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getDefaultFlowerNamePaths,
  readActiveGameDataBundle,
  registerCurrentGameDataBaseline,
  writeActiveGameDataPointer,
} from "./game-data-version.mjs";

test("readActiveGameDataBundle resolves only a complete compatible version bundle", async (t) => {
  const rootDir = await createTempRoot(t);
  await writeBundle(rootDir, "2f3f6", {
    sourceCodeVersion: "391.0.25",
    flowerNames: { 23070: "活跃花" },
  });
  await writePointer(rootDir, "2f3f6");

  const active = readActiveGameDataBundle({ rootDir });

  assert.equal(active.dataVersion, "2f3f6");
  assert.equal(active.sourceCodeVersion, "391.0.25");
  assert.equal(
    active.staticConfigPath,
    path.join(rootDir, "runtime", "game-data", "versions", "2f3f6", "g-data.2f3f6.text"),
  );
  assert.equal(
    active.flowerNamesPath,
    path.join(rootDir, "runtime", "game-data", "versions", "2f3f6", "flower-names.json"),
  );
});

test("readActiveGameDataBundle rejects traversal, incomplete, and unverified pointers", async (t) => {
  const cases = [
    { token: "../outside", setup: async () => {} },
    { token: "missing", setup: async () => {} },
    {
      token: "abc12",
      setup: async (rootDir) => writeBundle(rootDir, "abc12", { compatibilityStatus: "manual-review" }),
    },
  ];

  for (const item of cases) {
    const rootDir = await createTempRoot(t);
    await item.setup(rootDir);
    await writePointer(rootDir, item.token);
    assert.equal(readActiveGameDataBundle({ rootDir }), null, item.token);
  }
});

test("readActiveGameDataBundle rejects pointer schema and manifest evidence mismatches", async (t) => {
  const rootDir = await createTempRoot(t);
  await writeBundle(rootDir, "2f3f6");
  await writePointer(rootDir, "2f3f6", { schemaVersion: 2 });
  assert.equal(readActiveGameDataBundle({ rootDir }), null);

  await writePointer(rootDir, "2f3f6");
  const configPath = path.join(
    rootDir,
    "runtime",
    "game-data",
    "versions",
    "2f3f6",
    "g-data.2f3f6.text",
  );
  await fsp.writeFile(configPath, "tampered", "utf8");
  assert.equal(readActiveGameDataBundle({ rootDir }), null);
});

test("writeActiveGameDataPointer validates the bundle and preserves the previous pointer on rename failure", async (t) => {
  const rootDir = await createTempRoot(t);
  await writeBundle(rootDir, "aaa11");
  await writeBundle(rootDir, "bbb22");
  await writeActiveGameDataPointer({ rootDir, dataVersion: "aaa11" });

  const failingFs = {
    ...fsp,
    async rename() {
      const error = new Error("rename blocked");
      error.code = "EPERM";
      throw error;
    },
  };
  await assert.rejects(
    writeActiveGameDataPointer({ rootDir, dataVersion: "bbb22", fileSystem: failingFs }),
    /rename blocked/,
  );

  assert.equal(readActiveGameDataBundle({ rootDir }).dataVersion, "aaa11");
  const statusDir = path.join(rootDir, "runtime", "status");
  assert.equal(
    (await fsp.readdir(statusDir)).some((name) => name.endsWith(".tmp")),
    false,
  );
});

test("registerCurrentGameDataBaseline copies the current legacy files and activates the registered bundle", async (t) => {
  const rootDir = await createTempRoot(t);
  const workDir = path.join(rootDir, "work");
  await fsp.mkdir(workDir, { recursive: true });
  const staticConfigPath = path.join(workDir, "g-data.2f3f6.text");
  const flowerNamesPath = path.join(workDir, "flower-names.json");
  await fsp.writeFile(staticConfigPath, JSON.stringify({ baseline: true }), "utf8");
  await fsp.writeFile(flowerNamesPath, JSON.stringify({ 23070: "基线花" }), "utf8");

  const active = await registerCurrentGameDataBaseline({
    rootDir,
    staticConfigPath,
    flowerNamesPath,
    sourceCodeVersion: "391.0.25",
    now: () => new Date("2026-08-12T04:00:00.000Z"),
  });

  assert.equal(active.dataVersion, "2f3f6");
  assert.equal(JSON.parse(await fsp.readFile(active.staticConfigPath, "utf8")).baseline, true);
  assert.equal(JSON.parse(await fsp.readFile(active.flowerNamesPath, "utf8"))[23070], "基线花");
  assert.equal(await fsp.readFile(staticConfigPath, "utf8"), JSON.stringify({ baseline: true }));
  assert.equal(
    JSON.parse(await fsp.readFile(active.manifestPath, "utf8")).registeredAt,
    "2026-08-12T04:00:00.000Z",
  );

  const second = await registerCurrentGameDataBaseline({
    rootDir,
    staticConfigPath,
    flowerNamesPath,
    sourceCodeVersion: "should-not-overwrite",
  });
  assert.equal(second.sourceCodeVersion, "391.0.25");
});

test("registerCurrentGameDataBaseline rejects source files outside the application root", async (t) => {
  const rootDir = await createTempRoot(t);
  const outsideDir = await createTempRoot(t);
  const workDir = path.join(rootDir, "work");
  await fsp.mkdir(workDir, { recursive: true });
  const staticConfigPath = path.join(workDir, "g-data.2f3f6.text");
  const flowerNamesPath = path.join(outsideDir, "flower-names.json");
  await fsp.writeFile(staticConfigPath, "{}", "utf8");
  await fsp.writeFile(flowerNamesPath, "{}", "utf8");

  await assert.rejects(
    registerCurrentGameDataBaseline({ rootDir, staticConfigPath, flowerNamesPath }),
    (error) => error?.code === "GAME_DATA_BASELINE_PATH_OUTSIDE_ROOT",
  );
});

test("getDefaultFlowerNamePaths keeps active and legacy mappings mutually exclusive", async (t) => {
  const rootDir = await createTempRoot(t);
  await writeBundle(rootDir, "2f3f6");
  await writePointer(rootDir, "2f3f6");

  assert.deepEqual(getDefaultFlowerNamePaths({ rootDir }), [
    path.join(rootDir, "runtime", "game-data", "versions", "2f3f6", "flower-names.json"),
  ]);
});

async function createTempRoot(t) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-game-data-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

async function writePointer(rootDir, dataVersion, overrides = {}) {
  const statusDir = path.join(rootDir, "runtime", "status");
  await fsp.mkdir(statusDir, { recursive: true });
  await fsp.writeFile(
    path.join(statusDir, "game-data-active.json"),
    `${JSON.stringify({ schemaVersion: 1, activeDataVersion: dataVersion, ...overrides }, null, 2)}\n`,
    "utf8",
  );
}

async function writeBundle(rootDir, dataVersion, options = {}) {
  const versionDir = path.join(rootDir, "runtime", "game-data", "versions", dataVersion);
  await fsp.mkdir(versionDir, { recursive: true });
  const compatibilityStatus = options.compatibilityStatus || "compatible";
  const configFile = `g-data.${dataVersion}.text`;
  const configText = "{}";
  const flowerNamesText = JSON.stringify(options.flowerNames || { 23070: "测试花" });
  const compatibilityReportText = JSON.stringify({ schemaVersion: 1, dataVersion, status: compatibilityStatus });
  await fsp.writeFile(path.join(versionDir, configFile), configText, "utf8");
  await fsp.writeFile(
    path.join(versionDir, "flower-names.json"),
    flowerNamesText,
    "utf8",
  );
  await fsp.writeFile(
    path.join(versionDir, "compatibility-report.json"),
    compatibilityReportText,
    "utf8",
  );
  await fsp.writeFile(
    path.join(versionDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      dataVersion,
      sourceCodeVersion: options.sourceCodeVersion || null,
      configFile,
      flowerNamesFile: "flower-names.json",
      compatibilityReportFile: "compatibility-report.json",
      compatibilityStatus,
      files: {
        [configFile]: fileEvidence(configText),
        "flower-names.json": fileEvidence(flowerNamesText),
        "compatibility-report.json": fileEvidence(compatibilityReportText),
      },
    }),
    "utf8",
  );
}

function fileEvidence(text) {
  return {
    bytes: Buffer.byteLength(text),
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}
