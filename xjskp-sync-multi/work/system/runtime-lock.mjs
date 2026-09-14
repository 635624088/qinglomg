import * as defaultFs from "node:fs/promises";
import path from "node:path";

const SYSTEM_DIR = "system";
const SERVER_LOCK_FILE = "server.lock.json";
const ACTIVE_TASK_FILE = "active-task.json";
const LAST_TASK_EXIT_FILE = "last-task-exit.json";
const ACTIVE_TASKS_DIR = "active-tasks";
const LAST_TASK_EXITS_DIR = "last-task-exits";
const SERVER_DISCOVERY_BACKUPS_DIR = "server-discovery-backups";
const jsonWriteQueues = new Map();
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_RETRY_ATTEMPTS = 5;
let fs = defaultFs;
let retryDelayMs = DEFAULT_RETRY_DELAY_MS;
let retryAttempts = DEFAULT_RETRY_ATTEMPTS;

export function setRuntimeLockTestHooks(hooks = null) {
  fs = hooks?.fsModule || defaultFs;
  retryDelayMs = Math.max(0, Math.floor(hooks?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  retryAttempts = Math.max(1, Math.floor(hooks?.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS));
}

export function systemRuntimeDir(runtimeDir) {
  return path.join(runtimeDir, SYSTEM_DIR);
}

export function serverLockPath(runtimeDir) {
  return path.join(systemRuntimeDir(runtimeDir), SERVER_LOCK_FILE);
}

export function activeTaskPath(runtimeDir) {
  return path.join(systemRuntimeDir(runtimeDir), ACTIVE_TASK_FILE);
}

export function lastTaskExitPath(runtimeDir) {
  return path.join(systemRuntimeDir(runtimeDir), LAST_TASK_EXIT_FILE);
}

export function activeTasksDir(runtimeDir) {
  return path.join(systemRuntimeDir(runtimeDir), ACTIVE_TASKS_DIR);
}

export function profileActiveTaskPath(runtimeDir, profileId) {
  return path.join(activeTasksDir(runtimeDir), `${safeProfileFileName(profileId)}.json`);
}

export function lastTaskExitsDir(runtimeDir) {
  return path.join(systemRuntimeDir(runtimeDir), LAST_TASK_EXITS_DIR);
}

export function profileLastTaskExitPath(runtimeDir, profileId) {
  return path.join(lastTaskExitsDir(runtimeDir), `${safeProfileFileName(profileId)}.json`);
}

export async function writeServerLock({
  runtimeDir,
  rootDir,
  port,
  instanceId,
  canonicalRuntimeDir,
  guardName,
  lifecycle = "starting",
  pid = process.pid,
  startedAt = null,
  now = () => new Date(),
}) {
  if (!instanceId || !canonicalRuntimeDir || !guardName) {
    const error = new Error("Server discovery v2 requires instanceId, canonicalRuntimeDir, and guardName");
    error.code = "INVALID_SERVER_DISCOVERY";
    throw error;
  }
  const record = {
    version: 2,
    instanceId,
    pid,
    port,
    rootDir,
    runtimeDir,
    canonicalRuntimeDir,
    guardName,
    lifecycle,
    startedAt: startedAt || now().toISOString(),
  };
  await writeJsonAtomic(serverLockPath(runtimeDir), record);
  return record;
}

export async function readServerLock(runtimeDir) {
  try {
    return await readJsonOrNull(serverLockPath(runtimeDir));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function clearServerLock(runtimeDir, { instanceId } = {}) {
  if (!instanceId) return { cleared: false, reason: "instance-id-required" };
  const current = await readServerLock(runtimeDir);
  if (!current) return { cleared: false, reason: "not-found-or-invalid" };
  if (current.instanceId !== instanceId) {
    return { cleared: false, reason: "owner-mismatch", ownerInstanceId: current.instanceId || null };
  }
  await rmWithRetries(serverLockPath(runtimeDir), { force: true });
  return { cleared: true, reason: "owner-match" };
}

export async function backupServerLock(runtimeDir, { instanceId, now = () => new Date() } = {}) {
  if (!instanceId) {
    const error = new Error("instanceId is required to back up server discovery");
    error.code = "INVALID_SERVER_DISCOVERY_BACKUP";
    throw error;
  }
  const source = serverLockPath(runtimeDir);
  const backupDir = path.join(systemRuntimeDir(runtimeDir), SERVER_DISCOVERY_BACKUPS_DIR);
  const timestamp = now().toISOString().replaceAll(":", "-");
  const safeInstanceId = String(instanceId).replace(/[^A-Za-z0-9_-]/g, "_");
  const target = path.join(backupDir, `${timestamp}-${safeInstanceId}.json`);
  await fs.mkdir(backupDir, { recursive: true });
  try {
    await fs.rename(source, target);
    return { backedUp: true, path: target };
  } catch (error) {
    if (error?.code === "ENOENT") return { backedUp: false, path: null };
    throw error;
  }
}

export function evaluateServerLock(lock, { processes = [] } = {}) {
  if (!lock) {
    return { exists: false, healthy: false, reason: "not-found", lock: null };
  }
  const pid = Number(lock.pid);
  const process = processes.find((item) => Number(item.ProcessId ?? item.pid) === pid);
  if (!process) {
    return { exists: true, healthy: false, reason: "pid-not-found", lock };
  }
  const commandLine = normalizeForMatch(process.CommandLine ?? process.commandLine ?? "");
  const rootDir = normalizeForMatch(lock.rootDir ?? "");
  const looksRelated = !rootDir || commandLine.includes(rootDir) || commandLine.includes("server.mjs");
  return {
    exists: true,
    healthy: looksRelated,
    reason: looksRelated ? "running" : "pid-reused",
    lock,
    process: {
      pid,
      name: process.Name ?? process.name ?? "",
      commandLine: process.CommandLine ?? process.commandLine ?? "",
    },
  };
}

export async function writeActiveTask(runtimeDir, task) {
  const record = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...task,
  };
  if (record.profileId) {
    await writeJsonAtomic(profileActiveTaskPath(runtimeDir, record.profileId), record);
  } else {
    await writeJsonAtomic(activeTaskPath(runtimeDir), record);
  }
  return record;
}

export async function readActiveTask(runtimeDir, profileId = null) {
  if (profileId) return await readJsonOrNull(profileActiveTaskPath(runtimeDir, profileId));
  const tasks = await readActiveTasks(runtimeDir);
  return tasks[0] || null;
}

export async function readActiveTasks(runtimeDir) {
  await migrateLegacyActiveTask(runtimeDir);
  const dir = activeTasksDir(runtimeDir);
  const tasks = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const task = await readJsonOrNull(path.join(dir, entry.name));
      if (task?.profileId) tasks.push(task);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return tasks.sort((a, b) => String(a.profileId).localeCompare(String(b.profileId)));
}

export async function clearActiveTask(runtimeDir, profileId = null) {
  if (profileId) {
    await rmWithRetries(profileActiveTaskPath(runtimeDir, profileId), { force: true });
    return;
  }
  await rmWithRetries(activeTaskPath(runtimeDir), { force: true });
  await rmWithRetries(activeTasksDir(runtimeDir), { recursive: true, force: true });
}

export async function writeLastTaskExit(runtimeDir, exit) {
  const record = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...exit,
  };
  if (record.profileId) {
    await writeJsonAtomic(profileLastTaskExitPath(runtimeDir, record.profileId), record);
  }
  await writeJsonAtomic(lastTaskExitPath(runtimeDir), record);
  return record;
}

export async function readLastTaskExit(runtimeDir, profileId = null) {
  if (profileId) return await readJsonOrNull(profileLastTaskExitPath(runtimeDir, profileId));
  const legacy = await readJsonOrNull(lastTaskExitPath(runtimeDir));
  if (legacy) return legacy;
  const exits = Object.values(await readLastTaskExits(runtimeDir));
  return exits.sort((a, b) => String(b.updatedAt || b.exitedAt || "").localeCompare(String(a.updatedAt || a.exitedAt || "")))[0] || null;
}

export async function readLastTaskExits(runtimeDir) {
  const dir = lastTaskExitsDir(runtimeDir);
  const exits = {};
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const exit = await readJsonOrNull(path.join(dir, entry.name));
      if (exit?.profileId) exits[exit.profileId] = exit;
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  const legacy = await readJsonOrNull(lastTaskExitPath(runtimeDir));
  if (legacy?.profileId && !exits[legacy.profileId]) exits[legacy.profileId] = legacy;
  return exits;
}

export async function clearLastTaskExit(runtimeDir, profileId = null) {
  if (profileId) {
    await rmWithRetries(profileLastTaskExitPath(runtimeDir, profileId), { force: true });
    const legacy = await readJsonOrNull(lastTaskExitPath(runtimeDir));
    if (legacy?.profileId === profileId) await rmWithRetries(lastTaskExitPath(runtimeDir), { force: true });
    return;
  }
  await rmWithRetries(lastTaskExitPath(runtimeDir), { force: true });
  await rmWithRetries(lastTaskExitsDir(runtimeDir), { recursive: true, force: true });
}

export function evaluateActiveTask(task, { processes = [], rootDir = "" } = {}) {
  if (!task) {
    return { exists: false, healthy: false, reason: "not-found", task: null };
  }
  const pid = Number(task.pid);
  const process = processes.find((item) => Number(item.ProcessId ?? item.pid) === pid);
  if (!process) {
    return { exists: true, healthy: false, reason: "pid-not-found", task };
  }
  const commandLine = normalizeForMatch(process.CommandLine ?? process.commandLine ?? "");
  const expectedRoot = normalizeForMatch(task.rootDir || rootDir);
  const looksRelated = !expectedRoot
    || commandLine.includes(expectedRoot)
    || commandLine.includes("inspect-garden-dryrun.mjs")
    || (task.runtimeMode === "worker" && commandLine.includes("server.mjs"));
  return {
    exists: true,
    healthy: looksRelated,
    reason: looksRelated ? "running" : "pid-reused",
    task,
    process: {
      pid,
      name: process.Name ?? process.name ?? "",
      commandLine: process.CommandLine ?? process.commandLine ?? "",
    },
  };
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJsonAtomic(filePath, value) {
  const queueKey = normalizeForMatch(path.resolve(filePath));
  const previous = jsonWriteQueues.get(queueKey) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => writeJsonAtomicUnlocked(filePath, value));
  jsonWriteQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (jsonWriteQueues.get(queueKey) === current) jsonWriteQueues.delete(queueKey);
  }
}

async function writeJsonAtomicUnlocked(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await retryFsOperation(() => fs.rename(tmpPath, filePath));
  } catch (err) {
    await rmWithRetries(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function rmWithRetries(filePath, options) {
  return await retryFsOperation(() => fs.rm(filePath, options));
}

async function retryFsOperation(operation) {
  let lastError = null;
  for (let attempt = 1; attempt <= retryAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (!isRetryableFsError(err) || attempt >= retryAttempts) throw err;
      await sleep(retryDelayMs);
    }
  }
  throw lastError;
}

function isRetryableFsError(err) {
  return err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES";
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function migrateLegacyActiveTask(runtimeDir) {
  const legacyPath = activeTaskPath(runtimeDir);
  const legacy = await readJsonOrNull(legacyPath);
  if (!legacy?.profileId) return;
  const targetPath = profileActiveTaskPath(runtimeDir, legacy.profileId);
  if (!(await pathExists(targetPath))) {
    await writeJsonAtomic(targetPath, legacy);
  }
  await rmWithRetries(legacyPath, { force: true });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeProfileFileName(profileId) {
  const value = String(profileId || "").trim();
  if (!value) throw new Error("Missing profile id for runtime lock");
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "profile";
}

function normalizeForMatch(value) {
  return String(value ?? "").replace(/\//g, "\\").toLowerCase();
}
