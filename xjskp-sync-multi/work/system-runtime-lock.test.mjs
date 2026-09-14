import test from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  clearActiveTask,
  readActiveTasks,
  evaluateServerLock,
  readActiveTask,
  readLastTaskExit,
  readLastTaskExits,
  readServerLock,
  writeActiveTask,
  writeLastTaskExit,
  writeServerLock,
} from "./system/runtime-lock.mjs";

test("server lock records the local console process and evaluates as healthy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-lock-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const lock = await writeServerLock({
      runtimeDir,
      rootDir: dir,
      port: 43746,
      instanceId: "instance-test",
      canonicalRuntimeDir: runtimeDir,
      guardName: "test-guard",
      lifecycle: "ready",
      pid: 1234,
      now: () => new Date("2026-06-29T10:00:00.000Z"),
    });

    assert.equal(lock.version, 2);
    assert.equal(lock.instanceId, "instance-test");
    assert.equal(lock.pid, 1234);
    assert.equal(lock.port, 43746);
    assert.equal(lock.rootDir, dir);

    const saved = await readServerLock(runtimeDir);
    assert.equal(saved.startedAt, "2026-06-29T10:00:00.000Z");
    assert.equal(saved.lifecycle, "ready");

    const status = evaluateServerLock(saved, {
      processes: [
        {
          ProcessId: 1234,
          Name: "node.exe",
          CommandLine: `"${path.join(dir, "bin", "node", "node.exe")}" "${path.join(dir, "work", "system", "server.mjs")}"`,
        },
      ],
    });

    assert.equal(status.exists, true);
    assert.equal(status.healthy, true);
    assert.equal(status.reason, "running");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("server lock evaluates stale when the recorded pid is absent", () => {
  const status = evaluateServerLock({
    pid: 2222,
    port: 43746,
    rootDir: "E:\\xjskp-sync-multi",
  }, {
    processes: [
      { ProcessId: 3333, Name: "node.exe", CommandLine: "node other-server.mjs" },
    ],
  });

  assert.equal(status.exists, true);
  assert.equal(status.healthy, false);
  assert.equal(status.reason, "pid-not-found");
});

