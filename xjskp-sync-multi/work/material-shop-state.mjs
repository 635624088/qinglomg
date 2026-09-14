import fs from "node:fs";
import {
  decodeConfigRows as decodeStaticConfigRows,
  findConfigTable as findStaticConfigTable,
} from "./flower-level-config.mjs";
import { getGardenResourceStatus, ITEM_IDS } from "./garden-state.mjs";
import { loadItemNameMap } from "./order-state.mjs";
import { formatDateTime, formatDuration } from "./status-format.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

export const MATERIAL_SHOP_IFACES = {
  enter: "gs.shopCultivate.enter",
  refresh: "gs.shopCultivate.refresh",
  buy: "gs.shopCultivate.buy",
  buyOneKey: "gs.shopCultivate.buyOneKey",
};

const DEFAULT_STATIC_CONFIG_PATH = getDefaultStaticConfigPath();
const MATERIAL_SHOP_TABLE = "c_shop_cultivate";
export const DEFAULT_MATERIAL_SHOP_REFRESH_WINDOW_START = "23:50";
export const DEFAULT_MATERIAL_SHOP_REFRESH_WINDOW_END = "24:00";
export const MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO_OPTIONS = Object.freeze([
  0, 1, 2, 4, 8, 12, 16,
]);
export const DEFAULT_MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO = 4;
export const HARD_MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO = 16;

const materialShopConfigCache = new Map();

function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasOwn(source, key) {
  return source != null && Object.prototype.hasOwnProperty.call(source, key);
}

function getExplicitYuanbaoCount(source) {
  const roots = [
    source?.$usrTot?.data,
    source?.$usrTot?.usr,
    source?.usrTot?.data,
    source?.usrTot?.usr,
    source?.usr,
  ];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    if (hasOwn(root, "dmd")) return toNumber(root.dmd, null);
    for (const bag of [root.bag, root.oi?.bd]) {
      if (hasOwn(bag, ITEM_IDS.YUANBAO)) {
        return toNumber(bag[ITEM_IDS.YUANBAO], null);
      }
      if (hasOwn(bag, String(ITEM_IDS.YUANBAO))) {
        return toNumber(bag[String(ITEM_IDS.YUANBAO)], null);
      }
    }
  }
  return null;
}

export function calculateMaterialShopRefreshCost(manualRefreshCount) {
  const count = Math.max(0, Math.floor(toNumber(manualRefreshCount, 0)));
  if (count < 3) return 0;
  if (count < 7) return 2 ** (count - 3);
  return Math.min(4 * count - 16, 20);
}

