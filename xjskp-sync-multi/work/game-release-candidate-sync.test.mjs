import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { commitCompatibleGameCodeBundle } from "./game-code-version.mjs";
import {
  commitCompatibleGameDataBundle,
  readActiveGameDataPointerSnapshot,
  writeActiveGameDataPointer,
} from "./game-data-version.mjs";
import {
  readActiveGameRelease,
  readActiveGameReleasePointerSnapshot,
  writeActiveGameReleasePointer,
} from "./game-release-version.mjs";
import { syncGameReleaseCandidate } from "./game-release-candidate-sync.mjs";

test("offline compatible code and data activate through one joint release pointer", async (t) => {
  const fixture = await createFixture(t);
  const phases = [];

  const result = await syncGameReleaseCandidate({
    rootDir: fixture.rootDir,
    prepareDataCandidate: async () => fixture.prepared,
    auditCodeCandidate: () => ({ status: "compatible", reasons: [], schemaAudit: {} }),
    verifyActivation: async (active) => {
      assert.equal(active.code.appVersion, "401.0.1");
      assert.equal(active.data.dataVersion, "bbb02");
    },
    onPhase: async (phase) => phases.push(phase),
  });

  assert.equal(result.status, "latest");
  assert.equal(result.activeCodeVersion, "401.0.1");
  assert.equal(result.activeDataVersion, "bbb02");
  assert.equal(result.codeCompatibilityStatus, "compatible");
  assert.equal(result.dataCompatibilityStatus, "compatible");
  assert.deepEqual(phases, ["stage", "pointer", "verify"]);
  const active = readActiveGameRelease({ rootDir: fixture.rootDir });
  assert.equal(active.code.gameJsSha256, sha256("candidate-code"));
  assert.equal(active.data.dataVersion, "bbb02");
});

test("incompatible code keeps the complete old joint release active", async (t) => {
  const fixture = await createFixture(t);
  const before = readActiveGameReleasePointerSnapshot({ rootDir: fixture.rootDir });

  const result = await syncGameReleaseCandidate({
    rootDir: fixture.rootDir,
    prepareDataCandidate: async () => fixture.prepared,
    auditCodeCandidate: () => ({ status: "incompatible", reasons: ["missing-interface:gs.foo"] }),
  });

  assert.equal(result.status, "incompatible");
  assert.equal(result.codeCompatibilityStatus, "incompatible");
  assert.deepEqual(readActiveGameReleasePointerSnapshot({ rootDir: fixture.rootDir }), before);
  assert.equal(readActiveGameRelease({ rootDir: fixture.rootDir }).code.appVersion, "400.0.1");
  assert.equal(readActiveGameRelease({ rootDir: fixture.rootDir }).data.dataVersion, "aaa01");
});

test("activation verification failure restores the previous joint pointer", async (t) => {
  const fixture = await createFixture(t);
  const before = readActiveGameReleasePointerSnapshot({ rootDir: fixture.rootDir });

  await assert.rejects(
    syncGameReleaseCandidate({
      rootDir: fixture.rootDir,
      prepareDataCandidate: async () => fixture.prepared,
      auditCodeCandidate: () => ({ status: "compatible", reasons: [] }),
      verifyActivation: async () => {
        throw Object.assign(new Error("worker release mismatch"), { code: "GAME_RELEASE_VERIFY_FAILED" });
      },
    }),
    (error) => error?.code === "GAME_RELEASE_VERIFY_FAILED",
  );

  assert.deepEqual(readActiveGameReleasePointerSnapshot({ rootDir: fixture.rootDir }), before);
  const active = readActiveGameRelease({ rootDir: fixture.rootDir });
  assert.equal(active.code.appVersion, "400.0.1");
  assert.equal(active.data.dataVersion, "aaa01");
});

test("a newer compatible code release can reuse byte-identical active data", async (t) => {
  const fixture = await createFixture(t);
  const packageDir = await writePackage(fixture.rootDir, "401.0.7", "candidate-code-40107", "same-data-code");
  const activeData = fixture.prepared.activeBefore;
  const reusedCandidate = {
    ...fixture.prepared.candidate,
    dataVersion: activeData.dataVersion,
    sourceCodeVersion: "401.0.7",
    configPath: activeData.staticConfigPath,
    packageDir,
    gameJsPath: path.join(packageDir, "tar", "game.js"),
  };

  const result = await syncGameReleaseCandidate({
    rootDir: fixture.rootDir,
    prepareDataCandidate: async () => ({
      ...fixture.prepared,
      candidate: reusedCandidate,
      sameAsActive: true,
    }),
    auditCodeCandidate: () => ({ status: "compatible", reasons: [], schemaAudit: {} }),
  });

  assert.equal(result.status, "latest");
  const active = readActiveGameRelease({ rootDir: fixture.rootDir });
  assert.equal(active.code.appVersion, "401.0.7");
  assert.equal(active.data.dataVersion, "aaa01");
  assert.equal(active.data.sourceCodeVersion, "400.0.1");
});

