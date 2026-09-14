import fs from "node:fs";

import {
  getDoubleGoldStatus,
  getItemCount,
} from "./garden-state.mjs";
import {
  formatDateTime,
  formatDuration,
  flowerName,
} from "./status-format.mjs";
import {
  loadFlowerArtConfig,
  loadItemNameMap,
  summarizeFlowerArtInventory,
} from "./order-state.mjs";
import {
  getFlowerAdvanceSkillExt,
  loadFlowerLevelConfig,
} from "./flower-level-config.mjs";

export const FLOWER_RACK_IFACES = {
  sell: "gs.flowerRack.sell",
  sellOneKey: "gs.flowerRack.sellOneKey",
  recvSellMoney: "gs.flowerRack.recvSellMoney",
  recvOneKey: "gs.flowerRack.recvOneKey",
  makeFlowerArt: "gs.flowerArt.makeFlowerArt",
};

export const TARGET_FLOWER_RACK_ART_ID = 301722;
export const TARGET_FLOWER_RACK_ART_NAME = "丹青瓷瓶：轻紫大花葱 + 蓝叶苏铁 + 粉鹤芋";
export const FLOWER_RACK_GROUP_SIZE = 12;
export const FLOWER_RACK_TARGET_GROUPS = 6;
export const FLOWER_RACK_REQUIRED_ART_COUNT = FLOWER_RACK_GROUP_SIZE * FLOWER_RACK_TARGET_GROUPS;
export const FLOWER_RACK_DOUBLE_GOLD_MIN_REMAINING_MS = 60 * 1000;
export const FLOWER_RACK_SELL_SECONDS_PER_ITEM = 240;
export const FLOWER_RACK_RECOMMENDATION_LIMIT = 5;
export const FLOWER_RACK_GOLD_ITEM_ID = 11;

export const FLOWER_RACK_ART_PRESETS = Object.freeze({
  305101: {
    artId: 305101,
    name: "藤韵花篮：棉花小熊 + 轮生冬青 + 粉红木槿花",
  },
  301722: {
    artId: 301722,
    name: TARGET_FLOWER_RACK_ART_NAME,
  },
  302003: {
    artId: 302003,
    name: "幽木流芳：星河映蕊 + 粉樱月见草 + 金白德鸢",
  },
  302009: {
    artId: 302009,
    name: "幽木流芳：星河映蕊 + 蜜合月见草 + 金白德鸢",
  },
});
export const FLOWER_RACK_ALLOWED_TARGET_ART_IDS = Object.freeze(
  Object.keys(FLOWER_RACK_ART_PRESETS).map((value) => Number(value)),
);

export function normalizeFlowerRackTargetArtId(value, options = {}) {
  if (value == null || value === "") return null;
  const artId = Number(value);
  if (!Number.isSafeInteger(artId) || artId <= 0) return null;
  const flowerArtConfig = safeLoadFlowerArtConfig(options);
  return flowerArtConfig.arts?.[artId] || flowerArtConfig.arts?.[String(artId)]
    ? artId
    : null;
}

export function isAllowedFlowerRackTargetArtId(value, options = {}) {
  if (value == null || value === "") return true;
  return normalizeFlowerRackTargetArtId(value, options) != null;
}

function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickPositiveNumber(values, fallback) {
  for (const value of values) {
    const n = toNumber(value, null);
    if (n != null && n > 0) return n;
  }
  return fallback;
}

