import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as runModule from "../src/run.mjs";

const { runClientAnalysis } = runModule;

const fixtureSource = "const FooCtrl=class{};gs.usrLand.plantBatch(1);";

async function withTempDir(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-client-run-"));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("runClientAnalysis reads a local client and atomically publishes complete generated evidence", async () => {
  await withTempDir(async (rootDir) => {
    const gameDir = path.join(rootDir, "work", "game-pkg-latest", "tar");
    await fs.mkdir(gameDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, "work", "latest-game-info.json"), JSON.stringify({ data: { appVersion: "fixture-run-1" } }));
    await fs.writeFile(path.join(gameDir, "game.js"), fixtureSource);

    const result = await runClientAnalysis({ rootDir, toolVersion: "test" });
    const generatedDir = path.join(result.versionDir, "generated");
    const manifest = JSON.parse(await fs.readFile(path.join(result.versionDir, "manifest.json"), "utf8"));
    const latest = JSON.parse(await fs.readFile(path.join(rootDir, "client-analysis", "latest.json"), "utf8"));

    assert.equal(result.status, "published");
    assert.equal(manifest.sourceSha256, createHash("sha256").update(fixtureSource).digest("hex"));
    assert.equal(manifest.performance.parseDurationMs >= 0, true);
    assert.equal(manifest.performance.totalDurationMs >= manifest.performance.parseDurationMs, true);
    assert.deepEqual(manifest.discoveries, { controllers: 1, dialogs: 0, interfaces: 1, configTables: 0, callSites: 1, unresolved: 0, businessNodes: 3, businessEdges: 1, unclassified: 1 });
    assert.equal(latest.appVersion, "fixture-run-1");
    for (const fileName of ["game.formatted.js", "controllers.json", "dialogs.json", "interfaces.json", "config-tables.json", "call-sites.json", "unresolved.json", "business-map.json"]) {
      assert.equal((await fs.stat(path.join(generatedDir, fileName))).isFile(), true);
    }
    assert.equal((await fs.stat(path.join(result.versionDir, "generated-reports", "business-catalog.md"))).isFile(), true);
    assert.equal((await fs.stat(path.join(result.versionDir, "generated-reports", "unclassified.md"))).isFile(), true);
    assert.equal(manifest.artifacts.some((artifact) => artifact.path === "generated-reports/unclassified.md"), true);
  });
});

test("parseAnalysisArguments exposes only the explicit same-source rebuild switch", () => {
  assert.equal(typeof runModule.parseAnalysisArguments, "function");
  assert.deepEqual(runModule.parseAnalysisArguments([]), { rebuildExisting: false });
  assert.deepEqual(
    runModule.parseAnalysisArguments(["--rebuild-existing-same-source"]),
    { rebuildExisting: true }
  );
  assert.throws(
    () => runModule.parseAnalysisArguments(["--force"]),
    /Unknown client analysis argument: --force/
  );
});
