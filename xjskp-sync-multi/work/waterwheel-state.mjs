import fs from "node:fs";
import {
  decodeConfigRows,
  findConfigTable,
} from "./flower-level-config.mjs";
import { getWaterDropStatus } from "./garden-state.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";
import {
  readAndAdvanceWaterwheelBucketState,
} from "./waterwheel-bucket-state.mjs";

export const WATERWHEEL_IFACES = {
  enter: "gs.waterwheel.enter",
  recv: "gs.waterwheel.recv",
  skip: "gs.waterwheel.skip",
};

export const DEFAULT_WATERWHEEL_THRESHOLD = 16;

const DEFAULT_STATIC_CONFIG_PATH = getDefaultStaticConfigPath();
const WATERWHEEL_CFG_TABLE = "c_waterwheel";
const DEFAULT_WATERWHEEL_CONFIG = {
  bucketCreateCd: null,
  bucketExistMax: null,
  bucketGetMax: null,
  bucketWaterRangeText: null,
  bucketWaterMin: null,
  bucketWaterMax: null,
  bucketShareId: null,
};

const configCache = new Map();

function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeNumberList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => toNumber(item, null))
    .filter((item) => item != null);
}

function loadWaterwheelMeta(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const table = findConfigTable(config, WATERWHEEL_CFG_TABLE);
  const rows = decodeConfigRows(table, WATERWHEEL_CFG_TABLE);
  return rows.find((row) => toNumber(row.id, 0) < 0) || rows[0] || {};
}

