import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { readClientInput, ClientAnalysisInputError } from "../src/input.mjs";
import {
  publishClientVersion,
  ClientAnalysisVersionConflictError
} from "../src/publish.mjs";

async function createFixtureRoot({ appVersion = "1.2.3", source = "const a=1;" } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-client-analysis-"));
  await fs.mkdir(path.join(rootDir, "work", "game-pkg-latest", "tar"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "work", "latest-game-info.json"),
    JSON.stringify({ data: { appVersion } })
  );
  await fs.writeFile(path.join(rootDir, "work", "game-pkg-latest", "tar", "game.js"), source);
  return rootDir;
}

async function withTempDir(callback) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-client-analysis-test-"));
  try {
    return await callback(rootDir);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function buildFixture({ tempDir }) {
  const generatedDir = path.join(tempDir, "generated");
  await fs.mkdir(generatedDir, { recursive: true });
  await fs.writeFile(path.join(generatedDir, "fixture.txt"), "generated");
}

test("rejects missing client version and game source with typed input errors", async () => {
  await withTempDir(async (rootDir) => {
    await fs.mkdir(path.join(rootDir, "work", "game-pkg-latest", "tar"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "work", "latest-game-info.json"), JSON.stringify({ data: {} }));

    await assert.rejects(
      readClientInput({ rootDir }),
      (error) => error instanceof ClientAnalysisInputError
        && error.code === "CLIENT_ANALYSIS_INPUT_INVALID"
        && error.path.endsWith("latest-game-info.json")
    );

    await fs.writeFile(
      path.join(rootDir, "work", "latest-game-info.json"),
      JSON.stringify({ data: { appVersion: "1.2.3" } })
    );
    await assert.rejects(
      readClientInput({ rootDir }),
      (error) => error instanceof ClientAnalysisInputError
        && error.code === "CLIENT_ANALYSIS_INPUT_MISSING"
        && error.path.endsWith("game.js")
    );
  });
});

test("publishes a fixture version and returns the existing result for the same input", async () => {
  const fixtureRoot = await createFixtureRoot();
  await withTempDir(async (analysisRoot) => {
    try {
      const input = await readClientInput({ rootDir: fixtureRoot });
      const result = await publishClientVersion({
        analysisRoot,
        input,
        toolVersion: "1.0.0",
        build: buildFixture
      });

      assert.equal(result.status, "published");
      assert.equal(result.versionDir, path.join(analysisRoot, "versions", "1.2.3"));
      assert.equal(result.manifest.sourceSha256, createHash("sha256").update("const a=1;").digest("hex"));
      assert.equal(result.manifest.sourceSize, Buffer.byteLength("const a=1;"));
      assert.equal((await fs.stat(path.join(result.versionDir, "generated"))).isDirectory(), true);

      const latest = JSON.parse(await fs.readFile(path.join(analysisRoot, "latest.json"), "utf8"));
      assert.deepEqual(latest, {
        appVersion: "1.2.3",
        sourceSha256: input.sourceSha256,
        sourceSize: input.sourceSize,
        versionDir: "versions/1.2.3"
      });

      const existing = await publishClientVersion({
        analysisRoot,
        input,
        toolVersion: "1.0.0",
        build: buildFixture
      });
      assert.equal(existing.status, "existing");
      assert.equal(existing.versionDir, result.versionDir);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

test("rejects a conflicting version without replacing latest", async () => {
  const firstRoot = await createFixtureRoot({ source: "const a=1;" });
  const secondRoot = await createFixtureRoot({ source: "const b=2;" });
  await withTempDir(async (analysisRoot) => {
    try {
      const firstInput = await readClientInput({ rootDir: firstRoot });
      const secondInput = await readClientInput({ rootDir: secondRoot });
      await publishClientVersion({ analysisRoot, input: firstInput, toolVersion: "1.0.0", build: buildFixture });
      const latestBefore = await fs.readFile(path.join(analysisRoot, "latest.json"), "utf8");

      await assert.rejects(
        publishClientVersion({ analysisRoot, input: secondInput, toolVersion: "1.0.0", build: buildFixture }),
        (error) => error instanceof ClientAnalysisVersionConflictError
          && error.code === "CLIENT_ANALYSIS_VERSION_CONFLICT"
      );
      assert.equal(await fs.readFile(path.join(analysisRoot, "latest.json"), "utf8"), latestBefore);
    } finally {
      await Promise.all([
        fs.rm(firstRoot, { recursive: true, force: true }),
        fs.rm(secondRoot, { recursive: true, force: true })
      ]);
    }
  });
});

test("does not publish a version or latest when build fails", async () => {
  const fixtureRoot = await createFixtureRoot();
  await withTempDir(async (analysisRoot) => {
    try {
      const input = await readClientInput({ rootDir: fixtureRoot });
      await assert.rejects(
        publishClientVersion({
          analysisRoot,
          input,
          toolVersion: "1.0.0",
          build: async () => { throw new Error("fixture build failure"); }
        }),
        /fixture build failure/
      );
      await assert.rejects(fs.stat(path.join(analysisRoot, "versions", "1.2.3")), { code: "ENOENT" });
      await assert.rejects(fs.stat(path.join(analysisRoot, "latest.json")), { code: "ENOENT" });
      const entries = await fs.readdir(path.join(analysisRoot, "versions"));
      assert.deepEqual(entries, []);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

test("records approved build manifest metadata", async () => {
  await withTempDir(async (analysisRoot) => {
    const source = "fixture source 3";
    const input = {
      appVersion: "fixture-3",
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      sourceSize: Buffer.byteLength(source),
      sourceText: source
    };
    const published = await publishClientVersion({
      analysisRoot,
      input,
      toolVersion: "1.0.0",
      build: async ({ tempDir }) => {
        await fs.mkdir(path.join(tempDir, "generated"));
        return { manifest: { performance: { parseDurationMs: 12 } } };
      }
    });

    assert.deepEqual(published.manifest.performance, { parseDurationMs: 12 });
  });
});

test("falls back to a complete copy when publishing the version directory rename returns EPERM", async () => {
  const fixtureRoot = await createFixtureRoot();
  await withTempDir(async (analysisRoot) => {
    try {
      const input = await readClientInput({ rootDir: fixtureRoot });
      const versionDir = path.join(analysisRoot, "versions", input.appVersion);
      let versionRenameAttempts = 0;
      let copyCalls = 0;
      const published = await publishClientVersion({
        analysisRoot,
        input,
        toolVersion: "1.0.0",
        build: buildFixture,
        fileOps: {
          rename: async (sourcePath, destinationPath) => {
            if (destinationPath === versionDir) {
              versionRenameAttempts += 1;
              const error = new Error("simulated directory rename denial");
              error.code = "EPERM";
              throw error;
            }
            return fs.rename(sourcePath, destinationPath);
          },
          cp: async (...args) => {
            copyCalls += 1;
            return fs.cp(...args);
          }
        }
      });

      assert.equal(versionRenameAttempts, 1);
      assert.equal(copyCalls > 0, true);
      assert.equal(published.status, "published");
      assert.equal(await fs.readFile(path.join(versionDir, "generated", "fixture.txt"), "utf8"), "generated");
      assert.equal(JSON.parse(await fs.readFile(path.join(versionDir, "manifest.json"), "utf8")).sourceSha256, input.sourceSha256);
      assert.equal(JSON.parse(await fs.readFile(path.join(analysisRoot, "latest.json"), "utf8")).sourceSha256, input.sourceSha256);
      assert.deepEqual((await fs.readdir(path.join(analysisRoot, "versions"))).sort(), [input.appVersion]);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

test("keeps input identity when an EPERM fallback build returns conflicting manifest fields", async () => {
  const firstRoot = await createFixtureRoot({ source: "const payloadA=1;" });
  const secondRoot = await createFixtureRoot({ source: "const payloadB=2;" });
  await withTempDir(async (analysisRoot) => {
    try {
      const firstInput = await readClientInput({ rootDir: firstRoot });
      const secondInput = await readClientInput({ rootDir: secondRoot });
      const versionDir = path.join(analysisRoot, "versions", firstInput.appVersion);
      const published = await publishClientVersion({
        analysisRoot,
        input: firstInput,
        toolVersion: "1.0.0",
        build: async ({ tempDir }) => {
          await buildFixture({ tempDir });
          return {
            manifest: {
              appVersion: secondInput.appVersion,
              sourceSha256: secondInput.sourceSha256,
              sourceSize: secondInput.sourceSize,
              toolVersion: "malicious-tool",
              generatedAtUtc: "2000-01-01T00:00:00.000Z",
              discoveries: { source: "fixture" },
              unapprovedBuildField: "must-not-publish"
            }
          };
        },
        fileOps: {
          rename: async (sourcePath, destinationPath) => {
            if (destinationPath === versionDir) {
              const error = new Error("simulated directory rename denial");
              error.code = "EPERM";
              throw error;
            }
            return fs.rename(sourcePath, destinationPath);
          }
        }
      });

      assert.equal(published.manifest.appVersion, firstInput.appVersion);
      assert.equal(published.manifest.sourceSha256, firstInput.sourceSha256);
      assert.equal(published.manifest.sourceSize, firstInput.sourceSize);
      assert.equal(published.manifest.toolVersion, "1.0.0");
      assert.notEqual(published.manifest.generatedAtUtc, "2000-01-01T00:00:00.000Z");
      assert.deepEqual(published.manifest.discoveries, { source: "fixture" });
      assert.equal(published.manifest.unapprovedBuildField, undefined);

      await assert.rejects(
        publishClientVersion({ analysisRoot, input: secondInput, toolVersion: "1.0.0", build: buildFixture }),
        (error) => error instanceof ClientAnalysisVersionConflictError
          && error.code === "CLIENT_ANALYSIS_VERSION_CONFLICT"
      );
    } finally {
      await Promise.all([
        fs.rm(firstRoot, { recursive: true, force: true }),
        fs.rm(secondRoot, { recursive: true, force: true })
      ]);
    }
  });
});

test("cleans an incomplete copied version and preserves latest when the EPERM fallback copy fails", async () => {
  const fixtureRoot = await createFixtureRoot();
  await withTempDir(async (analysisRoot) => {
    try {
      const input = await readClientInput({ rootDir: fixtureRoot });
      const versionDir = path.join(analysisRoot, "versions", input.appVersion);
      const latestPath = path.join(analysisRoot, "latest.json");
      const latestBefore = '{"appVersion":"previous"}\n';
      await fs.writeFile(latestPath, latestBefore);

      await assert.rejects(
        publishClientVersion({
          analysisRoot,
          input,
          toolVersion: "1.0.0",
          build: buildFixture,
          fileOps: {
            rename: async (sourcePath, destinationPath) => {
              if (destinationPath === versionDir) {
                const error = new Error("simulated directory rename denial");
                error.code = "EPERM";
                throw error;
              }
              return fs.rename(sourcePath, destinationPath);
            },
            cp: async () => {
              await assert.rejects(fs.stat(path.join(versionDir, "manifest.json")), { code: "ENOENT" });
              throw new Error("simulated fallback copy failure");
            }
          }
        }),
        /simulated fallback copy failure/
      );

      assert.equal(await fs.readFile(latestPath, "utf8"), latestBefore);
      await assert.rejects(fs.stat(versionDir), { code: "ENOENT" });
      await assert.rejects(fs.stat(path.join(versionDir, "manifest.json")), { code: "ENOENT" });
      assert.deepEqual(await fs.readdir(path.join(analysisRoot, "versions")), []);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

test("does not copy when the version directory rename fails with a non-EPERM error", async () => {
  const fixtureRoot = await createFixtureRoot();
  await withTempDir(async (analysisRoot) => {
    try {
      const input = await readClientInput({ rootDir: fixtureRoot });
      const versionDir = path.join(analysisRoot, "versions", input.appVersion);
      let copyCalls = 0;
      await assert.rejects(
        publishClientVersion({
          analysisRoot,
          input,
          toolVersion: "1.0.0",
          build: buildFixture,
          fileOps: {
            rename: async (sourcePath, destinationPath) => {
              if (destinationPath === versionDir) {
                const error = new Error("simulated non-EPERM rename failure");
                error.code = "EACCES";
                throw error;
              }
              return fs.rename(sourcePath, destinationPath);
            },
            cp: async (...args) => {
              copyCalls += 1;
              return fs.cp(...args);
            }
          }
        }),
        (error) => error?.code === "EACCES"
      );

      assert.equal(copyCalls, 0);
      await assert.rejects(fs.stat(versionDir), { code: "ENOENT" });
      await assert.rejects(fs.stat(path.join(analysisRoot, "latest.json")), { code: "ENOENT" });
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

test("rejects and cleans a fallback copy that reports success but omits generated files", async () => {
  const fixtureRoot = await createFixtureRoot();
  await withTempDir(async (analysisRoot) => {
    try {
      const input = await readClientInput({ rootDir: fixtureRoot });
      const versionDir = path.join(analysisRoot, "versions", input.appVersion);
      await assert.rejects(
        publishClientVersion({
          analysisRoot,
          input,
          toolVersion: "1.0.0",
          build: buildFixture,
          fileOps: {
            rename: async (sourcePath, destinationPath) => {
              if (destinationPath === versionDir) {
                const error = new Error("simulated directory rename denial");
                error.code = "EPERM";
                throw error;
              }
              return fs.rename(sourcePath, destinationPath);
            },
            cp: async (sourcePath, destinationPath) => {
              assert.equal(path.basename(sourcePath), "generated");
              await fs.mkdir(destinationPath);
            }
          }
        }),
        /fallback copy is incomplete/
      );

      await assert.rejects(fs.stat(versionDir), { code: "ENOENT" });
      await assert.rejects(fs.stat(path.join(analysisRoot, "latest.json")), { code: "ENOENT" });
      assert.deepEqual(await fs.readdir(path.join(analysisRoot, "versions")), []);
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
