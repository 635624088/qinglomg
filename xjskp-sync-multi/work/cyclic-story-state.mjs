import fs from "node:fs";
import {
  decodeConfigRows,
  findConfigTable,
} from "./flower-level-config.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

export const CYCLIC_STORY_IFACES = {
  enter: "gs.actCyclicStory.enter",
  recvOrderRwd: "gs.actCyclicStory.recvOrderRwd",
};
export const CYCLIC_STORY_ACTIVITY_TYPE = 4003;
export const CYCLIC_STORY_SCORE_ITEM_ID = 1108;
export const CYCLIC_STORY_MAX_SUBMIT_PER_CYCLE = 3;

const CYCLIC_STORY_PHASE_ACTIVE = 2;
const DEFAULT_STATIC_CONFIG_PATH = getDefaultStaticConfigPath();
const CYCLIC_STORY_CONFIG_CACHE = new Map();

function toFiniteNumber(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toNonNegativeInteger(value, fallback = 0) {
  const number = toFiniteNumber(value, fallback);
  return number != null && number >= 0 ? Math.floor(number) : fallback;
}

function toTimeMs(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) return number > 0 && number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function getMapValue(map, key) {
  if (map instanceof Map) return map.get(key) ?? map.get(String(key)) ?? null;
  return map?.[key] ?? map?.[String(key)] ?? null;
}

function normalizeRowMap(value) {
  if (value instanceof Map) return new Map(value);
  if (Array.isArray(value)) {
    return new Map(value
      .map((row) => {
        const id = toFiniteNumber(row?.id);
        return id == null ? null : [id, row];
      })
      .filter(Boolean));
  }
  if (value && typeof value === "object") {
    return new Map(Object.entries(value).map(([key, row]) => [
      toFiniteNumber(row?.id) ?? toFiniteNumber(key) ?? key,
      row,
    ]));
  }
  return new Map();
}

function normalizeNumberMap(value) {
  if (value instanceof Map) {
    return new Map([...value.entries()].map(([key, number]) => [Number(key), toFiniteNumber(number, 1)]));
  }
  if (Array.isArray(value)) {
    return new Map(value
      .filter((pair) => Array.isArray(pair) && toFiniteNumber(pair[0]) != null)
      .map((pair) => [Number(pair[0]), toFiniteNumber(pair[1], 1)]));
  }
  if (value && typeof value === "object") {
    return new Map(Object.entries(value).map(([key, number]) => [Number(key), toFiniteNumber(number, 1)]));
  }
  return new Map();
}

function normalizeItemNames(value) {
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, rowOrName]) => [
      String(key),
      typeof rowOrName === "string" ? rowOrName : rowOrName?.name,
    ]));
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(value
      .filter((row) => toFiniteNumber(row?.id) != null)
      .map((row) => [String(row.id), row.name || `物品-${row.id}`]));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, rowOrName]) => [
      String(rowOrName?.id ?? key),
      typeof rowOrName === "string" ? rowOrName : rowOrName?.name || `物品-${key}`,
    ]));
  }
  return {};
}

function normalizeFlowers(value) {
  const rows = normalizeRowMap(value);
  return new Map([...rows.entries()].map(([id, row]) => [id, {
    ...row,
    id: toFiniteNumber(row?.id) ?? toFiniteNumber(id),
    name: row?.name || `花朵-${id}`,
    exp: toFiniteNumber(row?.exp),
  }]));
}

function normalizeOrders(value) {
  const rows = normalizeRowMap(value);
  return new Map([...rows.entries()]
    .filter(([id]) => Number(id) > 0)
    .map(([id, row]) => [Number(id), {
      ...row,
      id: Number(id),
      cost: toFiniteNumber(row?.cost),
      items: Array.isArray(row?.items) ? row.items : [],
    }]));
}

