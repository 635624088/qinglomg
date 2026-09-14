import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createRotatingLogWriter, listLogFiles, readJsonFileSafe, readLogFile } from "./system/status-store.mjs";

test("readJsonFileSafe returns invalid-json instead of throwing for partial status files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-status-"));
  try {
    const file = path.join(dir, "garden-status.json");
    await writeFile(file, "{\"updatedAt\":", "utf8");

    const result = await readJsonFileSafe(file);

    assert.equal(result.ok, false);
    assert.equal(result.errorType, "invalid-json");
    assert.equal(result.path, file);
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listLogFiles returns newest automation logs first", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-logs-"));
  try {
    await writeFile(path.join(dir, "auto-plant-20260629-100000.log"), "old", "utf8");
    await writeFile(path.join(dir, "auto-plant-20260629-110000.log"), "new", "utf8");
    await writeFile(path.join(dir, "notes.txt"), "skip", "utf8");

    const logs = await listLogFiles(dir);

    assert.deepEqual(logs.map((item) => item.name), [
      "auto-plant-20260629-110000.log",
      "auto-plant-20260629-100000.log",
    ]);
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createRotatingLogWriter rotates oversized logs and keeps the newest profile logs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-rotating-logs-"));
  try {
    const baseLog = path.join(dir, "auto-plant-20260707-010203.log");
    const writer = createRotatingLogWriter(baseLog, {
      maxBytes: 12,
      keep: 2,
    });

    await writer.write("first-line\n");
    await writer.write("second-line\n");
    await writer.write("third-line\n");
    await writer.settle();

    const logs = await listLogFiles(dir, { limit: 10 });
    assert.deepEqual(logs.map((item) => item.name), [
      "auto-plant-20260707-010203-002.log",
      "auto-plant-20260707-010203-001.log",
    ]);
    assert.equal(await readFile(path.join(dir, logs[0].name), "utf8"), "third-line\n");
    assert.equal(await readFile(path.join(dir, logs[1].name), "utf8"), "second-line\n");
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLogFile rejects a name that resolves outside the log directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-log-path-"));
  try {
    await assert.rejects(
      () => readLogFile(path.join(dir, "logs", "main"), "auto-plant-/../../../outside.log"),
      (err) => err.code === "INVALID_PATH_PARAMETER" && err.statusCode === 400,
    );
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});
