import fs from "node:fs";

import {
  decodeConfigRows,
  findConfigTable,
} from "./flower-level-config.mjs";
import { getItemCount } from "./garden-state.mjs";
import { formatDateTime, formatDuration } from "./status-format.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

export const PEARL_IFACES = {
  recvDailyFree: "gs.pearl.recvDailyFree",
  getRecommendList: "gs.pearl.getRecommendList",
  getHireStateByUids: "gs.pearl.getHireStateByUids",
  refresh: "gs.pearl.refresh",
  hire: "gs.pearlPlace.hire",
  recv: "gs.pearlPlace.recv",
  recvOneKey: "gs.pearlPlace.recvOneKey",
};

export const DEFAULT_PEARL_HIRE_ITEM_RESERVE_COUNT = 100;

const DEFAULT_PEARL_CONFIG_PATH = getDefaultStaticConfigPath();
const pearlConfigCache = new Map();

function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveNumber(value, fallback = null) {
  const n = toNumber(value, fallback);
  return n > 0 ? n : fallback;
}

function toTimeMs(value) {
  if (value == null || value === "") return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function sameLocalDayMs(leftMs, rightMs) {
  if (!leftMs || !rightMs) return false;
  const left = new Date(leftMs);
  const right = new Date(rightMs);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function normalizeUidList(value) {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value)
      : [];
  return raw
    .map((item) => item && typeof item === "object" ? findPlayerUid(item) : toNumber(item, null))
    .filter((item) => item != null && item > 0);
}

const PLAYER_NAME_KEYS = [
  "nickName",
  "nickname",
  "nick",
  "name",
  "userName",
  "playerName",
  "displayName",
  "laborNickName",
  "laborNickname",
  "laborName",
  "laborUserName",
];
const PLAYER_UID_KEYS = ["uid", "userId", "playerId", "id", "dstUid", "laborUid"];
const PLAYER_NESTED_KEYS = ["user", "userInfo", "player", "playerInfo", "profile", "labor", "laborInfo"];

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function looksLikeTimeOrNumericString(value) {
  const text = nonEmptyString(value);
  if (!text) return true;
  if (/^\d+$/.test(text)) return true;
  return Number.isFinite(Date.parse(text));
}

function findPlayerName(raw, depth = 0) {
  if (!raw || typeof raw !== "object" || depth > 2) return null;
  for (const key of PLAYER_NAME_KEYS) {
    const name = nonEmptyString(raw[key]);
    if (name) return name;
  }
  for (const key of PLAYER_NESTED_KEYS) {
    const name = findPlayerName(raw[key], depth + 1);
    if (name) return name;
  }
  return null;
}

function findPlayerUid(raw) {
  if (!raw || typeof raw !== "object") return null;
  for (const key of PLAYER_UID_KEYS) {
    const uid = toNumber(raw[key], null);
    if (uid != null && uid > 0) return uid;
  }
  for (const key of PLAYER_NESTED_KEYS) {
    const uid = findPlayerUid(raw[key]);
    if (uid != null && uid > 0) return uid;
  }
  return null;
}

function addPlayerName(playerNames, uidValue, raw) {
  const uid = toNumber(uidValue, null);
  if (uid == null || uid <= 0) return;
  const name = typeof raw === "string"
    ? looksLikeTimeOrNumericString(raw) ? null : nonEmptyString(raw)
    : findPlayerName(raw);
  if (name && !playerNames.has(uid)) playerNames.set(uid, name);
}

function collectPlayerNamesFromSource(playerNames, source) {
  if (!source) return;
  if (Array.isArray(source)) {
    for (const item of source) {
      if (item && typeof item === "object") addPlayerName(playerNames, findPlayerUid(item), item);
    }
    return;
  }
  if (typeof source !== "object") return;
  for (const [key, value] of Object.entries(source)) {
    addPlayerName(playerNames, key, value);
    if (value && typeof value === "object") addPlayerName(playerNames, findPlayerUid(value), value);
  }
}

function buildPearlPlayerNameMap(pearlTot) {
  const playerNames = new Map();
  for (const place of Object.values(pearlTot?.placeMap || {})) {
    if (place && typeof place === "object") addPlayerName(playerNames, place.laborUid, place);
  }
  for (const key of [
    "otherHireMap",
    "recommendMap",
    "recommendUserMap",
    "userMap",
    "userInfoMap",
    "playerMap",
    "hireUserMap",
    "laborMap",
    "laborUserMap",
    "recommendList",
    "mHireLogList",
    "dHireLogList",
  ]) {
    collectPlayerNamesFromSource(playerNames, pearlTot?.[key]);
  }
  return playerNames;
}

function makePearlConfig({ pearlRows = [], pearlEventRows = [], sourcePath = DEFAULT_PEARL_CONFIG_PATH } = {}) {
  const pearlGlobals = pearlRows.find((row) => Number(row.id) === -1) || {};
  const pearlEventGlobals = pearlEventRows.find((row) => Number(row.id) === -1) || {};
  const places = {};

  for (const row of pearlRows) {
    const id = toNumber(row.id, null);
    if (id != null && id > 0) places[id] = { ...row, id };
  }

  return {
    sourcePath,
    hireItemId: positiveNumber(pearlGlobals.$hireItem, null),
    dailyFree: Array.isArray(pearlGlobals.$dailyFree) ? pearlGlobals.$dailyFree : null,
    pearlItemId: positiveNumber(pearlEventGlobals.$pearlId, null),
    hireTimeSeconds: positiveNumber(pearlGlobals.$hireTime, null),
    restTimeSeconds: positiveNumber(pearlGlobals.$restTime, 0),
    gatherCdSeconds: positiveNumber(pearlEventGlobals.$gatherCd, null),
    manyNum: positiveNumber(pearlGlobals.$manyNum, null),
    hireDefGld: pearlGlobals.$hireDefGld || null,
    placeMax: positiveNumber(pearlGlobals.$placeMax, null),
    places,
  };
}

function withEnvOverrides(config) {
  return {
    ...config,
    hireItemId: positiveNumber(process.env.PEARL_HIRE_ITEM_ID, config.hireItemId),
    hireTimeSeconds: positiveNumber(process.env.PEARL_HIRE_TIME_SECONDS, config.hireTimeSeconds),
    restTimeSeconds: positiveNumber(process.env.PEARL_REST_TIME_SECONDS, config.restTimeSeconds ?? 0),
    gatherCdSeconds: positiveNumber(process.env.PEARL_GATHER_CD_SECONDS, config.gatherCdSeconds),
  };
}

export function loadPearlConfig(configPath = DEFAULT_PEARL_CONFIG_PATH) {
  let config = pearlConfigCache.get(configPath);
  if (!config) {
    if (!fs.existsSync(configPath)) {
      config = makePearlConfig({ sourcePath: configPath });
    } else {
      const raw = fs.readFileSync(configPath, "utf8");
      const staticConfig = JSON.parse(raw);
      config = makePearlConfig({
        pearlRows: decodeConfigRows(findConfigTable(staticConfig, "c_pearl"), "c_pearl"),
        pearlEventRows: decodeConfigRows(findConfigTable(staticConfig, "c_pearlEvent"), "c_pearlEvent"),
        sourcePath: configPath,
      });
    }
    pearlConfigCache.set(configPath, config);
  }
  return withEnvOverrides(config);
}

function calcCanRecvNum(place, nowMs, config) {
  const hireTimeMs = positiveNumber(config.hireTimeSeconds, null) == null ? null : config.hireTimeSeconds * 1000;
  const gatherCdMs = positiveNumber(config.gatherCdSeconds, null) == null ? null : config.gatherCdSeconds * 1000;
  const laborEndMs = toTimeMs(place?.laborEndTime);
  const everyMakeNum = toNumber(place?.everyMakeNum);
  const recvCnt = toNumber(place?.recvCnt);
  const surplusRecvNum = toNumber(place?.surplusRecvNum);

  if (!laborEndMs || !hireTimeMs || !gatherCdMs || !everyMakeNum) return Math.max(0, surplusRecvNum);

  const laborStartMs = laborEndMs - hireTimeMs;
  const effectiveMs = Math.min(nowMs, laborEndMs);
  const elapsedMs = Math.max(0, effectiveMs - laborStartMs);
  const generatedTicks = Math.floor(elapsedMs / gatherCdMs);
  const unreceivedTicks = Math.max(0, generatedTicks - recvCnt);
  return unreceivedTicks * everyMakeNum + Math.max(0, surplusRecvNum);
}

function isExplicitEmptyPearlPlace(place) {
  if (!place || typeof place !== "object") return false;
  return toNumber(place.eventId, null) === 0
    && toNumber(place.everyMakeNum, null) === 0
    && toNumber(place.recvCnt, null) === 0
    && toNumber(place.surplusRecvNum, null) === 0;
}

function summarizePearlPlace(placeId, place, nowMs, config, playerNames = new Map()) {
  if (!place) {
    return {
      placeId,
      exists: false,
      state: "locked",
      stateText: "未解锁",
      canHire: false,
      laborUid: null,
      laborNickname: null,
      laborDisplayText: "-",
      laborEndTime: null,
      laborEndTimeMs: null,
      laborEndTimeText: "-",
      remainingMs: null,
      remainingText: "-",
      restRemainingMs: null,
      restRemainingText: "-",
      everyMakeNum: null,
      recvCnt: null,
      surplusRecvNum: null,
      canRecvNum: 0,
      totalRecvNum: null,
      remainRecvNum: null,
      hireFailCnt: null,
      eventId: null,
    };
  }

  const placeConfig = config?.places?.[placeId] || config?.places?.[String(placeId)] || {};
  const explicitEmpty = isExplicitEmptyPearlPlace(place);
  const laborEndTimeMs = toTimeMs(place.laborEndTime);
  const restTimeMs = Math.max(0, toNumber(config.restTimeSeconds) * 1000);
  const working = !explicitEmpty && Boolean(laborEndTimeMs && laborEndTimeMs > nowMs);
  const resting = !explicitEmpty && Boolean(!working && laborEndTimeMs && restTimeMs && nowMs < laborEndTimeMs + restTimeMs);
  const laborUidNumber = toNumber(place.laborUid, null);
  const hasLaborUid = laborUidNumber != null && laborUidNumber > 0;
  const effectiveHasLaborUid = !explicitEmpty && hasLaborUid;
  const lockedByMonthlyCard = Boolean(placeConfig.mCardUnlock) && !working && !effectiveHasLaborUid;
  const canHire = !lockedByMonthlyCard && !working && !resting;
  const hireTimeSeconds = positiveNumber(config.hireTimeSeconds, null);
  const gatherCdSeconds = positiveNumber(config.gatherCdSeconds, null);
  const everyMakeNum = toNumber(place.everyMakeNum, null);
  const totalTicks = hireTimeSeconds && gatherCdSeconds ? Math.floor(hireTimeSeconds / gatherCdSeconds) : null;
  const totalRecvNum = totalTicks != null && everyMakeNum != null ? totalTicks * everyMakeNum : null;
  const canRecvNum = explicitEmpty ? 0 : calcCanRecvNum(place, nowMs, config);
  const restRemainingMs = resting ? Math.max(0, laborEndTimeMs + restTimeMs - nowMs) : null;
  const laborNickname = effectiveHasLaborUid ? playerNames.get(laborUidNumber) || null : null;
  const laborDisplayText = effectiveHasLaborUid
    ? laborNickname
      ? `${laborNickname} (${place.laborUid})`
      : String(place.laborUid)
    : "-";

  return {
    placeId,
    exists: true,
    state: working ? "working" : resting ? "resting" : lockedByMonthlyCard ? "locked" : "idle",
    stateText: working ? "采集中" : resting ? "休息中" : lockedByMonthlyCard ? "未解锁" : "空闲",
    canHire,
    laborUid: effectiveHasLaborUid ? place.laborUid ?? null : null,
    laborNickname,
    laborDisplayText,
    laborEndTime: explicitEmpty ? null : place.laborEndTime ?? null,
    laborEndTimeMs: explicitEmpty ? null : laborEndTimeMs || null,
    laborEndTimeText: explicitEmpty ? "-" : formatDateTime(place.laborEndTime),
    remainingMs: working ? Math.max(0, laborEndTimeMs - nowMs) : null,
    remainingText: working ? formatDuration(laborEndTimeMs - nowMs) : "-",
    restRemainingMs,
    restRemainingText: resting ? formatDuration(restRemainingMs) : "-",
    everyMakeNum,
    recvCnt: toNumber(place.recvCnt, null),
    surplusRecvNum: toNumber(place.surplusRecvNum, null),
    canRecvNum,
    totalRecvNum,
    remainRecvNum: totalRecvNum == null ? null : Math.max(0, totalRecvNum - canRecvNum),
    hireFailCnt: toNumber(place.hireFailCnt, null),
    eventId: place.eventId ?? null,
  };
}

function buildUnavailableRecommendUids(otherHireMap, nowMs, config) {
  const out = new Set();
  const restTimeMs = Math.max(0, toNumber(config.restTimeSeconds) * 1000);
  for (const [uid, raw] of Object.entries(otherHireMap || {})) {
    const laborEndTime = raw && typeof raw === "object"
      ? raw.laborEndTime ?? raw.endTime ?? raw.eTime ?? raw.value
      : raw;
    const laborEndMs = toTimeMs(laborEndTime);
    if (laborEndMs && nowMs < laborEndMs + restTimeMs) {
      const numericUid = toNumber(uid, null);
      if (numericUid != null) out.add(numericUid);
    }
  }
  return out;
}

export function summarizePearlStatus(sync, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const config = options.pearlConfig || loadPearlConfig(options.configPath);
  const pearlTot = sync?.pearlTot || {};
  const placeMap = pearlTot.placeMap || {};
  const playerNames = buildPearlPlayerNameMap(pearlTot);
  const placeIds = new Set([
    ...Object.keys(config.places || {}).map((item) => Number(item)),
    ...Object.keys(placeMap || {}).map((item) => Number(item)),
  ]);
  const placeRows = [...placeIds]
    .filter((item) => Number.isFinite(item) && item > 0)
    .sort((a, b) => a - b)
    .map((placeId) => summarizePearlPlace(placeId, placeMap[placeId] || placeMap[String(placeId)], nowMs, config, playerNames));
  const recommendList = normalizeUidList(pearlTot.recommendList);
  const otherHireMap = pearlTot.otherHireMap || {};
  const unavailableRecommendUids = buildUnavailableRecommendUids(otherHireMap, nowMs, config);
  const recvDailyDateMs = toTimeMs(pearlTot.pearl?.recvDailyDate);
  const exists = Boolean(pearlTot.pearl || Object.keys(placeMap).length || recommendList.length);

  return {
    kind: "pearl",
    kindText: "珍珠采集",
    sourcePath: "pearlTot",
    configSourcePath: config.sourcePath,
    hireSource: "worldRecommend",
    exists,
    hireItemId: config.hireItemId,
    hireItemCount: config.hireItemId ? getItemCount(sync, config.hireItemId) : null,
    dailyFree: config.dailyFree,
    recvDailyDate: pearlTot.pearl?.recvDailyDate ?? null,
    recvDailyDateText: formatDateTime(pearlTot.pearl?.recvDailyDate),
    canRecvDailyFree: exists && !sameLocalDayMs(recvDailyDateMs, nowMs),
    canRecvNum: placeRows.reduce((sum, item) => sum + toNumber(item.canRecvNum), 0),
    freePlaceIds: placeRows.filter((item) => item.canHire).map((item) => item.placeId),
    recommendList,
    recommendCount: recommendList.length,
    otherHireMap,
    unavailableRecommendUids,
    placeRows,
  };
}

export function getAutoPearlActions(status, options = {}) {
  if (!status?.exists) return [];
  const maxHires = Math.max(0, toNumber(options.maxHires, Number.POSITIVE_INFINITY));
  const hireItemReserveCount = Math.max(0, toNumber(options.hireItemReserveCount, DEFAULT_PEARL_HIRE_ITEM_RESERVE_COUNT));
  const actions = [];

  if (status.canRecvDailyFree) {
    actions.push({ type: "recvDailyFree", iface: PEARL_IFACES.recvDailyFree, args: {} });
  }

  if (toNumber(status.canRecvNum) > 0) {
    actions.push({ type: "recvOneKey", iface: PEARL_IFACES.recvOneKey, args: {} });
  }

  const freePlaceIds = [...(status.freePlaceIds || [])];
  const unavailable = status.unavailableRecommendUids || new Set();
  const candidates = normalizeUidList(status.recommendList)
    .filter((uid) => !unavailable.has(uid));
  const hireItemCount = status.hireItemCount == null ? Number.POSITIVE_INFINITY : Math.max(0, toNumber(status.hireItemCount));
  const spendableHireItemCount = hireItemCount === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(0, hireItemCount - hireItemReserveCount);
  const hireCount = Math.min(freePlaceIds.length, candidates.length, spendableHireItemCount, maxHires);

  for (let index = 0; index < hireCount; index += 1) {
    const placeId = freePlaceIds[index];
    const dstUid = candidates[index];
    actions.push({
      type: "hire",
      iface: PEARL_IFACES.hire,
      args: { placeId, dstUid },
      placeId,
      dstUid,
      source: "worldRecommend",
    });
  }

  return actions;
}
