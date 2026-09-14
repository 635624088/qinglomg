import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildFlowerNameMap } from "./extract-flower-names.mjs";
import { decodeConfigRows, findConfigTable } from "./flower-level-config.mjs";
import { auditBusinessConfigLoaders } from "./sync-latest-static-config.mjs";

export const REQUIRED_GAME_DATA_TABLES = Object.freeze([
  "c_item",
  "c_flower",
  "c_flowerLvl",
  "c_flowerLvlCfg",
  "c_flowerAdvanceSkill",
  "c_flowerArt",
  "c_flowerVase",
  "c_gameCfg",
  "c_waterwheel",
  "c_fmlLandLvl",
  "c_pearl",
  "c_pearlEvent",
  "c_shop_cultivate",
  "c_task_main",
  "c_actCyclicNote",
  "c_task_type",
  "c_actCyclicStory",
  "c_monthCard",
  "c_fashionSuit",
  "c_orderCustomerNpc",
  "c_orderFlower",
  "c_orderTeam",
  "c_lvl",
]);

const DEPENDENT_FIELDS = Object.freeze({
  c_item: ["name", "name1", "sname", "bType"],
  c_flower: ["exp", "gld", "seedId", "eliteId", "culCost", "culTime", "vaseCfg"],
  c_flowerArt: ["lvl", "cOrder", "wgt", "vase", "flowers", "sPrice", "cPrice", "createRwd", "artExpAdd"],
  c_flowerVase: ["flowers", "flowerVaseType", "flowerPos", "coordinate", "ratio", "scale"],
  c_orderCustomerNpc: ["$createCd", "$createNum", "$npcMax", "$npcId", "$firstNPC", "$npcMaxDay"],
});

const DIFF_FIELDS = Object.freeze({
  ...DEPENDENT_FIELDS,
  c_fashionSuit: ["unitId", "suitNeed", "attrExt", "specialValue"],
});

export function auditGameDataCompatibility(options = {}) {
  const dataVersion = normalizeDataVersion(options.dataVersion);
  const baseline = readConfig(options.baselinePath, "baseline");
  const candidate = readConfig(options.candidatePath, "candidate");
  const requiredTables = options.requiredTables || REQUIRED_GAME_DATA_TABLES;
  const reasons = [];
  const manualReviewReasons = [];
  const tables = {};
  if (path.basename(options.candidatePath) !== `g-data.${dataVersion}.text`) {
    reasons.push(`file-version-mismatch:${path.basename(options.candidatePath)}`);
  }
  if (options.expectedBytes != null && Number(options.expectedBytes) !== candidate.bytes) {
    reasons.push(`file-size-mismatch:${options.expectedBytes}->${candidate.bytes}`);
  }
  if (
    options.expectedSha256
    && String(options.expectedSha256).toLowerCase() !== candidate.sha256
  ) reasons.push("file-hash-mismatch");

  for (const tableName of requiredTables) {
    const baselineTable = findConfigTable(baseline.value, tableName);
    const candidateTable = findConfigTable(candidate.value, tableName);
    if (!candidateTable) {
      reasons.push(`missing-table:${tableName}`);
      continue;
    }
    let baselineRows = [];
    let candidateRows = [];
    try {
      baselineRows = baselineTable ? decodeConfigRows(baselineTable, tableName) : [];
      candidateRows = decodeConfigRows(candidateTable, tableName);
    } catch (error) {
      reasons.push(`decode-failed:${tableName}:${safeMessage(error)}`);
      continue;
    }
    if (candidateRows.length === 0) reasons.push(`empty-table:${tableName}`);
    auditRowIds(tableName, candidateRows, reasons);
    const tableDiff = diffRows(baselineRows, candidateRows, DIFF_FIELDS[tableName]);
    tables[tableName] = tableDiff;
    for (const removedId of tableDiff.removedIds) {
      if (isCodeCriticalId(options.codeCriticalIds, tableName, removedId)) {
        reasons.push(`critical-id-removed:${tableName}:${removedId}`);
      } else if (tableName === "c_item" && isClosedFashionSplitMigration({
        baseline: baseline.value,
        candidate: candidate.value,
        removedItemId: removedId,
      })) {
        // The official client supports both unit=20 and the unit=21+22 pair.
        // A fully closed split is a structural migration, not an orphaned deletion.
      } else if (tableName === "c_item") {
        manualReviewReasons.push(`row-removed:${tableName}:${removedId}`);
      } else if (DEPENDENT_FIELDS[tableName]) {
        reasons.push(`critical-id-removed:${tableName}:${removedId}`);
      } else {
        manualReviewReasons.push(`row-removed:${tableName}:${removedId}`);
      }
    }
    if (baselineTable && encodingChanged(baselineTable, candidateTable)) {
      manualReviewReasons.push(`encoding-changed:${tableName}`);
    }
    auditDependentFieldTypes(tableName, baselineRows, candidateRows, reasons);
  }

  auditCoreReferences(candidate.value, reasons);
  auditFashionReferences(candidate.value, reasons);
  auditTeamOrderCodeCoupling(baseline.value, candidate.value, manualReviewReasons);
  const businessLoaderAudit = options.businessLoaderAudit || auditBusinessConfigLoaders;
  const loaderAudit = businessLoaderAudit(options.candidatePath);
  for (const result of loaderAudit?.results || []) {
    if (result.compatible) continue;
    reasons.push(`loader-failed:${result.name}:${(result.reasons || []).join("|") || "unknown"}`);
  }
  if (loaderAudit?.compatible !== true && !(loaderAudit?.results || []).some((result) => !result.compatible)) {
    reasons.push("loader-audit-failed:unknown");
  }

  let flowerNames = {};
  try {
    flowerNames = buildFlowerNameMap(candidate.value);
    const flowerRows = decodeRows(candidate.value, "c_flower")
      .filter((row) => positiveId(row.id) != null && Number(row.isHide) !== 1);
    for (const flower of flowerRows) {
      const id = String(positiveId(flower.id));
      if (!normalizeName(flowerNames[id])) reasons.push(`missing-flower-name:${id}`);
    }
  } catch (error) {
    reasons.push(`flower-name-derivation-failed:${safeMessage(error)}`);
  }

  const allManualReasons = [...new Set([
    ...manualReviewReasons,
    ...(options.manualReviewReasons || []).map(String),
  ])];
  const incompatibleReasons = [...new Set(reasons)];
  const status = incompatibleReasons.length > 0
    ? "incompatible"
    : allManualReasons.length > 0
      ? "manual-review"
      : "compatible";
  return {
    schemaVersion: 1,
    dataVersion,
    status,
    reasons: status === "incompatible" ? incompatibleReasons : allManualReasons,
    file: {
      bytes: candidate.bytes,
      sha256: candidate.sha256,
    },
    loaderAudit,
    diff: { tables },
    flowerNames,
  };
}

