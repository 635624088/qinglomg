import { getTimeAuthoritySnapshot } from "./time-authority.mjs";
import { getFlowerLevelInfo, loadFlowerLevelConfig } from "./flower-level-config.mjs";
import {
  mergeNobleSessionFields,
} from "./experience-settlement.mjs";

import { formatWanNumber } from "./status-format.mjs";

function pick(obj, keys) {
  const out = {};
  for (const key of keys) out[key] = obj?.[key];
  return out;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolveNowMs(timeInput, fallbackNowMs = Date.now()) {
  if (typeof timeInput === "number") {
    return Number.isFinite(timeInput) ? timeInput : fallbackNowMs;
  }

  if (timeInput && typeof timeInput === "object") {
    const timeAuthority = timeInput.timeAuthority && typeof timeInput.timeAuthority === "object"
      ? timeInput.timeAuthority
      : timeInput;
    const localNowMs = Number.isFinite(timeInput.nowMs) ? timeInput.nowMs : fallbackNowMs;
    const snapshot = getTimeAuthoritySnapshot(timeAuthority, { nowMs: localNowMs });
    if (snapshot.trusted && Number.isFinite(snapshot.correctedNowMs)) {
      return snapshot.correctedNowMs;
    }
    if (!Object.hasOwn(timeAuthority || {}, "lastAcceptedSample")
      && timeAuthority.trusted === true
      && Number.isFinite(timeAuthority.correctedNowMs)) {
      return timeAuthority.correctedNowMs;
    }
    if (Number.isFinite(timeInput.nowMs)) return timeInput.nowMs;
  }

  return fallbackNowMs;
}

function toTimeMs(value) {
  if (value == null || value === "") return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function cloneMap(map) {
  return map && typeof map === "object" ? { ...map } : {};
}

function hasObjectKeys(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function sameLocalDayMs(leftMs, rightMs) {
  if (!leftMs || !rightMs) return false;
  const left = new Date(leftMs);
  const right = new Date(rightMs);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

export const ITEM_IDS = {
  EXPERIENCE: 2,
  WATER_DROP: 7,
  YUANBAO: 1,
  GOLD: 11,
  FLOWER_SHOP_COIN: 1002,
  PEARL: 1006,
  SATIN_SILK: 1106,
  BUILDING_MATERIAL: 1340,
};

const USER_ITEM_PROP_BY_ID = {
  [ITEM_IDS.EXPERIENCE]: "lvlExp",
};

export const GARDEN_RESOURCE_DEFS = [
  { key: "pearl", label: "珍珠", itemId: ITEM_IDS.PEARL },
  { key: "flowerShopCoin", label: "花坊币", itemId: ITEM_IDS.FLOWER_SHOP_COIN },
  { key: "satinSilk", label: "丝绸/绸缎", itemId: ITEM_IDS.SATIN_SILK },
  { key: "buildingMaterial", label: "建材", itemId: ITEM_IDS.BUILDING_MATERIAL },
  { key: "yuanbao", label: "元宝", itemId: ITEM_IDS.YUANBAO, propName: "dmd" },
  { key: "gold", label: "金币", itemId: ITEM_IDS.GOLD, propName: "gld" },
];

const DEFAULT_WATER_DROP_RESTORE = {
  displayLimit: 65,
  restoreAmount: 1,
  restoreIntervalMs: 120 * 1000,
};

function getUsrData(sync) {
  const usrTot = sync?.$usrTot || {};
  return usrTot.data || usrTot.usr || usrTot || {};
}

function getUsrDataEntry(sync) {
  const usrTot = sync?.$usrTot || {};
  if (usrTot.data && typeof usrTot.data === "object") return { data: usrTot.data, path: "$usrTot.data" };
  if (usrTot.usr && typeof usrTot.usr === "object") return { data: usrTot.usr, path: "$usrTot.usr" };
  return { data: usrTot, path: "$usrTot" };
}

function itemDeltaMaps(itemAddChg) {
  if (!itemAddChg || typeof itemAddChg !== "object") return [];
  const maps = [];
  if (itemAddChg.itemMap && typeof itemAddChg.itemMap === "object") {
    maps.push(itemAddChg.itemMap);
  }
  for (const record of itemAddChg.itemAddRcdList || []) {
    if (record?.itemMap && typeof record.itemMap === "object") maps.push(record.itemMap);
  }
  return maps;
}

function collapseItemAddChg(itemAddChg) {
  const itemMap = {};
  const directItemIds = itemIdsInMaps(itemAddChg?.itemMap);
  let mapIndex = 0;
  for (const deltaMap of itemDeltaMaps(itemAddChg)) {
    for (const [itemId, delta] of Object.entries(deltaMap)) {
      if (mapIndex > 0 && directItemIds.has(String(itemId))) continue;
      itemMap[itemId] = toNumber(itemMap[itemId]) + toNumber(delta);
    }
    mapIndex += 1;
  }
  return itemMap;
}

function mergeItemAddChgContainers(rootValue, nestedValue) {
  if (!rootValue || typeof rootValue !== "object") return nestedValue;
  if (!nestedValue || typeof nestedValue !== "object") return rootValue;
  return {
    ...rootValue,
    ...nestedValue,
    itemMap: {
      ...collapseItemAddChg(rootValue),
      ...collapseItemAddChg(nestedValue),
    },
    itemAddRcdList: [],
  };
}

function mergeOiContainers(rootValue, nestedValue) {
  if (!rootValue || typeof rootValue !== "object") return nestedValue;
  if (!nestedValue || typeof nestedValue !== "object") return rootValue;
  const merged = { ...rootValue, ...nestedValue };
  for (const key of ["bd", "bi", "bo"]) {
    const map = { ...(rootValue[key] || {}), ...(nestedValue[key] || {}) };
    if (Object.keys(map).length) merged[key] = map;
  }
  return merged;
}

function getUsrMergeUpdate(update) {
  const nested = update?.$usrTot || {};
  const itemAddChg = mergeItemAddChgContainers(update?.itemAddChg, nested.itemAddChg);
  const oi = mergeOiContainers(update?.oi, nested.oi);
  return {
    ...nested,
    ...(itemAddChg ? { itemAddChg } : {}),
    ...(oi ? { oi } : {}),
  };
}

function itemIdsInMaps(...maps) {
  const itemIds = new Set();
  for (const map of maps) {
    if (!map || typeof map !== "object") continue;
    for (const itemId of Object.keys(map)) {
      itemIds.add(String(itemId));
    }
  }
  return itemIds;
}

function userItemPropName(itemId) {
  return USER_ITEM_PROP_BY_ID[String(itemId)] || USER_ITEM_PROP_BY_ID[Number(itemId)] || null;
}

function applyAbsoluteUserItem(data, bag, itemId, count) {
  const propName = userItemPropName(itemId);
  if (propName) {
    data[propName] = toNumber(count);
    return;
  }
  bag[itemId] = count;
}

function applyDeltaUserItem(data, bag, baseBag, itemId, delta, updateBag = null, options = {}) {
  const propName = userItemPropName(itemId);
  const deltaCount = toNumber(delta);
  if (propName) {
    data[propName] = toNumber(data[propName]) + deltaCount;
    return;
  }

  if (options.skipWaterDropBagDelta && Number(itemId) === ITEM_IDS.WATER_DROP) {
    return;
  }

  const baseCount = toNumber(baseBag[itemId]);
  if (updateBag && hasOwn(updateBag, itemId)) {
    const updateCount = toNumber(updateBag[itemId]);
    const expectedCount = baseCount + deltaCount;
    if (updateCount === baseCount && updateCount !== expectedCount) {
      bag[itemId] = expectedCount;
    }
  } else {
    bag[itemId] = toNumber(bag[itemId]) + deltaCount;
  }
}

export function summarizeLand(sync, nowMs = Date.now()) {
  const landMap = sync?.usrLandTot?.usrLand?.landMap || {};
  const resolvedNowMs = resolveNowMs(nowMs);
  const rows = Object.entries(landMap)
    .map(([landId, land]) => {
      const nextMs = land?.nextTime ? Date.parse(land.nextTime) : 0;
      const mature = land?.state === 3 || (land?.state === 2 && nextMs && nextMs <= resolvedNowMs);
      const empty = !land || Object.keys(land).length === 0 || land.state == null || land.state === 0;
      return {
        landId: Number(landId),
        flowerId: land?.flowerId || 0,
        state: land?.state ?? null,
        lvl: land?.lvl ?? null,
        harvestCnt: land?.harvestCnt ?? null,
        nextTime: land?.nextTime || null,
        mature,
        empty,
      };
    })
    .sort((a, b) => a.landId - b.landId);
  return {
    total: rows.length,
    empty: rows.filter((r) => r.empty).map((r) => r.landId),
    mature: rows.filter((r) => r.mature).map((r) => pick(r, ["landId", "flowerId", "state", "lvl", "harvestCnt", "nextTime"])),
    growing: rows.filter((r) => !r.empty && !r.mature).map((r) => pick(r, ["landId", "flowerId", "state", "lvl", "harvestCnt", "nextTime"])),
    rows,
  };
}

export function getBag(sync) {
  const usrTot = sync?.$usrTot || {};
  const usrData = getUsrData(sync);
  return usrData.bag || usrData.itemMap || usrTot.bag || usrTot.itemMap || {};
}

export function getItemCount(sync, itemId) {
  const bag = getBag(sync);
  return toNumber(bag[itemId] ?? bag[String(itemId)]);
}

function getResourceCount(sync, def) {
  if (def.propName) {
    const { data, path } = getUsrDataEntry(sync);
    if (hasOwn(data, def.propName) && data[def.propName] != null && data[def.propName] !== "") {
      return {
        count: toNumber(data[def.propName]),
        sourcePath: `${path}.${def.propName}`,
      };
    }
  }

  return {
    count: getItemCount(sync, def.itemId),
    sourcePath: `$usrTot.data.bag[${def.itemId}]`,
  };
}

export function getGardenResourceStatus(sync, resourceDefs = GARDEN_RESOURCE_DEFS) {
  return Object.fromEntries(resourceDefs.map((def) => {
    const { count, sourcePath } = getResourceCount(sync, def);
    return [def.key, {
      ...def,
      count,
      displayText: def.key === "gold" ? formatWanNumber(count) : String(count),
      sourcePath,
    }];
  }));
}

function getItemExt(sync, itemId) {
  const usrTot = sync?.$usrTot || {};
  const usrData = getUsrData(sync);
  const itemExtMap = usrData.itemExtMap || usrTot.itemExtMap || {};
  return itemExtMap[itemId] || itemExtMap[String(itemId)] || null;
}

function positiveNumber(value, fallback = 0) {
  const n = toNumber(value, fallback);
  return n > 0 ? n : fallback;
}

export function getWaterDropStatus(sync, nowMs = Date.now()) {
  const resolvedNowMs = resolveNowMs(nowMs);
  const itemId = ITEM_IDS.WATER_DROP;
  const usrData = getUsrData(sync);
  const ext = getItemExt(sync, itemId);
  const baseCount = getItemCount(sync, itemId);
  const displayLimit = positiveNumber(
    ext?.resetNum,
    DEFAULT_WATER_DROP_RESTORE.displayLimit,
  );
  const restoreIntervalMs = positiveNumber(
    ext?.cd,
    DEFAULT_WATER_DROP_RESTORE.restoreIntervalMs,
  );
  const restoreAmount = positiveNumber(
    ext?.restoreNum,
    DEFAULT_WATER_DROP_RESTORE.restoreAmount,
  );
  const itemLimit = positiveNumber(ext?.limit, 0);

  let restoreStartMs = toTimeMs(ext?.lems);
  const resetMs = toTimeMs(ext?.lrms);
  const createMs = toTimeMs(usrData.cTime);
  if (restoreStartMs && resetMs && restoreStartMs < resetMs) restoreStartMs = resetMs;
  if (!restoreStartMs) restoreStartMs = resetMs || createMs;
  if (restoreStartMs && createMs && restoreStartMs < createMs) restoreStartMs = createMs;

  let restoreTicks = 0;
  let restoredCount = 0;
  if (ext && restoreStartMs > 0 && restoreIntervalMs > 0 && resolvedNowMs > restoreStartMs) {
    restoreTicks = Math.floor((resolvedNowMs - restoreStartMs) / restoreIntervalMs);
    const restoreCapacity = displayLimit > 0 ? Math.max(0, displayLimit - baseCount) : Infinity;
    restoredCount = Math.min(restoreTicks * restoreAmount, restoreCapacity);
  }

  let count = baseCount + Math.max(0, restoredCount);
  if (itemLimit > 0) count = Math.min(count, itemLimit);

  let nextRestoreInSeconds = null;
  let nextRestoreAtMs = null;
  if (ext && count < displayLimit && restoreStartMs > 0 && restoreIntervalMs > 0) {
    const elapsedMs = Math.max(0, resolvedNowMs - restoreStartMs);
    nextRestoreAtMs = restoreStartMs + (Math.floor(elapsedMs / restoreIntervalMs) + 1) * restoreIntervalMs;
    nextRestoreInSeconds = Math.max(0, Math.ceil((nextRestoreAtMs - resolvedNowMs) / 1000));
  }

  return {
    itemId,
    sourcePath: "$usrTot.data.bag[7] + $usrTot.data.itemExtMap[7]",
    baseCount,
    count,
    restoredCount,
    restoreTicks,
    displayLimit,
    itemLimit: itemLimit || null,
    restoreAmount,
    restoreIntervalMs,
    restoreIntervalSeconds: Math.floor(restoreIntervalMs / 1000),
    restoreStartMs: restoreStartMs || null,
    restoreStartTime: restoreStartMs ? new Date(restoreStartMs).toISOString() : null,
    nextRestoreAtMs,
    nextRestoreAt: nextRestoreAtMs ? new Date(nextRestoreAtMs).toISOString() : null,
    nextRestoreInSeconds,
    hasRestoreExt: Boolean(ext),
  };
}

export function getWaterDropCount(sync, nowMs = Date.now()) {
  return getWaterDropStatus(sync, nowMs).count;
}

export function setWaterDropCount(sync, count, nowMs = Date.now()) {
  const resolvedNowMs = resolveNowMs(nowMs);
  const current = getWaterDropStatus(sync, resolvedNowMs);
  const target = Math.max(0, Math.floor(toNumber(count, current.count)));
  const out = { ...sync };
  const usrTot = { ...(out.$usrTot || {}) };
  const dataKey = usrTot.data ? "data" : usrTot.usr ? "usr" : "data";
  const data = { ...(usrTot[dataKey] || {}) };
  const bag = { ...(data.bag || data.itemMap || usrTot.bag || usrTot.itemMap || {}) };
  bag[ITEM_IDS.WATER_DROP] = target;
  data.bag = bag;

  const itemExtMap = { ...(data.itemExtMap || usrTot.itemExtMap || {}) };
  const ext = itemExtMap[ITEM_IDS.WATER_DROP] || itemExtMap[String(ITEM_IDS.WATER_DROP)];
  if (ext) {
    itemExtMap[ITEM_IDS.WATER_DROP] = { ...ext, lems: resolvedNowMs };
    data.itemExtMap = itemExtMap;
  }

  usrTot[dataKey] = data;
  out.$usrTot = usrTot;
  return out;
}

export function clampWaterDropCount(sync, maxCount, nowMs = Date.now()) {
  const resolvedNowMs = resolveNowMs(nowMs);
  const current = getWaterDropStatus(sync, resolvedNowMs);
  const target = Math.max(0, Math.floor(toNumber(maxCount, current.count)));
  if (current.count <= target) return sync;
  return setWaterDropCount(sync, target, resolvedNowMs);
}

export function getDoubleGoldStatus(sync, nowMs = Date.now()) {
  const resolvedNowMs = resolveNowMs(nowMs);
  const videoDouble = sync?.videoDouble || {};
  const eTimeMs = toTimeMs(videoDouble.eTime);
  const remainingMs = eTimeMs ? Math.max(0, eTimeMs - resolvedNowMs) : 0;
  return {
    sourcePath: "videoDouble.eTime",
    exists: Boolean(sync?.videoDouble),
    active: remainingMs > 0,
    videoCnt: videoDouble.videoCnt ?? null,
    eTime: videoDouble.eTime ?? null,
    eTimeMs: eTimeMs || null,
    remainingMs,
  };
}

function mergeUsrTot(baseUsr = {}, updateUsr = {}) {
  const mergedUsr = { ...baseUsr, ...updateUsr };
  const dataKey = updateUsr.data || baseUsr.data ? "data" : updateUsr.usr || baseUsr.usr ? "usr" : "data";
  const baseData = baseUsr.data || baseUsr.usr || {};
  const updateData = updateUsr.data || updateUsr.usr || {};
  const mergedData = { ...baseData, ...updateData };
  const baseBag = baseData.bag || baseData.itemMap || baseUsr.bag || baseUsr.itemMap || {};
  const updateBag = updateData.bag || updateData.itemMap || updateUsr.bag || updateUsr.itemMap || null;
  const bag = cloneMap(baseBag);

  if (updateBag) {
    for (const [id, count] of Object.entries(updateBag)) {
      applyAbsoluteUserItem(mergedData, bag, id, count);
    }
  }

  const oiItemIds = itemIdsInMaps(updateUsr.oi?.bd, updateUsr.oi?.bi, updateUsr.oi?.bo);
  const itemAddChgItemMapIds = itemIdsInMaps(updateUsr.itemAddChg?.itemMap);
  let itemAddChgMapIndex = 0;
  for (const deltaMap of itemDeltaMaps(updateUsr.itemAddChg)) {
    for (const [id, delta] of Object.entries(deltaMap)) {
      if (oiItemIds.has(String(id))) continue;
      if (itemAddChgMapIndex > 0 && itemAddChgItemMapIds.has(String(id))) continue;
      applyDeltaUserItem(mergedData, bag, baseBag, id, delta, updateBag, { skipWaterDropBagDelta: true });
    }
    itemAddChgMapIndex += 1;
  }

  if (updateUsr.oi?.bd && typeof updateUsr.oi.bd === "object") {
    for (const [id, count] of Object.entries(updateUsr.oi.bd)) {
      applyAbsoluteUserItem(mergedData, bag, id, count);
    }
  }

  for (const deltaMap of [updateUsr.oi?.bi, updateUsr.oi?.bo]) {
    if (!deltaMap || typeof deltaMap !== "object") continue;
    for (const [id, delta] of Object.entries(deltaMap)) {
      applyDeltaUserItem(mergedData, bag, baseBag, id, delta, updateBag, { skipWaterDropBagDelta: true });
    }
  }

  if (Object.keys(bag).length) mergedData.bag = bag;
  mergedUsr[dataKey] = mergedData;
  if (baseUsr.cntMap || updateUsr.cntMap) {
    mergedUsr.cntMap = mergeCntMap(baseUsr.cntMap || {}, updateUsr.cntMap || {});
  }
  return mergedUsr;
}

function mergeCntInfo(baseInfo, updateInfo) {
  if (updateInfo == null) return baseInfo;
  if (!baseInfo || typeof baseInfo !== "object" || typeof updateInfo !== "object") return updateInfo;

  const merged = { ...baseInfo, ...updateInfo };
  const baseTdy = toNumber(baseInfo.tdyCnt, null);
  const updateTdy = toNumber(updateInfo.tdyCnt, null);
  const baseRTimeMs = toTimeMs(baseInfo.rTime);
  const updateRTimeMs = toTimeMs(updateInfo.rTime);

  if (
    baseTdy != null
    && updateTdy != null
    && updateTdy < baseTdy
    && sameLocalDayMs(baseRTimeMs, updateRTimeMs || baseRTimeMs)
  ) {
    merged.tdyCnt = baseInfo.tdyCnt;
    if (baseInfo.totCnt != null && updateInfo.totCnt != null) {
      merged.totCnt = Math.max(toNumber(baseInfo.totCnt), toNumber(updateInfo.totCnt));
    }
    if (!updateRTimeMs || (baseRTimeMs && baseRTimeMs > updateRTimeMs)) {
      merged.rTime = baseInfo.rTime;
    }
  }

  return merged;
}

function mergeCntMap(baseMap = {}, updateMap = {}) {
  const out = { ...baseMap, ...updateMap };
  const keys = new Set([...Object.keys(baseMap || {}), ...Object.keys(updateMap || {})]);
  for (const key of keys) {
    out[key] = mergeCntInfo(baseMap?.[key], updateMap?.[key]);
  }
  return out;
}

function mergeUsrLandTot(baseLandTot = {}, updateLandTot = {}) {
  const out = { ...baseLandTot, ...updateLandTot };
  const baseUsrLand = baseLandTot.usrLand || {};
  const updateUsrLand = updateLandTot.usrLand || {};
  const baseLandMap = baseUsrLand.landMap || {};
  const updateLandMap = updateUsrLand.landMap || {};
  const chgLandMap = updateLandTot.chgLandMap || {};

  if (baseLandTot.usrLand || updateLandTot.usrLand || updateLandTot.chgLandMap) {
    out.usrLand = {
      ...baseUsrLand,
      ...updateUsrLand,
      landMap: {
        ...baseLandMap,
        ...updateLandMap,
        ...chgLandMap,
      },
    };
  }

  return out;
}

function mergeSpecialOrder(baseOrder, updateOrder) {
  if (updateOrder == null) return baseOrder;
  if (!hasObjectKeys(updateOrder) && hasObjectKeys(baseOrder)) return baseOrder;
  if (baseOrder && typeof baseOrder === "object" && updateOrder && typeof updateOrder === "object") {
    return { ...baseOrder, ...updateOrder };
  }
  return updateOrder;
}

function mergeOrderFlowerTot(baseOrderTot = {}, updateOrderTot = {}) {
  const out = { ...baseOrderTot, ...updateOrderTot };
  if (!Object.hasOwn(updateOrderTot, "orderFlower")) return out;

  // Official 412.0.10 OrderFlowerCtrl only calls setData when orderFlower is
  // truthy. Its setData updates the fields that are actually present, so an
  // explicit orderSatin/orderDecorate/orderMap (including null or {}) replaces
  // that field, while absent fields retain the controller's prior value.
  const updateOrderFlower = updateOrderTot.orderFlower;
  if (!updateOrderFlower || typeof updateOrderFlower !== "object") {
    if (Object.hasOwn(baseOrderTot, "orderFlower")) {
      out.orderFlower = baseOrderTot.orderFlower;
    } else {
      delete out.orderFlower;
    }
    return out;
  }

  out.orderFlower = {
    ...(baseOrderTot.orderFlower || {}),
    ...updateOrderFlower,
  };

  return out;
}

function mergeOrderTeam(baseOrder = {}, updateOrder = {}) {
  const out = { ...baseOrder, ...updateOrder };

  for (const key of ["rwd", "highCntMap"]) {
    if (baseOrder[key] || updateOrder[key]) {
      out[key] = {
        ...(baseOrder[key] || {}),
        ...(updateOrder[key] || {}),
      };
    }
  }

  if (!Array.isArray(updateOrder.storedOrders) && hasOwn(baseOrder, "storedOrders")) {
    out.storedOrders = baseOrder.storedOrders;
  } else if (!Array.isArray(updateOrder.storedOrders)) {
    delete out.storedOrders;
  }

  return out;
}

function mergeOrderTeamTot(baseTot = {}, updateTot = {}) {
  const out = { ...baseTot, ...updateTot };
  if (baseTot.orderTeam || updateTot.orderTeam) {
    out.orderTeam = mergeOrderTeam(baseTot.orderTeam || {}, updateTot.orderTeam || {});
  }
  return out;
}

function mergeOrderCustomerTot(baseOrderTot = {}, updateOrderTot = {}) {
  const out = { ...baseOrderTot, ...updateOrderTot };
  const baseOrderCustomer = baseOrderTot.orderCustomer || {};
  const updateOrderCustomer = updateOrderTot.orderCustomer || {};

  if (baseOrderTot.orderCustomer || updateOrderTot.orderCustomer) {
    out.orderCustomer = {
      ...baseOrderCustomer,
      ...updateOrderCustomer,
    };

    if (hasOwn(updateOrderCustomer, "orderMap") && !hasObjectKeys(updateOrderCustomer.orderMap)) {
      out.orderCustomer.orderMap = {};
    } else if (baseOrderCustomer.orderMap || updateOrderCustomer.orderMap) {
      out.orderCustomer.orderMap = {
        ...(baseOrderCustomer.orderMap || {}),
        ...(updateOrderCustomer.orderMap || {}),
      };
    }
  }

  return out;
}

function mergeOrderPalaceTot(baseOrderTot = {}, updateOrderTot = {}) {
  const out = { ...baseOrderTot, ...updateOrderTot };
  const baseOrderPalace = baseOrderTot.orderPalace || {};
  const updateOrderPalace = updateOrderTot.orderPalace || {};

  if (baseOrderTot.orderPalace || updateOrderTot.orderPalace) {
    out.orderPalace = mergeSpecialOrder(baseOrderPalace, updateOrderPalace);

    if (baseOrderPalace.orderMap || updateOrderPalace.orderMap) {
      out.orderPalace.orderMap = {
        ...(baseOrderPalace.orderMap || {}),
        ...(updateOrderPalace.orderMap || {}),
      };
    }
  }

  return out;
}

function mergeFlowerArtTot(baseFlowerArtTot = {}, updateFlowerArtTot = {}) {
  const out = { ...baseFlowerArtTot, ...updateFlowerArtTot };
  const baseFlowerArt = baseFlowerArtTot.flowerArt || {};
  const updateFlowerArt = updateFlowerArtTot.flowerArt || {};

  if (baseFlowerArtTot.flowerArt || updateFlowerArtTot.flowerArt) {
    out.flowerArt = {
      ...baseFlowerArt,
      ...updateFlowerArt,
    };

    for (const key of ["makeList", "sRecvList"]) {
      if (hasOwn(updateFlowerArt, key)) {
        out.flowerArt[key] = updateFlowerArt[key] || [];
      } else if (hasOwn(baseFlowerArt, key)) {
        out.flowerArt[key] = baseFlowerArt[key] || [];
      }
    }
  }

  return out;
}

function mergePlainObject(baseValue = {}, updateValue = {}) {
  return { ...(baseValue || {}), ...(updateValue || {}) };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function firstPositiveNumber(values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function getPalaceOrderFlowerId(row) {
  const direct = firstPositiveNumber([
    row?.flowerId,
    row?.flwId,
    row?.flowerID,
    row?.flower_id,
  ]);
  if (direct) return direct;

  const itemId = firstPositiveNumber([row?.itemId, row?.iid]);
  return itemId >= 23000 && itemId < 24000 ? itemId : 0;
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

function isFinishedFlag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function isFinishedPalaceOrder(row) {
  return isFinishedFlag(row?.isFinish)
    || isFinishedFlag(row?.finished)
    || isFinishedFlag(row?.finish)
    || isFinishedFlag(row?.isFinished);
}

function collectPalaceOrderRows(sync) {
  const roots = [
    sync?.orderPalaceTot?.orderPalace,
    sync?.orderPalaceTot?.orderPalace?.orderMap,
    sync?.orderPalace,
    sync?.orderPalace?.orderMap,
  ];
  const rows = [];
  const seen = new Set();

  function addRow(row) {
    if (!row || typeof row !== "object" || seen.has(row)) return;
    if (!getPalaceOrderFlowerId(row) || !getPalaceOrderNeed(row)) return;
    seen.add(row);
    rows.push(row);
  }

  function visitContainer(container) {
    if (!container || typeof container !== "object") return;
    if (Array.isArray(container)) {
      for (const item of container) addRow(item);
      return;
    }

    addRow(container);
    for (const key of ["orderMap", "map", "orderList", "orders", "list"]) {
      const child = container[key];
      if (!child || child === container) continue;
      visitContainer(child);
    }

    for (const value of Object.values(container)) {
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        visitContainer(value);
      } else {
        addRow(value);
      }
    }
  }

  for (const root of roots) visitContainer(root);
  return rows;
}

export function getPalaceOrderFlowerNeeds(sync) {
  const bag = getBag(sync);
  const needsByFlowerId = new Map();
  for (const row of collectPalaceOrderRows(sync)) {
    if (isFinishedPalaceOrder(row)) continue;
    const flowerId = getPalaceOrderFlowerId(row);
    const need = getPalaceOrderNeed(row);
    if (!flowerId || !need) continue;
    const current = needsByFlowerId.get(flowerId) || 0;
    needsByFlowerId.set(flowerId, current + need);
  }

  const out = new Map();
  for (const [flowerId, need] of needsByFlowerId.entries()) {
    const have = toNumber(bag[flowerId] ?? bag[String(flowerId)]);
    const missing = Math.max(0, need - have);
    if (missing > 0) out.set(flowerId, { need, have, missing });
  }
  return out;
}

function mergeActInfo(baseAct = {}, updateAct = {}) {
  const out = { ...baseAct, ...updateAct };
  if (baseAct.ext || updateAct.ext) {
    out.ext = mergePlainObject(baseAct.ext, updateAct.ext);
    if (baseAct.ext?.cyclicStory || updateAct.ext?.cyclicStory) {
      out.ext.cyclicStory = mergePlainObject(baseAct.ext?.cyclicStory, updateAct.ext?.cyclicStory);
      if (hasOwn(updateAct.ext?.cyclicStory, "orderInfo")) {
        out.ext.cyclicStory.orderInfo = updateAct.ext?.cyclicStory?.orderInfo || {};
      } else if (hasOwn(baseAct.ext?.cyclicStory, "orderInfo")) {
        out.ext.cyclicStory.orderInfo = baseAct.ext?.cyclicStory?.orderInfo || {};
      }
    }
    if (baseAct.ext?.cyclicNote || updateAct.ext?.cyclicNote) {
      out.ext.cyclicNote = mergePlainObject(baseAct.ext?.cyclicNote, updateAct.ext?.cyclicNote);
      if (hasOwn(updateAct.ext?.cyclicNote, "taskList")) {
        out.ext.cyclicNote.taskList = updateAct.ext?.cyclicNote?.taskList || [];
      } else if (hasOwn(baseAct.ext?.cyclicNote, "taskList")) {
        out.ext.cyclicNote.taskList = baseAct.ext?.cyclicNote?.taskList || [];
      }
    }
  }
  return out;
}

function mergeActTaskRcdMap(baseMap = {}, updateMap = {}) {
  const out = { ...(baseMap || {}) };
  for (const [key, updateRecord] of Object.entries(updateMap || {})) {
    if (!updateRecord || typeof updateRecord !== "object") {
      // No verified task-record deletion marker exists. Keep an existing record
      // rather than treating a falsy sparse update as a deletion.
      if (!hasOwn(out, key)) out[key] = updateRecord;
      continue;
    }
    const baseRecord = out[key] && typeof out[key] === "object" ? out[key] : {};
    // setData updates only fields present in the response. progress/recvMap are
    // record fields, so an explicit field replaces that map as a whole.
    out[key] = { ...baseRecord, ...updateRecord };
  }
  return out;
}

function mergeActTot(baseActTot = {}, updateActTot = {}) {
  const out = { ...baseActTot, ...updateActTot };
  if (baseActTot.map || updateActTot.map) {
    out.map = { ...(baseActTot.map || {}) };
    for (const [batchId, act] of Object.entries(updateActTot.map || {})) {
      out.map[batchId] = mergeActInfo(out.map[batchId] || {}, act);
    }
  }
  if (baseActTot.taskRcdMap || updateActTot.taskRcdMap) {
    out.taskRcdMap = mergeActTaskRcdMap(
      baseActTot.taskRcdMap || {},
      updateActTot.taskRcdMap || {},
    );
  }
  return out;
}

function hasPearlLabor(place) {
  return Boolean(place?.laborEndTime) && Number(place?.laborUid || 0) > 0;
}

function isSparsePearlIdlePlace(place) {
  if (!place || typeof place !== "object") return false;
  const laborUid = Number(place.laborUid || 0);
  return laborUid <= 0 && !place.laborEndTime;
}

function isExplicitEmptyPearlPlace(place) {
  if (!place || typeof place !== "object") return false;
  return toNumber(place.eventId, null) === 0
    && toNumber(place.everyMakeNum, null) === 0
    && toNumber(place.recvCnt, null) === 0
    && toNumber(place.surplusRecvNum, null) === 0;
}

function mergePearlPlace(basePlace = {}, updatePlace = {}) {
  const out = { ...(basePlace || {}), ...(updatePlace || {}) };
  if (hasPearlLabor(basePlace) && isSparsePearlIdlePlace(updatePlace) && !isExplicitEmptyPearlPlace(updatePlace)) {
    out.laborUid = basePlace.laborUid;
    out.laborEndTime = basePlace.laborEndTime;
    if (basePlace.everyMakeNum != null && out.everyMakeNum == null) out.everyMakeNum = basePlace.everyMakeNum;
    if (basePlace.eventId != null && out.eventId == null) out.eventId = basePlace.eventId;
  }
  return out;
}

function mergePearlPlaceMap(baseMap = {}, updateMap = {}) {
  const out = { ...(baseMap || {}) };
  for (const [placeId, place] of Object.entries(updateMap || {})) {
    out[placeId] = mergePearlPlace(out[placeId] || {}, place && typeof place === "object" ? place : {});
  }
  return out;
}

function mergePearlTot(basePearlTot = {}, updatePearlTot = {}) {
  const out = { ...basePearlTot, ...updatePearlTot };

  if (basePearlTot.pearl || updatePearlTot.pearl) {
    out.pearl = {
      ...(basePearlTot.pearl || {}),
      ...(updatePearlTot.pearl || {}),
    };
  }

  if (basePearlTot.placeMap || updatePearlTot.placeMap) {
    out.placeMap = mergePearlPlaceMap(basePearlTot.placeMap || {}, updatePearlTot.placeMap || {});
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
  ]) {
    if (basePearlTot[key] || updatePearlTot[key]) {
      out[key] = {
        ...(basePearlTot[key] || {}),
        ...(updatePearlTot[key] || {}),
      };
    }
  }

  for (const key of ["recommendList", "drawList", "mHireLogList", "dHireLogList"]) {
    if (hasOwn(updatePearlTot, key)) {
      out[key] = updatePearlTot[key] || [];
    } else if (hasOwn(basePearlTot, key)) {
      out[key] = basePearlTot[key] || [];
    }
  }

  return out;
}

function mergeFlowerRackMap(baseMap = {}, updateMap = {}) {
  const out = { ...(baseMap || {}) };
  for (const [rackId, rack] of Object.entries(updateMap || {})) {
    out[rackId] = rack && typeof rack === "object" ? { ...rack } : rack;
  }
  return out;
}

function mergeFlowerRackTot(baseRackTot = {}, updateRackTot = {}) {
  const out = { ...baseRackTot, ...updateRackTot };

  if (baseRackTot.flowerRackMap || updateRackTot.flowerRackMap) {
    out.flowerRackMap = mergeFlowerRackMap(baseRackTot.flowerRackMap || {}, updateRackTot.flowerRackMap || {});
  }

  if (baseRackTot.flowerRack || updateRackTot.flowerRack) {
    out.flowerRack = {
      ...(baseRackTot.flowerRack || {}),
      ...(updateRackTot.flowerRack || {}),
    };
    if (baseRackTot.flowerRack?.flowerRackMap || updateRackTot.flowerRack?.flowerRackMap) {
      out.flowerRack.flowerRackMap = mergeFlowerRackMap(
        baseRackTot.flowerRack?.flowerRackMap || {},
        updateRackTot.flowerRack?.flowerRackMap || {},
      );
    }
  }

  return out;
}

function mergeFmlTot(baseFmlTot = {}, updateFmlTot = {}) {
  const out = { ...baseFmlTot, ...updateFmlTot };
  const baseFmlLand = baseFmlTot.fmlLand || {};
  const updateFmlLand = updateFmlTot.fmlLand || {};

  if (baseFmlTot.fmlLand || updateFmlTot.fmlLand) {
    out.fmlLand = {
      ...baseFmlLand,
      ...updateFmlLand,
    };

    if (baseFmlLand.landMap || updateFmlLand.landMap || updateFmlLand.chgLandMap) {
      out.fmlLand.landMap = {
        ...(baseFmlLand.landMap || {}),
        ...(updateFmlLand.landMap || {}),
        ...(updateFmlLand.chgLandMap || {}),
      };
    }
  }

  return out;
}

function mergeShopCultivate(baseShop = {}, updateShop = {}) {
  const out = { ...baseShop, ...updateShop };

  if (baseShop.infoMap || updateShop.infoMap) {
    out.infoMap = hasOwn(updateShop, "infoMap")
      ? { ...(updateShop.infoMap || {}) }
      : { ...(baseShop.infoMap || {}) };
  }

  if (baseShop.bRecord || updateShop.bRecord) {
    if (hasOwn(updateShop, "infoMap") && hasOwn(updateShop, "bRecord")) {
      out.bRecord = { ...(updateShop.bRecord || {}) };
    } else if (hasOwn(updateShop, "bRecord")) {
      out.bRecord = {
        ...(baseShop.bRecord || {}),
        ...(updateShop.bRecord || {}),
      };
    } else {
      out.bRecord = { ...(baseShop.bRecord || {}) };
    }
  }

  return out;
}

function mergeCultivateTot(baseCultivateTot = {}, updateCultivateTot = {}) {
  const out = {
    ...(baseCultivateTot || {}),
    ...(updateCultivateTot || {}),
  };

  if (baseCultivateTot.cultivateMap || updateCultivateTot.cultivateMap) {
    const baseMap = baseCultivateTot.cultivateMap || {};
    const updateMap = updateCultivateTot.cultivateMap || {};
    out.cultivateMap = hasObjectKeys(updateMap)
      ? {
          ...baseMap,
          ...Object.fromEntries(
            Object.entries(updateMap).map(([flowerId, item]) => [
              flowerId,
              {
                ...(baseMap[flowerId] || baseMap[Number(flowerId)] || {}),
                ...(item || {}),
              },
            ]),
          ),
        }
      : { ...baseMap };
  }

  return out;
}

function mergeWaterwheel(baseWaterwheel = {}, updateWaterwheel = {}) {
  return {
    ...(baseWaterwheel || {}),
    ...(updateWaterwheel || {}),
  };
}

function mergeTaskCtrlState(baseState, updateState) {
  if (baseState && updateState && typeof baseState === "object" && typeof updateState === "object" && !Array.isArray(baseState) && !Array.isArray(updateState)) {
    return {
      ...baseState,
      ...updateState,
    };
  }
  return updateState;
}

function mergeTaskTot(baseTaskTot = {}, updateTaskTot = {}) {
  const out = {
    ...(baseTaskTot || {}),
    ...(updateTaskTot || {}),
  };

  for (const key of ["main", "task", "mainTask", "taskCtrl_main"]) {
    if (hasOwn(updateTaskTot, key)) {
      out[key] = mergeTaskCtrlState(baseTaskTot[key], updateTaskTot[key]);
    } else if (hasOwn(baseTaskTot, key)) {
      out[key] = baseTaskTot[key];
    }
  }

  return out;
}

function getUsrPayloadData(usrTot = {}) {
  return usrTot.data || usrTot.usr || {};
}

function finiteEvidenceNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstFiniteField(value, keys) {
  for (const key of keys) {
    if (!hasOwn(value, key)) continue;
    const number = finiteEvidenceNumber(value[key]);
    if (number != null) return number;
  }
  return null;
}

function addExperienceCandidate(candidates, source, value, invalidSources) {
  if (value == null || value === "") return;
  const number = finiteEvidenceNumber(value);
  if (number == null) {
    invalidSources.push(source);
    return;
  }
  candidates.push({ source, value: number });
}

function resolveDisplayExperienceDelta(updateUsr, invalidSources) {
  const experienceItemKey = String(ITEM_IDS.EXPERIENCE);
  const deltaCandidates = [];
  const itemAddChg = updateUsr?.itemAddChg || {};

  const directItemMap = itemAddChg.itemMap;
  let directItemDelta = null;
  if (directItemMap && hasOwn(directItemMap, experienceItemKey)) {
    addExperienceCandidate(
      deltaCandidates,
      `$usrTot.itemAddChg.itemMap[${experienceItemKey}]`,
      directItemMap[experienceItemKey],
      invalidSources,
    );
    directItemDelta = finiteEvidenceNumber(directItemMap[experienceItemKey]);
  }

  let recordDelta = null;
  let recordFound = false;
  for (const [index, record] of (itemAddChg.itemAddRcdList || []).entries()) {
    const itemMap = record?.itemMap;
    if (!itemMap || !hasOwn(itemMap, experienceItemKey)) continue;
    const value = finiteEvidenceNumber(itemMap[experienceItemKey]);
    addExperienceCandidate(
      deltaCandidates,
      `$usrTot.itemAddChg.itemAddRcdList[${index}].itemMap[${experienceItemKey}]`,
      itemMap[experienceItemKey],
      invalidSources,
    );
    if (value == null) continue;
    recordFound = true;
    recordDelta = (recordDelta ?? 0) + value;
  }

  let conflictReason = null;
  let itemAddDelta = directItemDelta;
  if (recordFound) {
    if (directItemDelta != null && directItemDelta !== recordDelta) {
      conflictReason = "item-add-summary-mismatch";
    }
    itemAddDelta = directItemDelta ?? recordDelta;
  }

  const oi = updateUsr?.oi || {};
  let incomingDelta = null;
  if (oi.bi && hasOwn(oi.bi, experienceItemKey)) {
    addExperienceCandidate(
      deltaCandidates,
      `$usrTot.oi.bi[${experienceItemKey}]`,
      oi.bi[experienceItemKey],
      invalidSources,
    );
    incomingDelta = finiteEvidenceNumber(oi.bi[experienceItemKey]);
  }

  let outgoingDelta = null;
  if (oi.bo && hasOwn(oi.bo, experienceItemKey)) {
    const outgoing = finiteEvidenceNumber(oi.bo[experienceItemKey]);
    addExperienceCandidate(
      deltaCandidates,
      `$usrTot.oi.bo[${experienceItemKey}]`,
      outgoing == null ? oi.bo[experienceItemKey] : -Math.abs(outgoing),
      invalidSources,
    );
    if (outgoing != null) outgoingDelta = -Math.abs(outgoing);
  }

  let deduplicatedDelta = itemAddDelta;
  if (incomingDelta != null) {
    if (itemAddDelta != null && itemAddDelta !== incomingDelta) {
      conflictReason ||= "experience-display-delta-mismatch";
    }
    deduplicatedDelta = incomingDelta;
  }
  if (outgoingDelta != null) {
    if (
      (incomingDelta != null && incomingDelta !== 0)
      || (itemAddDelta != null && itemAddDelta !== 0)
    ) {
      conflictReason ||= "experience-in-and-out-conflict";
    }
    deduplicatedDelta = outgoingDelta;
  }

  return {
    deltaCandidates,
    deduplicatedDelta,
    conflictReason,
  };
}

export function parseExperienceSettlementEvidence(base, update) {
  const beforeData = getUsrPayloadData(base?.$usrTot || {});
  const beforeLevel = firstFiniteField(
    beforeData,
    ["lvl", "lv", "level", "usrLvl", "usrLevel"],
  );
  const beforeExp = firstFiniteField(
    beforeData,
    ["lvlExp", "lvExp", "exp", "curExp", "currentExp", "usrExp"],
  );
  const updateUsr = update?.$usrTot || {};
  const updateData = getUsrPayloadData(updateUsr);
  const responseLevel = firstFiniteField(
    updateData,
    ["lvl", "lv", "level", "usrLvl", "usrLevel"],
  );
  const invalidSources = [];
  const absoluteCandidates = [];
  const experienceItemKey = String(ITEM_IDS.EXPERIENCE);

  for (const [key, source] of [
    ["lvlExp", "$usrTot.data.lvlExp"],
    ["lvExp", "$usrTot.data.lvExp"],
    ["exp", "$usrTot.data.exp"],
    ["curExp", "$usrTot.data.curExp"],
    ["currentExp", "$usrTot.data.currentExp"],
    ["usrExp", "$usrTot.data.usrExp"],
  ]) {
    if (!hasOwn(updateData, key)) continue;
    addExperienceCandidate(
      absoluteCandidates,
      source,
      updateData[key],
      invalidSources,
    );
  }

  const updateBag = updateData.bag || updateData.itemMap || null;
  if (updateBag && hasOwn(updateBag, experienceItemKey)) {
    addExperienceCandidate(
      absoluteCandidates,
      `$usrTot.data.bag[${experienceItemKey}]`,
      updateBag[experienceItemKey],
      invalidSources,
    );
  }
  if (updateUsr.oi?.bd && hasOwn(updateUsr.oi.bd, experienceItemKey)) {
    addExperienceCandidate(
      absoluteCandidates,
      `$usrTot.oi.bd[${experienceItemKey}]`,
      updateUsr.oi.bd[experienceItemKey],
      invalidSources,
    );
  }

  const display = resolveDisplayExperienceDelta(updateUsr, invalidSources);
  const absoluteValues = [...new Set(
    absoluteCandidates.map((candidate) => candidate.value),
  )];
  const canonicalAbsoluteCandidates = absoluteCandidates.filter(
    (candidate) => (
      candidate.source === "$usrTot.data.lvlExp"
      || candidate.source === "$usrTot.oi.bd[2]"
    ),
  );
  const canonicalAbsoluteValues = [...new Set(
    canonicalAbsoluteCandidates.map((candidate) => candidate.value),
  )];
  const hasExperienceEvidence = absoluteCandidates.length > 0
    || display.deltaCandidates.length > 0
    || invalidSources.length > 0;
  let conflictReason = invalidSources.length
    ? "invalid-experience-evidence"
    : display.conflictReason;
  if (!conflictReason && absoluteValues.length > 1) {
    conflictReason = "absolute-experience-candidates-conflict";
  }
  if (
    !conflictReason
    && absoluteCandidates.length > 0
    && canonicalAbsoluteCandidates.length === 0
  ) {
    conflictReason = "unsupported-absolute-experience-source";
  }

  const authoritativeExp = canonicalAbsoluteValues.length
    ? canonicalAbsoluteValues[canonicalAbsoluteValues.length - 1]
    : null;
  let resolvedLevel = responseLevel ?? beforeLevel;
  let resolvedExp = beforeExp;
  let actualExpDelta = 0;
  let resolution = "no-experience-evidence";
  let regression = false;

  if (hasExperienceEvidence) {
    if (
      beforeLevel != null
      && responseLevel != null
      && responseLevel < beforeLevel
    ) {
      conflictReason ||= "experience-level-regression";
      resolvedLevel = beforeLevel;
      resolvedExp = beforeExp;
      resolution = "conflict-protective-upper-bound";
    } else if (
      beforeLevel != null
      && responseLevel != null
      && responseLevel > beforeLevel
    ) {
      if (authoritativeExp == null) {
        conflictReason ||= "level-up-without-authoritative-experience";
        resolvedLevel = beforeLevel;
        resolvedExp = beforeExp;
        resolution = "conflict-protective-upper-bound";
      } else {
        resolvedLevel = responseLevel;
        resolvedExp = authoritativeExp;
        actualExpDelta = display.deduplicatedDelta;
        resolution = "authoritative-level-up";
      }
    } else if (authoritativeExp != null) {
      const absoluteDelta = beforeExp == null ? null : authoritativeExp - beforeExp;
      resolvedExp = authoritativeExp;
      actualExpDelta = absoluteDelta;
      resolution = "authoritative-absolute";
      if (beforeExp != null && authoritativeExp < beforeExp) {
        regression = true;
        conflictReason ||= "same-level-experience-regression";
        resolvedExp = beforeExp;
        resolution = "conflict-protective-upper-bound";
      } else if (
        absoluteDelta != null
        && display.deduplicatedDelta != null
        && absoluteDelta !== display.deduplicatedDelta
      ) {
        conflictReason ||= "absolute-delta-mismatch";
      }
    } else if (display.deduplicatedDelta != null) {
      actualExpDelta = display.deduplicatedDelta;
      conflictReason ||= "missing-authoritative-experience";
      resolution = "display-delta-only";
    }
  }

  if (conflictReason && !regression && resolution !== "authoritative-level-up") {
    const sameLevelUpperCandidates = [
      beforeExp,
      ...canonicalAbsoluteValues,
    ].filter((value) => value != null);
    resolvedExp = sameLevelUpperCandidates.length
      ? Math.max(...sameLevelUpperCandidates)
      : resolvedExp;
  }

  return {
    beforeLevel,
    beforeExp,
    responseLevel,
    absoluteCandidates,
    deltaCandidates: display.deltaCandidates,
    deduplicatedDelta: display.deduplicatedDelta,
    resolvedLevel,
    resolvedExp,
    actualExpDelta,
    resolution,
    conflict: Boolean(conflictReason),
    conflictReason,
    regression,
  };
}

function applyResolvedExperience(syncValue, evidence) {
  if (
    evidence?.resolvedLevel == null
    && evidence?.resolvedExp == null
  ) {
    return syncValue;
  }
  const out = { ...(syncValue || {}) };
  const usrTot = { ...(out.$usrTot || {}) };
  const dataKey = usrTot.data ? "data" : usrTot.usr ? "usr" : "data";
  const data = { ...(usrTot[dataKey] || {}) };
  if (evidence.resolvedLevel != null) data.lvl = evidence.resolvedLevel;
  if (evidence.resolvedExp != null) data.lvlExp = evidence.resolvedExp;
  usrTot[dataKey] = data;
  out.$usrTot = usrTot;
  return out;
}

export function mergeExperienceSync(base, update) {
  if (!update) return base;
  const out = mergeNobleSessionFields(base, update, { ...(base || {}) });
  if (hasOwn(update, "c_lvl")) out.c_lvl = update.c_lvl;
  return applyResolvedExperience(
    out,
    parseExperienceSettlementEvidence(base, update),
  );
}

export function mergeGameSync(base, update) {
  if (!update) return base;
  let out = mergeNobleSessionFields(base, update, { ...base, ...update });
  const experienceEvidence = parseExperienceSettlementEvidence(base, update);

  if (base?.$usrTot || update?.$usrTot || update?.itemAddChg || update?.oi) {
    out.$usrTot = mergeUsrTot(base?.$usrTot || {}, getUsrMergeUpdate(update));
    out = applyResolvedExperience(out, experienceEvidence);
  }

  if (base?.usrLandTot || update?.usrLandTot) {
    out.usrLandTot = mergeUsrLandTot(base?.usrLandTot || {}, update?.usrLandTot || {});
  }

  if (base?.orderFlowerTot || update?.orderFlowerTot) {
    out.orderFlowerTot = mergeOrderFlowerTot(base?.orderFlowerTot || {}, update?.orderFlowerTot || {});
  }

  if (base?.orderTeamTot || update?.orderTeamTot) {
    out.orderTeamTot = mergeOrderTeamTot(base?.orderTeamTot || {}, update?.orderTeamTot || {});
  }

  if (base?.orderCustomerTot || update?.orderCustomerTot) {
    out.orderCustomerTot = mergeOrderCustomerTot(base?.orderCustomerTot || {}, update?.orderCustomerTot || {});
  }

  if (base?.orderPalaceTot || update?.orderPalaceTot) {
    out.orderPalaceTot = mergeOrderPalaceTot(base?.orderPalaceTot || {}, update?.orderPalaceTot || {});
  }

  if (base?.flowerArtTot || update?.flowerArtTot) {
    out.flowerArtTot = mergeFlowerArtTot(base?.flowerArtTot || {}, update?.flowerArtTot || {});
  }

  if (base?.actTot || update?.actTot) {
    out.actTot = mergeActTot(base?.actTot || {}, update?.actTot || {});
  }

  if (base?.pearlTot || update?.pearlTot) {
    out.pearlTot = mergePearlTot(base?.pearlTot || {}, update?.pearlTot || {});
  }

  if (base?.flowerRackTot || update?.flowerRackTot) {
    out.flowerRackTot = mergeFlowerRackTot(base?.flowerRackTot || {}, update?.flowerRackTot || {});
  }

  if (base?.fmlTot || update?.fmlTot) {
    out.fmlTot = mergeFmlTot(base?.fmlTot || {}, update?.fmlTot || {});
  }

  if (base?.shopCultivate || update?.shopCultivate) {
    out.shopCultivate = mergeShopCultivate(base?.shopCultivate || {}, update?.shopCultivate || {});
  }

  if (base?.cultivateTot || update?.cultivateTot) {
    out.cultivateTot = mergeCultivateTot(base?.cultivateTot || {}, update?.cultivateTot || {});
  }

  if (base?.videoDouble || update?.videoDouble) {
    out.videoDouble = {
      ...(base?.videoDouble || {}),
      ...(update?.videoDouble || {}),
    };
  }

  if (base?.waterwheel || update?.waterwheel) {
    out.waterwheel = mergeWaterwheel(base?.waterwheel || {}, update?.waterwheel || {});
  }

  if (base?.taskTot || update?.taskTot) {
    out.taskTot = mergeTaskTot(base?.taskTot || {}, update?.taskTot || {});
  }

  if (base?.$taskTot || update?.$taskTot) {
    out.$taskTot = mergeTaskTot(base?.$taskTot || {}, update?.$taskTot || {});
  }

  if (base?.mainTaskTot || update?.mainTaskTot) {
    out.mainTaskTot = mergeTaskTot(base?.mainTaskTot || {}, update?.mainTaskTot || {});
  }

  if (base?.$mainTaskTot || update?.$mainTaskTot) {
    out.$mainTaskTot = mergeTaskTot(base?.$mainTaskTot || {}, update?.$mainTaskTot || {});
  }

  return out;
}

export function removeCustomerOrder(sync, npcId) {
  if (!sync || npcId == null) return sync;
  const key = String(npcId);
  let out = sync;

  if (sync.orderCustomerTot?.orderCustomer?.orderMap) {
    const orderMap = { ...sync.orderCustomerTot.orderCustomer.orderMap };
    delete orderMap[key];
    out = {
      ...out,
      orderCustomerTot: {
        ...out.orderCustomerTot,
        orderCustomer: {
          ...out.orderCustomerTot.orderCustomer,
          orderMap,
        },
      },
    };
  }

  if (sync.orderCustomer?.orderMap) {
    const orderMap = { ...sync.orderCustomer.orderMap };
    delete orderMap[key];
    out = {
      ...out,
      orderCustomer: {
        ...out.orderCustomer,
        orderMap,
      },
    };
  }

  return out;
}

export function summarizePlantCandidates(sync) {
  const cultivateMap = sync?.cultivateTot?.cultivateMap || {};
  const bag = getBag(sync);
  const palaceNeeds = getPalaceOrderFlowerNeeds(sync);
  return Object.entries(cultivateMap)
    .map(([flowerId, item]) => {
      const resolvedFlowerId = Number(item?.flowerId || flowerId);
      const count = toNumber(bag[item?.flowerId] ?? bag[String(item?.flowerId)] ?? bag[flowerId]);
      const palaceNeed = palaceNeeds.get(resolvedFlowerId);
      return {
        flowerId: resolvedFlowerId,
        lvl: item?.lvl,
        cTime: item?.cTime || null,
        count,
        palaceOrderNeed: palaceNeed?.need || 0,
        palaceOrderHave: palaceNeed?.have ?? count,
        palaceOrderMissing: palaceNeed?.missing || 0,
        plantPriorityReason: palaceNeed?.missing > 0 ? "palace-order-shortage" : "inventory-low",
      };
    })
    .filter((item) => item.flowerId && item.lvl >= 2)
    .sort((a, b) => {
      const palaceRank = Number(b.palaceOrderMissing > 0) - Number(a.palaceOrderMissing > 0);
      return palaceRank
        || b.palaceOrderMissing - a.palaceOrderMissing
        || a.count - b.count
        || a.flowerId - b.flowerId;
    });
}

export function getFlowerInventory(sync, flowerLevelConfig = loadFlowerLevelConfig()) {
  const bag = getBag(sync);
  const cultivateMap = sync?.cultivateTot?.cultivateMap || {};
  const land = summarizeLand(sync);
  const flowerIds = new Set();
  for (const id of Object.keys(cultivateMap)) flowerIds.add(Number(id));
  for (const row of land.rows) {
    if (row.flowerId) flowerIds.add(Number(row.flowerId));
  }
  for (const id of Object.keys(bag)) {
    const n = Number(id);
    if (n >= 23000 && n < 24000) flowerIds.add(n);
  }
  return [...flowerIds]
    .filter(Boolean)
    .map((flowerId) => {
      const cultivate = cultivateMap[flowerId] || cultivateMap[String(flowerId)] || {};
      const plantedCount = land.rows.filter((row) => row.flowerId === flowerId && !row.empty).length;
      const hasCultivateLevel = cultivate.lvl != null && cultivate.lvl !== "";
      const maturity = hasCultivateLevel
        ? getFlowerLevelInfo(flowerId, cultivate.lvl, flowerLevelConfig, cultivate)
        : {
            seconds: null,
            rawCd: null,
            timeStep: null,
            source: "missing",
            advanceHarvestIntervalReductionSeconds: 0,
            advanceEffects: {},
            advanceSlots: [],
          };
      return {
        flowerId,
        count: toNumber(bag[flowerId] ?? bag[String(flowerId)]),
        lvl: cultivate.lvl ?? "",
        plantedCount,
        cTime: cultivate.cTime || "",
        maturitySeconds: maturity.seconds,
        maturityRawCd: maturity.rawCd,
        maturityTimeStep: maturity.timeStep,
        maturitySource: maturity.source,
        advanceHarvestIntervalReductionSeconds: maturity.advanceHarvestIntervalReductionSeconds ?? 0,
        advanceEffects: maturity.advanceEffects || {},
        advanceSlots: maturity.advanceSlots || [],
      };
    })
    .sort((a, b) => a.count - b.count || a.flowerId - b.flowerId);
}

export function getCultivatedFlowerInventory(sync, flowerLevelConfig = loadFlowerLevelConfig()) {
  return getFlowerInventory(sync, flowerLevelConfig)
    .filter((item) => item.flowerId)
    .filter((item) => toNumber(item.lvl) > 1)
    .sort((a, b) => a.count - b.count || a.flowerId - b.flowerId);
}

export function getState(syncValue, nowMs = Date.now()) {
  const resolvedNowMs = resolveNowMs(nowMs);
  const land = summarizeLand(syncValue, resolvedNowMs);
  const candidates = summarizePlantCandidates(syncValue);
  const recommendation = {
    harvestLandIds: land.mature.map((item) => item.landId),
    emptyLandIds: land.empty,
    plantFlower: candidates[0] || null,
    candidateTop5: candidates.slice(0, 5),
  };
  return { land, candidates, recommendation };
}
