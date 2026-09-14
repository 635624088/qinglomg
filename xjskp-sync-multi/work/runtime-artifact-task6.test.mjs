import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildOfflineRuntimeArtifactOptimizationComparison,
  collectRuntimeTempDryRun,
  measureRuntimeResources,
} from "./runtime-artifact-task6.mjs";

test("Task 6 uses the same offline fixture and preserves game, log and full-read metrics", () => {
  const comparison = buildOfflineRuntimeArtifactOptimizationComparison();

  assert.equal(comparison.baseline.artifact.buildCount, 3);
  assert.equal(comparison.optimized.artifact.buildCount, 0);
  assert.equal(comparison.baseline.artifact.logicalWriteBytes, 195);
  assert.equal(comparison.optimized.artifact.logicalWriteBytes, 0);
  assert.equal(comparison.baseline.artifact.actualReplaceCount, 9);
  assert.equal(comparison.optimized.artifact.actualReplaceCount, 0);
  assert.deepEqual(comparison.optimized.game, comparison.baseline.game);
  assert.deepEqual(comparison.optimized.logs, comparison.baseline.logs);
  assert.deepEqual(comparison.optimized.fullStatusRead, comparison.baseline.fullStatusRead);
  assert.deepEqual(comparison.optimized.lifecycle, comparison.baseline.lifecycle);
});

test("runtime temp dry-run inventories candidates without deleting anything", async (t) => {
  const root = await fsTempDirectory(t);
  await mkdir(path.join(root, "status", "p1"), { recursive: true });
  await mkdir(path.join(root, "logs", "p1"), { recursive: true });
  await writeFile(path.join(root, "status", "p1", "garden-status.json.12.100.abc.tmp"), "status");
  await writeFile(path.join(root, "logs", "p1", "auto-plant.log.12.100.abc.tmp"), "log");
  await writeFile(path.join(root, "status", "p1", "garden-status.json"), "stable");

  const report = await collectRuntimeTempDryRun(root, {
    nowMs: 200_000,
    staleAfterMs: 1_000,
  });

  assert.equal(report.readOnly, true);
  assert.equal(report.deletionPerformed, false);
  assert.equal(report.totalFiles, 2);
  assert.equal(report.byArea.status.count, 1);
  assert.equal(report.byArea.logs.count, 1);
  assert.deepEqual(report.cleanup.safeToDelete, []);
  assert.equal(report.cleanup.authorizationRequired, true);
  assert.equal(report.cleanup.manualReview.length, 2);
  await access(path.join(root, "status", "p1", "garden-status.json.12.100.abc.tmp"));
  await access(path.join(root, "logs", "p1", "auto-plant.log.12.100.abc.tmp"));
});

test("runtime resource sampling exposes memory and event-loop metrics", async () => {
  const sample = await measureRuntimeResources({ durationMs: 20, resolutionMs: 10 });

  assert.ok(Number.isFinite(sample.rssBytes) && sample.rssBytes > 0);
  assert.ok(Number.isFinite(sample.heapUsedBytes) && sample.heapUsedBytes >= 0);
  assert.ok(Number.isFinite(sample.eventLoopDelayMs.p95));
  assert.ok(sample.sampleDurationMs >= 0);
});

async function fsTempDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xjskp-task6-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
