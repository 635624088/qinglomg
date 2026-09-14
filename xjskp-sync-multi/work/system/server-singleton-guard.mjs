import crypto from "node:crypto";
import * as defaultFs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 100;

export async function resolveServerGuardIdentity(runtimeDir, options = {}) {
  if (!runtimeDir) {
    throw createGuardError("SYSTEM_SERVER_GUARD_INVALID_RUNTIME", "runtimeDir is required");
  }
  const fs = options.fs || defaultFs;
  const platform = options.platform || process.platform;
  await fs.mkdir(runtimeDir, { recursive: true });
  const physicalPath = await fs.realpath(runtimeDir);
  const canonicalRuntimeDir = normalizeCanonicalRuntimeDir(physicalPath, platform);
  const guardKey = crypto.createHash("sha256").update(canonicalRuntimeDir, "utf8").digest("hex");
  const guardName = platform === "win32"
    ? `\\\\.\\pipe\\xjskp-system-${guardKey.slice(0, 32)}`
    : String(resolveLoopbackGuardPort(guardKey));
  return {
    canonicalRuntimeDir,
    guardKey,
    guardName,
    instanceId: (options.randomUUIDFn || crypto.randomUUID)(),
  };
}

function resolveLoopbackGuardPort(guardKey) {
  // Deterministic loopback port in 32768-45055 derived from the runtime dir hash.
  return 32768 + (parseInt(guardKey.slice(0, 8), 16) % 12288);
}

export async function acquireServerSingletonGuard(options = {}) {
  const identity = options.identity || await resolveServerGuardIdentity(options.runtimeDir, options);
  const platform = options.platform || process.platform;
  const transportFactory = options.transportFactory
    || ((context) => createGuardTransport({ ...context, platform }));
  const inspectOwner = options.inspectOwner || (async () => null);
  const timeoutMs = normalizeDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const retryDelayMs = Math.max(1, normalizeDuration(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS));
  const nowFn = options.nowFn || Date.now;
  const delayFn = options.delayFn || delay;
  const deadline = nowFn() + timeoutMs;

  while (true) {
    const transport = transportFactory({ ...identity, platform });
    try {
      await transport.acquire(identity.guardName);
      let held = true;
      return {
        ...identity,
        get held() {
          return held;
        },
        async release() {
          if (!held) return;
          held = false;
          await transport.release();
        },
      };
    } catch (error) {
      await safeRelease(transport);
      if (error?.code !== "EADDRINUSE") {
        throw createGuardError(
          "SYSTEM_SERVER_GUARD_ACQUIRE_FAILED",
          `Unable to acquire singleton guard: ${error?.message || error}`,
          { cause: error },
        );
      }

      const owner = await inspectOwnerSafely(inspectOwner, identity);
      if (owner?.status === "ready" && Number(owner.version) >= 2) {
        throw createGuardError(
          "SYSTEM_SERVER_ALREADY_RUNNING",
          "A server already owns this runtimeDir",
          { owner },
        );
      }
      if (owner?.status === "legacy" || Number(owner?.version) === 1 && owner?.healthy) {
        throw createGuardError(
          "SYSTEM_SERVER_LEGACY_OWNER_RUNNING",
          "A legacy server is still running for this runtimeDir",
          { owner },
        );
      }

      const now = nowFn();
      if (now >= deadline) {
        throw createGuardError(
          "SYSTEM_SERVER_SINGLETON_UNRESOLVED",
          "The singleton guard is occupied but its owner could not be verified",
          { owner: owner || null },
        );
      }
      await delayFn(Math.min(retryDelayMs, Math.max(1, deadline - now)));
    }
  }
}

function normalizeCanonicalRuntimeDir(value, platform) {
  const raw = String(value || "");
  if (platform === "win32") {
    return path.win32.normalize(raw.replaceAll("/", "\\")).toLowerCase();
  }
  return path.resolve(raw);
}

function createGuardTransport({ platform }) {
  if (platform === "win32") {
    return createNamedPipeTransport({ platform });
  }
  return createLoopbackTcpTransport();
}

// Linux: bind an exclusive loopback TCP port instead of a named pipe.
// Port collision surfaces as EADDRINUSE, matching the named-pipe semantics.
function createLoopbackTcpTransport() {
  let server = null;
  return {
    async acquire(guardName) {
      if (server) throw new Error("Guard transport already used");
      const candidate = net.createServer((socket) => socket.destroy());
      server = candidate;
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          candidate.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          candidate.off("error", onError);
          candidate.on("error", () => {});
          resolve();
        };
        candidate.once("error", onError);
        candidate.once("listening", onListening);
        candidate.listen(Number(guardName), "127.0.0.1");
      });
    },
    async release() {
      const current = server;
      server = null;
      if (!current?.listening) return;
      await new Promise((resolve, reject) => {
        current.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function createNamedPipeTransport({ platform }) {
  if (platform !== "win32") {
    return {
      async acquire() {
        throw createGuardError(
          "SYSTEM_SERVER_GUARD_UNSUPPORTED_PLATFORM",
          `Named-pipe singleton guard is unsupported on ${platform}`,
        );
      },
      async release() {},
    };
  }

  let server = null;
  return {
    async acquire(guardName) {
      if (server) throw new Error("Guard transport already used");
      const candidate = net.createServer((socket) => socket.destroy());
      server = candidate;
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          candidate.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          candidate.off("error", onError);
          candidate.on("error", () => {});
          resolve();
        };
        candidate.once("error", onError);
        candidate.once("listening", onListening);
        candidate.listen(guardName);
      });
    },
    async release() {
      const current = server;
      server = null;
      if (!current?.listening) return;
      await new Promise((resolve, reject) => {
        current.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function inspectOwnerSafely(inspectOwner, identity) {
  try {
    return await inspectOwner(identity);
  } catch {
    return null;
  }
}

async function safeRelease(transport) {
  try {
    await transport?.release?.();
  } catch {
    // Failed acquire transports do not own the authoritative guard.
  }
}

function normalizeDuration(value, fallback) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function createGuardError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
