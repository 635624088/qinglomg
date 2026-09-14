import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export function gameDataSyncLockPath(runtimeDir) {
  return path.join(path.resolve(runtimeDir), "status", "game-data-sync.lock");
}

export async function acquireGameDataSyncLock(options = {}) {
  const runtimeDir = path.resolve(options.runtimeDir || path.join(process.cwd(), "runtime"));
  const fileSystem = options.fs || fs;
  const lockPath = gameDataSyncLockPath(runtimeDir);
  const ownerId = options.ownerId || crypto.randomUUID();
  await fileSystem.mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await fileSystem.open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify({
      schemaVersion: 1,
      ownerId,
      ownerPid: process.pid,
      createdAt: (options.now?.() || new Date()).toISOString(),
    }, null, 2)}\n`, "utf8");
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") throw syncLockError();
    throw error;
  }
  await handle.close();
  let released = false;
  return {
    lockPath,
    async release() {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(await fileSystem.readFile(lockPath, "utf8"));
        if (current?.ownerId === ownerId) await fileSystem.rm(lockPath, { force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
  };
}

export function assertGameDataSyncStartAllowed(options = {}) {
  const runtimeDir = path.resolve(options.runtimeDir || path.join(process.cwd(), "runtime"));
  const fsModule = options.fsModule || fsSync;
  try {
    fsModule.accessSync(gameDataSyncLockPath(runtimeDir), fsSync.constants.F_OK);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  throw syncLockError();
}

export async function recoverStaleGameDataSyncLock(options = {}) {
  const runtimeDir = path.resolve(options.runtimeDir || path.join(process.cwd(), "runtime"));
  const fileSystem = options.fs || fs;
  const lockPath = gameDataSyncLockPath(runtimeDir);
  let record;
  try {
    record = JSON.parse(await fileSystem.readFile(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    record = null;
  }
  const ownerPid = Number(record?.ownerPid);
  const isAlive = options.isProcessAlive || defaultIsProcessAlive;
  if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && isAlive(ownerPid)) return false;
  await fileSystem.rm(lockPath, { force: true });
  return true;
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function syncLockError() {
  return Object.assign(new Error("游戏数据同步期间不能启动账号任务"), {
    statusCode: 409,
    code: "GAME_DATA_SYNC_IN_PROGRESS",
  });
}