test("active task lock can be written, read, and cleared", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-task-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    await writeActiveTask(runtimeDir, {
      profileId: "main",
      mode: "loop",
      pid: 9876,
      rootDir: dir,
      logPath: path.join(dir, "runtime", "logs", "main", "auto.log"),
    });

    const task = await readActiveTask(runtimeDir);
    assert.equal(task.profileId, "main");
    assert.equal(task.pid, 9876);
    assert.equal(task.mode, "loop");

    await clearActiveTask(runtimeDir);
    assert.equal(await readActiveTask(runtimeDir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("active task locks are stored per profile and can be cleared independently", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-task-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    await writeActiveTask(runtimeDir, {
      profileId: "main",
      mode: "loop",
      pid: 1111,
      rootDir: dir,
      logPath: path.join(dir, "runtime", "logs", "main", "auto.log"),
    });
    await writeActiveTask(runtimeDir, {
      profileId: "alt",
      mode: "loop",
      pid: 2222,
      rootDir: dir,
      logPath: path.join(dir, "runtime", "logs", "alt", "auto.log"),
    });

    const tasks = await readActiveTasks(runtimeDir);
    assert.deepEqual(tasks.map((task) => task.profileId).sort(), ["alt", "main"]);
    assert.equal((await readActiveTask(runtimeDir, "main")).pid, 1111);

    await clearActiveTask(runtimeDir, "main");

    assert.equal(await readActiveTask(runtimeDir, "main"), null);
    assert.equal((await readActiveTask(runtimeDir, "alt")).pid, 2222);
    assert.deepEqual((await readActiveTasks(runtimeDir)).map((task) => task.profileId), ["alt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy single active-task lock is migrated into the per-profile task directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-task-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    const legacyPath = path.join(runtimeDir, "system", "active-task.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({
      version: 1,
      profileId: "legacy-main",
      mode: "loop",
      pid: 3333,
      rootDir: dir,
      logPath: path.join(dir, "runtime", "logs", "legacy-main", "auto.log"),
      startedAt: "2026-07-04T00:00:00.000Z",
    }), "utf8");

    const tasks = await readActiveTasks(runtimeDir);

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].profileId, "legacy-main");
    assert.equal(tasks[0].pid, 3333);
    assert.equal((await readActiveTask(runtimeDir, "legacy-main")).pid, 3333);
    await assert.rejects(() => readFile(legacyPath, "utf8"), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("last task exits are stored per profile while preserving latest overall exit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-exit-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    await writeLastTaskExit(runtimeDir, {
      profileId: "main",
      mode: "loop",
      pid: 4444,
      exitCode: 42,
      reason: "session-expired",
      exitedAt: "2026-07-04T00:00:00.000Z",
    });
    await writeLastTaskExit(runtimeDir, {
      profileId: "alt",
      mode: "loop",
      pid: 5555,
      exitCode: 1,
      reason: "error",
      exitedAt: "2026-07-04T00:01:00.000Z",
    });

    const exits = await readLastTaskExits(runtimeDir);

    assert.equal(exits.main.reason, "session-expired");
    assert.equal(exits.alt.reason, "error");
    assert.equal((await readLastTaskExit(runtimeDir, "main")).pid, 4444);
    assert.equal((await readLastTaskExit(runtimeDir)).profileId, "alt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("last task exit writes tolerate concurrent profile exits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-exit-race-"));
  try {
    const runtimeDir = path.join(dir, "runtime");
    await Promise.all(Array.from({ length: 12 }, (_, index) => writeLastTaskExit(runtimeDir, {
      profileId: `profile-${index}`,
      mode: "loop",
      pid: 5000 + index,
      exitCode: index,
      reason: index % 2 ? "error" : "stopped",
      exitedAt: `2026-07-04T00:${String(index).padStart(2, "0")}:00.000Z`,
    })));

    const exits = await readLastTaskExits(runtimeDir);
    assert.equal(Object.keys(exits).length, 12);
    assert.equal(exits["profile-0"].pid, 5000);
    assert.equal(exits["profile-11"].pid, 5011);
    assert.match((await readFile(path.join(runtimeDir, "system", "last-task-exit.json"), "utf8")), /profile-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("last task exit writes retry retryable Windows rename failures", async () => {
  const runtimeLock = await import("./system/runtime-lock.mjs");
  assert.equal(typeof runtimeLock.setRuntimeLockTestHooks, "function");
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-exit-rename-retry-"));
  let renameAttempts = 0;
  const failingFs = {
    ...realFs,
    rename: async (from, to) => {
      if (!String(to).endsWith(`${path.sep}last-task-exits${path.sep}main.json`)) {
        return realFs.rename(from, to);
      }
      renameAttempts++;
      if (renameAttempts < 3) {
        const err = new Error("simulated EPERM");
        err.code = "EPERM";
        throw err;
      }
      return realFs.rename(from, to);
    },
  };
  runtimeLock.setRuntimeLockTestHooks({ fsModule: failingFs, retryDelayMs: 0 });
  try {
    const runtimeDir = path.join(dir, "runtime");
    await runtimeLock.writeLastTaskExit(runtimeDir, {
      profileId: "main",
      mode: "loop",
      pid: 4444,
      exitCode: 42,
      reason: "session-expired",
      exitedAt: "2026-07-04T00:00:00.000Z",
    });

    assert.equal(renameAttempts, 3);
    const exit = await runtimeLock.readLastTaskExit(runtimeDir, "main");
    assert.equal(exit.reason, "session-expired");
    assert.match(await readFile(path.join(runtimeDir, "system", "last-task-exits", "main.json"), "utf8"), /session-expired/);
  } finally {
    runtimeLock.setRuntimeLockTestHooks(null);
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearing one active task retries retryable Windows rm failures without touching other profiles", async () => {
  const runtimeLock = await import("./system/runtime-lock.mjs");
  assert.equal(typeof runtimeLock.setRuntimeLockTestHooks, "function");
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-active-rm-retry-"));
  let rmAttempts = 0;
  const failingFs = {
    ...realFs,
    rm: async (target, options) => {
      if (String(target).endsWith(`${path.sep}main.json`) && rmAttempts < 2) {
        rmAttempts++;
        const err = new Error("simulated EBUSY");
        err.code = "EBUSY";
        throw err;
      }
      return realFs.rm(target, options);
    },
  };
  try {
    const runtimeDir = path.join(dir, "runtime");
    await runtimeLock.writeActiveTask(runtimeDir, {
      profileId: "main",
      mode: "loop",
      pid: 1111,
      rootDir: dir,
    });
    await runtimeLock.writeActiveTask(runtimeDir, {
      profileId: "alt",
      mode: "loop",
      pid: 2222,
      rootDir: dir,
    });
    runtimeLock.setRuntimeLockTestHooks({ fsModule: failingFs, retryDelayMs: 0 });

    await runtimeLock.clearActiveTask(runtimeDir, "main");

    assert.equal(rmAttempts, 2);
    assert.equal(await runtimeLock.readActiveTask(runtimeDir, "main"), null);
    assert.equal((await runtimeLock.readActiveTask(runtimeDir, "alt")).pid, 2222);
  } finally {
    runtimeLock.setRuntimeLockTestHooks(null);
    await rm(dir, { recursive: true, force: true });
  }
});
