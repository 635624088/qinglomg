import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readGameCodeStatus } from "./system/game-code-status.mjs";

test("code review status comes only from the analysis index and never assumes the local package was analyzed", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-code-status-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(rootDir, "client-analysis"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "client-analysis", "latest.json"), JSON.stringify({ appVersion: "380.0.25" }), "utf8");

  assert.deepEqual(await readGameCodeStatus({
    rootDir,
    localVersion: "391.0.25",
    officialVersion: "400.0.15",
    comparison: "newer",
  }), {
    localVersion: "391.0.25",
    officialVersion: "400.0.15",
    comparison: "newer",
    analyzedVersion: "380.0.25",
    reviewStatus: "pending-analysis",
  });
});

test("missing analysis evidence is unknown before official check and pending afterward", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-code-status-missing-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  assert.equal((await readGameCodeStatus({ rootDir, localVersion: "391.0.25" })).reviewStatus, "unknown");
  assert.equal((await readGameCodeStatus({ rootDir, localVersion: "391.0.25", officialVersion: "400.0.15" })).reviewStatus, "pending-analysis");
});

test("an active verified joint release is accepted as code compatibility evidence", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-code-status-release-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const status = await readGameCodeStatus({
    rootDir,
    localVersion: "401.0.1",
    officialVersion: "401.0.1",
    comparison: "same",
    readActiveRelease: () => ({ code: { appVersion: "401.0.1" } }),
  });
  assert.equal(status.analyzedVersion, "401.0.1");
  assert.equal(status.reviewStatus, "current");
});
