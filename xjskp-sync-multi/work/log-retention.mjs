import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const AUTO_PLANT_LOG_RE = /^auto-plant-\d{8}-\d{6}\.log(?:\.gz)?$/;

async function getAutoPlantLogs(outputDir) {
  const dirEntries = await readdir(outputDir, { withFileTypes: true });
  const logs = [];

  for (const entry of dirEntries) {
    if (!entry.isFile() || !AUTO_PLANT_LOG_RE.test(entry.name)) continue;
    const filePath = path.join(outputDir, entry.name);
    const fileStat = await stat(filePath);
    logs.push({
      name: entry.name,
      path: filePath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    });
  }

  return logs.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.name.localeCompare(a.name);
  });
}

function normalizeKeep(value) {
  const keep = Number(value ?? 10);
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error(`keep must be a non-negative integer, got ${value}`);
  }
  return keep;
}

export async function pruneAutoPlantLogs(outputDir, options = {}) {
  const keep = normalizeKeep(options.keep);
  const logs = await getAutoPlantLogs(outputDir);
  const kept = logs.slice(0, keep);
  const deleted = logs.slice(keep).sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
    return a.name.localeCompare(b.name);
  });

  if (!options.dryRun) {
    for (const entry of deleted) {
      await unlink(entry.path);
    }
  }

  return {
    keep,
    total: logs.length,
    kept,
    deleted,
    deletedCount: deleted.length,
  };
}

async function main() {
  const [outputDir = "outputs", keep = "10"] = process.argv.slice(2);
  const result = await pruneAutoPlantLogs(outputDir, { keep: Number(keep) });
  console.log(JSON.stringify({
    keep: result.keep,
    total: result.total,
    keptCount: result.kept.length,
    deletedCount: result.deletedCount,
    deleted: result.deleted.map((entry) => entry.name),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