function toTimeMs(value) {
  if (value == null || value === "") return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getFlowerRackMap(sync) {
  const rackTot = sync?.flowerRackTot || {};
  return rackTot.flowerRackMap
    || rackTot.flowerRack?.flowerRackMap
    || sync?.flowerRackMap
    || {};
}

function isEmptyRack(row) {
  if (!row || typeof row !== "object") return true;
  return !toNumber(row.iid ?? row.itemId, 0) || !toTimeMs(row.sellStartTime);
}

function safeLoadFlowerArtConfig(options = {}) {
  if (Object.hasOwn(options, "flowerArtConfig")) return options.flowerArtConfig || {};
  try {
    return loadFlowerArtConfig(options.flowerArtConfigPath);
  } catch {
    return {};
  }
}

function safeLoadItemNameMap(options = {}) {
  if (Object.hasOwn(options, "itemNameMap")) return options.itemNameMap || {};
  try {
    return loadItemNameMap(options.itemNameMapPath);
  } catch {
    return {};
  }
}

function itemName(itemId, itemNameMap = {}) {
  if (!itemId) return "-";
  return itemNameMap[itemId] || itemNameMap[String(itemId)] || `物品-${itemId}`;
}

function safeLoadFlowerLevelConfig(options = {}) {
  if (Object.hasOwn(options, "flowerLevelConfig")) return options.flowerLevelConfig || {};
  try {
    return loadFlowerLevelConfig(options.flowerArtConfigPath);
  } catch {
    return {};
  }
}

function normalizeItemCountPair(value) {
  if (Array.isArray(value)) {
    const pair = Array.isArray(value[0]) ? value[0] : value;
    return {
      itemId: toNumber(pair[0], null),
      count: toNumber(pair[1], 0),
    };
  }
  if (value && typeof value === "object") {
    return {
      itemId: toNumber(value.iid ?? value.itemId ?? value.id, null),
      count: toNumber(value.num ?? value.count ?? value.value, 0),
    };
  }
  return { itemId: null, count: 0 };
}

function getCultivatedFlowerIds(sync, options = {}) {
  if (options.cultivatedFlowerIds) {
    return new Set(
      [...options.cultivatedFlowerIds]
        .map((value) => toNumber(value, null))
        .filter(Boolean),
    );
  }
  const cultivateMap = sync?.cultivateTot?.cultivateMap
    || sync?.cultivate?.cultivateMap
    || sync?.cultivateMap
    || {};
  return new Set(
    Object.entries(cultivateMap)
      .map(([key, row]) => ({
        flowerId: toNumber(row?.flowerId ?? key, null),
        lvl: toNumber(row?.rawLvl ?? row?.lvl, 0),
        cultivated: row?.cultivated === true,
      }))
      .filter((row) => row.flowerId && (row.cultivated || row.lvl > 1))
      .map((row) => row.flowerId),
  );
}

function getCultivateMap(sync) {
  return sync?.cultivateTot?.cultivateMap
    || sync?.cultivate?.cultivateMap
    || sync?.cultivateMap
    || {};
}

function isAdCardActive(sync, nowMs) {
  const cardMap = sync?.rchgTot?.cardMap
    || sync?.rchg?.cardMap
    || sync?.cardMap
    || {};
  const card = cardMap[6] || cardMap["6"];
  if (!card) return false;
  if (card.isMain) return true;
  return toTimeMs(card.invalidTime) > nowMs;
}

function getFlowerRackGoldAddRate(sync, flowerLevelConfig, options = {}) {
  if (Object.hasOwn(options, "goldAddRate")) {
    return Math.max(0, toNumber(options.goldAddRate, 0));
  }
  const nowMs = options.nowMs ?? Date.now();
  const hasGoldAdd = isAdCardActive(sync, nowMs)
    || getDoubleGoldStatus(sync, nowMs).active;
  return hasGoldAdd
    ? Math.max(0, toNumber(flowerLevelConfig?.videoGoldAddRate, 0))
    : 0;
}

function getRecommendationGoldAddRate(flowerLevelConfig, options = {}) {
  if (Object.hasOwn(options, "recommendationGoldAddRate")) {
    return Math.max(0, toNumber(options.recommendationGoldAddRate, 0));
  }
  return Math.max(0, toNumber(flowerLevelConfig?.videoGoldAddRate, 0));
}

function formatGoldCount(value) {
  const amount = Math.max(0, Math.round(toNumber(value, 0)));
  if (amount < 10000) return String(amount);
  const yi = Math.floor(amount / 100000000);
  const belowYi = amount % 100000000;
  const wan = Math.floor(belowYi / 10000);
  const belowWan = belowYi % 10000;
  let text = yi > 0 ? `${yi}亿` : "";
  const appendZero = () => {
    if (text && !text.endsWith("零")) text += "零";
  };
  if (yi > 0 && belowYi > 0 && belowYi < 10000000) appendZero();
  if (wan > 0) text += `${wan}万`;
  if (belowWan > 0) {
    if ((yi > 0 || wan > 0) && belowWan < 1000) appendZero();
    text += belowWan;
  }
  return text || "0";
}

export function calculateFlowerRackArtGold(sync, art, options = {}) {
  if (!art || !Array.isArray(art.flowerIds) || art.flowerIds.length === 0) return null;
  const flowerLevelConfig = safeLoadFlowerLevelConfig(options);
  const configuredSale = normalizeItemCountPair(art.sPrice);
  if (configuredSale.itemId != null && configuredSale.itemId !== FLOWER_RACK_GOLD_ITEM_ID) {
    return null;
  }

  let flowerGoldTotal = 0;
  let skillBonus = 0;
  const cultivateMap = getCultivateMap(sync);
  const goldAddRate = getFlowerRackGoldAddRate(sync, flowerLevelConfig, options);
  for (const flowerIdRaw of art.flowerIds) {
    const flowerId = toNumber(flowerIdRaw, null);
    const flowerConfig = flowerLevelConfig?.flowerById?.get?.(String(flowerId));
    const flowerGold = toNumber(flowerConfig?.gld, 0);
    flowerGoldTotal += flowerGold;
    const cultivate = cultivateMap[flowerId] || cultivateMap[String(flowerId)] || {};
    const effects = getFlowerAdvanceSkillExt(cultivate, flowerLevelConfig).effects || {};
    const rackGoldEffect = Math.max(0, toNumber(effects[1], 0));
    if (flowerGold > 0 && rackGoldEffect > 0) {
      skillBonus += Math.max(
        Math.round((flowerGold * rackGoldEffect * 2.3) / (1 + goldAddRate)),
        1,
      );
    }
  }

  const baseSalePrice = configuredSale.itemId === FLOWER_RACK_GOLD_ITEM_ID
    && configuredSale.count > 0
    ? configuredSale.count
    : Math.round(2.3 * flowerGoldTotal);
  if (!(baseSalePrice > 0)) return null;
  return {
    baseSalePrice,
    skillBonus,
    salePrice: baseSalePrice + skillBonus,
    goldAddRate,
  };
}

export function summarizeFlowerRackRecommendations(sync, options = {}) {
  const flowerArtConfig = safeLoadFlowerArtConfig(options);
  const flowerLevelConfig = safeLoadFlowerLevelConfig(options);
  const itemNameMap = safeLoadItemNameMap(options);
  const flowerNameMap = options.nameMap || itemNameMap;
  const cultivatedFlowerIds = getCultivatedFlowerIds(sync, options);
  const limit = Math.max(0, toNumber(options.limit, FLOWER_RACK_RECOMMENDATION_LIMIT));
  const groupSize = pickPositiveNumber(
    [options.groupSize, process.env.FLOWER_RACK_GROUP_SIZE],
    FLOWER_RACK_GROUP_SIZE,
  );
  const goldAddRate = getRecommendationGoldAddRate(flowerLevelConfig, options);

  return Object.values(flowerArtConfig.arts || {})
    .map((art) => {
      const artId = toNumber(art?.id, null);
      const vaseId = toNumber(art?.vaseId, null);
      const gold = calculateFlowerRackArtGold(sync, art, {
        ...options,
        flowerLevelConfig,
        goldAddRate,
      });
      const flowers = summarizeIdCounts(art?.flowerIds).map((flower) => ({
        flowerId: flower.itemId,
        flowerName: flowerName(flower.itemId, flowerNameMap),
        need: flower.needPerArt,
      }));
      if (
        !artId
        || !vaseId
        || !gold
        || flowers.length === 0
        || flowers.some((flower) => !cultivatedFlowerIds.has(flower.flowerId))
      ) {
        return null;
      }
      const vaseName = itemName(vaseId, itemNameMap);
      const flowerText = flowers
        .map((flower) => (
          flower.need > 1
            ? `${flower.flowerName}x${flower.need}`
            : flower.flowerName
        ))
        .join("+");
      const rackGold = gold.salePrice * groupSize * (1 + goldAddRate);
      return {
        artId,
        label: `${artId}【双倍每架${formatGoldCount(rackGold)}金币】(${vaseName}+${flowerText})`,
        vaseId,
        vaseName,
        flowerIds: Array.isArray(art.flowerIds) ? [...art.flowerIds] : [],
        flowers,
        baseSalePrice: gold.baseSalePrice,
        skillBonus: gold.skillBonus,
        salePrice: gold.salePrice,
        groupSize,
        goldMultiplier: 1 + goldAddRate,
        rackGold,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.rackGold - a.rackGold) || (a.artId - b.artId))
    .slice(0, limit);
}

export function attachFlowerRackRecommendations(sync, options = {}) {
  if (Array.isArray(sync?.$flowerRackRecommendations)) return sync;
  return {
    ...(sync || {}),
    $flowerRackRecommendations: summarizeFlowerRackRecommendations(sync, options),
  };
}

function getShelfConfig(options = {}) {
  const configuredArtId = getConfiguredTargetArtId(options);
  const groupSize = pickPositiveNumber(
    [options.groupSize, process.env.FLOWER_RACK_GROUP_SIZE],
    FLOWER_RACK_GROUP_SIZE,
  );
  const targetGroups = pickPositiveNumber(
    [options.targetGroups, process.env.FLOWER_RACK_TARGET_GROUPS],
    FLOWER_RACK_TARGET_GROUPS,
  );
  const requiredArtCount = pickPositiveNumber(
    [options.requiredArtCount, process.env.FLOWER_RACK_REQUIRED_ART_COUNT],
    groupSize * targetGroups,
  );
  return {
    artId: configuredArtId,
    enabled: configuredArtId != null,
    groupSize,
    targetGroups,
    requiredArtCount,
  };
}

function getConfiguredTargetArtId(options = {}) {
  if (Object.hasOwn(options, "targetArtId")) {
    if (options.targetArtId == null || options.targetArtId === "") return null;
    const artId = Number(options.targetArtId);
    return Number.isFinite(artId) ? artId : null;
  }
  const settingsPath = options.flowerRackSettingsPath
    || options.settingsPath
    || process.env.FLOWER_RACK_SETTINGS_PATH
    || process.env.PROFILE_SETTINGS_PATH;
  if (settingsPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (Object.hasOwn(parsed || {}, "flowerRackTargetArtId")) {
        return normalizeFlowerRackTargetArtId(parsed.flowerRackTargetArtId);
      }
    } catch {
      return null;
    }
  }
  return null;
}

function summarizeIdCounts(ids = []) {
  const counts = new Map();
  for (const idRaw of ids || []) {
    const id = toNumber(idRaw, null);
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()].map(([itemId, needPerArt]) => ({ itemId, needPerArt }));
}

function getRecipe(sync, artConfig, options = {}) {
  if (!artConfig) {
    return {
      exists: false,
      vaseId: null,
      flowerIds: [],
      materials: [],
      craftableCount: 0,
    };
  }

  const itemNameMap = safeLoadItemNameMap(options);
  const nameMap = options.nameMap || {};
  const vaseId = toNumber(artConfig.vaseId, null);
  const flowerIds = Array.isArray(artConfig.flowerIds)
    ? artConfig.flowerIds.map((id) => toNumber(id, null)).filter(Boolean)
    : [];
  const materials = [];

  if (vaseId) {
    const have = getItemCount(sync, vaseId);
    materials.push({
      kind: "vase",
      itemId: vaseId,
      itemName: itemName(vaseId, itemNameMap),
      needPerArt: 1,
      have,
      stockRequired: false,
      craftableCount: null,
      missingForOne: 0,
    });
  }

  for (const flower of summarizeIdCounts(flowerIds)) {
    const have = getItemCount(sync, flower.itemId);
    materials.push({
      kind: "flower",
      itemId: flower.itemId,
      itemName: flowerName(flower.itemId, nameMap),
      needPerArt: flower.needPerArt,
      have,
      stockRequired: true,
      craftableCount: Math.floor(have / flower.needPerArt),
      missingForOne: Math.max(0, flower.needPerArt - have),
    });
  }
  const stockMaterials = materials.filter((item) => item.stockRequired);

  return {
    exists: true,
    vaseId,
    flowerIds,
    materials,
    craftableCount: stockMaterials.length
      ? Math.min(...stockMaterials.map((item) => item.craftableCount))
      : 0,
  };
}

function getTargetArt(sync, options = {}) {
  const shelfConfig = getShelfConfig(options);
  const { artId, enabled, groupSize, targetGroups, requiredArtCount } = shelfConfig;
  if (!enabled) {
    return {
      enabled: false,
      artId: null,
      name: "不自动上架",
      label: "不自动上架",
      salePrice: null,
      have: 0,
      need: requiredArtCount,
      groupSize,
      targetGroups,
      missingForTarget: 0,
      craftableCount: 0,
      makeNeededCount: 0,
      availableAfterMake: 0,
      canMakeEnough: false,
      recipe: { exists: false, vaseId: null, flowerIds: [], materials: [], craftableCount: 0 },
      vaseId: null,
      flowerIds: [],
      inventoryRow: null,
    };
  }
  const have = getItemCount(sync, artId);
  const inventoryRows = options.flowerArtInventory || summarizeFlowerArtInventory(sync, options);
  const inventoryRow = inventoryRows.find((row) => row.artId === artId) || null;
  const flowerArtConfig = safeLoadFlowerArtConfig(options);
  const artConfig = flowerArtConfig.arts?.[artId] || flowerArtConfig.arts?.[String(artId)] || null;
  const recipe = getRecipe(sync, artConfig, options);
  const flowerLevelConfig = safeLoadFlowerLevelConfig(options);
  const recommendationGoldAddRate = getRecommendationGoldAddRate(flowerLevelConfig, options);
  const gold = calculateFlowerRackArtGold(sync, artConfig, {
    ...options,
    flowerLevelConfig,
    goldAddRate: recommendationGoldAddRate,
  });
  const salePrice = gold?.salePrice ?? null;
  const rackGold = salePrice == null
    ? null
    : salePrice * groupSize * (1 + recommendationGoldAddRate);
  const missingForTarget = Math.max(0, requiredArtCount - have);
  const canMakeEnough = missingForTarget > 0
    && recipe.exists
    && recipe.craftableCount >= missingForTarget;
  const makeNeededCount = canMakeEnough ? missingForTarget : 0;
  const itemNameMap = safeLoadItemNameMap(options);
  const configuredName = options.targetArtName
    || process.env.FLOWER_RACK_TARGET_ART_NAME
    || FLOWER_RACK_ART_PRESETS[artId]?.name
    || (artId === TARGET_FLOWER_RACK_ART_ID ? TARGET_FLOWER_RACK_ART_NAME : null);
  const name = configuredName || inventoryRow?.artName || itemName(artId, itemNameMap);

  return {
    artId,
    enabled: true,
    name,
    label: inventoryRow?.artLabel || `${name} (${artId})`,
    baseSalePrice: gold?.baseSalePrice ?? null,
    skillBonus: gold?.skillBonus ?? 0,
    salePrice,
    goldMultiplier: 1 + recommendationGoldAddRate,
    rackGold,
    have,
    need: requiredArtCount,
    groupSize,
    targetGroups,
    missingForTarget,
    craftableCount: recipe.craftableCount,
    makeNeededCount,
    availableAfterMake: have + makeNeededCount,
    canMakeEnough,
    recipe,
    vaseId: recipe.vaseId,
    flowerIds: recipe.flowerIds,
    inventoryRow,
  };
}

export function summarizeFlowerRackRows(sync, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const sellSecondsPerItem = toNumber(options.sellSecondsPerItem, FLOWER_RACK_SELL_SECONDS_PER_ITEM);
  const rackMap = getFlowerRackMap(sync);

  return Object.entries(rackMap)
    .map(([rackIdKey, rack]) => {
      const rackId = toNumber(rack?.rackId ?? rackIdKey, null);
      const artId = toNumber(rack?.iid ?? rack?.itemId, 0);
      const num = toNumber(rack?.num, 0);
      const sellStartMs = toTimeMs(rack?.sellStartTime);
      const sellDurationMs = Math.max(0, num * sellSecondsPerItem * 1000);
      const elapsedMs = sellStartMs ? Math.max(0, nowMs - sellStartMs) : 0;
      const remainingMs = sellStartMs ? Math.max(0, sellDurationMs - elapsedMs) : null;
      const empty = isEmptyRack(rack);
      const collectable = !empty && remainingMs === 0;
      const selling = !empty && !collectable;
      const state = empty ? "empty" : collectable ? "collectable" : "selling";
      const statusText = empty ? "空位" : collectable ? "金币可收" : "售卖中";

      return {
        rackId,
        artId: artId || null,
        num,
        sellStartTime: rack?.sellStartTime || null,
        sellStartTimeText: formatDateTime(rack?.sellStartTime),
        sellDurationMs,
        elapsedMs,
        remainingMs,
        remainingText: empty ? "-" : formatDuration(remainingMs),
        empty,
        selling,
        collectable,
        state,
        statusText,
      };
    })
    .filter((row) => row.rackId != null)
    .sort((a, b) => a.rackId - b.rackId);
}

export function summarizeFlowerRackStatus(sync, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const doubleGold = options.doubleGold || getDoubleGoldStatus(sync, nowMs);
  const minRemainingMs = toNumber(options.doubleGoldMinRemainingMs, FLOWER_RACK_DOUBLE_GOLD_MIN_REMAINING_MS);
  const doubleGoldReady = Boolean(doubleGold.active && doubleGold.remainingMs > minRemainingMs);
  const doubleGoldGate = {
    active: Boolean(doubleGold.active),
    ready: doubleGoldReady,
    remainingMs: doubleGold.remainingMs ?? 0,
    remainingText: doubleGold.active ? formatDuration(doubleGold.remainingMs ?? 0) : "未开启",
    eTime: doubleGold.eTime ?? null,
    eTimeText: formatDateTime(doubleGold.eTime),
    minRemainingMs,
    reasonText: doubleGoldReady
      ? "双倍金币剩余大于1分钟"
      : !doubleGold.active
        ? "双倍金币未开启"
        : "双倍金币剩余不足1分钟",
  };
  const rackRows = summarizeFlowerRackRows(sync, options);
  const collectableRows = rackRows.filter((row) => row.collectable);
  const emptyOrCollectedRows = rackRows.filter((row) => row.empty || row.collectable);
  const targetArt = getTargetArt(sync, options);
  const groupSize = targetArt.groupSize;
  const targetGroups = targetArt.targetGroups;
  const requiredArtCount = targetArt.need;
  const targetText = targetArt.enabled
    ? `${targetArt.name}(${targetArt.artId})`
    : targetArt.name;

  let sellPlanRows = [];
  let reasonText = doubleGoldGate.reasonText;
  if (doubleGoldReady) {
    if (!targetArt.enabled) {
      reasonText = collectableRows.length
        ? "当前账号未设置上架花艺，只收取到期花架金币"
        : "当前账号未设置上架花艺，不自动制作或上架花艺";
    } else if (!emptyOrCollectedRows.length) {
      reasonText = "没有空花架或到期金币可收";
    } else if (targetArt.have < requiredArtCount && !targetArt.recipe.exists) {
      reasonText = `${targetText}库存不足且缺少制作配方：库存${targetArt.have}/${requiredArtCount}，只收花架金币，不重新上架`;
    } else if (targetArt.have < requiredArtCount && !targetArt.canMakeEnough) {
      reasonText = `${targetText}库存+可制作不足：库存${targetArt.have}，可制作${targetArt.craftableCount}，需要${requiredArtCount}，只收花架金币，不重新上架`;
    } else {
      const maxGroupsByStock = Math.floor(targetArt.availableAfterMake / groupSize);
      const sellCount = Math.min(targetGroups, maxGroupsByStock, emptyOrCollectedRows.length);
      sellPlanRows = emptyOrCollectedRows.slice(0, sellCount);
      reasonText = sellPlanRows.length
        ? `计划上架${targetText} ${sellPlanRows.length}组，每组${groupSize}个`
        : "没有可用花架空位";
    }
  }

  const collectActions = doubleGoldReady
    ? collectableRows.map((row) => ({
      type: "recvSellMoney",
      iface: FLOWER_RACK_IFACES.recvSellMoney,
      args: { rackId: row.rackId },
      rackId: row.rackId,
      outcomeText: `收取花架${row.rackId}金币`,
    }))
    : [];
  const makeActions = doubleGoldReady && targetArt.enabled && sellPlanRows.length && targetArt.makeNeededCount > 0
    ? [{
      type: "makeFlowerArt",
      iface: FLOWER_RACK_IFACES.makeFlowerArt,
      args: {
        vaseId: targetArt.vaseId,
        flowersIds: targetArt.flowerIds,
        num: targetArt.makeNeededCount,
      },
      artId: targetArt.artId,
      artName: targetArt.name,
      num: targetArt.makeNeededCount,
      outcomeText: `制作${targetText} x${targetArt.makeNeededCount}`,
    }]
    : [];
  const sellActions = doubleGoldReady && targetArt.enabled && sellPlanRows.length
    ? (() => {
      // 一键上架：用 gs.flowerRack.sellOneKey 一次把所有空位/可收槽位上架，
      // 所有槽位同时开始售卖（结束时间一致），且不因个别槽位仍在售卖而降组。
      // sellMap 值为官方格式 [iid, count]（见 game.js _fillSellData: a[y]=[l.iid,v]）。
      const sellMap = {};
      for (const row of sellPlanRows) {
        sellMap[row.rackId] = [targetArt.artId, groupSize];
      }
      return [{
        type: "sell",
        iface: FLOWER_RACK_IFACES.sellOneKey,
        args: { sellMap },
        rackId: null,
        artId: targetArt.artId,
        artName: targetArt.name,
        num: sellPlanRows.length * groupSize,
        outcomeText: `一键上架${targetArt.name}(${targetArt.artId}) x${sellPlanRows.length * groupSize} 到 ${sellPlanRows.length} 个花架`,
      }];
    })()
    : [];
  const actions = [...collectActions, ...makeActions, ...sellActions];

  return {
    exists: rackRows.length > 0,
    rows: rackRows,
    doubleGoldGate,
    targetArt,
    recommendedArts: Array.isArray(options.recommendedArts)
      ? options.recommendedArts
      : Array.isArray(sync?.$flowerRackRecommendations)
        ? sync.$flowerRackRecommendations
        : [],
    collectableCount: collectableRows.length,
    emptyCount: rackRows.filter((row) => row.empty).length,
    sellingCount: rackRows.filter((row) => row.selling).length,
    sellPlanCount: sellPlanRows.length,
    actionCount: actions.length,
    receivedCount: collectActions.length,
    makeActionCount: makeActions.length,
    madeCount: makeActions.reduce((sum, action) => sum + toNumber(action.num), 0),
    shelvedCount: sellPlanRows.length,
    reasonText,
    actions,
  };
}
