import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readActiveGameDataBundle, registerCurrentGameDataBaseline } from "./game-data-version.mjs";
import {
  discoverGameDataCandidate,
  prepareGameDataCandidate,
  syncGameDataCandidate,
} from "./game-data-candidate-sync.mjs";

test("discoverGameDataCandidate keeps package, modules, resource config, and g-data inside its candidate directory", async (t) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-discovery-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  const candidateDir = path.join(rootDir, "candidate");
  const seen = [];
  const result = await discoverGameDataCandidate({
    candidateDir,
    packageUrl: "https://cdn.example.invalid/package.bin",
    sourceCodeVersion: "400.0.15",
    baseUrls: ["https://cdn.example.invalid/"],
    downloadPackage: async ({ packagePath, extractDir }) => {
      seen.push(packagePath, extractDir);
      await fsp.mkdir(path.join(extractDir, "tar"), { recursive: true });
      await fsp.writeFile(packagePath, "package", "utf8");
      await fsp.writeFile(path.join(extractDir, "tar", "modules.json"), "{}", "utf8");
      return { packageBytes: 7, packageSha256: "a".repeat(64), manifestAppVersion: "400.0.15" };
    },
    downloadResourceConfig: async ({ outDir }) => {
      const resourceConfigPath = path.join(outDir, "resources-config-abc12.json");
      seen.push(resourceConfigPath);
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.writeFile(resourceConfigPath, "{}", "utf8");
      return {
        resourceConfigPath,
        resourceConfigVersionToken: "abc12",
        resourceConfigBytes: 2,
        resourceConfigSha256: "b".repeat(64),
        resource: { version: "bbb22", nativePath: "assets/resources/native/aa/file.bbb22.text" },
      };
    },
    downloadStaticConfig: async ({ outputPath }) => {
      seen.push(outputPath);
      await fsp.writeFile(outputPath, "{}", "utf8");
      return { configPath: outputPath, bytes: 2, sha256: "c".repeat(64) };
    },
  });

  assert.equal(result.dataVersion, "bbb22");
  assert.equal(result.sourceCodeVersion, "400.0.15");
  for (const filePath of seen) {
    const relative = path.relative(candidateDir, filePath);
    assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false, filePath);
  }
});

test("syncGameDataCandidate activates a compatible isolated candidate without changing code files", async (t) => {
  const fixture = await createFixture(t);
  const protectedBefore = await hashes(fixture.protectedPaths);

  const result = await syncGameDataCandidate({
    rootDir: fixture.rootDir,
    currentStaticConfigPath: fixture.baselinePath,
    currentFlowerNamesPath: fixture.baselineNamesPath,
    sourceCodeVersion: "400.0.15",
    discoverCandidate: async ({ candidateDir }) => {
      const configPath = path.join(candidateDir, "g-data.bbb22.text");
      await fsp.mkdir(candidateDir, { recursive: true });
      await fsp.writeFile(configPath, JSON.stringify({ candidate: true }), "utf8");
      return { dataVersion: "bbb22", sourceCodeVersion: "400.0.15", configPath, calls: ["official-package", "static-file"] };
    },
    auditCandidate: () => compatibleAudit(),
  });

  assert.equal(result.status, "latest");
  assert.equal(readActiveGameDataBundle({ rootDir: fixture.rootDir }).dataVersion, "bbb22");
  assert.deepEqual(await hashes(fixture.protectedPaths), protectedBefore);
});

test("prepareGameDataCandidate audits an isolated candidate without activating it", async (t) => {
  const fixture = await createFixture(t);
  const prepared = await prepareGameDataCandidate({
    rootDir: fixture.rootDir,
    currentStaticConfigPath: fixture.baselinePath,
    currentFlowerNamesPath: fixture.baselineNamesPath,
    sourceCodeVersion: "400.0.15",
    discoverCandidate: makeDiscovery("bbb22"),
    auditCandidate: () => compatibleAudit(),
  });

  assert.equal(prepared.status, "compatible");
  assert.equal(prepared.candidate.dataVersion, "bbb22");
  assert.equal(prepared.activeBefore.dataVersion, "aaa11");
  assert.equal(readActiveGameDataBundle({ rootDir: fixture.rootDir }).dataVersion, "aaa11");
  await fsp.access(prepared.reportPath);
  assert.deepEqual(
    JSON.parse(await fsp.readFile(path.join(prepared.candidateDir, "flower-names.json"), "utf8")),
    { 23001: "候选花" },
  );
});