function normalizeWaterReward(bucketWaterNum) {
  const values = (Array.isArray(bucketWaterNum) ? bucketWaterNum : [])
    .map((row) => Array.isArray(row) ? toNumber(row[1], null) : null)
    .filter((item) => item != null);
  if (!values.length) {
    return {
      bucketWaterMin: null,
      bucketWaterMax: null,
      bucketWaterRangeText: null,
    };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  return {
    bucketWaterMin: min,
    bucketWaterMax: max,
    bucketWaterRangeText: `${min}-${max}`,
  };
}

export function loadWaterwheelConfig(filePath = DEFAULT_STATIC_CONFIG_PATH) {
  if (configCache.has(filePath)) return configCache.get(filePath);

  const meta = loadWaterwheelMeta(filePath);
  const reward = normalizeWaterReward(meta.$bucketWaterNum);
  const loaded = {
    sourcePath: filePath,
    tableName: WATERWHEEL_CFG_TABLE,
    bucketCreateCd: toNumber(meta.$bucketCreateCd, null),
    bucketExistMax: toNumber(meta.$bucketExistMax, null),
    bucketGetMax: toNumber(meta.$bucketGetMax, null),
    bucketWaterRangeText: reward.bucketWaterRangeText,
    bucketWaterMin: reward.bucketWaterMin,
    bucketWaterMax: reward.bucketWaterMax,
    bucketShareId: toNumber(meta.$bucketShareId, null),
  };
  configCache.set(filePath, loaded);
  return loaded;
}

function safeLoadWaterwheelConfig(options = {}) {
  if (Object.hasOwn(options, "config")) {
    const config = options.config || {};
    const reward = config.bucketWaterNum
      ? normalizeWaterReward(config.bucketWaterNum)
      : {
          bucketWaterMin: toNumber(config.bucketWaterMin, null),
          bucketWaterMax: toNumber(config.bucketWaterMax, null),
          bucketWaterRangeText: config.bucketWaterRangeText || null,
        };
    return { ...DEFAULT_WATERWHEEL_CONFIG, ...config, ...reward };
  }
  try {
    return loadWaterwheelConfig(options.configPath || DEFAULT_STATIC_CONFIG_PATH);
  } catch {
    return DEFAULT_WATERWHEEL_CONFIG;
  }
}

export function getWaterwheelState(sync) {
  return sync?.waterwheel || sync?.waterwheelTot?.waterwheel || {};
}

export function summarizeWaterwheelStatus(sync, options = {}) {
  const config = safeLoadWaterwheelConfig(options);
  const nowMs = options.nowMs ?? Date.now();
  const autoReceiveEnabled = options.autoReceiveEnabled !== false;
  const configuredSkipVideoBucketsEnabled = options.skipVideoBuckets === true;
  const skipVideoBucketsEnabled = autoReceiveEnabled && configuredSkipVideoBucketsEnabled;
  const state = getWaterwheelState(sync);
  const exists = Boolean(state && Object.keys(state).length);
  const waterDrop = getWaterDropStatus(sync, nowMs);
  const threshold = Math.max(0, toNumber(options.waterDropThreshold, DEFAULT_WATERWHEEL_THRESHOLD));
  const plantWaterRefill = options.plantWaterRefill || null;
  const requiresPlantWaterRefill = Boolean(plantWaterRefill);
  const hasPlantWaterNeed = !requiresPlantWaterRefill || Boolean(plantWaterRefill.needsPlanting);
  const claimedBucketCount = Math.max(0, toNumber(state.count, 0));
  const maxBucketCount = Math.max(0, toNumber(config.bucketGetMax, 0));
  const remainingDailyBucketCount = Math.max(0, maxBucketCount - claimedBucketCount);
  const bucketState = readAndAdvanceWaterwheelBucketState(sync, {
    ...options,
    config,
    claimedBucketCount,
    nowMs,
  });
  const storedBucketCount = Math.max(0, toNumber(bucketState.storedBucketCount, 0));
  const storedBucketMax = Math.max(0, toNumber(config.bucketExistMax, 0));
  const storedBucketCapacity = Math.max(0, toNumber(bucketState.storageCapacity, 0));
  const storedBucketAvailable = Math.max(0, storedBucketCapacity - storedBucketCount);
  const nextBucketNo = storedBucketCount > 0 && remainingDailyBucketCount > 0
    ? claimedBucketCount + 1
    : null;
  const videoBucketList = normalizeNumberList(state.advList);
  const nextBucketIsVideo = nextBucketNo != null && videoBucketList.includes(nextBucketNo);
  const waterDropLow = hasPlantWaterNeed && waterDrop.count < threshold;
  const nextBucketGenerationAtMs = Number.isSafeInteger(bucketState.state?.nextGenerationAtMs)
    ? bucketState.state.nextGenerationAtMs
    : null;
  const nextBucketGenerationInMs = nextBucketGenerationAtMs == null
    ? null
    : Math.max(0, nextBucketGenerationAtMs - nowMs);
  const nextBucketGenerationInSeconds = nextBucketGenerationInMs == null
    ? null
    : Math.ceil(nextBucketGenerationInMs / 1000);
  const nextBucketGenerationAt = nextBucketGenerationAtMs == null
    ? null
    : new Date(nextBucketGenerationAtMs).toISOString();

  let reason = "ready";
  let reasonText = "可领取普通水桶";
  if (!exists) {
    reason = "no-waterwheel-state";
    reasonText = "暂无水车状态";
  } else if (!autoReceiveEnabled) {
    reason = options.autoReceiveDisabledReason || "profile-setting-disabled";
    reasonText = options.autoReceiveDisabledReasonText || "账号已关闭领取水车水桶";
  } else if (!hasPlantWaterNeed) {
    reason = plantWaterRefill?.reason || "no-planting-need";
    reasonText = plantWaterRefill?.reasonText || "当前没有需要种植的土地组";
  } else if (!waterDropLow) {
    reason = "water-drop-not-low";
    reasonText = `当前水滴 ${waterDrop.count} >= ${threshold}`;
  } else if (remainingDailyBucketCount <= 0) {
    reason = "no-bucket-remaining";
    reasonText = "今日水桶已到上限";
  } else if (storedBucketCount <= 0) {
    reason = "no-generated-bucket";
    reasonText = "暂无已生成水桶，等待本地生成";
  } else if (nextBucketIsVideo && !skipVideoBucketsEnabled) {
    reason = "next-bucket-video-retained";
    reasonText = "下一桶是视频桶，保留不领取";
  } else if (nextBucketIsVideo) {
    reason = "ready-video-base";
    reasonText = "可跳过视频并领取当前桶基础水滴";
  }

  const canReceive = reason === "ready" || reason === "ready-video-base";
  const pendingActions = canReceive
    ? [nextBucketIsVideo
      ? {
          type: "receiveWaterwheelVideoBucketBase",
          nextBucketNo,
          steps: [
            {
              stage: "skip-video-requirement",
              iface: WATERWHEEL_IFACES.skip,
              args: {},
            },
            {
              stage: "receive-base-reward",
              iface: WATERWHEEL_IFACES.recv,
              args: {},
            },
          ],
        }
      : {
          type: "recvWaterwheelBucket",
          iface: WATERWHEEL_IFACES.recv,
          args: {},
          nextBucketNo,
        }]
    : [];

  return {
    exists,
    state,
    waterDrop,
    waterDropCount: waterDrop.count,
    waterDropText: `${waterDrop.count}/${waterDrop.displayLimit}`,
    threshold,
    waterDropLow,
    autoReceiveEnabled,
    configuredSkipVideoBucketsEnabled,
    skipVideoBucketsEnabled,
    claimedBucketCount,
    maxBucketCount,
    remainingDailyBucketCount,
    // Compatibility alias: this is today's server claim quota, never local storage.
    remainingBucketCount: remainingDailyBucketCount,
    storedBucketCount,
    storedBucketMax,
    storedBucketCapacity,
    storedBucketAvailable,
    bucketStatePath: bucketState.statePath,
    bucketStatePersistenceStatus: bucketState.persistenceStatus,
    bucketStateInvalidReason: bucketState.invalidReason,
    nextBucketGenerationAtMs,
    nextBucketGenerationAt,
    nextBucketGenerationInMs,
    nextBucketGenerationInSeconds,
    nextBucketNo,
    nextBucketIsVideo,
    nextBucketVideoText: nextBucketNo == null ? "-" : nextBucketIsVideo ? "是" : "否",
    videoBucketList,
    plantWaterRefill,
    bucketWaterRangeText: config.bucketWaterRangeText || "-",
    bucketWaterMin: config.bucketWaterMin,
    bucketWaterMax: config.bucketWaterMax,
    bucketExistMax: config.bucketExistMax,
    bucketCreateCd: config.bucketCreateCd,
    bucketShareId: config.bucketShareId,
    canReceive,
    pendingActions,
    reason,
    reasonText,
  };
}

export function getAutoWaterwheelActions(status) {
  return status?.canReceive ? [...(status.pendingActions || [])] : [];
}

export function getWaterwheelReceiveSyncState(beforeStatus, afterStatus) {
  const beforeWater = toNumber(beforeStatus?.waterDropCount, 0);
  const afterWater = toNumber(afterStatus?.waterDropCount, 0);
  if (afterWater > beforeWater) {
    return "synced";
  }

  const beforeClaimed = toNumber(beforeStatus?.claimedBucketCount, 0);
  const afterClaimed = toNumber(afterStatus?.claimedBucketCount, 0);
  const beforeRemaining = toNumber(
    beforeStatus?.remainingDailyBucketCount ?? beforeStatus?.remainingBucketCount,
    0,
  );
  const afterRemaining = toNumber(
    afterStatus?.remainingDailyBucketCount ?? afterStatus?.remainingBucketCount,
    0,
  );
  if (afterClaimed > beforeClaimed || afterRemaining < beforeRemaining) {
    return "pending-water-sync";
  }

  return "unchanged";
}

export function isWaterwheelDeltaOutOfExpectedRange(beforeStatus, afterStatus) {
  const beforeWater = toNumber(beforeStatus?.waterDropCount, 0);
  const afterWater = toNumber(afterStatus?.waterDropCount, 0);
  const delta = afterWater - beforeWater;
  if (delta <= 0) return false;

  const bucketWaterMax = toNumber(beforeStatus?.bucketWaterMax ?? afterStatus?.bucketWaterMax, 0);
  return bucketWaterMax > 0 && delta > bucketWaterMax;
}