function auditRowIds(tableName, rows, reasons) {
  const seen = new Set();
  for (const row of rows) {
    const id = comparableId(row?.id);
    if (id == null) {
      reasons.push(`missing-id:${tableName}`);
      continue;
    }
    if (seen.has(id)) reasons.push(`duplicate-id:${tableName}:${id}`);
    seen.add(id);
  }
}

function auditTeamOrderCodeCoupling(baseline, candidate, reasons) {
  const beforeRows = decodeRows(baseline, "c_orderTeam");
  const afterRows = decodeRows(candidate, "c_orderTeam");
  if (!beforeRows.length || !afterRows.length) return;
  const beforeGlobals = beforeRows.find((row) => Number(row.id) === -1) || {};
  const afterGlobals = afterRows.find((row) => Number(row.id) === -1) || {};
  const fields = ["$orderTeamTime", "$orderMax", "$orderMaxSecond"];
  const beforeCount = beforeRows.filter((row) => positiveId(row.id) != null).length;
  const afterCount = afterRows.filter((row) => positiveId(row.id) != null).length;
  if (beforeCount !== afterCount) reasons.push(`code-coupling-changed:c_orderTeam.orderCount:${beforeCount}->${afterCount}`);
  for (const field of fields) {
    if (JSON.stringify(beforeGlobals[field]) !== JSON.stringify(afterGlobals[field])) {
      reasons.push(`code-coupling-changed:c_orderTeam.${field}`);
    }
  }
}

function auditDependentFieldTypes(tableName, baselineRows, candidateRows, reasons) {
  const fields = DEPENDENT_FIELDS[tableName];
  if (!fields) return;
  const candidateById = rowMap(candidateRows);
  for (const baselineRow of baselineRows) {
    const id = comparableId(baselineRow.id);
    if (id == null || !candidateById.has(id)) continue;
    const candidateRow = candidateById.get(id);
    for (const field of fields) {
      if (baselineRow[field] == null) continue;
      if (candidateRow[field] == null) {
        reasons.push(`missing-field:${tableName}.${field}:${id}`);
        continue;
      }
      const before = valueKind(baselineRow[field]);
      const after = valueKind(candidateRow[field]);
      if (before !== after) reasons.push(`type-changed:${tableName}.${field}:${id}:${before}->${after}`);
    }
  }
}