test("joint release sync uses joint active data when the legacy data pointer is stale", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-stale-data-pointer-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootDir, "runtime", "status"), { recursive: true });

  const legacyData = await commitData(rootDir, "f0e8e", "411.0.10", "legacy-data");
  const jointData = await commitData(rootDir, "d2ea9", "411.0.22", "joint-data");
  await writeActiveGameDataPointer({ rootDir, dataVersion: legacyData.dataVersion });
  const oldCode = await commitCode(rootDir, "411.0.22", "old-code", "old-joint-code");
  await writeActiveGameReleasePointer({
    rootDir,
    codeBundleId: oldCode.bundleId,
    dataVersion: jointData.dataVersion,
  });

  const packageDir = await writePackage(rootDir, "411.0.23", "new-code", "new-joint-code");
  let seenBaselinePath = null;
  const result = await syncGameReleaseCandidate({
    rootDir,
    sourceCodeVersion: "411.0.23",
    discoverCandidate: async ({ candidateDir }) => {
      const configPath = path.join(candidateDir, "g-data.d2ea9.text");
      await fs.mkdir(candidateDir, { recursive: true });
      await fs.writeFile(configPath, "joint-data", "utf8");
      return {
        dataVersion: "d2ea9",
        sourceCodeVersion: "411.0.23",
        configPath,
        packageDir,
        gameJsPath: path.join(packageDir, "tar", "game.js"),
        calls: ["static-file"],
      };
    },
    auditCandidate: ({ baselinePath }) => {
      seenBaselinePath = baselinePath;
      return {
        status: "compatible",
        reasons: [],
        flowerNames: { 1: "测试花" },
        loaderAudit: { compatible: true, loaderCount: 17, results: [] },
        diff: { tables: {} },
      };
    },
    auditCodeCandidate: () => ({ status: "compatible", reasons: [], schemaAudit: {} }),
  });

  assert.equal(result.status, "latest");
  assert.equal(result.activeCodeVersion, "411.0.23");
  assert.equal(result.activeDataVersion, "d2ea9");
  assert.equal(seenBaselinePath, jointData.staticConfigPath);
  const activePointer = readActiveGameReleasePointerSnapshot({ rootDir });
  assert.equal(activePointer.dataRevalidatedForCodeVersion, "411.0.23");
  assert.equal(readActiveGameDataPointerSnapshot({ rootDir }).activeDataVersion, "f0e8e");
});

async function createFixture(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-release-sync-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootDir, "runtime", "status"), { recursive: true });

  const baselineCode = await commitCode(rootDir, "400.0.1", "baseline-code", "baseline");
  const baselineData = await commitData(rootDir, "aaa01", "400.0.1", "baseline-data");
  await writeActiveGameReleasePointer({
    rootDir,
    codeBundleId: baselineCode.bundleId,
    dataVersion: baselineData.dataVersion,
  });

  const packageDir = await writePackage(rootDir, "401.0.1", "candidate-code", "candidate");
  const candidateDir = path.join(rootDir, "runtime", "game-data", "candidates", "offline-job");
  await fs.mkdir(candidateDir, { recursive: true });
  const configPath = path.join(candidateDir, "g-data.bbb02.text");
  await fs.writeFile(configPath, "candidate-data", "utf8");
  const candidate = {
    dataVersion: "bbb02",
    sourceCodeVersion: "401.0.1",
    configPath,
    packageDir,
    gameJsPath: path.join(packageDir, "tar", "game.js"),
    package: { bytes: 123, sha256: "a".repeat(64) },
  };
  const prepared = {
    status: "compatible",
    activeBefore: baselineData,
    candidate,
    audit: {
      status: "compatible",
      reasons: [],
      flowerNames: { 1: "测试花" },
      loaderAudit: { loaderCount: 17 },
    },
    report: { status: "compatible", reasons: [] },
    reportPath: path.join(candidateDir, "compatibility-report.json"),
    sameAsActive: false,
  };
  return { rootDir, prepared };
}

async function commitCode(rootDir, appVersion, gameJs, name) {
  const packageDir = await writePackage(rootDir, appVersion, gameJs, name);
  return commitCompatibleGameCodeBundle({
    rootDir,
    packageDir,
    compatibilityReport: { status: "compatible" },
  });
}

async function writePackage(rootDir, appVersion, gameJs, name) {
  const packageDir = path.join(rootDir, "candidates", `${name}-${appVersion}`);
  await fs.mkdir(path.join(packageDir, "tar"), { recursive: true });
  await fs.writeFile(path.join(packageDir, "Manifest.xml"), `<manifest><appVersion>${appVersion}</appVersion></manifest>`, "utf8");
  await fs.writeFile(path.join(packageDir, "tar", "game.js"), gameJs, "utf8");
  await fs.writeFile(path.join(packageDir, "tar", "modules.json"), "{}", "utf8");
  return packageDir;
}

async function commitData(rootDir, dataVersion, sourceCodeVersion, text) {
  const configPath = path.join(rootDir, "candidates", `g-data.${dataVersion}.text`);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, text, "utf8");
  return commitCompatibleGameDataBundle({
    rootDir,
    dataVersion,
    sourceCodeVersion,
    configPath,
    flowerNames: { 1: "测试花" },
    compatibilityReport: { status: "compatible" },
  });
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
