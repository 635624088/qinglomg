import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { auditGameDataCompatibility } from "./game-data-compatibility.mjs";

test("current production data passes all registered production loaders", () => {
  const configPath = path.resolve("work", "g-data.2f3f6.text");
  const result = auditGameDataCompatibility({
    baselinePath: configPath,
    candidatePath: configPath,
    dataVersion: "2f3f6",
  });
  assert.equal(result.status, "compatible");
  assert.equal(result.loaderAudit.loaderCount, 17);
  assert.equal(Object.keys(result.flowerNames).length > 0, true);
});

test("auditGameDataCompatibility accepts safe flower and flower-art additions", async (t) => {
  const { baselinePath, candidatePath } = await writePair(t, baseConfig(), (candidate) => {
    candidate.c_item.list[0].v[23002] = { name: "白玫瑰", bType: 2 };
    candidate.c_flower.list[0].v[23002] = { seedId: 12002, eliteId: 13002 };
    candidate.c_item.list[0].v[12002] = { name: "白玫瑰种子", bType: 1 };
    candidate.c_item.list[0].v[13002] = { name: "白玫瑰精华", bType: 1 };
    candidate.c_flowerArt.list[0].v[30002] = { flowers: [23001, 23002], vase: 40001 };
  });

  const result = auditGameDataCompatibility({
    baselinePath,
    candidatePath,
    dataVersion: "abc12",
    requiredTables: ["c_item", "c_flower", "c_flowerArt", "c_flowerVase"],
    businessLoaderAudit: passingLoaders,
  });

  assert.equal(result.status, "compatible");
  assert.equal(result.flowerNames[23002], "白玫瑰");
  assert.equal(result.diff.tables.c_flower.addedIds.includes(23002), true);
});

test("auditGameDataCompatibility blocks missing tables and dependent field type changes", async (t) => {
  const missing = await writePair(t, baseConfig(), (candidate) => delete candidate.c_flowerArt);
  assert.equal(audit(missing).status, "incompatible");
  assert.equal(audit(missing).reasons.includes("missing-table:c_flowerArt"), true);

  const changed = await writePair(t, baseConfig(), (candidate) => {
    candidate.c_flower.list[0].v[23001].seedId = { itemId: 12001 };
  });
  const changedResult = audit(changed);
  assert.equal(changedResult.status, "incompatible");
  assert.equal(changedResult.reasons.some((reason) => reason.includes("type-changed:c_flower.seedId")), true);
});

test("auditGameDataCompatibility verifies candidate filename, bytes, and sha256 evidence", async (t) => {
  const pair = await writePair(t, baseConfig(), () => {});
  const result = auditGameDataCompatibility({
    ...pair,
    dataVersion: "abc12",
    expectedBytes: 1,
    expectedSha256: "0".repeat(64),
    requiredTables: ["c_item", "c_flower", "c_flowerArt", "c_flowerVase"],
    businessLoaderAudit: passingLoaders,
  });
  assert.equal(result.status, "incompatible");
  assert.equal(result.reasons.some((reason) => reason.startsWith("file-size-mismatch:")), true);
  assert.equal(result.reasons.includes("file-hash-mismatch"), true);
});

test("auditGameDataCompatibility blocks broken flower, flower-art, and vase references", async (t) => {
  const pair = await writePair(t, baseConfig(), (candidate) => {
    candidate.c_flower.list[0].v[23001].seedId = 99999;
    candidate.c_flowerArt.list[0].v[30001].flowers = [88888];
    candidate.c_flowerArt.list[0].v[30001].vase = 77777;
  });
  const result = audit(pair);

  assert.equal(result.status, "incompatible");
  assert.equal(result.reasons.some((reason) => reason.includes("missing-item-reference:c_flower.seedId:99999")), true);
  assert.equal(result.reasons.some((reason) => reason.includes("missing-flower-reference:c_flowerArt.flowers:88888")), true);
  assert.equal(result.reasons.some((reason) => reason.includes("missing-vase-reference:c_flowerArt.vase:77777")), true);
});

