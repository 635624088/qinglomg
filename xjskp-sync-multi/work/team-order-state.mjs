import fs from "node:fs";
import {
  decodeConfigRows,
  findConfigTable,
} from "./flower-level-config.mjs";
import { getBag } from "./garden-state.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

export const TEAM_ORDER_IFACES = Object.freeze({
  takeOrder: "gs.orderTeam.takeOrder",
  submitOrder: "gs.orderTeam.submitOrder",
  refreshOrder: "gs.orderTeam.refreshOrder",
  recvRwd: "gs.orderTeam.recvRwd",
  storeOrder: "gs.orderTeam.storeOrder",
  takeStoredOrder: "gs.orderTeam.takeStoredOrder",
});

export const TEAM_ORDER_SCHEMA_NAMES = Object.freeze({
  takeOrder: "G.GS.orderTeamIface.IArg_takeOrder",
  submitOrder: "G.GS.orderTeamIface.IArg_submitOrder",
  refreshOrder: "G.GS.orderTeamIface.IArg_refreshOrder",
  recvRwd: "G.GS.orderTeamIface.IArg_recvRwd",
  storeOrder: "G.GS.orderTeamIface.IArg_storeOrder",
  takeStoredOrder: "G.GS.orderTeamIface.IArg_takeStoredOrder",
});

const TEAM_ORDER_REFRESH_ONLY_FLOWER_NAMES = new Set([
  "曼珠沙华",
  "伯利恒之星",
]);

export function shouldRefreshProtectedTeamOrderFlower(flowerName) {
  return TEAM_ORDER_REFRESH_ONLY_FLOWER_NAMES.has(flowerName);
}

function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toTimeMs(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const timeMs = value.getTime();
    return Number.isFinite(timeMs) ? timeMs : null;
  }

  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : null;
  if (Number.isFinite(numeric)) {
    // Current Unix timestamps in seconds are 10 digits; short test values remain milliseconds.
    return Math.abs(numeric) >= 1_000_000_000 && Math.abs(numeric) < 100_000_000_000
      ? numeric * 1000
      : numeric;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getStoredOrderExpireTime(order) {
  return order?.expireTime ?? order?.eTime ?? order?.endTime ?? null;
}

export function loadTeamOrderConfig(filePath = getDefaultStaticConfigPath()) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const rows = decodeConfigRows(findConfigTable(raw, "c_orderTeam"), "c_orderTeam");
  let monthCardRows = [];
  try {
    monthCardRows = decodeConfigRows(
      findConfigTable(raw, "c_monthCard"),
      "c_monthCard",
    );
  } catch {
    // Older isolated fixtures can omit c_monthCard; client-equivalent default
    // is no noble experience bonus.
  }
  const globals = rows.find((row) => Number(row.id) === -1);
  const monthCardGlobals =
    monthCardRows.find((row) => Number(row.id) === -1) || {};
  const orders = new Map(
    rows
      .filter((row) => Number(row.id) > 0)
      .map((row) => [Number(row.id), {
        orderNum: Number(row.id),
        flowerNum: Number(row.flowerNum),
        magnification: Number(row.magnification),
        magnificationShow: row.magnificationShow || null,
      }]),
  );

  return {
    sourcePath: filePath,
    triggerCounts: globals.$orderNeed.map(Number),
    durationSeconds: Number(globals.$orderTeamTime),
    maxOrderNum: Number(globals.$orderMax),
    refreshPerSecond: Number(globals.$orderMaxSecond),
    storeSeconds: Number(globals.$storeTime),
    paidRenewCost: globals.$orderTeamBuyCost,
    rewardBase: globals.$orderRwdBase,
    nobleExpAdd: toNumber(monthCardGlobals.$expAdd) / 10_000,
    orders,
  };
}

export function getTeamOrderNobleExpAdd(
  syncValue,
  config,
  options = {},
) {
  const card =
    syncValue?.rchgTot?.cardMap?.[1]
    ?? syncValue?.rchgTot?.cardMap?.["1"]
    ?? null;
  if (!card) return 0;
  const nowMs = options.nowMs ?? Date.now();
  const invalidTimeMs = toTimeMs(card.invalidTime);
  const valid = Boolean(card.isMain)
    || (invalidTimeMs != null && invalidTimeMs > nowMs);
  return valid ? toNumber(config?.nobleExpAdd) : 0;
}

