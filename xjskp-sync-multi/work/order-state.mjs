import fs from "node:fs";
import {
  decodeConfigRows as decodeStaticConfigRows,
  findConfigTable as findStaticConfigTable,
} from "./flower-level-config.mjs";
import { getBag, getDoubleGoldStatus } from "./garden-state.mjs";
import {
  flowerName,
  formatDateTime,
  formatDuration,
  formatFlowerLabel,
} from "./status-format.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

export const SPECIAL_ORDER_DEFS = {
  satin: {
    label: "丝绸订单",
    iface: "gs.orderFlower.finishSatinOrder",
    sourcePath: "orderFlowerTot.orderFlower.orderSatin",
  },
  decorate: {
    label: "建材订单",
    iface: "gs.orderFlower.finishDecorateOrder",
    sourcePath: "orderFlowerTot.orderFlower.orderDecorate",
  },
};

export const ORDER_FLOWER_IFACES = {
  finishOrder: "gs.orderFlower.finishOrder",
};

export const ORDER_CUSTOMER_IFACES = {
  genOrder: "gs.orderCustomer.genOrder",
  makeFlowerArt: "gs.flowerArt.makeFlowerArt",
  finishOrder: "gs.orderCustomer.finishOrder",
  rejectOrder: "gs.orderCustomer.rejectOrder",
};

// Official 411.0.10 c_item identifies 1002 as 花坊币. This is the reward
// identity only; the maximum reward is always calculated from cPrice * order num.
export const FLOWER_CURRENCY_ITEM_ID = 1002;
// Official game.js calls usrCtrl.getTdyCount(107) for customer-order completion.
export const CUSTOMER_ORDER_DAILY_COUNT_TYPE = 107;
export const CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD_VALUES = Object.freeze([1, 2, 3]);
export const DEFAULT_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD_RELEASE_MASK = 4;

export const ORDER_PALACE_IFACES = {
  enter: "gs.orderPalace.enter",
  finishOrder: "gs.orderPalace.finishOrder",
  refreshOrder: "gs.orderPalace.refreshOrder",
};

const DEFAULT_GAME_CONFIG_PATH = getDefaultStaticConfigPath();
const ORDER_CUSTOMER_KIND_TEXT = "顾客订单";
const CUSTOMER_DOUBLE_GOLD_MIN_REMAINING_MS = 60_000;
const ORDER_PALACE_KIND_TEXT = "宫廷订单";
const PALACE_DOUBLE_GOLD_MIN_REMAINING_MS = 60_000;
const RESIDENT_BOARD_COUNT_TYPE = 105;
const RESIDENT_BOARD_TEAM_TRIGGER_COUNTS = [50, 100];
const RESIDENT_BOARD_SPECIAL_ORDER_STOP_COUNTS = RESIDENT_BOARD_TEAM_TRIGGER_COUNTS.map((count) => count - 1);
const TEAM_ORDER_DOUBLE_GOLD_MIN_REMAINING_MS = 180_000;
const SPECIAL_ORDER_COUNT_TYPES = {
  satin: 109,
  decorate: 116,
};
const SPECIAL_ORDER_DAILY_LIMITS = {
  satin: 120,
  decorate: 120,
};
const SPECIAL_ORDER_STAT_FIELDS = {
  satin: "orderSatinFinishNum",
  decorate: "orderDecorateFinishNum",
};
const ORDINARY_ORDER_STAT_FIELD = "orderFlowerFinishNum";
const FLOWER_ART_MAKE_LIST_PATHS = [
  ["flowerArtTot", "flowerArt", "makeList"],
  ["flowerArtTot", "makeList"],
  ["flowerArt", "makeList"],
];
const flowerArtConfigCache = new Map();
const itemNameMapCache = new Map();
const orderCustomerNpcConfigCache = new Map();
const orderFlowerConfigCache = new Map();
const DEFAULT_ITEM_NAMES = {
  1: "元宝",
  11: "金币",
  1002: "花坊币",
  1006: "珍珠",
};

function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isEmptyObject(value) {
  return !value || typeof value !== "object" || Object.keys(value).length === 0;
}