function normalizeCyclicStoryConfig(config = {}) {
  const globalsSource = config.globals || config.global || {};
  const items = normalizeRowMap(config.items || config.cItem);
  const itemNames = normalizeItemNames(config.itemNames || items);
  const flowers = normalizeFlowers(config.flowers || config.cFlower);
  for (const [flowerId, flower] of flowers.entries()) {
    if (!flower.name || flower.name === `花朵-${flowerId}`) {
      flower.name = itemNames[flowerId] || itemNames[String(flowerId)] || `花朵-${flowerId}`;
    }
  }
  return {
    orders: normalizeOrders(config.orders || config.actCyclicStory || config.rows),
    globals: {
      expOrderMax: toFiniteNumber(
        globalsSource.expOrderMax ?? globalsSource.$expValueMax ?? config.expOrderMax,
      ),
      expValue: toFiniteNumber(
        globalsSource.expValue ?? config.expValue,
        toFiniteNumber(globalsSource.$expValue, 0) / 10_000,
      ),
      goldValue: toFiniteNumber(
        globalsSource.goldValue ?? config.goldValue,
        toFiniteNumber(globalsSource.$goldValue, 0) / 10_000,
      ),
      qualityValue: normalizeNumberMap(
        globalsSource.qualityValue ?? globalsSource.$qualityValue ?? config.qualityValue,
      ),
    },
    flowers,
    items,
    itemNames,
    sourcePath: config.sourcePath || null,
  };
}

