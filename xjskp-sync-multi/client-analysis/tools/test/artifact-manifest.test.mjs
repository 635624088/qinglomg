import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishClientVersion } from "../src/publish.mjs";

function fixtureInput() {
  const sourceText = "fixture-source";
  return {
    appVersion: "fixture-artifacts",
    sourceSha256: createHash("sha256").update(sourceText).digest("hex"),
    sourceSize: Buffer.byteLength(sourceText),
    sourceText
  };
}

async function buildArtifacts({ tempDir }) {
  await fs.mkdir(path.join(tempDir, "generated", "nested"), { recursive: true });
  await fs.mkdir(path.join(tempDir, "generated-reports"), { recursive: true });
  await fs.writeFile(path.join(tempDir, "generated", "a.txt"), "alpha");
  await fs.writeFile(path.join(tempDir, "generated", "nested", "b.txt"), "beta");
  await fs.writeFile(path.join(tempDir, "generated-reports", "report.md"), "report\n");
}

async function withAnalysisRoot(callback) {
  const analysisRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-artifact-manifest-"));
  try {
    return await callback(analysisRoot);
  } finally {
    await fs.rm(analysisRoot, { recursive: true, force: true });
  }
}

test("manifest records every generated artifact with stable POSIX path, size, and SHA256", async () => {
  const input = fixtureInput();
  const firstArtifacts = await withAnalysisRoot(async (analysisRoot) => {
    const result = await publishClientVersion({ analysisRoot, input, toolVersion: "test", build: buildArtifacts });
    return result.manifest.artifacts;
  });
  const secondArtifacts = await withAnalysisRoot(async (analysisRoot) => {
    const result = await publishClientVersion({ analysisRoot, input, toolVersion: "test", build: buildArtifacts });
    return result.manifest.artifacts;
  });

  assert.deepEqual(firstArtifacts, secondArtifacts);
  assert.deepEqual(firstArtifacts.map((artifact) => artifact.path), [
    "generated-reports/report.md",
    "generated/a.txt",
    "generated/nested/b.txt"
  ]);
  assert.deepEqual(firstArtifacts.map((artifact) => artifact.size), [7, 5, 4]);
  assert.deepEqual(firstArtifacts.map((artifact) => artifact.sha256), [
    createHash("sha256").update("report\n").digest("hex"),
    createHash("sha256").update("alpha").digest("hex"),
    createHash("sha256").update("beta").digest("hex")
  ]);
  assert.equal(firstArtifacts.some((artifact) => artifact.path === "manifest.json"), false);
});

test("existing same-source version is rejected when its artifact list no longer matches disk", async () => {
  await withAnalysisRoot(async (analysisRoot) => {
    const input = fixtureInput();
    const published = await publishClientVersion({ analysisRoot, input, toolVersion: "test", build: buildArtifacts });
    const latestBefore = await fs.readFile(path.join(analysisRoot, "latest.json"), "utf8");
    await fs.writeFile(path.join(published.versionDir, "generated", "a.txt"), "tampered");

    await assert.rejects(
      publishClientVersion({ analysisRoot, input, toolVersion: "test", build: buildArtifacts }),
      (error) => error?.code === "CLIENT_ANALYSIS_ARTIFACT_INTEGRITY"
    );
    assert.equal(await fs.readFile(path.join(analysisRoot, "latest.json"), "utf8"), latestBefore);
  });
});

test("EPERM copy fallback publishes only after the manifest artifact list matches the copied tree", async () => {
  await withAnalysisRoot(async (analysisRoot) => {
    const input = fixtureInput();
    const versionDir = path.join(analysisRoot, "versions", input.appVersion);
    const result = await publishClientVersion({
      analysisRoot,
      input,
      toolVersion: "test",
      build: buildArtifacts,
      fileOps: {
        rename: async (sourcePath, destinationPath) => {
          if (destinationPath === versionDir) {
            const error = new Error("simulated EPERM");
            error.code = "EPERM";
            throw error;
          }
          return fs.rename(sourcePath, destinationPath);
        }
      }
    });

    const manifest = JSON.parse(await fs.readFile(path.join(versionDir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.artifacts, result.manifest.artifacts);
    assert.equal(manifest.artifacts.length, 3);
    assert.equal(JSON.parse(await fs.readFile(path.join(analysisRoot, "latest.json"), "utf8")).sourceSha256, input.sourceSha256);
  });
});