function auditCoreReferences(config, reasons) {
  const itemIds = idSet(decodeRows(config, "c_item"));
  const flowerRows = decodeRows(config, "c_flower");
  const flowerIds = idSet(flowerRows);
  const vaseRows = decodeRows(config, "c_flowerVase");
  const vaseIds = idSet(vaseRows);
  const artRows = decodeRows(config, "c_flowerArt");

  for (const row of flowerRows) {
    const flowerId = positiveId(row.id);
    if (flowerId == null) continue;
    if (!itemIds.has(flowerId)) reasons.push(`missing-item-reference:c_flower.id:${flowerId}`);
    for (const field of ["seedId", "eliteId"]) {
      const itemId = positiveId(row[field]);
      if (itemId != null && !itemIds.has(itemId)) {
        reasons.push(`missing-item-reference:c_flower.${field}:${itemId}`);
      }
    }
    for (const pair of Array.isArray(row.culCost) ? row.culCost : []) {
      const itemId = positiveId(Array.isArray(pair) ? pair[0] : pair?.itemId ?? pair?.id);
      if (itemId != null && !itemIds.has(itemId)) {
        reasons.push(`missing-item-reference:c_flower.culCost:${itemId}`);
      }
    }
  }
  for (const row of artRows) {
    if (positiveId(row.id) == null) continue;
    for (const rawId of Array.isArray(row.flowers) ? row.flowers : []) {
      const flowerId = positiveId(rawId);
      if (flowerId != null && !flowerIds.has(flowerId)) {
        reasons.push(`missing-flower-reference:c_flowerArt.flowers:${flowerId}`);
      }
    }
    const vaseId = positiveId(row.vase);
    if (vaseId != null && !vaseIds.has(vaseId)) {
      reasons.push(`missing-vase-reference:c_flowerArt.vase:${vaseId}`);
    }
  }
  for (const row of vaseRows) {
    if (positiveId(row.id) == null) continue;
    for (const rawId of Array.isArray(row.flowers) ? row.flowers : []) {
      const flowerId = positiveId(rawId);
      if (flowerId != null && !flowerIds.has(flowerId)) {
        reasons.push(`missing-flower-reference:c_flowerVase.flowers:${flowerId}`);
      }
    }
  }
}

function auditFashionReferences(config, reasons) {
  const itemIds = idSet(decodeRows(config, "c_item"));
  const fashionUnits = decodeRows(config, "c_fashionUnit");
  const fashionUnitIds = idSet(fashionUnits);
  const fashionSuitIds = idSet(decodeRows(config, "c_fashionSuit"));
  for (const row of fashionUnits) {
    const id = positiveId(row.id);
    if (id == null) continue;
    if (!itemIds.has(id)) reasons.push(`missing-item-reference:c_fashionUnit.id:${id}`);
    const suitId = positiveId(row.suitId);
    if (suitId != null && !fashionSuitIds.has(suitId)) {
      reasons.push(`missing-fashion-suit-reference:c_fashionUnit.suitId:${suitId}`);
    }
  }
  for (const row of decodeRows(config, "c_fashionSuit")) {
    if (positiveId(row.id) == null) continue;
    for (const rawId of Array.isArray(row.unitId) ? row.unitId : []) {
      const itemId = positiveId(rawId);
      if (itemId == null) continue;
      if (!itemIds.has(itemId)) reasons.push(`missing-item-reference:c_fashionSuit.unitId:${itemId}`);
      if (!fashionUnitIds.has(itemId)) reasons.push(`missing-fashion-unit-reference:c_fashionSuit.unitId:${itemId}`);
    }
  }
}

function diffRows(baselineRows, candidateRows, fields = []) {
  const before = idSet(baselineRows);
  const after = idSet(candidateRows);
  const beforeById = rowMap(baselineRows);
  const afterById = rowMap(candidateRows);
  const changedFields = [];
  for (const [id, beforeRow] of beforeById) {
    const afterRow = afterById.get(id);
    if (!afterRow) continue;
    const changed = fields.filter((field) => JSON.stringify(beforeRow[field]) !== JSON.stringify(afterRow[field]));
    if (changed.length) changedFields.push({ id: Number(id), fields: changed });
  }
  return {
    beforeCount: baselineRows.length,
    afterCount: candidateRows.length,
    addedIds: [...after].filter((id) => !before.has(id)).sort(numericSort),
    removedIds: [...before].filter((id) => !after.has(id)).sort(numericSort),
    changedFields,
  };
}

