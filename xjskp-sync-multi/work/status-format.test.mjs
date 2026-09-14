import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  flowerName,
  formatAccountLevelProgress,
  formatDateTime,
  formatDuration,
  formatFlowerLabel,
  formatWanNumber,
  loadFlowerNameMap,
} from "./status-format.mjs";

test("formats local date time as yyyy-mm-dd hh:mm:ss", () => {
  const localMs = new Date(2026, 5, 15, 17, 56, 21).getTime();

  assert.equal(formatDateTime(localMs), "2026-06-15 17:56:21");
  assert.equal(formatDateTime(null), "-");
  assert.equal(formatDateTime("not a date"), "-");
});

test("formats durations with days and mature state", () => {
  assert.equal(formatDuration(null), "-");
  assert.equal(formatDuration(-1000), "可收获");
  assert.equal(formatDuration(61_000), "1分01秒");
  assert.equal(formatDuration(90_061_000), "1天01小时01分01秒");
});

test("formats account numbers using Chinese ten-thousand grouping", () => {
  assert.equal(formatWanNumber(11147274), "1114,7274");
  assert.equal(formatWanNumber(2760828), "276,0828");
  assert.equal(formatWanNumber(9919000), "991,9000");
  assert.equal(formatWanNumber(null), "-");
});

test("formats account level progress with grouped numbers and percentage", () => {
  assert.equal(formatAccountLevelProgress({ currentExp: 2760828, requiredExp: 9919000 }), "276,0828/991,9000（27.8%）");
  assert.equal(formatAccountLevelProgress({ currentExp: 2760828, requiredExp: 0 }), "276,0828/0");
  assert.equal(formatAccountLevelProgress({ currentExp: null, requiredExp: 9919000 }), "-/991,9000");
});

test("loads flower names from string and object mappings", () => {
  const tmpPath = "work/.tmp-flower-names-test.json";
  fs.writeFileSync(tmpPath, JSON.stringify({
    23070: "测试花",
    23071: { name: "对象花" },
    23072: { zhName: "中文字段花" },
  }), "utf8");
  try {
    const names = loadFlowerNameMap([tmpPath]);

    assert.equal(flowerName(23070, names), "测试花");
    assert.equal(flowerName(23071, names), "对象花");
    assert.equal(flowerName(23072, names), "中文字段花");
    assert.equal(flowerName(23999, names), "花-23999");
    assert.equal(formatFlowerLabel(23070, names), "测试花 (23070)");
    assert.equal(formatFlowerLabel(null, names), "-");
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
});

test("loads the active data bundle flower names before legacy fallbacks", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-active-flower-names-"));
  try {
    const versionDir = path.join(rootDir, "runtime", "game-data", "versions", "2f3f6");
    fs.mkdirSync(versionDir, { recursive: true });
    fs.mkdirSync(path.join(rootDir, "runtime", "status"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "work"), { recursive: true });
    const configText = "{}";
    const flowerNamesText = JSON.stringify({ 23070: "活跃名称" });
    const compatibilityReportText = JSON.stringify({ schemaVersion: 1, dataVersion: "2f3f6", status: "compatible" });
    fs.writeFileSync(path.join(versionDir, "g-data.2f3f6.text"), configText, "utf8");
    fs.writeFileSync(path.join(versionDir, "flower-names.json"), flowerNamesText, "utf8");
    fs.writeFileSync(path.join(rootDir, "work", "flower-names.json"), JSON.stringify({ 23070: "旧名称", 23071: "旧版补充" }), "utf8");
    fs.writeFileSync(
      path.join(versionDir, "compatibility-report.json"),
      compatibilityReportText,
      "utf8",
    );
    fs.writeFileSync(
      path.join(versionDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        dataVersion: "2f3f6",
        sourceCodeVersion: "400.0.15",
        configFile: "g-data.2f3f6.text",
        flowerNamesFile: "flower-names.json",
        compatibilityReportFile: "compatibility-report.json",
        compatibilityStatus: "compatible",
        files: {
          "g-data.2f3f6.text": fileEvidence(configText),
          "flower-names.json": fileEvidence(flowerNamesText),
          "compatibility-report.json": fileEvidence(compatibilityReportText),
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(rootDir, "runtime", "status", "game-data-active.json"),
      JSON.stringify({ schemaVersion: 1, activeDataVersion: "2f3f6" }),
      "utf8",
    );

    const names = loadFlowerNameMap(undefined, { rootDir });

    assert.equal(names[23070], "活跃名称");
    assert.equal(names[23071], undefined);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("does not retain a missing flower-name file and refreshes changed content", () => {
  const tmpPath = path.join(os.tmpdir(), `xjskp-flower-names-${process.pid}-${Date.now()}.json`);
  try {
    assert.deepEqual(loadFlowerNameMap([tmpPath]), {});
    fs.writeFileSync(tmpPath, JSON.stringify({ 23070: "首次名称" }), "utf8");
    assert.equal(loadFlowerNameMap([tmpPath])[23070], "首次名称");
    fs.writeFileSync(tmpPath, JSON.stringify({ 23070: "更新名称" }), "utf8");
    assert.equal(loadFlowerNameMap([tmpPath])[23070], "更新名称");
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
});

function fileEvidence(text) {
  return {
    bytes: Buffer.byteLength(text),
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}