export function loadCyclicStoryConfig(configPath = DEFAULT_STATIC_CONFIG_PATH) {
  const cacheKey = String(configPath);
  if (CYCLIC_STORY_CONFIG_CACHE.has(cacheKey)) return CYCLIC_STORY_CONFIG_CACHE.get(cacheKey);
  if (!fs.existsSync(configPath)) {
    const empty = normalizeCyclicStoryConfig({ sourcePath: configPath });
    CYCLIC_STORY_CONFIG_CACHE.set(cacheKey, empty);
    return empty;
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const storyRows = decodeConfigRows(findConfigTable(raw, "c_actCyclicStory"), "c_actCyclicStory");
  const flowerRows = decodeConfigRows(findConfigTable(raw, "c_flower"), "c_flower");
  const itemRows = decodeConfigRows(findConfigTable(raw, "c_item"), "c_item");
  const globalRow = storyRows.find((row) => Number(row?.id) === -1) || {};
  const loaded = normalizeCyclicStoryConfig({
    orders: storyRows.filter((row) => Number(row?.id) > 0),
    globals: globalRow,
    flowers: flowerRows,
    items: itemRows,
    itemNames: itemRows,
    sourcePath: configPath,
  });
  CYCLIC_STORY_CONFIG_CACHE.set(cacheKey, loaded);
  return loaded;
}

function safeLoadConfig(options = {}) {
  if (Object.hasOwn(options, "cyclicStoryConfig")) {
    return normalizeCyclicStoryConfig(options.cyclicStoryConfig);
  }
  try {
    return loadCyclicStoryConfig(options.configPath || DEFAULT_STATIC_CONFIG_PATH);
  } catch {
    return normalizeCyclicStoryConfig();
  }
}

function activityValue(act, key) {
  return act?.[key] ?? act?.d?.[key] ?? null;
}

function resolveOfficialPhase(act, nowMs) {
  const bms = toTimeMs(activityValue(act, "bms"));
  const ems = toTimeMs(activityValue(act, "ems"));
  if (bms == null || ems == null) return null;
  const durationBefore = Math.max(0, toFiniteNumber(activityValue(act, "duration_before"), 0));
  const durationAfter = Math.max(0, toFiniteNumber(activityValue(act, "duration_after"), 0));
  const previewStartMs = bms - durationBefore;
  const exchangeEndMs = ems + durationAfter;
  const phase = nowMs < previewStartMs
    ? 0
    : nowMs < bms
      ? 1
      : nowMs < ems
        ? 2
        : nowMs < exchangeEndMs
          ? 3
          : 4;
  const phaseStartMs = phase === 0
    ? null
    : phase === 1
      ? previewStartMs
      : phase === 2
        ? bms
        : phase === 3
          ? ems
          : exchangeEndMs;
  const phaseEndMs = phase === 0
    ? previewStartMs
    : phase === 1
      ? bms
      : phase === 2
        ? ems
        : phase === 3
          ? exchangeEndMs
          : null;
  return {
    phase,
    phaseSource: "official-time",
    phaseStartMs,
    phaseEndMs,
    phaseRemainingMs: phaseEndMs == null ? 0 : Math.max(0, phaseEndMs - nowMs),
    bms,
    ems,
    durationBefore,
    durationAfter,
  };
}

function normalizePhase(act, nowMs) {
  const official = resolveOfficialPhase(act, nowMs);
  if (official) return official;
  for (const value of [act?.phase, act?.d?.phase]) {
    const phase = toFiniteNumber(value);
    if (phase != null) {
      return {
        phase,
        phaseSource: "explicit-phase",
        phaseStartMs: null,
        phaseEndMs: null,
        phaseRemainingMs: null,
        bms: null,
        ems: null,
        durationBefore: null,
        durationAfter: null,
      };
    }
  }
  return {
    phase: "unknown",
    phaseSource: "unknown",
    phaseStartMs: null,
    phaseEndMs: null,
    phaseRemainingMs: null,
    bms: null,
    ems: null,
    durationBefore: null,
    durationAfter: null,
  };
}

function activityType(act) {
  return toFiniteNumber(act?.tmpType)
    ?? toFiniteNumber(act?.tmpId)
    ?? toFiniteNumber(act?.d?.tmpType)
    ?? toFiniteNumber(act?.d?.tmpId);
}

function activityBatchId(act) {
  return toFiniteNumber(act?.batchId) ?? toFiniteNumber(act?.d?.batchId);
}

function activityTmpId(act) {
  return toFiniteNumber(act?.tmpId)
    ?? toFiniteNumber(act?.tmpType)
    ?? toFiniteNumber(act?.d?.tmpId)
    ?? toFiniteNumber(act?.d?.tmpType);
}

function selectActivity(syncValue, nowMs) {
  const map = syncValue?.actTot?.map;
  if (!map || typeof map !== "object") return { act: null, phase: "unknown", count: 0 };
  const candidates = Object.values(map)
    .filter((act) => act && typeof act === "object")
    .filter((act) => activityType(act) === CYCLIC_STORY_ACTIVITY_TYPE)
    .map((act) => ({ act, ...normalizePhase(act, nowMs) }));
  if (!candidates.length) return { act: null, phase: "unknown", count: 0 };
  const selected = candidates.find((entry) => entry.phase === CYCLIC_STORY_PHASE_ACTIVE) || candidates[0];
  return { ...selected, count: candidates.length };
}

function storyData(act) {
  return act?.ext?.cyclicStory || act?.d?.ext?.cyclicStory || null;
}

function getBag(syncValue) {
  const usrTot = syncValue?.$usrTot || {};
  const data = usrTot.data || usrTot.usr || {};
  return data.bag || data.itemMap || usrTot.bag || usrTot.itemMap || {};
}

function itemName(itemId, config) {
  return config.itemNames[itemId] || config.itemNames[String(itemId)] || `物品-${itemId}`;
}

function buildRewards(items, config, multiplier = 1) {
  const pairs = Array.isArray(items) ? items : [];
  const rewards = pairs.map((pair) => ({
    itemId: toFiniteNumber(pair?.[0]),
    name: itemName(toFiniteNumber(pair?.[0]), config),
    count: Math.ceil(toNonNegativeInteger(pair?.[1]) * multiplier),
  })).filter((row) => row.itemId != null);
  return {
    rewards,
    rewardText: rewards.map((row) => `${row.name}x${row.count}`).join("、"),
  };
}

function remainingText(remainingMs) {
  if (!(remainingMs > 0)) return "冷却已结束";
  const seconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}分${rest}秒` : `${rest}秒`;
}

function buildOrder(orderIdxRaw, info, context) {
  const { active, bag, config, expOrderNum, nowMs } = context;
  const orderIdx = toFiniteNumber(orderIdxRaw);
  const orderId = toFiniteNumber(info?.orderId, 1) || 1;
  const flowerId = toFiniteNumber(info?.flowerId);
  const validTimeMs = toTimeMs(info?.validTime);
  const cfg = config.orders.get(orderId) || null;
  const flower = flowerId != null ? getMapValue(config.flowers, flowerId) : null;
  const item = flowerId != null ? getMapValue(config.items, flowerId) : null;
  const cost = toFiniteNumber(cfg?.cost);
  const have = flowerId != null
    ? toNonNegativeInteger(bag[flowerId] ?? bag[String(flowerId)])
    : 0;
  const missing = cost == null ? null : Math.max(0, cost - have);
  const remainingMs = validTimeMs == null ? null : Math.max(0, validTimeMs - nowMs);
  const grantsExperience = config.globals.expOrderMax != null
    && expOrderNum < config.globals.expOrderMax;
  const expectedExperience = !grantsExperience
    ? 0
    : flower?.exp != null && cost != null && config.globals.expValue != null
      ? Math.ceil(flower.exp * cost * config.globals.expValue)
      : null;
  const expectedGold = flower?.gld != null && cost != null && config.globals.goldValue != null
    ? Math.ceil(flower.gld * cost * config.globals.goldValue)
    : null;
  const quality = toFiniteNumber(item?.color);
  const qualityRewardMultiplier = quality == null
    ? 1
    : config.globals.qualityValue.get(quality) ?? 1;

  let status = "unknown";
  if (orderIdx == null || !cfg || flowerId == null || cost == null || validTimeMs == null) {
    status = "unknown";
  } else if (remainingMs > 0) {
    status = "cooling";
  } else if (missing > 0) {
    status = "inventory-shortage";
  } else {
    status = "ready";
  }

  const { rewards, rewardText } = buildRewards(cfg?.items, config, qualityRewardMultiplier);
  const expectedRewardParts = [rewardText];
  if (expectedGold != null) expectedRewardParts.push(`金币x${expectedGold}`);
  if (expectedExperience != null && grantsExperience) expectedRewardParts.push(`经验x${expectedExperience}`);
  return {
    orderIdx,
    orderId,
    flowerId,
    flowerName: flower?.name || (flowerId != null ? `花朵-${flowerId}` : "未知花朵"),
    orderTime: info?.orderTime ?? null,
    orderTimeMs: toTimeMs(info?.orderTime),
    validTime: info?.validTime ?? null,
    validTimeMs,
    remainingMs,
    remainingText: remainingMs == null ? "时间未知" : remainingText(remainingMs),
    cost,
    have,
    missing,
    status,
    statusText: status === "ready"
      ? "可提交"
      : status === "cooling"
        ? `冷却中 ${remainingText(remainingMs)}`
        : status === "inventory-shortage"
          ? `缺少 ${missing}`
          : "状态未知",
    ready: active && status === "ready",
    quality,
    qualityRewardMultiplier,
    grantsExperience,
    expectedExperience,
    expectedGold,
    rewards,
    rewardText,
    expectedRewardText: expectedRewardParts.filter(Boolean).join("、"),
  };
}

export function summarizeCyclicStoryStatus(syncValue, options = {}) {
  const config = safeLoadConfig(options);
  const nowMs = toFiniteNumber(options.nowMs, Date.now());
  const selected = selectActivity(syncValue, nowMs);
  if (!selected.act) {
    return {
      exists: false,
      active: false,
      phase: "unknown",
      phaseSource: "unknown",
      reason: "unknown",
      reasonText: "活动ID不可用",
      batchId: null,
      tmpId: null,
      score: 0,
      scoreItemId: CYCLIC_STORY_SCORE_ITEM_ID,
      scoreItemName: itemName(CYCLIC_STORY_SCORE_ITEM_ID, config),
      expOrderNum: 0,
      expOrderMax: config.globals.expOrderMax,
      orders: [],
      pendingAutoSubmitActions: [],
      configSourcePath: config.sourcePath,
      activityCount: 0,
    };
  }

  const act = selected.act;
  const data = storyData(act) || {};
  const orderInfo = data.orderInfo && typeof data.orderInfo === "object" ? data.orderInfo : {};
  const phase = selected.phase;
  const active = phase === CYCLIC_STORY_PHASE_ACTIVE;
  const batchId = activityBatchId(act);
  const expOrderNum = toNonNegativeInteger(data.expOrderNum);
  const bag = getBag(syncValue);
  const orders = Object.entries(orderInfo)
    .map(([orderIdx, info]) => buildOrder(orderIdx, info, {
      active,
      bag,
      config,
      expOrderNum,
      nowMs,
    }))
    .sort((left, right) => Number(left.orderIdx) - Number(right.orderIdx));
  const phaseView = getPhaseView(phase);
  const status = {
    exists: true,
    active,
    phase,
    phaseSource: selected.phaseSource,
    phaseText: phaseView.phaseText,
    phaseStartMs: selected.phaseStartMs,
    phaseEndMs: selected.phaseEndMs,
    phaseRemainingMs: selected.phaseRemainingMs,
    bms: selected.bms,
    ems: selected.ems,
    durationBefore: selected.durationBefore,
    durationAfter: selected.durationAfter,
    recordStatus: toFiniteNumber(activityValue(act, "status")),
    reason: phaseView.reason,
    reasonText: phaseView.reasonText,
    batchId,
    tmpId: activityTmpId(act),
    score: toNonNegativeInteger(act.score ?? act.d?.score),
    scoreItemId: CYCLIC_STORY_SCORE_ITEM_ID,
    scoreItemName: itemName(CYCLIC_STORY_SCORE_ITEM_ID, config),
    expOrderNum,
    expOrderMax: config.globals.expOrderMax,
    onlyHighestExperienceOrder: isOnlyHighestExperienceOrderEnabled(options),
    orders,
    orderInfoSourcePath: act?.ext?.cyclicStory ? "ext.cyclicStory.orderInfo" : "d.ext.cyclicStory.orderInfo",
    configSourcePath: config.sourcePath,
    activityCount: selected.count,
  };
  status.pendingAutoSubmitActions = options.autoSubmitEnabled === false
    ? []
    : getAutoSubmitCyclicStoryActions(status, options);
  return status;
}

function getPhaseView(phase) {
  if (phase === 0) return {
    phaseText: "未开放（阶段0）",
    reason: "not-started",
    reasonText: "尚未进入预告期",
  };
  if (phase === 1) return {
    phaseText: "预告期（阶段1）",
    reason: "preview",
    reasonText: "预告期：活动尚未开始",
  };
  if (phase === 2) return {
    phaseText: "进行期（阶段2）",
    reason: "active",
    reasonText: "进行期：可提交订单",
  };
  if (phase === 3) return {
    phaseText: "兑换期（阶段3）",
    reason: "exchange",
    reasonText: "兑换期：订单提交已结束",
  };
  if (phase === 4) return {
    phaseText: "已结束（阶段4）",
    reason: "ended",
    reasonText: "活动已结束",
  };
  return {
    phaseText: "活动阶段未知",
    reason: "unknown",
    reasonText: "活动阶段未知",
  };
}

function isOnlyHighestExperienceOrderEnabled(options = {}) {
  return options.onlyHighestExperienceOrder === true
    || options.cyclicStoryOnlyHighestExperienceOrder === true;
}

function getOnlyHighestExperienceOrder(status) {
  const currentOrders = Array.isArray(status?.orders)
    ? status.orders.slice(0, 3)
    : [];
  if (currentOrders.length !== 3) return null;

  if (currentOrders.some((order) => (
    order?.orderIdx == null
    || !["ready", "inventory-shortage"].includes(order.status)
    || order.status === "cooling"
    || (order.remainingMs != null && order.remainingMs > 0)
    || !Number.isFinite(order.expectedExperience)
  ))) return null;

  return [...currentOrders].sort((left, right) => (
    Number(right.expectedExperience) - Number(left.expectedExperience)
    || Number(left.orderIdx) - Number(right.orderIdx)
  ))[0] || null;
}

export function getAutoSubmitCyclicStoryActions(status, options = {}) {
  if (!status?.active || status.phase !== CYCLIC_STORY_PHASE_ACTIVE || !status.batchId) return [];
  const onlyHighestExperienceOrder = isOnlyHighestExperienceOrderEnabled(options);
  const orders = onlyHighestExperienceOrder
    ? [getOnlyHighestExperienceOrder(status)].filter(Boolean).filter((order) => order.ready)
    : (status.orders || [])
      .filter((order) => order?.ready && order.orderIdx != null)
      .slice(0, CYCLIC_STORY_MAX_SUBMIT_PER_CYCLE);
  return orders
    .map((order) => ({
      kind: "cyclicStory",
      iface: CYCLIC_STORY_IFACES.recvOrderRwd,
      args: { batchId: status.batchId, orderIdx: order.orderIdx },
      batchId: status.batchId,
      orderIdx: order.orderIdx,
      orderId: order.orderId,
      flowerId: order.flowerId,
      flowerName: order.flowerName,
      cost: order.cost,
      have: order.have,
      expectedExperience: order.expectedExperience,
      rewardText: order.rewardText,
      reason: "cyclic-story-order-ready",
    }));
}
