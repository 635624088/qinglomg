import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_KEEP_PER_PROFILE = 20;

export async function readJsonFileSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    try {
      return {
        ok: true,
        path: filePath,
        data: JSON.parse(raw),
      };
    } catch (err) {
      return {
        ok: false,
        path: filePath,
        errorType: "invalid-json",
        message: err.message,
      };
    }
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      errorType: err.code === "ENOENT" ? "not-found" : "read-error",
      message: err.message,
    };
  }
}

export function createRotatingLogWriter(baseLogPath, options = {}) {
  const maxBytes = normalizePositiveInteger(
    options.maxBytes ?? process.env.XJSKP_LOG_MAX_BYTES,
    DEFAULT_LOG_MAX_BYTES,
  );
  const keep = normalizePositiveInteger(
    options.keep ?? process.env.XJSKP_LOG_KEEP_PER_PROFILE,
    DEFAULT_LOG_KEEP_PER_PROFILE,
  );
  const logDir = path.dirname(baseLogPath);
  const parsed = parseLogPath(baseLogPath);
  let currentPath = baseLogPath;
  let currentSize = null;
  let rotationIndex = 0;
  let pending = Promise.resolve();

  const writer = {
    write(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      pending = pending
        .then(() => writeQueued(data))
        .catch(() => {});
      return pending;
    },
    async settle() {
      await pending.catch(() => {});
    },
  };

  async function writeQueued(data) {
    if (!data.length) return;
    await fs.mkdir(logDir, { recursive: true });
    if (currentSize == null) {
      currentSize = await getFileSizeSafe(currentPath);
    }
    let rotated = false;
    if (maxBytes > 0 && currentSize > 0 && currentSize + data.length > maxBytes) {
      await rotate();
      rotated = true;
    }
    await fs.appendFile(currentPath, data);
    currentSize += data.length;
    if (rotated) await enforceRetention();
  }

  async function rotate() {
    rotationIndex += 1;
    currentPath = path.join(logDir, `${parsed.stem}-${String(rotationIndex).padStart(3, "0")}${parsed.ext}`);
    currentSize = await getFileSizeSafe(currentPath);
  }

  async function enforceRetention() {
    if (keep <= 0) return;
    let entries = [];
    try {
      entries = await fs.readdir(logDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    const logs = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const index = rotationIndexFromName(entry.name, parsed);
        return index == null ? null : { name: entry.name, index };
      })
      .filter(Boolean)
      .sort((a, b) => b.index - a.index);
    for (const oldLog of logs.slice(keep)) {
      await fs.rm(path.join(logDir, oldLog.name), { force: true });
    }
  }

  return writer;
}

export async function listLogFiles(logDir, options = {}) {
  const limit = Math.max(1, Number(options.limit || 20));
  try {
    const entries = await fs.readdir(logDir, { withFileTypes: true });
    const logs = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^auto-plant-.*\.log(?:\.gz)?$/i.test(entry.name)) continue;
      const filePath = path.join(logDir, entry.name);
      const stat = await fs.stat(filePath);
      logs.push({
        name: entry.name,
        path: filePath,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    }
    return logs
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, limit);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function getFileSizeSafe(filePath) {
  try {
    return (await fs.stat(filePath)).size;
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
}

function parseLogPath(filePath) {
  const ext = path.extname(filePath) || ".log";
  const base = path.basename(filePath, ext);
  return { stem: base, ext };
}

function rotationIndexFromName(name, parsed) {
  if (name === `${parsed.stem}${parsed.ext}`) return 0;
  const match = name.match(new RegExp(`^${escapeRegExp(parsed.stem)}-(\\d{3,})${escapeRegExp(parsed.ext)}$`, "i"));
  return match ? Number(match[1]) : null;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function readLogFile(logDir, name, options = {}) {
  if (!isSafeLogName(name)) throw invalidPathParameter("Unsupported log file name");
  const maxBytes = Math.max(1, Number(options.maxBytes || 200_000));
  const filePath = resolveWithin(logDir, name);
  const file = await fs.open(filePath, "r");
  try {
    const stat = await file.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, start);
    return {
      name,
      path: filePath,
      size: stat.size,
      truncated: start > 0,
      content: buffer.toString("utf8"),
    };
  } finally {
    await file.close();
  }
}

export function isSafeLogName(value) {
  return /^auto-plant-[A-Za-z0-9_.-]+\.log(?:\.gz)?$/i.test(String(value || ""));
}

function resolveWithin(rootDir, name) {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, name);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw invalidPathParameter("Invalid path parameter");
  }
  return candidate;
}

function invalidPathParameter(message) {
  const err = new Error(message);
  err.code = "INVALID_PATH_PARAMETER";
  err.statusCode = 400;
  return err;
}