test("auditGameDataCompatibility blocks loader failures and routes encoding changes to manual review", async (t) => {
  const pair = await writePair(t, baseConfig(), (candidate) => {
    candidate.c_flower.f = true;
  });
  const manual = auditGameDataCompatibility({
    baselinePath: pair.baselinePath,
    candidatePath: pair.candidatePath,
    dataVersion: "abc12",
    requiredTables: ["c_item", "c_flower", "c_flowerArt", "c_flowerVase"],
    businessLoaderAudit: passingLoaders,
  });
  assert.equal(manual.status, "manual-review");
  assert.equal(manual.reasons.includes("encoding-changed:c_flower"), true);

  const failedLoader = auditGameDataCompatibility({
    baselinePath: pair.baselinePath,
    candidatePath: pair.candidatePath,
    dataVersion: "abc12",
    requiredTables: ["c_item", "c_flower", "c_flowerArt", "c_flowerVase"],
    businessLoaderAudit: () => ({
      compatible: false,
      loaderCount: 1,
      results: [{ name: "teamOrder", compatible: false, reasons: ["orders-empty"] }],
    }),
  });
  assert.equal(failedLoader.status, "incompatible");
  assert.equal(failedLoader.reasons.includes("loader-failed:teamOrder:orders-empty"), true);
});

test("auditGameDataCompatibility routes explicit team-order code coupling changes to manual review", async (t) => {
  const baseline = baseConfig();
  baseline.c_orderTeam = table({
    "-1": { $orderTeamTime: 50, $orderMax: 160, $orderMaxSecond: 4 },
    1: { flowerNum: 2, magnification: 1 },
  });
  const pair = await writePair(t, baseline, (candidate) => {
    candidate.c_orderTeam.list[0].v["-1"].$orderMaxSecond = 5;
  });
  const result = auditGameDataCompatibility({
    ...pair,
    dataVersion: "abc12",
    requiredTables: ["c_item", "c_flower", "c_flowerArt", "c_flowerVase", "c_orderTeam"],
    businessLoaderAudit: passingLoaders,
  });
  assert.equal(result.status, "manual-review");
  assert.equal(result.reasons.includes("code-coupling-changed:c_orderTeam.$orderMaxSecond"), true);
});

test("auditGameDataCompatibility records c_orderCustomerNpc npcMaxDay addition as compatible", async (t) => {
  const baseline = baseConfig();
  baseline.c_orderCustomerNpc = table({
    "-1": {
      "$npcId": [1, 2],
      "$createCd": [60, 120],
      "$createNum": [1, 2],
      "$npcMax": 2,
      "$firstNPC": 1,
    },
  });
  const pair = await writePair(t, baseline, (candidate) => {
    candidate.c_orderCustomerNpc.list[0].v["-1"].$npcMaxDay = 350;
    candidate.c_orderCustomerNpc.colMap.$npcMaxDay = "$npcMaxDay";
  });

  const result = auditGameDataCompatibility({
    ...pair,
    dataVersion: "abc12",
    requiredTables: ["c_item", "c_flower", "c_flowerArt", "c_flowerVase", "c_orderCustomerNpc"],
    businessLoaderAudit: passingLoaders,
  });

  assert.equal(result.status, "compatible");
  assert.deepEqual(result.diff.tables.c_orderCustomerNpc.changedFields, [
    { id: -1, fields: ["$npcMaxDay"] },
  ]);
});

test("auditGameDataCompatibility accepts a closed whole-outfit to top-and-bottom migration", async (t) => {
  const baseline = baseConfig();
  baseline.c_item.list[0].v[12040065] = { name: "套装整套", bType: 0 };
  baseline.c_fashionUnit = table({
    12040065: { unit: 20, suitId: 10065, baseAdd: [[1, 25600]] },
  });
  baseline.c_fashionSuit = table({
    10065: { unitId: [12040065], suitNeed: [1] },
  });
  const pair = await writePair(t, baseline, (candidate) => {
    delete candidate.c_item.list[0].v[12040065];
    delete candidate.c_fashionUnit.list[0].v[12040065];
    candidate.c_item.list[0].v[12140065] = { name: "上衣", bType: 0 };
    candidate.c_item.list[0].v[12240065] = { name: "下衣", bType: 0 };
    candidate.c_fashionUnit.list[0].v[12140065] = { unit: 21, suitId: 10065, baseAdd: [[1, 12800]] };
    candidate.c_fashionUnit.list[0].v[12240065] = { unit: 22, suitId: 10065, baseAdd: [[1, 12000]] };
    candidate.c_fashionSuit.list[0].v[10065].unitId = [12140065, 12240065];
    candidate.c_fashionSuit.list[0].v[10065].suitNeed = [1, 2];
  });
  const result = auditGameDataCompatibility({
    ...pair,
    dataVersion: "abc12",
    requiredTables: ["c_item", "c_flower", "c_flowerArt", "c_flowerVase", "c_fashionSuit"],
    businessLoaderAudit: passingLoaders,
  });
  assert.equal(result.status, "compatible");
  assert.equal(result.reasons.includes("critical-id-removed:c_item:12040065"), false);
  assert.equal(
    result.diff.tables.c_fashionSuit.changedFields.some((row) => row.id === 10065 && row.fields.includes("unitId")),
    true,
  );
});