function parseTimeMs(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function strictNonNegativeInteger(value) {
  return value != null
    && (typeof value !== "string" || value.trim() !== "")
    && Number.isSafeInteger(Number(value))
    && Number(value) >= 0
    ? Number(value)
    : null;
}

function strictBinaryFlag(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && (parsed === 0 || parsed === 1)
    ? parsed
    : null;
}

function strictTimeMs(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = parseTimeMs(value);
  return parsed > 0 ? parsed : null;
}

function validateResidentOrderAuthority(order, { requireBoxId = false } = {}) {
  if (!order || typeof order !== "object") return { known: false, reason: "order-missing" };
  if (order.__specialOrderAuthorityInvalid) {
    return { known: false, reason: String(order.__specialOrderAuthorityInvalid) };
  }
  const finishCnt = strictNonNegativeInteger(order.finishCnt);
  if (finishCnt == null) return { known: false, reason: "finishCnt-invalid" };
  const isVideo = strictBinaryFlag(order.isVideo);
  if (isVideo == null) return { known: false, reason: "isVideo-invalid" };
  const cTimeMs = strictTimeMs(order.cTime);
  if (cTimeMs == null) return { known: false, reason: "cTime-invalid" };
  const cdTimeMs = strictTimeMs(order.cdTime);
  if (cdTimeMs == null) return { known: false, reason: "cdTime-invalid" };
  if (requireBoxId && strictNonNegativeInteger(order.boxId ?? order.box ?? order.id) == null) {
    return { known: false, reason: "boxId-invalid" };
  }
  return { known: true, finishCnt, isVideo, cTimeMs, cdTimeMs };
}

function sameLocalDay(leftMs, rightMs) {
  if (!leftMs || !rightMs) return false;
  const left = new Date(leftMs);
  const right = new Date(rightMs);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function getMapValue(map, key) {
  return map?.[key] ?? map?.[String(key)] ?? null;
}

function getUsrCountInfo(sync, countType, nowMs = Date.now(), options = {}) {
  const cntMap = sync?.$usrTot?.cntMap ?? sync?.usrTot?.cntMap ?? null;
  const hasCountMap = Boolean(cntMap)
    && typeof cntMap === "object"
    && !Array.isArray(cntMap);
  const hasRecord = hasCountMap
    && (Object.hasOwn(cntMap, countType) || Object.hasOwn(cntMap, String(countType)));
  const info = getMapValue(cntMap, countType);
  const validInfo = Boolean(info) && typeof info === "object" && !Array.isArray(info);
  const rTimeMs = parseTimeMs(validInfo ? info.rTime : null);
  const rawTdyCnt = validInfo ? info.tdyCnt ?? null : null;
  const parsedTdyCnt = toNumber(rawTdyCnt, null);
  const validTdyCnt = parsedTdyCnt != null
    && Number.isSafeInteger(parsedTdyCnt)
    && parsedTdyCnt >= 0;
  const validRTime = rTimeMs > 0;
  const isFreshToday = validInfo
    && validTdyCnt
    && validRTime
    && sameLocalDay(rTimeMs, nowMs);
  const isOfficialRefresh = options.officialRefreshZero === true
    && validInfo
    && validRTime
    && !sameLocalDay(rTimeMs, nowMs);
  const isOfficialMissingRecord = options.officialRefreshZero === true
    && hasCountMap
    && !hasRecord;
  const countKnown = isFreshToday || isOfficialRefresh || isOfficialMissingRecord;
  return {
    type: countType,
    exists: Boolean(info),
    rawTdyCnt,
    tdyCnt: countKnown ? (isFreshToday ? parsedTdyCnt : 0) : null,
    totalCount: validInfo ? toNumber(info.totCnt) : null,
    rTime: validInfo ? info.rTime ?? null : null,
    rTimeText: formatDateTime(validInfo ? info.rTime : null),
    isFreshToday,
    countKnown,
    countSource: isOfficialMissingRecord
      ? "official-missing-record"
      : isOfficialRefresh
        ? "official-refresh-zero"
        : isFreshToday
          ? "official-today-count"
          : hasCountMap
            ? "panel-invalid"
            : "panel-missing",
  };
}

function getOfficialOrderBoardCountInfo(sync, countType, nowMs = Date.now()) {
  const cntMap = sync?.$usrTot?.cntMap ?? sync?.usrTot?.cntMap ?? null;
  const base = {
    type: countType,
    exists: false,
    rawTdyCnt: null,
    tdyCnt: null,
    totalCount: null,
    rTime: null,
    rTimeText: "-",
    isFreshToday: false,
    countKnown: false,
    countSource: "panel-missing",
  };
  if (!cntMap || typeof cntMap !== "object" || Array.isArray(cntMap)) {
    return base;
  }

  const info = getMapValue(cntMap, countType);
  if (info == null) {
    return {
      ...base,
      tdyCnt: 0,
      countKnown: true,
      countSource: "official-missing-record",
    };
  }
  if (typeof info !== "object" || Array.isArray(info)) {
    return {
      ...base,
      exists: true,
      countSource: "panel-invalid",
    };
  }

  const rawRTime = info.rTime ?? null;
  const rTimeMs = parseTimeMs(rawRTime);
  const common = {
    ...base,
    exists: true,
    rawTdyCnt: info.tdyCnt ?? null,
    totalCount: toNumber(info.totCnt),
    rTime: rawRTime,
    rTimeText: formatDateTime(rawRTime),
  };
  if (!rawRTime) {
    return {
      ...common,
      tdyCnt: 0,
      countKnown: true,
      countSource: "official-refresh-zero",
    };
  }
  if (!rTimeMs) {
    return {
      ...common,
      countSource: "panel-invalid",
    };
  }
  if (rTimeMs && !sameLocalDay(rTimeMs, nowMs)) {
    return {
      ...common,
      tdyCnt: 0,
      countKnown: true,
      countSource: "official-refresh-zero",
    };
  }

  const rawTdyCnt = info.tdyCnt;
  const defaultZero = rawTdyCnt == null || rawTdyCnt === "" || rawTdyCnt === 0 || rawTdyCnt === false;
  const parsedTdyCnt = defaultZero
    ? 0
    : typeof rawTdyCnt === "number" || typeof rawTdyCnt === "string"
      ? toNumber(rawTdyCnt, null)
      : null;
  if (parsedTdyCnt == null || parsedTdyCnt < 0) {
    return {
      ...common,
      countSource: "panel-invalid",
    };
  }
  return {
    ...common,
    tdyCnt: parsedTdyCnt,
    isFreshToday: true,
    countKnown: true,
    countSource: "official-today-count",
  };
}

function getTodayStatistics(sync, nowMs = Date.now()) {
  const statisticsMap = sync?.statisticsTot?.statisticsMap || sync?.statisticsMap || {};
  const rows = Object.entries(statisticsMap)
    .map(([key, row]) => {
      const dayId = toNumber(row?.dayId ?? key, null);
      return {
        key,
        dayId,
        dayText: dayId ? formatDateTime(dayId) : "-",
        sameDay: dayId ? sameLocalDay(dayId, nowMs) : false,
        row,
      };
    })
    .filter((entry) => entry.row && typeof entry.row === "object")
    .sort((a, b) => (b.dayId || 0) - (a.dayId || 0));
  return rows.find((entry) => entry.sameDay) || rows[0] || null;
}

export function getSpecialOrderCompletionCounts(sync, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const statistics = getTodayStatistics(sync, nowMs);
  const doubleGold = options.doubleGold || getDoubleGoldStatus(sync, nowMs);
  const teamOrderDoubleGoldRemainingMs = Number(doubleGold.remainingMs) || 0;
  const teamOrderDoubleGoldReady =
    doubleGold.active === true
    && teamOrderDoubleGoldRemainingMs > TEAM_ORDER_DOUBLE_GOLD_MIN_REMAINING_MS;
  const teamOrderDoubleGoldRemainingText = doubleGold.active
    ? formatDuration(teamOrderDoubleGoldRemainingMs)
    : "未开启或已结束";
  const out = {
    sourceRule: "home-popup cntMap count first, business-statistics fallback only; never fallback to order finishCnt and never self-increment",
    homePopupSourcePath: "$usrTot.cntMap[105].tdyCnt + max($usrTot.cntMap[109].tdyCnt - 1, 0) + max($usrTot.cntMap[116].tdyCnt - 1, 0)",
    businessStatsSourcePath: "statisticsTot.statisticsMap[today].orderFlowerFinishNum/orderSatinFinishNum/orderDecorateFinishNum",
    statisticsDayId: statistics?.dayId ?? null,
    statisticsDayText: statistics?.dayText ?? "-",
  };

  for (const kind of ["satin", "decorate"]) {
    const userCount = getOfficialOrderBoardCountInfo(sync, SPECIAL_ORDER_COUNT_TYPES[kind], nowMs);
    const homePopupCompletedCount = userCount.countKnown && userCount.tdyCnt != null
      ? Math.max(0, userCount.tdyCnt - 1)
      : null;
    const statField = SPECIAL_ORDER_STAT_FIELDS[kind];
    const businessStatsCompletedCount = statistics?.row
      ? toNumber(statistics.row[statField], null)
      : null;
    const completedCount = homePopupCompletedCount ?? businessStatsCompletedCount ?? null;
    const completedCountSource = homePopupCompletedCount != null
      ? "home-popup"
      : businessStatsCompletedCount != null
        ? "business-statistics"
        : "panel-missing";

    out[kind] = {
      completedCount,
      completedCountSource,
      completedCountSourceText: completedCountSource === "home-popup"
          ? "右下角弹窗"
          : completedCountSource === "business-statistics"
            ? "经营状况"
            : "等待面板数据",
      countType: SPECIAL_ORDER_COUNT_TYPES[kind],
      statField,
      homePopupCompletedCount,
      businessStatsCompletedCount,
      userCount,
    };
  }

  const flowerOrderUserCount = getOfficialOrderBoardCountInfo(sync, RESIDENT_BOARD_COUNT_TYPE, nowMs);
  const homePopupFlowerOrderCount = flowerOrderUserCount.countKnown
    && flowerOrderUserCount.tdyCnt != null
      ? flowerOrderUserCount.tdyCnt
    : null;
  const businessStatsFlowerOrderCount = statistics?.row
    ? toNumber(statistics.row[ORDINARY_ORDER_STAT_FIELD], null)
    : null;
  const ordinaryCompletedCount = homePopupFlowerOrderCount ?? businessStatsFlowerOrderCount ?? null;
  const ordinaryCompletedCountSource = homePopupFlowerOrderCount != null
    ? "home-popup"
    : businessStatsFlowerOrderCount != null
      ? "business-statistics"
      : "panel-missing";
  out.ordinary = {
    completedCount: ordinaryCompletedCount,
    completedCountSource: ordinaryCompletedCountSource,
    completedCountSourceText: ordinaryCompletedCountSource === "home-popup"
      ? "右下角弹窗"
      : ordinaryCompletedCountSource === "business-statistics"
        ? "经营状况"
        : "等待面板数据",
    countType: RESIDENT_BOARD_COUNT_TYPE,
    statField: ORDINARY_ORDER_STAT_FIELD,
    homePopupCompletedCount: homePopupFlowerOrderCount,
    businessStatsCompletedCount: businessStatsFlowerOrderCount,
    userCount: flowerOrderUserCount,
  };
  const homePopupResidentBoardCount = homePopupFlowerOrderCount != null
    && out.satin.homePopupCompletedCount != null
    && out.decorate.homePopupCompletedCount != null
      ? homePopupFlowerOrderCount + out.satin.homePopupCompletedCount + out.decorate.homePopupCompletedCount
      : null;
  const businessStatsResidentBoardCount = businessStatsFlowerOrderCount != null
    && out.satin.businessStatsCompletedCount != null
    && out.decorate.businessStatsCompletedCount != null
      ? businessStatsFlowerOrderCount + out.satin.businessStatsCompletedCount + out.decorate.businessStatsCompletedCount
      : null;
  const residentBoardCompletedCount = homePopupResidentBoardCount ?? businessStatsResidentBoardCount ?? null;
  const residentBoardCompletedCountSource = homePopupResidentBoardCount != null
    ? "home-popup"
    : businessStatsResidentBoardCount != null
      ? "business-statistics"
      : "panel-missing";
  const teamOrderOfflineReady = options.teamOrderCapability?.ready === true;
  const teamOrderRealValidated =
    options.teamOrderCapability?.realValidated === true;
  const teamOrderTriggerProtectionEnabled =
    options.teamOrderCapability
      ?.teamOrderTriggerProtectionEnabled !== false;
  const teamOrderRequiresExperienceTriggerDecision =
    options.teamOrderCapability
      ?.requiresExperienceTriggerDecision === true;
  const teamOrderTriggerDecisionReady =
    teamOrderOfflineReady
    && !teamOrderTriggerProtectionEnabled
    && teamOrderRequiresExperienceTriggerDecision
    && teamOrderDoubleGoldReady;
  const teamOrderReady =
    teamOrderOfflineReady
    && !teamOrderTriggerProtectionEnabled
    && !teamOrderRequiresExperienceTriggerDecision
    && teamOrderDoubleGoldReady;
  const teamOrderEffectiveProtectionEnabled =
    !teamOrderReady;
  const pauseSpecialOrders = !teamOrderReady
    && !teamOrderTriggerDecisionReady
    && residentBoardCompletedCount != null
    && RESIDENT_BOARD_SPECIAL_ORDER_STOP_COUNTS.includes(residentBoardCompletedCount);
  let pauseReasonText = null;
  if (pauseSpecialOrders) {
    if (!teamOrderOfflineReady) {
      pauseReasonText = `居民订单板总数 ${residentBoardCompletedCount}，组团运行能力未就绪，停在 49/99`;
    } else if (!teamOrderDoubleGoldReady) {
      pauseReasonText = `居民订单板总数 ${residentBoardCompletedCount}，双倍金币剩余 ${teamOrderDoubleGoldRemainingText}，必须超过3分钟才允许跨过 49/99`;
    } else {
      pauseReasonText = `居民订单板总数 ${residentBoardCompletedCount}，49/99 组团触发保护已开启`;
    }
  }
  out.residentBoard = {
    completedCount: residentBoardCompletedCount,
    completedCountSource: residentBoardCompletedCountSource,
    completedCountSourceText: residentBoardCompletedCountSource === "home-popup"
      ? "右下角弹窗"
      : residentBoardCompletedCountSource === "business-statistics"
        ? "经营状况"
        : "等待面板数据",
    homePopupCompletedCount: homePopupResidentBoardCount,
    businessStatsCompletedCount: businessStatsResidentBoardCount,
    flowerOrderCount: homePopupFlowerOrderCount ?? businessStatsFlowerOrderCount ?? null,
    flowerOrderHomePopupCount: homePopupFlowerOrderCount,
    flowerOrderBusinessStatsCount: businessStatsFlowerOrderCount,
    flowerOrderUserCount,
    stopCounts: RESIDENT_BOARD_SPECIAL_ORDER_STOP_COUNTS,
    teamOrderOfflineReady,
    teamOrderRealValidated,
    teamOrderTriggerProtectionEnabled,
    teamOrderRequiresExperienceTriggerDecision,
    teamOrderGuardMultiplier:
      options.teamOrderCapability?.teamOrderGuardMultiplier ?? null,
    teamOrderGuardExp:
      options.teamOrderCapability?.teamOrderGuardExp ?? null,
    accountHistoricalMaxTeamExp:
      options.teamOrderCapability?.accountHistoricalMaxTeamExp ?? null,
    teamOrderTriggerDecisionReady,
    teamOrderEffectiveProtectionEnabled,
    teamOrderDoubleGoldReady,
    teamOrderDoubleGoldMinRemainingMs: TEAM_ORDER_DOUBLE_GOLD_MIN_REMAINING_MS,
    teamOrderDoubleGoldRemainingMs,
    teamOrderDoubleGoldRemainingText,
    teamOrderDoubleGoldReasonText: teamOrderDoubleGoldReady
      ? "双倍金币剩余超过3分钟"
      : "双倍金币必须剩余超过3分钟",
    teamOrderReady,
    pauseSpecialOrders,
    pauseReasonText,
  };

  return out;
}

function normalizeCountPair(value) {
  if (Array.isArray(value)) {
    return {
      itemId: toNumber(value[0], null),
      count: toNumber(value[1]),
      raw: value,
    };
  }
  if (value && typeof value === "object") {
    return {
      itemId: toNumber(value.itemId ?? value.iid ?? value.id, null),
      count: toNumber(value.count ?? value.num),
      raw: value,
    };
  }
  return { itemId: null, count: 0, raw: value ?? null };
}

export function getCustomerOrderFlowerCurrencyReward(artConfig, orderQuantity, options = {}) {
  const itemId = toNumber(options.itemId ?? FLOWER_CURRENCY_ITEM_ID, FLOWER_CURRENCY_ITEM_ID);
  const quantity = toNumber(orderQuantity, null);
  const cPrice = artConfig?.cPrice;
  if (!Array.isArray(cPrice) || !Number.isFinite(quantity) || quantity <= 0) {
    return {
      itemId,
      itemName: options.itemName || DEFAULT_ITEM_NAMES[itemId] || `物品-${itemId}`,
      baseReward: null,
      quantity,
      reward: null,
      known: false,
      reason: "missing-cPrice-or-order-quantity",
      sourcePath: "c_flowerArt[artId].cPrice",
    };
  }

  const matches = cPrice
    .map(normalizeCountPair)
    .filter((pair) => pair.itemId === itemId);
  if (matches.length !== 1) {
    return {
      itemId,
      itemName: options.itemName || DEFAULT_ITEM_NAMES[itemId] || `物品-${itemId}`,
      baseReward: null,
      quantity,
      reward: null,
      known: false,
      reason: matches.length === 0
        ? "flower-currency-pair-missing"
        : "flower-currency-pair-ambiguous",
      sourcePath: "c_flowerArt[artId].cPrice",
    };
  }

  const baseReward = matches[0].count;
  if (!Number.isFinite(baseReward) || baseReward <= 0) {
    return {
      itemId,
      itemName: options.itemName || DEFAULT_ITEM_NAMES[itemId] || `物品-${itemId}`,
      baseReward: null,
      quantity,
      reward: null,
      known: false,
      reason: "flower-currency-amount-invalid",
      sourcePath: "c_flowerArt[artId].cPrice",
    };
  }

  return {
    itemId,
    itemName: options.itemName || DEFAULT_ITEM_NAMES[itemId] || `物品-${itemId}`,
    baseReward,
    quantity,
    reward: baseReward * quantity,
    known: true,
    reason: "official-cPrice-times-order-num",
    sourcePath: "c_flowerArt[artId].cPrice",
  };
}

export function loadFlowerArtConfig(filePath = DEFAULT_GAME_CONFIG_PATH) {
  const cacheKey = filePath;
  if (flowerArtConfigCache.has(cacheKey)) return flowerArtConfigCache.get(cacheKey);

  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const table = findStaticConfigTable(config, "c_flowerArt");
  const rows = decodeStaticConfigRows(table, "c_flowerArt");
  const arts = {};
  let globals = {};

  for (const row of rows) {
    const artId = toNumber(row.id, null);
    if (artId > 0) {
      arts[artId] = {
        id: artId,
        lvl: toNumber(row.lvl, null),
        cOrder: toNumber(row.cOrder, null),
        wgt: toNumber(row.wgt, null),
        vaseId: toNumber(row.vase, null),
        flowerIds: Array.isArray(row.flowers)
          ? row.flowers.map((id) => toNumber(id, null)).filter(Boolean)
          : [],
        sPrice: row.sPrice || null,
        cPrice: row.cPrice || null,
        createRwd: row.createRwd || null,
        artExpAdd: toNumber(row.artExpAdd, null),
      };
    } else if (artId === -1) {
      globals = row;
    }
  }

  const loaded = {
    sourcePath: filePath,
    arts,
    customerNeedNum: toNumber(globals.$cusNeedNum, null),
    customerMax: toNumber(globals.$cusMax, null),
    customerCreateCd: toNumber(globals.$cusCreateCd, null),
    customerCreateNum: toNumber(globals.$cusCreateNum, null),
  };

  flowerArtConfigCache.set(cacheKey, loaded);
  return loaded;
}

export function loadItemNameMap(filePath = DEFAULT_GAME_CONFIG_PATH) {
  const cacheKey = filePath;
  if (itemNameMapCache.has(cacheKey)) return itemNameMapCache.get(cacheKey);

  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const table = findStaticConfigTable(config, "c_item");
  const rows = decodeStaticConfigRows(table, "c_item");
  const names = {};
  for (const row of rows) {
    const itemId = toNumber(row.id, null);
    if (itemId > 0 && row.name) names[itemId] = row.name;
  }

  itemNameMapCache.set(cacheKey, names);
  return names;
}

export function loadOrderCustomerNpcConfig(filePath = DEFAULT_GAME_CONFIG_PATH) {
  const cacheKey = filePath;
  if (orderCustomerNpcConfigCache.has(cacheKey)) return orderCustomerNpcConfigCache.get(cacheKey);

  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const table = findStaticConfigTable(config, "c_orderCustomerNpc");
  const rows = decodeStaticConfigRows(table, "c_orderCustomerNpc");
  const npcs = {};
  let globals = {};

  for (const row of rows) {
    const npcId = toNumber(row.id, null);
    if (npcId > 0) {
      npcs[npcId] = {
        id: npcId,
        name: row.name || null,
        maintaskId: toNumber(row.maintaskId, null),
        pathId: toNumber(row.pathId, null),
        raw: row,
      };
    } else if (npcId === -1) {
      globals = row;
    }
  }

  const loaded = {
    sourcePath: `${filePath}: c_orderCustomerNpc`,
    npcs,
    npcIds: Array.isArray(globals.$npcId)
      ? globals.$npcId.map((id) => toNumber(id, null)).filter((id) => id != null)
      : Object.keys(npcs).map((id) => Number(id)).filter((id) => Number.isFinite(id)),
    createCdSeconds: Array.isArray(globals.$createCd) ? globals.$createCd : null,
    createNum: Array.isArray(globals.$createNum) ? globals.$createNum : null,
    npcMax: toNumber(globals.$npcMax, null),
    npcMaxDay: toNumber(globals.$npcMaxDay, null),
    firstNpcId: toNumber(globals.$firstNPC, null),
    globals,
  };

  orderCustomerNpcConfigCache.set(cacheKey, loaded);
  return loaded;
}

function safeLoadOrderCustomerNpcConfig(options = {}) {
  if (Object.hasOwn(options, "orderCustomerNpcConfig")) {
    return options.orderCustomerNpcConfig || {};
  }
  try {
    return loadOrderCustomerNpcConfig(options.orderCustomerNpcConfigPath || DEFAULT_GAME_CONFIG_PATH);
  } catch {
    return {};
  }
}

export function getCustomerOrderDailyLimitStatus(sync, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const config = safeLoadOrderCustomerNpcConfig(options);
  const orderMap = getCustomerOrderMap(sync);
  const pendingOrderCount = Object.entries(orderMap || {})
    .filter(([, order]) => order && typeof order === "object" && Object.keys(order).length > 0)
    .length;
  const userCount = getUsrCountInfo(sync, CUSTOMER_ORDER_DAILY_COUNT_TYPE, nowMs, {
    officialRefreshZero: true,
  });
  const dailyLimit = toNumber(config.npcMaxDay, null);
  const dailyCountKnown = userCount.countKnown === true && userCount.tdyCnt != null;
  const clientGenerationLimitReached = dailyLimit != null
    && dailyCountKnown
    && userCount.tdyCnt + pendingOrderCount >= dailyLimit;

  return {
    countType: CUSTOMER_ORDER_DAILY_COUNT_TYPE,
    countSourcePath: `$usrTot.cntMap[${CUSTOMER_ORDER_DAILY_COUNT_TYPE}].tdyCnt`,
    countSourceText: "官方客户端 usrCtrl.getTdyCount(107)",
    configSourcePath: config.sourcePath || null,
    dailyLimit,
    tdyCompletedCount: dailyCountKnown ? userCount.tdyCnt : null,
    pendingOrderCount,
    dailyCountKnown,
    clientGenerationLimitReached,
    finishSubmissionLimitKnown: false,
    behaviorBoundary: "generation-only-client-evidence",
    userCount,
  };
}

export function loadOrderFlowerConfig(filePath = DEFAULT_GAME_CONFIG_PATH) {
  const cacheKey = filePath;
  if (orderFlowerConfigCache.has(cacheKey)) return orderFlowerConfigCache.get(cacheKey);

  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const table = findStaticConfigTable(config, "c_orderFlower");
  const rows = decodeStaticConfigRows(table, "c_orderFlower");
  const globals = rows.find((row) => toNumber(row.id, null) === -1) || {};
  const loaded = {
    sourcePath: `${filePath}: c_orderFlower`,
    orderMax: toNumber(globals.$orderMax, null),
    orderCdSeconds: toNumber(globals.$orderCd, null),
    dailyMax: toNumber(globals.$dailyMax, null),
    globals,
  };

  orderFlowerConfigCache.set(cacheKey, loaded);
  return loaded;
}

export function markOrdinaryResidentOrderRefill(syncValue, boxId, options = {}) {
  if (!syncValue || typeof syncValue !== "object" || boxId == null) return syncValue;
  const normalizedBoxId = toNumber(boxId, null);
  if (normalizedBoxId == null) return syncValue;
  const nowMs = options.nowMs ?? Date.now();
  const cooldownSeconds = toNumber(options.cooldownSeconds, null);
  const refillAtMs = cooldownSeconds == null
    ? null
    : nowMs + Math.max(0, cooldownSeconds) * 1000;
  const marker = {
    boxId: normalizedBoxId,
    __refillPending: true,
    refillCooldownSeconds: cooldownSeconds,
    refillSource: "ordinary-resident-order-submitted",
    cTime: new Date(nowMs).toISOString(),
    cdTime: refillAtMs == null ? null : new Date(refillAtMs).toISOString(),
  };
  const markOrderFlower = (orderFlower) => {
    if (!orderFlower || typeof orderFlower !== "object") return orderFlower;
    const currentOrderMap = orderFlower.orderMap instanceof Map
      ? Object.fromEntries(orderFlower.orderMap)
      : orderFlower.orderMap || {};
    const existingOrder = currentOrderMap[normalizedBoxId] || {};
    return {
      ...orderFlower,
      orderMap: {
        ...currentOrderMap,
        // 保留原订单字段（npcId/flowers 等），只叠加补位标记，
        // 避免提交后把订单整体替换成纯标记导致本地数据丢失。
        [normalizedBoxId]: {
          ...(existingOrder && typeof existingOrder === "object" ? existingOrder : {}),
          ...marker,
        },
      },
    };
  };
  let out = syncValue;
  if (syncValue.orderFlowerTot?.orderFlower) {
    out = {
      ...out,
      orderFlowerTot: {
        ...out.orderFlowerTot,
        orderFlower: markOrderFlower(out.orderFlowerTot.orderFlower),
      },
    };
  }
  if (syncValue.orderFlower) {
    out = {
      ...out,
      orderFlower: markOrderFlower(out.orderFlower),
    };
  }
  return out;
}

function safeLoadFlowerArtConfig(options = {}) {
  if (Object.hasOwn(options, "flowerArtConfig")) return options.flowerArtConfig || {};
  try {
    return loadFlowerArtConfig(options.flowerArtConfigPath || DEFAULT_GAME_CONFIG_PATH);
  } catch {
    return {};
  }
}

function safeLoadItemNameMap(options = {}) {
  if (Object.hasOwn(options, "itemNameMap")) return options.itemNameMap || {};
  try {
    return loadItemNameMap(options.itemNameMapPath || DEFAULT_GAME_CONFIG_PATH);
  } catch {
    return {};
  }
}

function itemName(itemId, itemNameMap = {}) {
  if (!itemId) return "-";
  const key = String(itemId);
  return itemNameMap[key] || itemNameMap[itemId] || DEFAULT_ITEM_NAMES[itemId] || `物品-${key}`;
}

function formatItemLabel(itemId, itemNameMap = {}) {
  if (!itemId) return "-";
  return `${itemName(itemId, itemNameMap)} (${itemId})`;
}

function summarizeFlowerIdCounts(flowerIds = []) {
  const counts = new Map();
  for (const flowerIdRaw of flowerIds || []) {
    const flowerId = toNumber(flowerIdRaw, null);
    if (!flowerId) continue;
    counts.set(flowerId, (counts.get(flowerId) || 0) + 1);
  }
  return [...counts.entries()].map(([flowerId, need]) => ({ flowerId, need }));
}

function composeFlowerArtName({ artId, vaseId, itemNameMap = {}, vaseName = "", flowers = [] } = {}) {
  const rawArtName = itemName(artId, itemNameMap);
  const rawVaseName = vaseName || itemName(vaseId, itemNameMap);
  if (rawArtName && rawArtName !== rawVaseName && rawArtName !== `${rawVaseName}花艺品`) {
    return rawArtName;
  }

  const flowerPart = flowers
    .map((item) => item.need > 1 ? `${item.flowerName}x${item.need}` : item.flowerName)
    .filter(Boolean)
    .join(" + ");
  return flowerPart ? `${rawVaseName}：${flowerPart}` : rawArtName;
}

export function summarizeFlowerArtInventory(sync, options = {}) {
  const bag = options.bag || getBag(sync);
  const cultivateMap = options.cultivateMap || getCultivateMap(sync);
  const flowerArtConfig = safeLoadFlowerArtConfig(options);
  const itemNameMap = safeLoadItemNameMap(options);
  const nameMap = options.nameMap || {};

  return Object.values(flowerArtConfig.arts || {})
    .map((art) => {
      const artId = toNumber(art?.id, null);
      const artCount = artId ? toNumber(bag[artId] ?? bag[String(artId)]) : 0;
      if (!artId || artCount <= 0) return null;

      const sale = normalizeCountPair(art.sPrice);
      const vaseId = toNumber(art.vaseId, null);
      const flowers = summarizeFlowerIdCounts(art.flowerIds).map((item) => ({
        ...item,
        flowerName: flowerName(item.flowerId, nameMap),
        flowerLabel: formatFlowerLabel(item.flowerId, nameMap),
      }));
      const salePriceItemId = sale.itemId;
      const salePrice = sale.count;
      const vaseName = itemName(vaseId, itemNameMap);
      const artName = composeFlowerArtName({ artId, vaseId, itemNameMap, vaseName, flowers });

      return {
        artId,
        artName,
        artLabel: formatItemLabel(artId, itemNameMap),
        artCount,
        vaseId,
        vaseName,
        vaseLabel: formatItemLabel(vaseId, itemNameMap),
        vaseNeed: vaseId ? 1 : 0,
        vaseText: vaseId ? `${formatItemLabel(vaseId, itemNameMap)} x1` : "-",
        flowers,
        flowersText: flowers.length
          ? flowers.map((item) => `${item.flowerLabel} x${item.need}`).join("；")
          : "-",
        salePriceItemId,
        salePriceCurrencyName: itemName(salePriceItemId, itemNameMap),
        salePrice,
        salePriceText: salePriceItemId ? `${salePrice} ${itemName(salePriceItemId, itemNameMap)}` : "-",
        sourcePath: `flowerArtTot/c_flowerArt + $usrTot.data.bag[${artId}]`,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.salePrice - a.salePrice) || (a.artId - b.artId));
}

function normalizeFlowerRequirement(entry) {
  if (Array.isArray(entry)) {
    return {
      itemId: Number(entry[0]),
      need: toNumber(entry[1]),
    };
  }
  if (entry && typeof entry === "object") {
    return {
      itemId: Number(entry.itemId ?? entry.iid ?? entry.id ?? entry.flowerId),
      need: toNumber(entry.num ?? entry.need ?? entry.count),
    };
  }
  return { itemId: 0, need: 0 };
}

function getSpecialOrder(sync, kind) {
  const orderFlower = sync?.orderFlowerTot?.orderFlower || sync?.orderFlower || {};
  if (kind === "satin") return orderFlower.orderSatin || null;
  if (kind === "decorate") return orderFlower.orderDecorate || null;
  return null;
}

function specialOrderFingerprint(order) {
  if (isEmptyObject(order)) return null;
  const requirements = (order.flowers || [])
    .map(normalizeFlowerRequirement)
    .filter((item) => item.itemId && item.need)
    .map((item) => [item.itemId, item.need])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return JSON.stringify({
    requirements,
    npcId: order.npcId ?? null,
    dialogId: order.dialogId ?? null,
    finishCnt: order.finishCnt ?? null,
    cTime: order.cTime ?? null,
  });
}

export function markSpecialOrderStockRejection(sync, kind, itemId, options = {}) {
  if (!sync || typeof sync !== "object" || !SPECIAL_ORDER_DEFS[kind]) return sync;
  const normalizedItemId = toNumber(itemId, null);
  if (normalizedItemId == null || normalizedItemId <= 0) return sync;
  const order = getSpecialOrder(sync, kind);
  const orderFingerprint = specialOrderFingerprint(order);
  if (!orderFingerprint) return sync;
  const requirement = (order.flowers || [])
    .map(normalizeFlowerRequirement)
    .find((item) => item.itemId === normalizedItemId);
  if (!requirement) return sync;
  const bag = getBag(sync);
  const observedHave = toNumber(bag[normalizedItemId] ?? bag[String(normalizedItemId)]);
  const nowMs = options.nowMs ?? Date.now();
  return {
    ...sync,
    $specialOrderStockRejections: {
      ...(sync.$specialOrderStockRejections || {}),
      [kind]: {
        code: toNumber(options.code, 301),
        itemId: normalizedItemId,
        need: requirement.need,
        observedHave,
        confirmedAt: new Date(nowMs).toISOString(),
        orderFingerprint,
      },
    },
  };
}

function resolveSpecialOrderStockRejection(order, requirements, rejection) {
  if (!rejection || rejection.orderFingerprint !== specialOrderFingerprint(order)) return null;
  const requirement = requirements.find((item) => item.itemId === Number(rejection.itemId));
  if (!requirement) return null;
  const observedHave = toNumber(rejection.observedHave, null);
  if (observedHave == null || requirement.have > observedHave) return null;
  return {
    code: toNumber(rejection.code, 301),
    itemId: requirement.itemId,
    need: requirement.need,
    observedHave,
    currentHave: requirement.have,
    confirmedAt: rejection.confirmedAt || null,
    exactHaveKnown: requirement.have < requirement.need,
    reason: "server-confirmed-out-of-stock",
  };
}

function summarizeSpecialOrder(order, kind, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const nameMap = options.nameMap || {};
  const bag = options.bag || {};
  const completion = options.completion || {};
  const residentBoard = options.residentBoard || {};
  const dailyLimit = SPECIAL_ORDER_DAILY_LIMITS[kind] ?? null;
  const dailyLimitReached = dailyLimit != null
    && completion.completedCount != null
    && completion.completedCount >= dailyLimit;
  const residentBoardStop = Boolean(residentBoard.pauseSpecialOrders);

  if (isEmptyObject(order)) {
    return {
      kind,
      kindText: SPECIAL_ORDER_DEFS[kind]?.label || kind,
      exists: false,
      status: "missing",
      statusText: "未生成/未开启",
      canFinish: false,
      isVideo: false,
      npcId: null,
      dialogId: null,
      finishCnt: null,
      dailyLimit,
      dailyLimitReached,
      completedCount: completion.completedCount ?? null,
      completedCountSource: completion.completedCountSource || "panel-missing",
      completedCountSourceText: completion.completedCountSourceText || "等待面板数据",
      homePopupCompletedCount: completion.homePopupCompletedCount ?? null,
      businessStatsCompletedCount: completion.businessStatsCompletedCount ?? null,
      userCount: completion.userCount || null,
      residentBoardTotalCount: residentBoard.completedCount ?? null,
      residentBoardPauseSpecialOrders: residentBoardStop,
      residentBoardStopCounts: residentBoard.stopCounts || RESIDENT_BOARD_SPECIAL_ORDER_STOP_COUNTS,
      cdTime: null,
      cdTimeText: "-",
      remainingMs: null,
      remainingText: "-",
      cTime: null,
      cTimeText: "-",
      requirements: [],
      videoRwd: {},
      serverConfirmedOutOfStock: false,
      stockRejection: null,
    };
  }

  const authority = validateResidentOrderAuthority(order);
  const cdMs = authority.cdTimeMs ?? 0;
  const remainingMs = cdMs > nowMs ? cdMs - nowMs : 0;
  const requirements = (order.flowers || [])
    .map(normalizeFlowerRequirement)
    .filter((item) => item.itemId && item.need)
    .map((item) => {
      const have = toNumber(bag[item.itemId] ?? bag[String(item.itemId)]);
      return {
        itemId: item.itemId,
        name: flowerName(item.itemId, nameMap),
        label: formatFlowerLabel(item.itemId, nameMap),
        need: item.need,
        have,
        missing: Math.max(0, item.need - have),
        enough: have >= item.need,
      };
    });
  const isVideo = authority.isVideo === 1;
  const hasEnoughItems = requirements.length > 0 && requirements.every((item) => item.enough);
  const stockRejection = resolveSpecialOrderStockRejection(
    order,
    requirements,
    options.stockRejection,
  );

  let status = "ready";
  let statusText = "可完成";
  let canFinish = authority.known && hasEnoughItems && !isVideo && remainingMs <= 0;

  if (!authority.known) {
    status = "invalid";
    statusText = "订单状态不完整";
    canFinish = false;
  } else if (isVideo) {
    status = "video";
    statusText = "视频订单";
    canFinish = false;
  } else if (dailyLimitReached) {
    status = "daily-limit";
    statusText = "已达上限";
    canFinish = false;
  } else if (residentBoardStop) {
    status = "resident-board-stop";
    statusText = "居民订单板停单";
    canFinish = false;
  } else if (remainingMs > 0) {
    status = "cooldown";
    statusText = "冷却中";
    canFinish = false;
  } else if (!hasEnoughItems) {
    status = "missing-items";
    statusText = "缺少材料";
    canFinish = false;
  } else if (stockRejection) {
    status = "server-confirmed-out-of-stock";
    statusText = "服务端确认缺货";
    canFinish = false;
  }

  return {
    kind,
    kindText: SPECIAL_ORDER_DEFS[kind]?.label || kind,
    exists: true,
    status,
    statusText,
    canFinish,
    isVideo,
    npcId: order.npcId ?? null,
    dialogId: order.dialogId ?? null,
    finishCnt: order.finishCnt ?? null,
    stateKnown: authority.known,
    stateReason: authority.reason ?? null,
    dailyLimit,
    dailyLimitReached,
    completedCount: completion.completedCount ?? null,
    completedCountSource: completion.completedCountSource || "panel-missing",
    completedCountSourceText: completion.completedCountSourceText || "等待面板数据",
    homePopupCompletedCount: completion.homePopupCompletedCount ?? null,
    businessStatsCompletedCount: completion.businessStatsCompletedCount ?? null,
    userCount: completion.userCount || null,
    residentBoardTotalCount: residentBoard.completedCount ?? null,
    residentBoardPauseSpecialOrders: residentBoardStop,
    residentBoardStopCounts: residentBoard.stopCounts || RESIDENT_BOARD_SPECIAL_ORDER_STOP_COUNTS,
    cdTime: order.cdTime ?? null,
    cdTimeText: formatDateTime(order.cdTime),
    remainingMs,
    remainingText: formatDuration(remainingMs),
    cTime: order.cTime ?? null,
    cTimeText: formatDateTime(order.cTime),
    requirements,
    videoRwd: order.videoRwd || {},
    serverConfirmedOutOfStock: Boolean(stockRejection),
    stockRejection,
  };
}

function collectOrdinaryResidentOrders(orderMap) {
  if (!orderMap || typeof orderMap !== "object") return [];
  const entries = orderMap instanceof Map
    ? [...orderMap.entries()]
    : Array.isArray(orderMap)
      ? orderMap.map((order, index) => [index, order])
      : Object.entries(orderMap);

  return entries
    .map(([key, order]) => {
      if (!order || typeof order !== "object") return null;
      return {
        boxId: toNumber(order.boxId ?? order.box ?? order.id ?? key, null),
        sourceKey: key,
        order,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.boxId ?? Number.MAX_SAFE_INTEGER) - (b.boxId ?? Number.MAX_SAFE_INTEGER));
}

function summarizeOrdinaryResidentOrder(entry, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const nameMap = options.nameMap || {};
  const bag = options.bag || {};
  const order = entry.order || {};
  const authority = validateResidentOrderAuthority(order);
  const cdMs = parseTimeMs(order.cdTime);
  const remainingMs = cdMs > nowMs ? cdMs - nowMs : 0;
  const requirements = (order.flowers || [])
    .map(normalizeFlowerRequirement)
    .filter((item) => item.itemId && item.need)
    .map((item) => {
      const have = toNumber(bag[item.itemId] ?? bag[String(item.itemId)]);
      return {
        itemId: item.itemId,
        name: flowerName(item.itemId, nameMap),
        label: formatFlowerLabel(item.itemId, nameMap),
        need: item.need,
        have,
        missing: Math.max(0, item.need - have),
        enough: have >= item.need,
      };
    });
  const isVideo = toNumber(order.isVideo) !== 0;
  const refillPending = order.__refillPending === true;
  const refillCooldownActive = refillPending && remainingMs > 0;
  const hasEnoughItems = requirements.length > 0 && requirements.every((item) => item.enough);
  let status = "ready";
  let statusText = "可完成";
  let canFinish = Boolean(entry.boxId) && hasEnoughItems && !isVideo && remainingMs <= 0;

  if (refillCooldownActive) {
    // 提交后的冷却期（cdTime 未到）：等待服务端补位，禁止重复提交。
    status = "refill-cooldown";
    statusText = "等待服务端补位";
    canFinish = false;
  } else if (!entry.boxId || !requirements.length) {
    status = "invalid";
    statusText = "数据不完整";
    canFinish = false;
  } else if (remainingMs > 0) {
    status = "cooldown";
    statusText = "冷却中";
    canFinish = false;
  } else if (isVideo) {
    status = "video";
    statusText = "视频订单";
    canFinish = false;
  } else if (!hasEnoughItems) {
    status = "missing-items";
    statusText = "缺少材料";
    canFinish = false;
  }
  // 冷却结束后（remainingMs <= 0）refillPending 标记失效：
  // 服务端未在该 boxId 补位时，该槽位恢复为按订单数据判断（空位/可交付），
  // 不再永久"等待服务端补位"阻塞。

  return {
    kind: "ordinary",
    kindText: "普通居民订单",
    exists: true,
    boxId: entry.boxId,
    sourceKey: entry.sourceKey,
    status,
    statusText,
    canFinish,
    isVideo,
    stateKnown: authority.known,
    stateReason: authority.reason ?? null,
    refillPending,
    refillCooldownSeconds: order.refillCooldownSeconds ?? null,
    refillSource: order.refillSource ?? null,
    npcId: order.npcId ?? null,
    dialogId: order.dialogId ?? null,
    finishCnt: order.finishCnt ?? null,
    cdTime: order.cdTime ?? null,
    cdTimeText: formatDateTime(order.cdTime),
    remainingMs,
    remainingText: formatDuration(remainingMs),
    cTime: order.cTime ?? null,
    cTimeText: formatDateTime(order.cTime),
    requirements,
    videoRwd: order.videoRwd || {},
  };
}

function summarizeOrdinaryResidentOrders(orderMap, options = {}) {
  const orders = collectOrdinaryResidentOrders(orderMap)
    .map((entry) => summarizeOrdinaryResidentOrder(entry, options));
  const readyOrders = orders.filter((order) => order.canFinish && !order.isVideo);
  const completion = options.completion || {};
  return {
    kind: "ordinary",
    kindText: "普通居民订单",
    sourcePath: "orderFlowerTot.orderFlower.orderMap",
    exists: orders.length > 0,
    total: orders.length,
    readyCount: readyOrders.length,
    blockedCount: orders.length - readyOrders.length,
    completedCount: completion.completedCount ?? null,
    completedCountSource: completion.completedCountSource ?? "panel-missing",
    completedCountSourceText: completion.completedCountSourceText ?? "等待面板数据",
    homePopupCompletedCount: completion.homePopupCompletedCount ?? null,
    businessStatsCompletedCount: completion.businessStatsCompletedCount ?? null,
    countType: completion.countType ?? RESIDENT_BOARD_COUNT_TYPE,
    statField: completion.statField ?? ORDINARY_ORDER_STAT_FIELD,
    orders,
  };
}

export function summarizeOrderFlowerStatus(sync, options = {}) {
  const orderFlower = sync?.orderFlowerTot?.orderFlower || sync?.orderFlower || {};
  const bag = options.bag || getBag(sync);
  const shared = { ...options, bag };
  const completionCounts = getSpecialOrderCompletionCounts(sync, options);

  return {
    sourcePath: "orderFlowerTot.orderFlower",
    completionCounts,
    residentBoard: completionCounts.residentBoard,
    satin: summarizeSpecialOrder(orderFlower.orderSatin, "satin", {
      ...shared,
      completion: completionCounts.satin,
      residentBoard: completionCounts.residentBoard,
      stockRejection: sync?.$specialOrderStockRejections?.satin,
    }),
    decorate: summarizeSpecialOrder(orderFlower.orderDecorate, "decorate", {
      ...shared,
      completion: completionCounts.decorate,
      residentBoard: completionCounts.residentBoard,
      stockRejection: sync?.$specialOrderStockRejections?.decorate,
    }),
    ordinary: summarizeOrdinaryResidentOrders(orderFlower.orderMap, {
      ...shared,
      completion: completionCounts.ordinary,
    }),
  };
}

function firstPositiveNumber(values) {
  for (const value of values) {
    const n = toNumber(value, null);
    if (n != null && n > 0) return n;
  }
  return null;
}

function getPalaceOrderFlowerId(row) {
  return firstPositiveNumber([
    row?.flowerId,
    row?.flwId,
    row?.itemId,
    row?.id,
  ]);
}

function getPalaceOrderNeed(row) {
  return firstPositiveNumber([
    row?.num,
    row?.need,
    row?.needNum,
    row?.flowerNum,
    row?.targetNum,
    row?.orderNum,
    row?.total,
  ]);
}

function isPalaceOrderFinished(row) {
  return row?.isFinish === true
    || row?.isFinish === 1
    || row?.isFinish === "1"
    || row?.isFinish === "true"
    || row?.finished === true
    || row?.finish === true
    || row?.isFinished === true;
}

function collectPalaceOrderEntries(sync) {
  const roots = [
    { value: sync?.orderPalaceTot?.orderPalace, sourcePath: "orderPalaceTot.orderPalace" },
    { value: sync?.orderPalaceTot?.orderPalace?.orderMap, sourcePath: "orderPalaceTot.orderPalace.orderMap" },
    { value: sync?.orderPalace, sourcePath: "orderPalace" },
    { value: sync?.orderPalace?.orderMap, sourcePath: "orderPalace.orderMap" },
  ];
  const entries = [];
  const seen = new Set();

  function addRow(row, sourcePath) {
    if (!row || typeof row !== "object" || seen.has(row)) return;
    if (!getPalaceOrderFlowerId(row) || !getPalaceOrderNeed(row)) return;
    seen.add(row);
    entries.push({ row, sourcePath });
  }

  function visitContainer(container, sourcePath) {
    if (!container || typeof container !== "object") return;
    if (Array.isArray(container)) {
      container.forEach((item, index) => addRow(item, `${sourcePath}[${index}]`));
      return;
    }

    addRow(container, sourcePath);
    for (const key of ["orderMap", "map", "orderList", "orders", "list"]) {
      const child = container[key];
      if (!child || child === container) continue;
      visitContainer(child, `${sourcePath}.${key}`);
    }

    for (const [key, value] of Object.entries(container)) {
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        visitContainer(value, `${sourcePath}.${key}`);
      } else {
        addRow(value, `${sourcePath}.${key}`);
      }
    }
  }

  for (const root of roots) visitContainer(root.value, root.sourcePath);
  return entries;
}

export function summarizeOrderPalaceStatus(sync, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const nameMap = options.nameMap || {};
  const bag = options.bag || getBag(sync);
  const doubleGoldGate = customerDoubleGoldGate(sync, {
    ...options,
    nowMs,
    doubleGoldMinRemainingMs: PALACE_DOUBLE_GOLD_MIN_REMAINING_MS,
  });
  const entries = collectPalaceOrderEntries(sync);
  const unfinishedEntries = entries.filter((entry) => !isPalaceOrderFinished(entry.row));
  const entry = unfinishedEntries[0] || entries[0] || null;
  const base = {
    kind: "palace",
    kindText: ORDER_PALACE_KIND_TEXT,
    sourcePath: entry?.sourcePath || "orderPalaceTot.orderPalace",
    exists: Boolean(entry),
    total: entries.length,
    unfinishedCount: unfinishedEntries.length,
    doubleGoldGate,
  };

  if (!entry) {
    return {
      ...base,
      status: "missing-order",
      statusText: "暂无宫廷订单",
      actionText: "跳过：暂无宫廷订单",
      canFinish: false,
      flowerId: null,
      flowerName: "-",
      flowerLabel: "-",
      need: null,
      have: null,
      missing: null,
      cTime: null,
      cTimeText: "-",
    };
  }

  const row = entry.row;
  const flowerId = getPalaceOrderFlowerId(row);
  const need = getPalaceOrderNeed(row);
  const have = flowerId != null ? toNumber(bag[flowerId] ?? bag[String(flowerId)], 0) : null;
  const missing = need != null && have != null ? Math.max(0, need - have) : null;
  const finished = isPalaceOrderFinished(row);
  let status = "ready";
  let statusText = "可提交";
  let actionText = "会提交";
  let canFinish = true;

  if (!flowerId || !need) {
    status = "invalid";
    statusText = "数据不完整";
    actionText = "跳过：宫廷订单数据不完整";
    canFinish = false;
  } else if (finished) {
    status = "completed";
    statusText = "已完成";
    actionText = "跳过：宫廷订单已完成";
    canFinish = false;
  } else if (missing > 0) {
    status = "missing-flowers";
    statusText = "缺少花朵";
    actionText = "跳过：花朵库存不足";
    canFinish = false;
  } else if (!doubleGoldGate.ready) {
    status = "waiting-double-gold";
    statusText = "等待双倍金币";
    actionText = `跳过：${doubleGoldGate.reasonText}`;
    canFinish = false;
  }

  return {
    ...base,
    status,
    statusText,
    actionText,
    canFinish,
    flowerId,
    flowerName: flowerName(flowerId, nameMap),
    flowerLabel: formatFlowerLabel(flowerId, nameMap),
    need,
    have,
    missing,
    finished,
    cTime: row?.cTime ?? null,
    cTimeText: formatDateTime(row?.cTime),
    raw: row,
  };
}

export function getAutoSubmitPalaceOrderActions(palaceStatus) {
  if (!palaceStatus?.canFinish) return [];
  return [
    {
      kind: "palace",
      iface: ORDER_PALACE_IFACES.finishOrder,
      args: {},
      reason: "double-gold-flower-stock-ready",
      flowerId: palaceStatus.flowerId,
      need: palaceStatus.need,
      have: palaceStatus.have,
    },
  ];
}

function getCustomerOrderMap(sync) {
  return sync?.orderCustomerTot?.orderCustomer?.orderMap || sync?.orderCustomer?.orderMap || {};
}

function hasBagSnapshot(sync) {
  const usrTot = sync?.$usrTot;
  const roots = [usrTot?.data, usrTot?.usr, usrTot];
  return roots.some((root) => (
    root
    && typeof root === "object"
    && (Object.hasOwn(root, "bag") || Object.hasOwn(root, "itemMap"))
  ));
}

function getCultivateMap(sync) {
  return sync?.cultivateTot?.cultivateMap
    || sync?.cultivate?.cultivateMap
    || sync?.cultivateMap
    || {};
}

function getCultivateLevel(cultivateMap, flowerId) {
  const row = cultivateMap?.[flowerId] || cultivateMap?.[String(flowerId)];
  return toNumber(row?.lvl ?? row?.level ?? row?.lv, 0);
}

function getPlantableFlowerIds(cultivateMap) {
  const out = new Set();
  for (const [key, row] of Object.entries(cultivateMap || {})) {
    const flowerId = toNumber(row?.flowerId ?? key, null);
    if (flowerId == null) continue;
    if (toNumber(row?.lvl ?? row?.level ?? row?.lv, 0) >= 2) out.add(flowerId);
  }
  return out;
}

function readOwnedPath(root, path) {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return { exists: false, value: null };
    }
    current = current[segment];
  }
  return { exists: true, value: current };
}

function normalizeIdSet(value) {
  const out = new Set();
  const add = (id) => {
    const n = toNumber(id, null);
    if (n != null) out.add(n);
  };

  if (value == null) return out;
  if (Array.isArray(value)) {
    for (const id of value) add(id);
    return out;
  }
  if (value instanceof Set) {
    for (const id of value) add(id);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, row] of Object.entries(value)) {
      if (row === false || row == null || row === 0) continue;
      if (row && typeof row === "object") add(row.artId ?? row.id ?? key);
      else add(key);
    }
    return out;
  }

  add(value);
  return out;
}