test("prepareGameDataCandidate can audit against an explicit runtime baseline without changing the active pointer", async (t) => {
  const fixture = await createFixture(t);
  const runtimeBaselinePath = path.join(fixture.rootDir, "work", "g-data.ccc33.text");
  await fsp.writeFile(runtimeBaselinePath, "runtime-baseline", "utf8");
  let seenBaselinePath = null;

  const prepared = await prepareGameDataCandidate({
    rootDir: fixture.rootDir,
    currentStaticConfigPath: fixture.baselinePath,
    currentFlowerNamesPath: fixture.baselineNamesPath,
    auditBaselinePath: runtimeBaselinePath,
    auditBaselineDataVersion: "ccc33",
    sourceCodeVersion: "400.0.15",
    discoverCandidate: makeDiscovery("bbb22"),
    auditCandidate: ({ baselinePath }) => {
      seenBaselinePath = baselinePath;
      return compatibleAudit();
    },
  });

  assert.equal(seenBaselinePath, runtimeBaselinePath);
  assert.equal(prepared.auditBaselinePath, runtimeBaselinePath);
  assert.deepEqual(JSON.parse(await fsp.readFile(prepared.reportPath, "utf8")).auditBaseline, {
    dataVersion: "ccc33",
    file: "g-data.ccc33.text",
  });
  assert.equal(readActiveGameDataBundle({ rootDir: fixture.rootDir }).dataVersion, "aaa11");
});

test("manual-review and incompatible candidates keep the previous active version", async (t) => {
  for (const status of ["manual-review", "incompatible"]) {
    const fixture = await createFixture(t);
    await registerCurrentGameDataBaseline({
      rootDir: fixture.rootDir,
      staticConfigPath: fixture.baselinePath,
      flowerNamesPath: fixture.baselineNamesPath,
      sourceCodeVersion: "391.0.25",
    });
    const result = await syncGameDataCandidate({
      rootDir: fixture.rootDir,
      currentStaticConfigPath: fixture.baselinePath,
      currentFlowerNamesPath: fixture.baselineNamesPath,
      sourceCodeVersion: "400.0.15",
      discoverCandidate: makeDiscovery("bbb22"),
      auditCandidate: () => ({ ...compatibleAudit(), status, reasons: [`fixture-${status}`] }),
    });

    assert.equal(result.status, status);
    assert.equal(readActiveGameDataBundle({ rootDir: fixture.rootDir }).dataVersion, "aaa11");
    assert.equal((await fsp.readFile(result.reportPath, "utf8")).includes(`fixture-${status}`), true);
  }
});

test("same data token with different bytes is incompatible and cannot replace the active bundle", async (t) => {
  const fixture = await createFixture(t);
  await registerCurrentGameDataBaseline({
    rootDir: fixture.rootDir,
    staticConfigPath: fixture.baselinePath,
    flowerNamesPath: fixture.baselineNamesPath,
    sourceCodeVersion: "391.0.25",
  });
  const result = await syncGameDataCandidate({
    rootDir: fixture.rootDir,
    currentStaticConfigPath: fixture.baselinePath,
    currentFlowerNamesPath: fixture.baselineNamesPath,
    sourceCodeVersion: "400.0.15",
    discoverCandidate: makeDiscovery("aaa11"),
    auditCandidate: () => compatibleAudit(),
  });

  assert.equal(result.status, "incompatible");
  assert.equal(readActiveGameDataBundle({ rootDir: fixture.rootDir }).dataVersion, "aaa11");
  assert.match(await fsp.readFile(result.reportPath, "utf8"), /version-content-collision:aaa11/);
});

test("download, staging, pointer, and post-activation failures retain or restore the previous active version", async (t) => {
  for (const phase of ["download", "stage", "pointer", "verify"]) {
    const fixture = await createFixture(t);
    await registerCurrentGameDataBaseline({
      rootDir: fixture.rootDir,
      staticConfigPath: fixture.baselinePath,
      flowerNamesPath: fixture.baselineNamesPath,
      sourceCodeVersion: "391.0.25",
    });
    await assert.rejects(
      syncGameDataCandidate({
        rootDir: fixture.rootDir,
        currentStaticConfigPath: fixture.baselinePath,
        currentFlowerNamesPath: fixture.baselineNamesPath,
        sourceCodeVersion: "400.0.15",
        discoverCandidate: phase === "download"
          ? async () => { throw new Error("download failed"); }
          : makeDiscovery(`b${phase.length}b22`),
        auditCandidate: () => compatibleAudit(),
        failPhase: phase,
      }),
      new RegExp(`${phase} failed`),
    );
    assert.equal(readActiveGameDataBundle({ rootDir: fixture.rootDir }).dataVersion, "aaa11", phase);
  }
});

