import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pruneAutoPlantLogs } from "./log-retention.mjs";

async function writeLog(dir, name, mtimeSeconds) {
  const filePath = path.join(dir, name);
  await writeFile(filePath, `${name}\n`, "utf8");
  const date = new Date(mtimeSeconds * 1000);
  await utimes(filePath, date, date);
  return filePath;
}

test("pruneAutoPlantLogs keeps only the newest auto plant logs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-logs-"));
  try {
    await writeLog(dir, "auto-plant-20260616-100000.log", 1000);
    await writeLog(dir, "auto-plant-20260616-100100.log", 1001);
    await writeLog(dir, "auto-plant-20260616-100200.log", 1002);
    await writeLog(dir, "auto-plant-20260616-100300.log", 1003);
    await writeLog(dir, "auto-plant-20260616-100400.log", 1004);
    await writeLog(dir, "auto-plant-20260616-100500.log.gz", 1005);
    await writeFile(path.join(dir, "garden-status.json"), "{}\n", "utf8");

    const result = await pruneAutoPlantLogs(dir, { keep: 3 });

    assert.deepEqual(result.deleted.map((entry) => entry.name), [
      "auto-plant-20260616-100000.log",
      "auto-plant-20260616-100100.log",
      "auto-plant-20260616-100200.log",
    ]);
    assert.equal(result.kept.length, 3);
    assert.deepEqual((await readdir(dir)).sort(), [
      "auto-plant-20260616-100300.log",
      "auto-plant-20260616-100400.log",
      "auto-plant-20260616-100500.log.gz",
      "garden-status.json",
    ]);
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});
