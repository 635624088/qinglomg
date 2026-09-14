import fs from "node:fs/promises";
import path from "node:path";

const SYSTEM_FILE = "system.json";

export function createSystemSettingsStore(options = {}) {
  const runtimeDir = options.runtimeDir || path.join(process.cwd(), "runtime");
  const fileSystem = options.fs || fs;
  const onWriteQueued = options.onWriteQueued || (() => {});
  const writeQueues = new Map();

  function settingsPath() {
    return path.join(runtimeDir, "settings", SYSTEM_FILE);
  }

  function write(settings = {}) {
    const previous = writeQueues.get(SYSTEM_FILE) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const filePath = settingsPath();
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
      try {
        await fileSystem.writeFile(tmpPath, `${JSON.stringify(normalizeSystemSettings(settings), null, 2)}\n`, "utf8");
        await fileSystem.rename(tmpPath, filePath);
      } finally {
        await fileSystem.rm(tmpPath, { force: true }).catch(() => {});
      }
    });
    let tracked;
    tracked = current.finally(() => {
      if (writeQueues.get(SYSTEM_FILE) === tracked) writeQueues.delete(SYSTEM_FILE);
    });
    writeQueues.set(SYSTEM_FILE, tracked);
    onWriteQueued();
    return tracked;
  }

  async function read() {
    try {
      const content = await fileSystem.readFile(settingsPath(), "utf8");
      return normalizeSystemSettings(content.trim() ? JSON.parse(content) : {});
    } catch {
      return { allowedHosts: [] };
    }
  }

  async function exists() {
    try {
      await fileSystem.access(settingsPath());
      return true;
    } catch {
      return false;
    }
  }

  async function drain() {
    await (writeQueues.get(SYSTEM_FILE) || Promise.resolve());
  }

  return { settingsPath, exists, read, write, drain };
}

export function normalizeSystemSettings(settings = {}) {
  const raw = Array.isArray(settings?.allowedHosts) ? settings.allowedHosts : [];
  const allowedHosts = [...new Set(
    raw
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean),
  )];
  return { allowedHosts };
}