function getFlowerArtActivation(sync) {
  for (const path of FLOWER_ART_MAKE_LIST_PATHS) {
    const found = readOwnedPath(sync, path);
    if (!found.exists) continue;
    const activeArtIds = normalizeIdSet(found.value);
    return {
      known: true,
      sourcePath: path.join("."),
      activeArtIds,
      activeCount: activeArtIds.size,
    };
  }

  return {
    known: false,
    sourcePath: null,
    activeArtIds: new Set(),
    activeCount: null,
  };
}

function customerDoubleGoldGate(sync, options = {}) {
  const minRemainingMs = options.doubleGoldMinRemainingMs ?? CUSTOMER_DOUBLE_GOLD_MIN_REMAINING_MS;
  const doubleGold = options.doubleGold || getDoubleGoldStatus(sync, options.nowMs ?? Date.now());
  const ready = Boolean(doubleGold.active && doubleGold.remainingMs >= minRemainingMs);
  let reasonText = "双倍金币有效";
  if (!doubleGold.active) reasonText = "双倍金币未开启";
  else if (doubleGold.remainingMs < minRemainingMs) reasonText = "双倍金币剩余不足1分钟";

  return {
    minRemainingMs,
    ready,
    reasonText,
    active: Boolean(doubleGold.active),
    remainingMs: doubleGold.remainingMs ?? 0,
    remainingText: formatDuration(doubleGold.remainingMs ?? 0),
    eTime: doubleGold.eTime ?? null,
    eTimeText: formatDateTime(doubleGold.eTime),
    sourcePath: doubleGold.sourcePath || "videoDouble.eTime",
  };
}

