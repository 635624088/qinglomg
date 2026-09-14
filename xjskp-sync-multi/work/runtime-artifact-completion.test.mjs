import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createRuntimeArtifactCompletion,
  cleanupRuntimeArtifactTemps,
  summarizeArtifactSubmission,
} from "./runtime-artifact-completion.mjs";

const TARGETS = {
  garden: ["garden-status.json", "garden-status.html", "garden-status.md"],
  order: ["order-status.json"],
};

test("runtime artifact completion requires every target in its own chain", () => {
  const garden = summarizeArtifactSubmission("garden", [
    { path: "garden-status.json", status: "committed" },
    { path: "garden-status.html", status: "committed" },
    { path: "garden-status.md", status: "committed" },
  ], { requiredTargets: TARGETS.garden });
  const order = summarizeArtifactSubmission("order", [
    { path: "order-status.json", status: "committed" },
  ], { requiredTargets: TARGETS.order });

  assert.equal(garden.status, "complete");
  assert.equal(garden.complete, true);
  assert.equal(order.status, "complete");
  assert.equal(order.complete, true);
});

test("old files and partial or uncertain submissions never become first complete state", () => {
  const result = summarizeArtifactSubmission("garden", [
    { path: "garden-status.json", status: "committed" },
    { path: "garden-status.html", status: "failed", errorCode: "EPERM" },
    { path: "garden-status.md", status: "unknown" },
  ], { requiredTargets: TARGETS.garden });

  assert.equal(result.status, "incomplete");
  assert.equal(result.complete, false);
  assert.deepEqual(result.failedTargets, ["garden-status.html", "garden-status.md"]);
  assert.deepEqual(result.missingTargets, []);
  assert.equal(result.usedExistingFileAsSuccess, false);
});

test("garden and order completion remain independent and late callbacks are rejected after stop", () => {
  const completion = createRuntimeArtifactCompletion({ requiredTargets: TARGETS });

  const garden = completion.observe("garden", [
    { path: "garden-status.json", status: "committed" },
    { path: "garden-status.html", status: "committed" },
    { path: "garden-status.md", status: "committed" },
  ]);
  assert.equal(garden.status, "complete");
  assert.equal(completion.snapshot().order.status, "pending");

  const closed = completion.close("user-stopped");
  assert.equal(closed.closed, true);
  const late = completion.observe("order", [
    { path: "order-status.json", status: "committed" },
  ]);

  assert.deepEqual(late, {
    chain: "order",
    status: "superseded",
    complete: false,
    reason: "user-stopped",
  });
  assert.equal(completion.snapshot().order.status, "pending");
});

test("runtime stop cleanup removes only known artifact temporary files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-artifact-stop-"));
  try {
    await Promise.all([
      fs.writeFile(path.join(dir, "garden-status.json.123.456.tmp"), "late"),
      fs.writeFile(path.join(dir, "garden-status.html.tmp"), "late"),
      fs.writeFile(path.join(dir, "unrelated.tmp"), "keep"),
    ]);

    const removed = await cleanupRuntimeArtifactTemps(dir);

    assert.deepEqual(removed.sort(), [
      "garden-status.html.tmp",
      "garden-status.json.123.456.tmp",
    ]);
    assert.equal(await fs.stat(path.join(dir, "unrelated.tmp")) !== null, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
