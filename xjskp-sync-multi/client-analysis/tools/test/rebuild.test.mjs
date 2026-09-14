import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ClientAnalysisVersionConflictError,
  publishClientVersion
} from "../src/publish.mjs";

function inputFor(sourceText) {
  return {
    appVersion: "fixture-rebuild",
    sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
    sourceSize: Buffer.byteLength(sourceText),
    sourceText
  };
}

function buildVersion(content) {
  return async ({ tempDir }) => {
    await fs.mkdir(path.join(tempDir, "generated"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "generated-reports"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "generated", "value.txt"), content);
    await fs.writeFile(path.join(tempDir, "generated-reports", "report.md"), `${content}\n`);
  };
}

async function withAnalysisRoot(callback) {
  const analysisRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-rebuild-"));
  try {
    return await callback(analysisRoot);
  } finally {
    await fs.rm(analysisRoot, { recursive: true, force: true });
  }
}

test("explicit same-source rebuild validates the candidate, archives the old version, and atomically promotes the replacement", async () => {
  await withAnalysisRoot(async (analysisRoot) => {
    const input = inputFor("same-source");
    const first = await publishClientVersion({ analysisRoot, input, toolVersion: "test", build: buildVersion("old") });
    await fs.writeFile(path.join(analysisRoot, "latest.json"), "{\"sentinel\":true}\n");

    const rebuilt = await publishClientVersion({
      analysisRoot,
      input,
      toolVersion: "test",
      build: buildVersion("new"),
      rebuildExisting: true
    });

    assert.equal(rebuilt.status, "rebuilt");
    assert.equal(rebuilt.versionDir, first.versionDir);
    assert.equal(await fs.readFile(path.join(rebuilt.versionDir, "generated", "value.txt"), "utf8"), "new");
    assert.equal(await fs.readFile(path.join(rebuilt.backupDir, "generated", "value.txt"), "utf8"), "old");
    assert.equal((await fs.stat(path.join(rebuilt.backupDir, "manifest.json"))).isFile(), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(analysisRoot, "latest.json"), "utf8")).sourceSha256, input.sourceSha256);
  });
});

test("failed same-source promotion restores the old formal version and leaves latest byte-for-byte unchanged", async () => {
  await withAnalysisRoot(async (analysisRoot) => {
    const input = inputFor("same-source");
    const first = await publishClientVersion({ analysisRoot, input, toolVersion: "test", build: buildVersion("old") });
    const latestPath = path.join(analysisRoot, "latest.json");
    const latestBefore = await fs.readFile(latestPath, "utf8");

    await assert.rejects(
      publishClientVersion({
        analysisRoot,
        input,
        toolVersion: "test",
        build: buildVersion("candidate"),
        rebuildExisting: true,
        fileOps: {
          rename: async (sourcePath, destinationPath) => {
            if (destinationPath === first.versionDir && path.basename(sourcePath).startsWith(`.${input.appVersion}.tmp-`)) {
              const error = new Error("simulated candidate promotion failure");
              error.code = "EACCES";
              throw error;
            }
            return fs.rename(sourcePath, destinationPath);
          }
        }
      }),
      /simulated candidate promotion failure/
    );

    assert.equal(await fs.readFile(path.join(first.versionDir, "generated", "value.txt"), "utf8"), "old");
    assert.equal(await fs.readFile(latestPath, "utf8"), latestBefore);
  });
});

test("failed latest replacement restores the old formal version and preserves latest bytes", async () => {
  await withAnalysisRoot(async (analysisRoot) => {
    const input = inputFor("same-source");
    const first = await publishClientVersion({ analysisRoot, input, toolVersion: "test", build: buildVersion("old") });
    const latestPath = path.join(analysisRoot, "latest.json");
    const latestBefore = await fs.readFile(latestPath, "utf8");

    await assert.rejects(
      publishClientVersion({
        analysisRoot,
        input,
        toolVersion: "test",
        build: buildVersion("candidate"),
        rebuildExisting: true,
        fileOps: {
          rename: async (sourcePath, destinationPath) => {
            if (destinationPath === latestPath && path.basename(sourcePath).startsWith(".latest.json.tmp-")) {
              const error = new Error("simulated latest replacement failure");
              error.code = "EACCES";
              throw error;
            }
            return fs.rename(sourcePath, destinationPath);
          }
        }
      }),
      /simulated latest replacement failure/
    );

    assert.equal(await fs.readFile(path.join(first.versionDir, "generated", "value.txt"), "utf8"), "old");
    assert.equal(await fs.readFile(latestPath, "utf8"), latestBefore);
  });
});

test("same-source rebuild mode still rejects a different source hash before building", async () => {
  await withAnalysisRoot(async (analysisRoot) => {
    const original = inputFor("original");
    const conflicting = inputFor("conflicting");
    await publishClientVersion({ analysisRoot, input: original, toolVersion: "test", build: buildVersion("old") });
    let buildCalled = false;

    await assert.rejects(
      publishClientVersion({
        analysisRoot,
        input: conflicting,
        toolVersion: "test",
        rebuildExisting: true,
        build: async () => { buildCalled = true; }
      }),
      (error) => error instanceof ClientAnalysisVersionConflictError
    );
    assert.equal(buildCalled, false);
  });
});