function normalizeCustomerOrder(entry, npcId, options = {}) {
  const nameMap = options.nameMap || {};
  const bag = options.bag || {};
  const gate = options.doubleGoldGate || {};
  const cultivateMap = options.cultivateMap || {};
  const flowerArtConfig = options.flowerArtConfig || {};
  const flowerArtActivation = options.flowerArtActivation || { known: false, activeArtIds: new Set(), sourcePath: null };
  const bagSnapshotKnown = options.bagSnapshotKnown === true;
  const npcIdNum = toNumber(npcId, null);
  const artId = toNumber(entry?.artId, null);
  const needArt = toNumber(entry?.num, null);
  const haveArt = artId != null ? toNumber(bag[artId] ?? bag[String(artId)]) : null;
  const missingArt = needArt != null && haveArt != null ? Math.max(0, needArt - haveArt) : null;
  const pendingArtSync = entry?.automationPendingArtSync || null;
  const pendingArtSyncArtId = toNumber(pendingArtSync?.artId, null);
  const artConfig = artId != null ? flowerArtConfig.arts?.[artId] || flowerArtConfig.arts?.[String(artId)] : null;
  const flowerCurrencyReward = getCustomerOrderFlowerCurrencyReward(artConfig, needArt, {
    itemId: FLOWER_CURRENCY_ITEM_ID,
    itemName: itemName(FLOWER_CURRENCY_ITEM_ID, options.itemNameMap || {}),
  });
  const artActivationKnown = Boolean(flowerArtActivation.known && artId != null);
  const artActivated = artActivationKnown ? flowerArtActivation.activeArtIds.has(artId) : true;
  const flowerRequirements = missingArt && artConfig?.flowerIds?.length
    ? artConfig.flowerIds.map((flowerId) => {
      const have = toNumber(bag[flowerId] ?? bag[String(flowerId)]);
      const need = missingArt;
      return {
        itemId: flowerId,
        flowerId,
        name: flowerName(flowerId, nameMap),
        label: formatFlowerLabel(flowerId, nameMap),
        need,
        have,
        missing: Math.max(0, need - have),
        enough: have >= need,
      };
    })
    : [];
  const hasEnoughArt = needArt != null && haveArt != null && haveArt >= needArt;
  const hasRecipe = Boolean(artConfig?.flowerIds?.length && artConfig?.vaseId != null);
  const needVase = hasRecipe && missingArt > 0 ? missingArt : 0;
  const haveVase = hasRecipe ? toNumber(bag[artConfig.vaseId] ?? bag[String(artConfig.vaseId)], 0) : null;
  const missingVase = haveVase != null ? Math.max(0, needVase - haveVase) : null;
  const hasEnoughFlowers = missingArt === 0 || (hasRecipe && flowerRequirements.every((item) => item.enough));
  const hasEnoughVase = missingArt === 0 || (hasRecipe && haveVase >= needVase);
  const orderDataKnown = Number.isSafeInteger(npcIdNum)
    && Number.isSafeInteger(artId)
    && Number.isSafeInteger(needArt)
    && needArt > 0;
  const cultivateKnown = Object.keys(cultivateMap || {}).length > 0;
  const plantableFlowerIds = cultivateKnown ? getPlantableFlowerIds(cultivateMap) : new Set();
  const uncultivatedFlowers = cultivateKnown && hasRecipe && missingArt > 0
    ? [...new Set(artConfig.flowerIds || [])]
      .map((flowerId) => {
        const lvl = getCultivateLevel(cultivateMap, flowerId);
        const have = toNumber(bag[flowerId] ?? bag[String(flowerId)], 0);
        return {
          flowerId,
          name: flowerName(flowerId, nameMap),
          label: formatFlowerLabel(flowerId, nameMap),
          lvl,
          have,
          plantable: plantableFlowerIds.has(flowerId),
        };
      })
      .filter((item) => item.have === 0 && !item.plantable)
    : [];
  const hasUncultivatedFlowers = uncultivatedFlowers.length > 0;
  const flowerStockShortageConfirmed = Boolean(
    orderDataKnown
      && bagSnapshotKnown
      && hasRecipe
      && missingArt > 0
      && flowerRequirements.length > 0
      && flowerRequirements.some((item) => item.missing > 0),
  );
  const inactiveArtConfirmed = Boolean(
    orderDataKnown
      && hasRecipe
      && artActivationKnown
      && !artActivated,
  );
  const customerOrderPriorityRejectReason = inactiveArtConfirmed && flowerStockShortageConfirmed
    ? "inactive-art-and-flower-stock-insufficient"
    : inactiveArtConfirmed
      ? "inactive-art"
      : flowerStockShortageConfirmed
        ? "flower-stock-insufficient"
        : null;
  const customerOrderPriorityRejectReasonText = customerOrderPriorityRejectReason === "inactive-art-and-flower-stock-insufficient"
    ? "花艺未激活且制作所需花朵库存不足"
    : customerOrderPriorityRejectReason === "inactive-art"
      ? "花艺未激活"
      : customerOrderPriorityRejectReason === "flower-stock-insufficient"
        ? "制作所需花朵库存不足"
        : null;
  const customerOrderPriorityReject = Boolean(
    flowerCurrencyReward.known && customerOrderPriorityRejectReason,
  );
  const canMakeArt = artActivated && !hasEnoughArt && missingArt > 0 && hasRecipe && hasEnoughFlowers;
  const waitingForArtSync = Boolean(
    pendingArtSync
      && artId != null
      && pendingArtSyncArtId === artId
      && !hasEnoughArt,
  );

  let status = "ready";
  let statusText = "可提交";
  let actionText = "会提交";
  let canFinish = hasEnoughArt;

  if (artId == null || needArt == null) {
    status = "invalid";
    statusText = "数据不完整";
    actionText = "跳过：订单数据不完整";
    canFinish = false;
  } else if (inactiveArtConfirmed) {
    status = "temporary-out-of-stock";
    statusText = "暂时没货";
    actionText = `会执行暂时没货：${customerOrderPriorityRejectReasonText}`;
    canFinish = false;
  } else if (!artActivated) {
    status = "inactive-art";
    statusText = "花艺未激活";
    actionText = "跳过：花艺未激活";
    canFinish = false;
  } else if (hasEnoughArt) {
    status = "ready";
    statusText = "可提交";
    actionText = "会提交";
    canFinish = true;
  } else if (waitingForArtSync) {
    status = "waiting-art-sync";
    statusText = "等待花艺库存同步";
    actionText = "跳过：等待花艺库存同步";
    canFinish = false;
  } else if (flowerStockShortageConfirmed) {
    status = "temporary-out-of-stock";
    statusText = "暂时没货";
    actionText = "会执行暂时没货：制作所需花朵库存不足";
    canFinish = false;
  } else if (hasUncultivatedFlowers) {
    status = "temporary-out-of-stock";
    statusText = "暂时没货";
    actionText = "会执行暂时没货：所需花朵未培育";
    canFinish = false;
  } else if (!hasRecipe) {
    status = "missing-recipe";
    statusText = "未知花艺配方";
    actionText = "跳过：未知花艺配方";
    canFinish = false;
  } else if (!hasEnoughFlowers) {
    status = "temporary-out-of-stock";
    statusText = "暂时没货";
    actionText = "会执行暂时没货";
    canFinish = false;
  } else if (canMakeArt) {
    status = "make-art-ready";
    statusText = "可制作并提交";
    actionText = "会先制作花艺再完成订单";
    canFinish = true;
  } else {
    status = "temporary-out-of-stock";
    statusText = "暂时没货";
    actionText = "会执行暂时没货";
    canFinish = false;
  }

  return {
    kind: "customer",
    kindText: ORDER_CUSTOMER_KIND_TEXT,
    npcId: npcIdNum,
    dialogId: entry?.dialogId ?? null,
    pathId: entry?.pathId ?? null,
    artId,
    artLabel: artId != null ? `花艺-${artId}` : "-",
    needArt,
    haveArt,
    missingArt,
    vaseId: artConfig?.vaseId ?? null,
    needVase,
    haveVase,
    missingVase,
    artActivated,
    artActivationKnown,
    artActivationSource: flowerArtActivation.sourcePath || null,
    flowerCurrencyItemId: flowerCurrencyReward.itemId,
    flowerCurrencyItemName: flowerCurrencyReward.itemName,
    flowerCurrencyBaseReward: flowerCurrencyReward.baseReward,
    flowerCurrencyQuantity: flowerCurrencyReward.quantity,
    flowerCurrencyReward: flowerCurrencyReward.reward,
    flowerCurrencyRewardKnown: flowerCurrencyReward.known,
    flowerCurrencyRewardReason: flowerCurrencyReward.reason,
    flowerCurrencyRewardSourcePath: flowerCurrencyReward.sourcePath,
    flowerStockShortageConfirmed,
    inactiveArtConfirmed,
    customerOrderPriorityReject,
    customerOrderPriorityRejectReason,
    customerOrderPriorityRejectReasonText,
    automationPendingArtSync: pendingArtSync,
    flowerIds: artConfig?.flowerIds || [],
    status,
    statusText,
    actionText,
    canFinish,
    hasEnoughArt,
    canMakeArt,
    hasEnoughFlowers,
    hasEnoughVase,
    cultivateKnown,
    hasUncultivatedFlowers,
    uncultivatedFlowerCount: uncultivatedFlowers.length,
    uncultivatedFlowers,
    cTime: entry?.cTime ?? null,
    cTimeText: formatDateTime(entry?.cTime),
    flowerRequirements,
  };
}