function parseClockMinute(value, { allowEndOfDay = false } = {}) {
  const text = String(value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (allowEndOfDay && hour === 24 && minute === 0) return 24 * 60;
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function getRefreshWindowStatus(options = {}) {
  const now = options.now instanceof Date
    ? options.now
    : new Date(options.nowMs ?? Date.now());
  const windowStart = options.windowStart ?? DEFAULT_MATERIAL_SHOP_REFRESH_WINDOW_START;
  const windowEnd = options.windowEnd ?? DEFAULT_MATERIAL_SHOP_REFRESH_WINDOW_END;
  const startMinute = parseClockMinute(windowStart);
  const endMinute = parseClockMinute(windowEnd, { allowEndOfDay: true });
  const valid = startMinute != null
    && endMinute != null
    && startMinute < endMinute
    && endMinute <= 24 * 60;
  const currentMinute = now.getHours()
    * 60
    + now.getMinutes()
    + now.getSeconds() / 60
    + now.getMilliseconds() / 60_000;
  return {
    valid,
    withinWindow: valid && currentMinute >= startMinute && currentMinute < endMinute,
    windowStart: String(windowStart),
    windowEnd: String(windowEnd),
    currentMinute,
  };
}

export function getMaterialShopMidnightRefreshPlan(sync, options = {}) {
  const enabled = options.enabled === true;
  const config = safeLoadMaterialShopConfig(options);
  const shopState = sync?.shopCultivate || {};
  const manualRefreshCount = Math.max(0, Math.floor(toNumber(shopState.mrCount, 0)));
  const freeRefreshTimes = Math.max(0, Math.floor(toNumber(config.freeRefreshTimes, 0)));
  const remainingFreeRefreshTimes = Math.max(0, freeRefreshTimes - manualRefreshCount);
  const nextRefreshCostYuanbao = calculateMaterialShopRefreshCost(manualRefreshCount);
  const maxCostYuanbaoRaw = toNumber(
    options.maxCostYuanbao,
    DEFAULT_MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO,
  );
  const maxCostYuanbao = Number.isFinite(maxCostYuanbaoRaw) && maxCostYuanbaoRaw >= 0
    ? Math.min(maxCostYuanbaoRaw, HARD_MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO)
    : DEFAULT_MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO;
  const yuanbaoCount = getGardenResourceStatus(sync).yuanbao.count;
  const window = getRefreshWindowStatus(options);
  const refreshKind = remainingFreeRefreshTimes > 0 ? "free" : "paid";

  let reason = "ready";
  if (!enabled) reason = "disabled";
  else if (!sync?.shopCultivate) reason = "shop-state-missing";
  else if (!window.valid) reason = "invalid-window";
  else if (!window.withinWindow) reason = "outside-window";
  else if (nextRefreshCostYuanbao > maxCostYuanbao) reason = "refresh-cost-limit-reached";
  else if (nextRefreshCostYuanbao > 0 && yuanbaoCount < nextRefreshCostYuanbao) reason = "yuanbao-insufficient";

  return {
    enabled,
    shouldRefresh: reason === "ready",
    reason,
    refreshKind,
    manualRefreshCount,
    freeRefreshTimes,
    remainingFreeRefreshTimes,
    nextRefreshCostYuanbao,
    maxCostYuanbao,
    yuanbaoCount,
    ...window,
  };
}

export function verifyMaterialShopRefreshOutcome({
  beforeSync,
  afterSync,
  refreshValue,
  enterValue,
  expectedCostYuanbao,
} = {}) {
  const beforeManualRefreshCount = Math.max(
    0,
    Math.floor(toNumber(beforeSync?.shopCultivate?.mrCount, 0)),
  );
  const afterManualRefreshCount = Math.max(
    0,
    Math.floor(toNumber(afterSync?.shopCultivate?.mrCount, 0)),
  );
  const beforeYuanbao = getGardenResourceStatus(beforeSync).yuanbao.count;
  const afterYuanbao = getGardenResourceStatus(afterSync).yuanbao.count;
  const expectedCost = Math.max(0, toNumber(expectedCostYuanbao, 0));
  const explicitAfterYuanbao = getExplicitYuanbaoCount(enterValue)
    ?? getExplicitYuanbaoCount(refreshValue);
  const actualSpentYuanbao = beforeYuanbao - afterYuanbao;
  const base = {
    confirmed: false,
    reason: null,
    beforeManualRefreshCount,
    afterManualRefreshCount,
    beforeYuanbao,
    afterYuanbao,
    actualSpentYuanbao,
    charged: actualSpentYuanbao > 0,
  };

  if (afterManualRefreshCount !== beforeManualRefreshCount + 1) {
    return { ...base, reason: "manual-refresh-count-not-confirmed" };
  }
  if (expectedCost > 0 && explicitAfterYuanbao == null) {
    return { ...base, reason: "paid-balance-not-confirmed" };
  }
  if (actualSpentYuanbao < 0) {
    return { ...base, reason: "yuanbao-delta-invalid" };
  }
  if (actualSpentYuanbao !== 0 && actualSpentYuanbao !== expectedCost) {
    return { ...base, reason: "yuanbao-cost-mismatch" };
  }
  return {
    ...base,
    confirmed: true,
    reason: actualSpentYuanbao > 0
      ? "paid-refresh-confirmed"
      : expectedCost > 0
        ? "extra-free-refresh-confirmed"
        : "free-refresh-confirmed",
  };
}

function getMapValue(map, key) {
  return map?.[key] ?? map?.[String(key)];
}

function itemName(itemId, itemNameMap = {}) {
  if (!itemId) return "-";
  return itemNameMap[itemId] || itemNameMap[String(itemId)] || `物品-${itemId}`;
}

function firstPair(value) {
  return Array.isArray(value) && Array.isArray(value[0]) ? value[0] : [];
}

function normalizeCost(value) {
  if (!Array.isArray(value)) return [];
  if (Array.isArray(value[0])) return value[0];
  return value;
}

function parseTimeMs(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function loadStaticRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const table = findStaticConfigTable(config, MATERIAL_SHOP_TABLE);
  return decodeStaticConfigRows(table, MATERIAL_SHOP_TABLE);
}

export function loadMaterialShopConfig(filePath = DEFAULT_STATIC_CONFIG_PATH) {
  const cacheKey = filePath;
  if (materialShopConfigCache.has(cacheKey)) return materialShopConfigCache.get(cacheKey);

  const rows = loadStaticRows(filePath);
  const meta = rows.find((row) => toNumber(row.id, 0) < 0) || {};
  const shopItems = rows
    .filter((row) => toNumber(row.id, 0) > 0)
    .map((row) => {
      const reward = firstPair(row.items);
      const cost = normalizeCost(row.costs);
      return {
        ...row,
        shopId: toNumber(row.id, null),
        itemId: toNumber(reward[0], null),
        itemNum: toNumber(reward[1], 0),
        priceItemId: toNumber(cost[0], null),
        basePriceNum: toNumber(cost[1], 0),
        limitNum: toNumber(row.bLimit?.[0], 99999),
        unlockLevel: toNumber(row.unlock_lvl, null),
        sort: toNumber(row.sort, 0),
      };
    })
    .filter((row) => row.shopId && row.itemId);
  const loaded = {
    sourcePath: filePath,
    tableName: MATERIAL_SHOP_TABLE,
    rows: shopItems,
    byShopId: Object.fromEntries(shopItems.map((row) => [row.shopId, row])),
    autoRefreshSeconds: toNumber(meta.$autoRefreshCd, 0),
    freeRefreshTimes: toNumber(meta.$frTimes, 0),
    freeRefreshResults: meta.$frResults || [],
    normalRefreshResults: meta.$nrResults || [],
  };
  materialShopConfigCache.set(cacheKey, loaded);
  return loaded;
}

function safeLoadMaterialShopConfig(options = {}) {
  if (Object.hasOwn(options, "materialShopConfig")) return options.materialShopConfig || {};
  try {
    return loadMaterialShopConfig(options.materialShopConfigPath || DEFAULT_STATIC_CONFIG_PATH);
  } catch {
    return {};
  }
}

function safeLoadItemNameMap(options = {}) {
  if (Object.hasOwn(options, "itemNameMap")) return options.itemNameMap || {};
  try {
    return loadItemNameMap(options.itemNameMapPath || DEFAULT_STATIC_CONFIG_PATH);
  } catch {
    return {};
  }
}

function getVisibleInfoMap(shopState = {}) {
  return shopState.infoMap && typeof shopState.infoMap === "object" ? shopState.infoMap : {};
}

function getBoughtCount(shopState = {}, shopId) {
  return toNumber(getMapValue(shopState.bRecord || {}, shopId), 0);
}

function getRefreshStatus(shopState = {}, config = {}, nowMs = Date.now()) {
  const lastRefreshMs = parseTimeMs(shopState.larTime);
  const intervalMs = toNumber(config.autoRefreshSeconds, 0) * 1000;
  const nextRefreshMs = lastRefreshMs && intervalMs ? lastRefreshMs + intervalMs : 0;
  const remainingMs = nextRefreshMs ? Math.max(0, nextRefreshMs - nowMs) : null;
  const manualRefreshCount = Math.max(0, Math.floor(toNumber(shopState.mrCount, 0)));
  const freeRefreshTimes = Math.max(0, Math.floor(toNumber(config.freeRefreshTimes, 0)));
  return {
    lastRefreshTime: shopState.larTime || null,
    lastRefreshTimeText: formatDateTime(shopState.larTime),
    nextRefreshAtMs: nextRefreshMs || null,
    nextRefreshAt: nextRefreshMs ? new Date(nextRefreshMs).toISOString() : null,
    nextRefreshText: nextRefreshMs ? formatDateTime(nextRefreshMs) : "-",
    remainingMs,
    remainingText: remainingMs == null ? "-" : formatDuration(remainingMs),
    manualRefreshCount,
    freeRefreshTimes,
    remainingFreeRefreshTimes: Math.max(0, freeRefreshTimes - manualRefreshCount),
    nextRefreshCostYuanbao: calculateMaterialShopRefreshCost(manualRefreshCount),
  };
}

export function summarizeMaterialShopStatus(sync, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const shopState = sync?.shopCultivate || {};
  const config = safeLoadMaterialShopConfig(options);
  const itemNameMap = safeLoadItemNameMap(options);
  const infoMap = getVisibleInfoMap(shopState);
  const goldCount = getGardenResourceStatus(sync).gold.count;
  const rowOrder = Object.keys(infoMap);
  const rows = rowOrder
    .map((shopIdKey, index) => {
      const shopId = toNumber(shopIdKey, null);
      const cfg = config.byShopId?.[shopId] || {};
      const liveCost = normalizeCost(infoMap[shopIdKey]);
      const priceItemId = toNumber(liveCost[0], cfg.priceItemId ?? ITEM_IDS.GOLD);
      const priceNum = toNumber(liveCost[1], cfg.basePriceNum ?? 0);
      const limitNum = toNumber(cfg.limitNum, 99999);
      const boughtCount = getBoughtCount(shopState, shopId);
      const remainingCount = Math.max(0, limitNum - boughtCount);
      const canBuy = remainingCount > 0 && priceItemId === ITEM_IDS.GOLD && priceNum >= 0;
      const lineCost = canBuy ? priceNum : 0;
      let statusText = "可购买";
      let reasonText = "金币材料，可购买";
      if (remainingCount <= 0) {
        statusText = "已售罄";
        reasonText = "本轮限购已买完";
      } else if (priceItemId !== ITEM_IDS.GOLD) {
        statusText = "非金币";
        reasonText = `价格货币是${itemName(priceItemId, itemNameMap)}，不自动购买`;
      }

      return {
        index: index + 1,
        shopId,
        itemId: cfg.itemId ?? null,
        itemName: itemName(cfg.itemId, itemNameMap),
        itemNum: cfg.itemNum ?? null,
        priceItemId,
        priceItemName: itemName(priceItemId, itemNameMap),
        priceNum,
        priceText: `${priceNum} ${itemName(priceItemId, itemNameMap)}`,
        limitNum,
        boughtCount,
        remainingCount,
        buyCount: canBuy ? 1 : 0,
        lineCost,
        unlockLevel: cfg.unlockLevel ?? null,
        sort: cfg.sort ?? index,
        canBuy,
        statusText,
        reasonText,
        action: canBuy
          ? {
            type: "buyMaterial",
            iface: MATERIAL_SHOP_IFACES.buy,
            args: { shopId },
            shopId,
            itemId: cfg.itemId ?? null,
            itemName: itemName(cfg.itemId, itemNameMap),
            itemNum: cfg.itemNum ?? null,
            priceItemId,
            priceItemName: itemName(priceItemId, itemNameMap),
            priceNum,
            outcomeText: `购买${itemName(cfg.itemId, itemNameMap)} x${cfg.itemNum ?? 1}`,
          }
          : null,
      };
    })
    .filter((row) => row.shopId)
    .sort((a, b) => a.index - b.index);

  const buyableRows = rows.filter((row) => row.canBuy);
  const blockedCurrencyRows = rows.filter((row) => row.remainingCount > 0 && row.priceItemId !== ITEM_IDS.GOLD);
  const totalGoldCost = buyableRows.reduce((sum, row) => sum + row.lineCost, 0);
  const canBuyAll = buyableRows.length > 0
    && blockedCurrencyRows.length === 0
    && goldCount >= totalGoldCost;
  let reasonText = "没有可购买材料";
  if (blockedCurrencyRows.length) {
    reasonText = "存在非金币材料，自动购买跳过";
  } else if (buyableRows.length) {
    reasonText = canBuyAll
      ? `金币足够，计划购买${buyableRows.length}项，总价${totalGoldCost}金币`
      : `金币不足：需要${totalGoldCost}，当前${goldCount}`;
  }

  const actions = canBuyAll ? buyableRows.map((row) => row.action) : [];
  return {
    exists: Boolean(sync?.shopCultivate),
    sourcePath: "shopCultivate.infoMap + shopCultivate.bRecord + c_shop_cultivate",
    configSourcePath: config.sourcePath || null,
    rowCount: rows.length,
    buyableCount: buyableRows.length,
    blockedCurrencyCount: blockedCurrencyRows.length,
    boughtOutCount: rows.filter((row) => row.remainingCount <= 0).length,
    goldCount,
    totalGoldCost,
    canBuyAll,
    reasonText,
    refresh: getRefreshStatus(shopState, config, nowMs),
    rows,
    actions,
  };
}
