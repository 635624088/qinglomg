import assert from "node:assert/strict";
import test from "node:test";

import { buildStatusArtifactFingerprint } from "./status-artifact-fingerprint.mjs";

test("status artifact fingerprint ignores projection-only time and scheduler fields", () => {
  const before = buildStatusArtifactFingerprint({
    updatedAt: "2026-08-14 10:00:00",
    cycle: 1,
    accountScheduler: { observedAt: "2026-08-14 10:00:00", count: 1 },
    automationQueue: {
      nextMatureInSeconds: 120,
      nextMatureText: "2分",
      nextMatureTime: "2026-08-14 10:02:00",
    },
    waterDropNextRestoreText: "30秒",
    resources: { waterDrop: { nextRestoreInSeconds: 30 } },
    summary: { doubleGoldRemainingText: "10分" },
    landRows: [{ landId: 1, statusText: "生长中", remainingText: "1分59秒" }],
  });
  const after = buildStatusArtifactFingerprint({
    updatedAt: "2026-08-14 10:00:05",
    cycle: 2,
    accountScheduler: { observedAt: "2026-08-14 10:00:05", count: 2 },
    automationQueue: {
      nextMatureInSeconds: 115,
      nextMatureText: "1分55秒",
      nextMatureTime: "2026-08-14 10:02:00",
    },
    waterDropNextRestoreText: "25秒",
    resources: { waterDrop: { nextRestoreInSeconds: 25 } },
    summary: { doubleGoldRemainingText: "9分" },
    landRows: [{ landId: 1, statusText: "生长中", remainingText: "1分54秒" }],
  });

  assert.equal(after, before);
});

test("status artifact fingerprint keeps business and lifecycle boundary changes", () => {
  const growing = buildStatusArtifactFingerprint({
    landRows: [{ landId: 1, statusText: "生长中", remainingText: "1秒" }],
    summary: { automationStopped: null },
  });
  const mature = buildStatusArtifactFingerprint({
    landRows: [{ landId: 1, statusText: "可收获", remainingText: "-" }],
    summary: { automationStopped: null },
  });
  const stopped = buildStatusArtifactFingerprint({
    landRows: [{ landId: 1, statusText: "生长中", remainingText: "1秒" }],
    summary: { automationStopped: { reason: "session-expired" } },
  });

  assert.notEqual(mature, growing);
  assert.notEqual(stopped, growing);
});
