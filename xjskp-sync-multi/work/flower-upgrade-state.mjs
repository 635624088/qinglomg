import {
  getFlowerUpgradeRequirement,
  loadFlowerLevelConfig,
} from "./flower-level-config.mjs";
import {
  getGardenResourceStatus,
  getItemCount,
} from "./garden-state.mjs";

function toNumber(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getCultivateMap(sync) {
  return sync?.cultivateTot?.cultivateMap
    || sync?.cultivate?.cultivateMap
    || sync?.cultivateMap
    || {};
}

function getCultivateLevel(row) {
  return toNumber(row?.lvl ?? row?.level ?? row?.lv, 0);
}

function getCultivateFlowerId(row, key) {
  return toNumber(row?.flowerId ?? key, null);
}

function getGoldCount(sync) {
  return toNumber(getGardenResourceStatus(sync).gold?.count, 0);
}

export function getFlowerUpgradeCandidates(sync = {}, flowerLevelConfig = loadFlowerLevelConfig()) {
  const goldCount = getGoldCount(sync);
  const candidates = [];
  for (const [key, row] of Object.entries(getCultivateMap(sync))) {
    const flowerId = getCultivateFlowerId(row, key);
    if (flowerId == null) continue;
    const lvl = getCultivateLevel(row);
    const requirement = getFlowerUpgradeRequirement(flowerId, lvl, flowerLevelConfig);
    if (!requirement.upgradable) continue;
    const eliteCount = toNumber(getItemCount(sync, requirement.eliteId), 0);
    if (goldCount < requirement.gldCost || eliteCount < requirement.eliteCost) continue;
    candidates.push({
      flowerId,
      lvl,
      maxLvl: requirement.maxLvl,
      eliteId: requirement.eliteId,
      eliteCost: requirement.eliteCost,
      gldCost: requirement.gldCost,
    });
  }
  return candidates.sort((a, b) => a.lvl - b.lvl || a.flowerId - b.flowerId);
}

function buildUpgradeReason({ lvl, maxLvl, eliteId, gldCost, eliteCost, goldCount, eliteCount }) {
  if (lvl >= maxLvl) return "maxed";
  if (eliteId == null || gldCost == null || eliteCost == null) return "no-config";
  if (goldCount < gldCost && eliteCount < eliteCost) return "gold+elite";
  if (goldCount < gldCost) return "gold";
  if (eliteCount < eliteCost) return "elite";
  return "ok";
}

export function summarizeUpgradeStatus(sync = {}, flowerLevelConfig = loadFlowerLevelConfig()) {
  const goldCount = getGoldCount(sync);
  const rows = [];
  for (const [key, row] of Object.entries(getCultivateMap(sync))) {
    const flowerId = getCultivateFlowerId(row, key);
    if (flowerId == null) continue;
    const lvl = getCultivateLevel(row);
    const requirement = getFlowerUpgradeRequirement(flowerId, lvl, flowerLevelConfig);
    const eliteCount = toNumber(getItemCount(sync, requirement.eliteId), 0);
    const reason = buildUpgradeReason({
      lvl,
      maxLvl: requirement.maxLvl,
      eliteId: requirement.eliteId,
      gldCost: requirement.gldCost,
      eliteCost: requirement.eliteCost,
      goldCount,
      eliteCount,
    });
    rows.push({
      flowerId,
      lvl,
      maxLvl: requirement.maxLvl,
      gold: goldCount,
      goldCost: requirement.gldCost,
      eliteId: requirement.eliteId,
      eliteCount,
      eliteCost: requirement.eliteCost,
      upgradable: reason === "ok",
      reason,
    });
  }
  rows.sort((a, b) => a.lvl - b.lvl || a.flowerId - b.flowerId);
  return {
    total: rows.length,
    maxed: rows.filter((r) => r.reason === "maxed").length,
    upgradable: rows.filter((r) => r.upgradable).length,
    blocked: rows.filter((r) => !r.upgradable && r.reason !== "maxed").length,
    nextCandidate: rows.find((r) => r.upgradable) || null,
    rows,
  };
}
