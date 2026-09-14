import fs from "node:fs";

import {
  decodeConfigRows,
  findConfigTable,
} from "./flower-level-config.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

const DEFAULT_STATIC_CONFIG_PATH = getDefaultStaticConfigPath();

export const FML_LAND_SCAN_INTERVAL_MS = 15 * 60 * 1000;

export const FML_LAND_IFACES = {
  enter: "gs.fml.enter",
  harvest: "gs.fmlLand.harvest",
  harvestAll: "gs.fmlLand.harvestAll",
};

let cachedFmlLandLevelPath = null;
let cachedFmlLandLevelConfig = null;

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function createFmlLandLevelConfig({ fmlLandLvlRows = [] } = {}) {
  return {
    fmlLandLvlById: new Map(fmlLandLvlRows.map((row) => [String(row.id), row])),
  };
}

export function loadFmlLandLevelConfig(configPath = DEFAULT_STATIC_CONFIG_PATH) {
  if (cachedFmlLandLevelConfig && cachedFmlLandLevelPath === configPath) return cachedFmlLandLevelConfig;
  if (!fs.existsSync(configPath)) {
    cachedFmlLandLevelPath = configPath;
    cachedFmlLandLevelConfig = createFmlLandLevelConfig();
    return cachedFmlLandLevelConfig;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const staticConfig = JSON.parse(raw);
  const fmlLandLvlRows = decodeConfigRows(findConfigTable(staticConfig, "c_fmlLandLvl"), "c_fmlLandLvl");
  cachedFmlLandLevelPath = configPath;
  cachedFmlLandLevelConfig = createFmlLandLevelConfig({ fmlLandLvlRows });
  return cachedFmlLandLevelConfig;
}

export function getFmlLandLevelInfo(lvl = 0, config = loadFmlLandLevelConfig()) {
  const level = toNumber(lvl, 0);
  const row = config?.fmlLandLvlById?.get(String(level));
  return {
    lvl: level,
    stock: toNumber(row?.stock, null),
    timeSeconds: toNumber(row?.time, null),
    source: row ? "c_fmlLandLvl" : "missing-fml-land-level-config",
  };
}

export function getFmlLandScanIntervalMs(env = process.env) {
  const seconds = Number(env.FML_LAND_SCAN_INTERVAL_SECONDS);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.max(60, Math.floor(seconds)) * 1000;
  }
  return FML_LAND_SCAN_INTERVAL_MS;
}

export function shouldScanFmlLand({ lastScanAtMs = 0, nowMs = Date.now(), intervalMs = FML_LAND_SCAN_INTERVAL_MS } = {}) {
  if (!lastScanAtMs) return true;
  return nowMs - lastScanAtMs >= intervalMs;
}

export function getFmlLandMap(sync) {
  const candidates = [
    sync?.fmlTot?.fmlLand?.landMap,
    sync?.fmlLandTot?.fmlLand?.landMap,
    sync?.fmlLand?.landMap,
    sync?.fmlTot?.landMap,
  ];
  return candidates.find(isPlainObject) || {};
}

function estimateFmlLandMaturity(land, { nowMs = Date.now(), fmlLandLevelConfig = loadFmlLandLevelConfig() } = {}) {
  const levelInfo = getFmlLandLevelInfo(land?.lvl ?? 0, fmlLandLevelConfig);
  const baselineMs = Date.parse(land?.lastCalcTime || land?.startTime || "");
  if (!Number.isFinite(baselineMs)) {
    return {
      estimatedCanHarvest: false,
      estimatedMatureFlwCnt: 0,
      matureAtMs: null,
      nextMatureAtMs: null,
      maturitySeconds: levelInfo.timeSeconds,
      maturitySource: "missing-last-calc-time",
      stock: levelInfo.stock,
    };
  }

  if (!Number.isFinite(levelInfo.timeSeconds) || levelInfo.timeSeconds <= 0) {
    return {
      estimatedCanHarvest: false,
      estimatedMatureFlwCnt: 0,
      matureAtMs: null,
      nextMatureAtMs: null,
      maturitySeconds: levelInfo.timeSeconds,
      maturitySource: levelInfo.source,
      stock: levelInfo.stock,
    };
  }

  const intervalMs = levelInfo.timeSeconds * 1000;
  const elapsedMs = Math.max(0, nowMs - baselineMs);
  const elapsedRounds = Math.floor(elapsedMs / intervalMs);
  const estimatedMatureFlwCnt = Number.isFinite(levelInfo.stock)
    ? Math.min(levelInfo.stock, elapsedRounds)
    : elapsedRounds;
  const matureAtMs = baselineMs + intervalMs;
  const nextMatureAtMs = Number.isFinite(levelInfo.stock) && estimatedMatureFlwCnt >= levelInfo.stock
    ? null
    : baselineMs + (estimatedMatureFlwCnt + 1) * intervalMs;

  return {
    estimatedCanHarvest: estimatedMatureFlwCnt > 0,
    estimatedMatureFlwCnt,
    matureAtMs,
    nextMatureAtMs,
    maturitySeconds: levelInfo.timeSeconds,
    maturitySource: estimatedMatureFlwCnt > 0 ? "estimated-fml-land-level" : "fml-land-level-timer",
    stock: levelInfo.stock,
  };
}

export function summarizeFmlLandStatus(sync, options = {}) {
  const landMap = getFmlLandMap(sync);
  const exists = isPlainObject(landMap) && Object.keys(landMap).length > 0;
  const rows = Object.entries(landMap)
    .map(([landId, land]) => {
      const matureFlwCnt = toNumber(land?.matureFlwCnt);
      const flowerId = toNumber(land?.flwId ?? land?.flowerId ?? land?.iid);
      const estimated = estimateFmlLandMaturity(land, options);
      const displayMatureFlwCnt = Math.max(matureFlwCnt, estimated.estimatedMatureFlwCnt);
      const canHarvest = displayMatureFlwCnt > 0;
      return {
        landId: Number(landId),
        flowerId,
        lvl: land?.lvl ?? null,
        matureFlwCnt,
        estimatedMatureFlwCnt: estimated.estimatedMatureFlwCnt,
        displayMatureFlwCnt,
        stock: estimated.stock ?? land?.stock ?? null,
        startTime: land?.startTime || null,
        lastCalcTime: land?.lastCalcTime || null,
        canHarvest,
        matureAtMs: estimated.matureAtMs,
        nextMatureAtMs: estimated.nextMatureAtMs,
        maturitySeconds: estimated.maturitySeconds,
        matureSource: matureFlwCnt > 0 ? "server-matureFlwCnt" : estimated.maturitySource,
        statusText: canHarvest ? "可收获" : "暂无成熟花朵",
      };
    })
    .filter((row) => Number.isFinite(row.landId))
    .sort((a, b) => a.landId - b.landId);
  const harvestableLandIds = rows.filter((row) => row.canHarvest).map((row) => row.landId);
  return {
    exists,
    total: rows.length,
    harvestableCount: harvestableLandIds.length,
    harvestableLandIds,
    rows,
  };
}

export function getFmlLandHarvestPlan(status = {}) {
  const landIds = [...(status.harvestableLandIds || [])].map(Number).filter(Boolean).sort((a, b) => a - b);
  if (!landIds.length) return null;
  return {
    type: "harvestFmlLand",
    iface: FML_LAND_IFACES.harvest,
    args: { landIds },
    requestedCount: landIds.length,
  };
}
