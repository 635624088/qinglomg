import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createAutomationRunner,
  getWindowsProcessSnapshot,
} from "./system/process-manager.mjs";
import { createStaleWhileRevalidateSnapshot } from "./system/process-snapshot-cache.mjs";

test("stale-while-revalidate snapshot serves cached data while one refresh is in flight", async () => {
  let nowMs = 0;
  let releaseRefresh;
  let calls = 0;
  const snapshot = createStaleWhileRevalidateSnapshot({
    maxAgeMs: 5_000,
    now: () => nowMs,
    load: async () => {
      calls += 1;
      if (calls === 1) return [{ ProcessId: 1 }];
      return await new Promise((resolve) => {
        releaseRefresh = () => resolve([{ ProcessId: 2 }]);
      });
    },
  });

  assert.deepEqual(await snapshot.get(), [{ ProcessId: 1 }]);
  assert.deepEqual(await snapshot.get(), [{ ProcessId: 1 }]);
  assert.equal(calls, 1);

  nowMs = 5_001;
  assert.deepEqual(await snapshot.get(), [{ ProcessId: 1 }]);
  assert.deepEqual(await snapshot.get(), [{ ProcessId: 1 }]);
  assert.equal(calls, 2);

  releaseRefresh();
  await snapshot.flush();
  assert.deepEqual(await snapshot.get(), [{ ProcessId: 2 }]);
});

test("snapshot refresh keeps the last good value after a background failure", async () => {
  let nowMs = 0;
  let calls = 0;
  const errors = [];
  const snapshot = createStaleWhileRevalidateSnapshot({
    maxAgeMs: 100,
    now: () => nowMs,
    onError: (error) => errors.push(error.message),
    load: async () => {
      calls += 1;
      if (calls === 1) return ["good"];
      throw new Error("scan failed");
    },
  });

  assert.deepEqual(await snapshot.get(), ["good"]);
  nowMs = 101;
  assert.deepEqual(await snapshot.get(), ["good"]);
  await snapshot.flush();

  assert.deepEqual(await snapshot.get(), ["good"]);
  assert.deepEqual(errors, ["scan failed"]);
});

test("automation runner caches read-only snapshots but runtime reconciliation scans fresh", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-process-snapshot-"));
  let calls = 0;
  try {
    const runner = createAutomationRunner({
      rootDir: dir,
      runtimeDir: path.join(dir, "runtime"),
      watchdogIntervalMs: 0,
      processSnapshotCacheMs: 10_000,
      processProvider: async () => {
        calls += 1;
        return [];
      },
    });

    await runner.snapshot();
    await runner.snapshot();
    assert.equal(calls, 1);

    await runner.runtime();
    assert.equal(calls, 2);
    await runner.shutdown();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Windows process inspection uses an asynchronous child process", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  let spawned = false;

  const pending = getWindowsProcessSnapshot({
    spawnFn: (...args) => {
      spawned = true;
      assert.equal(args[0], "powershell");
      queueMicrotask(() => {
        child.stdout.emit("data", '[{"ProcessId":42}]');
        child.emit("close", 0);
      });
      return child;
    },
  });

  assert.equal(spawned, true);
  assert.deepEqual(await pending, [{ ProcessId: 42 }]);
});