export function normalizeCustomerOrderFlowerCurrencyRewardReleaseMask(
  value,
  fallback = DEFAULT_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD_RELEASE_MASK,
) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 7
    ? value
    : fallback;
}

export function getCustomerOrderFlowerCurrencyRewardReleaseRewards(mask) {
  const normalizedMask = normalizeCustomerOrderFlowerCurrencyRewardReleaseMask(mask);
  return CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD_VALUES.filter(
    (reward) => (normalizedMask & (1 << (reward - 1))) !== 0,
  );
}

function applyFlowerCurrencySelection(orders, options = {}) {
  const suppliedHistory = options.customerOrderFlowerCurrencyHistory;
  const history = suppliedHistory
    ? {
      available: suppliedHistory.available !== false,
      accountId: suppliedHistory.accountId ?? null,
      historicalMaxReward: toNumber(suppliedHistory.historicalMaxReward, null),
      sourceStatus: suppliedHistory.sourceStatus || "unknown",
      recordStatus: suppliedHistory.recordStatus || "unknown",
      historyPath: suppliedHistory.historyPath || null,
    }
    : options.requireCustomerOrderFlowerCurrencyHistory === true
      ? {
        available: false,
        accountId: null,
        historicalMaxReward: null,
        sourceStatus: "unavailable",
        recordStatus: "history-unavailable",
        historyPath: null,
      }
      : {
        available: true,
        accountId: null,
        historicalMaxReward: null,
        sourceStatus: "not-loaded",
        recordStatus: "not-loaded",
        historyPath: null,
      };
  const releaseMask = normalizeCustomerOrderFlowerCurrencyRewardReleaseMask(
    options.customerOrderFlowerCurrencyRewardReleaseMask,
  );
  const releaseRewards = getCustomerOrderFlowerCurrencyRewardReleaseRewards(releaseMask);
  const selection = {
    itemId: FLOWER_CURRENCY_ITEM_ID,
    itemName: itemName(FLOWER_CURRENCY_ITEM_ID, options.itemNameMap || {}),
    sourcePath: "c_item[1002].id + c_flowerArt[artId].cPrice * order.num",
    releaseMask,
    releaseRewards,
    releaseValues: [...CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD_VALUES],
    historicalMaxReward: history.historicalMaxReward,
    historyAvailable: history.available,
    historyEnforced: false,
    historyUsedForDecision: false,
    historySourceStatus: history.sourceStatus,
    historyRecordStatus: history.recordStatus,
    historyAccountId: history.accountId,
    historyPath: history.historyPath,
    maxReward: null,
    highestRewardOrderCount: 0,
    eligibleOrderCount: 0,
    eligibleNpcIds: [],
    priorityRejectNpcIds: [],
    priorityRejectSuppressedReason: null,
    selectedNpcId: null,
    status: orders.length ? "unknown" : "no-orders",
    reason: orders.length ? "flower-currency-selection-not-ready" : "no-customer-orders",
  };

  const setDecision = (order, decision, decisionText) => {
    order.flowerCurrencyDecision = decision;
    order.flowerCurrencyDecisionText = decisionText;
  };

  if (!orders.length) return selection;

  const unknownOrders = orders.filter((order) => (
    order.flowerCurrencyRewardKnown !== true
    || !Number.isFinite(Number(order.flowerCurrencyReward))
  ));
  if (unknownOrders.length) {
    selection.status = "unknown";
    selection.reason = "flower-currency-reward-unknown";
    for (const order of orders) {
      setDecision(order, "fail-closed-unknown-reward", "跳过：花坊币收益未知，保持待处理");
      order.actionText = "跳过：花坊币收益未知，保持待处理";
      order.canFinish = false;
      order.canMakeArt = false;
    }
    return selection;
  }

  const knownRewards = orders.map((order) => Number(order.flowerCurrencyReward));
  selection.maxReward = Math.max(...knownRewards);
  selection.highestRewardOrderCount = knownRewards.filter(
    (reward) => reward === selection.maxReward,
  ).length;
  if (releaseMask === 0) {
    selection.status = "release-disabled";
    selection.reason = "customer-order-flower-currency-release-disabled";
    for (const order of orders) {
      setDecision(order, "fail-closed-release-disabled", "跳过：顾客订单花坊币收益放行列表为空，保持待处理");
      order.actionText = "跳过：顾客订单花坊币收益放行列表为空，保持待处理";
      order.canFinish = false;
      order.canMakeArt = false;
    }
    return selection;
  }

  const selectedOrders = orders.filter((order) => (
    releaseRewards.includes(Number(order.flowerCurrencyReward))
  ));
  const unselectedOrders = orders.filter((order) => !selectedOrders.includes(order));
  const selectionDataUnknown = (order) => (
    ["invalid", "waiting-art-sync", "missing-recipe"].includes(order.status)
    || (order.status === "inactive-art" && order.artActivationKnown !== true)
  );
  const unselectedDataUnknownOrders = unselectedOrders.filter(selectionDataUnknown);
  const rejectableUnselectedOrders = unselectedOrders.filter(
    (order) => !selectionDataUnknown(order),
  );
  selection.status = "ready";
  selection.reason = "customer-order-flower-currency-release-list";
  selection.eligibleOrderCount = selectedOrders.length;
  selection.eligibleNpcIds = selectedOrders.map((order) => order.npcId);
  selection.selectedNpcId = selectedOrders[0]?.npcId ?? null;

  for (const order of selectedOrders) {
    setDecision(
      order,
      "selected-reward",
      `花坊币收益 ${order.flowerCurrencyReward} 在当前放行列表（${releaseRewards.join("、")}）中，按既有库存/制作规则处理`,
    );
  }
  for (const order of unselectedDataUnknownOrders) {
    setDecision(order, "fail-closed-order-data-unknown", "跳过：顾客订单数据或花艺配置不足，保持待处理");
    order.actionText = "跳过：顾客订单数据或花艺配置不足，保持待处理";
    order.canFinish = false;
    order.canMakeArt = false;
  }
  for (const order of rejectableUnselectedOrders) {
    order.flowerCurrencyOriginalStatus = order.status;
    order.flowerCurrencyOriginalStatusText = order.statusText;
    order.status = "temporary-out-of-stock";
    order.statusText = "暂时没货";
    order.actionText = `暂时没货：收益 ${order.flowerCurrencyReward} 未在当前放行列表（1/2/3）中，按官方按钮拒绝顾客订单`;
    order.canFinish = false;
    order.canMakeArt = false;
    setDecision(order, "not-selected-reward", "收益未在当前放行列表中，暂时没货：按官方按钮拒绝顾客订单");
  }

  const priorityOrders = selectedOrders.filter(
    (order) => order.customerOrderPriorityReject === true,
  );
  selection.priorityRejectNpcIds = priorityOrders.map((order) => order.npcId);
  for (const order of priorityOrders) {
    order.flowerCurrencyOriginalStatus = order.status;
    order.flowerCurrencyOriginalStatusText = order.statusText;
    order.status = "temporary-out-of-stock";
    order.statusText = "暂时没货";
    order.actionText = `暂时没货：${order.customerOrderPriorityRejectReasonText}，按官方按钮拒绝顾客订单`;
    order.canFinish = false;
    order.canMakeArt = false;
    setDecision(order, "temporary-out-of-stock", `${order.customerOrderPriorityRejectReasonText}，暂时没货：按官方按钮拒绝顾客订单`);
  }
  return selection;
}