test("auditGameDataCompatibility rejects dangling fashion references and keeps ordinary removals manual", async (t) => {
  const baseline = baseConfig();
  baseline.c_item.list[0].v[10] = { name: "旧物品", bType: 0 };
  baseline.c_fashionSuit = table({ 1: { unitId: [10] } });
  const dangling = await writePair(t, baseline, (candidate) => delete candidate.c_item.list[0].v[10]);
  const danglingResult = auditGameDataCompatibility({
    ...dangling,
    dataVersion: "abc12",
    requiredTables: ["c_item", "c_flower", "c_flowerArt", "c_flowerVase", "c_fashionSuit"],
    businessLoaderAudit: passingLoaders,
  });
  assert.equal(danglingResult.status, "incompatible");
  assert.equal(danglingResult.reasons.includes("missing-item-reference:c_fashionSuit.unitId:10"), true);

  const ordinary = await writePair(t, baseConfig(), (candidate) => delete candidate.c_item.list[0].v[12001]);
  const ordinaryResult = audit(ordinary);
  assert.equal(ordinaryResult.status, "incompatible");
  assert.equal(ordinaryResult.reasons.includes("missing-item-reference:c_flower.seedId:12001"), true);
  assert.equal(ordinaryResult.reasons.includes("critical-id-removed:c_item:12001"), false);
});

test("auditGameDataCompatibility preserves explicitly declared source-critical item ids", async (t) => {
  const baseline = baseConfig();
  baseline.c_item.list[0].v[99] = { name: "源码硬依赖", bType: 0 };
  const pair = await writePair(t, baseline, (candidate) => delete candidate.c_item.list[0].v[99]);
  const result = auditGameDataCompatibility({
    ...pair,
    dataVersion: "abc12",
    requiredTables: ["c_item", "c_flower", "c_flowerArt", "c_flowerVase"],
    businessLoaderAudit: passingLoaders,
    codeCriticalIds: { c_item: [99] },
  });
  assert.equal(result.status, "incompatible");
  assert.equal(result.reasons.includes("critical-id-removed:c_item:99"), true);
});

function audit(pair) {
  return auditGameDataCompatibility({
    ...pair,
    dataVersion: "abc12",
    requiredTables: ["c_item", "c_flower", "c_flowerArt", "c_flowerVase"],
    businessLoaderAudit: passingLoaders,
  });
}

function passingLoaders() {
  return { compatible: true, loaderCount: 2, results: [
    { name: "flower", compatible: true, reasons: [] },
    { name: "orders", compatible: true, reasons: [] },
  ] };
}

async function writePair(t, baseline, mutate) {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-compat-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  const candidate = structuredClone(baseline);
  mutate(candidate);
  const baselinePath = path.join(rootDir, "g-data.aaa11.text");
  const candidatePath = path.join(rootDir, "g-data.abc12.text");
  await fsp.writeFile(baselinePath, JSON.stringify(baseline), "utf8");
  await fsp.writeFile(candidatePath, JSON.stringify(candidate), "utf8");
  return { baselinePath, candidatePath };
}

function baseConfig() {
  return {
    c_item: table({
      12001: { name: "红玫瑰种子", bType: 1 },
      13001: { name: "红玫瑰精华", bType: 1 },
      23001: { name: "红玫瑰", bType: 2 },
    }),
    c_flower: table({ 23001: { seedId: 12001, eliteId: 13001 } }),
    c_flowerArt: table({ 30001: { flowers: [23001], vase: 40001 } }),
    c_flowerVase: table({ 40001: { flowers: [23001] } }),
  };
}

function table(rows) {
  const fields = new Set(Object.values(rows).flatMap(Object.keys));
  return {
    colMap: Object.fromEntries([["$", "id"], ...[...fields].map((field) => [field, field])]),
    list: [{ v: rows }],
  };
}