function isCodeCriticalId(codeCriticalIds, tableName, id) {
  const values = codeCriticalIds?.[tableName] || [];
  return values.some((value) => comparableId(value) === comparableId(id));
}

function isClosedFashionSplitMigration({ baseline, candidate, removedItemId }) {
  const removedId = positiveId(removedItemId);
  if (removedId == null) return false;
  const beforeItems = idSet(decodeRows(baseline, "c_item"));
  const afterItems = idSet(decodeRows(candidate, "c_item"));
  const beforeUnits = rowMap(decodeRows(baseline, "c_fashionUnit"));
  const afterUnits = rowMap(decodeRows(candidate, "c_fashionUnit"));
  const beforeSuits = rowMap(decodeRows(baseline, "c_fashionSuit"));
  const afterSuits = rowMap(decodeRows(candidate, "c_fashionSuit"));
  const beforeUnit = beforeUnits.get(String(removedId));
  const suitId = positiveId(beforeUnit?.suitId);
  if (!beforeItems.has(removedId) || afterItems.has(removedId) || Number(beforeUnit?.unit) !== 20 || suitId == null) {
    return false;
  }
  if (afterUnits.has(String(removedId))) return false;
  const beforeSuit = beforeSuits.get(String(suitId));
  const afterSuit = afterSuits.get(String(suitId));
  const beforeIds = (Array.isArray(beforeSuit?.unitId) ? beforeSuit.unitId : []).map(positiveId).filter(Boolean);
  const afterIds = (Array.isArray(afterSuit?.unitId) ? afterSuit.unitId : []).map(positiveId).filter(Boolean);
  if (!beforeIds.includes(removedId) || afterIds.includes(removedId)) return false;
  if (beforeIds.filter((id) => id !== removedId).some((id) => !afterIds.includes(id))) return false;
  const replacements = afterIds.filter((id) => !beforeIds.includes(id));
  const replacementUnits = replacements.map((id) => afterUnits.get(String(id))).filter(Boolean);
  const units = new Set(replacementUnits.map((row) => Number(row.unit)));
  return replacements.length === 2
    && replacementUnits.length === 2
    && units.has(21)
    && units.has(22)
    && replacements.every((id) => afterItems.has(id))
    && replacementUnits.every((row) => positiveId(row.suitId) === suitId);
}

function decodeRows(config, name) {
  const table = findConfigTable(config, name);
  return table ? decodeConfigRows(table, name) : [];
}

function readConfig(filePath, label) {
  if (!filePath) throw gameDataError("GAME_DATA_FILE_REQUIRED", `${label} path is required`);
  const buffer = fs.readFileSync(filePath);
  if (buffer.length === 0) throw gameDataError("GAME_DATA_FILE_EMPTY", `${label} file is empty`);
  try {
    return {
      value: JSON.parse(buffer.toString("utf8")),
      bytes: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
  } catch (error) {
    throw gameDataError("GAME_DATA_JSON_INVALID", `${label} JSON is invalid: ${safeMessage(error)}`);
  }
}

function encodingChanged(before, after) {
  return String(before?.a ?? "") !== String(after?.a ?? "")
    || Boolean(before?.f) !== Boolean(after?.f);
}

function rowMap(rows) {
  return new Map(rows.map((row) => [comparableId(row.id), row]).filter(([id]) => id != null));
}

function idSet(rows) {
  return new Set(rows.map((row) => positiveId(row.id)).filter((id) => id != null));
}

function comparableId(value) {
  if (value == null || value === "") return null;
  return String(value);
}

function positiveId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function valueKind(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function normalizeName(value) {
  const name = String(value ?? "").trim();
  return name && name !== "0" ? name : "";
}

function normalizeDataVersion(value) {
  const token = String(value ?? "");
  if (!/^[0-9a-f]+$/i.test(token)) throw gameDataError("GAME_DATA_VERSION_INVALID", "Invalid data version");
  return token;
}

function numericSort(a, b) {
  return Number(a) - Number(b);
}

function safeMessage(error) {
  return String(error?.message || error || "unknown").slice(0, 300);
}

function gameDataError(code, message) {
  return Object.assign(new Error(message), { code });
}