export function summarizeOrderCustomerStatus(sync, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const nameMap = options.nameMap || {};
  const itemNameMap = safeLoadItemNameMap(options);
  const bag = Object.hasOwn(options, "bag") ? options.bag || {} : getBag(sync);
  const bagSnapshotKnown = options.bagSnapshotKnown
    ?? (Object.hasOwn(options, "bag") || hasBagSnapshot(sync));
  const cultivateMap = options.cultivateMap || getCultivateMap(sync);
  const flowerArtConfig = safeLoadFlowerArtConfig(options);
  const orderMap = getCustomerOrderMap(sync);
  const doubleGoldGate = customerDoubleGoldGate(sync, { ...options, nowMs });
  const flowerArtActivation = getFlowerArtActivation(sync);
  const normalizedOrders = Object.entries(orderMap || {})
    .filter(([, order]) => order && typeof order === "object" && Object.keys(order).length > 0)
    .map(([npcId, order]) => normalizeCustomerOrder(order, npcId, {
      nameMap,
      itemNameMap,
      bag,
      bagSnapshotKnown,
      cultivateMap,
      flowerArtConfig,
      flowerArtActivation,
      doubleGoldGate,
    }));
  const flowerCurrencySelection = applyFlowerCurrencySelection(normalizedOrders, {
    itemNameMap,
    customerOrderFlowerCurrencyRewardReleaseMask:
      options.customerOrderFlowerCurrencyRewardReleaseMask,
    customerOrderFlowerCurrencyHistory: options.customerOrderFlowerCurrencyHistory,
    requireCustomerOrderFlowerCurrencyHistory: options.requireCustomerOrderFlowerCurrencyHistory,
  });
  const dailyLimit = getCustomerOrderDailyLimitStatus(sync, {
    ...options,
    nowMs,
    orderCustomerNpcConfig: safeLoadOrderCustomerNpcConfig(options),
  });
  const orders = normalizedOrders
    .sort((a, b) => {
      const priority = {
        ready: 1,
        "make-art-ready": 2,
        "temporary-out-of-stock": 3,
        "waiting-art-sync": 4,
        "inactive-art": 5,
        "waiting-double-gold": 6,
      };
      return (priority[a.status] || 9) - (priority[b.status] || 9) || a.npcId - b.npcId;
    });
  const actionableStatuses = new Set(["ready", "make-art-ready", "temporary-out-of-stock"]);
  const pendingWaitCount = orders.filter((order) => !actionableStatuses.has(order.status)).length;

  return {
    kind: "customer",
    kindText: ORDER_CUSTOMER_KIND_TEXT,
    sourcePath: "orderCustomerTot.orderCustomer.orderMap",
    exists: orders.length > 0,
    doubleGoldGate,
    dailyLimit,
    flowerCurrencySelection,
    customerOrderFlowerCurrencyHistory: options.customerOrderFlowerCurrencyHistory || null,
    total: orders.length,
    readyCount: orders.filter((order) => order.status === "ready").length,
    makeArtReadyCount: orders.filter((order) => order.status === "make-art-ready").length,
    waitingArtSyncCount: orders.filter((order) => order.status === "waiting-art-sync").length,
    temporaryOutOfStockCount: orders.filter((order) => order.status === "temporary-out-of-stock").length,
    inactiveArtCount: orders.filter((order) => order.status === "inactive-art").length,
    pendingWaitCount,
    skippedCount: orders.filter((order) => !order.canFinish).length,
    config: {
      sourcePath: flowerArtConfig.sourcePath || null,
      customerNeedNum: flowerArtConfig.customerNeedNum ?? null,
      customerMax: flowerArtConfig.customerMax ?? null,
      customerCreateCd: flowerArtConfig.customerCreateCd ?? null,
      customerCreateNum: flowerArtConfig.customerCreateNum ?? null,
      flowerCurrencyItemId: FLOWER_CURRENCY_ITEM_ID,
      flowerCurrencyItemName: itemName(FLOWER_CURRENCY_ITEM_ID, itemNameMap),
      flowerCurrencySourcePath: "c_item[1002].id + c_flowerArt[artId].cPrice * order.num",
      flowerCurrencyRewardValues: [...CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD_VALUES],
      flowerCurrencyRewardReleaseMask: flowerCurrencySelection.releaseMask,
      flowerCurrencyRewardReleaseValues: flowerCurrencySelection.releaseRewards,
      artActivationKnown: flowerArtActivation.known,
      artActivationSource: flowerArtActivation.sourcePath,
      activeArtCount: flowerArtActivation.activeCount,
    },
    orders,
  };
}