test("progress hooks are awaited and activation performs a final external quiescence check", async (t) => {
  const fixture = await createFixture(t);
  await registerCurrentGameDataBaseline({
    rootDir: fixture.rootDir,
    staticConfigPath: fixture.baselinePath,
    flowerNamesPath: fixture.baselineNamesPath,
    sourceCodeVersion: "391.0.25",
  });
  const events = [];
  await syncGameDataCandidate({
    rootDir: fixture.rootDir,
    discoverCandidate: makeDiscovery("ccc33"),
    auditCandidate: () => compatibleAudit(),
    async onPhase(phase) {
      await new Promise((resolve) => setImmediate(resolve));
      events.push(phase);
    },
    async beforeActivate() {
      events.push("before-activate");
    },
  });
  assert.deepEqual(events, [
    "download",
    "validate",
    "before-activate",
    "stage",
    "pointer",
    "verify",
  ]);
});

test("a partial version-stage write is cleaned and never becomes active", async (t) => {
  const fixture = await createFixture(t);
  await registerCurrentGameDataBaseline({
    rootDir: fixture.rootDir,
    staticConfigPath: fixture.baselinePath,
    flowerNamesPath: fixture.baselineNamesPath,
    sourceCodeVersion: "391.0.25",
  });
  const failingFs = {
    ...fsp,
    async writeFile(filePath, ...args) {
      if (String(filePath).includes(".stage-bbb22-") && String(filePath).endsWith("flower-names.json")) {
        throw new Error("stage flower write failed");
      }
      return fsp.writeFile(filePath, ...args);
    },
  };
  await assert.rejects(
    syncGameDataCandidate({
      rootDir: fixture.rootDir,
      currentStaticConfigPath: fixture.baselinePath,
      currentFlowerNamesPath: fixture.baselineNamesPath,
      sourceCodeVersion: "400.0.15",
      discoverCandidate: makeDiscovery("bbb22"),
      auditCandidate: () => compatibleAudit(),
      fileSystem: failingFs,
    }),
    /stage flower write failed/,
  );
  assert.equal(readActiveGameDataBundle({ rootDir: fixture.rootDir }).dataVersion, "aaa11");
  const versionsDir = path.join(fixture.rootDir, "runtime", "game-data", "versions");
  assert.equal((await fsp.readdir(versionsDir)).some((name) => name.startsWith(".stage-bbb22-")), false);
  assert.equal(await fsp.stat(path.join(versionsDir, "aaa11")).then(() => true), true);
});

function compatibleAudit() {
  return {
    status: "compatible",
    reasons: [],
    flowerNames: { 23001: "候选花" },
    loaderAudit: { compatible: true, loaderCount: 16, results: [] },
    diff: { tables: {} },
  };
}

function makeDiscovery(dataVersion) {
  return async ({ candidateDir }) => {
    const configPath = path.join(candidateDir, `g-data.${dataVersion}.text`);
    await fsp.mkdir(candidateDir, { recursive: true });
    await fsp.writeFile(configPath, JSON.stringify({ candidate: true }), "utf8");
    return { dataVersion, sourceCodeVersion: "400.0.15", configPath, calls: ["static-file"] };
  };
}

async function createFixture(t) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-sync-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  const workDir = path.join(rootDir, "work");
  const analysisDir = path.join(rootDir, "client-analysis");
  await fsp.mkdir(path.join(workDir, "game-pkg-latest", "tar"), { recursive: true });
  await fsp.mkdir(analysisDir, { recursive: true });
  const baselinePath = path.join(workDir, "g-data.aaa11.text");
  const baselineNamesPath = path.join(workDir, "flower-names.json");
  const protectedPaths = [
    path.join(workDir, "game-pkg-latest", "Manifest.xml"),
    path.join(workDir, "game-pkg-latest", "tar", "game.js"),
    path.join(workDir, "game-pkg-latest", "tar", "modules.json"),
    path.join(analysisDir, "latest.json"),
  ];
  await Promise.all([
    fsp.writeFile(baselinePath, "{}", "utf8"),
    fsp.writeFile(baselineNamesPath, JSON.stringify({ 23001: "基线花" }), "utf8"),
    ...protectedPaths.map((filePath, index) => fsp.writeFile(filePath, `protected-${index}`, "utf8")),
  ]);
  return { rootDir, baselinePath, baselineNamesPath, protectedPaths };
}

async function hashes(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async (filePath) => [
    filePath,
    crypto.createHash("sha256").update(await fsp.readFile(filePath)).digest("hex"),
  ])));
}
