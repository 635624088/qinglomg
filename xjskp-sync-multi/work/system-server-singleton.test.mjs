import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  clearServerLock,
  readServerLock,
  writeServerLock,
} from "./system/runtime-lock.mjs";
import { createSystemServer } from "./system/server.mjs";
import { acquireServerSingletonGuard } from "./system/server-singleton-guard.mjs";

test("same runtimeDir concurrent server startup admits exactly one owner", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-server-singleton-"));
  const runtimeDir = path.join(rootDir, "runtime");
  const preferredPort = await reservePort();
  const restoreCalls = [];
  const first = createIsolatedServer({ rootDir, runtimeDir, restoreCalls, name: "first" });
  const second = createIsolatedServer({ rootDir, runtimeDir, restoreCalls, name: "second" });

  try {
    const results = await Promise.allSettled([
      first.listen(preferredPort),
      second.listen(preferredPort),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");

    assert.equal(fulfilled.length, 1, "only one server may listen for one runtimeDir");
    assert.equal(rejected.length, 1, "the contender must fail closed");
    assert.match(
      rejected[0].reason?.code || "",
      /^SYSTEM_SERVER_(?:ALREADY_RUNNING|SINGLETON_UNRESOLVED)$/,
    );
    assert.equal(restoreCalls.length, 1, "only the owner may restore desired loops");
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("an old owner cannot clear a newer discovery record", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-server-discovery-"));
  const runtimeDir = path.join(rootDir, "runtime");

  try {
    await writeServerLock({
      runtimeDir,
      rootDir,
      port: 43722,
      instanceId: "owner-old",
      canonicalRuntimeDir: runtimeDir,
      guardName: "test-guard",
      lifecycle: "ready",
    });
    await writeServerLock({
      runtimeDir,
      rootDir,
      port: 43723,
      instanceId: "owner-new",
      canonicalRuntimeDir: runtimeDir,
      guardName: "test-guard",
      lifecycle: "ready",
    });

    const result = await clearServerLock(runtimeDir, { instanceId: "owner-old" });
    assert.equal(result.cleared, false);
    assert.equal((await readServerLock(runtimeDir))?.instanceId, "owner-new");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("ready health and discovery expose the same v2 owner identity", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-server-health-v2-"));
  const runtimeDir = path.join(rootDir, "runtime");
  const server = createIsolatedServer({ rootDir, runtimeDir, restoreCalls: [], name: "owner" });
  try {
    await server.listen(0);
    const health = await (await fetch(`http://127.0.0.1:${server.port}/api/health`)).json();
    const discovery = await readServerLock(runtimeDir);

    assert.equal(health.version, 2);
    assert.equal(health.lifecycle, "ready");
    assert.equal(health.instanceId, discovery.instanceId);
    assert.equal(health.canonicalRuntimeDir, discovery.canonicalRuntimeDir);
    assert.equal(health.guardName, discovery.guardName);
    assert.equal(discovery.lifecycle, "ready");
  } finally {
    await server.close().catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("stop API rejects a stale instanceId without stopping the current owner", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-server-stop-owner-"));
  const runtimeDir = path.join(rootDir, "runtime");
  const server = createIsolatedServer({ rootDir, runtimeDir, restoreCalls: [], name: "owner" });
  try {
    await server.listen(0);
    const base = `http://127.0.0.1:${server.port}`;
    const session = await (await fetch(`${base}/api/session`)).json();
    const response = await fetch(`${base}/api/system/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xjskp-session-token": session.token,
      },
      body: JSON.stringify({ instanceId: "stale-owner" }),
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.error, "SYSTEM_SERVER_INSTANCE_MISMATCH");
    assert.equal((await (await fetch(`${base}/api/health`)).json()).lifecycle, "ready");
  } finally {
    await server.close().catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("startup rollback releases HTTP, discovery, and guard after desired restore fails", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-server-rollback-"));
  const runtimeDir = path.join(rootDir, "runtime");
  const failing = createIsolatedServer({
    rootDir,
    runtimeDir,
    restoreCalls: [],
    name: "failing",
    runnerOverride: {
      async restoreDesiredLoops() {
        throw new Error("controlled restore failure");
      },
      async runtime() {
        return { activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [] };
      },
      async stop() {
        return { stopped: true };
      },
    },
  });
  const replacement = createIsolatedServer({ rootDir, runtimeDir, restoreCalls: [], name: "replacement" });
  try {
    await assert.rejects(failing.listen(0), /controlled restore failure/);
    assert.equal(await readServerLock(runtimeDir), null);
    await replacement.listen(0);
    assert.equal((await readServerLock(runtimeDir))?.lifecycle, "ready");
  } finally {
    await failing.close().catch(() => {});
    await replacement.close().catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("guard owner preserves stale discovery as a diagnostic backup before replacement", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-server-stale-backup-"));
  const runtimeDir = path.join(rootDir, "runtime");
  const lockPath = path.join(runtimeDir, "system", "server.lock.json");
  await mkdir(path.dirname(lockPath), { recursive: true });
  await writeFile(lockPath, "{stale-json", "utf8");
  const server = createIsolatedServer({ rootDir, runtimeDir, restoreCalls: [], name: "owner" });
  try {
    await server.listen(0);
    const backupDir = path.join(runtimeDir, "system", "server-discovery-backups");
    const backups = await readdir(backupDir);
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(backupDir, backups[0]), "utf8"), "{stale-json");
    assert.equal((await readServerLock(runtimeDir))?.version, 2);
  } finally {
    await server.close().catch(() => {});
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("corrupt discovery is not deleted while another process still holds the guard", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-server-corrupt-held-"));
  const runtimeDir = path.join(rootDir, "runtime");
  const lockPath = path.join(runtimeDir, "system", "server.lock.json");
  await mkdir(path.dirname(lockPath), { recursive: true });
  const owner = await acquireServerSingletonGuard({ runtimeDir, timeoutMs: 0 });
  await writeFile(lockPath, "{corrupt-owner", "utf8");
  let contender = null;
  try {
    contender = createSystemServer({
      rootDir,
      runtimeDir,
      runner: {
        async restoreDesiredLoops() {},
        async stop() {
          return { stopped: false };
        },
      },
      coordinatedRunner: {
        async beginAutomationAlreadyCoordinated() {
          throw new Error("singleton fixture must not start profile automation");
        },
      },
      gameVersionScheduler: { start() {}, stop() {}, getStatus: () => null },
      singletonGuardOptions: { timeoutMs: 0 },
      localRequestToken: "singleton-test-token",
    });
    await assert.rejects(contender.listen(0), { code: "SYSTEM_SERVER_SINGLETON_UNRESOLVED" });
    assert.equal(await readFile(lockPath, "utf8"), "{corrupt-owner");
  } finally {
    await contender?.close().catch(() => {});
    await owner.release();
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("healthy v1 discovery blocks v2 startup before guard acquisition", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-server-legacy-owner-"));
  const runtimeDir = path.join(rootDir, "runtime");
  const legacy = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      pid: process.pid,
      port: legacy.address().port,
      rootDir,
      runtimeDir,
    }));
  });
  await new Promise((resolve, reject) => {
    legacy.once("error", reject);
    legacy.listen(0, "127.0.0.1", resolve);
  });
  await mkdir(path.join(runtimeDir, "system"), { recursive: true });
  await writeFile(path.join(runtimeDir, "system", "server.lock.json"), JSON.stringify({
    version: 1,
    pid: process.pid,
    port: legacy.address().port,
    rootDir,
    startedAt: "2026-08-10T00:00:00.000Z",
  }), "utf8");
  const contender = createIsolatedServer({ rootDir, runtimeDir, restoreCalls: [], name: "v2" });
  try {
    await assert.rejects(contender.listen(0), { code: "SYSTEM_SERVER_LEGACY_OWNER_RUNNING" });
  } finally {
    await contender.close().catch(() => {});
    await new Promise((resolve) => legacy.close(resolve));
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("different runtimeDirs may start independently and the owner keeps HTTP port fallback", async () => {
  const rootA = await mkdtemp(path.join(tmpdir(), "xjskp-server-runtime-a-"));
  const rootB = await mkdtemp(path.join(tmpdir(), "xjskp-server-runtime-b-"));
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "0.0.0.0", resolve);
  });
  const preferredPort = occupied.address().port;
  const first = createIsolatedServer({
    rootDir: rootA,
    runtimeDir: path.join(rootA, "runtime"),
    restoreCalls: [],
    name: "first",
  });
  const second = createIsolatedServer({
    rootDir: rootB,
    runtimeDir: path.join(rootB, "runtime"),
    restoreCalls: [],
    name: "second",
  });
  try {
    await Promise.all([first.listen(preferredPort), second.listen(preferredPort)]);
    assert.notEqual(first.port, preferredPort);
    assert.notEqual(second.port, preferredPort);
    assert.notEqual(first.port, second.port);
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
    await new Promise((resolve) => occupied.close(resolve));
    await Promise.all([
      rm(rootA, { recursive: true, force: true }),
      rm(rootB, { recursive: true, force: true }),
    ]);
  }
});

test("launcher leaves stale discovery cleanup to the guard owner", async () => {
  const source = await readFile(new URL("./start-system.ps1", import.meta.url), "utf8");

  assert.doesNotMatch(
    source,
    /Remove-Item\s+-LiteralPath\s+\$LockPath\s+-Force/i,
    "launcher must not delete discovery before the server acquires the guard",
  );
});

test("stop script targets a v2 instance and never deletes discovery or the named pipe", async () => {
  const source = await readFile(new URL("./stop-system.ps1", import.meta.url), "utf8");

  assert.match(source, /instanceId/);
  assert.match(source, /x-xjskp-session-token/);
  assert.doesNotMatch(source, /Remove-Item\s+-LiteralPath\s+\$LockPath/i);
  assert.doesNotMatch(source, /\\\\\.\\pipe|xjskp-system-/i);
  assert.doesNotMatch(source, /WindowStyle\s+Hidden|Start-Job|-AsJob/i);
});

function createIsolatedServer({ rootDir, runtimeDir, restoreCalls, name, runnerOverride = null }) {
  const runner = runnerOverride || {
    async restoreDesiredLoops() {
      restoreCalls.push(name);
    },
    async runtime() {
      return { activeTasks: [], activeByProfile: {}, runningCount: 0, legacyProcesses: [] };
    },
    async stop() {
      return { stopped: false };
    },
  };
  return createSystemServer({
    rootDir,
    runtimeDir,
    runner,
    coordinatedRunner: {
      async beginAutomationAlreadyCoordinated() {
        throw new Error("singleton fixture must not start profile automation");
      },
    },
    legacyMigrator: {
      async inspect() {
        return { complete: false };
      },
    },
    gameVersionScheduler: {
      start() {},
      stop() {},
      getStatus() {
        return null;
      },
    },
    localRequestToken: "singleton-test-token",
  });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