export function getAutoSubmitOrderActions(orderStatus, options = {}) {
  const excludeKinds = new Set(options.excludeKinds || []);
  const teamOrderReady =
    orderStatus?.residentBoard?.teamOrderReady === true;
  const teamOrderTriggerDecisionReady =
    orderStatus?.residentBoard?.teamOrderTriggerDecisionReady === true;
  const readyActions = ["satin", "decorate"]
    .filter((kind) => !excludeKinds.has(kind))
    .map((kind) => {
      const status = orderStatus?.[kind];
      const def = SPECIAL_ORDER_DEFS[kind];
      if (!status?.canFinish || status.isVideo || !def?.iface) return null;
      return {
        kind,
        iface: def.iface,
        reason: "ready-non-video",
      };
    })
    .filter(Boolean);
  const ordinaryActions = getAutoSubmitOrdinaryResidentOrderActions(
    orderStatus,
    options.mainTaskStatus,
    options,
  );

  const residentBoardCount = orderStatus?.residentBoard?.completedCount;
  const currentCount = typeof residentBoardCount === "number"
    ? residentBoardCount
    : typeof residentBoardCount === "string" && residentBoardCount.trim() !== ""
      ? Number(residentBoardCount)
      : null;
  if (currentCount == null || !Number.isFinite(currentCount)) {
    return [];
  }

  if (!Number.isSafeInteger(currentCount) || currentCount < 0) return [];
  const nextTriggerCount = RESIDENT_BOARD_TEAM_TRIGGER_COUNTS.find((count) => currentCount < count);
  if (nextTriggerCount == null) {
    return [
      ...readyActions.map((action, index) => ({
      ...action,
      residentBoardTotalBefore: currentCount + index,
      residentBoardTotalAfter: currentCount + index + 1,
      residentBoardNextTeamTriggerCount: null,
      teamTriggerAvoided: false,
      })),
      ...ordinaryActions,
    ];
  }

  const allowedCount = Math.max(0, nextTriggerCount - currentCount - 1);
  const candidateActions = [...readyActions, ...ordinaryActions];
  if (
    allowedCount === 0
    && nextTriggerCount === currentCount + 1
    && (teamOrderTriggerDecisionReady || teamOrderReady)
    && typeof options.teamOrderCapability?.evaluateTrigger === "function"
  ) {
    for (const action of candidateActions) {
      let decision;
      try {
        decision = options.teamOrderCapability.evaluateTrigger(action);
      } catch (error) {
        decision = {
          blocked: true,
          forceTriggerProtectionEnabled: true,
          reason: "team-trigger-evaluation-failed",
          message: error?.message || String(error),
        };
      }
      if (decision?.blocked === false) {
        return [{
          ...action,
          residentBoardTotalBefore: currentCount,
          residentBoardTotalAfter: nextTriggerCount,
          residentBoardNextTeamTriggerCount: nextTriggerCount,
          teamTriggerAvoided: false,
          teamTriggerDecision: decision,
        }];
      }
    }
    return [];
  }
  if (teamOrderReady) {
    return [
      ...readyActions.map((action, index) => ({
        ...action,
        residentBoardTotalBefore: currentCount + index,
        residentBoardTotalAfter: currentCount + index + 1,
        residentBoardNextTeamTriggerCount: nextTriggerCount,
        teamTriggerAvoided: false,
      })),
      ...ordinaryActions,
    ];
  }
  const cappedActions = candidateActions.slice(0, allowedCount);
  const teamTriggerAvoided = candidateActions.length > cappedActions.length;
  return cappedActions.map((action, index) => ({
    ...action,
    residentBoardTotalBefore: currentCount + index,
    residentBoardTotalAfter: currentCount + index + 1,
    residentBoardNextTeamTriggerCount: nextTriggerCount,
    teamTriggerAvoided,
  }));
}

