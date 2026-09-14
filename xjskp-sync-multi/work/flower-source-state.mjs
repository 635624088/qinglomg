import fs from "node:fs";

import { decodeConfigRows, findConfigTable } from "./flower-level-config.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

const DEFAULT_STATIC_CONFIG_PATH = getDefaultStaticConfigPath();

let cachedPath = null;
let cachedConfig = null;

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeIdMap(rows = []) {
  return new Map(
    rows
      .map((row) => [String(toNumber(row?.id)), row])
      .filter(([id]) => id !== "null"),
  );
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function formatSourcePart(value) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) return value.map(formatSourcePart).filter(Boolean).join("/");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).trim();
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = formatSourcePart(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function normalizeCostRows(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!Array.isArray(row)) return null;
      const itemId = toNumber(row[0]);
      const count = toNumber(row[1]);
      if (itemId == null || count == null) return null;
      return { itemId, count };
    })
    .filter(Boolean);
}

function itemDisplayName(itemId, item = {}) {
  return item.name || item.sname || item.name1 || `item-${itemId}`;
}

export function createFlowerSourceConfig({
  flowerRows = [],
  itemRows = [],
} = {}) {
  return {
    flowerById: normalizeIdMap(flowerRows),
    itemById: normalizeIdMap(itemRows),
  };
}

export function loadFlowerSourceConfig(configPath = DEFAULT_STATIC_CONFIG_PATH) {
  if (cachedConfig && cachedPath === configPath) return cachedConfig;
  if (!fs.existsSync(configPath)) {
    cachedPath = configPath;
    cachedConfig = createFlowerSourceConfig();
    return cachedConfig;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  const flowerRows = decodeConfigRows(findConfigTable(config, "c_flower"), "c_flower");
  const itemRows = decodeConfigRows(findConfigTable(config, "c_item"), "c_item");
  cachedPath = configPath;
  cachedConfig = createFlowerSourceConfig({ flowerRows, itemRows });
  return cachedConfig;
}

export function getFlowerAcquisitionInfo(flowerId, config = loadFlowerSourceConfig()) {
  const id = toNumber(flowerId);
  const flower = config?.flowerById?.get(String(id)) || {};
  const seedId = toNumber(flower.seedId);
  const eliteId = toNumber(flower.eliteId);
  const seedItem = seedId == null ? null : config?.itemById?.get(String(seedId));
  const flowerItem = id == null ? null : config?.itemById?.get(String(id));
  const sourceItem = seedItem || flowerItem || {};
  const sourceParts = uniqueNonEmpty([sourceItem.getWayText, sourceItem.getWayPram]);

  return {
    flowerId: id,
    seedId,
    eliteId,
    seedName: sourceItem.name || "",
    getWays: normalizeArray(sourceItem.getWays),
    getWayText: formatSourcePart(sourceItem.getWayText) || "-",
    getWayPram: formatSourcePart(sourceItem.getWayPram),
    getWayIcon: normalizeArray(sourceItem.getWayIcon),
    sourceText: sourceParts.join("；") || "-",
  };
}

export function getFlowerCultivationCostInfo(flowerId, config = loadFlowerSourceConfig()) {
  const id = toNumber(flowerId);
  const flower = config?.flowerById?.get(String(id)) || {};
  const costs = normalizeCostRows(flower.culCost).map((cost) => {
    const item = config?.itemById?.get(String(cost.itemId)) || {};
    const itemName = itemDisplayName(cost.itemId, item);
    return {
      ...cost,
      itemName,
      text: `${itemName} (${cost.itemId}) x${cost.count}`,
    };
  });

  return {
    flowerId: id,
    costs,
    costText: costs.map((cost) => cost.text).join("；") || "-",
  };
}