export function summarizeTeamOrder(syncValue, options = {}) {
  const config = options.config || loadTeamOrderConfig(options.configPath);
  const nowMs = options.nowMs ?? Date.now();
  const order = syncValue?.orderTeamTot?.orderTeam || null;
  const rawStatus = toNumber(order?.status, 0);
  const startTimeMs = toTimeMs(order?.startTime);
  const durationMs = Math.max(0, toNumber(config?.durationSeconds) * 1000);
  const expiresAtMs = startTimeMs != null && durationMs ? startTimeMs + durationMs : null;
  const expiredByServerTime = rawStatus === 2
    && expiresAtMs != null
    && nowMs > expiresAtMs;
  const effectiveStatus = expiredByServerTime ? 3 : rawStatus;
  const orderNum = toNumber(order?.orderNum, null);
  const flowerId = toNumber(order?.flowerId, null);
  const orderConfig = orderNum == null ? null : config?.orders?.get(orderNum) || null;
  const flowerNames = options.flowerNames || options.nameMap || {};
  const bag = getBag(syncValue);
  const have = flowerId == null ? null : toNumber(bag[flowerId] ?? bag[String(flowerId)]);
  const need = orderConfig?.flowerNum ?? null;

  return {
    kind: "team-order",
    sourcePath: "orderTeamTot.orderTeam",
    exists: Boolean(order),
    status: rawStatus,
    effectiveStatus,
    expiredByServerTime,
    startTime: order?.startTime ?? null,
    startTimeMs,
    expiresAtMs,
    expiresAt: expiresAtMs == null ? null : new Date(expiresAtMs).toISOString(),
    remainingMs: expiresAtMs == null ? null : Math.max(0, expiresAtMs - nowMs),
    orderNum,
    flowerId,
    flowerName: flowerId == null ? null : flowerNames[flowerId] ?? flowerNames[String(flowerId)] ?? null,
    need,
    have,
    missing: need == null || have == null ? null : Math.max(0, need - have),
    canSubmit: effectiveStatus === 2 && need != null && have >= need,
  };
}

export function selectEarliestStoredOrder(storedOrders, nowMs = Date.now()) {
  const validRows = (Array.isArray(storedOrders) ? storedOrders : Object.values(storedOrders || {}))
    .map((order) => ({ order, expiresAtMs: toTimeMs(getStoredOrderExpireTime(order)) }))
    .filter(({ expiresAtMs }) => expiresAtMs > nowMs)
    .sort((left, right) => left.expiresAtMs - right.expiresAtMs);
  return validRows[0]?.order || null;
}

export function calculateTeamOrderReward(order, config, options = {}) {
  const orderNum = toNumber(order?.orderNum, null);
  const row = orderNum == null ? null : config?.orders?.get(orderNum) || null;
  const magnification = toNumber(row?.magnification, null);
  const multiplier = magnification == null ? null : magnification / 100;
  const rewardBase = Object.fromEntries(
    (Array.isArray(config?.rewardBase) ? config.rewardBase : [])
      .filter((entry) => Array.isArray(entry) && entry.length >= 2)
      .map(([itemId, count]) => [Number(itemId), toNumber(count)]),
  );
  const base = {
    2: toNumber(rewardBase[2]),
    11: toNumber(rewardBase[11]),
  };
  const bonus = {
    2: toNumber(order?.rwd?.[2] ?? order?.rwd?.["2"]),
    11: toNumber(order?.rwd?.[11] ?? order?.rwd?.["11"]),
  };
  const nobleExpAdd = options.nobleExpAdd == null
    ? null
    : toNumber(options.nobleExpAdd, null);
  const displayedGold = multiplier == null
    ? null
    : Math.round((base[11] + bonus[11]) * multiplier);
  const displayedExp = multiplier == null || nobleExpAdd == null
    ? null
    : Math.round(
        Math.round((base[2] + bonus[2]) * (1 + nobleExpAdd))
        * multiplier,
      );

  return {
    orderNum,
    multiplier,
    magnification,
    base,
    bonus,
    nobleExpAdd,
    displayed: {
      2: displayedExp,
      11: displayedGold,
    },
  };
}

export function evaluateTeamOrderCapability(syncValue, config, options = {}) {
  const schemas = options.schemas || {};
  const order = syncValue?.orderTeamTot?.orderTeam;
  const configReady = config?.orders instanceof Map
    && config.orders.size === 160
    && config.durationSeconds === 50
    && config.maxOrderNum === 160
    && config.refreshPerSecond === 4;
  const statusReady = order == null
    || [0, 1, 2, 3].includes(Number(order.status || 0));
  const activeFieldsReady = Number(order?.status) !== 2
    || (Number(order.orderNum) > 0 && Number(order.flowerId) > 0 && order.startTime != null);
  const interfacesReady = Object.values(TEAM_ORDER_SCHEMA_NAMES)
    .every((name) => Object.hasOwn(schemas, name));
  const takeOrderSchema = schemas[TEAM_ORDER_SCHEMA_NAMES.takeOrder] || {};
  const takeStoredOrderSchema = schemas[TEAM_ORDER_SCHEMA_NAMES.takeStoredOrder] || {};
  const argsReady = Object.hasOwn(takeOrderSchema, "isAgree")
    && Object.hasOwn(takeOrderSchema, "isCost")
    && Object.hasOwn(takeStoredOrderSchema, "npcId");

  return {
    ready: Boolean(configReady && statusReady && activeFieldsReady && interfacesReady && argsReady),
    realValidated: false,
    configReady,
    statusReady,
    activeFieldsReady,
    interfacesReady,
    argsReady,
  };
}
