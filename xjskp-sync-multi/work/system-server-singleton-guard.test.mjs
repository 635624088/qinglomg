import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  acquireServerSingletonGuard,
  resolveServerGuardIdentity,
} from "./system/server-singleton-guard.mjs";

test("guard identity uses canonical physical runtimeDir and a stable SHA-256 pipe name", async () => {
  const identity = await resolveServerGuardIdentity("E:/XJSKP/Runtime", {
    platform: "win32",
    fs: {
      async mkdir() {},
      async realpath() {
        return "E:\\XJSKP\\Runtime";
      },
    },
    randomUUIDFn: () => "instance-1",
  });
  const sameIdentity = await resolveServerGuardIdentity("e:\\xjskp\\runtime", {
    platform: "win32",
    fs: {
      async mkdir() {},
      async realpath() {
        return "e:\\xjskp\\runtime";
      },
    },
    randomUUIDFn: () => "instance-2",
  });

  assert.equal(identity.canonicalRuntimeDir, "e:\\xjskp\\runtime");
  assert.equal(identity.guardKey.length, 64);
  assert.equal(identity.guardName, sameIdentity.guardName);
  assert.match(identity.guardName, /^\\\\\.\\pipe\\xjskp-system-[a-f0-9]{32}$/);
  assert.equal(identity.instanceId, "instance-1");
});

test("same guard key is exclusive while different runtimeDirs remain independent", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-guard-module-"));
  const registry = new Set();
  const transportFactory = createRegistryTransportFactory(registry);
  try {
    const runtimeA = path.join(rootDir, "runtime-a");
    const runtimeB = path.join(rootDir, "runtime-b");
    const first = await acquireServerSingletonGuard({
      runtimeDir: runtimeA,
      transportFactory,
      timeoutMs: 0,
    });
    const otherRuntime = await acquireServerSingletonGuard({
      runtimeDir: runtimeB,
      transportFactory,
      timeoutMs: 0,
    });

    await assert.rejects(
      acquireServerSingletonGuard({ runtimeDir: runtimeA, transportFactory, timeoutMs: 0 }),
      { code: "SYSTEM_SERVER_SINGLETON_UNRESOLVED" },
    );

    await first.release();
    const replacement = await acquireServerSingletonGuard({
      runtimeDir: runtimeA,
      transportFactory,
      timeoutMs: 0,
    });
    await replacement.release();
    await otherRuntime.release();
    assert.equal(registry.size, 0);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("contention retries the same guard and acquires it after the owner releases", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-guard-retry-"));
  const registry = new Set();
  const attemptedNames = [];
  const baseFactory = createRegistryTransportFactory(registry);
  const transportFactory = (options) => {
    attemptedNames.push(options.guardName);
    return baseFactory(options);
  };
  let clock = 0;
  try {
    const runtimeDir = path.join(rootDir, "runtime");
    const owner = await acquireServerSingletonGuard({
      runtimeDir,
      transportFactory,
      timeoutMs: 0,
    });
    let released = false;
    const contender = await acquireServerSingletonGuard({
      runtimeDir,
      transportFactory,
      timeoutMs: 500,
      retryDelayMs: 100,
      nowFn: () => clock,
      delayFn: async (ms) => {
        clock += ms;
        if (!released) {
          released = true;
          await owner.release();
        }
      },
    });

    assert.ok(attemptedNames.length >= 3);
    assert.equal(new Set(attemptedNames).size, 1, "retry must not create an alternate guard name");
    await contender.release();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("contention reports a verified v2 or legacy owner without stealing the guard", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-guard-owner-"));
  const registry = new Set();
  const transportFactory = createRegistryTransportFactory(registry);
  try {
    const runtimeDir = path.join(rootDir, "runtime");
    const owner = await acquireServerSingletonGuard({ runtimeDir, transportFactory, timeoutMs: 0 });

    await assert.rejects(
      acquireServerSingletonGuard({
        runtimeDir,
        transportFactory,
        inspectOwner: async () => ({ status: "ready", version: 2, instanceId: "owner-v2" }),
      }),
      { code: "SYSTEM_SERVER_ALREADY_RUNNING" },
    );
    await assert.rejects(
      acquireServerSingletonGuard({
        runtimeDir,
        transportFactory,
        inspectOwner: async () => ({ status: "legacy", version: 1, pid: 1234 }),
      }),
      { code: "SYSTEM_SERVER_LEGACY_OWNER_RUNNING" },
    );

    assert.equal(registry.size, 1);
    await owner.release();
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("unverified contention times out fail-closed and cleans failed transports", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-guard-timeout-"));
  let clock = 0;
  let cleanupCalls = 0;
  try {
    await assert.rejects(
      acquireServerSingletonGuard({
        runtimeDir: path.join(rootDir, "runtime"),
        timeoutMs: 200,
        retryDelayMs: 100,
        nowFn: () => clock,
        delayFn: async (ms) => {
          clock += ms;
        },
        inspectOwner: async () => null,
        transportFactory: () => ({
          async acquire() {
            const error = new Error("occupied");
            error.code = "EADDRINUSE";
            throw error;
          },
          async release() {
            cleanupCalls++;
          },
        }),
      }),
      { code: "SYSTEM_SERVER_SINGLETON_UNRESOLVED" },
    );
    assert.equal(clock, 200);
    assert.ok(cleanupCalls >= 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("non-contention acquire failures are wrapped after transport cleanup", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-guard-failure-"));
  let cleaned = false;
  try {
    await assert.rejects(
      acquireServerSingletonGuard({
        runtimeDir: path.join(rootDir, "runtime"),
        transportFactory: () => ({
          async acquire() {
            const error = new Error("access denied");
            error.code = "EACCES";
            throw error;
          },
          async release() {
            cleaned = true;
          },
        }),
      }),
      { code: "SYSTEM_SERVER_GUARD_ACQUIRE_FAILED" },
    );
    assert.equal(cleaned, true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("Windows releases the named-pipe guard when its owner process is killed", {
  skip: process.platform !== "win32",
}, async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "xjskp-guard-crash-"));
  const runtimeDir = path.join(rootDir, "runtime");
  const fixturePath = fileURLToPath(new URL("./fixtures/server-singleton-guard-child.mjs", import.meta.url));
  const child = fork(fixturePath, [runtimeDir], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  try {
    const message = await waitForChildMessage(child);
    assert.equal(message.status, "acquired", message.message);
    await assert.rejects(
      acquireServerSingletonGuard({ runtimeDir, timeoutMs: 0 }),
      { code: "SYSTEM_SERVER_SINGLETON_UNRESOLVED" },
    );

    child.kill("SIGKILL");
    await waitForChildExit(child);
    const replacement = await acquireServerSingletonGuard({ runtimeDir, timeoutMs: 1_000 });
    assert.equal(replacement.guardName, message.guardName);
    await replacement.release();
  } finally {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    await rm(rootDir, { recursive: true, force: true });
  }
});

function createRegistryTransportFactory(registry) {
  return ({ guardName }) => {
    let held = false;
    return {
      async acquire() {
        if (registry.has(guardName)) {
          const error = new Error("occupied");
          error.code = "EADDRINUSE";
          throw error;
        }
        registry.add(guardName);
        held = true;
      },
      async release() {
        if (!held) return;
        held = false;
        registry.delete(guardName);
      },
    };
  };
}

function waitForChildMessage(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("guard child did not become ready")), 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("message", (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`guard child exited before ready: code=${code} signal=${signal}`));
    });
  });
}

function waitForChildExit(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}
