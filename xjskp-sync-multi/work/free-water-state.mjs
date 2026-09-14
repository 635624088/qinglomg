import fs from "node:fs";
import {
  decodeConfigRows,
  findConfigTable,
} from "./flower-level-config.mjs";
import { getWaterDropStatus } from "./garden-state.mjs";
import { formatDateTime } from "./status-format.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

export const FREE_WATER_IFACES = {
  recv: "gs.freeWater.recv",
};

export const DEFAULT_FREE_WATER_THRESHOLD = 16;

const DEFAULT_STATIC_CONFIG_PATH = getDefaultStaticConfigPath();
const GAME_CFG_TABLE = "c_gameCfg";
const FALLBACK_TIME_PERIODS = [[11, 14], [17, 21]];
const FALLBACK_FREE_WATER_NUM = [7, 30];

const configCache = new Map();

function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseTimeMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function sameLocalDay(aMs, bMs) {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function normalizeTimePeriods(value) {
  const rawPeriods = Array.isArray(value) && value.length ? value : FALLBACK_TIME_PERIODS;
  const periods = [];
  for (const row of rawPeriods) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const startHour = toNumber(row[0], null);
    const endHour = toNumber(row[1], null);
    if (startHour == null || endHour == null) continue;
    periods.push([startHour, endHour]);
  }
  return periods.length ? periods : FALLBACK_TIME_PERIODS;
}

function normalizeFreeWaterNum(value) {
  const raw = Array.isArray(value) && value.length >= 2 ? value : FALLBACK_FREE_WATER_NUM;
  return [
    toNumber(raw[0], FALLBACK_FREE_WATER_NUM[0]),
    toNumber(raw[1], FALLBACK_FREE_WATER_NUM[1]),
  ];
}

function loadGameCfgMeta(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const table = findConfigTable(config, GAME_CFG_TABLE);
  const rows = decodeConfigRows(table, GAME_CFG_TABLE);
  return rows.find((row) => toNumber(row.id, 0) < 0) || rows[0] || {};
}

export function loadFreeWaterConfig(filePath = DEFAULT_STATIC_CONFIG_PATH) {
  const cacheKey = filePath;
  if (configCache.has(cacheKey)) return configCache.get(cacheKey);

  const meta = loadGameCfgMeta(filePath);
  const [itemId, receiveWaterDropCount] = normalizeFreeWaterNum(meta.$freeWaterNum);
  const loaded = {
    sourcePath: filePath,
    tableName: GAME_CFG_TABLE,
    timePeriods: normalizeTimePeriods(meta.$freeWaterTime),
    itemId,
    receiveWaterDropCount,
    patchCost: Array.isArray(meta.$freeWaterDmd) ? meta.$freeWaterDmd : [],
  };
  configCache.set(cacheKey, loaded);
  return loaded;
}

function safeLoadFreeWaterConfig(options = {}) {
  if (Object.hasOwn(options, "freeWaterConfig")) return options.freeWaterConfig || {};
  try {
    return loadFreeWaterConfig(options.freeWaterConfigPath || DEFAULT_STATIC_CONFIG_PATH);
  } catch {
    return {
      timePeriods: FALLBACK_TIME_PERIODS,
      itemId: FALLBACK_FREE_WATER_NUM[0],
      receiveWaterDropCount: FALLBACK_FREE_WATER_NUM[1],
      patchCost: [],
    };
  }
}

export function getFreeWaterState(sync) {
  return sync?.freeWater || sync?.freeWaterTot?.freeWater || {};
}

function normalizeRecvIdx(state, nowMs) {
  const raw = Array.isArray(state?.recvIdx) ? state.recvIdx : [];
  const rTimeMs = parseTimeMs(state?.rTime);
  if (rTimeMs != null && !sameLocalDay(rTimeMs, nowMs)) return [];
  return raw.map((item) => toNumber(item, null)).filter((item) => item != null);
}

function localDayHourMs(nowMs, hour) {
  const d = new Date(nowMs);
  d.setHours(Math.trunc(hour), Math.round((hour - Math.trunc(hour)) * 60), 0, 0);
  return d.getTime();
}

