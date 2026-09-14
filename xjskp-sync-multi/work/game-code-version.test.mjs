import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  commitCompatibleGameCodeBundle,
  readActiveGameCodeBundle,
  readActiveGameCodePointerSnapshot,
  writeActiveGameCodePointer,
} from "./game-code-version.mjs";

test("commits an immutable verified code bundle and activates it through an atomic pointer", async (t) => {
  const rootDir = await createRoot(t);
  const packageDir = await writeCandidate(rootDir, "401.0.1", "candidate-code");
  const gameJsSha256 = sha256("candidate-code");

  const committed = await commitCompatibleGameCodeBundle({
    rootDir,
    packageDir,
    appVersion: "401.0.1",
    expectedGameJsSha256: gameJsSha256,
    packageEvidence: { bytes: 123, sha256: "a".repeat(64) },
    compatibilityReport: { status: "compatible", reasons: [] },
    now: () => new Date("2026-08-12T08:00:00.000Z"),
  });

  assert.equal(committed.bundleId, `401.0.1-${gameJsSha256.slice(0, 12)}`);
  assert.equal(committed.appVersion, "401.0.1");
  assert.equal(await fsp.readFile(committed.gameJsPath, "utf8"), "candidate-code");
  assert.equal(JSON.parse(await fsp.readFile(committed.packageEvidencePath, "utf8")).bytes, 123);

  await writeActiveGameCodePointer({
    rootDir,
    bundleId: committed.bundleId,
    now: () => new Date("2026-08-12T08:01:00.000Z"),
  });
  const active = readActiveGameCodeBundle({ rootDir });
  assert.equal(active.bundleId, committed.bundleId);
  assert.equal(active.gameJsSha256, gameJsSha256);
  assert.equal(readActiveGameCodePointerSnapshot({ rootDir }).activeCodeVersion, "401.0.1");

  await fsp.writeFile(active.gameJsPath, "tampered", "utf8");
  assert.equal(readActiveGameCodeBundle({ rootDir }), null);
});

test("rejects candidates outside the controlled root, hash mismatches, and same-version different content", async (t) => {
  const rootDir = await createRoot(t);
  const outsideRoot = await createRoot(t);
  const outsidePackage = await writeCandidate(outsideRoot, "401.0.1", "outside");
  await assert.rejects(
    commitCompatibleGameCodeBundle({
      rootDir,
      packageDir: outsidePackage,
      compatibilityReport: { status: "compatible" },
    }),
    (error) => error?.code === "GAME_CODE_CANDIDATE_PATH_OUTSIDE_ROOT",
  );

  const firstPackage = await writeCandidate(rootDir, "401.0.1", "first");
  await assert.rejects(
    commitCompatibleGameCodeBundle({
      rootDir,
      packageDir: firstPackage,
      expectedGameJsSha256: "0".repeat(64),
      compatibilityReport: { status: "compatible" },
    }),
    (error) => error?.code === "GAME_CODE_HASH_MISMATCH",
  );
  await commitCompatibleGameCodeBundle({
    rootDir,
    packageDir: firstPackage,
    compatibilityReport: { status: "compatible" },
  });

  const secondPackage = await writeCandidate(rootDir, "401.0.1", "second");
  await assert.rejects(
    commitCompatibleGameCodeBundle({
      rootDir,
      packageDir: secondPackage,
      compatibilityReport: { status: "compatible" },
    }),
    (error) => error?.code === "GAME_CODE_VERSION_CONTENT_COLLISION",
  );
});

test("requires compatible evidence and preserves the previous pointer when atomic rename fails", async (t) => {
  const rootDir = await createRoot(t);
  const first = await commit(rootDir, await writeCandidate(rootDir, "391.0.25", "old"));
  const second = await commit(rootDir, await writeCandidate(rootDir, "401.0.1", "new"));
  await writeActiveGameCodePointer({ rootDir, bundleId: first.bundleId });

  const failingFs = {
    ...fsp,
    async rename() {
      const error = new Error("rename blocked");
      error.code = "EPERM";
      throw error;
    },
  };
  await assert.rejects(
    writeActiveGameCodePointer({ rootDir, bundleId: second.bundleId, fileSystem: failingFs }),
    /rename blocked/,
  );
  assert.equal(readActiveGameCodeBundle({ rootDir }).bundleId, first.bundleId);
  assert.equal((await fsp.readdir(path.join(rootDir, "runtime", "status"))).some((name) => name.endsWith(".tmp")), false);

  await assert.rejects(
    commitCompatibleGameCodeBundle({
      rootDir,
      packageDir: await writeCandidate(rootDir, "402.0.1", "blocked"),
      compatibilityReport: { status: "manual-review" },
    }),
    (error) => error?.code === "GAME_CODE_COMPATIBILITY_REQUIRED",
  );
});

async function commit(rootDir, packageDir) {
  return commitCompatibleGameCodeBundle({
    rootDir,
    packageDir,
    compatibilityReport: { status: "compatible", reasons: [] },
  });
}

async function createRoot(t) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-game-code-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

async function writeCandidate(rootDir, appVersion, gameJs) {
  const packageDir = path.join(rootDir, "candidates", `${appVersion}-${crypto.randomUUID()}`);
  await fsp.mkdir(path.join(packageDir, "tar"), { recursive: true });
  await fsp.writeFile(path.join(packageDir, "Manifest.xml"), `<manifest><appVersion>${appVersion}</appVersion></manifest>`, "utf8");
  await fsp.writeFile(path.join(packageDir, "tar", "game.js"), gameJs, "utf8");
  await fsp.writeFile(path.join(packageDir, "tar", "modules.json"), JSON.stringify({ modules: [] }), "utf8");
  return packageDir;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