export function getAutoSubmitOrdinaryResidentOrderActions(orderStatus, _mainTaskStatus, options = {}) {
  const autoSubmitEnabled = options.autoSubmitEnabled === true
    || options.ordinaryAutoSubmitEnabled === true;
  if (!autoSubmitEnabled) return [];
  if (
    options.bypassSpecialOrderDailyLimit !== true
    && (!orderStatus?.satin?.dailyLimitReached || !orderStatus?.decorate?.dailyLimitReached)
  ) return [];

  const readyOrders = (orderStatus?.ordinary?.orders || [])
    .filter((order) => order.canFinish && !order.isVideo && order.boxId);
  return readyOrders.map((order) => ({
    kind: "ordinary",
    kindText: "普通居民订单",
    iface: ORDER_FLOWER_IFACES.finishOrder,
    args: { boxId: order.boxId },
    reason: "ordinary-resident-order-ready-non-video",
    boxId: order.boxId,
  }));
}

export function getAutoSubmitCustomerOrderActions(customerStatus, options = {}) {
  const selection = customerStatus?.flowerCurrencySelection;
  if (!selection) return [];
  if (selection.status === "release-disabled" || selection.status === "unknown" || selection.status === "no-orders") {
    return [];
  }
  const standardRejectAllowed = selection.status === "ready";
  const rejectActions = (customerStatus?.orders || [])
    .filter((order) => {
      if (order.status === "waiting-art-sync") return false;
      if (!order.flowerCurrencyRewardKnown) return false;
      const priorityReject = standardRejectAllowed && order.customerOrderPriorityReject === true;
      const standardReject = standardRejectAllowed
        && order.flowerCurrencyDecision === "not-selected-reward";
      return priorityReject || standardReject;
    })
    .map((order) => {
      const priorityReject = standardRejectAllowed && order.customerOrderPriorityReject === true;
      const action = {
        kind: "customer",
        npcId: order.npcId,
        artId: order.artId,
        reason: priorityReject
          ? `customer-order-confirmed-${order.customerOrderPriorityRejectReason}`
          : "customer-order-flower-currency-reward-not-selected",
        reasonText: order.actionText,
        finalizesOrder: true,
        steps: [
          {
            type: "rejectCustomerOrder",
            iface: ORDER_CUSTOMER_IFACES.rejectOrder,
            args: { npcId: order.npcId },
          },
        ],
      };
      if (priorityReject) {
        action.customerOrderPriorityReject = true;
        action.customerOrderPriorityRejectReason = order.customerOrderPriorityRejectReason;
      }
      return action;
    });
  if (selection.status !== "ready") return rejectActions;
  const eligibleNpcIds = new Set(
    Array.isArray(selection.eligibleNpcIds) && selection.eligibleNpcIds.length
      ? selection.eligibleNpcIds.map((npcId) => Number(npcId))
      : [selection.selectedNpcId].filter((npcId) => npcId != null).map((npcId) => Number(npcId)),
  );
  const selectedActions = (customerStatus?.orders || [])
    .filter((order) => (
      eligibleNpcIds.has(Number(order.npcId))
      && order.flowerCurrencyDecision === "selected-reward"
      && order.flowerCurrencyRewardKnown
      && order.canFinish
    ))
    .map((order) => {
      const steps = [];
      if (order.status === "make-art-ready") {
        return {
          kind: "customer",
          npcId: order.npcId,
          artId: order.artId,
          reason: "customer-flowers-ready-make-art",
          finalizesOrder: false,
          steps: [
            {
              type: "makeFlowerArt",
              iface: ORDER_CUSTOMER_IFACES.makeFlowerArt,
              args: {
                vaseId: order.vaseId,
                flowersIds: order.flowerIds,
                num: order.missingArt,
              },
            },
          ],
        };
      }
      steps.push({
        type: "finishCustomerOrder",
        iface: ORDER_CUSTOMER_IFACES.finishOrder,
        args: { npcId: order.npcId },
      });
      return {
        kind: "customer",
        npcId: order.npcId,
        artId: order.artId,
        reason: order.status === "make-art-ready"
          ? "customer-flowers-ready-make-art"
          : "customer-art-stock-ready",
        steps,
      };
    });
  return [...rejectActions, ...selectedActions];
}