function buildSlots(timePeriods, recvIdx, nowMs, waterDropLow) {
  const received = new Set(recvIdx);
  return timePeriods.map((period, idx) => {
    const [startHour, endHour] = period;
    let startAtMs = localDayHourMs(nowMs, startHour);
    let endAtMs = localDayHourMs(nowMs, endHour);
    if (endAtMs <= startAtMs) {
      endAtMs += 24 * 60 * 60 * 1000;
      if (nowMs < endAtMs - 24 * 60 * 60 * 1000) startAtMs -= 24 * 60 * 60 * 1000;
    }
    const isReceived = received.has(idx);
    const inTimeWindow = nowMs > startAtMs && nowMs < endAtMs;
    const expired = nowMs >= endAtMs;
    const waiting = nowMs <= startAtMs;
    return {
      idx,
      receiveNo: idx + 1,
      timePeriod: [startHour, endHour],
      timeWindowText: `${startHour}:00-${endHour}:00`,
      startAtMs,
      endAtMs,
      startAtText: formatDateTime(startAtMs),
      endAtText: formatDateTime(endAtMs),
      received: isReceived,
      inTimeWindow,
      expired,
      waiting,
      canReceive: waterDropLow && inTimeWindow && !isReceived,
    };
  });
}

export function summarizeFreeWaterStatus(sync, options = {}) {
  const config = safeLoadFreeWaterConfig(options);
  const nowMs = options.nowMs ?? Date.now();
  const state = getFreeWaterState(sync);
  const waterDrop = getWaterDropStatus(sync, nowMs);
  const threshold = Math.max(0, toNumber(options.waterDropThreshold, DEFAULT_FREE_WATER_THRESHOLD));
  const plantWaterRefill = options.plantWaterRefill || null;
  const requiresPlantWaterRefill = Boolean(plantWaterRefill);
  const hasPlantWaterNeed = !requiresPlantWaterRefill || Boolean(plantWaterRefill.needsPlanting);
  const recvIdx = normalizeRecvIdx(state, nowMs);
  const timePeriods = normalizeTimePeriods(config.timePeriods);
  const waterDropLow = hasPlantWaterNeed && waterDrop.count < threshold;
  const slots = buildSlots(timePeriods, recvIdx, nowMs, waterDropLow);
  const pendingActions = slots
    .filter((slot) => slot.canReceive)
    .map((slot) => ({
      type: "recvFreeWater",
      iface: FREE_WATER_IFACES.recv,
      idx: slot.idx,
      args: { idx: slot.idx },
      receiveNo: slot.receiveNo,
      expectedItemId: toNumber(config.itemId, FALLBACK_FREE_WATER_NUM[0]),
      expectedWaterDropCount: toNumber(config.receiveWaterDropCount, FALLBACK_FREE_WATER_NUM[1]),
    }));
  const receivedCountToday = recvIdx.length;
  const maxDailyCount = timePeriods.length;
  const nextReceivable = slots.find((slot) => slot.canReceive) || null;
  const nextWaiting = slots.find((slot) => slot.waiting && !slot.received) || null;

  let reasonText = "可领取";
  if (!hasPlantWaterNeed) {
    reasonText = plantWaterRefill?.reasonText || "当前没有需要种植的土地组";
  } else if (!waterDropLow) {
    reasonText = `当前水滴 ${waterDrop.count} >= ${threshold}`;
  } else if (pendingActions.length) {
    reasonText = `可领取第 ${pendingActions[0].receiveNo} 次`;
  } else if (receivedCountToday >= maxDailyCount) {
    reasonText = `挑水工今日领取次数已达上限 ${maxDailyCount}`;
  } else if (nextWaiting) {
    reasonText = `等待 ${nextWaiting.timeWindowText}`;
  } else {
    reasonText = "当前没有可领取的挑水工时间段";
  }

  return {
    state,
    recvIdx,
    waterDrop,
    waterDropCount: waterDrop.count,
    waterDropText: `${waterDrop.count}/${waterDrop.displayLimit}`,
    threshold,
    waterDropLow,
    plantWaterRefill,
    itemId: toNumber(config.itemId, FALLBACK_FREE_WATER_NUM[0]),
    receiveWaterDropCount: toNumber(config.receiveWaterDropCount, FALLBACK_FREE_WATER_NUM[1]),
    timePeriods,
    slots,
    receivedCountToday,
    maxDailyCount,
    remainingReceiveCount: Math.max(0, maxDailyCount - receivedCountToday),
    canReceive: pendingActions.length > 0,
    nextReceiveIdx: nextReceivable?.idx ?? null,
    nextReceiveNo: nextReceivable?.receiveNo ?? null,
    pendingActions,
    patchCost: config.patchCost || [],
    reasonText,
  };
}
