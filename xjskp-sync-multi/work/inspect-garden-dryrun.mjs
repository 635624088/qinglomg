import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertGameDataSyncStartAllowed } from "./system/game-data-sync-lock.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";
import { loadAccountLevelConfig } from "./account-level-config.mjs";
import { writeStatusArtifacts } from "./status-artifact-writer.mjs";
import { buildStatusArtifactFingerprint } from "./status-artifact-fingerprint.mjs";
import { summarizeArtifactSubmission } from "./runtime-artifact-completion.mjs";
import {
  loadFlowerLevelConfig,
} from "./flower-level-config.mjs";
import { getFlowerUpgradeCandidates } from "./flower-upgrade-state.mjs";
import {
  createAutomationModuleHealthRegistry,
  resolvePersistentCycleErrors,
} from "./automation-module-health.mjs";
import { createAccountScheduler } from "./account-scheduler.mjs";
import {
  CUSTOMER_ORDER_GENERATION_DELAY_MS,
  CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS,
  createCustomerOrderScheduler,
} from "./customer-order-scheduler.mjs";
import {
  getLoopIntervalConfig,
  getLoopSleepSeconds,
} from "./loop-interval.mjs";
import {
  flowerName,
  formatAccountLevelProgress,
  formatDateTime,
  formatDuration,
  formatFlowerLabel,
  formatWanNumber,
  loadFlowerNameMap,
} from "./status-format.mjs";
import {
  escHtml,
  formatMaturitySeconds,
  formatPlainSeconds,
  mdCell,
} from "./status-format-html.mjs";
import {
  buildLoopRefreshWaterDropFlow,
  buildWaterDropFlow,
  decorateWaterDropStatus,
} from "./water-drop-status.mjs";
import {
  clampWaterDropCount,
  getCultivatedFlowerInventory,
  getBag,
  getDoubleGoldStatus as getBaseDoubleGoldStatus,
  getFlowerInventory,
  getGardenResourceStatus,
  getItemCount,
  ITEM_IDS,
  getState as getBaseState,
  getWaterDropStatus as getBaseWaterDropStatus,
  mergeExperienceSync,
  mergeGameSync as mergeLandSync,
  parseExperienceSettlementEvidence,
  removeCustomerOrder,
  setWaterDropCount,
  summarizeLand as summarizeBaseLand,
  summarizePlantCandidates,
} from "./garden-state.mjs";
import {
  attachHardSyncState,
  attachTimeAuthorityState,
  createTimeAuthority,
  getTimeAuthoritySnapshot,
} from "./time-authority.mjs";
import {
  ORDER_CUSTOMER_IFACES,
  ORDER_PALACE_IFACES,
  CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD_VALUES,
  DEFAULT_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD_RELEASE_MASK,
  getCustomerOrderFlowerCurrencyRewardReleaseRewards,
  getAutoSubmitOrdinaryResidentOrderActions,
  getAutoSubmitCustomerOrderActions,
  getAutoSubmitOrderActions,
  getAutoSubmitPalaceOrderActions,
  loadItemNameMap,
  loadOrderFlowerConfig,
  loadOrderCustomerNpcConfig,
  markOrdinaryResidentOrderRefill,
  markSpecialOrderStockRejection,
  summarizeFlowerArtInventory,
  summarizeOrderCustomerStatus,
  summarizeOrderFlowerStatus,
  summarizeOrderPalaceStatus,
  normalizeCustomerOrderFlowerCurrencyRewardReleaseMask,
} from "./order-state.mjs";
import {
  createRunHistory,
  describeCustomerOrderAction,
  recordCustomerOrderCheck,
  recordCustomerOrderSubmission,
} from "./run-history.mjs";
import {
  getAccountCustomerOrderFlowerCurrencyHistory,
  loadCustomerOrderFlowerCurrencyHistory,
  resolveCustomerOrderFlowerCurrencyHistoryPath,
  updateCustomerOrderFlowerCurrencyHistory,
} from "./customer-order-flower-currency-history.mjs";
import { writeOrderStatusDocument } from "./order-status-document.mjs";
import {
  PEARL_IFACES,
  getAutoPearlActions,
  summarizePearlStatus,
} from "./pearl-state.mjs";
import {
  attachFlowerRackRecommendations,
  summarizeFlowerRackStatus,
} from "./flower-rack-state.mjs";
import {
  DEFAULT_MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO,
  DEFAULT_MATERIAL_SHOP_REFRESH_WINDOW_END,
  DEFAULT_MATERIAL_SHOP_REFRESH_WINDOW_START,
  HARD_MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO,
  MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO_OPTIONS,
  MATERIAL_SHOP_IFACES,
  getMaterialShopMidnightRefreshPlan,
  summarizeMaterialShopStatus,
  verifyMaterialShopRefreshOutcome,
} from "./material-shop-state.mjs";
import {
  FML_LAND_IFACES,
  getFmlLandHarvestPlan,
  getFmlLandScanIntervalMs,
  shouldScanFmlLand,
  summarizeFmlLandStatus,
} from "./fml-land-state.mjs";
import {
  DEFAULT_FREE_WATER_THRESHOLD,
  FREE_WATER_IFACES,
  summarizeFreeWaterStatus,
} from "./free-water-state.mjs";
import {
  WATERWHEEL_IFACES,
  getAutoWaterwheelActions,
  getWaterwheelReceiveSyncState,
  isWaterwheelDeltaOutOfExpectedRange,
  summarizeWaterwheelStatus,
} from "./waterwheel-state.mjs";
import {
  consumeWaterwheelBucket,
  readAndAdvanceWaterwheelBucketState,
} from "./waterwheel-bucket-state.mjs";
import {
  getFlowerAcquisitionInfo,
  getFlowerCultivationCostInfo,
} from "./flower-source-state.mjs";
import {
  MAIN_TASK_IFACES,
  getAutoSubmitMainTaskActions,
  summarizeMainTaskStatus,
} from "./main-task-state.mjs";
import {
  CYCLIC_NOTE_IFACES,
  summarizeCyclicNoteStatus,
} from "./cyclic-note-state.mjs";
import {
  getCyclicNoteNaturalRoutePolicy,
  planCyclicNoteNaturalCompletion,
} from "./cyclic-note-natural-completion.mjs";
import {
  CYCLIC_STORY_IFACES,
  CYCLIC_STORY_MAX_SUBMIT_PER_CYCLE,
  getAutoSubmitCyclicStoryActions,
  summarizeCyclicStoryStatus,
} from "./cyclic-story-state.mjs";
import { readActiveGameRelease } from "./game-release-version.mjs";
import {
  evaluateTeamOrderCapability,
  getTeamOrderNobleExpAdd,
  loadTeamOrderConfig,
  selectEarliestStoredOrder,
  summarizeTeamOrder,
} from "./team-order-state.mjs";
import { createTeamOrderRunner } from "./team-order-runner.mjs";
import {
  createTeamOrderArchive,
  createTeamOrderRunId,
} from "./team-order-archive.mjs";
import { readAutomationStopRequest } from "./automation-stop.mjs";
import {
  createAccountCommandGateway,
  createExperienceCommandClient,
  isAccountCommandGateway,
} from "./account-command-gateway.mjs";
import {
  createPersistentExperienceLevelGuard,
  resolveExperienceGuardStatePath,
} from "./experience-guard-state.mjs";
import {
  DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT,
  DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER,
  calculateExperienceGuardThreshold,
  classifyExperienceInterface,
  estimateExperienceAction,
  evaluateExperienceAction,
  isValidExperienceGuardThresholdPercent,
  isValidTeamOrderGuardMultiplier,
  loadExperienceSettlementConfig,
  markNobleSessionState,
  NOBLE_SESSION_STATE_FIELD,
} from "./experience-settlement.mjs";
import {
  evaluateTeamOrderTrigger,
  getAccountTeamOrderExperienceHistory,
  loadTeamOrderExperienceHistory,
  recordCompletedTeamOrderExperience,
  saveTeamOrderExperienceHistory,
} from "./team-order-experience-history.mjs";

const PLANT_SELECTION_RULE_TEXT = "palace order flower shortages first, then owned flower inventory count ascending, then flowerId ascending";
const DEFAULT_PROFILE_SETTINGS = {
  autoReceiveWaterwheelBuckets: true,
  skipWaterwheelVideoBuckets: false,
  autoSubmitOrdinaryResidentOrdersForLevelUp: false,
  experienceGuardThresholdPercent: DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT,
  materialShopMidnightRefreshEnabled: false,
  materialShopRefreshWindowStart: DEFAULT_MATERIAL_SHOP_REFRESH_WINDOW_START,
  materialShopRefreshMaxCostYuanbao: DEFAULT_MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO,
  pearlHireItemReserveCount: 100,
  teamOrderTriggerProtectionEnabled: true,
  teamOrderPaidRenewProtectionEnabled: true,
  teamOrderGuardMultiplier: DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER,
  autoSubmitCyclicStoryOrders: false,
  cyclicStoryOnlyHighestExperienceOrder: false,
  customerOrderFlowerCurrencyRewardReleaseMask:
    DEFAULT_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD_RELEASE_MASK,
};
const WATER_DROP_AUTHORITY_FIELD = "__xjskpWaterDropAuthority";
const ACCOUNT_MODULE_INTERVAL_MS = Object.freeze({
  flowerUpgrade: 5 * 60 * 1000,
  fmlLand: 2 * 60 * 1000,
  flowerRack: 2 * 60 * 1000,
  pearl: 5 * 60 * 1000,
  materialShop: 5 * 60 * 1000,
  cyclicStory: 2 * 60 * 1000,
  cyclicNote: 2 * 60 * 1000,
});
const STATUS_DOCUMENT_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000;
let activeAutomationModuleHealth = null;
let lastGardenArtifactCompletion = null;
const statusDocumentContextCache = new Map();

function getTrustedGardenNowMs(timeAuthority, localNowMs) {
  const fallbackNowMs = Number.isFinite(localNowMs) ? localNowMs : Date.now();
  const snapshot = getTimeAuthoritySnapshot(timeAuthority, { nowMs: fallbackNowMs });
  if (snapshot.trusted && Number.isFinite(snapshot.correctedNowMs)) {
    return snapshot.correctedNowMs;
  }
  if (!Object.hasOwn(timeAuthority || {}, "lastAcceptedSample")
    && timeAuthority?.trusted === true
    && Number.isFinite(timeAuthority.correctedNowMs)) {
    return timeAuthority.correctedNowMs;
  }
  return fallbackNowMs;
}

function resolveGardenNowMs(syncValue, timeInput) {
  if (typeof timeInput === "number") {
    return Number.isFinite(timeInput) ? timeInput : Date.now();
  }

  if (timeInput && typeof timeInput === "object") {
    const localNowMs = Number.isFinite(timeInput.nowMs) ? timeInput.nowMs : Date.now();
    const explicitAuthority = timeInput.timeAuthority
      || (Object.hasOwn(timeInput, "trusted") || Object.hasOwn(timeInput, "correctedNowMs")
        ? timeInput
        : null);
    return explicitAuthority
      ? getTrustedGardenNowMs(explicitAuthority, localNowMs)
      : localNowMs;
  }

  const localNowMs = Date.now();
  return getTrustedGardenNowMs(syncValue?.$timeAuthority, localNowMs);
}

function getResourceActionLocalNowMs(options = {}) {
  if (Object.hasOwn(options, "nowMs")) return options.nowMs;
  if (typeof options.nowFn === "function") {
    return options.nowFn();
  }
  if (typeof options.timeAuthorityNowFn === "function") {
    return options.timeAuthorityNowFn();
  }
  return Date.now();
}

function getTrustedResourceActionNowMs(timeAuthority, localNowMs) {
  if (!Number.isFinite(localNowMs)) return Number.NaN;
  const fallbackNowMs = localNowMs;
  const snapshot = getTimeAuthoritySnapshot(timeAuthority, {
    nowMs: fallbackNowMs,
  });
  return snapshot.trusted && Number.isFinite(snapshot.correctedNowMs)
    ? snapshot.correctedNowMs
    : fallbackNowMs;
}

function resolveResourceActionTime(syncValue, options = {}) {
  if (
    options.actionTime
    && typeof options.actionTime === "object"
    && Object.hasOwn(options.actionTime, "nowMs")
  ) {
    return options.actionTime;
  }
  const localNowMs = getResourceActionLocalNowMs(options);
  const timeAuthority = options.timeAuthority || syncValue?.$timeAuthority || null;
  const authoritySnapshot = getTimeAuthoritySnapshot(timeAuthority, {
    nowMs: localNowMs,
  });
  const trusted = Boolean(
    authoritySnapshot.trusted
    && Number.isFinite(authoritySnapshot.correctedNowMs),
  );
  return {
    localNowMs,
    nowMs: trusted ? authoritySnapshot.correctedNowMs : localNowMs,
    timeAuthority,
    timeTrusted: trusted,
    clockSource: trusted
      ? authoritySnapshot.clockSource
      : "local-fallback",
    timeAuthorityReason: trusted
      ? null
      : authoritySnapshot.rejectionReason || "no-trusted-time-authority",
  };
}

export function getResourceActionNowMs(syncValue, options = {}) {
  return resolveResourceActionTime(syncValue, options).nowMs;
}

function getState(syncValue, timeInput) {
  return getBaseState(syncValue, resolveGardenNowMs(syncValue, timeInput));
}

function summarizeLand(syncValue, timeInput) {
  return summarizeBaseLand(syncValue, resolveGardenNowMs(syncValue, timeInput));
}

function getWaterDropStatus(syncValue, timeInput) {
  return getBaseWaterDropStatus(syncValue, resolveGardenNowMs(syncValue, timeInput));
}

function getDoubleGoldStatus(syncValue, timeInput) {
  return getBaseDoubleGoldStatus(syncValue, resolveGardenNowMs(syncValue, timeInput));
}

function formatConsoleArgForLog(arg) {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function installDirectLogTee() {
  if (process.env.XJSKP_MANAGED_LOGGING === "1") return;
  const logPath = process.env.AUTO_PLANT_LOG_PATH;
  if (!logPath) return;

  const wrap = (method) => {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      try {
        fs.appendFileSync(logPath, `${args.map(formatConsoleArgForLog).join(" ")}\n`, "utf8");
      } catch {
        // Keep automation running even if the log file is temporarily unavailable.
      }
      original(...args);
    };
  };

  wrap("log");
  wrap("warn");
  wrap("error");
}

installDirectLogTee();

function normalizeProfileSettings(settings = {}) {
  const hasNewSetting = Object.hasOwn(settings || {}, "autoSubmitOrdinaryResidentOrdersForLevelUp");
  const levelUpEnabled = hasNewSetting
    ? settings.autoSubmitOrdinaryResidentOrdersForLevelUp === true
    : settings?.autoSubmitOrdinaryResidentOrders === true;
  return {
    ...DEFAULT_PROFILE_SETTINGS,
    autoReceiveWaterwheelBuckets:
      typeof settings?.autoReceiveWaterwheelBuckets === "boolean"
        ? settings.autoReceiveWaterwheelBuckets
        : DEFAULT_PROFILE_SETTINGS.autoReceiveWaterwheelBuckets,
    skipWaterwheelVideoBuckets:
      typeof settings?.skipWaterwheelVideoBuckets === "boolean"
        ? settings.skipWaterwheelVideoBuckets
        : DEFAULT_PROFILE_SETTINGS.skipWaterwheelVideoBuckets,
    autoSubmitOrdinaryResidentOrdersForLevelUp: levelUpEnabled,
    autoSubmitOrdinaryResidentOrders: levelUpEnabled,
    autoSubmitCyclicStoryOrders: settings?.autoSubmitCyclicStoryOrders === true,
    cyclicStoryOnlyHighestExperienceOrder:
      settings?.cyclicStoryOnlyHighestExperienceOrder === true,
    autoHandleCyclicNote: settings?.autoHandleCyclicNote === true,
    autoCompleteCyclicNoteHighestRewardTask:
      settings?.autoCompleteCyclicNoteHighestRewardTask === true,
    customerOrderFlowerCurrencyRewardReleaseMask:
      normalizeCustomerOrderFlowerCurrencyRewardReleaseMask(
        settings?.customerOrderFlowerCurrencyRewardReleaseMask,
      ),
    experienceGuardThresholdPercent:
      isValidExperienceGuardThresholdPercent(settings?.experienceGuardThresholdPercent)
        ? settings.experienceGuardThresholdPercent
        : DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT,
    materialShopMidnightRefreshEnabled:
      settings?.materialShopMidnightRefreshEnabled === true,
    materialShopRefreshWindowStart:
      /^([01]\d|2[0-3]):[0-5]\d$/.test(settings?.materialShopRefreshWindowStart)
        ? settings.materialShopRefreshWindowStart
        : DEFAULT_MATERIAL_SHOP_REFRESH_WINDOW_START,
    materialShopRefreshMaxCostYuanbao:
      MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO_OPTIONS.includes(
        settings?.materialShopRefreshMaxCostYuanbao,
      )
        ? settings.materialShopRefreshMaxCostYuanbao
        : DEFAULT_MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO,
    pearlHireItemReserveCount: normalizePearlHireItemReserveCount(settings?.pearlHireItemReserveCount),
    teamOrderTriggerProtectionEnabled:
      settings?.teamOrderTriggerProtectionEnabled !== false,
    teamOrderPaidRenewProtectionEnabled:
      settings?.teamOrderPaidRenewProtectionEnabled !== false,
    teamOrderGuardMultiplier: isValidTeamOrderGuardMultiplier(
      settings?.teamOrderGuardMultiplier,
    )
      ? settings.teamOrderGuardMultiplier
      : DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER,
  };
}

function normalizePearlHireItemReserveCount(value, fallback = 100) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function readProfileAutomationSettings() {
  const settingsPath = process.env.PROFILE_SETTINGS_PATH;
  if (!settingsPath) return normalizeProfileSettings();
  try {
    return normalizeProfileSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  } catch (err) {
    console.warn(JSON.stringify({
      step: "profileSettingsReadWarning",
      path: settingsPath,
      message: err.message,
    }));
    return normalizeProfileSettings();
  }
}

function getPearlHireItemReserveCount() {
  return readProfileAutomationSettings().pearlHireItemReserveCount;
}

function getWaterwheelAutomationSetting() {
  const settings = readProfileAutomationSettings();
  const configuredAutoReceiveEnabled = settings.autoReceiveWaterwheelBuckets === true;
  const configuredSkipVideoBucketsEnabled = settings.skipWaterwheelVideoBuckets === true;
  const runtimeEnabled = process.env.AUTO_HANDLE_WATERWHEEL !== "0";
  const effectiveAutoReceiveEnabled = runtimeEnabled && configuredAutoReceiveEnabled;
  const effectiveSkipVideoBucketsEnabled = (
    effectiveAutoReceiveEnabled && configuredSkipVideoBucketsEnabled
  );
  const source = process.env.PROFILE_SETTINGS_PATH ? "profile-setting" : "profile-default";
  const reason = !runtimeEnabled
    ? "runtime-disabled"
    : configuredAutoReceiveEnabled
      ? null
      : "profile-setting-disabled";
  const reasonText = reason === "runtime-disabled"
    ? "AUTO_HANDLE_WATERWHEEL 已关闭水车自动处理"
    : reason === "profile-setting-disabled"
      ? "账号已关闭领取水车水桶"
      : null;

  return {
    configuredAutoReceiveEnabled,
    effectiveAutoReceiveEnabled,
    configuredSkipVideoBucketsEnabled,
    effectiveSkipVideoBucketsEnabled,
    source,
    reason,
    reasonText,
  };
}

function getExperienceGuardThresholdPercent() {
  return readProfileAutomationSettings().experienceGuardThresholdPercent;
}

function getTeamOrderGuardMultiplier() {
  return readProfileAutomationSettings().teamOrderGuardMultiplier;
}

function formatExperienceGuardThresholdPercent(value) {
  const thresholdPercent = isValidExperienceGuardThresholdPercent(value)
    ? value
    : DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT;
  return thresholdPercent.toFixed(2);
}

const ORDINARY_RESIDENT_SINGLE_SAMPLE_DISABLED_FLAGS = [
  "AUTO_SUBMIT_SPECIAL_ORDERS",
  "AUTO_SUBMIT_CUSTOMER_ORDERS",
  "AUTO_SUBMIT_PALACE_ORDERS",
  "AUTO_SUBMIT_MAIN_TASKS",
  "AUTO_HANDLE_TEAM_ORDERS",
  "AUTO_HANDLE_GARDEN_LAND",
  "AUTO_HANDLE_FLOWER_RACK",
  "AUTO_HANDLE_PEARL",
  "AUTO_HANDLE_FML_LAND",
  "AUTO_HANDLE_FREE_WATER",
  "AUTO_HANDLE_WATERWHEEL",
  "AUTO_HANDLE_MATERIAL_SHOP",
  "AUTO_WATER",
  "AUTO_SPEEDUP_FREE",
];

function resolveOrdinaryResidentSingleSampleValidation(env = process.env) {
  const requested = env.ORDINARY_RESIDENT_ORDER_SINGLE_SAMPLE === "1";
  if (!requested) {
    return {
      requested: false,
      enabled: false,
      reason: null,
      bypassSpecialOrderDailyLimit: false,
    };
  }

  const unsafeReasons = [];
  if (env.ACTION !== "auto-loop") unsafeReasons.push("ACTION must be auto-loop");
  if (Number(env.MAX_CYCLES) !== 1) unsafeReasons.push("MAX_CYCLES must be 1");
  if (Number(env.ORDINARY_RESIDENT_ORDER_MAX_STEPS_PER_CYCLE) !== 1) {
    unsafeReasons.push("ORDINARY_RESIDENT_ORDER_MAX_STEPS_PER_CYCLE must be 1");
  }
  if (env.AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS !== "1") {
    unsafeReasons.push("AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS must be 1");
  }
  for (const key of ORDINARY_RESIDENT_SINGLE_SAMPLE_DISABLED_FLAGS) {
    if (env[key] !== "0") unsafeReasons.push(`${key} must be 0`);
  }
  if (unsafeReasons.length) {
    const error = new Error(
      `Unsafe ordinary resident single-sample runtime: ${unsafeReasons.join("; ")}`,
    );
    error.code = "ORDINARY_RESIDENT_SINGLE_SAMPLE_UNSAFE";
    error.reasons = unsafeReasons;
    throw error;
  }

  return {
    requested: true,
    enabled: true,
    reason: "single-sample-validation",
    bypassSpecialOrderDailyLimit: true,
  };
}

function getOrdinaryResidentAutoSubmitSetting() {
  const singleSampleValidation = resolveOrdinaryResidentSingleSampleValidation();
  if (singleSampleValidation.enabled) {
    return {
      ordinaryAutoSubmitEnabled: true,
      levelUpEnabled: true,
      reason: null,
      source: "single-sample-validation",
      singleSampleValidationEnabled: true,
      bypassSpecialOrderDailyLimit: true,
    };
  }
  if (process.env.AUTO_SUBMIT_SPECIAL_ORDERS === "0") {
    return {
      ordinaryAutoSubmitEnabled: false,
      levelUpEnabled: false,
      reason: "disabled",
      source: "runtime-disabled",
      singleSampleValidationEnabled: false,
      bypassSpecialOrderDailyLimit: false,
    };
  }
  if (process.env.AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS === "0") {
    return {
      ordinaryAutoSubmitEnabled: false,
      levelUpEnabled: false,
      reason: "ordinary-auto-submit-disabled-by-runtime-setting",
      source: "runtime-disabled",
      singleSampleValidationEnabled: false,
      bypassSpecialOrderDailyLimit: false,
    };
  }
  const settings = readProfileAutomationSettings();
  return settings.autoSubmitOrdinaryResidentOrdersForLevelUp === true
      ? {
        ordinaryAutoSubmitEnabled: true,
        levelUpEnabled: true,
        reason: null,
        source: "profile-setting",
        singleSampleValidationEnabled: false,
        bypassSpecialOrderDailyLimit: false,
      }
    : {
        ordinaryAutoSubmitEnabled: false,
        levelUpEnabled: false,
        reason: "ordinary-auto-submit-disabled-by-profile-setting",
        source: "profile-setting",
        singleSampleValidationEnabled: false,
        bypassSpecialOrderDailyLimit: false,
      };
}

function getCyclicStoryAutoSubmitSetting() {
  const settings = readProfileAutomationSettings();
  return settings.autoSubmitCyclicStoryOrders === true
    ? {
        enabled: true,
        reason: null,
        source: "profile-setting",
      }
    : {
        enabled: false,
        reason: "auto-submit-disabled-by-profile-setting",
        source: "profile-setting",
      };
}

function getCyclicStoryOnlyHighestExperienceSetting() {
  const settings = readProfileAutomationSettings();
  return settings.cyclicStoryOnlyHighestExperienceOrder === true
    ? {
        enabled: true,
        reason: null,
        source: "profile-setting",
      }
    : {
        enabled: false,
        reason: "highest-experience-only-disabled-by-profile-setting",
        source: "profile-setting",
      };
}

function getCyclicNoteOrdinaryResidentAutoSubmitSetting() {
  const setting = getOrdinaryResidentAutoSubmitSetting();
  if (setting.source === "runtime-disabled") return setting;
  return {
    ...setting,
    ordinaryAutoSubmitEnabled: true,
    levelUpEnabled: true,
    reason: null,
    source: "cyclic-note-natural-target",
    bypassSpecialOrderDailyLimit: false,
  };
}

function summarizeCyclicNoteWithResourceActionTime(syncValue, options = {}, { forceCurrentTime = false } = {}) {
  const actionTime = resolveResourceActionTime(syncValue, forceCurrentTime
    ? { ...options, actionTime: null, timeAuthority: syncValue?.$timeAuthority || null }
    : options);
  return summarizeCyclicNoteStatus(syncValue, {
    nowMs: actionTime.nowMs,
    timeTrusted: actionTime.timeTrusted === true,
    clockSource: actionTime.clockSource,
    timeAuthorityReason: actionTime.timeAuthorityReason
      || (actionTime.timeTrusted === true ? null : "no-trusted-time-authority"),
    ...(options.cyclicNoteConfig ? { cyclicNoteConfig: options.cyclicNoteConfig } : {}),
    ...(options.itemNameMap ? { itemNameMap: options.itemNameMap } : {}),
  });
}

function isSafePositiveCyclicNoteBatchId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function getCyclicNoteNaturalCompletionSetting() {
  const settings = readProfileAutomationSettings();
  const configuredEnabled = settings.autoHandleCyclicNote === true;
  const onlyHighestRewardTask = settings.autoCompleteCyclicNoteHighestRewardTask === true;
  const runtimeEnabled = process.env.AUTO_HANDLE_CYCLIC_NOTE !== "0";
  return {
    configuredEnabled,
    onlyHighestRewardTask,
    runtimeEnabled,
    enabled: configuredEnabled && runtimeEnabled,
    source: "profile-settings",
    reason: !configuredEnabled
      ? "cyclic-note-automation-disabled"
      : !runtimeEnabled ? "runtime-disabled" : "enabled",
  };
}

let cachedAccountLevelConfigPath = null;
let cachedAccountLevelRows = null;

function firstFiniteNumber(source, keys) {
  for (const key of keys) {
    const n = toFiniteNumber(source?.[key], null);
    if (n != null) return n;
  }
  return null;
}

function getAccountUserData(syncValue) {
  return syncValue?.$usrTot?.data
    || syncValue?.$usrTot?.usr
    || syncValue?.usrTot?.data
    || syncValue?.usrTot?.usr
    || syncValue?.usr
    || {};
}

function loadAccountLevelRows(configPath = process.env.STATIC_CONFIG_PATH || getDefaultStaticConfigPath()) {
  if (cachedAccountLevelRows && cachedAccountLevelConfigPath === configPath) return cachedAccountLevelRows;
  cachedAccountLevelConfigPath = configPath;
  cachedAccountLevelRows = new Map();
  try {
    if (!fs.existsSync(configPath)) return cachedAccountLevelRows;
    cachedAccountLevelRows = loadAccountLevelConfig(configPath).levels;
  } catch {
    cachedAccountLevelRows = new Map();
  }
  return cachedAccountLevelRows;
}

function summarizeAccountLevel(syncValue, options = {}) {
  const user = getAccountUserData(syncValue);
  const level = firstFiniteNumber(user, ["lvl", "lv", "level", "usrLvl", "usrLevel"]);
  const currentExp = firstFiniteNumber(user, ["lvlExp", "lvExp", "exp", "curExp", "currentExp", "usrExp"]);
  const directRequiredExp = firstFiniteNumber(user, ["nextExp", "needExp", "requiredExp", "maxExp", "upExp", "levelExp"]);
  const levelRow = level == null ? null : loadAccountLevelRows().get(level);
  const requiredExp = directRequiredExp ?? toFiniteNumber(levelRow?.exp, null);
  const serverIdx = toFiniteNumber(options.serverIdx ?? syncValue?.$loginServerIdx ?? syncValue?.serverIdx, null);
  const progressText = formatAccountLevelProgress({ currentExp, requiredExp });
  return {
    level,
    currentExp,
    requiredExp,
    nextLevel: level == null ? null : level + 1,
    progressText,
    serverIdx,
    serverText: serverIdx == null ? null : `区服 ${serverIdx}`,
    source: serverIdx == null ? null : "gwLogin.acc.lastGsIdx",
    lastGsIdx: serverIdx,
    sourcePath: "$usrTot.data + c_lvl",
  };
}

function roundPercent(value) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
}

function summarizeExperienceGuard(syncValue, options = {}) {
  const accountLevel = options.accountLevel || summarizeAccountLevel(syncValue, options);
  const thresholdPercent = isValidExperienceGuardThresholdPercent(options.thresholdPercent)
    ? options.thresholdPercent
    : getExperienceGuardThresholdPercent();
  const thresholdPercentText = formatExperienceGuardThresholdPercent(thresholdPercent);
  const thresholdLabel = thresholdPercent > 0
    ? `${thresholdPercentText}%门槛`
    : "不设门槛";
  const currentExp = toFiniteNumber(accountLevel.currentExp, null);
  const requiredExp = toFiniteNumber(accountLevel.requiredExp, null);
  const known = currentExp != null && requiredExp != null && requiredExp > 0;
  const progressPercentRaw = known ? (currentExp / requiredExp) * 100 : null;
  const progressPercent = progressPercentRaw == null ? null : roundPercent(progressPercentRaw);
  const remainingExp = known ? Math.max(0, requiredExp - currentExp) : null;
  const threshold = calculateExperienceGuardThreshold(requiredExp, thresholdPercent);
  const thresholdReached =
    thresholdPercent > 0
    && known
    && remainingExp <= threshold.thresholdRemainingExp;
  const persistentState = syncValue?.$experienceGuardState || null;
  const settlementUncertain = persistentState?.invalid === true
    && persistentState?.invalidReason === "experience-guard-settlement-unresolved";
  const persistentBlocked = thresholdPercent > 0 && (
    persistentState?.breached === true
    || persistentState?.invalid === true
  );
  const remainingToProtectionExp = known
    ? Math.max(0, remainingExp - threshold.thresholdRemainingExp)
    : null;
  const blocked = options.stopped === true || thresholdReached || persistentBlocked;
  const reason = persistentState?.invalid && thresholdPercent > 0
    ? persistentState.invalidReason || "experience-guard-state-invalid"
    : persistentState?.breached && thresholdPercent > 0
      ? "experience-level-ceiling-breached"
      : !known
    ? "unknown"
    : thresholdReached
      ? "experience-protection-boundary"
    : blocked
      ? "experience-action-blocked"
      : "action-level-check";
  const progressText = progressPercent == null ? "-" : `${progressPercent.toFixed(1)}%`;
  const remainingText = remainingExp == null ? "-" : formatWanNumber(remainingExp);
  const remainingToProtectionText =
    remainingToProtectionExp == null ? "-" : formatWanNumber(remainingToProtectionExp);
  const blockedText = blocked
    ? (thresholdPercent > 0
        ? `已到${thresholdPercentText}%保护线，有经验动作暂停，无经验动作继续`
        : "检测到异常经验，已停止后续收益动作")
    : (thresholdPercent > 0
        ? "收益动作正常，执行前按预测经验上界复核"
        : "有经验动作正常执行");
  return {
    ...threshold,
    armedLevel: persistentState?.armedLevel ?? null,
    ceilingLevel: persistentState?.ceilingLevel ?? null,
    breached: persistentState?.breached === true,
    breachEvidence: persistentState?.breachEvidence ?? null,
    stateRevision: persistentState?.stateRevision ?? null,
    settlementUncertain,
    experienceProtectionBlocked: thresholdPercent > 0 && (
      thresholdReached || persistentState?.breached === true
    ),
    thresholdReached,
    legacyThresholdReached: thresholdReached,
    remainingToProtectionExp,
    known,
    blocked,
    level: accountLevel.level ?? null,
    currentExp,
    requiredExp,
    remainingExp,
    progressPercent,
    reason,
    reasonText: persistentBlocked
      ? (settlementUncertain
          ? "收益请求未确认（网络中断或任务停止），当前仅等待权威核对；未判定为经验保护线命中"
          : persistentState.invalid
            ? `经验等级保护状态不可用（${persistentState.invalidReason || "状态损坏"}），有经验动作暂停，无经验动作继续`
            : `经验等级上限已越过：布防等级 ${persistentState.armedLevel ?? "未知"}，上限等级 ${persistentState.ceilingLevel ?? "未知"}，当前权威等级 ${persistentState.lastAuthoritativeLevel ?? "未知"}；需明确重新布防后恢复收益动作`)
      : known
      ? `经验保护（${thresholdLabel}）：当前 ${progressText}，距离升级 ${remainingText}，距保护线 ${remainingToProtectionText}，${blockedText}`
      : `经验保护（${thresholdLabel}）：经验值未知，等待刷新后判定`,
  };
}

class ExperienceGuardStopError extends Error {
  constructor(experienceGuard) {
    super(experienceGuard?.reasonText || "经验保护检测到异常经验，已停止后续收益动作");
    this.name = "ExperienceGuardStopError";
    this.reason = "experience-guard";
    this.category = "experience-guard";
    this.exitCode = EXPERIENCE_GUARD_EXIT_CODE;
    this.experienceGuard = experienceGuard || null;
  }
}

class ExperienceActionBlockedError extends Error {
  constructor(experienceGuard) {
    super(experienceGuard?.reasonText || "经验保护已跳过当前有经验动作");
    this.name = "ExperienceActionBlockedError";
    this.reason = "experience-action-blocked";
    this.category = "experience-guard";
    this.skipped = true;
    this.experienceGuard = experienceGuard || null;
  }
}

function isExperienceGuardError(err) {
  return err?.reason === "experience-guard" || err instanceof ExperienceGuardStopError;
}

function isExperienceActionBlockedError(err) {
  return err?.reason === "experience-action-blocked"
    || err instanceof ExperienceActionBlockedError;
}

const cfg = {
  ctoken: process.env.CTOKEN,
  pcUserId: process.env.PC_USER_ID,
  pcToken: process.env.PC_TOKEN,
  babiToken: process.env.BABI_TOKEN,
  openId: process.env.OPEN_ID,
  gwHost: process.env.GW_HOST || "https://hygnhmzfb.babigame.cn:443/gw",
};

function validateConfig() {
  for (const [key, value] of Object.entries(cfg)) {
    if (["gwHost"].includes(key)) continue;
    if (!value) throw new Error(`Missing env ${key}`);
  }
}

const GAME_ID = "xjskp";
const APP_ID = "2021004163668677";
const PACKAGE_NAME = "cn.hysj.zfb.minigame";
const DEFAULT_APP_VERSION = "351.0.2";
const DEFAULT_PACKAGE_ID = 520;
const PACKAGE_MANIFEST_CANDIDATES = [
  new URL("./game-pkg-latest/Manifest.xml", import.meta.url),
  new URL("./game-pkg/Manifest.xml", import.meta.url),
];
const GAME_JS_CANDIDATES = [
  "work/game-pkg-latest/tar/game.js",
  "work/game-pkg/tar/game.js",
];
const MDCL = 538;
const MDGID = 163;
const DEFAULT_SERVER_IDX = 730;
const CRYPTO_KEY = "smallaitt";
const SPLIT = "$#|#$";
const DEFAULT_ONLINE_HEART_TICK_INTERVAL_MS = 60 * 1000;
const SESSION_EXPIRED_EXIT_CODE = 42;
const EXPERIENCE_GUARD_EXIT_CODE = 43;
const SESSION_EXPIRED_STOP_MESSAGE = "检测到账号在其他设备登录或会话已失效，自动化循环已自动停止。";
const CYCLIC_NOTE_ENTER_IFACE = CYCLIC_NOTE_IFACES.enter;
const CYCLIC_STORY_ENTER_IFACE = CYCLIC_STORY_IFACES.enter;
const runHistory = createRunHistory();
let lastOnlineHeartTickAttemptAtMs = 0;
let lastFmlLandScanAttemptAtMs = 0;

function xorAll(code, key = CRYPTO_KEY) {
  for (let i = 0; i < key.length; i++) code ^= key.charCodeAt(i);
  return code;
}

function xorRev(code, key = CRYPTO_KEY) {
  for (let i = key.length - 1; i >= 0; i--) code ^= key.charCodeAt(i);
  return code;
}

function en(text, key = CRYPTO_KEY) {
  return JSON.stringify(Array.from(text, (ch) => xorAll(ch.charCodeAt(0), key)));
}

function de(text, key = CRYPTO_KEY) {
  return JSON.parse(text).map((n) => String.fromCharCode(xorRev(n, key))).join("");
}

function md5(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

function findExistingPackageFile(candidates) {
  return candidates.find((file) => fs.existsSync(file));
}

function readPackageAppVersionFromManifest(manifestPath = null, fallback = DEFAULT_APP_VERSION) {
  const activeRelease = manifestPath ? null : readActiveGameRelease({ rootDir: process.cwd() });
  const candidates = manifestPath ? [manifestPath] : [activeRelease?.code?.packageManifestPath, ...PACKAGE_MANIFEST_CANDIDATES].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const xml = fs.readFileSync(candidate, "utf8");
      const appVersion = xml.match(/<appVersion>\s*([^<\s]+)\s*<\/appVersion>/i)?.[1]?.trim();
      if (appVersion) return appVersion;
    } catch {
      // Try the next package manifest candidate.
    }
  }
  return fallback;
}

function getLoginPackageInfo(up = {}, options = {}) {
  const manifestAppVersion = readPackageAppVersionFromManifest(options.manifestPath || null, null);
  const appVersion = manifestAppVersion || up?.appVersion || DEFAULT_APP_VERSION;
  return {
    appVersion,
    appVersionSource: manifestAppVersion ? "local-manifest" : up?.appVersion ? "pack-userParams" : "default",
    manifestAppVersion,
    packageId: Number(up?.packageId || DEFAULT_PACKAGE_ID),
    zoneCode: up?.zoneCode || "my",
  };
}

function resolveGatewayServerIndex(gwLogin) {
  const serverIdx = toFiniteNumber(gwLogin?.acc?.lastGsIdx, null);
  if (serverIdx == null || serverIdx <= 0) {
    const err = new Error("账号信息缺少区服 lastGsIdx，请重新导入或验证账号。");
    err.code = "MISSING_ACCOUNT_SERVER";
    err.category = "login-state";
    throw err;
  }
  return serverIdx;
}

function gameParam(iface, arg, token = null) {
  const action = iface.slice(iface.indexOf(".") + 1);
  const a = en(JSON.stringify([action, arg || {}, token]));
  return { sign: md5(a + CRYPTO_KEY), a };
}

let schemaGameJsPath = null;

function getRuntimeGameJsPath() {
  const activeRelease = readActiveGameRelease({ rootDir: process.cwd() });
  if (activeRelease?.code?.gameJsPath) return activeRelease.code.gameJsPath;
  const gameJsPath = findExistingPackageFile(GAME_JS_CANDIDATES);
  if (!gameJsPath) throw new Error("Cannot find game.js under work/game-pkg-latest or work/game-pkg");
  return gameJsPath;
}

function extractSchemas() {
  schemaGameJsPath = getRuntimeGameJsPath();
  const src = fs.readFileSync(schemaGameJsPath, "utf8");
  const schemas = {};
  let pos = 0;
  const needle = 'mo.DS.setSingle("';
  while ((pos = src.indexOf(needle, pos)) >= 0) {
    const nameStart = pos + needle.length;
    const nameEnd = src.indexOf('"', nameStart);
    const name = src.slice(nameStart, nameEnd);
    let objStart = src.indexOf("{", nameEnd);
    if (objStart < 0) {
      pos = nameEnd + 1;
      continue;
    }
    let depth = 0;
    let quote = null;
    let escaped = false;
    let objEnd = -1;
    for (let i = objStart; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          objEnd = i;
          break;
        }
      }
    }
    if (objEnd > objStart) {
      const literal = src.slice(objStart, objEnd + 1);
      try {
        schemas[name] = Function(`"use strict"; return (${literal});`)();
      } catch {
        // Ignore rare schema literals that are not standalone.
      }
    }
    pos = objEnd > 0 ? objEnd + 1 : nameEnd + 1;
  }
  return schemas;
}

const schemas = extractSchemas();

function resolveType(type, ns = "G") {
  if (!type || ["number", "string", "boolean", "any"].includes(type)) return type;
  if (type === "Date" || type === "INumMap") return type;
  if (type.startsWith("{") && type.endsWith("}")) return type;
  if (type.endsWith("[]")) return `${resolveType(type.slice(0, -2), ns)}[]`;
  if (type.includes(".")) return type;
  return `${ns}.${type}`;
}

function parseField(spec, ns = "G") {
  if (typeof spec === "number") return { miniKey: String(spec), type: null };
  if (typeof spec !== "string") return { miniKey: String(spec), type: null };
  const idx = spec.indexOf(":");
  if (idx < 0) return { miniKey: spec, type: null };
  return { miniKey: spec.slice(0, idx), type: resolveType(spec.slice(idx + 1).trim(), ns) };
}

function decodeValue(value, type, ns = "G") {
  if (value == null || !type) return value;
  if (type === "Date") return typeof value === "number" ? new Date(value).toISOString() : value;
  if (type === "INumMap") return value;
  if (type.endsWith("[]")) {
    const inner = type.slice(0, -2);
    return Array.isArray(value) ? value.map((item) => decodeValue(item, inner, ns)) : value;
  }
  const mapMatch = type.match(/^\{\[[^\]]+\]:(.+)\}$/);
  if (mapMatch) {
    const innerRaw = mapMatch[1].trim();
    if (innerRaw.startsWith("{")) return value;
    const inner = resolveType(innerRaw, ns);
    if (typeof value !== "object") return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeValue(v, inner, ns);
    return out;
  }
  const schema = schemas[type];
  if (!schema || typeof value !== "object") return value;
  const out = {};
  const nextNs = type.includes(".") ? type.slice(0, type.lastIndexOf(".")) : ns;
  for (const [field, spec] of Object.entries(schema)) {
    const { miniKey, type: fieldType } = parseField(spec, nextNs);
    if (Object.prototype.hasOwnProperty.call(value, miniKey)) {
      out[field] = decodeValue(value[miniKey], fieldType, nextNs);
    }
  }
  return out;
}

function washResponse(raw) {
  if (!raw || typeof raw !== "object") return { value: raw, dsName: null, errMsg: null };
  let value = raw.v;
  let dsName = null;
  if (raw.d && value != null) {
    dsName = de(raw.d);
    value = decodeValue(value, dsName);
  }
  return { value, dsName, errMsg: raw.m || null, receivedMs: raw.r, rspMs: raw.t };
}

function isSessionExpiredPayload(value) {
  if (value == null) return false;
  if (typeof value === "string") {
    const text = value.toLowerCase();
    return text.includes("会话已过期")
      || text.includes("会话过期")
      || text.includes("会话已失效")
      || text.includes("登录失效")
      || text.includes("重新登录")
      || text.includes("其他设备登录")
      || text.includes("别的设备登录")
      || text.includes("账号已在其他设备")
      || text.includes("token invalid")
      || text.includes("invalid token")
      || text.includes("unauthorized")
      || text.includes('"type":90000')
      || value.includes('"type": 90000');
  }
  if (value instanceof Error) return isSessionExpiredPayload(value.message);
  if (typeof value !== "object") return false;
  if (Number(value.type) === 90000) return true;
  return Object.values(value).some((item) => isSessionExpiredPayload(item));
}

function isSessionExpiredError(err) {
  return isSessionExpiredPayload(err);
}

function hasStructuredSessionExpiredType(value, seen = new Set()) {
  if (value == null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Number(value.type) === 90000) return true;
  return Object.values(value).some((item) => hasStructuredSessionExpiredType(item, seen));
}

function createUserStoppedError(reason = "user-stop") {
  const error = new Error("用户停止");
  error.reason = "user-stopped";
  error.category = "operator";
  error.stopReason = reason;
  return error;
}

function isUserStoppedError(error) {
  return error?.reason === "user-stopped";
}

async function throwIfAutomationStopped(options = {}) {
  if (options.signal?.aborted) {
    throw createUserStoppedError(options.signal.reason || "user-stop");
  }
  const stopPath = options.stopPath || process.env.TEAM_ORDER_STOP_PATH;
  if (!stopPath) return;
  const request = await readAutomationStopRequest(stopPath);
  if (request) throw createUserStoppedError(request.reason);
}

async function waitForAutomationDelay(milliseconds, options = {}) {
  const waitFn = options.waitFn || wait;
  const nowFn = options.delayNowFn || Date.now;
  const stopPath = options.stopPath || process.env.TEAM_ORDER_STOP_PATH;
  const deadline = nowFn() + Math.max(0, Number(milliseconds) || 0);
  while (true) {
    await throwIfAutomationStopped(options);
    const remainingMs = Math.max(0, deadline - nowFn());
    if (remainingMs <= 0) return;
    const waitMs = stopPath ? Math.min(50, remainingMs) : remainingMs;
    let onAbort = null;
    const aborted = options.signal
      ? new Promise((_, reject) => {
        onAbort = () => reject(createUserStoppedError(options.signal.reason || "user-stop"));
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) onAbort();
      })
      : null;
    try {
      if (aborted) {
        await Promise.race([Promise.resolve().then(() => waitFn(waitMs)), aborted]);
      } else {
        await waitFn(waitMs);
      }
    } finally {
      if (onAbort) options.signal.removeEventListener("abort", onAbort);
    }
  }
}

async function runAtAutomationRequestBoundary(options, request, onStop = null) {
  await throwIfAutomationStopped(options);
  const outcome = Promise.resolve()
    .then(request)
    .then(
      (value) => ({ kind: "value", value }),
      (error) => ({ kind: "error", error }),
    );
  const stopPath = options.stopPath || process.env.TEAM_ORDER_STOP_PATH;
  let onAbort = null;
  const aborted = options.signal
    ? new Promise((resolve) => {
      onAbort = () => resolve({
        kind: "stop",
        error: createUserStoppedError(options.signal.reason || "user-stop"),
      });
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    })
    : null;
  try {
    while (true) {
      const candidates = [outcome];
      if (aborted) candidates.push(aborted);
      if (stopPath) candidates.push(wait(50).then(() => null));
      const settled = await Promise.race(candidates);
      if (!settled) {
        await throwIfAutomationStopped(options);
        continue;
      }
      if (settled.kind !== "value") throw settled.error;
      await throwIfAutomationStopped(options);
      return settled.value;
    }
  } catch (error) {
    if (isUserStoppedError(error)) {
      try {
        onStop?.();
      } catch {}
    }
    throw error;
  } finally {
    if (onAbort) options.signal.removeEventListener("abort", onAbort);
  }
}

function createStopGuardedWs(ws, options = {}) {
  return {
    ...ws,
    async request(...args) {
      return await runAtAutomationRequestBoundary(
        options,
        () => ws.request(...args),
        () => ws.close?.(),
      );
    },
    close() {
      return ws.close?.();
    },
  };
}

function classifyAutomationError(err) {
  const rawMessage = err?.message || String(err || "");
  const protectedClassification = err?.automationClassification;
  if (isUserStoppedError(err)) {
    return {
      reason: "user-stopped",
      category: "operator",
      exitCode: 0,
      message: "用户停止",
      rawMessage,
    };
  }
  // Protected business rejections keep their business meaning unless the
  // response object itself carries the authoritative session-expiry type.
  if (
    protectedClassification?.category === "business-rejected"
    && hasStructuredSessionExpiredType(err)
  ) {
    return {
      reason: "session-expired",
      category: "login-state",
      exitCode: SESSION_EXPIRED_EXIT_CODE,
      message: SESSION_EXPIRED_STOP_MESSAGE,
      rawMessage,
    };
  }
  if (protectedClassification?.category) {
    const category = String(protectedClassification.category);
    return {
      reason: `protected-${category}`,
      category,
      exitCode: category === "business-rejected" ? 0 : 1,
      message: rawMessage,
      rawMessage,
      automationClassification: protectedClassification,
    };
  }
  if (isSessionExpiredError(err)) {
    return {
      reason: "session-expired",
      category: "login-state",
      exitCode: SESSION_EXPIRED_EXIT_CODE,
      message: SESSION_EXPIRED_STOP_MESSAGE,
      rawMessage,
    };
  }
  if (isExperienceGuardError(err)) {
    return {
      reason: "experience-guard",
      category: "experience-guard",
      exitCode: EXPERIENCE_GUARD_EXIT_CODE,
      message: err?.experienceGuard?.reasonText || rawMessage,
      rawMessage,
      experienceGuard: err?.experienceGuard || null,
    };
  }
  if (err?.code === "MISSING_ACCOUNT_SERVER") {
    return {
      reason: "missing-account-server",
      category: "login-state",
      exitCode: 1,
      message: rawMessage,
      rawMessage,
    };
  }
  if (isWsRequestTimeoutError(err)) {
    return {
      reason: "ws-timeout",
      category: "network",
      exitCode: 1,
      message: rawMessage,
      rawMessage,
    };
  }
  return {
    reason: "error",
    category: "runtime",
    exitCode: 1,
    message: rawMessage,
    rawMessage,
  };
}

function buildAutomationStoppedSummary(err, options = {}) {
  const classified = classifyAutomationError(err);
  const now = options.now ? options.now() : new Date();
  const stoppedAt = formatDateTime(now);
  return {
    loopError: classified.message,
    loopErrorAt: stoppedAt,
    automationStopped: {
      stopped: true,
      reason: classified.reason,
      category: classified.category,
      message: classified.message,
      rawMessage: classified.rawMessage,
      cycle: options.cycle ?? null,
      step: options.step || null,
      stoppedAt,
      exitCode: classified.exitCode,
      ...(classified.experienceGuard ? { experienceGuard: classified.experienceGuard } : {}),
    },
    ...(classified.experienceGuard ? { experienceGuard: classified.experienceGuard } : {}),
  };
}

function emitAutomationReady(syncValue, context = {}) {
  if (
    lastGardenArtifactCompletion
    && !lastGardenArtifactCompletion.complete
    && process.env.XJSKP_ASYNC_STATUS_WRITER !== "1"
  ) {
    return false;
  }
  const waterDrop = getWaterDropStatus(syncValue);
  const experienceGuard = summarizeExperienceGuard(syncValue);
  console.log(JSON.stringify({
    step: "automationReady",
    readyAt: new Date().toISOString(),
    action: process.env.ACTION || null,
    profileId: process.env.PROFILE_ID || null,
    statusJsonPath: process.env.STATUS_JSON_PATH || null,
    cycle: context.cycle || "startup",
    statusStep: context.step || "startupReady",
    waterDropCount: waterDrop.count,
    waterDropText: `${waterDrop.count}/${waterDrop.displayLimit}`,
    experienceGuardBlocked: experienceGuard.blocked,
  }));
  return true;
}

function isWsRequestTimeoutError(err) {
  const message = err?.message || String(err || "");
  return message.includes("WS request timeout ")
    || message.includes("WS connect timeout ")
    || message.includes("WS closed while waiting for ")
    || message.includes("WS error while waiting for ")
    || message.startsWith("WS error ")
    || message.includes("Received network error or non-101 status code")
    || message.includes("WebSocket is not open")
    || message.includes("WS stale sync ");
}

function rethrowGlobalAutomationError(err) {
  if (
    isSessionExpiredError(err)
    || isWsRequestTimeoutError(err)
    || isExperienceGuardError(err)
    || isUserStoppedError(err)
  ) {
    throw err;
  }
}

function getTeamOrderTriggerProtectionEnabled() {
  return readProfileAutomationSettings().teamOrderTriggerProtectionEnabled !== false;
}

function getTeamOrderPaidRenewProtectionEnabled() {
  return readProfileAutomationSettings().teamOrderPaidRenewProtectionEnabled !== false;
}

function sampleObjectMap(map, limit = 5) {
  if (!map || typeof map !== "object") return null;
  return Object.fromEntries(Object.entries(map).slice(0, limit));
}

function debugLandRaw(label, raw, decoded) {
  if (!process.env.DEBUG_SYNC) return;
  const rawLandMap = raw?.v?.["100"]?.["0"]?.["1"];
  const decodedLandMap = decoded?.usrLandTot?.usrLand?.landMap;
  console.log(JSON.stringify({
    step: "debugLand",
    label,
    rawUsrLandTotKeys: raw?.v?.["100"] ? Object.keys(raw.v["100"]) : null,
    rawLandKeys: rawLandMap ? Object.keys(rawLandMap).slice(0, 10) : null,
    rawLandSample: sampleObjectMap(rawLandMap),
    decodedLandKeys: decodedLandMap ? Object.keys(decodedLandMap).slice(0, 10) : null,
    decodedLandSample: sampleObjectMap(decodedLandMap),
  }));
}

async function postJson(url, body, headers = {}) {
  const rsp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await rsp.text();
  if (!rsp.ok) throw new Error(`${rsp.status} ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function postForm(url, form, headers = {}) {
  const rsp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form),
  });
  const text = await rsp.text();
  if (!rsp.ok) throw new Error(`${rsp.status} ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function webgw(service, action, station, body) {
  return postJson(
    `https://webgwmobiler.alipay.com/gamecenterhome/${service}/${action}/${station}?ctoken=${encodeURIComponent(cfg.ctoken)}`,
    body,
    {
      "x-game-token-pcweb": cfg.pcToken,
      "x-game-uid-pcweb": cfg.pcUserId,
      "x-webgw-appId": "180020010001270314",
      "x-webgw-version": "2.0",
      origin: "https://www.wanyiwan.top",
      referer: "https://www.wanyiwan.top/game/xjskp",
    },
  );
}

async function gwRequest(iface, arg, token = null) {
  const p = gameParam(iface, arg, token);
  const rsp = await fetch(cfg.gwHost, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(p),
  });
  const text = await rsp.text();
  if (!rsp.ok) throw new Error(`${rsp.status} GW: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOnlineHeartTickIntervalMs(env = process.env) {
  const seconds = Number(env.ONLINE_HEART_TICK_INTERVAL_SECONDS);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.max(10, Math.floor(seconds)) * 1000;
  }
  return DEFAULT_ONLINE_HEART_TICK_INTERVAL_MS;
}

function getStatusRefreshIntervalMs(env = process.env) {
  const seconds = Number(env.STATUS_REFRESH_INTERVAL_SECONDS);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return 0;
    return Math.max(1, Math.floor(seconds)) * 1000;
  }
  return 5000;
}

function getAccountSnapshotIntervalMs(env = process.env) {
  const seconds = Number(env.ACCOUNT_SNAPSHOT_INTERVAL_SECONDS);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return 0;
    return Math.max(10, Math.floor(seconds)) * 1000;
  }
  return 30 * 1000;
}

function getAssetSyncIntervalMs(env = process.env) {
  const seconds = Number(env.ASSET_SYNC_INTERVAL_SECONDS);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return 0;
    return Math.max(10, Math.floor(seconds)) * 1000;
  }
  return 0;
}

function getWsRequestTimeoutMs(env = process.env) {
  const milliseconds = Number(env.WS_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(milliseconds)) return 20_000;
  return Math.max(1_000, Math.floor(milliseconds));
}

class GameWs {
  constructor(url, options = {}) {
    this.url = url;
    this.seq = 1;
    this.pending = new Map();
    this.requestTimeoutMs = Number.isFinite(Number(options.requestTimeoutMs))
      ? Math.max(1, Math.floor(Number(options.requestTimeoutMs)))
      : getWsRequestTimeoutMs(options.env || process.env);
  }
  settlePending(key, outcome, value) {
    const pending = this.pending.get(key);
    if (!pending) return false;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending[outcome](value);
    return true;
  }
  rejectPending(kind) {
    for (const [key, pending] of Array.from(this.pending.entries())) {
      this.settlePending(
        key,
        "reject",
        new Error(`WS ${kind} while waiting for ${pending.iface}`),
      );
    }
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      this.onMessage(event.data).catch((err) => console.error(JSON.stringify({ step: "wsMessage", warn: err.message })));
    });
    this.ws.addEventListener("close", () => {
      this.rejectPending("closed");
    });
    this.ws.addEventListener("error", () => {
      this.rejectPending("error");
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WS connect timeout ${this.url}`)), 15000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`WS error ${this.url}: ${event.message || "unknown"}`));
      }, { once: true });
    });
  }
  async onMessage(data) {
    let text;
    if (typeof data === "string") text = data;
    else if (data instanceof Blob) text = await data.text();
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
    else text = Buffer.from(data).toString("utf8");
    const chunks = text.startsWith(SPLIT) ? text.slice(SPLIT.length).split(SPLIT) : text.split(SPLIT);
    for (const chunk of chunks) {
      if (!chunk) continue;
      let msg;
      try {
        msg = JSON.parse(chunk);
      } catch {
        continue;
      }
      if (msg.e === "response" && msg.d && this.pending.has(msg.d.k)) {
        this.settlePending(msg.d.k, "resolve", msg.d);
      }
    }
  }
  request(iface, arg, token = null) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`WebSocket is not open: ${iface}`));
    }
    const k = String(this.seq++);
    const d = {
      r: iface.slice(0, iface.indexOf(".")),
      p: gameParam(iface, arg, token),
      k,
    };
    const payload = SPLIT + JSON.stringify({ e: "request", d });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settlePending(
          k,
          "reject",
          new Error(`WS request timeout ${iface}`),
        );
      }, this.requestTimeoutMs);
      this.pending.set(k, { iface, resolve, reject, timer });
      try {
        this.ws.send(payload);
      } catch (error) {
        this.settlePending(k, "reject", error);
      }
    });
  }
  close() {
    this.rejectPending("closed");
    this.ws?.close();
  }
}

async function requestSync(ws, gsToken, iface, arg = {}, errorPrefix = iface, options = {}) {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error(String(options.signal.reason || "request aborted"));
  }
  const timeAuthorityNowFn = typeof options.timeAuthorityNowFn === "function"
    ? options.timeAuthorityNowFn
    : Date.now;
  const requestStartedAtMs = Number.isFinite(Number(options.requestStartedAtMs))
    ? Number(options.requestStartedAtMs)
    : timeAuthorityNowFn();
  const raw = await ws.request(
    iface,
    arg,
    gsToken,
    options.requestContext || {},
  );
  const responseAtMs = timeAuthorityNowFn();
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error(String(options.signal.reason || "request aborted"));
  }
  const rsp = washResponse(raw);
  if (rsp.errMsg) {
    const err = new Error(`${errorPrefix}: ${JSON.stringify(rsp.errMsg)}`);
    err.errMsg = rsp.errMsg;
    err.dsName = rsp.dsName;
    err.iface = iface;
    err.requestStartedAtMs = requestStartedAtMs;
    err.responseAtMs = responseAtMs;
    err.automationClassification = {
      category: "business-rejected",
      phase: "response-received",
      settlement: "rejected",
      reason: "explicit-business-rejection",
      iface,
    };
    throw err;
  }
  if (iface === "gs.usr.heartTick" || !rsp.value || typeof rsp.value !== "object") {
    return {
      ...rsp,
      requestStartedAtMs,
      responseAtMs,
    };
  }
  const hardSyncedValue = attachHardSyncState(rsp.value, {
    serverMs: rsp.value?.$other?.ms,
    requestStartedAtMs,
    responseAtMs,
    maxAgeMs: options.timeAuthorityMaxAgeMs,
  });
  return {
    ...(hardSyncedValue === rsp.value ? rsp : { ...rsp, value: hardSyncedValue }),
    requestStartedAtMs,
    responseAtMs,
  };
}

const TEAM_TRIGGER_RESIDENT_ORDER_IFACES = new Set([
  "gs.orderFlower.finishOrder",
  "gs.orderFlower.finishSatinOrder",
  "gs.orderFlower.finishDecorateOrder",
]);

function isAuthorizedTeamColdStartRequest(iface, requestContext = {}) {
  const decision = requestContext?.teamTriggerDecision;
  const before = Number(requestContext?.residentBoardTotalBefore);
  const after = Number(requestContext?.residentBoardTotalAfter);
  return TEAM_TRIGGER_RESIDENT_ORDER_IFACES.has(iface)
    && [49, 99].includes(before)
    && after === before + 1
    && decision?.blocked === false
    && decision?.coldStartBypass === true
    && decision?.reason === "cold-start-user-authorized"
    && typeof decision?.teamOrderReservationId === "string"
    && decision.teamOrderReservationId.length > 0;
}

async function requestResidentOrderAction(
  ws,
  gsToken,
  action,
  errorPrefix = `${action?.iface || "resident order"} failed`,
) {
  return requestSync(
    ws,
    gsToken,
    action.iface,
    action.args || {},
    errorPrefix,
    {
      requestContext: {
        teamTriggerDecision: action.teamTriggerDecision || null,
        residentBoardTotalBefore: action.residentBoardTotalBefore ?? null,
        residentBoardTotalAfter: action.residentBoardTotalAfter ?? null,
        specialOrderExpectation: action.specialOrderExpectation || null,
        ordinaryOrderExpectation: action.ordinaryOrderExpectation || null,
      },
    },
  );
}

function classifyAutomationExperienceInterface(iface) {
  if (iface === WATERWHEEL_IFACES.skip) {
    return {
      kind: "none",
      source: "official-waterwheel-skip-no-reward",
    };
  }
  return classifyExperienceInterface(iface);
}

function isExperienceRewardIface(iface) {
  return classifyAutomationExperienceInterface(iface).kind !== "none";
}

function extractResponseItemDelta(value, itemId) {
  if (Number(itemId) === ITEM_IDS.EXPERIENCE) {
    return parseExperienceSettlementEvidence(null, value).deduplicatedDelta;
  }
  const key = String(itemId);
  const sumMaps = (maps) => {
    let found = false;
    let total = 0;
    for (const map of maps) {
      if (!map || typeof map !== "object" || !Object.hasOwn(map, key)) continue;
      const delta = Number(map[key]);
      if (!Number.isFinite(delta)) continue;
      found = true;
      total += delta;
    }
    return found ? total : null;
  };
  const usrTot = value?.$usrTot || {};
  const oiDelta = sumMaps([
    usrTot.oi?.bi,
    usrTot.oi?.bo,
    value?.oi?.bi,
    value?.oi?.bo,
  ]);
  if (oiDelta != null) return oiDelta;

  const itemAddChg = usrTot.itemAddChg || value?.itemAddChg || {};
  const directDelta = sumMaps([itemAddChg.itemMap]);
  if (directDelta != null) return directDelta;
  return sumMaps(
    (itemAddChg.itemAddRcdList || []).map((record) => record?.itemMap),
  );
}

function experienceEvidenceSource(evidence) {
  const canonicalAbsolute = (evidence?.absoluteCandidates || []).some(
    (candidate) => (
      candidate.source === "$usrTot.data.lvlExp"
      || candidate.source === "$usrTot.oi.bd[2]"
    ),
  );
  if (canonicalAbsolute && evidence?.responseLevel != null) {
    return "authoritative-absolute";
  }
  if (canonicalAbsolute) return "absolute-experience-without-level";
  if (
    !(evidence?.absoluteCandidates || []).length
    && !(evidence?.deltaCandidates || []).length
  ) {
    return "no-experience-evidence";
  }
  return "unverified-experience-evidence";
}

function buildExperienceSettlementAudit({
  step = "experienceSettlementAudit",
  cycle = null,
  requestId = null,
  iface = null,
  settlementKind = null,
  estimate = null,
  evidence,
  experienceSource = experienceEvidenceSource(evidence),
  conflict = evidence?.conflict ?? false,
  conflictReason = evidence?.conflictReason ?? null,
} = {}) {
  return {
    step,
    cycle,
    requestId,
    iface,
    settlementKind,
    predictionSource: estimate?.source ?? null,
    predictedMinExp: estimate?.minExp ?? null,
    predictedMaxExp: estimate?.maxExp ?? null,
    predictionDetails: estimate?.details ?? null,
    beforeLevel: evidence?.beforeLevel ?? null,
    beforeExp: evidence?.beforeExp ?? null,
    responseLevel: evidence?.responseLevel ?? null,
    absoluteCandidates: evidence?.absoluteCandidates || [],
    deltaCandidates: evidence?.deltaCandidates || [],
    deduplicatedDelta: evidence?.deduplicatedDelta ?? null,
    resolvedLevel: evidence?.resolvedLevel ?? null,
    resolvedExp: evidence?.resolvedExp ?? null,
    actualExpDelta: evidence?.actualExpDelta ?? null,
    resolution: evidence?.resolution || null,
    experienceSource,
    conflict,
    conflictReason,
  };
}

function logExperienceGuardActionSkip({ cycle = null, action = null, iface = null, experienceGuard = null, error = null } = {}) {
  console.log(JSON.stringify({
    step: "experienceGuardActionSkip",
    cycle,
    action,
    iface,
    thresholdPercent:
      experienceGuard?.thresholdPercent ?? DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT,
    thresholdRemainingExp: experienceGuard?.thresholdRemainingExp ?? null,
    protectionLimitExp: experienceGuard?.protectionLimitExp ?? null,
    remainingToProtectionExp: experienceGuard?.remainingToProtectionExp ?? null,
    level: experienceGuard?.level ?? null,
    currentExp: experienceGuard?.currentExp ?? null,
    requiredExp: experienceGuard?.requiredExp ?? null,
    progressPercent: experienceGuard?.progressPercent ?? null,
    remainingExp: experienceGuard?.remainingExp ?? null,
    reason: experienceGuard?.reason || "experience-protection-boundary",
    reasonText: experienceGuard?.reasonText || null,
    experienceGuardCategory: experienceGuard?.reason || "experience-protection-boundary",
    experienceEstimateSource: experienceGuard?.predictionSource || null,
    customerOrderNobleStateUnknown:
      experienceGuard?.predictionSource === "customer-order-noble-state-unknown",
    blocked: true,
    error,
  }));
}

async function refreshExperienceGuardSync(
  ws,
  gsToken,
  syncValue,
  label = "experienceGuardLazySync",
  cycle = null,
  options = {},
) {
  const guard = summarizeExperienceGuard(syncValue, {
    thresholdPercent: options.thresholdPercent,
  });
  const lazy = await requestSync(ws, gsToken, "gs.usr.lazySync", {}, "Experience guard lazySync failed");
  const evidence = parseExperienceSettlementEvidence(syncValue, lazy.value);
  const next = lazy.value ? mergeLandSync(syncValue, lazy.value) : syncValue;
  const refreshedGuard = summarizeExperienceGuard(next, {
    thresholdPercent: options.thresholdPercent,
  });
  const audit = buildExperienceSettlementAudit({
    cycle,
    requestId: options.requestId ?? null,
    iface: "gs.usr.lazySync",
    settlementKind: "authority-refresh",
    evidence,
  });
  options.onAudit?.(audit);
  console.log(JSON.stringify({
    step: label,
    cycle,
    iface: "gs.usr.lazySync",
    dsName: lazy.dsName,
    err: null,
    beforeProgressPercent: guard.progressPercent,
    afterProgressPercent: refreshedGuard.progressPercent,
    beforeCurrentExp: guard.currentExp,
    afterCurrentExp: refreshedGuard.currentExp,
    remainingExp: refreshedGuard.remainingExp,
    blocked: refreshedGuard.blocked,
    experienceSource: audit.experienceSource,
    resolution: evidence.resolution,
    conflict: evidence.conflict,
    conflictReason: evidence.conflictReason,
  }));
  if (evidence.regression) {
    options.onAudit?.({
      ...audit,
      step: "experienceSnapshotRegression",
    });
    console.warn(JSON.stringify({
      ...audit,
      step: "experienceSnapshotRegression",
    }));
  }
  return options.returnEvidence
    ? {
        syncValue: next,
        evidence,
        experienceSource: audit.experienceSource,
      }
    : next;
}

function createExperienceGuardStopSummary(syncValue, options = {}) {
  const experienceGuard = summarizeExperienceGuard(syncValue, { stopped: true });
  const err = new ExperienceGuardStopError(experienceGuard);
  return {
    err,
    experienceGuard,
    summary: buildAutomationStoppedSummary(err, options),
  };
}

function writeExperienceGuardStopStatus(syncValue, { cycle = null, action = null, iface = null, step = "experienceGuardStop" } = {}) {
  const { err, experienceGuard, summary } = createExperienceGuardStopSummary(syncValue, { cycle, step });
  logExperienceGuardActionSkip({ cycle, action, iface, experienceGuard });
  writeStatusDocuments(syncValue, {
    step,
    cycle,
    summary,
  });
  return err;
}

function createExperienceGuardedWs(ws, gsToken, syncRef, options = {}) {
  return createExperienceCommandClient(ws, gsToken, syncRef, options, {
    DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT,
    ExperienceActionBlockedError,
    ExperienceGuardStopError,
    buildExperienceSettlementAudit,
    classifyAutomationExperienceInterface,
    estimateExperienceAction,
    evaluateExperienceAction,
    formatExperienceGuardThresholdPercent,
    getExperienceGuardThresholdPercent,
    isAuthorizedTeamColdStartRequest,
    isValidExperienceGuardThresholdPercent,
    loadExperienceSettlementConfig,
    logExperienceGuardActionSkip,
    mergeLandSync,
    parseExperienceSettlementEvidence,
    refreshExperienceGuardSync,
    summarizeAccountLevel,
    summarizeExperienceGuard,
    washResponse,
    isSessionExpiredError,
    isWsRequestTimeoutError,
    isUserStoppedError,
  });
}

function normalizeExplicitCustomerOrderFlowerCurrencyRewardReleaseMask(value) {
  const normalized = normalizeCustomerOrderFlowerCurrencyRewardReleaseMask(value, null);
  return normalized == null ? 0 : normalized;
}

export function getCustomerOrderFlowerCurrencyRewardReleaseSetting() {
  const settingsPath = process.env.PROFILE_SETTINGS_PATH;
  const fallbackMask = DEFAULT_PROFILE_SETTINGS.customerOrderFlowerCurrencyRewardReleaseMask;
  if (!settingsPath) {
    return {
      mask: fallbackMask,
      rewards: getCustomerOrderFlowerCurrencyRewardReleaseRewards(fallbackMask),
      source: "profile-default",
      reason: null,
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        mask: 0,
        rewards: [],
        source: "profile-setting",
        reason: "invalid-profile-setting-fail-closed",
      };
    }
    if (!Object.hasOwn(raw, "customerOrderFlowerCurrencyRewardReleaseMask")) {
      return {
        mask: fallbackMask,
        rewards: getCustomerOrderFlowerCurrencyRewardReleaseRewards(fallbackMask),
        source: "profile-setting",
        reason: null,
      };
    }
    const rawMask = raw?.customerOrderFlowerCurrencyRewardReleaseMask;
    const mask = normalizeCustomerOrderFlowerCurrencyRewardReleaseMask(rawMask, null);
    if (mask == null) {
      return {
        mask: 0,
        rewards: [],
        source: "profile-setting",
        reason: "invalid-profile-setting-fail-closed",
      };
    }
    return {
      mask,
      rewards: getCustomerOrderFlowerCurrencyRewardReleaseRewards(mask),
      source: "profile-setting",
      reason: null,
    };
  } catch {
    return {
      mask: 0,
      rewards: [],
      source: "profile-setting",
      reason: "profile-setting-read-failed-fail-closed",
    };
  }
}
function getStructuredRequestError(err) {
  if (err?.errMsg && typeof err.errMsg === "object") return err.errMsg;
  const message = err?.message || String(err || "");
  const start = message.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(message.slice(start));
  } catch {
    return null;
  }
}

function isItemShortageError(err, itemId) {
  const shortage = getItemShortageError(err);
  return shortage?.itemId === Number(itemId);
}

function getItemShortageError(err) {
  const payload = getStructuredRequestError(err);
  const code = Number(payload?.code);
  const itemId = Number(payload?.param?.iid);
  if (code !== 301 || !Number.isFinite(itemId) || itemId <= 0) return null;
  return { code, itemId };
}

function setLocalBagItemCount(syncValue, itemId, count) {
  if (!itemId) return syncValue;
  const out = { ...syncValue };
  const usrTot = { ...(out.$usrTot || {}) };
  const dataKey = usrTot.data ? "data" : usrTot.usr ? "usr" : "data";
  const data = { ...(usrTot[dataKey] || {}) };
  const bag = { ...(data.bag || data.itemMap || usrTot.bag || usrTot.itemMap || {}) };
  bag[itemId] = Math.max(0, Math.floor(Number(count) || 0));
  data.bag = bag;
  usrTot[dataKey] = data;
  out.$usrTot = usrTot;
  return out;
}

function normalizeWaterDropAuthority(authority = {}) {
  const trust = authority.trust === "authoritative"
    ? "authoritative"
    : authority.trust === "unknown"
      ? "unknown"
      : "partial";
  const serverWaterDropCount = authority.serverWaterDropCount == null
    ? null
    : Math.max(0, Math.floor(Number(authority.serverWaterDropCount) || 0));
  return {
    trust,
    serverWaterDropCount: trust === "authoritative" ? serverWaterDropCount : null,
    serverWaterDropReason: authority.serverWaterDropReason || (
      trust === "authoritative" ? "authoritative-water-drop" : trust === "unknown" ? "missing-authoritative-water-drop" : "partial-or-merged-water-drop"
    ),
    sourcePath: authority.sourcePath || null,
    label: authority.label || null,
    atMs: authority.atMs || Date.now(),
  };
}

function setWaterDropAuthority(syncValue, authority) {
  if (!syncValue || typeof syncValue !== "object") return syncValue;
  return {
    ...syncValue,
    [WATER_DROP_AUTHORITY_FIELD]: normalizeWaterDropAuthority(authority),
  };
}

function getWaterDropAuthority(syncValue) {
  return normalizeWaterDropAuthority(syncValue?.[WATER_DROP_AUTHORITY_FIELD] || { trust: "partial" });
}

function isRawServerWaterDropSourcePath(sourcePath) {
  return /^(lazySync|usrLandRefresh|gsLogin|gsReconnectLogin|waterwheelReceive|freeWaterReceive)\./.test(String(sourcePath || ""));
}

function isClientComputedServerBaselineSourcePath(sourcePath) {
  const normalized = String(sourcePath || "");
  return normalized.includes("$usrTot.")
    && /\b(bag|itemMap)\[7\]/.test(normalized)
    && /\bitemExt(Map)?\[7\]/.test(normalized);
}

function isActionableWaterDropAuthority(authority) {
  const normalized = normalizeWaterDropAuthority(authority || { trust: "partial" });
  if (normalized.trust !== "authoritative") return false;
  if (normalized.serverWaterDropCount == null) return false;
  const reason = String(normalized.serverWaterDropReason || "");
  if (reason === "action-sync-authoritative-snapshot") return false;
  if (reason === "client-computed-server-baseline") {
    return isClientComputedServerBaselineSourcePath(normalized.sourcePath);
  }
  return isRawServerWaterDropSourcePath(normalized.sourcePath);
}

function isActionablePlantWaterRefill(plantWaterRefill) {
  return isActionableWaterDropAuthority({
    trust: plantWaterRefill?.waterDropTrust,
    serverWaterDropCount: plantWaterRefill?.serverWaterDropCount,
    serverWaterDropReason: plantWaterRefill?.serverWaterDropReason,
    sourcePath: plantWaterRefill?.serverWaterDropSourcePath,
    label: plantWaterRefill?.waterDropAuthorityLabel,
  });
}

function getAuthoritativeWaterDropCount(plantWaterRefill) {
  if (!isActionablePlantWaterRefill(plantWaterRefill)) return null;
  const count = Number(plantWaterRefill.serverWaterDropCount);
  return Number.isFinite(count) ? count : null;
}

function qualifyWaterDropSourcePath(sourcePath, prefix = "") {
  return prefix ? `${prefix}.${sourcePath}` : sourcePath;
}

function extractAuthoritativeWaterDropFromSync(value, options = {}) {
  const waterItemId = ITEM_IDS.WATER_DROP;
  const usrTot = value?.$usrTot || {};
  const data = usrTot.data || {};
  const usr = usrTot.usr || {};
  const sourcePrefix = options.sourcePrefix || "";
  const reason = options.reason || "authoritative-water-drop";
  const candidates = [
    { map: data.bag, sourcePath: "$usrTot.data.bag[7]" },
    { map: data.itemMap, sourcePath: "$usrTot.data.itemMap[7]" },
    { map: usr.bag, sourcePath: "$usrTot.usr.bag[7]" },
    { map: usr.itemMap, sourcePath: "$usrTot.usr.itemMap[7]" },
    { map: usrTot.bag, sourcePath: "$usrTot.bag[7]" },
    { map: usrTot.itemMap, sourcePath: "$usrTot.itemMap[7]" },
    { map: usrTot.oi?.bd, sourcePath: "$usrTot.oi.bd[7]" },
    { map: value?.oi?.bd, sourcePath: "oi.bd[7]" },
  ];

  for (const candidate of candidates) {
    const count = readOwnItemValue(candidate.map, waterItemId);
    if (count != null) {
      return {
        count: Math.max(0, Math.floor(count)),
        sourcePath: qualifyWaterDropSourcePath(candidate.sourcePath, sourcePrefix),
        reason,
      };
    }
  }

  return null;
}

function extractWaterDropRestoreSourcePathFromSync(value, options = {}) {
  const waterItemId = ITEM_IDS.WATER_DROP;
  const usrTot = value?.$usrTot || {};
  const data = usrTot.data || {};
  const usr = usrTot.usr || {};
  const sourcePrefix = options.sourcePrefix || "";
  const candidates = [
    { map: data.itemExtMap, sourcePath: "$usrTot.data.itemExtMap[7]" },
    { map: data.itemExt, sourcePath: "$usrTot.data.itemExt[7]" },
    { map: usr.itemExtMap, sourcePath: "$usrTot.usr.itemExtMap[7]" },
    { map: usr.itemExt, sourcePath: "$usrTot.usr.itemExt[7]" },
    { map: usrTot.itemExtMap, sourcePath: "$usrTot.itemExtMap[7]" },
    { map: usrTot.itemExt, sourcePath: "$usrTot.itemExt[7]" },
  ];

  for (const candidate of candidates) {
    if (hasOwnItemValue(candidate.map, waterItemId)) {
      return qualifyWaterDropSourcePath(candidate.sourcePath, sourcePrefix);
    }
  }

  return null;
}

function hasWaterDropDeltaFromSync(value) {
  const waterItemId = ITEM_IDS.WATER_DROP;
  const usrTot = value?.$usrTot || {};
  const candidates = [
    usrTot.itemAddChg?.itemMap,
    usrTot.itemAddChg?.items,
    usrTot.itemAddChg,
    usrTot.oi?.bi,
    usrTot.oi?.bo,
    value?.itemAddChg?.itemMap,
    value?.itemAddChg?.items,
    value?.itemAddChg,
    value?.oi?.bi,
    value?.oi?.bo,
  ];
  for (const record of usrTot.itemAddChg?.itemAddRcdList || []) {
    candidates.push(record?.itemMap);
  }
  return candidates.some((map) => hasOwnItemValue(map, waterItemId));
}

function logWaterDropBaselineEvent(step, label, authority) {
  console.log(JSON.stringify({
    step,
    label,
    waterDropTrust: authority.trust,
    serverWaterDropCount: authority.serverWaterDropCount,
    serverWaterDropReason: authority.serverWaterDropReason,
    serverWaterDropSourcePath: authority.sourcePath,
  }));
}

function invalidateWaterDropAuthorityAfterWaterSourceDelta(syncValue, updateValue, label) {
  const authoritative = extractServerSnapshotWaterDropFromSync(updateValue, {
    sourcePrefix: label,
    reason: "authoritative-water-drop",
  });
  if (authoritative) {
    const nextAuthority = normalizeWaterDropAuthority({
      trust: "authoritative",
      serverWaterDropCount: authoritative.count,
      serverWaterDropReason: authoritative.reason,
      sourcePath: authoritative.sourcePath,
      label,
    });
    logWaterDropBaselineEvent("waterDropBaselineEstablished", label, nextAuthority);
    return setWaterDropAuthority(syncValue, nextAuthority);
  }
  if (!hasWaterDropDeltaFromSync(updateValue)) return syncValue;
  return setWaterDropAuthority(syncValue, {
    trust: "unknown",
    serverWaterDropReason: "post-refill-water-delta-needs-server-refresh",
    label,
  });
}

function joinWaterDropSnapshotSourcePath(baseSourcePath, restoreSourcePath) {
  return restoreSourcePath ? `${baseSourcePath} + ${restoreSourcePath}` : baseSourcePath;
}

function extractServerSnapshotWaterDropFromSync(value, options = {}) {
  const authoritative = extractAuthoritativeWaterDropFromSync(value, options);
  if (!authoritative) return null;

  const snapshotValue = setLocalBagItemCount(value || {}, ITEM_IDS.WATER_DROP, authoritative.count);
  const waterDrop = getWaterDropStatus(snapshotValue);
  const restoreSourcePath = extractWaterDropRestoreSourcePathFromSync(snapshotValue, options);
  return {
    count: Math.max(0, Math.floor(Number(waterDrop.count) || 0)),
    baseCount: authoritative.count,
    sourcePath: joinWaterDropSnapshotSourcePath(authoritative.sourcePath, restoreSourcePath),
    restoreSourcePath,
    reason: authoritative.reason,
  };
}

function extractClientComputedWaterDropBaselineFromSync(value, options = {}) {
  const restoreSourcePath = extractWaterDropRestoreSourcePathFromSync(value, options);
  if (!restoreSourcePath) return null;
  const sourcePrefix = options.sourcePrefix || "";
  const waterDrop = getWaterDropStatus(value);
  return {
    count: Math.max(0, Math.floor(Number(waterDrop.count) || 0)),
    baseCount: Math.max(0, Math.floor(Number(waterDrop.baseCount) || 0)),
    sourcePath: joinWaterDropSnapshotSourcePath(
      qualifyWaterDropSourcePath("$usrTot.data.bag[7]", sourcePrefix),
      restoreSourcePath,
    ),
    restoreSourcePath,
    reason: "client-computed-server-baseline",
  };
}

function isFreshWaterwheelPostReceiveServerSnapshot(authority) {
  return isActionableWaterDropAuthority(authority)
    && String(authority?.serverWaterDropReason || "") === "authoritative-water-drop"
    && /^(lazySync|usrLandRefresh|waterwheelReceive|freeWaterReceive)\./.test(String(authority?.sourcePath || ""));
}

function isUsablePostRefillWaterDropAuthority(authority) {
  return isFreshWaterwheelPostReceiveServerSnapshot(authority)
    || (
      isActionableWaterDropAuthority(authority)
      && String(authority?.serverWaterDropReason || "") === "client-computed-server-baseline"
    )
    || (
      isActionableWaterDropAuthority(authority)
      && String(authority?.serverWaterDropReason || "") === "merged-authoritative-snapshot"
      && /^(waterwheelReceive|freeWaterReceive)\./.test(String(authority?.sourcePath || ""))
    );
}

function canRecoverMergedWaterDropAuthority(previousAuthority, mergedAuthoritative, options = {}) {
  if (options.allowMergedAuthoritativeSnapshotFromPrevious === false) return false;
  if (!isActionableWaterDropAuthority(previousAuthority)) return false;
  return Boolean(mergedAuthoritative?.restoreSourcePath);
}

function isUntrustedPostRefillWaterDropReason(reason) {
  const normalized = String(reason || "");
  return normalized === "post-refill-water-delta-needs-server-refresh"
    || normalized === "missing-post-refill-server-water-drop-snapshot"
    || normalized === "waterwheel-water-sync-untrusted";
}

function canPromoteMergedClientWaterDropBaseline(previousAuthority, mergedAuthoritative, options = {}) {
  if (options.allowMergedAuthoritativeSnapshotFromPrevious === false) return false;
  if (!mergedAuthoritative?.restoreSourcePath) return false;
  if (!isClientComputedServerBaselineSourcePath(mergedAuthoritative.sourcePath)) return false;
  const previousReason = String(previousAuthority?.serverWaterDropReason || "");
  if (isUntrustedPostRefillWaterDropReason(previousReason)) return false;
  return true;
}

function mergeAuthoritativeWaterDropSync(syncValue, updateValue, label = "authoritativeWaterDropRefresh", options = {}) {
  const merged = updateValue ? mergeLandSync(syncValue, updateValue) : syncValue;
  const previousAuthority = getWaterDropAuthority(syncValue);
  const authoritative = extractServerSnapshotWaterDropFromSync(updateValue, {
    sourcePrefix: options.rawSourcePrefix || "lazySync",
    reason: "authoritative-water-drop",
  });
  if (!authoritative) {
    const hasWaterDropDelta = hasWaterDropDeltaFromSync(updateValue);
    const mergedAuthoritative = extractServerSnapshotWaterDropFromSync(merged, {
      sourcePrefix: options.mergedSourcePrefix || "merged",
      reason: "merged-authoritative-snapshot",
    }) || extractClientComputedWaterDropBaselineFromSync(merged, {
      sourcePrefix: options.mergedSourcePrefix || "merged",
    });
    const canRecoverPreviousAuthority = canRecoverMergedWaterDropAuthority(previousAuthority, mergedAuthoritative, options);
    const canPromoteClientBaseline = canPromoteMergedClientWaterDropBaseline(previousAuthority, mergedAuthoritative, options);
    if (!hasWaterDropDelta && mergedAuthoritative && (canRecoverPreviousAuthority || canPromoteClientBaseline)) {
      const nextAuthority = normalizeWaterDropAuthority({
        trust: "authoritative",
        serverWaterDropCount: mergedAuthoritative.count,
        serverWaterDropReason: previousAuthority.serverWaterDropReason === "client-computed-server-baseline" || mergedAuthoritative.reason === "client-computed-server-baseline" || canPromoteClientBaseline
          ? "client-computed-server-baseline"
          : mergedAuthoritative.reason,
        sourcePath: canRecoverPreviousAuthority && previousAuthority.sourcePath
          ? previousAuthority.sourcePath
          : mergedAuthoritative.sourcePath,
        label,
      });
      if (previousAuthority.trust !== "authoritative") {
        logWaterDropBaselineEvent("waterDropBaselineEstablished", label, nextAuthority);
      }
      return setWaterDropAuthority(merged, {
        ...nextAuthority,
      });
    }
    const previousReason = String(previousAuthority?.serverWaterDropReason || "");
    return setWaterDropAuthority(merged, {
      trust: "unknown",
      serverWaterDropReason: isUntrustedPostRefillWaterDropReason(previousReason)
        ? previousReason
        : "missing-authoritative-water-drop",
      label,
    });
  }

  const nextAuthority = normalizeWaterDropAuthority({
    trust: "authoritative",
    serverWaterDropCount: authoritative.count,
    serverWaterDropReason: authoritative.reason,
    sourcePath: authoritative.sourcePath,
    label,
  });
  if (previousAuthority.trust !== "authoritative") {
    logWaterDropBaselineEvent("waterDropBaselineEstablished", label, nextAuthority);
  }
  return setWaterDropAuthority(merged, {
    ...nextAuthority,
  });
}

async function refreshAuthoritativeWaterDrop(ws, gsToken, syncValue, label = "authoritativeWaterDropRefresh", options = {}) {
  const beforeWaterDrop = getWaterDropStatus(syncValue);
  const lazy = await requestSync(ws, gsToken, "gs.usr.lazySync", {}, `${label} failed`);
  const next = mergeAuthoritativeWaterDropSync(syncValue, lazy.value, label, options);
  const afterWaterDrop = getWaterDropStatus(next);
  const authority = getWaterDropAuthority(next);
  if (options.log !== false) {
    console.log(JSON.stringify({
      step: label,
      iface: "gs.usr.lazySync",
      dsName: lazy.dsName,
      waterDropTrust: authority.trust,
      serverWaterDropCount: authority.serverWaterDropCount,
      serverWaterDropReason: authority.serverWaterDropReason,
      serverWaterDropSourcePath: authority.sourcePath,
      beforeLocalWaterDropCount: beforeWaterDrop.count,
      afterLocalWaterDropCount: afterWaterDrop.count,
      beforeWaterDropText: `${beforeWaterDrop.count}/${beforeWaterDrop.displayLimit}`,
      afterWaterDropText: `${afterWaterDrop.count}/${afterWaterDrop.displayLimit}`,
      err: null,
    }));
  }
  return next;
}

async function refreshLand(ws, gsToken, syncValue, label = "usrLandRefresh", options = {}) {
  const beforeWaterDrop = getWaterDropStatus(syncValue);
  const refresh = await requestSync(ws, gsToken, "gs.usrLand.refresh", {}, "Land refresh failed");
  const next = mergeAuthoritativeWaterDropSync(syncValue, refresh.value, label, {
    rawSourcePrefix: "usrLandRefresh",
    mergedSourcePrefix: "merged",
    allowMergedAuthoritativeSnapshotFromPrevious: options.allowMergedAuthoritativeSnapshotFromPrevious,
  });
  const afterWaterDrop = getWaterDropStatus(next);
  const authority = getWaterDropAuthority(next);
  if (options.log !== false) {
    console.log(JSON.stringify({
      step: label,
      iface: "gs.usrLand.refresh",
      dsName: refresh.dsName,
      waterDropTrust: authority.trust,
      serverWaterDropCount: authority.serverWaterDropCount,
      serverWaterDropReason: authority.serverWaterDropReason,
      serverWaterDropSourcePath: authority.sourcePath,
      beforeLocalWaterDropCount: beforeWaterDrop.count,
      afterLocalWaterDropCount: afterWaterDrop.count,
      beforeWaterDropText: `${beforeWaterDrop.count}/${beforeWaterDrop.displayLimit}`,
      afterWaterDropText: `${afterWaterDrop.count}/${afterWaterDrop.displayLimit}`,
      err: null,
    }));
  }
  return next;
}

function shouldRefreshLandForPotentialWaterAuthority(plantWaterRefill) {
  if (!plantWaterRefill?.needsPlanting) return false;
  return !isActionablePlantWaterRefill(plantWaterRefill);
}

async function refreshLandForPotentialWaterAuthority(ws, gsToken, syncValue, plantWaterRefill, label) {
  if (!shouldRefreshLandForPotentialWaterAuthority(plantWaterRefill)) {
    return { syncValue, plantWaterRefill, refreshed: false };
  }
  const next = await refreshLand(ws, gsToken, syncValue, label);
  return {
    syncValue: next,
    plantWaterRefill: getPlantWaterRefillContext(next),
    refreshed: true,
  };
}

async function refreshInventoryBeforePlant(ws, gsToken, syncValue, label = "inventoryRefreshBeforePlant") {
  const beforeBag = getBag(syncValue);
  const beforeFlowerCount = Object.keys(beforeBag).filter((id) => Number(id) >= 23000 && Number(id) < 24000).length;
  const beforeWaterDrop = getWaterDropStatus(syncValue);
  const lazy = await requestSync(ws, gsToken, "gs.usr.lazySync", {}, "Inventory refresh before plant failed");
  const next = mergeAuthoritativeWaterDropSync(syncValue, lazy.value, label, {
    allowMergedAuthoritativeSnapshotFromUnknown: true,
  });
  const afterBag = getBag(next);
  const afterFlowerCount = Object.keys(afterBag).filter((id) => Number(id) >= 23000 && Number(id) < 24000).length;
  const afterWaterDrop = getWaterDropStatus(next);
  const authority = getWaterDropAuthority(next);
  console.log(JSON.stringify({
    step: label,
    iface: "gs.usr.lazySync",
    dsName: lazy.dsName,
    bagPath: "$usrTot.data.bag",
    beforeFlowerItemCount: beforeFlowerCount,
    afterFlowerItemCount: afterFlowerCount,
    beforeWaterDropCount: beforeWaterDrop.count,
    afterWaterDropCount: afterWaterDrop.count,
    beforeWaterDropText: `${beforeWaterDrop.count}/${beforeWaterDrop.displayLimit}`,
    afterWaterDropText: `${afterWaterDrop.count}/${afterWaterDrop.displayLimit}`,
    waterDropTrust: authority.trust,
    serverWaterDropCount: authority.serverWaterDropCount,
    serverWaterDropReason: authority.serverWaterDropReason,
    serverWaterDropSourcePath: authority.sourcePath,
    waterDropCountSource: authority.trust === "authoritative"
      ? authority.serverWaterDropReason === "merged-authoritative-snapshot"
        ? "merged-authoritative-snapshot"
        : "lazySync-authoritative"
      : afterWaterDrop.count < beforeWaterDrop.count ? "lazySync-lower" : "lazySync",
  }));
  return next;
}

function buildMissingCultivationCostInfo(cultivationCost, bag = {}) {
  const missingCosts = (cultivationCost?.costs || [])
    .map((cost) => {
      const have = Number(bag[cost.itemId] ?? bag[String(cost.itemId)] ?? 0);
      const missing = Math.max(0, cost.count - have);
      if (missing <= 0) return null;
      return {
        itemId: cost.itemId,
        itemName: cost.itemName,
        need: cost.count,
        have,
        missing,
        text: `${cost.itemName} (${cost.itemId}) x${missing}`,
      };
    })
    .filter(Boolean);

  return {
    costs: missingCosts,
    costText: missingCosts.map((cost) => cost.text).join("；") || "-",
  };
}

function decorateFlowerRows(rows, flowerNames, bag = {}) {
  return rows.map((item) => {
    const lvlNumber = Number(item.lvl);
    const hasLevel = Number.isFinite(lvlNumber);
    const cultivated = hasLevel && lvlNumber > 1;
    const acquisition = getFlowerAcquisitionInfo(item.flowerId);
    const cultivationCost = getFlowerCultivationCostInfo(item.flowerId);
    const missingCultivationCost = buildMissingCultivationCostInfo(cultivationCost, bag);
    return {
      flowerId: item.flowerId,
      flowerName: flowerName(item.flowerId, flowerNames),
      count: item.count,
      lvl: item.lvl || "-",
      rawLvl: item.lvl ?? "",
      cultivated,
      cultivatedText: cultivated ? "是" : hasLevel && lvlNumber === 1 ? "否（等级1）" : "否",
      seedId: acquisition.seedId,
      eliteId: acquisition.eliteId,
      acquisitionText: acquisition.sourceText,
      acquisition,
      cultivationCostText: cultivationCost.costText,
      cultivationCost,
      missingCultivationCostText: missingCultivationCost.costText,
      missingCultivationCost,
      maturitySeconds: item.maturitySeconds ?? null,
      maturityRawCd: item.maturityRawCd ?? null,
      maturityTimeStep: item.maturityTimeStep ?? null,
      maturityText: formatMaturitySeconds(item.maturitySeconds),
      baseMaturityText: formatMaturitySeconds(item.maturityRawCd),
      advanceHarvestIntervalReductionSeconds: item.advanceHarvestIntervalReductionSeconds ?? 0,
      advanceHarvestIntervalReductionText: formatPlainSeconds(item.advanceHarvestIntervalReductionSeconds ?? 0),
      advanceEffects: item.advanceEffects || {},
      advanceSlots: item.advanceSlots || [],
      maturitySource: item.maturitySource || "-",
      plantedCount: item.plantedCount ?? 0,
      cTimeText: formatDateTime(item.cTime),
    };
  });
}

function sortStatusFlowerInventory(rows) {
  return [...rows].sort((a, b) => {
    if (a.cultivated !== b.cultivated) return a.cultivated ? -1 : 1;
    return Number(a.count || 0) - Number(b.count || 0) || Number(a.flowerId || 0) - Number(b.flowerId || 0);
  });
}

function sortUncultivatedFlowerInventory(rows) {
  return [...rows].sort((a, b) => {
    const acquiredA = a.rawLvl !== "";
    const acquiredB = b.rawLvl !== "";
    if (acquiredA !== acquiredB) return acquiredA ? -1 : 1;
    return Number(a.count || 0) - Number(b.count || 0) || Number(a.flowerId || 0) - Number(b.flowerId || 0);
  });
}

function isSummaryOnlyLog() {
  return process.env.SUMMARY_ONLY === "1";
}

function logStructured(fullEntry, compactEntry = fullEntry) {
  const entry = isSummaryOnlyLog() ? compactEntry : fullEntry;
  console.log(JSON.stringify(entry, null, isSummaryOnlyLog() ? 0 : 2));
}

function compactFlowerOrderStatus(order) {
  if (!order) return null;
  return {
    status: order.status,
    statusText: order.statusText,
    canFinish: order.canFinish,
    canSubmit: order.canSubmit,
    autoSubmitText: orderAutoSubmitText(order),
    completedCount: order.completedCount,
    finishCnt: order.finishCnt,
    remainingText: order.remainingText,
    cdTimeText: order.cdTimeText,
    isVideo: order.isVideo,
    requirements: (order.requirements || []).map((item) => ({
      flowerId: item.flowerId,
      flowerName: item.flowerName,
      have: item.have,
      need: item.need,
      missing: item.missing,
      enough: item.enough,
    })),
    serverConfirmedOutOfStock: order.serverConfirmedOutOfStock === true,
    stockRejection: order.stockRejection || null,
  };
}

function logPlantSelectionParsed(syncValue, context = {}) {
  const { flowerNames: providedFlowerNames, ...logContext } = context;
  const flowerNames = providedFlowerNames || loadFlowerNameMap();
  const inventory = getCultivatedFlowerInventory(syncValue);
  const state = getState(syncValue);
  const selected = state.recommendation.plantFlower;
  const selectedInventory = selected
    ? inventory.find((item) => item.flowerId === selected.flowerId)
    : null;
  const fullEntry = {
    step: "plantSelectionParsed",
    rule: PLANT_SELECTION_RULE_TEXT,
    inventoryScope: "cultivation level > 1 only",
    inventorySource: "$usrTot.data.bag merged with $usrTot.itemAddChg.itemMap",
    ...logContext,
    selected: selected ? {
      flowerId: selected.flowerId,
      flowerName: flowerName(selected.flowerId, flowerNames),
      count: selected.count,
      lvl: selected.lvl,
      plantPriorityReason: selected.plantPriorityReason,
      palaceOrderNeed: selected.palaceOrderNeed,
      palaceOrderHave: selected.palaceOrderHave,
      palaceOrderMissing: selected.palaceOrderMissing,
      maturitySeconds: selectedInventory?.maturitySeconds ?? null,
      maturityRawCd: selectedInventory?.maturityRawCd ?? null,
      maturityTimeStep: selectedInventory?.maturityTimeStep ?? null,
      maturityText: formatMaturitySeconds(selectedInventory?.maturitySeconds),
      baseMaturityText: formatMaturitySeconds(selectedInventory?.maturityRawCd),
      advanceHarvestIntervalReductionSeconds: selectedInventory?.advanceHarvestIntervalReductionSeconds ?? 0,
      advanceHarvestIntervalReductionText: formatPlainSeconds(selectedInventory?.advanceHarvestIntervalReductionSeconds ?? 0),
      advanceEffects: selectedInventory?.advanceEffects || {},
      advanceSlots: selectedInventory?.advanceSlots || [],
      maturitySource: selectedInventory?.maturitySource || "-",
      cTimeText: formatDateTime(selected.cTime),
    } : null,
    inventorySortedTop20: decorateFlowerRows(inventory.slice(0, 20), flowerNames),
    candidateSortedTop10: state.candidates.slice(0, 10).map((item) => ({
      flowerId: item.flowerId,
      flowerName: flowerName(item.flowerId, flowerNames),
      count: item.count,
      lvl: item.lvl,
      plantPriorityReason: item.plantPriorityReason,
      palaceOrderNeed: item.palaceOrderNeed,
      palaceOrderHave: item.palaceOrderHave,
      palaceOrderMissing: item.palaceOrderMissing,
      cTimeText: formatDateTime(item.cTime),
    })),
  };
  logStructured(fullEntry, {
    step: "plantSelectionParsed",
    cycle: context.cycle ?? null,
    mode: context.mode ?? null,
    emptyLandCount: context.emptyLandCount ?? null,
    selected: fullEntry.selected ? {
      flowerId: fullEntry.selected.flowerId,
      flowerName: fullEntry.selected.flowerName,
      count: fullEntry.selected.count,
      lvl: fullEntry.selected.lvl,
      plantPriorityReason: fullEntry.selected.plantPriorityReason,
      palaceOrderMissing: fullEntry.selected.palaceOrderMissing,
      maturityText: fullEntry.selected.maturityText,
    } : null,
    candidateTop3: fullEntry.candidateSortedTop10.slice(0, 3).map((item) => ({
      flowerId: item.flowerId,
      flowerName: item.flowerName,
      count: item.count,
      lvl: item.lvl,
      plantPriorityReason: item.plantPriorityReason,
      palaceOrderMissing: item.palaceOrderMissing,
    })),
  });
}

function logOrderStatusParsed(syncValue, context = {}) {
  const { flowerNames: providedFlowerNames, ...logContext } = context;
  const flowerNames = providedFlowerNames || loadFlowerNameMap();
  const customerOrderFlowerCurrencyHistory = context.customerOrderFlowerCurrencyHistory
    || loadCustomerOrderFlowerCurrencyHistoryContext(syncValue, context);
  const customerOrderRewardReleaseSetting = Object.hasOwn(
    context,
    "customerOrderFlowerCurrencyRewardReleaseMask",
  )
    ? {
      mask: normalizeExplicitCustomerOrderFlowerCurrencyRewardReleaseMask(
        context.customerOrderFlowerCurrencyRewardReleaseMask,
      ),
    }
    : getCustomerOrderFlowerCurrencyRewardReleaseSetting();
  const nowMs = Number.isFinite(context.nowMs)
    ? context.nowMs
    : (Number.isFinite(context.actionTime?.nowMs) ? context.actionTime.nowMs : undefined);
  const orderTime = Number.isFinite(nowMs) ? { nowMs } : {};
  const flowerOrderStatus = summarizeOrderFlowerStatus(syncValue, {
    nameMap: flowerNames,
    teamOrderCapability: context.teamOrderCapability,
    ...orderTime,
  });
  const customerStatus = summarizeOrderCustomerStatus(syncValue, {
    nameMap: flowerNames,
    customerOrderFlowerCurrencyHistory,
    customerOrderFlowerCurrencyRewardReleaseMask: customerOrderRewardReleaseSetting.mask,
    ...(Object.hasOwn(context, "flowerArtConfig")
      ? { flowerArtConfig: context.flowerArtConfig }
      : {}),
    ...(Object.hasOwn(context, "orderCustomerNpcConfig")
      ? { orderCustomerNpcConfig: context.orderCustomerNpcConfig }
      : {}),
    ...orderTime,
  });
  const palaceStatus = summarizeOrderPalaceStatus(syncValue, {
    nameMap: flowerNames,
    ...orderTime,
  });
  const orderStatus = {
    ...flowerOrderStatus,
    customer: customerStatus,
    palace: palaceStatus,
  };
  const parsed = {
    step: "orderStatusParsed",
    mapping: {
      satin: "orderFlowerTot.orderFlower.orderSatin",
      decorate: "orderFlowerTot.orderFlower.orderDecorate",
      customer: "orderCustomerTot.orderCustomer.orderMap",
      palace: "orderPalaceTot.orderPalace",
    },
    runHistory,
    customerOrderFlowerCurrencyHistory,
    customerOrderFlowerCurrencyRewardReleaseSetting: customerOrderRewardReleaseSetting,
    ...logContext,
    ...orderStatus,
  };
  logStructured(parsed, {
    step: "orderStatusParsed",
    cycle: context.cycle ?? null,
    mode: context.mode ?? null,
    phase: context.phase ?? null,
    iface: context.iface ?? null,
    satin: compactFlowerOrderStatus(orderStatus.satin),
    decorate: compactFlowerOrderStatus(orderStatus.decorate),
    customer: {
      total: customerStatus.total,
      readyCount: customerStatus.readyCount,
      makeArtReadyCount: customerStatus.makeArtReadyCount,
      temporaryOutOfStockCount: customerStatus.temporaryOutOfStockCount,
      inactiveArtCount: customerStatus.inactiveArtCount,
      pendingWaitCount: customerStatus.pendingWaitCount,
      flowerCurrencySelection: customerStatus.flowerCurrencySelection,
      customerOrderFlowerCurrencyHistory,
      dailyLimit: customerStatus.dailyLimit,
      doubleGoldReady: customerStatus.doubleGoldGate?.ready ?? false,
      doubleGoldReason: customerStatus.doubleGoldGate?.reasonText ?? null,
    },
    palace: {
      exists: palaceStatus.exists,
      status: palaceStatus.status,
      statusText: palaceStatus.statusText,
      canFinish: palaceStatus.canFinish,
      flowerId: palaceStatus.flowerId,
      have: palaceStatus.have,
      need: palaceStatus.need,
      missing: palaceStatus.missing,
      doubleGoldReady: palaceStatus.doubleGoldGate?.ready ?? false,
      doubleGoldReason: palaceStatus.doubleGoldGate?.reasonText ?? null,
    },
  });
  const orderDocument = writeOrderStatusDocument(orderStatus, {
    fsModule: fs,
    runHistory,
    writeStatusArtifacts,
  });
  Object.defineProperty(orderStatus, "artifactCompletion", {
    configurable: true,
    enumerable: false,
    value: summarizeArtifactSubmission("order", [orderDocument.writeResult], {
      requiredTargets: [orderDocument.jsonPath],
    }),
  });
  return orderStatus;
}

async function refreshSpecialOrders(ws, gsToken, syncValue, label = "orderFlowerEnter") {
  const orderRaw = await ws.request("gs.orderFlower.enter", {}, gsToken);
  const orderRsp = washResponse(orderRaw);
  if (orderRsp.errMsg) throw new Error(`${label} failed: ${JSON.stringify(orderRsp.errMsg)}`);
  const next = orderRsp.value
    ? mergeLandSync(syncValue, orderRsp.value)
    : syncValue;
  console.log(JSON.stringify({ step: label, iface: "gs.orderFlower.enter", dsName: orderRsp.dsName, err: null }));
  return next;
}

const SPECIAL_ORDER_REFRESH_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function getSpecialOrderRefreshDateKey(nowMs) {
  if (!Number.isFinite(nowMs)) return null;
  const parts = Object.fromEntries(
    SPECIAL_ORDER_REFRESH_DATE_FORMATTER
      .formatToParts(new Date(nowMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function createSpecialOrderRefreshState() {
  return {
    observedDateKey: null,
    refreshedDateKey: null,
  };
}

function getSpecialOrderRefreshReason(syncValue, refreshState, nowMs) {
  const dateKey = getSpecialOrderRefreshDateKey(nowMs);
  const orderFlower = syncValue?.orderFlowerTot?.orderFlower;
  const missingOrderTime = ["orderSatin", "orderDecorate"].some((key) => (
    !orderFlower?.[key]?.cTime
  ));
  const naturalDayChanged = Boolean(
    dateKey
    && refreshState.observedDateKey
    && refreshState.observedDateKey !== dateKey
  );
  if (dateKey) refreshState.observedDateKey = dateKey;
  if (!dateKey || refreshState.refreshedDateKey === dateKey) return null;
  if (naturalDayChanged) return "natural-day-rollover";
  return missingOrderTime ? "special-order-time-missing" : null;
}

async function refreshSpecialOrdersWhenRequired(
  ws,
  gsToken,
  syncValue,
  label,
  options = {},
) {
  const refreshState = options.specialOrderRefreshState
    || createSpecialOrderRefreshState();
  const actionTime = resolveResourceActionTime(syncValue, options);
  const reason = getSpecialOrderRefreshReason(syncValue, refreshState, actionTime.nowMs);
  if (!reason) return syncValue;
  const next = await refreshSpecialOrders(ws, gsToken, syncValue, label);
  refreshState.refreshedDateKey = getSpecialOrderRefreshDateKey(actionTime.nowMs);
  console.log(JSON.stringify({
    step: "specialOrderRefreshRequired",
    label,
    reason,
    dateKey: refreshState.refreshedDateKey,
  }));
  return next;
}

async function refreshSpecialOrderStockTruth(
  ws,
  gsToken,
  syncValue,
  recordCycleError = null,
) {
  let next = syncValue;
  const refreshErrors = [];
  const steps = [
    {
      errorStep: "specialOrderStockLazySyncError",
      run: () => refreshLazySync(
        ws,
        gsToken,
        next,
        "specialOrderStockLazySyncAfterRejected",
      ),
    },
    {
      errorStep: "specialOrderStockOrderRefreshError",
      run: () => refreshSpecialOrders(
        ws,
        gsToken,
        next,
        "specialOrderStockRefreshAfterRejected",
      ),
    },
  ];
  for (const step of steps) {
    try {
      next = await step.run();
    } catch (error) {
      if (
        isSessionExpiredError(error)
        || isWsRequestTimeoutError(error)
        || isExperienceGuardError(error)
        || isUserStoppedError(error)
      ) {
        throw error;
      }
      refreshErrors.push(error?.message || String(error));
      recordCycleError?.(step.errorStep, error);
    }
  }
  return {
    syncValue: next,
    refreshError: refreshErrors.length ? refreshErrors.join("; ") : null,
  };
}

async function refreshLazySync(ws, gsToken, syncValue, label = "lazySyncRefresh", options = {}) {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error(String(options.signal.reason || "request aborted"));
  }
  const timeAuthorityNowFn = typeof options.timeAuthorityNowFn === "function"
    ? options.timeAuthorityNowFn
    : Date.now;
  const requestStartedAtMs = timeAuthorityNowFn();
  const lazyRaw = await ws.request("gs.usr.lazySync", {}, gsToken);
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error(String(options.signal.reason || "request aborted"));
  }
  const lazy = washResponse(lazyRaw);
  if (lazy.errMsg) throw new Error(`${label} failed: ${JSON.stringify(lazy.errMsg)}`);
  const responseAtMs = timeAuthorityNowFn();
  const hardSyncedValue = lazy.value
    ? attachHardSyncState(lazy.value, {
      serverMs: lazy.value?.$other?.ms,
      requestStartedAtMs,
      responseAtMs,
      maxAgeMs: options.timeAuthorityMaxAgeMs,
    })
    : lazy.value;
  const waterMerged = hardSyncedValue ? mergeAuthoritativeWaterDropSync(syncValue, hardSyncedValue, label, {
    rawSourcePrefix: "lazySync",
    mergedSourcePrefix: "merged",
  }) : syncValue;
  const next = waterMerged;
  if (options.log !== false) {
    console.log(JSON.stringify({ step: label, iface: "gs.usr.lazySync", dsName: lazy.dsName, err: null }));
  }
  if (options.returnDetails === true) {
    return {
      syncValue: next,
      authoritativePayload: lazy.value ?? null,
      hardSyncedValue,
      requestStartedAtMs,
      responseAtMs,
      dsName: lazy.dsName,
    };
  }
  return next;
}

async function refreshCyclicNoteStatus(
  ws,
  gsToken,
  syncValue,
  batchId,
  cycle = null,
  step = "cyclicNoteStatusRefresh",
  options = {},
) {
  // Every enter is independently guarded with the current clock and the
  // current snapshot's authority; a previously trusted actionTime is never
  // reused for a later request.
  const preEnterStatus = summarizeCyclicNoteWithResourceActionTime(syncValue, options, {
    forceCurrentTime: true,
  });
  const missingAuthoritativeRecord = [
    "missing-authoritative-task-record",
    "missing-authoritative-task-progress",
    "missing-authoritative-task-recv-map",
  ].includes(preEnterStatus.snapshotError);
  const canEnterToReadAuthoritativeRecord = missingAuthoritativeRecord
    && preEnterStatus.active === true
    && preEnterStatus.timeTrusted === true;
  const skipReason = preEnterStatus.executionSafe !== true && !canEnterToReadAuthoritativeRecord
    ? (preEnterStatus.snapshotError || "cyclic-note-execution-unsafe")
    : !isSafePositiveCyclicNoteBatchId(batchId)
      ? "invalid-batch-id"
      : preEnterStatus.batchId !== batchId
        ? "batch-drift"
        : null;
  if (skipReason) {
    const diagnostic = {
      reason: skipReason,
      snapshotError: preEnterStatus.snapshotError,
      timeTrusted: preEnterStatus.timeTrusted,
      timeAuthorityReason: preEnterStatus.timeAuthorityReason,
      clockSource: preEnterStatus.clockSource,
      currentBatchId: preEnterStatus.batchId,
    };
    console.log(JSON.stringify({
      step: "cyclicNoteEnterSkipped",
      cycle,
      iface: CYCLIC_NOTE_ENTER_IFACE,
      batchId,
      reason: skipReason,
      phase: preEnterStatus.phase,
      timeTrusted: preEnterStatus.timeTrusted,
      timeAuthorityReason: preEnterStatus.timeAuthorityReason,
      clockSource: preEnterStatus.clockSource,
      err: null,
    }));
    return {
      syncValue,
      status: preEnterStatus,
      skipped: true,
      skipReason,
      diagnostic,
    };
  }
  const enter = await requestSync(
    ws,
    gsToken,
    CYCLIC_NOTE_ENTER_IFACE,
    { batchId },
    "Cyclic note enter failed",
  );
  // The official client feeds the enter response through G.ISyncData, whose
  // controller listeners update only the fields carried by that payload.  An
  // enter response is therefore an incremental sync, not a replacement for
  // the earlier complete activity snapshot.
  const next = enter.value ? mergeLandSync(syncValue, enter.value) : syncValue;
  const status = summarizeCyclicNoteWithResourceActionTime(next, options, {
    forceCurrentTime: true,
  });
  console.log(JSON.stringify({
    step,
    cycle,
    iface: CYCLIC_NOTE_ENTER_IFACE,
    batchId,
    status: status.reason,
    active: status.active,
    phase: status.phase,
    dsName: enter.dsName,
    err: null,
  }));
  return { syncValue: next, status, skipped: false, skipReason: null };
}

function specialOrderAuthorityIdentity(order) {
  if (!order?.exists || order.stateKnown !== true || order.canFinish !== true
    || order.isVideo || !Array.isArray(order.requirements) || !order.requirements.length) {
    return null;
  }
  const finishCnt = Number(order.finishCnt);
  const cTimeMs = parseTimeMs(order.cTime);
  const cdTimeMs = parseTimeMs(order.cdTime);
  if (!Number.isSafeInteger(finishCnt) || finishCnt < 0 || cTimeMs <= 0 || cdTimeMs <= 0) {
    return null;
  }
  return JSON.stringify({
    requirements: order.requirements
      .map((item) => [item.itemId, item.need])
      .sort((left, right) => Number(left[0]) - Number(right[0]) || Number(left[1]) - Number(right[1])),
    npcId: order.npcId ?? null,
    dialogId: order.dialogId ?? null,
    finishCnt,
    isVideo: order.isVideo === true ? 1 : 0,
    cTime: order.cTime,
    cdTime: order.cdTime,
  });
}

function ordinaryResidentOrderAuthorityIdentity(order) {
  if (!order?.exists || order.stateKnown !== true || order.canFinish !== true
    || order.isVideo || !Number.isSafeInteger(Number(order.boxId))) return null;
  const finishCnt = Number(order.finishCnt);
  const cTimeMs = parseTimeMs(order.cTime);
  const cdTimeMs = parseTimeMs(order.cdTime);
  if (!Number.isSafeInteger(finishCnt) || finishCnt < 0 || cTimeMs <= 0 || cdTimeMs <= 0) {
    return null;
  }
  return JSON.stringify({
    boxId: Number(order.boxId),
    requirements: (order.requirements || [])
      .map((item) => [item.itemId, item.need])
      .sort((left, right) => Number(left[0]) - Number(right[0]) || Number(left[1]) - Number(right[1])),
    finishCnt,
    isVideo: order.isVideo === true ? 1 : 0,
    cTime: order.cTime,
    cdTime: order.cdTime,
  });
}

function resolveResidentOrderValidationCapability(requestContext = {}) {
  // requestResidentOrderAction carries the plan-time release evidence on the
  // request context: teamTriggerDecision is populated for every authorized
  // 49/99 crossing by getAutoSubmitOrderActions and re-validated by the
  // preflight plan before the send. The final authority re-summarize must use
  // that same released protection state; without it a still-unchanged order is
  // re-reported as stopped (resident-board-stop) and the send is rejected.
  const decision = requestContext?.teamTriggerDecision;
  if (decision && decision.blocked === false) {
    return {
      ready: true,
      teamOrderTriggerProtectionEnabled: false,
      requiresExperienceTriggerDecision: true,
      source: "authorized-crossing-decision",
      reason: decision.reason ?? null,
      reservationId: decision.teamOrderReservationId ?? null,
    };
  }
  return null;
}

function validateResidentOrderAfterAuthorityRefresh({
  iface,
  arg,
  syncValue,
  requestContext,
} = {}) {
  const expected = requestContext?.specialOrderExpectation;
  const ordinaryExpected = requestContext?.ordinaryOrderExpectation;
  if (!expected && !ordinaryExpected) return { ok: true };
  if (ordinaryExpected) {
    if (iface !== "gs.orderFlower.finishOrder" || Number(arg?.boxId) !== ordinaryExpected.boxId) {
      return { ok: false, reason: "ordinary-resident-order-expectation-invalid" };
    }
    const status = summarizeOrderFlowerStatus(syncValue, {
      nowMs: ordinaryExpected.nowMs ?? Date.now(),
    });
    const actual = status?.ordinary?.orders?.find((order) => Number(order.boxId) === ordinaryExpected.boxId);
    const identity = ordinaryResidentOrderAuthorityIdentity(actual);
    return identity === ordinaryExpected.identity
      ? { ok: true }
      : { ok: false, reason: "ordinary-resident-order-final-authority-unproven" };
  }
  if (!expected.kind || !expected.identity || iface !== expected.iface) {
    return { ok: false, reason: "resident-order-expectation-invalid" };
  }
  // The final authority re-summarize must use the same team-order capability
  // as the submit plan. Without it, an authorized 49/99 crossing reverts to
  // default protection and the still-unchanged order is reported as stopped
  // (resident-board-stop), so the send is rejected before it starts.
  const validationCapability = resolveResidentOrderValidationCapability(requestContext);
  const status = summarizeOrderFlowerStatus(syncValue, {
    nowMs: expected.nowMs ?? Date.now(),
    ...(validationCapability
      ? { teamOrderCapability: validationCapability }
      : {}),
  });
  const actual = status?.[expected.kind];
  const identity = specialOrderAuthorityIdentity(actual);
  if (!identity) {
    return {
      ok: false,
      reason: "resident-order-final-authority-unproven",
      kind: expected.kind,
      status: actual?.status ?? "missing",
      stateReason: actual?.stateReason ?? null,
    };
  }
  if (identity !== expected.identity) {
    return {
      ok: false,
      reason: "resident-order-final-task-identity-changed",
      kind: expected.kind,
      status: actual?.status ?? null,
    };
  }
  return { ok: true };
}

async function refreshFlowerArtActivation(
  ws,
  gsToken,
  syncValue,
  label = "flowerArtActivationRefresh",
  options = {},
) {
  const flowerNames = options.flowerNames || loadFlowerNameMap();
  const before = summarizeOrderCustomerStatus(syncValue, { nameMap: flowerNames }).config;
  const timeAuthorityNowFn = typeof options.timeAuthorityNowFn === "function"
    ? options.timeAuthorityNowFn
    : Date.now;
  const requestStartedAtMs = timeAuthorityNowFn();
  const lazyRaw = await ws.request("gs.usr.lazySync", {}, gsToken);
  const lazy = washResponse(lazyRaw);
  if (lazy.errMsg) throw new Error(`${label} failed: ${JSON.stringify(lazy.errMsg)}`);
  const hardSyncedValue = lazy.value
    ? attachHardSyncState(lazy.value, {
      serverMs: lazy.value?.$other?.ms,
      requestStartedAtMs,
      responseAtMs: timeAuthorityNowFn(),
      maxAgeMs: options.timeAuthorityMaxAgeMs,
    })
    : lazy.value;
  const next = hardSyncedValue ? mergeLandSync(syncValue, hardSyncedValue) : syncValue;
  const after = summarizeOrderCustomerStatus(next, { nameMap: flowerNames }).config;
  console.log(JSON.stringify({
    step: label,
    iface: "gs.usr.lazySync",
    sourcePath: after.artActivationSource || before.artActivationSource || "flowerArtTot.flowerArt.makeList",
    artActivationKnown: after.artActivationKnown,
    beforeActiveArtCount: before.activeArtCount,
    afterActiveArtCount: after.activeArtCount,
    dsName: lazy.dsName,
    err: null,
  }));
  return next;
}

async function refreshOnlineState(ws, gsToken, syncValue, label = "heartTick", options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const intervalMs = getOnlineHeartTickIntervalMs();
  if (!options.force && lastOnlineHeartTickAttemptAtMs && nowMs - lastOnlineHeartTickAttemptAtMs < intervalMs) {
    return syncValue;
  }

  lastOnlineHeartTickAttemptAtMs = nowMs;
  const timeAuthorityNowFn = typeof options.timeAuthorityNowFn === "function"
    ? options.timeAuthorityNowFn
    : Date.now;
  const timeAuthority = createTimeAuthority({
    state: syncValue?.$timeAuthority,
    nowFn: timeAuthorityNowFn,
    maxAgeMs: Object.hasOwn(options, "timeAuthorityMaxAgeMs")
      ? options.timeAuthorityMaxAgeMs
      : intervalMs * 2,
  });
  timeAuthority.beginHeartbeat(timeAuthorityNowFn());
  try {
    const tick = await requestSync(ws, gsToken, "gs.usr.heartTick", {}, `${label} failed`);
    const timeAuthorityState = timeAuthority.recordHeartbeat({
      serverMs: tick.value?.$other?.ms,
      responseAtMs: timeAuthorityNowFn(),
    });
    const merged = tick.value ? mergeLandSync(syncValue, tick.value) : syncValue;
    const next = attachTimeAuthorityState(merged, timeAuthorityState);
    console.log(JSON.stringify({
      step: label,
      iface: "gs.usr.heartTick",
      intervalSeconds: Math.floor(intervalMs / 1000),
      clockSource: timeAuthorityState.clockSource,
      heartbeatDecision: timeAuthorityState.lastAttempt?.decision || null,
      rttMs: timeAuthorityState.lastAttempt?.rttMs ?? null,
      deltaMs: timeAuthorityState.lastAttempt?.deltaMs ?? null,
      rejectionReason: timeAuthorityState.rejectionReason,
      dsName: tick.dsName,
      err: null,
    }));
    return next;
  } catch (err) {
    const timeAuthorityState = timeAuthority.failHeartbeat(err, timeAuthorityNowFn());
    const failedSync = attachTimeAuthorityState(syncValue, timeAuthorityState);
    if (isSessionExpiredError(err) || isWsRequestTimeoutError(err)) {
      err.timeAuthorityState = timeAuthorityState;
      throw err;
    }
    console.log(JSON.stringify({
      step: label,
      iface: "gs.usr.heartTick",
      intervalSeconds: Math.floor(intervalMs / 1000),
      clockSource: timeAuthorityState.clockSource,
      heartbeatDecision: timeAuthorityState.lastAttempt?.decision || null,
      rttMs: timeAuthorityState.lastAttempt?.rttMs ?? null,
      deltaMs: timeAuthorityState.lastAttempt?.deltaMs ?? null,
      rejectionReason: timeAuthorityState.rejectionReason,
      warn: err.message,
    }));
    return failedSync;
  }
}

function getFreeWaterThreshold() {
  return Math.max(
    0,
    toFiniteNumber(
      process.env.AUTO_FREE_WATER_THRESHOLD,
      DEFAULT_FREE_WATER_THRESHOLD,
    ),
  );
}

function getPlantWaterRefillThreshold() {
  return Math.max(
    1,
    Math.floor(toFiniteNumber(process.env.PLANT_WATER_REFILL_THRESHOLD, 16)),
  );
}

function getWaterwheelMaxReceivesPerCycle() {
  return Math.max(
    1,
    Math.floor(toFiniteNumber(process.env.WATERWHEEL_MAX_RECEIVES_PER_CYCLE, 8)),
  );
}

function getWaterwheelSyncPollConfig() {
  return {
    attempts: Math.max(0, Math.floor(toFiniteNumber(process.env.WATERWHEEL_SYNC_POLL_ATTEMPTS, 5))),
    intervalMs: Math.max(0, Math.floor(toFiniteNumber(process.env.WATERWHEEL_SYNC_POLL_INTERVAL_MS, 1000))),
  };
}

function getWaterwheelInventorySyncPollConfig() {
  return {
    attempts: Math.max(0, Math.floor(toFiniteNumber(process.env.WATERWHEEL_INVENTORY_SYNC_POLL_ATTEMPTS, 2))),
    intervalMs: Math.max(0, Math.floor(toFiniteNumber(process.env.WATERWHEEL_INVENTORY_SYNC_POLL_INTERVAL_MS, 500))),
  };
}

function summarizeCurrentWaterwheel(
  syncValue,
  plantWaterRefill = getPlantWaterRefillContext(syncValue),
  automationSetting = getWaterwheelAutomationSetting(),
  options = {},
) {
  return summarizeWaterwheelStatus(syncValue, {
    ...options,
    nowMs: getResourceActionNowMs(syncValue, options),
    waterDropThreshold: plantWaterRefill?.threshold ?? getPlantWaterRefillThreshold(),
    plantWaterRefill,
    autoReceiveEnabled: automationSetting.effectiveAutoReceiveEnabled,
    autoReceiveDisabledReason: automationSetting.reason,
    autoReceiveDisabledReasonText: automationSetting.reasonText,
    skipVideoBuckets: automationSetting.configuredSkipVideoBucketsEnabled,
  });
}

function createAutomationAccountCommandGateway(
  transport,
  gsToken,
  syncValue,
  options = {},
) {
  const syncRef = { current: syncValue };
  const experienceLevelGuard = createAutomationExperienceLevelGuard(options);
  const profileId = String(options.profileId || process.env.PROFILE_ID || "default");
  const contextRef = {
    ...options,
    profileId,
    experienceLevelGuard,
    resolveProtectedActionSettlement:
      options.resolveProtectedActionSettlement || resolveProtectedActionSettlement,
    validateActionAfterAuthorityRefresh:
      options.validateActionAfterAuthorityRefresh || validateResidentOrderAfterAuthorityRefresh,
  };
  return createAccountCommandGateway({
    transport,
    token: gsToken,
    syncRef,
    contextRef,
    createExperienceClient: (
      safeTransport,
      defaultToken,
      sharedSyncRef,
      sharedContextRef,
    ) => createExperienceGuardedWs(
      safeTransport,
      defaultToken,
      sharedSyncRef,
      sharedContextRef,
    ),
    runAtRequestBoundary: runAtAutomationRequestBoundary,
    onRateLimited: ({ iface, backoffMs, message }) => {
      console.log(JSON.stringify({
        step: "requestRateLimited",
        profileId,
        iface,
        backoffMs,
        message: String(message).slice(0, 500),
      }));
    },
  });
}

function stableSettlementSnapshot(value) {
  if (Array.isArray(value)) return value.map((item) => stableSettlementSnapshot(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableSettlementSnapshot(value[key])]),
  );
}

function isProtectedActionAuthorityIface(actionIface, authorityIface) {
  if (actionIface === "gs.usrLand.harvest" || actionIface === "gs.usrLand.harvestOneKey") {
    return authorityIface === "gs.usrLand.refresh";
  }
  if (actionIface.startsWith("gs.orderFlower.finish")) {
    return new Set(["gs.orderFlower.enter", "gs.orderFlower.refreshOrder"]).has(authorityIface);
  }
  if (actionIface === ORDER_CUSTOMER_IFACES.finishOrder) {
    return authorityIface === "gs.orderCustomer.enter"
      || authorityIface === "gs.orderCustomer.refreshOrder";
  }
  if (actionIface === ORDER_PALACE_IFACES.finishOrder) {
    return authorityIface === ORDER_PALACE_IFACES.enter
      || authorityIface === ORDER_PALACE_IFACES.refreshOrder;
  }
  return false;
}

function resolveProtectedActionSettlement({
  pending,
  responseIface,
  syncValue,
  recoveryRequest = null,
} = {}) {
  const actionIface = String(pending?.iface || "");
  const authorityIface = String(responseIface || "");
  const legacyRecovery = recoveryRequest
    && !recoveryRequest.invalid
    && recoveryRequest.recoveryMode === "legacy-unverified"
    && recoveryRequest.pendingRequestId === pending?.requestId;
  if (legacyRecovery) {
    if (!isProtectedActionAuthorityIface(actionIface, authorityIface)) {
      return { status: "not-applicable" };
    }
    return {
      status: "rejected",
      source: "operator-confirmed-legacy-recovery",
      reason: recoveryRequest.operatorReason || "operator-confirmed-legacy-recovery",
      recoveryRequestId: recoveryRequest.requestId,
    };
  }
  if (actionIface === "gs.usrLand.harvest" || actionIface === "gs.usrLand.harvestOneKey") {
    if (authorityIface !== "gs.usrLand.refresh") {
      return { status: "not-applicable" };
    }
    const landId = Number(pending?.actionArgs?.landId);
    if (!Number.isFinite(landId)) {
      return {
        status: "unknown",
        source: authorityIface,
        reason: "harvest-land-id-missing",
      };
    }
    const row = summarizeLand(syncValue).rows.find((item) => item.landId === landId);
    if (!row) {
      return {
        status: "unknown",
        source: authorityIface,
        reason: "harvest-land-not-present-in-authority",
      };
    }
    if (!row.mature) {
      return {
        status: "confirmed",
        source: authorityIface,
        reason: "harvest-land-no-longer-mature",
      };
    }
    const beforeSnapshot = pending?.actionEvidence?.land?.snapshot;
    const currentLand = syncValue?.usrLandTot?.usrLand?.landMap?.[String(landId)]
      ?? syncValue?.usrLandTot?.usrLand?.landMap?.[landId]
      ?? null;
    const recoveryMatches = Boolean(
      recoveryRequest
      && !recoveryRequest.invalid
      && recoveryRequest.pendingRequestId === pending.requestId
      && beforeSnapshot
      && currentLand
      && JSON.stringify(stableSettlementSnapshot(currentLand))
        === JSON.stringify(stableSettlementSnapshot(beforeSnapshot)),
    );
    return recoveryMatches
      ? {
          status: "rejected",
          source: authorityIface,
          reason: "harvest-land-still-mature-matches-before-action",
          recoveryRequestId: recoveryRequest.requestId,
        }
      : {
          status: "unknown",
          source: authorityIface,
          reason: beforeSnapshot
            ? "harvest-land-still-mature-authority-changed"
            : "harvest-land-still-mature-missing-before-fingerprint",
        };
  }

  if (actionIface.startsWith("gs.orderFlower.finish")) {
    if (!new Set(["gs.orderFlower.enter", "gs.orderFlower.refreshOrder"]).has(authorityIface)) {
      return { status: "not-applicable" };
    }
    const boxId = pending?.actionArgs?.boxId ?? pending?.actionArgs?.orderId;
    if (boxId == null) {
      return { status: "unknown", source: authorityIface, reason: "flower-order-id-missing" };
    }
    const order = summarizeOrderFlowerStatus(syncValue).ordinary?.orders
      ?.find((item) => String(item.boxId) === String(boxId));
    return order
      ? { status: "unknown", source: authorityIface, reason: "flower-order-still-present" }
      : { status: "confirmed", source: authorityIface, reason: "flower-order-no-longer-present" };
  }

  if (actionIface === ORDER_CUSTOMER_IFACES.finishOrder) {
    if (authorityIface !== "gs.orderCustomer.enter" && authorityIface !== "gs.orderCustomer.refreshOrder") {
      return { status: "not-applicable" };
    }
    const npcId = pending?.actionArgs?.npcId;
    if (npcId == null) {
      return { status: "unknown", source: authorityIface, reason: "customer-order-id-missing" };
    }
    const order = summarizeOrderCustomerStatus(syncValue).orders
      ?.find((item) => String(item.npcId) === String(npcId));
    return order
      ? { status: "unknown", source: authorityIface, reason: "customer-order-still-present" }
      : { status: "confirmed", source: authorityIface, reason: "customer-order-no-longer-present" };
  }

  if (actionIface === ORDER_PALACE_IFACES.finishOrder) {
    if (authorityIface !== ORDER_PALACE_IFACES.enter && authorityIface !== ORDER_PALACE_IFACES.refreshOrder) {
      return { status: "not-applicable" };
    }
    return {
      status: "unknown",
      source: authorityIface,
      reason: "palace-order-authority-does-not-identify-finished-action",
    };
  }

  return { status: "not-applicable" };
}

function createAutomationExperienceLevelGuard(options = {}) {
  const profileId = String(options.profileId || process.env.PROFILE_ID || "default");
  const experienceGuardStatePath = resolveExperienceGuardStatePath({
    statePath: options.experienceGuardStatePath || process.env.EXPERIENCE_GUARD_STATE_PATH,
    settingsPath: options.profileSettingsPath || process.env.PROFILE_SETTINGS_PATH,
    profileId,
  });
  const experienceLevelGuard = options.experienceLevelGuard
    || (experienceGuardStatePath
      ? createPersistentExperienceLevelGuard({
          profileId,
          statePath: experienceGuardStatePath,
          requireIdentity: true,
          rearmPath:
            options.experienceGuardRearmPath
            || process.env.EXPERIENCE_GUARD_REARM_PATH,
        })
      : null);
  return experienceLevelGuard;
}

function mergeAccountGatewaySync(syncValue, gatewaySyncValue) {
  const experienceReconciled = mergeExperienceSync(syncValue, gatewaySyncValue);
  const next = Object.hasOwn(gatewaySyncValue || {}, "orderFlowerTot")
    ? mergeLandSync(experienceReconciled, {
      orderFlowerTot: gatewaySyncValue.orderFlowerTot,
    })
    : experienceReconciled;
  return gatewaySyncValue?.$experienceGuardState
    ? {
        ...next,
        $experienceGuardState: gatewaySyncValue.$experienceGuardState,
      }
    : next;
}

async function refreshWaterwheelState(ws, gsToken, syncValue, label = "waterwheelEnter", options = {}) {
  const enter = await requestSync(ws, gsToken, WATERWHEEL_IFACES.enter, {}, "Waterwheel enter failed");
  const next = enter.value ? mergeLandSync(syncValue, enter.value) : syncValue;
  const plantWaterRefill = Object.hasOwn(options, "plantWaterRefill")
    ? options.plantWaterRefill
    : getPlantWaterRefillContext(next);
  const status = summarizeCurrentWaterwheel(next, plantWaterRefill, undefined, options);
  console.log(JSON.stringify({
    step: label,
    iface: WATERWHEEL_IFACES.enter,
    waterDropText: status.waterDropText,
    threshold: status.threshold,
    plantWaterRefill,
    claimedBucketCount: status.claimedBucketCount,
    remainingBucketCount: status.remainingBucketCount,
    remainingDailyBucketCount: status.remainingDailyBucketCount,
    storedBucketCount: status.storedBucketCount,
    storedBucketMax: status.storedBucketMax,
    nextBucketGenerationAt: status.nextBucketGenerationAt,
    nextBucketGenerationInSeconds: status.nextBucketGenerationInSeconds,
    maxBucketCount: status.maxBucketCount,
    nextBucketNo: status.nextBucketNo,
    nextBucketIsVideo: status.nextBucketIsVideo,
    reason: status.reason,
    reasonText: status.reasonText,
    dsName: enter.dsName,
    err: null,
  }));
  return next;
}

async function refreshWaterwheelInventoryState(ws, gsToken, syncValue, label = "waterwheelInventorySync", options = {}) {
  const beforeStatus = summarizeCurrentWaterwheel(syncValue, options.plantWaterRefill, undefined, options);
  const lazy = await requestSync(ws, gsToken, "gs.usr.lazySync", {}, "Waterwheel inventory sync failed");
  const next = mergeAuthoritativeWaterDropSync(syncValue, lazy.value, label);
  const plantWaterRefill = getPlantWaterRefillContext(next);
  const status = summarizeCurrentWaterwheel(next, plantWaterRefill, undefined, options);
  const authority = getWaterDropAuthority(next);
  console.log(JSON.stringify({
    step: label,
    iface: "gs.usr.lazySync",
    dsName: lazy.dsName,
    beforeWaterDropCount: beforeStatus.waterDropCount,
    afterWaterDropCount: status.waterDropCount,
    waterDropTrust: authority.trust,
    serverWaterDropCount: authority.serverWaterDropCount,
    serverWaterDropReason: authority.serverWaterDropReason,
    serverWaterDropSourcePath: authority.sourcePath,
    threshold: status.threshold,
    err: null,
  }));
  return next;
}

function getWaterwheelConservativeCreditCount(status) {
  return Math.max(0, Math.floor(Number(status?.bucketWaterMin) || 0));
}

function isUsableWaterwheelReceiveSyncState(syncState) {
  return syncState === "synced";
}

function isAppliedWaterwheelReceiveSyncState(syncState) {
  return syncState === "synced" || syncState === "pending-water-sync";
}

function applyWaterwheelConservativeCredit(
  syncValue,
  beforeStatus,
  afterStatus,
  cycle,
  bucketNo,
  options = {},
) {
  const creditedWaterDropCount = getWaterwheelConservativeCreditCount(afterStatus || beforeStatus);
  if (creditedWaterDropCount <= 0) return null;

  const actionTimeOptions = {
    ...options,
    actionTime: resolveResourceActionTime(syncValue, options),
  };
  const creditedAtMs = actionTimeOptions.actionTime.localNowMs;
  const targetWaterDropCount = Math.max(0, Number(afterStatus?.waterDropCount) || 0) + creditedWaterDropCount;
  const next = setWaterDropCount(syncValue, targetWaterDropCount, creditedAtMs);
  const plantWaterRefill = getPlantWaterRefillContext(next);
  const status = summarizeCurrentWaterwheel(next, plantWaterRefill, undefined, actionTimeOptions);

  console.log(JSON.stringify({
    step: "waterwheelConservativeCredit",
    cycle,
    bucketNo,
    creditSource: "estimated-min",
    creditedWaterDropCount,
    beforeWaterDropCount: beforeStatus?.waterDropCount ?? null,
    staleAfterWaterDropCount: afterStatus?.waterDropCount ?? null,
    creditedAfterWaterDropCount: status.waterDropCount,
    bucketWaterRangeText: status.bucketWaterRangeText,
    bucketWaterMin: status.bucketWaterMin,
    beforeRemainingBucketCount: beforeStatus?.remainingBucketCount ?? null,
    afterRemainingBucketCount: afterStatus?.remainingBucketCount ?? null,
  }));

  return {
    syncValue: next,
    status,
    creditedWaterDropCount,
    creditedAtMs,
    localItemDeltaPatch: {
      beforeSync: syncValue,
      deltas: [{ itemId: ITEM_IDS.WATER_DROP, delta: creditedWaterDropCount }],
    },
  };
}

async function refreshWaterwheelStatusSnapshot(
  ws,
  gsToken,
  syncValue,
  label = "waterwheelStatusRefresh",
  options = {},
) {
  if (process.env.AUTO_HANDLE_WATERWHEEL === "0") return syncValue;

  try {
    return await refreshWaterwheelState(ws, gsToken, syncValue, label, options);
  } catch (err) {
    rethrowGlobalAutomationError(err);
    console.log(JSON.stringify({
      step: `${label}Error`,
      iface: WATERWHEEL_IFACES.enter,
      warn: err.message,
    }));
    return syncValue;
  }
}

async function waitForWaterwheelReceiveSync(
  ws,
  gsToken,
  syncValue,
  beforeStatus,
  cycle,
  bucketNo,
  options = {},
) {
  const { attempts, intervalMs } = getWaterwheelSyncPollConfig();
  let next = syncValue;
  let plantWaterRefill = getPlantWaterRefillContext(next);
  let status = summarizeCurrentWaterwheel(next, plantWaterRefill, undefined, options);
  let syncState = getWaterwheelReceiveSyncState(beforeStatus, status);

  for (let attempt = 1; attempt <= attempts && syncState === "pending-water-sync"; attempt++) {
    if (intervalMs) await wait(intervalMs);
    try {
      next = await refreshWaterwheelState(
        ws,
        gsToken,
        next,
        "waterwheelReceiveSyncPoll",
        { plantWaterRefill, ...options },
      );
      plantWaterRefill = getPlantWaterRefillContext(next);
      status = summarizeCurrentWaterwheel(next, plantWaterRefill, undefined, options);
      syncState = getWaterwheelReceiveSyncState(beforeStatus, status);
      console.log(JSON.stringify({
        step: "waterwheelReceiveSyncPollResult",
        cycle,
        bucketNo,
        attempt,
        syncState,
        beforeWaterDropCount: beforeStatus.waterDropCount,
        afterWaterDropCount: status.waterDropCount,
        afterRemainingBucketCount: status.remainingBucketCount,
        threshold: status.threshold,
      }));
    } catch (err) {
      if (isSessionExpiredError(err) || isWsRequestTimeoutError(err)) throw err;
      console.log(JSON.stringify({
        step: "waterwheelReceiveSyncPollError",
        cycle,
        bucketNo,
        attempt,
        message: err.message,
      }));
    }
  }

  const inventoryPoll = getWaterwheelInventorySyncPollConfig();
  for (let attempt = 1; attempt <= inventoryPoll.attempts && syncState === "pending-water-sync"; attempt++) {
    if (inventoryPoll.intervalMs) await wait(inventoryPoll.intervalMs);
    try {
      next = await refreshWaterwheelInventoryState(
        ws,
        gsToken,
        next,
        "waterwheelReceiveInventorySync",
        { plantWaterRefill, ...options },
      );
      plantWaterRefill = getPlantWaterRefillContext(next);
      status = summarizeCurrentWaterwheel(next, plantWaterRefill, undefined, options);
      syncState = getWaterwheelReceiveSyncState(beforeStatus, status);
      console.log(JSON.stringify({
        step: "waterwheelReceiveInventorySyncResult",
        cycle,
        bucketNo,
        attempt,
        syncState,
        beforeWaterDropCount: beforeStatus.waterDropCount,
        afterWaterDropCount: status.waterDropCount,
        afterRemainingBucketCount: status.remainingBucketCount,
        threshold: status.threshold,
      }));
    } catch (err) {
      if (isSessionExpiredError(err) || isWsRequestTimeoutError(err)) throw err;
      console.log(JSON.stringify({
        step: "waterwheelReceiveInventorySyncError",
        cycle,
        bucketNo,
        attempt,
        message: err.message,
      }));
    }
  }

  return { syncValue: next, status, syncState };
}

function isPlantWaterEnoughForRefill(plantWaterRefill) {
  const authoritativeWaterDropCount = getAuthoritativeWaterDropCount(plantWaterRefill);
  return Boolean(
    plantWaterRefill?.needsPlanting
    && authoritativeWaterDropCount != null
    && authoritativeWaterDropCount >= Number(plantWaterRefill.threshold),
  );
}

function buildWaterDecision(plantWaterRefill, extra = {}) {
  const authoritativeWaterDropCount = getAuthoritativeWaterDropCount(plantWaterRefill);
  const refillNeeded = Boolean(
    plantWaterRefill?.needsPlanting
    && authoritativeWaterDropCount != null
    && authoritativeWaterDropCount < Number(plantWaterRefill.threshold),
  );
  return {
    ...(plantWaterRefill || {}),
    refillNeeded,
    canReceiveWater: refillNeeded && !extra.blockedReason,
    blockedReason: extra.blockedReason || null,
    blockedReasonText: extra.blockedReasonText || null,
    trusted: plantWaterRefill?.waterDropTrust === "authoritative" && !extra.blockedReason,
  };
}

function logWaterRefillSkip(source, cycle, reason, reasonText, plantWaterRefill, status = null) {
  console.log(JSON.stringify({
    step: "waterRefillSkip",
    source,
    cycle,
    reason,
    reasonText,
    waterDropTrust: plantWaterRefill?.waterDropTrust || "partial",
    serverWaterDropCount: plantWaterRefill?.serverWaterDropCount ?? null,
    serverWaterDropReason: plantWaterRefill?.serverWaterDropReason || null,
    localWaterDropCount: plantWaterRefill?.waterDropCount ?? status?.waterDropCount ?? null,
    waterDropText: status?.waterDropText || plantWaterRefill?.waterDropText || null,
    threshold: plantWaterRefill?.threshold ?? status?.threshold ?? null,
    requiredWaterCount: plantWaterRefill?.requiredWaterCount || plantWaterRefill?.threshold || status?.threshold || null,
    refillTarget: plantWaterRefill?.refillTarget || null,
    groupKey: plantWaterRefill?.groupKey ?? null,
    groupIndex: plantWaterRefill?.groupIndex ?? null,
    groupStartId: plantWaterRefill?.groupStartId ?? null,
    groupEndId: plantWaterRefill?.groupEndId ?? null,
    emptyLandIds: plantWaterRefill?.emptyLandIds || [],
    seededLandIds: plantWaterRefill?.seededLandIds || [],
  }));
}

function logWaterEnoughNoReceive(source, cycle, status, plantWaterRefill) {
  if (!isPlantWaterEnoughForRefill(plantWaterRefill)) return;
  console.log(JSON.stringify({
    step: "waterEnoughNoReceive",
    source,
    cycle,
    reason: plantWaterRefill.reason,
    reasonText: plantWaterRefill.reasonText,
    waterDropCount: plantWaterRefill.waterDropCount,
    waterDropText: status?.waterDropText || plantWaterRefill.waterDropText,
    threshold: plantWaterRefill.threshold,
    requiredWaterCount: plantWaterRefill.requiredWaterCount || plantWaterRefill.threshold,
    emptyLandCount: plantWaterRefill.emptyLandCount,
    groupIndex: plantWaterRefill.groupIndex ?? null,
    nextBucketNo: status?.nextBucketNo ?? null,
    nextBucketIsVideo: status?.nextBucketIsVideo ?? null,
  }));
}

function getFreeWaterReceiveSyncState(beforeStatus, afterStatus, planned) {
  const beforeWater = Number(beforeStatus?.waterDropCount) || 0;
  const afterWater = Number(afterStatus?.waterDropCount) || 0;
  if (afterWater > beforeWater) return "synced";

  const beforeRecv = new Set((beforeStatus?.recvIdx || []).map((item) => Number(item)));
  const afterRecv = new Set((afterStatus?.recvIdx || []).map((item) => Number(item)));
  const plannedIdx = Number(planned?.idx);
  if (Number.isFinite(plannedIdx) && !beforeRecv.has(plannedIdx) && afterRecv.has(plannedIdx)) {
    return "pending-water-sync";
  }

  return "unchanged";
}

async function autoReceiveWaterwheelBuckets(ws, gsToken, syncValue, cycle, options = {}) {
  const actionTimeOptions = {
    ...options,
    actionTime: resolveResourceActionTime(syncValue, options),
  };
  let automationSetting = getWaterwheelAutomationSetting();
  if (!automationSetting.effectiveAutoReceiveEnabled) {
    console.log(JSON.stringify({
      step: "waterwheelReceiveSkip",
      cycle,
      configuredAutoReceiveEnabled: automationSetting.configuredAutoReceiveEnabled,
      effectiveAutoReceiveEnabled: automationSetting.effectiveAutoReceiveEnabled,
      configuredSkipVideoBucketsEnabled: automationSetting.configuredSkipVideoBucketsEnabled,
      effectiveSkipVideoBucketsEnabled: automationSetting.effectiveSkipVideoBucketsEnabled,
      source: automationSetting.source,
      reason: automationSetting.reason,
      reasonText: automationSetting.reasonText,
    }));
    return {
      syncValue,
      actionCount: 0,
      receivedCount: 0,
      normalReceivedCount: 0,
      videoBaseReceivedCount: 0,
      actions: [],
      status: summarizeCurrentWaterwheel(syncValue, undefined, automationSetting, actionTimeOptions),
      automationSetting,
      waterDecision: buildWaterDecision(getPlantWaterRefillContext(syncValue)),
    };
  }

  let next = syncValue;
  let plantWaterRefill = getPlantWaterRefillContext(next);
  if (!plantWaterRefill.needsPlanting) {
    const status = summarizeCurrentWaterwheel(next, plantWaterRefill, automationSetting, actionTimeOptions);
    logWaterEnoughNoReceive("waterwheel", cycle, status, plantWaterRefill);
    console.log(JSON.stringify({
      step: "waterwheelReceiveSkip",
      cycle,
      reason: status.reason,
      reasonText: status.reasonText,
      waterDropText: status.waterDropText,
      threshold: status.threshold,
      plantWaterRefill,
      remainingBucketCount: status.remainingBucketCount,
      remainingDailyBucketCount: status.remainingDailyBucketCount,
      storedBucketCount: status.storedBucketCount,
      storedBucketMax: status.storedBucketMax,
      nextBucketGenerationAt: status.nextBucketGenerationAt,
      nextBucketGenerationInSeconds: status.nextBucketGenerationInSeconds,
      maxBucketCount: status.maxBucketCount,
      nextBucketNo: status.nextBucketNo,
      nextBucketIsVideo: status.nextBucketIsVideo,
    }));
    return {
      syncValue: next,
      actionCount: 0,
      receivedCount: 0,
      normalReceivedCount: 0,
      videoBaseReceivedCount: 0,
      actions: [],
      status,
      waterDecision: buildWaterDecision(plantWaterRefill),
    };
  }

  next = await refreshAuthoritativeWaterDrop(ws, gsToken, next, "waterwheelAuthoritativeWaterDropBeforeReceive");
  plantWaterRefill = getPlantWaterRefillContext(next);
  if (plantWaterRefill.waterDropTrust !== "authoritative") {
    const refreshed = await refreshLandForPotentialWaterAuthority(
      ws,
      gsToken,
      next,
      plantWaterRefill,
      "waterwheelAuthoritativeLandRefreshBeforeRefill",
    );
    next = refreshed.syncValue;
    plantWaterRefill = refreshed.plantWaterRefill;
  }
  if (plantWaterRefill.waterDropTrust !== "authoritative") {
    const status = summarizeCurrentWaterwheel(next, plantWaterRefill, automationSetting, actionTimeOptions);
    const reason = "waiting-authoritative-water-drop-before-refill";
    const reasonText = "waiting authoritative water drop before waterwheel refill";
    logWaterRefillSkip("waterwheel", cycle, reason, reasonText, plantWaterRefill, status);
    return {
      syncValue: next,
      actionCount: 0,
      receivedCount: 0,
      normalReceivedCount: 0,
      videoBaseReceivedCount: 0,
      actions: [],
      status,
      blockedReason: reason,
      blockedReasonText: reasonText,
      waterDecision: buildWaterDecision(plantWaterRefill, { blockedReason: reason, blockedReasonText: reasonText }),
    };
  }

  if (isPlantWaterEnoughForRefill(plantWaterRefill)) {
    const status = summarizeCurrentWaterwheel(next, plantWaterRefill, automationSetting, actionTimeOptions);
    logWaterEnoughNoReceive("waterwheel", cycle, status, plantWaterRefill);
    console.log(JSON.stringify({
      step: "waterwheelReceiveSkip",
      cycle,
      reason: status.reason,
      reasonText: status.reasonText,
      waterDropText: status.waterDropText,
      threshold: status.threshold,
      plantWaterRefill,
      remainingBucketCount: status.remainingBucketCount,
      remainingDailyBucketCount: status.remainingDailyBucketCount,
      storedBucketCount: status.storedBucketCount,
      storedBucketMax: status.storedBucketMax,
      nextBucketGenerationAt: status.nextBucketGenerationAt,
      nextBucketGenerationInSeconds: status.nextBucketGenerationInSeconds,
      maxBucketCount: status.maxBucketCount,
      nextBucketNo: status.nextBucketNo,
      nextBucketIsVideo: status.nextBucketIsVideo,
    }));
    return {
      syncValue: next,
      actionCount: 0,
      receivedCount: 0,
      normalReceivedCount: 0,
      videoBaseReceivedCount: 0,
      actions: [],
      status,
      waterDecision: buildWaterDecision(plantWaterRefill),
    };
  }

  const maxReceives = getWaterwheelMaxReceivesPerCycle();
  next = await refreshWaterwheelState(
    ws,
    gsToken,
    next,
    "waterwheelEnterBeforeReceive",
    { plantWaterRefill, ...actionTimeOptions },
  );
  plantWaterRefill = getPlantWaterRefillContext(next);
  let status = summarizeCurrentWaterwheel(next, plantWaterRefill, automationSetting, actionTimeOptions);
  const actions = [];
  const localItemDeltaPatches = [];
  if (isPlantWaterEnoughForRefill(plantWaterRefill)) {
    logWaterEnoughNoReceive("waterwheel", cycle, status, plantWaterRefill);
    console.log(JSON.stringify({
      step: "waterInvariantStop",
      source: "waterwheel",
      cycle,
      reason: "plant-water-enough",
      reasonText: plantWaterRefill.reasonText,
      waterDropCount: plantWaterRefill.waterDropCount,
      threshold: plantWaterRefill.threshold,
    }));
    return {
      syncValue: next,
      actionCount: 0,
      receivedCount: 0,
      normalReceivedCount: 0,
      videoBaseReceivedCount: 0,
      actions,
      status,
      waterDecision: buildWaterDecision(plantWaterRefill),
    };
  }

  while (actions.filter((action) => !action.failed).length < maxReceives) {
    automationSetting = getWaterwheelAutomationSetting();
    plantWaterRefill = getPlantWaterRefillContext(next);
    status = summarizeCurrentWaterwheel(next, plantWaterRefill, automationSetting, actionTimeOptions);
    if (isPlantWaterEnoughForRefill(plantWaterRefill)) {
      logWaterEnoughNoReceive("waterwheel", cycle, status, plantWaterRefill);
      console.log(JSON.stringify({
        step: "waterInvariantStop",
        source: "waterwheel",
        cycle,
        reason: "plant-water-enough",
        reasonText: plantWaterRefill.reasonText,
        waterDropCount: plantWaterRefill.waterDropCount,
        threshold: plantWaterRefill.threshold,
      }));
      break;
    }
    const planned = getAutoWaterwheelActions(status)[0];
    if (!planned) break;
    const preReceiveBucketState = readAndAdvanceWaterwheelBucketState(next, {
      ...actionTimeOptions,
      config: {
        bucketCreateCd: status.bucketCreateCd,
        bucketExistMax: status.bucketExistMax,
        bucketGetMax: status.maxBucketCount,
      },
      claimedBucketCount: status.claimedBucketCount,
      nowMs: actionTimeOptions.actionTime.nowMs,
    });
    const preReceiveStatusOptions = {
      ...actionTimeOptions,
      bucketState: preReceiveBucketState.state,
    };
    const action = {
      type: planned.type,
      nextBucketNo: planned.nextBucketNo,
      beforeWaterDropCount: status.waterDropCount,
      beforeRemainingBucketCount: status.remainingBucketCount,
      nextBucketWasVideo: status.nextBucketIsVideo,
    };
    let failureStage = planned.type === "receiveWaterwheelVideoBucketBase"
      ? "skip-video-requirement"
      : "receive-bucket";

    try {
      let beforeStatus = status;
      if (planned.type === "receiveWaterwheelVideoBucketBase") {
        const skip = await requestSync(
          ws,
          gsToken,
          WATERWHEEL_IFACES.skip,
          {},
          "Waterwheel video bucket skip failed",
        );
        next = skip.value ? mergeLandSync(next, skip.value) : next;
        plantWaterRefill = getPlantWaterRefillContext(next);
        automationSetting = getWaterwheelAutomationSetting();
        beforeStatus = summarizeCurrentWaterwheel(
          next,
          plantWaterRefill,
          automationSetting,
          preReceiveStatusOptions,
        );
        action.skipApplied = true;
        action.skipDsName = skip.dsName;
        console.log(JSON.stringify({
          step: "waterwheelVideoBucketSkip",
          cycle,
          bucketNo: planned.nextBucketNo,
          iface: WATERWHEEL_IFACES.skip,
          dsName: skip.dsName,
          err: null,
        }));
        failureStage = "receive-base-reward";
        if (!automationSetting.effectiveAutoReceiveEnabled) {
          action.stoppedReason = automationSetting.reason;
          action.stoppedReasonText = automationSetting.reasonText;
          action.stoppedStage = "receive-base-reward";
          actions.push(action);
          status = beforeStatus;
          console.log(JSON.stringify({
            step: "waterwheelReceiveStop",
            cycle,
            bucketNo: planned.nextBucketNo,
            reason: action.stoppedReason,
            reasonText: action.stoppedReasonText,
            stoppedStage: action.stoppedStage,
            skipApplied: true,
          }));
          break;
        }
      }
      const recv = await requestSync(ws, gsToken, WATERWHEEL_IFACES.recv, {}, "Waterwheel receive failed");
      next = recv.value ? mergeLandSync(next, recv.value) : next;
      next = invalidateWaterDropAuthorityAfterWaterSourceDelta(
        next,
        recv.value,
        "waterwheelReceive",
      );
      plantWaterRefill = getPlantWaterRefillContext(next);
      let afterStatus = summarizeCurrentWaterwheel(
        next,
        plantWaterRefill,
        automationSetting,
        preReceiveStatusOptions,
      );
      let syncState = getWaterwheelReceiveSyncState(beforeStatus, afterStatus);
      if (syncState === "pending-water-sync") {
        const waited = await waitForWaterwheelReceiveSync(
          ws,
          gsToken,
          next,
          beforeStatus,
          cycle,
          planned.nextBucketNo,
          preReceiveStatusOptions,
        );
        next = waited.syncValue;
        afterStatus = waited.status;
        syncState = waited.syncState;
        plantWaterRefill = getPlantWaterRefillContext(next);
      }
      next = await refreshAuthoritativeWaterDrop(ws, gsToken, next, "waterwheelAuthoritativeWaterDropAfterReceive", {
        allowMergedAuthoritativeSnapshotFromPrevious: true,
      });
      plantWaterRefill = getPlantWaterRefillContext(next);
      let postReceiveAuthority = getWaterDropAuthority(next);
      if (!isUsablePostRefillWaterDropAuthority(postReceiveAuthority)) {
        try {
          next = await refreshLand(
            ws,
            gsToken,
            next,
            "waterwheelAuthoritativeLandRefreshAfterReceive",
          );
          plantWaterRefill = getPlantWaterRefillContext(next);
          postReceiveAuthority = getWaterDropAuthority(next);
        } catch (err) {
          if (isSessionExpiredError(err) || isWsRequestTimeoutError(err)) throw err;
          console.log(JSON.stringify({
            step: "waterwheelAuthoritativeLandRefreshAfterReceiveError",
            cycle,
            bucketNo: planned.nextBucketNo,
            message: err.message,
          }));
        }
      }
      if (!isUsablePostRefillWaterDropAuthority(postReceiveAuthority)) {
        next = setWaterDropAuthority(next, {
          trust: "unknown",
          serverWaterDropReason: "missing-post-refill-server-water-drop-snapshot",
          label: "waterwheelAuthoritativeWaterDropAfterReceive",
        });
        plantWaterRefill = getPlantWaterRefillContext(next);
        postReceiveAuthority = getWaterDropAuthority(next);
      }
      afterStatus = summarizeCurrentWaterwheel(
        next,
        plantWaterRefill,
        automationSetting,
        preReceiveStatusOptions,
      );
      syncState = getWaterwheelReceiveSyncState(beforeStatus, afterStatus);
      if (!isUsablePostRefillWaterDropAuthority(postReceiveAuthority)) {
        const reason = "waiting-authoritative-water-drop-after-refill";
        const reasonText = "waiting authoritative water drop after waterwheel refill";
        action.stoppedReason = reason;
        action.stoppedReasonText = reasonText;
        logWaterRefillSkip("waterwheel", cycle, reason, reasonText, plantWaterRefill, afterStatus);
      }

      if (isWaterwheelDeltaOutOfExpectedRange(beforeStatus, afterStatus)) {
        console.log(JSON.stringify({
          step: "waterwheelWaterDeltaOutOfExpectedRange",
          cycle,
          bucketNo: planned.nextBucketNo,
          beforeWaterDropCount: beforeStatus.waterDropCount,
          afterWaterDropCount: afterStatus.waterDropCount,
          receivedWaterDropCount: Math.max(0, afterStatus.waterDropCount - beforeStatus.waterDropCount),
          bucketWaterMin: beforeStatus.bucketWaterMin ?? afterStatus.bucketWaterMin ?? null,
          bucketWaterMax: beforeStatus.bucketWaterMax ?? afterStatus.bucketWaterMax ?? null,
          snapshotTrustedForPlanting: isUsablePostRefillWaterDropAuthority(postReceiveAuthority),
          waterDropTrust: plantWaterRefill.waterDropTrust,
          serverWaterDropCount: plantWaterRefill.serverWaterDropCount,
          serverWaterDropReason: plantWaterRefill.serverWaterDropReason,
          serverWaterDropSourcePath: plantWaterRefill.serverWaterDropSourcePath,
        }));
      }
      const serverAfterStatus = afterStatus;
      if (isAppliedWaterwheelReceiveSyncState(syncState)) {
        const bucketConsumption = consumeWaterwheelBucket(next, {
          ...actionTimeOptions,
          config: {
            bucketCreateCd: serverAfterStatus.bucketCreateCd,
            bucketExistMax: serverAfterStatus.bucketExistMax,
            bucketGetMax: serverAfterStatus.maxBucketCount,
          },
          // The server-after claim is used by the next projection. Consumption
          // must only remove the one local bucket that existed before recv.
          claimedBucketCount: beforeStatus.claimedBucketCount,
          nowMs: actionTimeOptions.actionTime.nowMs,
        });
        action.storedBucketConsumed = bucketConsumption.consumed;
        action.storedBucketPersisted = bucketConsumption.persisted;
        action.storedBucketStatePersistenceStatus = bucketConsumption.persistenceStatus;
        action.storedBucketStatePath = bucketConsumption.statePath || null;
        action.storedBucketStateInvalidReason = bucketConsumption.invalidReason || null;
        if (!bucketConsumption.consumed) {
          action.storedBucketConsumeFailed = true;
          if (!action.stoppedReason) {
            action.stoppedReason = "waterwheel-local-bucket-missing-after-receive";
            action.stoppedReasonText = "水车领取已得到服务端变化，但本地已生成水桶库存无法消费，停止本轮领取";
          }
        } else {
          afterStatus = summarizeCurrentWaterwheel(
            next,
            plantWaterRefill,
            automationSetting,
            bucketConsumption.persisted
              ? actionTimeOptions
              : { ...actionTimeOptions, bucketState: bucketConsumption.state },
          );
          if (!bucketConsumption.persisted) {
            action.storedBucketStatePersistenceError = true;
            if (!action.stoppedReason) {
              action.stoppedReason = "waterwheel-local-bucket-state-write-failed";
              action.stoppedReasonText = "水车领取已成功，但本地水桶库存未能持久化，停止本轮领取";
            }
          }
        }
      }
      action.afterWaterDropCount = afterStatus.waterDropCount;
      action.afterRemainingBucketCount = afterStatus.remainingBucketCount;
      action.afterRemainingDailyBucketCount = afterStatus.remainingDailyBucketCount;
      action.afterStoredBucketCount = afterStatus.storedBucketCount;
      action.receivedWaterDropCount = Math.max(0, serverAfterStatus.waterDropCount - beforeStatus.waterDropCount);
      action.afterNextBucketNo = afterStatus.nextBucketNo;
      action.afterNextBucketIsVideo = afterStatus.nextBucketIsVideo;
      action.syncState = syncState;
      if (!action.stoppedReason && !isUsableWaterwheelReceiveSyncState(syncState)) {
        action.stoppedReason = syncState === "pending-water-sync"
          ? "water-drop-sync-pending"
          : "waterwheel-recv-not-applied";
        action.stoppedReasonText = syncState === "pending-water-sync"
          ? "水车领取后桶数已变化但水滴暂未同步，停止本轮水车领取，等待下一轮刷新"
          : "水车领取后桶数和水滴都没有有效变化，停止本轮水车领取";
      }
      if (action.stoppedReason === "water-drop-sync-pending") {
        console.log(JSON.stringify({
          step: "waterDropSyncPending",
          source: "waterwheel",
          cycle,
          bucketNo: planned.nextBucketNo,
          beforeWaterDropCount: beforeStatus.waterDropCount,
          afterWaterDropCount: afterStatus.waterDropCount,
          beforeRemainingBucketCount: beforeStatus.remainingBucketCount,
          afterRemainingBucketCount: afterStatus.remainingBucketCount,
        }));
      }
      actions.push(action);
      console.log(JSON.stringify({
        step: "waterwheelReceive",
        cycle,
        bucketNo: planned.nextBucketNo,
        dsName: recv.dsName,
        syncState,
        beforeWaterDropCount: beforeStatus.waterDropCount,
        afterWaterDropCount: afterStatus.waterDropCount,
        receivedWaterDropCount: action.receivedWaterDropCount,
        beforeRemainingBucketCount: beforeStatus.remainingBucketCount,
        afterRemainingBucketCount: afterStatus.remainingBucketCount,
        beforeStoredBucketCount: beforeStatus.storedBucketCount,
        afterStoredBucketCount: afterStatus.storedBucketCount,
        afterNextBucketNo: afterStatus.nextBucketNo,
        afterNextBucketIsVideo: afterStatus.nextBucketIsVideo,
        threshold: beforeStatus.threshold,
        creditSource: action.creditSource || null,
        creditedWaterDropCount: action.creditedWaterDropCount || 0,
        storedBucketConsumed: action.storedBucketConsumed ?? null,
        storedBucketPersisted: action.storedBucketPersisted ?? null,
        storedBucketStatePersistenceStatus: action.storedBucketStatePersistenceStatus || null,
        storedBucketStatePath: action.storedBucketStatePath,
        storedBucketStateInvalidReason: action.storedBucketStateInvalidReason,
      }));
      status = afterStatus;
      if (action.stoppedReason) {
        console.log(JSON.stringify({
          step: "waterwheelReceiveStop",
          cycle,
          bucketNo: planned.nextBucketNo,
          reason: action.stoppedReason,
          reasonText: action.stoppedReasonText,
          beforeWaterDropCount: action.beforeWaterDropCount,
          afterWaterDropCount: action.afterWaterDropCount,
          threshold: status.threshold,
        }));
        break;
      }
      if (action.stopReceivingReason) {
        console.log(JSON.stringify({
          step: "waterwheelReceiveLimit",
          cycle,
          bucketNo: planned.nextBucketNo,
          reason: action.stopReceivingReason,
          reasonText: action.stopReceivingReasonText,
          afterWaterDropCount: action.afterWaterDropCount,
          threshold: status.threshold,
        }));
        break;
      }
    } catch (err) {
      if (isSessionExpiredError(err) || isWsRequestTimeoutError(err)) throw err;
      action.failed = true;
      action.failureStage = failureStage;
      action.message = err.message;
      actions.push(action);
      console.log(JSON.stringify({
        step: "waterwheelReceiveError",
        cycle,
        bucketNo: planned.nextBucketNo,
        failureStage,
        message: err.message,
      }));
      break;
    }
  }

  if (!actions.length || !getAutoWaterwheelActions(status).length) {
    console.log(JSON.stringify({
      step: "waterwheelReceiveSkip",
      cycle,
      reason: status.reason,
      reasonText: status.reasonText,
      waterDropText: status.waterDropText,
      threshold: status.threshold,
      remainingBucketCount: status.remainingBucketCount,
      remainingDailyBucketCount: status.remainingDailyBucketCount,
      storedBucketCount: status.storedBucketCount,
      storedBucketMax: status.storedBucketMax,
      nextBucketGenerationAt: status.nextBucketGenerationAt,
      nextBucketGenerationInSeconds: status.nextBucketGenerationInSeconds,
      maxBucketCount: status.maxBucketCount,
      nextBucketNo: status.nextBucketNo,
      nextBucketIsVideo: status.nextBucketIsVideo,
    }));
  }

  const blockedAction = actions.find((action) => action.stoppedReason);
  const receivedActions = actions.filter((action) => (
    !action.failed
    && !action.stoppedReason
    && isUsableWaterwheelReceiveSyncState(action.syncState)
  ));
  return {
    syncValue: next,
    actionCount: actions.length,
    receivedCount: receivedActions.length,
    normalReceivedCount: receivedActions.filter(
      (action) => action.type === "recvWaterwheelBucket",
    ).length,
    videoBaseReceivedCount: receivedActions.filter(
      (action) => action.type === "receiveWaterwheelVideoBucketBase",
    ).length,
    actions,
    localItemDeltaPatches,
    status,
    blockedReason: blockedAction?.stoppedReason || null,
    blockedReasonText: blockedAction?.stoppedReasonText || null,
    waterDecision: buildWaterDecision(getPlantWaterRefillContext(next), {
      blockedReason: blockedAction?.stoppedReason || null,
      blockedReasonText: blockedAction?.stoppedReasonText || null,
    }),
  };
}

async function autoReceiveFreeWaterDrops(ws, gsToken, syncValue, cycle) {
  if (process.env.AUTO_HANDLE_FREE_WATER === "0") {
    console.log(JSON.stringify({ step: "freeWaterReceiveSkip", cycle, reason: "disabled" }));
    return { syncValue, actionCount: 0, receivedCount: 0, actions: [], waterDecision: buildWaterDecision(getPlantWaterRefillContext(syncValue)) };
  }

  let next = syncValue;
  let plantWaterRefill = getPlantWaterRefillContext(next);
  if (!plantWaterRefill.needsPlanting) {
    const status = summarizeFreeWaterStatus(next, {
      waterDropThreshold: plantWaterRefill.threshold,
      plantWaterRefill,
    });
    logWaterEnoughNoReceive("freeWater", cycle, status, plantWaterRefill);
    console.log(JSON.stringify({
      step: "freeWaterReceiveSkip",
      cycle,
      reason: plantWaterRefill.reason,
      reasonText: status.reasonText,
      waterDropText: status.waterDropText,
      threshold: status.threshold,
      plantWaterRefill,
      receivedCountToday: status.receivedCountToday,
      maxDailyCount: status.maxDailyCount,
    }));
    return { syncValue: next, actionCount: 0, receivedCount: 0, actions: [], status, waterDecision: buildWaterDecision(plantWaterRefill) };
  }

  next = await refreshAuthoritativeWaterDrop(ws, gsToken, next, "freeWaterAuthoritativeWaterDropBeforeReceive");
  plantWaterRefill = getPlantWaterRefillContext(next);
  if (plantWaterRefill.waterDropTrust !== "authoritative") {
    const refreshed = await refreshLandForPotentialWaterAuthority(
      ws,
      gsToken,
      next,
      plantWaterRefill,
      "freeWaterAuthoritativeLandRefreshBeforeRefill",
    );
    next = refreshed.syncValue;
    plantWaterRefill = refreshed.plantWaterRefill;
  }
  if (plantWaterRefill.waterDropTrust !== "authoritative") {
    const status = summarizeFreeWaterStatus(next, {
      waterDropThreshold: plantWaterRefill.threshold,
      plantWaterRefill,
    });
    const reason = "waiting-authoritative-water-drop-before-refill";
    const reasonText = "waiting authoritative water drop before free water refill";
    logWaterRefillSkip("freeWater", cycle, reason, reasonText, plantWaterRefill, status);
    return {
      syncValue: next,
      actionCount: 0,
      receivedCount: 0,
      actions: [],
      status,
      blockedReason: reason,
      blockedReasonText: reasonText,
      waterDecision: buildWaterDecision(plantWaterRefill, { blockedReason: reason, blockedReasonText: reasonText }),
    };
  }

  if (isPlantWaterEnoughForRefill(plantWaterRefill)) {
    const status = summarizeFreeWaterStatus(next, {
      waterDropThreshold: plantWaterRefill.threshold,
      plantWaterRefill,
    });
    logWaterEnoughNoReceive("freeWater", cycle, status, plantWaterRefill);
    console.log(JSON.stringify({
      step: "freeWaterReceiveSkip",
      cycle,
      reason: plantWaterRefill.reason,
      reasonText: status.reasonText,
      waterDropText: status.waterDropText,
      threshold: status.threshold,
      plantWaterRefill,
      receivedCountToday: status.receivedCountToday,
      maxDailyCount: status.maxDailyCount,
    }));
    return { syncValue: next, actionCount: 0, receivedCount: 0, actions: [], status, waterDecision: buildWaterDecision(plantWaterRefill) };
  }

  const threshold = plantWaterRefill.threshold;
  let status = summarizeFreeWaterStatus(next, {
    waterDropThreshold: threshold,
    plantWaterRefill,
  });
  const actions = [];
  const attemptedIdx = new Set();
  while (status.pendingActions.length) {
    plantWaterRefill = getPlantWaterRefillContext(next);
    if (isPlantWaterEnoughForRefill(plantWaterRefill)) {
      status = summarizeFreeWaterStatus(next, {
        waterDropThreshold: plantWaterRefill.threshold,
        plantWaterRefill,
      });
      logWaterEnoughNoReceive("freeWater", cycle, status, plantWaterRefill);
      console.log(JSON.stringify({
        step: "waterInvariantStop",
        source: "freeWater",
        cycle,
        reason: "plant-water-enough",
        reasonText: plantWaterRefill.reasonText,
        waterDropCount: plantWaterRefill.waterDropCount,
        threshold: plantWaterRefill.threshold,
      }));
      break;
    }
    const planned = status.pendingActions.find((item) => !attemptedIdx.has(item.idx));
    if (!planned) break;
    attemptedIdx.add(planned.idx);
    const action = {
      type: planned.type,
      idx: planned.idx,
      receiveNo: planned.receiveNo,
      beforeWaterDropCount: status.waterDropCount,
    };

    try {
      const recv = await requestSync(ws, gsToken, FREE_WATER_IFACES.recv, planned.args, "Free water receive failed");
      next = recv.value ? mergeLandSync(next, recv.value) : next;
      next = invalidateWaterDropAuthorityAfterWaterSourceDelta(
        next,
        recv.value,
        "freeWaterReceive",
      );
      plantWaterRefill = getPlantWaterRefillContext(next);
      let afterStatus = summarizeFreeWaterStatus(next, {
        waterDropThreshold: plantWaterRefill.threshold,
        plantWaterRefill,
      });
      let syncState = getFreeWaterReceiveSyncState(status, afterStatus, planned);
      next = await refreshAuthoritativeWaterDrop(ws, gsToken, next, "freeWaterAuthoritativeWaterDropAfterReceive");
      plantWaterRefill = getPlantWaterRefillContext(next);
      let postReceiveAuthority = getWaterDropAuthority(next);
      if (!isUsablePostRefillWaterDropAuthority(postReceiveAuthority)) {
        try {
          next = await refreshLand(
            ws,
            gsToken,
            next,
            "freeWaterAuthoritativeLandRefreshAfterReceive",
          );
          plantWaterRefill = getPlantWaterRefillContext(next);
          postReceiveAuthority = getWaterDropAuthority(next);
        } catch (err) {
          if (isSessionExpiredError(err) || isWsRequestTimeoutError(err)) throw err;
          console.log(JSON.stringify({
            step: "freeWaterAuthoritativeLandRefreshAfterReceiveError",
            cycle,
            idx: planned.idx,
            receiveNo: planned.receiveNo,
            message: err.message,
          }));
        }
      }
      if (isUsablePostRefillWaterDropAuthority(postReceiveAuthority)) {
        afterStatus = summarizeFreeWaterStatus(next, {
          waterDropThreshold: plantWaterRefill.threshold,
          plantWaterRefill,
        });
        syncState = getFreeWaterReceiveSyncState(status, afterStatus, planned);
      } else {
        const reason = "waiting-authoritative-water-drop-after-refill";
        const reasonText = "waiting authoritative water drop after free water refill";
        afterStatus = summarizeFreeWaterStatus(next, {
          waterDropThreshold: plantWaterRefill.threshold,
          plantWaterRefill,
        });
        action.stoppedReason = reason;
        action.stoppedReasonText = reasonText;
        logWaterRefillSkip("freeWater", cycle, reason, reasonText, plantWaterRefill, afterStatus);
      }
      action.afterWaterDropCount = afterStatus.waterDropCount;
      action.receivedWaterDropCount = Math.max(0, afterStatus.waterDropCount - status.waterDropCount);
      action.syncState = syncState;
      if (!action.stoppedReason && syncState !== "synced") {
        action.stoppedReason = syncState === "pending-water-sync"
          ? "water-drop-sync-pending"
          : "free-water-recv-not-applied";
        action.stoppedReasonText = syncState === "pending-water-sync"
          ? "Free water receive state advanced before water drops synced; stop this cycle."
          : "Free water receive did not change water drops or receive state; stop this cycle.";
      }
      actions.push(action);
      console.log(JSON.stringify({
        step: "freeWaterReceive",
        cycle,
        idx: planned.idx,
        receiveNo: planned.receiveNo,
        dsName: recv.dsName,
        beforeWaterDropCount: status.waterDropCount,
        afterWaterDropCount: afterStatus.waterDropCount,
        receivedWaterDropCount: action.receivedWaterDropCount,
        syncState,
        receivedCountToday: afterStatus.receivedCountToday,
        maxDailyCount: afterStatus.maxDailyCount,
        threshold: afterStatus.threshold,
      }));
      status = afterStatus;
      if (action.stoppedReason) {
        if (action.stoppedReason === "water-drop-sync-pending") {
          console.log(JSON.stringify({
            step: "waterDropSyncPending",
            source: "freeWater",
            cycle,
            idx: planned.idx,
            receiveNo: planned.receiveNo,
            beforeWaterDropCount: action.beforeWaterDropCount,
            afterWaterDropCount: action.afterWaterDropCount,
            receivedCountToday: status.receivedCountToday,
            threshold: status.threshold,
          }));
        }
        console.log(JSON.stringify({
          step: "waterInvariantStop",
          source: "freeWater",
          cycle,
          reason: action.stoppedReason,
          reasonText: action.stoppedReasonText,
          waterDropCount: action.afterWaterDropCount,
          threshold: status.threshold,
        }));
        break;
      }
      if (!status.waterDropLow) break;
    } catch (err) {
      action.failed = true;
      action.message = err.message;
      actions.push(action);
      console.log(JSON.stringify({
        step: "freeWaterReceiveError",
        cycle,
        idx: planned.idx,
        receiveNo: planned.receiveNo,
        message: err.message,
      }));
      break;
    }
  }

  if (!actions.length) {
    console.log(JSON.stringify({
      step: "freeWaterReceiveSkip",
      cycle,
      reason: status.reasonText,
      waterDropText: status.waterDropText,
      threshold: status.threshold,
      plantWaterRefill: status.plantWaterRefill,
      receivedCountToday: status.receivedCountToday,
      maxDailyCount: status.maxDailyCount,
      slots: status.slots.map((slot) => ({
        idx: slot.idx,
        timeWindowText: slot.timeWindowText,
        received: slot.received,
        inTimeWindow: slot.inTimeWindow,
      })),
    }));
  }

  const blockedAction = actions.find((action) => action.stoppedReason);
  const receivedActions = actions.filter((action) => !action.failed && action.syncState === "synced");
  return {
    syncValue: next,
    actionCount: actions.length,
    receivedCount: receivedActions.length,
    actions,
    status,
    blockedReason: blockedAction?.stoppedReason || null,
    blockedReasonText: blockedAction?.stoppedReasonText || null,
    waterDecision: buildWaterDecision(getPlantWaterRefillContext(next), {
      blockedReason: blockedAction?.stoppedReason || null,
      blockedReasonText: blockedAction?.stoppedReasonText || null,
    }),
  };
}

async function refreshStatusSnapshot(ws, gsToken, syncValue, label = "statusSnapshotRefresh") {
  let next = syncValue;
  try {
    next = await refreshLazySync(ws, gsToken, next, `${label}LazySync`, { log: false });
  } catch (err) {
    console.log(JSON.stringify({
      step: `${label}LazySyncError`,
      iface: "gs.usr.lazySync",
      warn: err.message,
    }));
    rethrowGlobalAutomationError(err);
  }

  try {
    next = await refreshLand(ws, gsToken, next, `${label}LandRefresh`, { log: false });
  } catch (err) {
    console.log(JSON.stringify({
      step: `${label}LandRefreshError`,
      iface: "gs.usrLand.refresh",
      warn: err.message,
    }));
    rethrowGlobalAutomationError(err);
  }

  next = await refreshFmlLandStatusSnapshot(ws, gsToken, next);
  next = await refreshWaterwheelStatusSnapshot(ws, gsToken, next);

  return next;
}

async function refreshAssetSync(ws, gsToken, syncValue, label = "assetSync") {
  let next = syncValue;
  console.log(JSON.stringify({ step: "assetSyncStart", label, iface: "gs.usr.lazySync" }));
  try {
    next = await refreshLazySync(ws, gsToken, next, `${label}LazySync`, { log: false });
  } catch (err) {
    if (isSessionExpiredError(err) || isWsRequestTimeoutError(err)) throw err;
    console.log(JSON.stringify({
      step: "assetSyncError",
      label,
      iface: "gs.usr.lazySync",
      message: err.message,
    }));
  }

  let authority = getWaterDropAuthority(next);
  if (authority.trust !== "authoritative") {
    try {
      next = await refreshLand(ws, gsToken, next, `${label}LandRefresh`, { log: false });
      authority = getWaterDropAuthority(next);
    } catch (err) {
      if (isSessionExpiredError(err) || isWsRequestTimeoutError(err)) throw err;
      console.log(JSON.stringify({
        step: "assetSyncError",
        label,
        iface: "gs.usrLand.refresh",
        message: err.message,
      }));
    }
  }

  const waterDrop = getWaterDropStatus(next);
  authority = getWaterDropAuthority(next);
  console.log(JSON.stringify({
    step: "waterDropClientComputed",
    label,
    waterDropCount: waterDrop.count,
    waterDropText: `${waterDrop.count}/${waterDrop.displayLimit}`,
    baseCount: waterDrop.baseCount,
    restoredCount: waterDrop.restoredCount,
    nextRestoreInSeconds: waterDrop.nextRestoreInSeconds,
    waterDropTrust: authority.trust,
    serverWaterDropReason: authority.serverWaterDropReason,
    serverWaterDropSourcePath: authority.sourcePath,
  }));
  console.log(JSON.stringify({
    step: "assetSyncResult",
    label,
    waterDropCount: waterDrop.count,
    waterDropText: `${waterDrop.count}/${waterDrop.displayLimit}`,
    waterDropTrust: authority.trust,
    serverWaterDropReason: authority.serverWaterDropReason,
    serverWaterDropSourcePath: authority.sourcePath,
  }));
  return next;
}

function compactFmlLandRows(status) {
  return (status?.rows || []).map((row) => ({
    landId: row.landId,
    flowerId: row.flowerId,
    lvl: row.lvl,
    matureFlwCnt: row.matureFlwCnt,
    estimatedMatureFlwCnt: row.estimatedMatureFlwCnt,
    displayMatureFlwCnt: row.displayMatureFlwCnt,
    stock: row.stock,
    canHarvest: row.canHarvest,
    matureSource: row.matureSource,
    statusText: row.statusText,
  }));
}

async function refreshFmlLandStatusSnapshot(
  ws,
  gsToken,
  syncValue,
  label = "fmlLandStatusRefresh",
  options = {},
) {
  if (process.env.AUTO_HANDLE_FML_LAND === "0") return syncValue;

  try {
    const enter = await requestSync(ws, gsToken, FML_LAND_IFACES.enter, {}, "Guild fml enter failed");
    const next = enter.value ? mergeLandSync(syncValue, enter.value) : syncValue;
    const status = summarizeFmlLandStatus(next, {
      nowMs: getResourceActionNowMs(next, options),
    });
    console.log(JSON.stringify({
      step: label,
      iface: FML_LAND_IFACES.enter,
      total: status.total,
      harvestableCount: status.harvestableCount,
      harvestableLandIds: status.harvestableLandIds,
      rows: compactFmlLandRows(status),
      dsName: enter.dsName,
      err: null,
    }));
    return next;
  } catch (err) {
    rethrowGlobalAutomationError(err);
    console.log(JSON.stringify({
      step: `${label}Error`,
      iface: FML_LAND_IFACES.enter,
      warn: err.message,
    }));
    return syncValue;
  }
}

function getPearlMaxHiresPerCycle() {
  const n = Number(process.env.PEARL_MAX_HIRES_PER_CYCLE);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 4;
}

function serializePearlStatus(status) {
  return {
    ...status,
    unavailableRecommendUids: [...(status?.unavailableRecommendUids || [])],
  };
}

async function refreshPearlHireItemInventory(ws, gsToken, syncValue, cycle, label, options = {}) {
  try {
    const next = await refreshLazySync(ws, gsToken, syncValue, label, { log: false });
    const status = summarizePearlStatus(next, {
      nowMs: getResourceActionNowMs(next, options),
    });
    console.log(JSON.stringify({
      step: label,
      cycle,
      iface: "gs.usr.lazySync",
      hireItemId: status.hireItemId,
      hireItemCount: status.hireItemCount,
      err: null,
    }));
    return next;
  } catch (err) {
    if (isSessionExpiredError(err)) throw err;
    console.log(JSON.stringify({
      step: `${label}Error`,
      cycle,
      iface: "gs.usr.lazySync",
      warn: err.message,
    }));
    return syncValue;
  }
}

async function autoHandlePearl(ws, gsToken, syncValue, cycle, options = {}) {
  if (process.env.AUTO_HANDLE_PEARL === "0") {
    console.log(JSON.stringify({ step: "pearlHandleSkip", reason: "disabled" }));
    return { syncValue, actionCount: 0, actions: [], receivedCount: 0, hireCount: 0, dailyFreeCount: 0 };
  }

  let next = syncValue;
  const actionTime = resolveResourceActionTime(syncValue, options);
  const actionTimeOptions = { actionTime };
  const summarizePearl = (value) => summarizePearlStatus(value, { nowMs: actionTime.nowMs });
  const cyclicNoteTargetOnly = options.cyclicNoteTargetOnly === true;
  const hireItemReserveCount = cyclicNoteTargetOnly
    ? Math.max(0, Number(options.hireItemReserveCount ?? 0) || 0)
    : getPearlHireItemReserveCount();
  let status = summarizePearl(next);
  const actions = [];
  let receivedCount = 0;
  let hireCount = 0;
  let dailyFreeCount = 0;

  if (!status.exists) {
    const refreshWhenMissing = process.env.PEARL_REFRESH_WHEN_MISSING !== "0"
      && process.env.AUTO_HANDLE_PEARL_REFRESH_WHEN_MISSING !== "0";
    if (refreshWhenMissing) {
      const refresh = await requestSync(ws, gsToken, PEARL_IFACES.refresh, {}, "Pearl refresh failed");
      next = refresh.value ? mergeLandSync(next, refresh.value) : next;
      status = summarizePearl(next);
      console.log(JSON.stringify({ step: "pearlRefresh", cycle, iface: PEARL_IFACES.refresh, exists: status.exists, dsName: refresh.dsName, err: null }));
    }
  }

  if (!status.exists) {
    console.log(JSON.stringify({ step: "pearlHandleSkip", cycle, reason: "no-pearl-state" }));
    return { syncValue: next, actionCount: 0, actions, receivedCount, hireCount, dailyFreeCount };
  }

  if (!cyclicNoteTargetOnly && status.canRecvDailyFree) {
    const daily = await requestSync(ws, gsToken, PEARL_IFACES.recvDailyFree, {}, "Pearl daily free failed");
    next = daily.value ? mergeLandSync(next, daily.value) : next;
    next = await refreshPearlHireItemInventory(
      ws,
      gsToken,
      next,
      cycle,
      "pearlDailyFreeInventoryRefresh",
      actionTimeOptions,
    );
    dailyFreeCount = 1;
    actions.push({ type: "recvDailyFree", iface: PEARL_IFACES.recvDailyFree, args: {}, outcome: "received", outcomeText: "已领取每日免费雇佣道具" });
    status = summarizePearl(next);
    console.log(JSON.stringify({
      step: "pearlDailyFreeReceived",
      cycle,
      iface: PEARL_IFACES.recvDailyFree,
      hireItemId: status.hireItemId,
      hireItemCount: status.hireItemCount,
      dsName: daily.dsName,
      err: null,
    }));
  }

  if (!cyclicNoteTargetOnly && status.canRecvNum > 0) {
    const beforeCanRecvNum = status.canRecvNum;
    const recv = await requestSync(ws, gsToken, PEARL_IFACES.recvOneKey, {}, "Pearl receive failed");
    next = recv.value ? mergeLandSync(next, recv.value) : next;
    receivedCount += beforeCanRecvNum;
    actions.push({ type: "recvOneKey", iface: PEARL_IFACES.recvOneKey, args: {}, receivedCount: beforeCanRecvNum, outcome: "received", outcomeText: `已收取 ${beforeCanRecvNum} 珍珠` });
    status = summarizePearl(next);
    console.log(JSON.stringify({
      step: "pearlRecvOneKey",
      cycle,
      iface: PEARL_IFACES.recvOneKey,
      receivedCount: beforeCanRecvNum,
      dsName: recv.dsName,
      err: null,
    }));
  }

  if (!status.freePlaceIds.length) {
    console.log(JSON.stringify({
      step: "pearlHireSkip",
      cycle,
      reason: "no-free-place",
      canRecvNum: status.canRecvNum,
      freePlaceIds: status.freePlaceIds,
    }));
    return { syncValue: next, actionCount: actions.length, actions, receivedCount, hireCount, dailyFreeCount };
  }

  if (status.hireItemCount != null && status.hireItemCount <= hireItemReserveCount) {
    console.log(JSON.stringify({
      step: "pearlHireSkip",
      cycle,
      reason: "hire-item-reserved",
      hireItemId: status.hireItemId,
      hireItemCount: status.hireItemCount,
      reserveCount: hireItemReserveCount,
      freePlaceIds: status.freePlaceIds,
    }));
    return { syncValue: next, actionCount: actions.length, actions, receivedCount, hireCount, dailyFreeCount };
  }

  if (!status.recommendList.length) {
    const recommend = await requestSync(ws, gsToken, PEARL_IFACES.getRecommendList, {}, "Pearl recommend failed");
    next = recommend.value ? mergeLandSync(next, recommend.value) : next;
    status = summarizePearl(next);
    console.log(JSON.stringify({
      step: "pearlRecommendList",
      cycle,
      iface: PEARL_IFACES.getRecommendList,
      source: "worldRecommend",
      recommendCount: status.recommendCount,
      dsName: recommend.dsName,
      err: null,
    }));
  }

  if (status.recommendList.length && process.env.PEARL_CHECK_HIRE_STATE !== "0") {
    const uids = [...status.recommendList];
    const hireState = await requestSync(ws, gsToken, PEARL_IFACES.getHireStateByUids, { uids }, "Pearl hire state failed");
    next = hireState.value ? mergeLandSync(next, hireState.value) : next;
    status = summarizePearl(next);
    console.log(JSON.stringify({
      step: "pearlRecommendHireState",
      cycle,
      iface: PEARL_IFACES.getHireStateByUids,
      source: "worldRecommend",
      uidCount: uids.length,
      unavailableCount: status.unavailableRecommendUids.size,
      dsName: hireState.dsName,
      err: null,
    }));
  }

  const maxHireAttempts = cyclicNoteTargetOnly
    ? Math.max(0, status.recommendList.length)
    : getPearlMaxHiresPerCycle();
  const attemptedCandidateUids = new Set();
  const settledPlaceIds = new Set();
  let hireAttemptCount = 0;

  while (hireAttemptCount < maxHireAttempts) {
    status = summarizePearl(next);
    if (status.hireItemCount != null && status.hireItemCount <= hireItemReserveCount) {
      console.log(JSON.stringify({
        step: "pearlHireSkip",
        cycle,
        reason: "hire-item-reserved-before-hire",
        hireItemId: status.hireItemId,
        hireItemCount: status.hireItemCount,
        reserveCount: hireItemReserveCount,
        hireAttemptCount,
        maxHireAttempts,
      }));
      break;
    }
    const planningStatus = {
      ...status,
      freePlaceIds: status.freePlaceIds.filter((placeId) => !settledPlaceIds.has(Number(placeId))),
      unavailableRecommendUids: new Set([
        ...status.unavailableRecommendUids,
        ...attemptedCandidateUids,
      ]),
    };
    const action = getAutoPearlActions(planningStatus, {
      maxHires: 1,
      hireItemReserveCount,
    }).find((item) => item.type === "hire");
    if (!action) {
      console.log(JSON.stringify({
        step: hireAttemptCount ? "pearlHireRetryStop" : "pearlHireSkip",
        cycle,
        reason: "no-world-recommend-candidate",
        hireItemId: status.hireItemId,
        hireItemCount: status.hireItemCount,
        freePlaceIds: planningStatus.freePlaceIds,
        recommendCount: status.recommendCount,
        unavailableCount: planningStatus.unavailableRecommendUids.size,
        hireAttemptCount,
        maxHireAttempts,
      }));
      break;
    }
    attemptedCandidateUids.add(Number(action.dstUid));
    hireAttemptCount += 1;
    const beforePlace = next.pearlTot?.placeMap?.[action.placeId] || next.pearlTot?.placeMap?.[String(action.placeId)] || {};
    const beforeFailCnt = Number(beforePlace.hireFailCnt || 0);
    let hire;
    try {
      hire = await requestSync(ws, gsToken, action.iface, action.args, "Pearl hire failed");
    } catch (err) {
      if (!isItemShortageError(err, status.hireItemId)) throw err;
      next = await refreshPearlHireItemInventory(
        ws,
        gsToken,
        next,
        cycle,
        "pearlHireItemShortageRefresh",
        actionTimeOptions,
      );
      status = summarizePearl(next);
      if (status.hireItemId && status.hireItemCount > 0) {
        next = setLocalBagItemCount(next, status.hireItemId, 0);
        status = summarizePearl(next);
      }
      const payload = getStructuredRequestError(err);
      actions.push({
        ...action,
        outcome: "skipped",
        outcomeText: "服务端判定雇佣书不足，本轮停止雇佣",
        err: payload || err.message,
        hireItemId: status.hireItemId,
        hireItemCount: status.hireItemCount,
      });
      console.log(JSON.stringify({
        step: "pearlHireSkip",
        cycle,
        reason: "server-hire-item-shortage",
        iface: action.iface,
        source: "worldRecommend",
        placeId: action.placeId,
        dstUid: action.dstUid,
        hireItemId: status.hireItemId,
        hireItemCount: status.hireItemCount,
        err: payload || err.message,
      }));
      break;
    }
    next = hire.value ? mergeLandSync(next, hire.value) : next;
    if (status.hireItemId && status.hireItemCount != null) {
      next = setLocalBagItemCount(next, status.hireItemId, Math.max(0, status.hireItemCount - 1));
    }
    const afterPlace = next.pearlTot?.placeMap?.[action.placeId] || next.pearlTot?.placeMap?.[String(action.placeId)] || {};
    const afterFailCnt = Number(afterPlace.hireFailCnt || 0);
    const hired = Number(afterPlace.laborUid) === Number(action.dstUid) || Boolean(afterPlace.laborUid && afterPlace.laborEndTime);
    const amuletBlocked = afterFailCnt <= beforeFailCnt && Boolean(hire.value?.$ext?.iv);
    const outcome = afterFailCnt > beforeFailCnt
      ? "failed"
      : amuletBlocked
        ? "amulet-blocked"
        : hired
          ? "hired"
          : "submitted";
    const outcomeText = outcome === "failed"
      ? "雇佣失败"
      : outcome === "amulet-blocked"
        ? "对方使用护身符抵挡"
        : outcome === "hired"
          ? "已雇佣"
          : "已请求，等待服务端状态刷新";
    if (outcome === "hired") hireCount += 1;
    if (!amuletBlocked) settledPlaceIds.add(Number(action.placeId));
    const recorded = {
      ...action,
      outcome,
      outcomeText,
      amuletBlocked,
      laborUid: afterPlace.laborUid ?? null,
      laborEndTime: afterPlace.laborEndTime ?? null,
      hireFailCnt: afterPlace.hireFailCnt ?? null,
    };
    actions.push(recorded);
    status = summarizePearl(next);
    console.log(JSON.stringify({
      step: "pearlHireDone",
      cycle,
      iface: action.iface,
      source: "worldRecommend",
      placeId: action.placeId,
      dstUid: action.dstUid,
      outcome,
      outcomeText,
      amuletBlocked,
      hireAttemptCount,
      maxHireAttempts,
      laborUid: afterPlace.laborUid ?? null,
      laborEndTime: afterPlace.laborEndTime ?? null,
      dsName: hire.dsName,
      err: null,
    }));
  }

  return { syncValue: next, actionCount: actions.length, actions, receivedCount, hireCount, dailyFreeCount };
}

function setLocalItemCount(sync, itemId, count) {
  const out = { ...sync };
  const usrTot = { ...(out.$usrTot || {}) };
  const dataKey = usrTot.data ? "data" : usrTot.usr ? "usr" : "data";
  const data = { ...(usrTot[dataKey] || {}) };
  const bag = { ...(data.bag || data.itemMap || usrTot.bag || usrTot.itemMap || {}) };
  bag[itemId] = Math.max(0, Math.floor(Number(count) || 0));
  data.bag = bag;
  usrTot[dataKey] = data;
  out.$usrTot = usrTot;
  return out;
}

function applyLocalItemDeltasForUnchanged(beforeSync, afterSync, deltas = []) {
  let out = afterSync;
  for (const { itemId, delta } of deltas) {
    const beforeCount = getItemCount(beforeSync, itemId);
    const afterCount = getItemCount(out, itemId);
    if (afterCount === beforeCount) {
      out = setLocalItemCount(out, itemId, beforeCount + delta);
    }
  }
  return out;
}

function applyLocalItemDeltaPatchesForUnchanged(syncValue, patches = []) {
  let out = syncValue;
  let appliedPatchCount = 0;
  for (const patch of patches) {
    const beforePatch = out;
    out = applyLocalItemDeltasForUnchanged(patch.beforeSync, out, patch.deltas);
    if (out !== beforePatch) appliedPatchCount += 1;
  }
  return { syncValue: out, appliedPatchCount };
}

function preserveWaterDropCountAfterRefillSync(beforeSync, afterSync) {
  const beforeWater = getWaterDropStatus(beforeSync);
  const afterWater = getWaterDropStatus(afterSync);
  return {
    syncValue: afterSync,
    preserved: false,
    beforeWaterDropCount: beforeWater.count,
    afterWaterDropCount: afterWater.count,
    lowerAfterWaterDropCount: afterWater.count < beforeWater.count ? afterWater.count : null,
  };
}

function flowerRackActionLocalDeltas(action) {
  if (action.type === "makeFlowerArt") {
    const num = Number(action.num || action.args?.num || 0);
    if (!num) return [];
    return (action.args?.flowersIds || []).map((itemId) => ({ itemId, delta: -num }));
  }

  if (action.type === "sell") {
    const num = Number(action.num || action.args?.num || 0);
    const itemId = action.artId || action.args?.iid;
    return itemId && num ? [{ itemId, delta: -num }] : [];
  }

  return [];
}

function customerOrderActionStepLocalDeltas(action, actionStep, order = {}) {
  if (actionStep?.type === "makeFlowerArt") {
    const num = Number(actionStep.args?.num || 0);
    if (!num) return [];
    return (actionStep.args?.flowersIds || []).map((itemId) => ({ itemId, delta: -num }));
  }

  if (actionStep?.type === "finishCustomerOrder") {
    const itemId = action?.artId || order?.artId;
    const num = Number(order?.needArt || action?.needArt || 0);
    if (!itemId || !num) return [];
    return [{ itemId, delta: -num }];
  }

  return [];
}

function customerOrderAuthorityObservation(map, itemId, kind, sourcePath, source = null) {
  const value = readOwnItemValue(map, itemId);
  if (value == null) return null;
  return {
    kind,
    value,
    source,
    sourcePath,
  };
}

function readCustomerOrderArtAuthorityEvidence(value, itemId, source) {
  if (!value || typeof value !== "object") return [];
  const usrTot = value.$usrTot || {};
  const data = usrTot.data || {};
  const usr = usrTot.usr || {};
  const absoluteCandidates = [
    { map: data.bag, path: "$usrTot.data.bag" },
    { map: data.itemMap, path: "$usrTot.data.itemMap" },
    { map: usr.bag, path: "$usrTot.usr.bag" },
    { map: usr.itemMap, path: "$usrTot.usr.itemMap" },
    { map: usrTot.bag, path: "$usrTot.bag" },
    { map: usrTot.itemMap, path: "$usrTot.itemMap" },
    { map: usrTot.oi?.bd, path: "$usrTot.oi.bd" },
    { map: value.bag, path: "bag" },
    { map: value.itemMap, path: "itemMap" },
    { map: value.oi?.bd, path: "oi.bd" },
  ];
  for (const candidate of absoluteCandidates) {
    const observation = customerOrderAuthorityObservation(
      candidate.map,
      itemId,
      "absolute",
      `${source}.${candidate.path}[${itemId}]`,
      source,
    );
    if (observation) return [observation];
  }

  const oiContainers = [];
  if (usrTot.oi && typeof usrTot.oi === "object") oiContainers.push({ value: usrTot.oi, path: "$usrTot.oi" });
  if (value.oi && value.oi !== usrTot.oi && typeof value.oi === "object") oiContainers.push({ value: value.oi, path: "oi" });
  for (const container of oiContainers) {
    const observations = [];
    for (const [key, map] of [["bi", container.value.bi], ["bo", container.value.bo]]) {
      const observation = customerOrderAuthorityObservation(
        map,
        itemId,
        "delta",
        `${source}.${container.path}.${key}[${itemId}]`,
        source,
      );
      if (observation) observations.push(observation);
    }
    if (observations.length) return observations;
  }

  const itemAddChgContainers = [];
  if (usrTot.itemAddChg && typeof usrTot.itemAddChg === "object") {
    itemAddChgContainers.push({ value: usrTot.itemAddChg, path: "$usrTot.itemAddChg" });
  }
  if (value.itemAddChg && value.itemAddChg !== usrTot.itemAddChg && typeof value.itemAddChg === "object") {
    itemAddChgContainers.push({ value: value.itemAddChg, path: "itemAddChg" });
  }
  for (const container of itemAddChgContainers) {
    const direct = customerOrderAuthorityObservation(
      container.value.itemMap || container.value.items,
      itemId,
      "delta",
      `${source}.${container.path}.itemMap[${itemId}]`,
      source,
    );
    if (direct) return [direct];
    const recordObservations = [];
    for (const [index, record] of (container.value.itemAddRcdList || []).entries()) {
      const observation = customerOrderAuthorityObservation(
        record?.itemMap || record?.items,
        itemId,
        "delta",
        `${source}.${container.path}.itemAddRcdList[${index}].itemMap[${itemId}]`,
        source,
      );
      if (observation) recordObservations.push(observation);
    }
    if (recordObservations.length) return recordObservations;
  }

  return [];
}

function resolveCustomerOrderArtAuthority({ payloads = [], itemId, baselineCount, expectedCount }) {
  const observations = [];
  for (const payload of payloads) {
    observations.push(...readCustomerOrderArtAuthorityEvidence(
      payload?.value,
      itemId,
      payload?.source || "customer-order-authority-payload",
    ));
  }
  const baseline = toFiniteNumber(baselineCount, null);
  const expected = toFiniteNumber(expectedCount, null);
  const absoluteCounts = observations
    .filter((observation) => observation.kind === "absolute")
    .map((observation) => observation.value);
  const deltaObservations = observations.filter((observation) => observation.kind === "delta");
  const candidateCounts = [...absoluteCounts];
  if (baseline != null && deltaObservations.length) {
    candidateCounts.push(
      baseline + deltaObservations.reduce((sum, observation) => sum + observation.value, 0),
    );
  }
  const highestCandidate = candidateCounts.length ? Math.max(...candidateCounts) : null;
  const confirmedArtCount = highestCandidate == null || expected == null || expected <= 0
    ? highestCandidate
    : Math.min(highestCandidate, expected);
  const confirmed = expected != null
    && expected > 0
    && candidateCounts.some((count) => count >= expected);
  return {
    confirmed,
    confirmedArtCount,
    confirmationKnown: observations.length > 0,
    authorityEvidence: observations,
    syncSource: observations.length
      ? [...new Set(observations.map((observation) => observation.source).filter(Boolean))]
      : [],
    failureCategory: expected == null || expected <= 0
      ? "expected-art-count-unknown"
      : confirmed
        ? null
        : "authoritative-confirmation-missing",
  };
}

function updateCustomerOrderEntry(sync, npcId, updater) {
  const out = { ...sync };
  const npcKey = String(npcId);

  if (out.orderCustomerTot?.orderCustomer?.orderMap) {
    const orderCustomerTot = { ...out.orderCustomerTot };
    const orderCustomer = { ...orderCustomerTot.orderCustomer };
    const orderMap = { ...orderCustomer.orderMap };
    const current = orderMap[npcKey] || orderMap[npcId];
    if (current && typeof current === "object") {
      orderMap[npcKey] = updater(current);
      orderCustomer.orderMap = orderMap;
      orderCustomerTot.orderCustomer = orderCustomer;
      out.orderCustomerTot = orderCustomerTot;
    }
  }

  if (out.orderCustomer?.orderMap) {
    const orderCustomer = { ...out.orderCustomer };
    const orderMap = { ...orderCustomer.orderMap };
    const current = orderMap[npcKey] || orderMap[npcId];
    if (current && typeof current === "object") {
      orderMap[npcKey] = updater(current);
      orderCustomer.orderMap = orderMap;
      out.orderCustomer = orderCustomer;
    }
  }

  return out;
}

function markCustomerOrderPendingArtSync(sync, npcId, pendingArtSync) {
  return updateCustomerOrderEntry(sync, npcId, (entry) => ({
    ...entry,
    automationPendingArtSync: pendingArtSync,
  }));
}

function parseJsonFromErrorMessage(message) {
  const text = String(message || "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

function parseItemShortageError(err) {
  const payload = err?.errMsg || parseJsonFromErrorMessage(err?.message);
  const code = Number(payload?.code ?? payload?.type);
  const itemId = Number(
    payload?.param?.iid
      ?? payload?.param?.itemId
      ?? payload?.iid
      ?? payload?.itemId,
  );
  if (code !== 301 || !Number.isFinite(itemId) || itemId <= 0) return null;
  return { code, itemId, payload };
}

function parseCustomerOrderItemShortageError(err) {
  return parseItemShortageError(err);
}

export async function autoHandleFlowerRack(ws, gsToken, syncValue, cycle, options = {}) {
  if (process.env.AUTO_HANDLE_FLOWER_RACK === "0") {
    console.log(JSON.stringify({ step: "flowerRackHandleSkip", reason: "disabled" }));
    return { syncValue, actionCount: 0, actions: [], receivedCount: 0, makeActionCount: 0, madeCount: 0, shelvedCount: 0, failedCount: 0 };
  }

  const status = summarizeFlowerRackStatus(syncValue);
  console.log(JSON.stringify({
    step: "flowerRackActionPlan",
    cycle,
    rule: "only collect rack gold and shelf configured flower art while double gold has more than one minute left; make missing flower art first when stock plus craftable count reaches target",
    doubleGoldGate: status.doubleGoldGate,
    targetArt: status.targetArt,
    collectableCount: status.collectableCount,
    emptyCount: status.emptyCount,
    sellingCount: status.sellingCount,
    sellPlanCount: status.sellPlanCount,
    actionCount: status.actionCount,
    reasonText: status.reasonText,
    actions: status.actions.map((action) => ({
      type: action.type,
      iface: action.iface,
      args: action.args,
      outcomeText: action.outcomeText,
    })),
  }, null, 2));

  const plannedActions = status.actions;
  if (!plannedActions.length) {
    return { syncValue, actionCount: 0, actions: [], receivedCount: 0, makeActionCount: 0, madeCount: 0, shelvedCount: 0, failedCount: 0, status };
  }

  let next = syncValue;
  const actions = [];
  const failedCollectRackIds = new Set();
  const shortageItemIds = new Set();
  let makeFlowerArtFailed = false;
  let makeFlowerArtPendingSync = false;
  let receivedCount = 0;
  let makeActionCount = 0;
  let madeCount = 0;
  let shelvedCount = 0;
  let failedCount = 0;

  for (const action of plannedActions) {
    const actionArtId = Number(action.artId || action.args?.iid || 0);
    if (action.type === "sell" && makeFlowerArtPendingSync) {
      const skipped = {
        ...action,
        outcome: "skipped",
        outcomeText: "等待花艺库存同步，跳过本轮上架",
      };
      actions.push(skipped);
      console.log(JSON.stringify({
        step: "flowerRackActionStepSkipped",
        cycle,
        rackId: action.rackId,
        type: action.type,
        iface: action.iface,
        itemId: actionArtId || null,
        reason: "waiting-flower-rack-art-sync",
        reasonText: skipped.outcomeText,
      }));
      continue;
    }

    if (action.type === "sell" && actionArtId && shortageItemIds.has(actionArtId)) {
      const skipped = {
        ...action,
        outcome: "skipped",
        outcomeText: "服务端判定花艺库存不足，跳过本轮上架",
      };
      actions.push(skipped);
      console.log(JSON.stringify({
        step: "flowerRackActionStepSkipped",
        cycle,
        rackId: action.rackId,
        type: action.type,
        iface: action.iface,
        itemId: actionArtId,
        reason: "item-shortage",
        reasonText: skipped.outcomeText,
      }));
      continue;
    }

    if (action.type === "sell" && makeFlowerArtFailed) {
      const skipped = {
        ...action,
        outcome: "skipped",
        outcomeText: "制作花艺失败，跳过上架",
      };
      actions.push(skipped);
      console.log(JSON.stringify({
        step: "flowerRackActionStepSkipped",
        cycle,
        rackId: action.rackId,
        type: action.type,
        iface: action.iface,
        reason: skipped.outcomeText,
      }));
      continue;
    }

    if (action.type === "sell" && failedCollectRackIds.has(action.rackId)) {
      const skipped = {
        ...action,
        outcome: "skipped",
        outcomeText: "收金币失败，跳过该花架上架",
      };
      actions.push(skipped);
      console.log(JSON.stringify({
        step: "flowerRackActionStepSkipped",
        cycle,
        rackId: action.rackId,
        type: action.type,
        iface: action.iface,
        reason: skipped.outcomeText,
      }));
      continue;
    }

    try {
      const beforeActionSync = next;
      const rsp = await requestSync(ws, gsToken, action.iface, action.args, "Flower rack action failed");
      next = rsp.value ? mergeLandSync(next, rsp.value) : next;
      next = applyLocalItemDeltasForUnchanged(beforeActionSync, next, flowerRackActionLocalDeltas(action));
      const recorded = {
        ...action,
        outcome: "done",
        dsName: rsp.dsName,
        err: null,
      };
      actions.push(recorded);
      if (action.type === "recvSellMoney") receivedCount += 1;
      if (action.type === "makeFlowerArt") {
        makeActionCount += 1;
        madeCount += Number(action.num || action.args?.num || 0);
        makeFlowerArtPendingSync = true;
        console.log(JSON.stringify({
          step: "flowerRackArtSyncPending",
          cycle,
          artId: action.artId || action.args?.iid || null,
          expectedCount: Number(action.num || action.args?.num || 0),
          reason: "make-flower-art-await-server-sync",
        }));
      }
      if (action.type === "sell") {
        shelvedCount += action.args?.sellMap
          ? Object.keys(action.args.sellMap).length
          : 1;
      }
      console.log(JSON.stringify({
        step: "flowerRackActionStepDone",
        cycle,
        rackId: action.rackId,
        type: action.type,
        iface: action.iface,
        args: action.args,
        outcomeText: action.outcomeText,
        dsName: rsp.dsName,
        err: null,
      }));
    } catch (err) {
      failedCount += 1;
      const shortage = parseItemShortageError(err);
      if (shortage) {
        next = setLocalItemCount(next, shortage.itemId, 0);
        shortageItemIds.add(shortage.itemId);
      }
      if (action.type === "recvSellMoney") failedCollectRackIds.add(action.rackId);
      if (action.type === "makeFlowerArt") makeFlowerArtFailed = true;
      const failed = {
        ...action,
        outcome: "failed",
        outcomeText: "处理失败",
        error: err.message,
        ...(shortage ? { code: shortage.code, itemId: shortage.itemId } : {}),
      };
      actions.push(failed);
      console.log(JSON.stringify({
        step: "flowerRackActionStepFailed",
        cycle,
        rackId: action.rackId,
        type: action.type,
        iface: action.iface,
        args: action.args,
        message: err.message,
        code: shortage?.code ?? null,
        itemId: shortage?.itemId ?? null,
        shortageRecovered: Boolean(shortage),
        err: shortage?.payload ?? null,
      }));
    }
  }

  const nextStatus = summarizeFlowerRackStatus(next);
  return {
    syncValue: next,
    actionCount: receivedCount + makeActionCount + shelvedCount,
    actions,
    receivedCount,
    makeActionCount,
    madeCount,
    shelvedCount,
    failedCount,
    status: nextStatus,
  };
}

const MAX_MATERIAL_SHOP_REFRESH_ATTEMPTS_PER_CYCLE = 16;

function getMaterialShopMidnightRefreshOptions(env = process.env) {
  const settings = readProfileAutomationSettings();
  const rawMaxCostYuanbao = Number(env.MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO);
  const rawMaxCostExclusive = Number(env.MATERIAL_SHOP_REFRESH_MAX_COST_EXCLUSIVE);
  const legacyMaxCostYuanbao = MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO_OPTIONS
    .filter((cost) => Number.isFinite(rawMaxCostExclusive) && cost < rawMaxCostExclusive)
    .at(-1);
  const maxCostYuanbao = Object.hasOwn(env, "MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO")
    && Number.isFinite(rawMaxCostYuanbao)
    && rawMaxCostYuanbao >= 0
    ? Math.min(rawMaxCostYuanbao, HARD_MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO)
    : Object.hasOwn(env, "MATERIAL_SHOP_REFRESH_MAX_COST_EXCLUSIVE")
      && legacyMaxCostYuanbao != null
      ? legacyMaxCostYuanbao
      : settings.materialShopRefreshMaxCostYuanbao;
  return {
    enabled: Object.hasOwn(env, "AUTO_REFRESH_MATERIAL_SHOP_BEFORE_MIDNIGHT")
      ? env.AUTO_REFRESH_MATERIAL_SHOP_BEFORE_MIDNIGHT === "1"
      : settings.materialShopMidnightRefreshEnabled === true,
    windowStart: env.MATERIAL_SHOP_REFRESH_WINDOW_START
      || settings.materialShopRefreshWindowStart
      || DEFAULT_MATERIAL_SHOP_REFRESH_WINDOW_START,
    windowEnd: env.MATERIAL_SHOP_REFRESH_WINDOW_END
      || DEFAULT_MATERIAL_SHOP_REFRESH_WINDOW_END,
    maxCostYuanbao,
  };
}

async function refreshCyclicStoryStatus(
  ws,
  gsToken,
  syncValue,
  batchId,
  cycle = null,
  step = "cyclicStoryStatusRefresh",
) {
  const enter = await requestSync(
    ws,
    gsToken,
    CYCLIC_STORY_ENTER_IFACE,
    { batchId },
    "Cyclic story enter failed",
  );
  const next = enter.value ? mergeLandSync(syncValue, enter.value) : syncValue;
  const status = summarizeCyclicStoryStatus(next);
  console.log(JSON.stringify({
    step,
    cycle,
    iface: CYCLIC_STORY_ENTER_IFACE,
    batchId,
    status: status.reason,
    active: status.active,
    phase: status.phase,
    readyCount: status.pendingAutoSubmitActions?.length ?? 0,
    dsName: enter.dsName,
    err: null,
  }));
  return next;
}

async function autoHandleMaterialShop(ws, gsToken, syncValue, cycle, options = {}) {
  if (process.env.AUTO_HANDLE_MATERIAL_SHOP === "0") {
    console.log(JSON.stringify({ step: "materialShopHandleSkip", reason: "disabled" }));
    return {
      syncValue,
      actionCount: 0,
      actions: [],
      boughtCount: 0,
      spentGold: 0,
      failedCount: 0,
      refreshActions: [],
      refreshCount: 0,
      freeRefreshCount: 0,
      paidRefreshCount: 0,
      spentYuanbao: 0,
      refreshFailedCount: 0,
      refreshStopReason: "material-shop-disabled",
    };
  }

  let next = syncValue;
  const actionTime = resolveResourceActionTime(syncValue, options);
  const summarizeMaterialShop = (value) => summarizeMaterialShopStatus(value, { nowMs: actionTime.nowMs });
  const actions = [];
  let boughtCount = 0;
  let spentGold = 0;
  let failedCount = 0;
  const refreshActions = [];
  let refreshCount = 0;
  let freeRefreshCount = 0;
  let paidRefreshCount = 0;
  let spentYuanbao = 0;
  let refreshFailedCount = 0;
  let refreshStopReason = null;

  const enterShop = async (label) => {
    const response = await requestSync(
      ws,
      gsToken,
      MATERIAL_SHOP_IFACES.enter,
      {},
      "Material shop enter failed",
    );
    next = response.value ? mergeLandSync(next, response.value) : next;
    return {
      label,
      response,
      status: summarizeMaterialShop(next),
    };
  };

  const buyCurrentVisibleMaterials = async ({ label, response, status: initialStatus }) => {
    let status = initialStatus;
    const failedBefore = failedCount;
    console.log(JSON.stringify({
      step: "materialShopActionPlan",
      cycle,
      label,
      iface: MATERIAL_SHOP_IFACES.enter,
      dsName: response.dsName,
      rowCount: status.rowCount,
      buyableCount: status.buyableCount,
      blockedCurrencyCount: status.blockedCurrencyCount,
      goldCount: status.goldCount,
      totalGoldCost: status.totalGoldCost,
      canBuyAll: status.canBuyAll,
      reasonText: status.reasonText,
      actions: status.actions.map((action) => ({
        iface: action.iface,
        args: action.args,
        itemName: action.itemName,
        itemNum: action.itemNum,
        priceNum: action.priceNum,
      })),
    }, null, 2));

    for (const action of status.actions) {
      try {
        const rsp = await requestSync(ws, gsToken, action.iface, action.args, "Material shop buy failed");
        next = rsp.value ? mergeLandSync(next, rsp.value) : next;
        boughtCount += 1;
        spentGold += Number(action.priceNum || 0);
        const recorded = {
          ...action,
          outcome: "bought",
          outcomeText: "已购买",
          dsName: rsp.dsName,
          err: null,
        };
        actions.push(recorded);
        console.log(JSON.stringify({
          step: "materialShopBuyDone",
          cycle,
          label,
          iface: action.iface,
          shopId: action.shopId,
          itemId: action.itemId,
          itemName: action.itemName,
          itemNum: action.itemNum,
          priceItemName: action.priceItemName,
          priceNum: action.priceNum,
          dsName: rsp.dsName,
          err: null,
        }));
      } catch (err) {
        rethrowGlobalAutomationError(err);
        failedCount += 1;
        actions.push({
          ...action,
          outcome: "failed",
          outcomeText: "购买失败",
          error: err.message,
        });
        console.log(JSON.stringify({
          step: "materialShopBuyFailed",
          cycle,
          label,
          iface: action.iface,
          shopId: action.shopId,
          itemId: action.itemId,
          itemName: action.itemName,
          message: err.message,
        }));
      }
    }

    status = summarizeMaterialShop(next);
    const safeForRefresh = failedCount === failedBefore
      && status.buyableCount === 0
      && status.blockedCurrencyCount === 0;
    return { status, safeForRefresh };
  };

  let entered = await enterShop("initial");
  let purchase = await buyCurrentVisibleMaterials(entered);
  let status = purchase.status;
  const refreshOptions = getMaterialShopMidnightRefreshOptions();

  if (!purchase.safeForRefresh) {
    refreshStopReason = failedCount > 0
      ? "material-purchase-failed"
      : status.blockedCurrencyCount > 0
        ? "non-gold-material-present"
        : "material-purchase-not-confirmed";
  } else {
    for (let attempt = 0; attempt < MAX_MATERIAL_SHOP_REFRESH_ATTEMPTS_PER_CYCLE; attempt += 1) {
      const plan = getMaterialShopMidnightRefreshPlan(next, {
        ...refreshOptions,
        nowMs: actionTime.nowMs,
      });
      console.log(JSON.stringify({
        step: "materialShopRefreshPlan",
        cycle,
        attempt: attempt + 1,
        ...plan,
      }));
      if (!plan.shouldRefresh) {
        refreshStopReason = plan.reason;
        break;
      }

      const beforeRefresh = next;
      try {
        const refresh = await requestSync(
          ws,
          gsToken,
          MATERIAL_SHOP_IFACES.refresh,
          {},
          "Material shop refresh failed",
        );
        next = refresh.value ? mergeLandSync(next, refresh.value) : next;
        entered = await enterShop(`refresh-${attempt + 1}`);
        const verification = verifyMaterialShopRefreshOutcome({
          beforeSync: beforeRefresh,
          afterSync: next,
          refreshValue: refresh.value,
          enterValue: entered.response.value,
          expectedCostYuanbao: plan.nextRefreshCostYuanbao,
        });
        const recorded = {
          type: "refreshMaterialShop",
          iface: MATERIAL_SHOP_IFACES.refresh,
          args: {},
          attempt: attempt + 1,
          refreshKind: plan.refreshKind,
          expectedCostYuanbao: plan.nextRefreshCostYuanbao,
          ...verification,
          outcome: verification.confirmed ? "refreshed" : "unknown",
          outcomeText: verification.confirmed ? "刷新已确认" : "刷新结果不明，停止后续刷新",
        };
        refreshActions.push(recorded);
        console.log(JSON.stringify({
          step: verification.confirmed
            ? "materialShopRefreshDone"
            : "materialShopRefreshUnknown",
          cycle,
          ...recorded,
        }));
        if (!verification.confirmed) {
          refreshFailedCount += 1;
          refreshStopReason = verification.reason;
          status = entered.status;
          break;
        }

        refreshCount += 1;
        spentYuanbao += verification.actualSpentYuanbao;
        if (verification.charged) paidRefreshCount += 1;
        else freeRefreshCount += 1;

        purchase = await buyCurrentVisibleMaterials(entered);
        status = purchase.status;
        if (!purchase.safeForRefresh) {
          refreshStopReason = failedCount > 0
            ? "material-purchase-failed"
            : status.blockedCurrencyCount > 0
              ? "non-gold-material-present"
              : "material-purchase-not-confirmed";
          break;
        }
        if (attempt === MAX_MATERIAL_SHOP_REFRESH_ATTEMPTS_PER_CYCLE - 1) {
          refreshStopReason = "cycle-refresh-attempt-limit";
        }
      } catch (err) {
        rethrowGlobalAutomationError(err);
        refreshFailedCount += 1;
        refreshStopReason = "refresh-request-failed";
        refreshActions.push({
          type: "refreshMaterialShop",
          iface: MATERIAL_SHOP_IFACES.refresh,
          args: {},
          attempt: attempt + 1,
          refreshKind: plan.refreshKind,
          expectedCostYuanbao: plan.nextRefreshCostYuanbao,
          outcome: "failed",
          outcomeText: "刷新失败，停止后续刷新",
          error: err.message,
        });
        console.log(JSON.stringify({
          step: "materialShopRefreshFailed",
          cycle,
          attempt: attempt + 1,
          message: err.message,
        }));
        break;
      }
    }
  }

  console.log(JSON.stringify({
    step: "materialShopRefreshStopped",
    cycle,
    refreshCount,
    freeRefreshCount,
    paidRefreshCount,
    spentYuanbao,
    refreshFailedCount,
    reason: refreshStopReason,
  }));
  return {
    syncValue: next,
    actionCount: boughtCount,
    actions,
    boughtCount,
    spentGold,
    failedCount,
    status,
    refreshActions,
    refreshCount,
    freeRefreshCount,
    paidRefreshCount,
    spentYuanbao,
    refreshFailedCount,
    refreshStopReason,
  };
}

async function autoHarvestFmlLand(ws, gsToken, syncValue, cycle, options = {}) {
  if (process.env.AUTO_HANDLE_FML_LAND === "0") {
    console.log(JSON.stringify({ step: "fmlLandHarvestSkip", cycle, reason: "disabled" }));
    return { syncValue, scanned: false, actionCount: 0, actions: [], harvestedCount: 0, failedCount: 0 };
  }

  const nowMs = getResourceActionNowMs(syncValue, options);
  const intervalMs = getFmlLandScanIntervalMs();
  const intervalSeconds = Math.floor(intervalMs / 1000);
  const cachedStatus = summarizeFmlLandStatus(syncValue, { nowMs });
  const scanDue = shouldScanFmlLand({ lastScanAtMs: lastFmlLandScanAttemptAtMs, nowMs, intervalMs });
  if (!scanDue && cachedStatus.harvestableCount <= 0) {
    const nextScanInSeconds = Math.max(0, Math.ceil((lastFmlLandScanAttemptAtMs + intervalMs - nowMs) / 1000));
    console.log(JSON.stringify({
      step: "fmlLandHarvestSkip",
      cycle,
      reason: "scan-interval",
      intervalSeconds,
      nextScanInSeconds,
      harvestableCount: cachedStatus.harvestableCount,
    }));
    return { syncValue, scanned: false, actionCount: 0, actions: [], harvestedCount: 0, failedCount: 0, status: cachedStatus };
  }

  if (!scanDue && cachedStatus.harvestableCount > 0) {
    console.log(JSON.stringify({
      step: "fmlLandScanIntervalBypass",
      cycle,
      reason: "cached-harvestable",
      intervalSeconds,
      harvestableCount: cachedStatus.harvestableCount,
      harvestableLandIds: cachedStatus.harvestableLandIds,
      rows: compactFmlLandRows(cachedStatus),
    }));
  }

  lastFmlLandScanAttemptAtMs = nowMs;
  let next = syncValue;
  let enter;
  try {
    enter = await requestSync(ws, gsToken, FML_LAND_IFACES.enter, {}, "Guild fml enter failed");
    next = enter.value ? mergeLandSync(next, enter.value) : next;
  } catch (err) {
    console.log(JSON.stringify({
      step: "fmlLandScanError",
      cycle,
      iface: FML_LAND_IFACES.enter,
      intervalSeconds,
      message: err.message,
    }));
    return { syncValue: next, scanned: true, actionCount: 0, actions: [], harvestedCount: 0, failedCount: 1 };
  }

  const status = summarizeFmlLandStatus(next, { nowMs });
  console.log(JSON.stringify({
    step: "fmlLandScan",
    cycle,
    iface: FML_LAND_IFACES.enter,
    intervalSeconds,
    total: status.total,
    harvestableCount: status.harvestableCount,
    harvestableLandIds: status.harvestableLandIds,
    rows: compactFmlLandRows(status),
    dsName: enter.dsName,
    err: null,
  }));

  const action = getFmlLandHarvestPlan(status);
  if (!action) {
    console.log(JSON.stringify({
      step: "fmlLandHarvestSkip",
      cycle,
      reason: status.exists ? "no-mature-fml-land" : "no-fml-land-state",
      total: status.total,
      harvestableCount: status.harvestableCount,
    }));
    return { syncValue: next, scanned: true, actionCount: 0, actions: [], harvestedCount: 0, failedCount: 0, status };
  }

  try {
    const rsp = await requestSync(ws, gsToken, action.iface, action.args, "Guild fml land harvest failed");
    next = rsp.value ? mergeLandSync(next, rsp.value) : next;
    const recorded = {
      ...action,
      outcome: "harvested",
      outcomeText: "已收获公会土地",
      dsName: rsp.dsName,
      err: null,
    };
    console.log(JSON.stringify({
      step: "fmlLandHarvest",
      cycle,
      iface: action.iface,
      landIds: action.args.landIds,
      requestedCount: action.requestedCount,
      harvestedCount: action.requestedCount,
      dsName: rsp.dsName,
      err: null,
    }));
    return {
      syncValue: next,
      scanned: true,
      actionCount: 1,
      actions: [recorded],
      harvestedCount: action.requestedCount,
      failedCount: 0,
      status: summarizeFmlLandStatus(next, { nowMs }),
    };
  } catch (err) {
    const failed = {
      ...action,
      outcome: "failed",
      outcomeText: "公会土地收获失败",
      error: err.message,
    };
    console.log(JSON.stringify({
      step: "fmlLandHarvestError",
      cycle,
      iface: action.iface,
      landIds: action.args.landIds,
      requestedCount: action.requestedCount,
      message: err.message,
    }));
    return {
      syncValue: next,
      scanned: true,
      actionCount: 0,
      actions: [failed],
      harvestedCount: 0,
      failedCount: 1,
      status,
    };
  }
}

async function waitWithOnlineHeartTick(ws, gsToken, syncValue, totalMs, options = {}) {
  await throwIfAutomationStopped(options);
  if (!isAccountCommandGateway(ws)) {
    ws = createAutomationAccountCommandGateway(ws, gsToken, syncValue, options);
  }
  ws.observeSync(syncValue, {
    ...options,
    cycle: options.cycle ?? null,
  });
  let next = syncValue;
  const nowFn = options.nowFn || Date.now;
  const waitFn = options.waitFn || wait;
  const statusWriter = options.statusWriter || writeStatusDocuments;
  const statusRefresher = options.statusRefresher || refreshStatusSnapshot;
  const assetSyncRefresher = options.assetSyncRefresher || refreshAssetSync;
  const growthHandler = options.growthHandler || handleTimeCriticalGrowth;
  const customerOrderRefresher = options.customerOrderRefresher || refreshCustomerOrders;
  const customerOrderProcessor = options.customerOrderProcessor || autoSubmitCustomerOrders;
  const flowerNames = options.flowerNames || loadFlowerNameMap();
  const authoritativeSnapshotIntervalMs = options.authoritativeSnapshotIntervalMs
    ?? (options.statusRefreshIntervalMs != null
      ? options.statusRefreshIntervalMs
      : getAccountSnapshotIntervalMs());
  const assetSyncIntervalMs = options.assetSyncIntervalMs ?? getAssetSyncIntervalMs();
  const customerOrderRetryIntervalMs = getCustomerOrderGenerationDuringWaitRetryIntervalMs();
  const scheduler = options.accountScheduler || createAccountScheduler({
    accountId: process.env.PROFILE_ID || null,
    nowFn,
  });
  const customerOrderScheduler = options.customerOrderScheduler || createCustomerOrderScheduler({
    accountId: process.env.PROFILE_ID || null,
    nowFn,
    retryIntervalMs: customerOrderRetryIntervalMs,
    healthCheckIntervalMs: CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS,
  });
  const startMs = nowFn();
  const endMs = startMs + Math.max(0, totalMs);
  if (authoritativeSnapshotIntervalMs > 0 && !scheduler.hasModule("authoritativeSnapshot")) {
    scheduler.defer("authoritativeSnapshot", authoritativeSnapshotIntervalMs, {
      nowMs: startMs,
      intervalMs: authoritativeSnapshotIntervalMs,
    });
  }
  if (assetSyncIntervalMs > 0 && !scheduler.hasModule("assetSync")) {
    scheduler.defer("assetSync", assetSyncIntervalMs, {
      nowMs: startMs,
      intervalMs: assetSyncIntervalMs,
    });
  }
  const onlineHeartTickIntervalMs = getOnlineHeartTickIntervalMs();
  if (!scheduler.hasModule("onlineHeartbeat")) {
    scheduler.defer("onlineHeartbeat", 0, {
      nowMs: startMs,
      intervalMs: onlineHeartTickIntervalMs,
    });
  }
  let lastCustomerOrderGenerationAttemptAtMs = 0;
  while (nowFn() < endMs) {
    await throwIfAutomationStopped(options);
    const nowMs = nowFn();
    const remainingMs = Math.max(0, endMs - nowMs);
    const heartDueInMs = scheduler.dueInMs("onlineHeartbeat", {
      intervalMs: onlineHeartTickIntervalMs,
      nowMs,
    });
    const authorityDueInMs = authoritativeSnapshotIntervalMs > 0
      ? scheduler.dueInMs("authoritativeSnapshot", { intervalMs: authoritativeSnapshotIntervalMs, nowMs })
      : Infinity;
    const assetSyncDueInMs = assetSyncIntervalMs > 0
      ? scheduler.dueInMs("assetSync", { intervalMs: assetSyncIntervalMs, nowMs })
      : Infinity;
    const customerGenerationStatus = getCustomerOrderGenerationStatus(next, {
      nowMs,
      timeAuthority: options.timeAuthority,
    });
    customerOrderScheduler.observeSync({
      nextGenTimeMs: customerGenerationStatus.nextGenTimeMs,
      nextGenTimeInvalid: customerGenerationStatus.nextGenTimeInvalid,
      nowMs: customerGenerationStatus.nowMs,
    });
    const customerOrderDueInMs = isCustomerOrderGenerationDuringWaitEnabled()
      ? customerOrderScheduler.dueInMs({
        actionTime: customerGenerationStatus,
        nowMs: customerGenerationStatus.nowMs,
        clockSource: customerGenerationStatus.clockSource,
        timeTrusted: customerGenerationStatus.timeTrusted,
        allowInitialGeneration: !customerOrderScheduler.snapshot().hasGenerated,
      })
      : Infinity;
    const waitMs = Math.min(
      remainingMs,
      heartDueInMs,
      authorityDueInMs,
      assetSyncDueInMs,
      customerOrderDueInMs,
    );
    if (waitMs > 0 || remainingMs <= 0) {
      await waitForAutomationDelay(waitMs, {
        ...options,
        waitFn,
        delayNowFn: nowFn,
      });
    }
    await throwIfAutomationStopped(options);
    const afterWaitMs = nowFn();
    if (afterWaitMs >= endMs) break;

    if (scheduler.isDue("onlineHeartbeat", {
      intervalMs: onlineHeartTickIntervalMs,
      nowMs: afterWaitMs,
    })) {
      const heart = await scheduler.runDue("onlineHeartbeat", {
        intervalMs: onlineHeartTickIntervalMs,
        nowMs: afterWaitMs,
        task: () => refreshOnlineState(ws, gsToken, next, "loopHeartTick", {
          nowMs: afterWaitMs,
          force: true,
        }),
      });
      if (heart.ran) next = heart.value;
    }

    let businessRefreshRan = false;
    const afterWaitGenerationStatus = getCustomerOrderGenerationStatus(next, {
      nowMs: afterWaitMs,
      timeAuthority: options.timeAuthority,
    });
    customerOrderScheduler.observeSync({
      nextGenTimeMs: afterWaitGenerationStatus.nextGenTimeMs,
      nextGenTimeInvalid: afterWaitGenerationStatus.nextGenTimeInvalid,
      nowMs: afterWaitGenerationStatus.nowMs,
    });
    const shouldGenerateCustomerOrderNow = isCustomerOrderGenerationDuringWaitEnabled()
      && customerOrderScheduler.dueInMs({
        actionTime: afterWaitGenerationStatus,
        nowMs: afterWaitGenerationStatus.nowMs,
        clockSource: afterWaitGenerationStatus.clockSource,
        timeTrusted: afterWaitGenerationStatus.timeTrusted,
        allowInitialGeneration: !customerOrderScheduler.snapshot().hasGenerated,
      }) <= 0;
    if (shouldGenerateCustomerOrderNow) {
      lastCustomerOrderGenerationAttemptAtMs = afterWaitMs;
      try {
        const generationResult = await customerOrderRefresher(
          ws,
          gsToken,
          next,
          "customerOrderGenDuringWait",
          {
            flowerNames,
            nowFn,
            customerOrderScheduler,
            returnGenerationResult: true,
            ...(Object.hasOwn(options, "orderCustomerNpcConfig")
              ? { orderCustomerNpcConfig: options.orderCustomerNpcConfig }
              : {}),
            ...(Object.hasOwn(options, "flowerArtConfig")
              ? { flowerArtConfig: options.flowerArtConfig }
              : {}),
          },
        );
        const generatedSync = generationResult?.syncValue || generationResult;
        next = generatedSync;
        businessRefreshRan = true;
        if (generationResult?.generated) {
          const processResult = await customerOrderProcessor(
            ws,
            gsToken,
            next,
            options.cycle ?? null,
            options.teamOrderRuntime || null,
            {
              ...options,
              flowerNames,
              nowFn,
              customerOrderScheduler,
              customerOrderGenerationAtMs: generationResult.generationAtMs,
            },
          );
          next = processResult?.syncValue || processResult || next;
          ws.observeSync(next, {
            cycle: options.cycle ?? null,
            customerOrderScheduler: customerOrderScheduler.snapshot(),
          });
          console.log(JSON.stringify({
            step: "customerOrderGenerationToAction",
            cycle: options.cycle ?? null,
            generatedOrderCount: generationResult.generatedOrderCount ?? 0,
            generationAtMs: generationResult.generationAtMs ?? null,
            firstActionAtMs: customerOrderScheduler.snapshot().firstActionAtMs,
            generationToFirstActionMs: customerOrderScheduler.snapshot().generationToFirstActionMs,
            generationToFirstActionRequestStartMs: customerOrderScheduler.snapshot().generationToFirstActionMs,
            latencyMetricBasis: customerOrderScheduler.snapshot().latencyMetricBasis,
            actionCount: processResult?.actionCount ?? 0,
            customerOrderScheduler: customerOrderScheduler.snapshot(),
          }));
          console.log(JSON.stringify({
            step: "customerOrderGenerationWaitReturnedEarly",
            cycle: options.cycle ?? null,
            reason: "generated-order-processed",
            returnedAtMs: nowFn(),
            generationAtMs: generationResult.generationAtMs ?? null,
            latencyMetricBasis: customerOrderScheduler.snapshot().latencyMetricBasis,
            customerOrderScheduler: customerOrderScheduler.snapshot(),
          }));
          return next;
        }
      } catch (err) {
        if (isSessionExpiredError(err) || isWsRequestTimeoutError(err) || isUserStoppedError(err)) throw err;
        console.log(JSON.stringify({
          step: "customerOrderGenDuringWaitError",
          cycle: options.cycle ?? null,
          category: customerOrderGenerationErrorCategory(err),
          message: err.message,
        }));
      }
    }

    let authoritativeSnapshotRan = false;
    if (
      authoritativeSnapshotIntervalMs > 0
      && scheduler.isDue("authoritativeSnapshot", {
        intervalMs: authoritativeSnapshotIntervalMs,
        nowMs: afterWaitMs,
      })
    ) {
      try {
        next = await scheduler.getAuthoritativeSnapshot({
          currentValue: next,
          intervalMs: authoritativeSnapshotIntervalMs,
          nowMs: afterWaitMs,
          refresher: (current) => statusRefresher(
            ws,
            gsToken,
            current,
            "loopAuthoritativeSnapshot",
          ),
        });
        authoritativeSnapshotRan = true;
        businessRefreshRan = true;
        ws.observeSync(next, { cycle: options.cycle ?? null });
        const growth = await growthHandler(
          ws,
          gsToken,
          next,
          "loopTimeCriticalGrowth",
          options,
        );
        next = mergeAccountGatewaySync(growth.syncValue, ws.getSyncValue());
      } catch (err) {
        rethrowGlobalAutomationError(err);
        const summary = {
          ...(options.summary || {}),
          accountScheduler: scheduler.snapshot(),
          customerOrderScheduler: customerOrderScheduler.snapshot(),
          loopError: err.message,
          loopErrorAt: formatDateTime(new Date(afterWaitMs)),
        };
        console.log(JSON.stringify({
          step: "loopStatusRefreshError",
          cycle: options.cycle ?? null,
          message: err.message,
        }));
        statusWriter(next, {
          step: "loopStatusRefreshError",
          cycle: options.cycle ?? null,
          summary,
          flowerNames,
          log: false,
        });
      }
    }

    if (
      assetSyncIntervalMs > 0
      && scheduler.isDue("assetSync", { intervalMs: assetSyncIntervalMs, nowMs: afterWaitMs })
    ) {
      if (authoritativeSnapshotRan) {
        scheduler.markRun("assetSync", {
          atMs: afterWaitMs,
          intervalMs: assetSyncIntervalMs,
        });
      } else {
        try {
          const assetSync = await scheduler.runDue("assetSync", {
            intervalMs: assetSyncIntervalMs,
            nowMs: afterWaitMs,
            task: () => assetSyncRefresher(ws, gsToken, next, "assetSync"),
          });
          if (assetSync.ran) {
            next = assetSync.value;
            businessRefreshRan = true;
          }
        } catch (err) {
          if (isSessionExpiredError(err) || isWsRequestTimeoutError(err) || isUserStoppedError(err)) throw err;
          console.log(JSON.stringify({
            step: "assetSyncError",
            cycle: options.cycle ?? null,
            message: err.message,
          }));
        }
      }
    }

    if (businessRefreshRan) {
      try {
        await statusWriter(next, {
          step: authoritativeSnapshotRan ? "loopStatusRefresh" : "loopStatusProjection",
          cycle: options.cycle ?? null,
          statusMode: "loop-refresh",
          summary: {
            ...(options.summary || {}),
            accountScheduler: scheduler.snapshot(),
            customerOrderScheduler: customerOrderScheduler.snapshot(),
          },
          flowerNames,
          log: false,
        });
      } catch (err) {
        rethrowGlobalAutomationError(err);
        const summary = {
          ...(options.summary || {}),
          customerOrderScheduler: customerOrderScheduler.snapshot(),
          loopError: err.message,
          loopErrorAt: formatDateTime(new Date(afterWaitMs)),
        };
        console.log(JSON.stringify({
          step: "loopStatusRefreshError",
          cycle: options.cycle ?? null,
          message: err.message,
        }));
        statusWriter(next, {
          step: "loopStatusRefreshError",
          cycle: options.cycle ?? null,
          summary,
          flowerNames,
          log: false,
        });
      }
    }
  }
  ws.observeSync(next, { cycle: options.cycle ?? null });
  return next;
}

function getCustomerOrderGenerationDuringWaitRetryIntervalMs() {
  const seconds = toFiniteNumber(process.env.CUSTOMER_ORDER_GEN_DURING_WAIT_RETRY_SECONDS, 30);
  return Math.max(1, seconds ?? 30) * 1000;
}

function isCustomerOrderGenerationDuringWaitEnabled() {
  return process.env.AUTO_SUBMIT_CUSTOMER_ORDERS !== "0"
    && process.env.CUSTOMER_ORDER_GEN_BEFORE_ACTION !== "0"
    && process.env.CUSTOMER_ORDER_GEN_DURING_WAIT !== "0";
}

function getCustomerOrderGenerationDuringWaitDueInMs(syncValue, nowMs, lastAttemptAtMs = 0, retryIntervalMs = 30_000) {
  if (!isCustomerOrderGenerationDuringWaitEnabled()) return Infinity;
  const nextGenTimeMs = getCustomerOrderNextGenTimeMs(syncValue);
  if (!nextGenTimeMs) return Infinity;
  const nextAllowedAttemptAtMs = lastAttemptAtMs ? lastAttemptAtMs + retryIntervalMs : 0;
  return Math.max(0, nextGenTimeMs + 1001 - nowMs, nextAllowedAttemptAtMs - nowMs);
}

function shouldGenerateCustomerOrdersDuringWait(syncValue, nowMs, lastAttemptAtMs = 0, retryIntervalMs = 30_000) {
  return getCustomerOrderGenerationDuringWaitDueInMs(syncValue, nowMs, lastAttemptAtMs, retryIntervalMs) <= 0;
}

async function finalizeUserStopped(syncValue, teamOrderRuntime, options = {}) {
  if (typeof teamOrderRuntime?.finalizeUserStop === "function") {
    await teamOrderRuntime.finalizeUserStop(syncValue);
  } else {
    teamOrderRuntime?.requestStop("user-stop");
    await teamOrderRuntime?.flush();
  }
  writeStatusDocuments(syncValue, {
    step: "userStopped",
    cycle: options.cycle ?? null,
    summary: buildAutomationStoppedSummary(createUserStoppedError(), {
      cycle: options.cycle ?? null,
      step: "userStopped",
    }),
  });
  clearStatusDocumentContextCache(process.env.STATUS_JSON_PATH || path.join(
    process.env.STATUS_DOC_DIR || "outputs",
    "garden-status.json",
  ));
}

function getTeamOrderUserId(syncValue) {
  return String(
    syncValue?.$usrTot?.data?.id
      ?? syncValue?.$usrTot?.usr?.id
      ?? syncValue?.usrTot?.data?.id
      ?? syncValue?.usrTot?.usr?.id
      ?? "unknown",
  );
}

function getCustomerOrderAccountId(syncValue, options = {}) {
  const explicitId = options.customerOrderAccountId || options.profileId || process.env.PROFILE_ID;
  if (explicitId != null && String(explicitId).trim()) return String(explicitId).trim();
  const syncId = getTeamOrderUserId(syncValue);
  return syncId && syncId !== "unknown" ? syncId : null;
}

function loadCustomerOrderFlowerCurrencyHistoryContext(syncValue, options = {}) {
  const historyPath = resolveCustomerOrderFlowerCurrencyHistoryPath({
    historyPath: options.customerOrderFlowerCurrencyHistoryPath
      || process.env.CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_PATH,
    statusDir: options.statusDir || process.env.STATUS_DOC_DIR || "outputs",
  });
  const history = loadCustomerOrderFlowerCurrencyHistory(historyPath);
  return getAccountCustomerOrderFlowerCurrencyHistory(
    history,
    getCustomerOrderAccountId(syncValue, options),
  );
}

function createTeamOrderSessionRuntime(syncValue, options = {}) {
  const connection = {
    ws: null,
    gsToken: null,
  };
  const uid = getTeamOrderUserId(syncValue);
  const profileId = String(options.profileId || process.env.PROFILE_ID || uid || "default");
  let config = null;
  let configError = null;
  let fatalError = null;
  if (options.teamOrderConfig) {
    config = options.teamOrderConfig;
  } else {
    try {
      config = loadTeamOrderConfig();
    } catch (err) {
      configError = err;
    }
  }
  let latestSyncValue = syncValue;
  let latestContext = {};
  let activeArchiveIdentityKey = null;
  let activeArchiveState = null;
  const pendingArchiveStates = new Map();
  const archiveStatusDir =
    options.statusDir || process.env.STATUS_DOC_DIR || "outputs";
  const archiveFactory =
    options.createTeamOrderArchive || createTeamOrderArchive;
  const experienceSettlementConfig =
    options.experienceConfig || loadExperienceSettlementConfig();
  const teamOrderExperienceHistoryPath =
    options.teamOrderExperienceHistoryPath
    || path.join(path.resolve(String(archiveStatusDir)), "team-order-experience-history.json");
  let teamOrderExperienceHistory =
    loadTeamOrderExperienceHistory(teamOrderExperienceHistoryPath);
  let teamOrderReservation = null;
  let settledTeamExperienceDelta = null;
  const readExperienceGuardThresholdPercent = () => {
    const configured = typeof options.getExperienceGuardThresholdPercent === "function"
      ? options.getExperienceGuardThresholdPercent()
      : getExperienceGuardThresholdPercent();
    return isValidExperienceGuardThresholdPercent(configured)
      ? configured
      : DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT;
  };
  const readTeamOrderGuardMultiplier = () => {
    const configured = typeof options.getTeamOrderGuardMultiplier === "function"
      ? options.getTeamOrderGuardMultiplier()
      : getTeamOrderGuardMultiplier();
    return isValidTeamOrderGuardMultiplier(configured)
      ? configured
      : DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER;
  };

  const reservationMatchesAction = (reservation, action) => (
    reservation?.triggerIface === (action?.iface ?? null)
    && JSON.stringify(reservation?.triggerArgs ?? null)
      === JSON.stringify(action?.args ?? null)
  );

  const releaseTeamOrderReservation = (reason) => {
    if (!teamOrderReservation) return null;
    const released = {
      teamOrderReservationId: teamOrderReservation.id,
      reason,
    };
    teamOrderReservation = null;
    settledTeamExperienceDelta = null;
    logStructured({
      step: "teamOrderExperienceReservationReleased",
      profileId,
      accountId: uid,
      ...released,
    });
    return released;
  };

  const cancelTriggerReservation = (
    action,
    reason = "resident-order-trigger-cancelled",
  ) => {
    if (!teamOrderReservation) return null;
    const reservationId =
      action?.teamTriggerDecision?.teamOrderReservationId ?? null;
    if (
      reservationId !== teamOrderReservation.id
      || !reservationMatchesAction(teamOrderReservation, action)
    ) {
      return null;
    }
    return releaseTeamOrderReservation(reason);
  };

  const getCurrentAccountHistory = () => getAccountTeamOrderExperienceHistory(
    teamOrderExperienceHistory,
    uid,
  );

  const getOrCreateTeamOrderReservation = (decision, currentSync, action = null) => {
    if (decision?.blocked !== false) return null;
    if (teamOrderReservation) return teamOrderReservation;
    const order = currentSync?.orderTeamTot?.orderTeam || {};
    settledTeamExperienceDelta = null;
    teamOrderReservation = {
      id: `team-exp-${profileId}-${crypto.randomUUID()}`,
      profileId,
      accountId: uid,
      createdAt: new Date().toISOString(),
      coldStartBypass: decision.coldStartBypass === true,
      accountHistoricalMaxTeamExp:
        decision.accountHistoricalMaxFinalExp ?? null,
      teamOrderGuardExp: decision.teamOrderGuardExp ?? null,
      triggeringResidentOrderMaxExp:
        decision.triggeringResidentOrderMaxExp ?? null,
      triggerIface: action?.iface ?? null,
      triggerArgs: action?.args ?? null,
      triggerDecision: null,
      orderStartTime: order.startTime ?? null,
    };
    return teamOrderReservation;
  };

  const evaluateExperienceTrigger = (
    currentSync,
    action = {},
    thresholdPercent = readExperienceGuardThresholdPercent(),
  ) => {
    if (teamOrderReservation?.triggerDecision) {
      const sameAction = reservationMatchesAction(teamOrderReservation, action);
      if (!sameAction) {
        const mismatch = {
          blocked: true,
          coldStartBypass: false,
          forceTriggerProtectionEnabled: true,
          reason: "team-trigger-reservation-action-mismatch",
          teamOrderReservationId: teamOrderReservation.id,
          triggerDecisionReused: false,
        };
        logStructured({
          step: "teamOrderExperienceTriggerDecisionBlocked",
          profileId,
          accountId: uid,
          iface: action?.iface ?? null,
          blocked: true,
          reason: mismatch.reason,
          teamOrderReservationId: teamOrderReservation.id,
        });
        return mismatch;
      }
      const reused = {
        ...teamOrderReservation.triggerDecision,
        teamOrderReservationId: teamOrderReservation.id,
        triggerDecisionReused: true,
      };
      logStructured({
        step: "teamOrderExperienceTriggerDecisionReused",
        profileId,
        accountId: uid,
        iface: action?.iface ?? null,
        blocked: reused.blocked,
        reason: reused.reason,
        teamOrderReservationId: teamOrderReservation.id,
      });
      return reused;
    }
    const accountLevel = summarizeAccountLevel(currentSync);
    const threshold = calculateExperienceGuardThreshold(
      accountLevel.requiredExp,
      thresholdPercent,
    );
    const estimate = estimateExperienceAction({
      iface: action?.iface,
      arg: action?.args || {},
      syncValue: currentSync,
      config: experienceSettlementConfig,
    });
    const history = getCurrentAccountHistory();
    const decision = evaluateTeamOrderTrigger({
      remainingLevelExp:
        accountLevel.currentExp != null && accountLevel.requiredExp != null
          ? accountLevel.requiredExp - accountLevel.currentExp
          : null,
      minimumRemainingExp: threshold.thresholdRemainingExp,
      triggeringResidentOrderMaxExp:
        estimate.known === true ? estimate.maxExp : null,
      triggerProtectionEnabled: getTeamOrderTriggerProtectionEnabled(),
      history,
      guardMultiplier: readTeamOrderGuardMultiplier(),
    });
    const result = {
      ...decision,
      triggeringResidentOrderMaxExp:
        estimate.known === true ? estimate.maxExp : null,
      predictionSource: estimate.source,
      predictedMinExp: estimate.minExp,
      predictedMaxExp: estimate.maxExp,
      thresholdPercent: threshold.thresholdPercent,
      thresholdRemainingExp: threshold.thresholdRemainingExp,
      protectionLimitExp: threshold.protectionLimitExp,
      remainingLevelExp:
        accountLevel.currentExp != null && accountLevel.requiredExp != null
          ? accountLevel.requiredExp - accountLevel.currentExp
          : null,
    };
    const reservation = getOrCreateTeamOrderReservation(result, currentSync, action);
    if (reservation) {
      result.teamOrderReservationId = reservation.id;
      result.triggerDecisionReused = false;
      reservation.triggerDecision = { ...result };
    }
    logStructured({
      step: "teamOrderExperienceTriggerDecision",
      profileId,
      accountId: uid,
      iface: action?.iface ?? null,
      blocked: result.blocked,
      reason: result.reason,
      coldStartBypass: result.coldStartBypass,
      remainingLevelExp: result.remainingLevelExp,
      thresholdPercent: result.thresholdPercent,
      thresholdRemainingExp: result.thresholdRemainingExp,
      minimumRemainingExp: result.minimumRemainingExp ?? null,
      triggeringResidentOrderMaxExp: result.triggeringResidentOrderMaxExp,
      accountHistoricalMaxTeamExp:
        result.accountHistoricalMaxFinalExp ?? null,
      teamOrderGuardExp: result.teamOrderGuardExp,
      requiredExperienceSpace: result.requiredExperienceSpace,
      teamOrderReservationId: result.teamOrderReservationId ?? null,
    });
    return result;
  };

  const recordCompletedExperience = (beforeSync, afterSync, result = {}) => {
    if (
      result?.handled !== true
      || !["server-ended", "order-max-reached"].includes(result?.finalReason)
    ) {
      return null;
    }
    const beforeExp = summarizeAccountLevel(beforeSync).currentExp;
    const afterExp = summarizeAccountLevel(afterSync).currentExp;
    const levelExpDelta = Number.isFinite(beforeExp) && Number.isFinite(afterExp)
      ? afterExp - beforeExp
      : null;
    const actualExpDelta = settledTeamExperienceDelta > 0
      ? settledTeamExperienceDelta
      : levelExpDelta;
    if (!(actualExpDelta > 0)) {
      releaseTeamOrderReservation("team-order-completed-without-positive-experience");
      return null;
    }
    const nextHistory = recordCompletedTeamOrderExperience({
      history: teamOrderExperienceHistory,
      accountId: uid,
      actualExpDelta,
      completed: true,
      settlementStatus: "completed",
    });
    saveTeamOrderExperienceHistory(teamOrderExperienceHistoryPath, nextHistory);
    teamOrderExperienceHistory = nextHistory;
    const accountHistory = getCurrentAccountHistory();
    const record = {
      actualExpDelta,
      accountHistoricalMaxTeamExp:
        accountHistory?.accountHistoricalMaxFinalExp ?? null,
      teamOrderReservationId: teamOrderReservation?.id ?? null,
    };
    releaseTeamOrderReservation("team-order-completed");
    logStructured({
      step: "teamOrderExperienceHistoryUpdated",
      profileId,
      accountId: uid,
      ...record,
    });
    return record;
  };

  const currentTeamOrderArchiveIdentity = (currentSync) => {
    const order = currentSync?.orderTeamTot?.orderTeam;
    const validTime = (value) => {
      if (value instanceof Date) return Number.isFinite(value.getTime());
      if (typeof value === "number") return Number.isFinite(value);
      if (typeof value === "string") {
        const text = value.trim();
        return text.length > 0 && Number.isFinite(Date.parse(text));
      }
      return false;
    };
    const firstValidTime = (...values) => {
      for (const value of values) {
        if (validTime(value)) return value;
      }
      return null;
    };
    const nowMs = Date.now();
    const summary = summarizeTeamOrder(currentSync, { config, nowMs });
    const storedOrder = summary.effectiveStatus === 0
      ? selectEarliestStoredOrder(order?.storedOrders || null, nowMs)
      : null;
    const startTime = firstValidTime(
      order?.startTime,
      order?.activeTime,
      order?.cTime,
      storedOrder?.startTime,
    );
    const activeTime = firstValidTime(
      order?.activeTime,
      storedOrder?.activeTime,
    );
    const createdTime = firstValidTime(
      order?.cTime,
      storedOrder?.cTime,
      storedOrder?.createTime,
      storedOrder?.createdTime,
    );
    if (startTime == null) return null;
    return {
      profileId,
      uid,
      startTime,
      activeTime,
      createdTime,
    };
  };
  const archiveIdentityKey = (identity) => {
    if (!identity) return null;
    const keyPart = (value) => {
      if (value instanceof Date) return `date:${value.toISOString()}`;
      return `${typeof value}:${String(value ?? "")}`;
    };
    return JSON.stringify([
      keyPart(identity.profileId),
      keyPart(identity.uid),
      keyPart(identity.startTime),
    ]);
  };
  const activateArchiveIdentity = (identity) => {
    const identityKey = archiveIdentityKey(identity);
    if (identityKey === activeArchiveIdentityKey) return identityKey;
    if (
      activeArchiveState?.identityKey
      && activeArchiveState.finishValue
      && !activeArchiveState.finishSucceeded
    ) {
      pendingArchiveStates.set(
        activeArchiveState.identityKey,
        activeArchiveState,
      );
    }
    activeArchiveState = null;
    activeArchiveIdentityKey = identityKey;
    return identityKey;
  };
  const retryArchiveFinish = async (state) => {
    if (!state?.finishValue || state.finishSucceeded) return true;
    try {
      if (state.commitPayload) {
        await state.wrapper.commit(state.commitPayload);
      } else {
        await state.wrapper.finish(state.finishValue);
        await state.wrapper.flush();
      }
      return state.finishSucceeded;
    } catch (error) {
      logStructured({
        step: "teamOrderArchiveRecoveryFailed",
        profileId,
        runId: state.runId,
        phase: "active-finish",
        message: error?.message || String(error),
      });
      return false;
    }
  };
  const retryPendingArchiveFinishes = async () => {
    for (const [identityKey, state] of pendingArchiveStates) {
      await retryArchiveFinish(state);
      if (state.finishSucceeded) {
        pendingArchiveStates.delete(identityKey);
      }
    }
  };
  const recoverPersistedUserStoppedArchives = async ({
    excludeRunId = null,
  } = {}) => {
    const archiveDir = path.join(
      path.resolve(String(archiveStatusDir)),
      "team-orders",
    );
    let directory;
    try {
      directory = await fs.promises.opendir(archiveDir);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        logStructured({
          step: "teamOrderArchiveRecoveryFailed",
          profileId,
          runId: null,
          phase: "open-directory",
          message: error?.message || String(error),
        });
      }
      return;
    }

    try {
      for await (const entry of directory) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const ledgerPath = path.join(archiveDir, entry.name);
        let ledger;
        try {
          ledger = JSON.parse(await fs.promises.readFile(ledgerPath, "utf8"));
        } catch (error) {
          logStructured({
            step: "teamOrderArchiveRecoveryFailed",
            profileId,
            runId: null,
            phase: "read-ledger",
            message: error?.message || String(error),
          });
          continue;
        }

        const runId = String(ledger?.runId ?? "");
        const events = Array.isArray(ledger?.events) ? ledger.events : [];
        const terminalEvent = events.at(-1);
        if (
          runId === excludeRunId
          || entry.name !== `${runId}.json`
          || String(ledger?.profileId ?? "") !== profileId
          || String(ledger?.uid ?? "") !== uid
          || ledger?.finishedAt
          || terminalEvent?.reason !== "user-stopped"
        ) {
          continue;
        }

        try {
          const archive = archiveFactory({
            statusDir: archiveStatusDir,
            profileId: ledger.profileId,
            uid: ledger.uid,
            runId,
            label: ledger.label ?? "",
            serverIdx: ledger.serverIdx ?? "",
          });
          await archive.start({
            trigger: ledger.trigger ?? "user-stop-recovery",
            initialOrderNum: ledger.initialOrderNum ?? null,
          });
          await archive.finish({
            finalStatus: "user-stopped",
            finalOrderNum:
              terminalEvent.orderNumAfter
              ?? ledger.finalOrderNum
              ?? ledger.initialOrderNum
              ?? null,
            multiplier: ledger.multiplier ?? null,
            reward: ledger.reward ?? null,
            stopReason: "用户停止",
          });
          await archive.flush();
          if (activeArchiveState?.runId === runId) {
            activeArchiveState.finishSucceeded = true;
          }
        } catch (error) {
          logStructured({
            step: "teamOrderArchiveRecoveryFailed",
            profileId,
            runId,
            phase: "finish-ledger",
            message: error?.message || String(error),
          });
        }
      }
    } finally {
      await directory.close().catch(() => {});
    }
  };

  const rememberFatalError = (err) => {
    if (isSessionExpiredError(err) || isWsRequestTimeoutError(err) || isExperienceGuardError(err)) {
      fatalError ||= err;
    }
  };

  const runner = createTeamOrderRunner({
    profileId,
    uid,
    request: async (iface, args, label, requestOptions = {}) => {
      try {
        const response = await requestSync(
          connection.ws,
          connection.gsToken,
          iface,
          args,
          label,
          requestOptions,
        );
        if (iface === "gs.orderTeam.recvRwd" && !response.errMsg) {
          const experienceDelta = extractResponseItemDelta(
            response.value,
            ITEM_IDS.EXPERIENCE,
          );
          if (experienceDelta > 0) {
            settledTeamExperienceDelta = Math.max(
              settledTeamExperienceDelta || 0,
              experienceDelta,
            );
          }
        }
        return response;
      } catch (err) {
        rememberFatalError(err);
        if (fatalError === err) throw err;
        return {
          value: null,
          dsName: err?.dsName ?? null,
          errMsg: err?.errMsg ?? err?.message ?? String(err),
        };
      }
    },
    mergeSync: mergeLandSync,
    refreshTruth: async (currentSync, label, requestOptions = {}) => {
      try {
        return await refreshLazySync(
          connection.ws,
          connection.gsToken,
          currentSync,
          label,
          { ...requestOptions, log: false },
        );
      } catch (err) {
        rememberFatalError(err);
        throw err;
      }
    },
    createArchive: (identity) => {
      const runId = createTeamOrderRunId(identity);
      const identityKey = activateArchiveIdentity(identity);
      if (activeArchiveState?.identityKey === identityKey) {
        return activeArchiveState.wrapper;
      }
      const archive = archiveFactory({
        statusDir: archiveStatusDir,
        profileId: identity.profileId,
        uid: identity.uid,
        runId,
        label: process.env.PROFILE_NAME || "",
        serverIdx: latestSyncValue?.$loginServerIdx ?? "",
      });
      const state = {
        archive,
        identityKey,
        runId,
        finishSucceeded: false,
        finishValue: null,
        commitPayload: null,
        userStoppedAppendSucceeded: false,
        wrapper: null,
      };
      state.wrapper = {
        async commit(payload) {
          const finishValue =
            payload?.result?.stopReason === "user-stop"
              ? {
                  ...payload.result,
                  finalStatus: "user-stopped",
                  stopReason: "用户停止",
                }
              : payload?.result;
          const events = Array.isArray(payload?.events)
            ? payload.events.map((event) => (
                event?.reason === "user-stop"
                  ? {
                      ...event,
                      status: "user-stopped",
                      reason: "user-stopped",
                      message: "用户停止",
                    }
                  : event
              ))
            : payload?.events;
          const commitPayload = {
            ...payload,
            events,
            result: finishValue,
          };
          state.finishValue = finishValue;
          state.commitPayload = commitPayload;
          if (state.finishSucceeded) return undefined;
          const result = await archive.commit(commitPayload);
          state.finishSucceeded = true;
          pendingArchiveStates.delete(state.identityKey);
          return result;
        },
        start: (value) => archive.start(value),
        async append(value) {
          if (value?.reason !== "user-stop") {
            return archive.append(value);
          }
          if (state.userStoppedAppendSucceeded) return undefined;
          const result = await archive.append({
            ...value,
            status: "user-stopped",
            reason: "user-stopped",
            message: "用户停止",
          });
          state.userStoppedAppendSucceeded = true;
          return result;
        },
        async finish(value) {
          const finishValue =
            value?.stopReason === "user-stop"
              ? {
                  ...value,
                  finalStatus: "user-stopped",
                  stopReason: "用户停止",
                }
              : value;
          state.finishValue = finishValue;
          if (state.finishSucceeded) return undefined;
          const result = await archive.finish(finishValue);
          state.finishSucceeded = true;
          return result;
        },
        flush: () => archive.flush(),
      };
      activeArchiveState = state;
      return state.wrapper;
    },
    nowMs: () => Date.now(),
    monotonicMs: () => performance.now(),
    sleep: wait,
    signal: options.signal || null,
    onStatus: options.onTeamOrderStatus,
    shouldStop: async () => {
      if (fatalError) return { reason: "fatal-error" };
      try {
        await throwIfAutomationStopped(options);
        return null;
      } catch (error) {
        if (isUserStoppedError(error)) return { reason: "user-stop" };
        throw error;
      }
    },
  });
  const onAbort = () => runner.requestStop("user-stop");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  return {
    runner,
    signal: options.signal || null,
    bind(ws, gsToken) {
      connection.ws = ws;
      connection.gsToken = gsToken;
      runner.setOfficialTeamOrderActionLockHandled?.(
        isAccountCommandGateway(ws),
      );
    },
    capability(currentSync) {
      const teamOrderTriggerProtectionEnabled =
        getTeamOrderTriggerProtectionEnabled();
      const teamOrderPaidRenewProtectionEnabled =
        getTeamOrderPaidRenewProtectionEnabled();
      const accountHistory = getCurrentAccountHistory();
      const accountLevel = summarizeAccountLevel(currentSync);
      const thresholdPercent = readExperienceGuardThresholdPercent();
      const threshold = calculateExperienceGuardThreshold(
        accountLevel.requiredExp,
        thresholdPercent,
      );
      const requiresExperienceTriggerDecision =
        !teamOrderTriggerProtectionEnabled
        && accountHistory != null;
      const experienceFields = {
        teamOrderTriggerProtectionEnabled,
        teamOrderPaidRenewProtectionEnabled,
        teamOrderGuardMultiplier: readTeamOrderGuardMultiplier(),
        requiresExperienceTriggerDecision,
        thresholdPercent: threshold.thresholdPercent,
        thresholdRemainingExp: threshold.thresholdRemainingExp,
        protectionLimitExp: threshold.protectionLimitExp,
        minimumRemainingExp: threshold.thresholdRemainingExp,
        accountHistoricalMaxTeamExp:
          accountHistory?.accountHistoricalMaxFinalExp ?? null,
        teamOrderGuardExp:
          Number.isFinite(Number(accountHistory?.accountHistoricalMaxFinalExp))
            ? Number(accountHistory.accountHistoricalMaxFinalExp)
              * readTeamOrderGuardMultiplier()
            : null,
        teamOrderReservationId: teamOrderReservation?.id ?? null,
        evaluateTrigger: (action) => evaluateExperienceTrigger(
          currentSync,
          action,
          threshold.thresholdPercent,
        ),
      };
      if (process.env.AUTO_HANDLE_TEAM_ORDERS === "0") {
        return {
          ready: false,
          realValidated: false,
          enabled: false,
          ...experienceFields,
          reason: "disabled",
        };
      }
      if (configError) {
        return {
          ready: false,
          realValidated: false,
          enabled: true,
          configReady: false,
          ...experienceFields,
          reason: "config-load-failed",
          message: configError.message,
        };
      }
      return {
        ...evaluateTeamOrderCapability(currentSync, config, { schemas }),
        enabled: true,
        ...experienceFields,
      };
    },
    config,
    getPaidRenewProtectionEnabled() {
      return getTeamOrderPaidRenewProtectionEnabled();
    },
    takeFatalError() {
      const err = fatalError;
      fatalError = null;
      return err;
    },
    requestStop(reason = "user-stop") {
      runner.requestStop(reason);
    },
    archiveLifecycleState() {
      return {
        activeIdentityCount: activeArchiveState ? 1 : 0,
        pendingFinishCompensationCount: pendingArchiveStates.size,
        retainedArchiveStateCount:
          (activeArchiveState ? 1 : 0) + pendingArchiveStates.size,
      };
    },
    handle(currentSync, context = {}) {
      latestSyncValue = currentSync;
      latestContext = context;
      activateArchiveIdentity(currentTeamOrderArchiveIdentity(currentSync));
      return runner.handle(currentSync, context);
    },
    evaluateTrigger(currentSync, action) {
      return evaluateExperienceTrigger(currentSync, action);
    },
    cancelTriggerReservation,
    recordCompletedExperience,
    async finalizeUserStop(currentSync = latestSyncValue) {
      runner.requestStop("user-stop");
      const identity = currentTeamOrderArchiveIdentity(currentSync);
      const identityKey = activateArchiveIdentity(identity);
      await recoverPersistedUserStoppedArchives({
        excludeRunId: activeArchiveState?.runId ?? null,
      });
      await retryPendingArchiveFinishes();
      await retryArchiveFinish(activeArchiveState);
      if (
        currentSync?.orderTeamTot?.orderTeam != null
        && (
          !identityKey
          || activeArchiveState?.identityKey !== identityKey
          || !activeArchiveState.finishValue
        )
      ) {
        latestSyncValue = currentSync;
        await runner.handle(currentSync, {
          ...latestContext,
          trigger: latestContext.trigger || "user-stop",
          config,
          capability: latestContext.capability || { ready: true },
          experienceGuard: summarizeExperienceGuard(currentSync),
        });
      }
      await retryArchiveFinish(activeArchiveState);
      await runner.flush();
      await retryPendingArchiveFinishes();
      await recoverPersistedUserStoppedArchives();
    },
    async flush() {
      await runner.flush();
      await retryPendingArchiveFinishes();
      await recoverPersistedUserStoppedArchives();
      options.signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function handleTeamOrderCheckpoint(ws, gsToken, syncValue, context = {}) {
  const runtime = context.teamOrderRuntime
    || createTeamOrderSessionRuntime(syncValue, context);
  runtime.bind(ws, gsToken);
  const capability = runtime.capability(syncValue);
  if (!capability.ready) {
    logStructured({
      step: "teamOrderCapabilityBlocked",
      cycle: context.cycle ?? null,
      trigger: context.trigger || "unknown",
      capability,
    });
    if (capability.enabled !== false) {
      context.recordCycleError?.(
        "teamOrderCapabilityBlocked",
        new Error(capability.message || capability.reason || "team order capability blocked"),
      );
    }
    return { syncValue, capability, handled: false };
  }

  const handle = typeof runtime.handle === "function"
    ? runtime.handle.bind(runtime)
    : runtime.runner.handle.bind(runtime.runner);
  const settlementPollMs = Math.max(
    10,
    Math.floor(Number(context.teamOrderSettlementPollMs) || 100),
  );
  let currentSyncValue = syncValue;
  let result;
  do {
    result = await handle(currentSyncValue, {
      ...buildTeamOrderRunnerContext(currentSyncValue, runtime.config, context),
      config: runtime.config,
      capability,
      experienceGuard: summarizeExperienceGuard(currentSyncValue),
      getPaidRenewProtectionEnabled: () => (
        runtime.getPaidRenewProtectionEnabled?.() ?? true
      ),
      getPaidRenewExperienceGuard: (latestSync) => (
        summarizeExperienceGuard(latestSync)
      ),
    });
    const fatalError = runtime.takeFatalError();
    if (fatalError) throw fatalError;
    if (result.finalReason === "paid-renew-continued") {
      currentSyncValue = result.syncValue;
      continue;
    }
    if (result.finalReason !== "settlement-pending") break;
    currentSyncValue = result.syncValue;
    await waitForAutomationDelay(settlementPollMs, {
      signal: context.signal || runtime.signal || null,
      stopPath: context.stopPath,
      waitFn: context.waitFn,
      delayNowFn: context.delayNowFn,
    });
  } while (true);
  if (
    result.handled
    && ![
      "idle",
      "server-ended",
      "order-max-reached",
      "accepted",
      "restored",
      "settlement-pending",
    ].includes(result.finalReason)
  ) {
    context.recordCycleError?.(
      "teamOrderCheckpointError",
      new Error(`team order ${result.finalReason}`),
    );
  }
  runtime.recordCompletedExperience?.(syncValue, result.syncValue, result);
  return { ...result, capability };
}

function buildTeamOrderRunnerContext(syncValue, config, context = {}) {
  return {
    ...context,
    flowerNames: context.flowerNames || loadFlowerNameMap(),
    rewardItemNames: context.rewardItemNames || loadItemNameMap(),
    nobleExpAdd: context.nobleExpAdd ?? getTeamOrderNobleExpAdd(
      syncValue,
      config,
      { nowMs: Date.now() },
    ),
  };
}

async function autoSubmitSpecialOrders(
  ws,
  gsToken,
  syncValue,
  cycle = null,
  teamOrderRuntime = null,
  recordCycleError = null,
  options = {},
) {
  if (process.env.AUTO_SUBMIT_SPECIAL_ORDERS === "0") {
    console.log(JSON.stringify({ step: "specialOrderSubmitSkip", reason: "disabled" }));
    return { syncValue, submittedCount: 0, submittedActions: [], failedActions: [] };
  }

  const flowerNames = options.flowerNames || loadFlowerNameMap();
  let next = await refreshSpecialOrdersWhenRequired(
    ws,
    gsToken,
    syncValue,
    "specialOrderRefreshBeforeSubmit",
    options,
  );
  const actionTime = resolveResourceActionTime(next, options);
  const orderTimeOptions = { nowMs: actionTime.nowMs };
  const teamOrderCapability = teamOrderRuntime?.capability(next) || {
    ready: false,
    teamOrderTriggerProtectionEnabled: true,
  };
  let orderStatus = logOrderStatusParsed(next, {
    cycle,
    mode: process.env.ACTION || "once",
    phase: "beforeSubmit",
    teamOrderCapability,
    flowerNames,
    ...orderTimeOptions,
  });
  const actions = getAutoSubmitOrderActions(orderStatus, {
    teamOrderCapability,
  });
  console.log(JSON.stringify({
    step: "specialOrderSubmitPlan",
    cycle,
    rule: "submit only ready non-video/non-ad satin and decorate orders without advancing resident board total to 50/100",
    actions,
    skipped: ["satin", "decorate"]
      .filter((kind) => !actions.some((action) => action.kind === kind))
      .map((kind) => ({
        kind,
        status: orderStatus[kind]?.status,
        statusText: orderStatus[kind]?.statusText,
        completedCount: orderStatus[kind]?.completedCount,
        dailyLimit: orderStatus[kind]?.dailyLimit,
        dailyLimitReached: orderStatus[kind]?.dailyLimitReached,
        isVideo: orderStatus[kind]?.isVideo,
        canFinish: orderStatus[kind]?.canFinish,
      })),
  }, null, 2));

  const submittedActions = [];
  const failedActions = [];
  const attemptedKinds = new Set();
  const withSpecialOrderIdentity = (actions, status) => actions.map((action) => {
    const order = status?.[action.kind];
    const identity = specialOrderAuthorityIdentity(order);
    if (!identity) {
      return { ...action, specialOrderIdentity: null };
    }
    return {
      ...action,
      specialOrderIdentity: identity,
      specialOrderExpectation: {
        kind: action.kind,
        iface: action.iface,
        identity,
        nowMs: orderTimeOptions.nowMs,
      },
    };
  });
  const actionQueue = [...actions];
  const currentActionPlan = (excludeKinds = []) => {
    const capability = teamOrderRuntime?.capability(next) || teamOrderCapability;
    const status = summarizeOrderFlowerStatus(next, {
      nameMap: flowerNames,
      teamOrderCapability: capability,
      ...orderTimeOptions,
    });
    return {
      capability,
      status,
      actions: withSpecialOrderIdentity(
        getAutoSubmitOrderActions(status, {
          teamOrderCapability: capability,
          excludeKinds,
        }),
        status,
      ),
    };
  };
  for (let index = 0; index < actionQueue.length; index++) {
    actionQueue[index] = withSpecialOrderIdentity([actionQueue[index]], orderStatus)[0];
  }
  for (let idx = 0; idx < actionQueue.length; idx++) {
    let action = actionQueue[idx];
    const preflight = currentActionPlan([...attemptedKinds]);
    const currentAction = preflight.actions.find(
      (candidate) => candidate.kind === action.kind,
    );
    if (!currentAction) {
      teamOrderRuntime?.cancelTriggerReservation?.(
        action,
        "preflight-plan-changed",
      );
      console.log(JSON.stringify({
        step: "specialOrderSubmitSkip",
        cycle,
        kind: action.kind,
        reason: "preflight-plan-changed",
        teamOrderTriggerProtectionEnabled:
          preflight.capability.teamOrderTriggerProtectionEnabled !== false,
        teamOrderReady: preflight.status.residentBoard?.teamOrderReady === true,
      }));
      continue;
    }
    if (!action.specialOrderIdentity || !currentAction.specialOrderIdentity) {
      teamOrderRuntime?.cancelTriggerReservation?.(
        action,
        "preflight-authority-unproven",
      );
      console.log(JSON.stringify({
        step: "specialOrderSubmitSkip",
        cycle,
        kind: action.kind,
        reason: "preflight-authority-unproven",
      }));
      continue;
    }
    if (currentAction.specialOrderIdentity !== action.specialOrderIdentity) {
      teamOrderRuntime?.cancelTriggerReservation?.(
        action,
        "preflight-task-identity-changed",
      );
      console.log(JSON.stringify({
        step: "specialOrderSubmitSkip",
        cycle,
        kind: action.kind,
        reason: "preflight-task-identity-changed",
      }));
      continue;
    }
    action = currentAction;
    attemptedKinds.add(action.kind);
    let residentOrderRequestSucceeded = false;
    try {
      const rsp = await requestResidentOrderAction(
        ws,
        gsToken,
        action,
        `${action.kind} order submit failed`,
      );
      residentOrderRequestSucceeded = true;
      next = mergeLandSync(next, rsp.value);
      const checkpoint = await handleTeamOrderCheckpoint(ws, gsToken, next, {
        cycle,
        trigger: "special-order-submitted",
        sourceKind: action.kind,
        teamOrderRuntime,
        recordCycleError,
        flowerNames,
      });
      next = checkpoint.syncValue;
      submittedActions.push(action);
      console.log(JSON.stringify({
        step: "specialOrderSubmitted",
        cycle,
        kind: action.kind,
        iface: action.iface,
        dsName: rsp.dsName,
        err: null,
      }));
    } catch (err) {
      if (err?.code === "ACTION_AUTHORITY_REJECTED") {
        next = ws.getSyncValue?.() || next;
        teamOrderRuntime?.cancelTriggerReservation?.(
          action,
          err.authorityValidation?.reason || "final-authority-rejected",
        );
        console.log(JSON.stringify({
          step: "specialOrderSubmitSkip",
          cycle,
          kind: action.kind,
          reason: err.authorityValidation?.reason || "final-authority-rejected",
        }));
        continue;
      }
      if (!residentOrderRequestSucceeded) {
        teamOrderRuntime?.cancelTriggerReservation?.(
          action,
          "resident-order-request-failed",
        );
      }
      if (isSessionExpiredError(err) || isWsRequestTimeoutError(err) || isExperienceGuardError(err)) throw err;
      if (isExperienceActionBlockedError(err)) break;
      let failedAction = { ...action, error: err.message };
      const shortage = getItemShortageError(err);
      if (shortage) {
        const marked = markSpecialOrderStockRejection(
          next,
          action.kind,
          shortage.itemId,
          { code: shortage.code, ...orderTimeOptions },
        );
        if (marked !== next) {
          next = marked;
          const refreshed = await refreshSpecialOrderStockTruth(
            ws,
            gsToken,
            next,
            recordCycleError,
          );
          next = refreshed.syncValue;
          const rejectedStatus = summarizeOrderFlowerStatus(next, {
            nameMap: flowerNames,
            teamOrderCapability: teamOrderRuntime?.capability(next) || teamOrderCapability,
            ...orderTimeOptions,
          })[action.kind];
          failedAction = {
            ...failedAction,
            stockRejection: rejectedStatus?.stockRejection || {
              code: shortage.code,
              itemId: shortage.itemId,
            },
          };
          console.log(JSON.stringify({
            step: "specialOrderStockRejected",
            cycle,
            kind: action.kind,
            iface: action.iface,
            code: shortage.code,
            itemId: shortage.itemId,
            status: rejectedStatus?.status || null,
            statusText: rejectedStatus?.statusText || null,
            canFinish: rejectedStatus?.canFinish === true,
            stockRejection: rejectedStatus?.stockRejection || null,
            refreshError: refreshed.refreshError,
          }));
          orderStatus = logOrderStatusParsed(next, {
            cycle,
            mode: process.env.ACTION || "once",
            phase: "afterStockRejection",
            teamOrderCapability: teamOrderRuntime?.capability(next) || teamOrderCapability,
            flowerNames,
            ...orderTimeOptions,
          });
        }
      }
      failedActions.push(failedAction);
      console.log(JSON.stringify({
        step: "specialOrderSubmitFailed",
        cycle,
        kind: action.kind,
        iface: action.iface,
        message: err.message,
      }));
      if (!submittedActions.length) {
        const fallbackActions = currentActionPlan([...attemptedKinds]).actions
          .filter((candidate) => !actionQueue.slice(idx + 1).some((queued) => queued.kind === candidate.kind));
        if (fallbackActions.length) {
          actionQueue.push(fallbackActions[0]);
          console.log(JSON.stringify({
            step: "specialOrderSubmitFallbackPlan",
            cycle,
            failedKind: action.kind,
            fallbackKind: fallbackActions[0].kind,
            residentBoardTotalBefore: fallbackActions[0].residentBoardTotalBefore ?? null,
            residentBoardTotalAfter: fallbackActions[0].residentBoardTotalAfter ?? null,
            reason: "previous-special-order-failed-no-count-increase",
          }));
        }
      }
    }
  }

  if (submittedActions.length) {
    orderStatus = logOrderStatusParsed(next, {
      cycle,
      mode: process.env.ACTION || "once",
      phase: "afterSubmit",
      teamOrderCapability: teamOrderRuntime?.capability(next) || teamOrderCapability,
      flowerNames,
      ...orderTimeOptions,
    });
  }

  return {
    syncValue: next,
    submittedCount: submittedActions.length,
    submittedActions,
    failedActions,
    orderStatus,
  };
}

function getOrdinaryResidentPreflightActions(
  orderStatus,
  mainTaskStatus,
  teamOrderCapability,
  autoSubmitSetting,
  nowMs = Date.now(),
) {
  return getAutoSubmitOrderActions(orderStatus, {
    mainTaskStatus,
    teamOrderCapability,
    autoSubmitEnabled: autoSubmitSetting?.ordinaryAutoSubmitEnabled === true,
    bypassSpecialOrderDailyLimit:
      autoSubmitSetting?.bypassSpecialOrderDailyLimit === true,
  }).filter((action) => action.kind === "ordinary").map((action) => {
    const order = orderStatus?.ordinary?.orders?.find(
      (candidate) => Number(candidate.boxId) === Number(action.boxId),
    );
    const identity = ordinaryResidentOrderAuthorityIdentity(order);
    return {
      ...action,
      ordinaryOrderExpectation: identity ? {
        boxId: Number(action.boxId),
        identity,
        nowMs,
      } : null,
    };
  }).filter((action) => action.ordinaryOrderExpectation != null);
}

function getOrdinaryResidentOrderGateReason(orderStatus, actions, autoSubmitSetting) {
  if (autoSubmitSetting?.ordinaryAutoSubmitEnabled !== true) return "ordinary-auto-submit-disabled";
  if (actions.length > 0) return "ordinary-order-ready";
  if (orderStatus?.residentBoard?.pauseSpecialOrders) return "resident-board-team-trigger-protection";
  if (!orderStatus?.satin?.dailyLimitReached || !orderStatus?.decorate?.dailyLimitReached) {
    return "special-order-daily-limit-not-reached";
  }
  if ((orderStatus?.ordinary?.readyCount || 0) > 0) return "ordinary-order-conditions-blocked";
  return "ordinary-no-ready-order";
}

async function autoSubmitOrdinaryResidentOrders(
  ws,
  gsToken,
  syncValue,
  cycle = null,
  teamOrderRuntime = null,
  recordCycleError = null,
  options = {},
) {
  const flowerNames = options.flowerNames || loadFlowerNameMap();
  const autoSubmitSetting = options.cyclicNoteTargetOnly
    ? getCyclicNoteOrdinaryResidentAutoSubmitSetting()
    : getOrdinaryResidentAutoSubmitSetting();
  const initialActionTime = resolveResourceActionTime(syncValue, options);
  let next = syncValue;
  let mainTaskStatus = summarizeMainTaskStatus(next);
  const mainTaskStatusBefore = mainTaskStatus;
  if (autoSubmitSetting.ordinaryAutoSubmitEnabled !== true) {
    console.log(JSON.stringify({
      step: "ordinaryResidentOrderSubmitSkip",
      reason: autoSubmitSetting.reason || "ordinary-auto-submit-disabled",
      taskId: mainTaskStatus.taskId,
      taskType: mainTaskStatus.taskType,
      status: mainTaskStatus.status,
      progressText: mainTaskStatus.progressText,
      gateReason: "ordinary-auto-submit-disabled",
    }));
    return {
      syncValue: next,
      submittedCount: 0,
      submittedActions: [],
      failedActions: [],
      autoSubmitEnabled: false,
      ordinaryAutoSubmitEnabled: false,
      levelUpAutoSubmitEnabled: autoSubmitSetting.levelUpEnabled,
      mainTaskStatusBefore,
      mainTaskStatusAfter: mainTaskStatus,
      orderStatus: summarizeOrderFlowerStatus(next, {
        nameMap: flowerNames,
        nowMs: initialActionTime.nowMs,
      }),
    };
  }

  next = await refreshSpecialOrdersWhenRequired(
    ws,
    gsToken,
    next,
    "ordinaryResidentOrderRefreshBeforeSubmit",
    options,
  );
  const actionTime = resolveResourceActionTime(next, options);
  const orderTimeOptions = { nowMs: actionTime.nowMs };
  let teamOrderCapability = teamOrderRuntime?.capability(next) || {
    ready: false,
    teamOrderTriggerProtectionEnabled: true,
  };
  let orderStatus = logOrderStatusParsed(next, {
    cycle,
    mode: process.env.ACTION || "once",
    phase: "ordinaryResidentBeforeSubmit",
    teamOrderCapability,
    flowerNames,
    ...orderTimeOptions,
  });
  mainTaskStatus = summarizeMainTaskStatus(next);
  const submittedActions = [];
  const failedActions = [];
  const maxSteps = Math.max(1, Number(process.env.ORDINARY_RESIDENT_ORDER_MAX_STEPS_PER_CYCLE || 20));

  for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex++) {
    teamOrderCapability = teamOrderRuntime?.capability(next) || {
      ready: false,
      teamOrderTriggerProtectionEnabled: true,
    };
    orderStatus = summarizeOrderFlowerStatus(next, {
      nameMap: flowerNames,
      teamOrderCapability,
      ...orderTimeOptions,
    });
    const actions = getOrdinaryResidentPreflightActions(
      orderStatus,
      mainTaskStatus,
      teamOrderCapability,
      autoSubmitSetting,
      orderTimeOptions.nowMs,
    );
    console.log(JSON.stringify({
      step: "ordinaryResidentOrderSubmitPlan",
      cycle,
      ordinaryResidentStep: stepIndex,
      rule: autoSubmitSetting.singleSampleValidationEnabled
        ? "single-sample validation: one auto-loop cycle, one ordinary resident step, special/customer/palace/main-task/team and other configured handlers disabled; special daily-limit automation gate is explicitly bypassed"
        : "when the ordinary resident order auto-submit switch is enabled, submit ready non-video orders independent of main-task type, progress, and receive status; satin/decorate daily limits must both be reached",
      gateReason: getOrdinaryResidentOrderGateReason(orderStatus, actions, autoSubmitSetting),
      ordinaryAutoSubmitEnabled: autoSubmitSetting.ordinaryAutoSubmitEnabled,
      levelUpAutoSubmitEnabled: autoSubmitSetting.levelUpEnabled,
      singleSampleValidationEnabled:
        autoSubmitSetting.singleSampleValidationEnabled === true,
      specialDailyLimitBypassed:
        autoSubmitSetting.bypassSpecialOrderDailyLimit === true,
      mainTask: {
        taskId: mainTaskStatus.taskId,
        taskType: mainTaskStatus.taskType,
        status: mainTaskStatus.status,
        progressText: mainTaskStatus.progressText,
        remainingValue: mainTaskStatus.remainingValue,
        canProgressResidentOrderMainTask: mainTaskStatus.canProgressResidentOrderMainTask,
        canProgressLevelUpMainTask: mainTaskStatus.canProgressLevelUpMainTask,
        canSubmitOrdinaryResidentOrderForMainTask: mainTaskStatus.canSubmitOrdinaryResidentOrderForMainTask,
        legacyMainTaskOrderGateReason: mainTaskStatus.ordinaryResidentOrderGateReason,
      },
      satinDailyLimitReached: orderStatus.satin?.dailyLimitReached ?? false,
      decorateDailyLimitReached: orderStatus.decorate?.dailyLimitReached ?? false,
      readyOrdinaryCount: orderStatus.ordinary?.readyCount ?? 0,
      actions,
    }, null, 2));

    if (!actions.length) break;
    const action = actions[0];
    let residentOrderRequestSucceeded = false;
    try {
      const rsp = await requestResidentOrderAction(
        ws,
        gsToken,
        action,
        `${action.iface} failed`,
      );
      residentOrderRequestSucceeded = true;
      next = mergeLandSync(next, rsp.value);
      const orderFlowerConfig = loadOrderFlowerConfig(
        process.env.STATIC_CONFIG_PATH || getDefaultStaticConfigPath(),
      );
      next = markOrdinaryResidentOrderRefill(next, action.boxId, {
        ...orderTimeOptions,
        cooldownSeconds: orderFlowerConfig.orderCdSeconds,
      });
      const checkpoint = await handleTeamOrderCheckpoint(ws, gsToken, next, {
        cycle,
        trigger: "ordinary-resident-order-submitted",
        sourceKind: action.kind,
        teamOrderRuntime,
        recordCycleError,
        flowerNames,
      });
      next = checkpoint.syncValue;
      submittedActions.push(action);
      console.log(JSON.stringify({
        step: "ordinaryResidentOrderSubmitted",
        cycle,
        ordinaryResidentStep: stepIndex,
        iface: action.iface,
        args: action.args || {},
        boxId: action.boxId,
        taskId: action.taskId,
        reason: action.reason,
        gateReason: getOrdinaryResidentOrderGateReason(orderStatus, actions, autoSubmitSetting),
        dsName: rsp.dsName,
        err: null,
      }));
      next = await refreshLazySync(ws, gsToken, next, "ordinaryResidentOrderLazySyncAfterSubmit");
      teamOrderCapability = teamOrderRuntime?.capability(next) || {
        ready: false,
        teamOrderTriggerProtectionEnabled: true,
      };
      orderStatus = logOrderStatusParsed(next, {
        cycle,
        mode: process.env.ACTION || "once",
        phase: "ordinaryResidentAfterSubmit",
        ordinaryResidentStep: stepIndex,
        lastOrdinaryResidentAction: action,
        teamOrderCapability,
        flowerNames,
        ...orderTimeOptions,
      });
      mainTaskStatus = summarizeMainTaskStatus(next);
    } catch (err) {
      if (!residentOrderRequestSucceeded) {
        teamOrderRuntime?.cancelTriggerReservation?.(
          action,
          "resident-order-request-failed",
        );
      }
      if (isSessionExpiredError(err) || isWsRequestTimeoutError(err) || isExperienceGuardError(err)) throw err;
      if (isExperienceActionBlockedError(err)) break;
      failedActions.push({ ...action, message: err.message });
      console.log(JSON.stringify({
        step: "ordinaryResidentOrderSubmitFailed",
        cycle,
        ordinaryResidentStep: stepIndex,
        iface: action.iface,
        boxId: action.boxId,
        message: err.message,
      }));
      break;
    }
  }

  if (submittedActions.length >= maxSteps) {
    console.log(JSON.stringify({
      step: "ordinaryResidentOrderSubmitLimitReached",
      cycle,
      maxSteps,
      submittedCount: submittedActions.length,
    }));
  }

  return {
    syncValue: next,
    submittedCount: submittedActions.length,
    submittedActions,
    failedActions,
    autoSubmitEnabled: autoSubmitSetting.ordinaryAutoSubmitEnabled === true,
    ordinaryAutoSubmitEnabled: autoSubmitSetting.ordinaryAutoSubmitEnabled === true,
    levelUpAutoSubmitEnabled: autoSubmitSetting.levelUpEnabled,
    orderStatus,
    mainTaskStatusBefore,
    mainTaskStatusAfter: mainTaskStatus,
  };
}

async function refreshPalaceOrder(ws, gsToken, syncValue, label = "palaceOrderRefresh") {
  const rsp = await requestSync(ws, gsToken, ORDER_PALACE_IFACES.enter, {}, `${label} failed`);
  const next = mergeLandSync(syncValue, rsp.value);
  console.log(JSON.stringify({ step: label, iface: ORDER_PALACE_IFACES.enter, dsName: rsp.dsName, err: null }));
  return next;
}

function markPalaceOrderFinished(syncValue) {
  if (!syncValue || typeof syncValue !== "object") return syncValue;
  let out = syncValue;

  if (syncValue.orderPalaceTot?.orderPalace) {
    out = {
      ...out,
      orderPalaceTot: {
        ...out.orderPalaceTot,
        orderPalace: {
          ...out.orderPalaceTot.orderPalace,
          isFinish: true,
        },
      },
    };
  }

  if (syncValue.orderPalace) {
    out = {
      ...out,
      orderPalace: {
        ...out.orderPalace,
        isFinish: true,
      },
    };
  }

  return out;
}

async function autoSubmitPalaceOrders(ws, gsToken, syncValue, cycle = null, options = {}) {
  if (process.env.AUTO_SUBMIT_PALACE_ORDERS === "0") {
    console.log(JSON.stringify({ step: "palaceOrderSubmitSkip", reason: "disabled" }));
    return { syncValue, submittedCount: 0, submittedActions: [], failedActions: [] };
  }

  const flowerNames = options.flowerNames || loadFlowerNameMap();
  let next = await refreshPalaceOrder(ws, gsToken, syncValue, "palaceOrderRefreshBeforeSubmit");
  const actionTime = resolveResourceActionTime(next, options);
  const orderTimeOptions = { nowMs: actionTime.nowMs };
  let palaceStatus = summarizeOrderPalaceStatus(next, {
    nameMap: flowerNames,
    ...orderTimeOptions,
  });
  const actions = getAutoSubmitPalaceOrderActions(palaceStatus);
  console.log(JSON.stringify({
    step: "palaceOrderSubmitPlan",
    cycle,
    rule: "submit palace order only while double gold remaining is at least one minute and required flower stock is enough",
    status: {
      exists: palaceStatus.exists,
      status: palaceStatus.status,
      statusText: palaceStatus.statusText,
      actionText: palaceStatus.actionText,
      flowerId: palaceStatus.flowerId,
      flowerLabel: palaceStatus.flowerLabel,
      have: palaceStatus.have,
      need: palaceStatus.need,
      missing: palaceStatus.missing,
      doubleGoldGate: palaceStatus.doubleGoldGate,
    },
    actions,
  }, null, 2));

  const submittedActions = [];
  const failedActions = [];
  for (const action of actions) {
    const beforeActionSync = next;
    const localDeltas = action.flowerId && action.need
      ? [{ itemId: action.flowerId, delta: -Number(action.need || 0) }]
      : [];
    try {
      const rsp = await requestSync(ws, gsToken, action.iface, action.args || {}, `${action.iface} failed`);
      next = mergeLandSync(next, rsp.value);
      next = applyLocalItemDeltasForUnchanged(beforeActionSync, next, localDeltas);
      next = markPalaceOrderFinished(next);
      submittedActions.push(action);
      console.log(JSON.stringify({
        step: "palaceOrderSubmitted",
        cycle,
        iface: action.iface,
        flowerId: action.flowerId,
        need: action.need,
        haveBefore: action.have,
        dsName: rsp.dsName,
        err: null,
      }));
      next = await refreshLazySync(ws, gsToken, next, "palaceOrderLazySyncAfterSubmit");
      const afterLazySyncPatch = applyLocalItemDeltasForUnchanged(beforeActionSync, next, localDeltas);
      if (afterLazySyncPatch !== next) {
        next = afterLazySyncPatch;
        console.log(JSON.stringify({
          step: "palaceOrderLocalDeltasPreservedAfterLazySync",
          cycle,
          flowerId: action.flowerId,
          need: action.need,
        }));
      }
      next = markPalaceOrderFinished(next);
      palaceStatus = summarizeOrderPalaceStatus(next, {
        nameMap: flowerNames,
        ...orderTimeOptions,
      });
    } catch (err) {
      if (isSessionExpiredError(err) || isWsRequestTimeoutError(err) || isExperienceGuardError(err)) throw err;
      if (isExperienceActionBlockedError(err)) break;
      const shortage = parseItemShortageError(err);
      if (shortage) {
        next = setLocalItemCount(next, shortage.itemId, 0);
      }
      const failedAction = {
        ...action,
        error: err.message,
        ...(shortage ? { code: shortage.code, itemId: shortage.itemId } : {}),
      };
      failedActions.push(failedAction);
      console.log(JSON.stringify({
        step: "palaceOrderSubmitFailed",
        cycle,
        iface: action.iface,
        flowerId: action.flowerId,
        need: action.need,
        message: err.message,
        code: shortage?.code ?? null,
        itemId: shortage?.itemId ?? null,
        shortageRecovered: Boolean(shortage),
        err: shortage?.payload ?? null,
      }));
      palaceStatus = summarizeOrderPalaceStatus(next, {
        nameMap: flowerNames,
        ...orderTimeOptions,
      });
    }
  }

  return {
    syncValue: next,
    submittedCount: submittedActions.length,
    submittedActions,
    failedActions,
    palaceStatus,
  };
}

async function autoSubmitMainTasks(ws, gsToken, syncValue, cycle = null) {
  if (process.env.AUTO_SUBMIT_MAIN_TASKS === "0") {
    console.log(JSON.stringify({ step: "mainTaskSubmitSkip", reason: "disabled" }));
    return { syncValue, submittedCount: 0, submittedActions: [], failedActions: [] };
  }

  const maxSteps = Math.max(1, Number(process.env.MAIN_TASK_MAX_SUBMIT_PER_CYCLE || 10));
  let next = syncValue;
  const submittedActions = [];
  const failedActions = [];
  let mainTaskStatus = summarizeMainTaskStatus(next);

  for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex++) {
    const actions = getAutoSubmitMainTaskActions(mainTaskStatus);
    console.log(JSON.stringify({
      step: "mainTaskActionPlan",
      cycle,
      mainTaskStep: stepIndex,
      status: mainTaskStatus.status,
      statusText: mainTaskStatus.statusText,
      taskId: mainTaskStatus.taskId,
      curValue: mainTaskStatus.curValue,
      targetValue: mainTaskStatus.targetValue,
      progressText: mainTaskStatus.progressText,
      sourcePath: mainTaskStatus.sourcePath,
      actions,
    }));
    if (!actions.length) break;

    const action = actions[0];
    try {
      const rsp = await requestSync(ws, gsToken, action.iface, action.args || {}, `${action.iface} failed`);
      next = mergeLandSync(next, rsp.value);
      submittedActions.push(action);
      console.log(JSON.stringify({
        step: "mainTaskSubmitDone",
        cycle,
        mainTaskStep: stepIndex,
        iface: action.iface,
        args: action.args || {},
        taskId: action.taskId,
        curValue: action.curValue,
        targetValue: action.targetValue,
        reason: action.reason,
        dsName: rsp.dsName,
        err: null,
      }));
      next = await refreshLazySync(ws, gsToken, next, "mainTaskLazySyncAfterSubmit");
      mainTaskStatus = summarizeMainTaskStatus(next);
    } catch (err) {
      if (isSessionExpiredError(err) || isWsRequestTimeoutError(err) || isExperienceGuardError(err)) throw err;
      if (isExperienceActionBlockedError(err)) break;
      failedActions.push({ ...action, message: err.message });
      console.log(JSON.stringify({
        step: "mainTaskSubmitFailed",
        cycle,
        mainTaskStep: stepIndex,
        iface: action.iface,
        taskId: action.taskId,
        message: err.message,
      }));
      break;
    }
  }

  return {
    syncValue: next,
    submittedCount: submittedActions.length,
    submittedActions,
    failedActions,
    mainTaskStatus,
  };
}

async function runCyclicNoteTaskHandler(ws, gsToken, syncValue, cycle, target, route, options = {}) {
  const selectedRoute = route || target?.route;
  const targetWithRoute = target?.route === selectedRoute ? target : { ...target, route: selectedRoute };
  const customHandler = options.cyclicNoteTaskHandlers?.[selectedRoute]
    || options.cyclicNoteTaskHandler;
  if (typeof customHandler === "function") {
    return customHandler({ ws, gsToken, syncValue, cycle, target: targetWithRoute, options });
  }

  const remainingProgress = target?.target - target?.current;
  if (!Number.isSafeInteger(remainingProgress) || remainingProgress <= 0) {
    return { syncValue, actionCount: 0, reason: "invalid-remaining-progress" };
  }
  const routePolicy = getCyclicNoteNaturalRoutePolicy(selectedRoute);
  const handlerOptions = {
    ...options,
    ...(routePolicy || {}),
    cyclicNoteTargetOnly: true,
  };

  if (selectedRoute === "resident-order") {
    return autoSubmitOrdinaryResidentOrders(ws, gsToken, syncValue, cycle, null, null, handlerOptions);
  }
  if (selectedRoute === "pearl-hire") {
    return autoHandlePearl(ws, gsToken, syncValue, cycle, handlerOptions);
  }
  if (selectedRoute === "plant") {
    const state = getState(syncValue);
    const flowerId = state.recommendation.plantFlower?.flowerId;
    const candidate = flowerId
      ? getPlantLandGroupCandidates(syncValue, flowerId, new Map(), { forcedFlowerId: 0 })
        .find((item) => item.wholeGroupEmpty
          && getPlantLandGroupWindowDecision(syncValue, item, null).ok)
      : null;
    const water = getPlantWaterRefillContext(syncValue);
    const authoritativeWater = getAuthoritativeWaterDropCount(water);
    if (!candidate || authoritativeWater == null || authoritativeWater < candidate.requiredWaterCount) {
      return { syncValue, actionCount: 0, reason: "plant-target-blocked" };
    }
    return plantEmptyLands(
      ws,
      gsToken,
      syncValue,
      { emptyLandIds: candidate.emptyLandIds, plantFlower: { flowerId } },
      { maxPlantCount: candidate.emptyLandIds.length, preferSingle: true, noFallback: true },
    );
  }
  if (selectedRoute === "harvest") {
    return harvestMatureLands(ws, gsToken, syncValue);
  }
  if (selectedRoute === "water") {
    const seededGroup = getFirstSeededLandGroup(syncValue);
    if (!seededGroup) {
      return { syncValue, actionCount: 0, reason: "water-target-blocked" };
    }
    return waterSeededLandGroup(ws, gsToken, syncValue, seededGroup, {
      phase: "cyclicNoteNaturalWater",
    });
  }
  if (selectedRoute === "flower-rack-sell") {
    return autoHandleFlowerRack(ws, gsToken, syncValue, cycle, handlerOptions);
  }
  if (selectedRoute === "customer-order") {
    return autoSubmitCustomerOrders(ws, gsToken, syncValue, cycle, null, handlerOptions);
  }
  return { syncValue, actionCount: 0, reason: "unsupported-natural-route" };
}

async function autoHandleCyclicNote(ws, gsToken, syncValue, cycle = null, options = {}) {
  const naturalCompletion = getCyclicNoteNaturalCompletionSetting();
  const emptyResult = (status, currentSyncValue = syncValue) => ({
    syncValue: currentSyncValue,
    actionCount: 0,
    receivedCount: 0,
    failedCount: 0,
    actions: [],
    failedActions: [],
    status,
  });
  const initialStatus = summarizeCyclicNoteWithResourceActionTime(syncValue, options);
  if (!naturalCompletion.enabled) {
    console.log(JSON.stringify({
      step: "cyclicNoteSkip",
      cycle,
      reason: naturalCompletion.reason,
      phase: initialStatus.phase,
      batchId: initialStatus.batchId,
      timeTrusted: initialStatus.timeTrusted,
    }));
    return emptyResult(initialStatus);
  }
  const missingAuthoritativeRecord = [
    "missing-authoritative-task-record",
    "missing-authoritative-task-progress",
    "missing-authoritative-task-recv-map",
  ].includes(initialStatus.snapshotError);
  const canEnterToReadAuthoritativeRecord = missingAuthoritativeRecord
    && initialStatus.active === true
    && initialStatus.timeTrusted === true
    && isSafePositiveCyclicNoteBatchId(initialStatus.batchId);

  if (
    !initialStatus.exists
    || !initialStatus.active
    || initialStatus.timeTrusted !== true
    || !isSafePositiveCyclicNoteBatchId(initialStatus.batchId)
    || (initialStatus.executionSafe !== true && !canEnterToReadAuthoritativeRecord)
  ) {
    console.log(JSON.stringify({
      step: "cyclicNoteSkip",
      cycle,
      reason: initialStatus.snapshotError || initialStatus.reason || "cyclic-note-not-ready",
      reasonText: initialStatus.reasonText,
      phase: initialStatus.phase,
      batchId: initialStatus.batchId,
      timeTrusted: initialStatus.timeTrusted,
    }));
    return emptyResult(initialStatus);
  }

  let refreshed = await refreshCyclicNoteStatus(
    ws,
    gsToken,
    syncValue,
    initialStatus.batchId,
    cycle,
    "cyclicNoteStatusRefresh",
    options,
  );
  let next = refreshed.syncValue;
  let status = refreshed.status;
  if (refreshed.skipped) return emptyResult(status, next);

  const plan = planCyclicNoteNaturalCompletion(status, {
    onlyHighestRewardTask: naturalCompletion.onlyHighestRewardTask,
  });
  const plannedReceives = plan.kind === "receive" ? plan.receives : [];
  const actions = plannedReceives;
  const sentActions = [];
  const sentReceiveKeys = new Set();
  const receivedActions = [];
  const failedActions = [];

  console.log(JSON.stringify({
    step: "cyclicNoteActionPlan",
    cycle,
    batchId: status.batchId,
    actionCount: actions.length,
    taskIds: actions.map((action) => action.taskId),
    naturalCompletion,
    naturalPlan: {
      kind: plan.kind,
      reason: plan.reason,
      route: plan.route,
      targetTaskId: plan.target?.taskId ?? null,
      targetSlotIndex: plan.target?.slotIndex ?? null,
      targetTaskIds: plan.targets?.map((target) => target.taskId) || [],
      receiveTaskIds: plannedReceives.map((action) => action.taskId),
    },
  }));

  for (const action of actions) {
    const receiveKey = `${action.batchId}:${action.taskId}`;
    if (sentReceiveKeys.has(receiveKey)) continue;
    sentReceiveKeys.add(receiveKey);
    sentActions.push(action);
    try {
      const rsp = await requestSync(
        ws,
        gsToken,
        CYCLIC_NOTE_IFACES.recvTaskRwd,
        { batchId: action.batchId, taskId: action.taskId },
        "Cyclic note task reward failed",
      );
      next = rsp.value ? mergeLandSync(next, rsp.value) : next;
      console.log(JSON.stringify({
        step: "cyclicNoteRecvTaskRwdSent",
        cycle,
        batchId: action.batchId,
        taskId: action.taskId,
        slotIndex: action.slotIndex,
        iface: CYCLIC_NOTE_IFACES.recvTaskRwd,
        dsName: rsp.dsName,
        err: null,
      }));
      refreshed = await refreshCyclicNoteStatus(
        ws,
        gsToken,
        next,
        action.batchId,
        cycle,
        "cyclicNoteEnterAfterReceive",
        options,
      );
      next = refreshed.syncValue;
      status = refreshed.status;
      const receiptConfirmed = status.taskSlots.some((slot) => (
        Number(slot.taskId) === Number(action.taskId) && slot.received === true
      ));
      if (!receiptConfirmed) {
        failedActions.push({
          ...action,
          iface: CYCLIC_NOTE_IFACES.recvTaskRwd,
          reason: "recv-task-rwd-unconfirmed",
          message: "authoritative-enter-did-not-confirm-recv-map",
        });
        console.log(JSON.stringify({
          step: "cyclicNoteRecvTaskRwdUnconfirmed",
          cycle,
          batchId: action.batchId,
          taskId: action.taskId,
          slotIndex: action.slotIndex,
          iface: CYCLIC_NOTE_IFACES.recvTaskRwd,
          reason: "authoritative-enter-did-not-confirm-recv-map",
        }));
        break;
      }
      receivedActions.push(action);
      console.log(JSON.stringify({
        step: "cyclicNoteRecvTaskRwdDone",
        cycle,
        batchId: action.batchId,
        taskId: action.taskId,
        slotIndex: action.slotIndex,
        iface: CYCLIC_NOTE_IFACES.recvTaskRwd,
        err: null,
      }));
    } catch (err) {
      if (isSessionExpiredError(err) || isWsRequestTimeoutError(err) || isExperienceGuardError(err)) throw err;
      if (isExperienceActionBlockedError(err)) break;
      failedActions.push({
        ...action,
        iface: CYCLIC_NOTE_IFACES.recvTaskRwd,
        reason: "recv-task-rwd-failed",
        message: err.message,
      });
      console.log(JSON.stringify({
        step: "cyclicNoteRecvTaskRwdFailed",
        cycle,
        batchId: action.batchId,
        taskId: action.taskId,
        slotIndex: action.slotIndex,
        iface: CYCLIC_NOTE_IFACES.recvTaskRwd,
        reason: "recv-task-rwd-failed",
        message: err.message,
      }));
      break;
    }
  }

  if (sentActions.length) {
    return {
      ...emptyResult(status),
      syncValue: next,
      actionCount: sentActions.length,
      receivedCount: receivedActions.length,
      actions: receivedActions,
      failedCount: failedActions.length,
      failedActions,
    };
  }

  if (plan.kind === "action") {
    let result = null;
    for (const target of plan.targets || [plan.target]) {
      if (!target) continue;
      result = await runCyclicNoteTaskHandler(
        ws,
        gsToken,
        next,
        cycle,
        target,
        target.route,
        options,
      );
      next = result?.syncValue || next;
      const actionCount = Number(
        result?.actionCount
        || result?.submittedCount
        || result?.hireCount
        || result?.plantedCount
        || result?.harvestedCount
        || result?.wateredCount
        || result?.shelvedCount
        || 0,
      );
      if (actionCount > 0 || result?.failedActions?.length) break;
    }
    refreshed = await refreshCyclicNoteStatus(
      ws,
      gsToken,
      next,
      status.batchId,
      cycle,
      "cyclicNoteEnterAfterNaturalAction",
      options,
    );
    next = refreshed.syncValue;
    status = refreshed.status;
    return {
      ...emptyResult(status),
      syncValue: next,
      actionCount: Number(result?.actionCount || result?.submittedCount || result?.hireCount || result?.plantedCount || result?.harvestedCount || result?.wateredCount || result?.shelvedCount || 0),
      actions: result?.actions || result?.submittedActions || [],
      failedCount: result?.failedActions?.length || 0,
      failedActions: result?.failedActions || [],
    };
  }

  return emptyResult(status, next);
}
function parseNumberList(value) {
  if (!value) return [];
  return String(value)
    .split(/[,\s]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function toFiniteNumber(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseTimeMs(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function compactCustomerNpcIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0))];
}

function readPath(root, path) {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return null;
    current = current[segment];
  }
  return current;
}

function getOrderCustomerState(syncValue) {
  return syncValue?.orderCustomerTot?.orderCustomer || syncValue?.orderCustomer || {};
}

function getExistingCustomerNpcIdSet(syncValue) {
  const orderMap = getOrderCustomerState(syncValue).orderMap || {};
  const out = new Set();
  for (const [npcId, order] of Object.entries(orderMap)) {
    if (!order || typeof order !== "object" || !Object.keys(order).length) continue;
    const id = Number(npcId);
    if (Number.isSafeInteger(id) && id > 0) out.add(id);
  }
  return out;
}

function getCustomerOrderRequestClockFn(options = {}) {
  return typeof options.customerOrderRequestStartNowFn === "function"
    ? options.customerOrderRequestStartNowFn
    : Date.now;
}

function getCustomerOrderRequestStartAtMs(options = {}) {
  const value = getCustomerOrderRequestClockFn(options)();
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getCustomerOrderQueueSnapshot(customerStatus = {}, actions = [], options = {}) {
  const orders = Array.isArray(customerStatus?.orders) ? customerStatus.orders : [];
  const selection = customerStatus?.flowerCurrencySelection || null;
  const normalizeIds = (values) => [...new Set((Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((a, b) => a - b);
  const pendingNpcIds = normalizeIds(orders.map((order) => order?.npcId));
  const eligibleNpcIds = normalizeIds(
    selection?.eligibleNpcIds?.length
      ? selection.eligibleNpcIds
      : selection?.selectedNpcId == null ? [] : [selection.selectedNpcId],
  );
  const actionNpcIds = normalizeIds((actions || []).map((action) => action?.npcId));
  const processingNpcIds = normalizeIds(options.processingNpcIds);
  return {
    pendingCount: pendingNpcIds.length,
    pendingNpcIds,
    eligibleCount: eligibleNpcIds.length,
    eligibleNpcIds,
    actionCount: actionNpcIds.length,
    actionNpcIds,
    processingCount: processingNpcIds.length,
    processingNpcIds,
    selectionStatus: selection?.status || null,
    selectionReason: selection?.reason || null,
    queueStateKnown: Array.isArray(customerStatus?.orders)
      && Boolean(selection),
    queueSource: "order-state.customerStatus",
  };
}

function getCurrentMainTaskId(syncValue) {
  const paths = [
    ["taskTot", "main", "curTaskId"],
    ["taskTot", "task", "curTaskId"],
    ["taskTot", "mainTask", "curTaskId"],
    ["taskTot", "taskCtrl_main", "curTaskId"],
    ["$taskTot", "main", "curTaskId"],
    ["$taskTot", "task", "curTaskId"],
    ["$taskTot", "mainTask", "curTaskId"],
    ["$taskTot", "taskCtrl_main", "curTaskId"],
    ["taskCtrl_main", "curTaskId"],
    ["mainTaskTot", "main", "curTaskId"],
    ["mainTaskTot", "mainTask", "curTaskId"],
    ["mainTaskTot", "task", "curTaskId"],
    ["$mainTaskTot", "main", "curTaskId"],
    ["$mainTaskTot", "mainTask", "curTaskId"],
    ["$mainTaskTot", "task", "curTaskId"],
    ["$usrTot", "data", "curTaskId"],
    ["usrTot", "data", "curTaskId"],
    ["$usrTot", "mainTaskId"],
    ["usrTot", "mainTaskId"],
  ];

  for (const path of paths) {
    const value = toFiniteNumber(readPath(syncValue, path), null);
    if (Number.isSafeInteger(value) && value >= 0) return { value, sourcePath: path.join(".") };
  }

  return { value: null, sourcePath: null };
}

function getCustomerOrderNextGenTimeMs(syncValue) {
  const orderCustomer = getOrderCustomerState(syncValue);
  const fields = ["nextGenTime", "nextGenAt", "nextTime", "genTime"];
  for (const field of fields) {
    if (!Object.hasOwn(orderCustomer || {}, field)) continue;
    const candidate = orderCustomer[field];
    if (candidate == null || candidate === "") continue;
    const ms = parseTimeMs(candidate);
    return ms > 0 && Number.isFinite(ms) ? ms : Number.NaN;
  }
  return null;
}

function getCustomerOrderTimeContext(syncValue, options = {}) {
  const explicitActionTime = options.customerOrderActionTime || options.actionTime || null;
  const actionTime = resolveResourceActionTime(syncValue, {
    ...options,
    actionTime: explicitActionTime,
  });
  const timeAuthority = options.timeAuthority
    || actionTime.timeAuthority
    || syncValue?.$timeAuthority
    || null;
  const localNowMs = Object.hasOwn(actionTime, "localNowMs")
    ? actionTime.localNowMs
    : actionTime.nowMs;
  const authoritySnapshot = getTimeAuthoritySnapshot(timeAuthority, {
    nowMs: localNowMs,
  });
  if (
    explicitActionTime
    && typeof explicitActionTime === "object"
    && Object.hasOwn(explicitActionTime, "nowMs")
  ) {
    const explicitTimeTrusted = Object.hasOwn(explicitActionTime, "timeTrusted")
      ? explicitActionTime.timeTrusted === true
      : (
        typeof explicitActionTime.clockSource === "string"
        && explicitActionTime.clockSource !== "local-fallback"
      );
    return {
      ...actionTime,
      localNowMs,
      nowMs: actionTime.nowMs,
      timeTrusted: explicitTimeTrusted,
      timeValid: Number.isFinite(actionTime.nowMs),
      clockSource: actionTime.clockSource
        || (explicitTimeTrusted ? authoritySnapshot.clockSource : "local-fallback"),
      timeAuthority,
      timeAuthorityReason: explicitTimeTrusted
        ? null
        : actionTime.timeAuthorityReason || authoritySnapshot.rejectionReason || "no-sample",
    };
  }
  const legacyTrusted = !Object.hasOwn(timeAuthority || {}, "lastAcceptedSample")
    && timeAuthority?.trusted === true
    && Number.isFinite(timeAuthority.correctedNowMs)
    && Number.isFinite(localNowMs);
  const timeTrusted = Boolean(
    (authoritySnapshot.trusted && Number.isFinite(authoritySnapshot.correctedNowMs))
      || legacyTrusted,
  );
  const nowMs = timeTrusted
    ? (legacyTrusted ? timeAuthority.correctedNowMs : authoritySnapshot.correctedNowMs)
    : localNowMs;
  return {
    ...actionTime,
    localNowMs,
    nowMs,
    timeTrusted,
    timeValid: Number.isFinite(nowMs),
    clockSource: timeTrusted
      ? (legacyTrusted ? "server-heartbeat-corrected" : authoritySnapshot.clockSource)
      : "local-fallback",
    timeAuthority,
    timeAuthorityReason: timeTrusted ? null : authoritySnapshot.rejectionReason || "no-sample",
  };
}

function getCustomerOrderGenerationStatus(syncValue, options = {}) {
  const actionTime = getCustomerOrderTimeContext(syncValue, options);
  const nextGenTimeMs = getCustomerOrderNextGenTimeMs(syncValue);
  const validNextGenTimeMs = Number.isFinite(nextGenTimeMs) && nextGenTimeMs > 0;
  const cooldownEndMs = validNextGenTimeMs
    ? nextGenTimeMs + CUSTOMER_ORDER_GENERATION_DELAY_MS
    : 0;
  const cooldownActive = Boolean(
    validNextGenTimeMs
    && Number.isFinite(actionTime.nowMs)
    && actionTime.nowMs <= cooldownEndMs,
  );
  const remainingMs = cooldownActive
    ? Math.max(0, cooldownEndMs - actionTime.nowMs)
    : 0;
  return {
    localNowMs: actionTime.localNowMs,
    nowMs: actionTime.nowMs,
    nextGenTimeMs: validNextGenTimeMs ? nextGenTimeMs : null,
    nextGenTime: validNextGenTimeMs ? new Date(nextGenTimeMs).toISOString() : null,
    nextGenTimeInvalid: Number.isNaN(nextGenTimeMs),
    cooldownEndMs: cooldownEndMs || null,
    cooldownActive,
    remainingMs,
    remainingText: formatDuration(remainingMs),
    timeTrusted: actionTime.timeTrusted,
    timeAuthorityReason: actionTime.timeAuthorityReason,
    clockSource: actionTime.clockSource,
  };
}

function getCustomerOrderVerifiedGuestNpcState(options = {}) {
  const unavailable = {
    guestNpcIds: [],
    guestNpcIdSource: "unavailable/local-visitor-state-unavailable",
    guestNpcStateKnown: false,
  };
  const adapter = options?.customerOrderVerifiedGuestNpcState;
  if (adapter == null) return unavailable;
  if (
    typeof adapter !== "object"
    || adapter.verified !== true
    || typeof adapter.provenance !== "string"
    || !adapter.provenance.trim()
    || !Array.isArray(adapter.guestNpcIds)
  ) {
    return {
      ...unavailable,
      guestNpcIdSource: "customerOrderVerifiedGuestNpcState:invalid",
    };
  }
  const normalizedIds = adapter.guestNpcIds.map((npcId) => Number(npcId));
  if (normalizedIds.some((npcId) => !Number.isSafeInteger(npcId) || npcId <= 0)) {
    return {
      ...unavailable,
      guestNpcIdSource: "customerOrderVerifiedGuestNpcState:invalid",
    };
  }
  return {
    guestNpcIds: [...new Set(normalizedIds)],
    guestNpcIdSource: `verified-adapter:${adapter.provenance.trim()}`,
    guestNpcStateKnown: true,
    guestNpcProvenance: adapter.provenance.trim(),
  };
}

function getCustomerOrderNpcConfig(options = {}) {
  if (Object.hasOwn(options, "orderCustomerNpcConfig")) {
    return {
      config: options.orderCustomerNpcConfig,
      error: null,
    };
  }
  try {
    return {
      config: loadOrderCustomerNpcConfig(options.orderCustomerNpcConfigPath),
      error: null,
    };
  } catch (error) {
    return {
      config: null,
      error,
    };
  }
}

function emptyCustomerOrderNpcPlan(syncValue, guestState, reason, details = {}) {
  const existingOrderNpcIds = [...getExistingCustomerNpcIdSet(syncValue)].sort((a, b) => a - b);
  const hasOrderCustomerContainer = Boolean(
    syncValue
    && typeof syncValue === "object"
    && (
      Object.hasOwn(syncValue, "orderCustomerTot")
      || Object.hasOwn(syncValue, "orderCustomer")
    ),
  );
  return {
    existingOrderNpcIds,
    existingOrderNpcIdsKnown: details.existingOrderNpcIdsKnown ?? true,
    existingOrderNpcIdsSource: details.existingOrderNpcIdsSource
      || (hasOrderCustomerContainer
        ? "orderCustomerTot.orderCustomer.orderMap"
        : "legacy-compatible-absent-order-state"),
    existingNpcIds: existingOrderNpcIds,
    guestNpcIds: guestState.guestNpcIds,
    guestNpcIdList: guestState.guestNpcIds,
    guestNpcIdSource: guestState.guestNpcIdSource,
    guestNpcStateKnown: guestState.guestNpcStateKnown,
    guestNpcIdsKnown: guestState.guestNpcStateKnown,
    guestNpcIdsSource: guestState.guestNpcIdSource,
    availableNpcIds: [],
    availableNpcIdsKnown: false,
    availableNpcCount: 0,
    availableNpcSourceKnown: false,
    availableNpcSource: details.availableNpcSource || null,
    unlockStateKnown: false,
    reason,
    ...details,
  };
}

function getCustomerOrderNpcPlan(syncValue, beforeStatus = {}, options = {}) {
  const guestState = getCustomerOrderVerifiedGuestNpcState(options);
  const orderCustomerState = getOrderCustomerState(syncValue);
  const hasOrderCustomerContainer = Boolean(
    syncValue
    && typeof syncValue === "object"
    && (
      Object.hasOwn(syncValue, "orderCustomerTot")
      || Object.hasOwn(syncValue, "orderCustomer")
    ),
  );
  const existingOrderNpcIdsKnown = Boolean(
    !hasOrderCustomerContainer
    || (
      orderCustomerState
      && typeof orderCustomerState === "object"
      && orderCustomerState.orderMap
      && typeof orderCustomerState.orderMap === "object"
      && !Array.isArray(orderCustomerState.orderMap)
    ),
  );
  const existingOrderNpcIdsSource = hasOrderCustomerContainer
    ? "orderCustomerTot.orderCustomer.orderMap"
    : "legacy-compatible-absent-order-state";
  if (!existingOrderNpcIdsKnown) {
    return emptyCustomerOrderNpcPlan(syncValue, guestState, "existing-order-state-unknown", {
      existingOrderNpcIdsKnown: false,
      existingOrderNpcIdsSource,
    });
  }
  const { config, error } = getCustomerOrderNpcConfig(options);
  if (!config || error) {
    return emptyCustomerOrderNpcPlan(syncValue, guestState, "npc-config-source-unknown", {
      configError: error?.message || null,
    });
  }
  const configSourcePath = typeof config.sourcePath === "string" && config.sourcePath.trim()
    ? config.sourcePath
    : null;
  if (!configSourcePath || !Array.isArray(config.npcIds) || !config.npcIds.length) {
    return emptyCustomerOrderNpcPlan(syncValue, guestState, "npc-config-source-unknown", {
      configSourcePath,
    });
  }
  const configuredNpcIds = compactCustomerNpcIdList(config.npcIds);
  if (configuredNpcIds.length !== config.npcIds.length || !configuredNpcIds.length) {
    return emptyCustomerOrderNpcPlan(syncValue, guestState, "npc-candidate-source-unknown", {
      configSourcePath,
      configuredNpcIds,
    });
  }

  const npcRows = configuredNpcIds.map((npcId) => config.npcs?.[npcId] || config.npcs?.[String(npcId)]);
  const unlockRequirements = npcRows.map((npc) => toFiniteNumber(npc?.maintaskId, null));
  if (npcRows.some((npc) => !npc) || unlockRequirements.some(
    (taskId) => !Number.isSafeInteger(taskId) || taskId < 0,
  )) {
    return emptyCustomerOrderNpcPlan(syncValue, guestState, "npc-candidate-source-unknown", {
      configSourcePath,
      configuredNpcIds,
    });
  }

  const currentMainTask = getCurrentMainTaskId(syncValue);
  const requiresMainTask = unlockRequirements.some((taskId) => taskId > 0);
  if (requiresMainTask && currentMainTask.value == null) {
    return emptyCustomerOrderNpcPlan(syncValue, guestState, "main-task-state-unknown", {
      configSourcePath,
      configuredNpcIds,
      currentMainTaskId: null,
      currentMainTaskSourcePath: null,
    });
  }

  const existingOrderNpcIds = [...getExistingCustomerNpcIdSet(syncValue)].sort((a, b) => a - b);
  const existingNpcSet = new Set(existingOrderNpcIds);
  const guestNpcSet = new Set(guestState.guestNpcIds);
  const openNpcIds = configuredNpcIds.filter((npcId, index) => (
    unlockRequirements[index] === 0
      || (currentMainTask.value != null && unlockRequirements[index] <= currentMainTask.value)
  ));
  const availableNpcIds = openNpcIds.filter((npcId) => (
    !existingNpcSet.has(npcId) && !guestNpcSet.has(npcId)
  ));
  return {
    existingOrderNpcIds,
    existingOrderNpcIdsKnown: true,
    existingOrderNpcIdsSource,
    existingNpcIds: existingOrderNpcIds,
    guestNpcIds: guestState.guestNpcIds,
    guestNpcIdList: guestState.guestNpcIds,
    guestNpcIdSource: guestState.guestNpcIdSource,
    guestNpcStateKnown: guestState.guestNpcStateKnown,
    guestNpcIdsKnown: guestState.guestNpcStateKnown,
    guestNpcIdsSource: guestState.guestNpcIdSource,
    configSourcePath,
    configuredNpcIds,
    openNpcIds,
    availableNpcIds,
    availableNpcIdsKnown: true,
    availableNpcCount: availableNpcIds.length,
    availableNpcSourceKnown: true,
    availableNpcSource: `${configSourcePath}:unlocked-and-unoccupied`,
    unlockStateKnown: true,
    currentMainTaskId: currentMainTask.value,
    currentMainTaskSourcePath: currentMainTask.sourcePath,
    unlockTaskIdUsed: currentMainTask.value,
    npcMax: toFiniteNumber(config.npcMax, null),
    npcMaxDay: toFiniteNumber(config.npcMaxDay, null),
    customerMax: toFiniteNumber(beforeStatus?.config?.customerMax, null),
    reason: availableNpcIds.length ? null : "no-available-npcs",
  };
}

function customerOrderRefreshResult(syncValue, details, options = {}) {
  return options.returnGenerationResult === true
    ? { syncValue, ...details }
    : syncValue;
}

function countCustomerOrders(syncValue) {
  const orderMap = getOrderCustomerState(syncValue)?.orderMap || {};
  return Object.values(orderMap)
    .filter((order) => order && typeof order === "object" && Object.keys(order).length > 0)
    .length;
}

function customerOrderGenerationErrorCategory(err) {
  if (isSessionExpiredError(err)) return "session-expired";
  if (isWsRequestTimeoutError(err)) return "transport-timeout";
  if (isUserStoppedError(err)) return "user-stop";
  return err?.automationClassification?.category || "transport";
}

function customerOrderActionFailureCategory(err, actionStep = {}) {
  if (isExperienceActionBlockedError(err)) return "experience-guard-blocked";
  if (isExperienceGuardError(err)) return "experience-guard-error";
  if (actionStep.type === "rejectCustomerOrder") return "reject-submit-error";
  if (actionStep.type === "makeFlowerArt") return "make-submit-error";
  if (actionStep.type === "finishCustomerOrder") return "finish-submit-error";
  return err?.automationClassification?.category || "submit-error";
}

async function refreshCustomerOrders(ws, gsToken, syncValue, label = "customerOrderGen", options = {}) {
  if (process.env.CUSTOMER_ORDER_GEN_BEFORE_ACTION === "0") {
    console.log(JSON.stringify({
      step: label,
      iface: ORDER_CUSTOMER_IFACES.genOrder,
      skipped: true,
      reason: "disabled",
      decision: "disabled",
      failureCategory: "disabled",
    }));
    return customerOrderRefreshResult(syncValue, {
      attempted: false,
      requestSucceeded: false,
      generated: false,
      reason: "disabled",
    }, options);
  }

  const flowerNames = options.flowerNames || loadFlowerNameMap();
  const generationStatus = getCustomerOrderGenerationStatus(syncValue, options);
  const rewardReleaseMask = Object.hasOwn(
    options,
    "customerOrderFlowerCurrencyRewardReleaseMask",
  )
    ? normalizeExplicitCustomerOrderFlowerCurrencyRewardReleaseMask(
      options.customerOrderFlowerCurrencyRewardReleaseMask,
    )
    : getCustomerOrderFlowerCurrencyRewardReleaseSetting().mask;
  const beforeStatus = summarizeOrderCustomerStatus(syncValue, {
    nameMap: flowerNames,
    customerOrderFlowerCurrencyRewardReleaseMask: rewardReleaseMask,
    customerOrderFlowerCurrencyHistory: options.customerOrderFlowerCurrencyHistory
      || loadCustomerOrderFlowerCurrencyHistoryContext(syncValue, options),
    nowMs: generationStatus.nowMs,
    ...(Object.hasOwn(options, "orderCustomerNpcConfig")
      ? { orderCustomerNpcConfig: options.orderCustomerNpcConfig }
      : {}),
    ...(Object.hasOwn(options, "flowerArtConfig")
      ? { flowerArtConfig: options.flowerArtConfig }
      : {}),
  });
  const customerOrderScheduler = options.customerOrderScheduler || createCustomerOrderScheduler({
    nowFn: options.nowFn || Date.now,
    retryIntervalMs: getCustomerOrderGenerationDuringWaitRetryIntervalMs(),
    healthCheckIntervalMs: CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS,
  });
  const nextGenTimeMs = generationStatus.nextGenTimeMs;
  const nowMs = generationStatus.nowMs;
  customerOrderScheduler.observeSync({
    nextGenTimeMs,
    nextGenTimeInvalid: generationStatus.nextGenTimeInvalid,
    nowMs,
  });
  const guestNpcPlan = getCustomerOrderNpcPlan(syncValue, beforeStatus, options);
  const preconditions = {
    dailyCountKnown: beforeStatus.dailyLimit?.dailyCountKnown,
    tdyCompletedCount: beforeStatus.dailyLimit?.tdyCompletedCount,
    dailyLimit: beforeStatus.dailyLimit?.dailyLimit,
    pendingOrderCount: beforeStatus.total,
    customerMax: beforeStatus.config?.customerMax,
    guestNpcIds: guestNpcPlan.guestNpcIds,
    availableNpcIds: guestNpcPlan.availableNpcIds,
    availableNpcCount: guestNpcPlan.availableNpcCount,
    availableNpcSourceKnown: guestNpcPlan.availableNpcSourceKnown,
  };
  const decision = customerOrderScheduler.evaluate({
    actionTime: generationStatus,
    nowMs,
    clockSource: generationStatus.clockSource,
    timeTrusted: generationStatus.timeTrusted,
    allowInitialGeneration: !customerOrderScheduler.snapshot().hasGenerated,
    preconditions,
  });
  if (!decision.due) {
    console.log(JSON.stringify({
      step: label,
      iface: ORDER_CUSTOMER_IFACES.genOrder,
      skipped: true,
      reason: decision.reason === "next-generation-cooldown"
        ? "customer-order-generation-cooldown"
        : decision.reason,
      schedulerReason: decision.reason,
      beforeTotal: beforeStatus.total,
      nextGenTime: nextGenTimeMs ? new Date(nextGenTimeMs).toISOString() : null,
      nextGenTimeText: formatDateTime(nextGenTimeMs),
      nowMs,
      localNowMs: generationStatus.localNowMs,
      timeTrusted: generationStatus.timeTrusted,
      clockSource: generationStatus.clockSource,
      timeAuthorityReason: generationStatus.timeAuthorityReason,
      remainingMs: generationStatus.remainingMs,
      remainingText: generationStatus.remainingText,
      guestNpcPlan,
      dailyLimit: beforeStatus.dailyLimit || null,
      customerOrderScheduler: customerOrderScheduler.snapshot(),
      queue: getCustomerOrderQueueSnapshot(beforeStatus),
    }));
    return customerOrderRefreshResult(syncValue, {
      attempted: false,
      requestSucceeded: false,
      generated: false,
      reason: decision.reason,
      customerNpcPlan: guestNpcPlan,
    }, options);
  }

  const { guestNpcIdList } = guestNpcPlan;
  const requestStartedAtMs = getCustomerOrderRequestStartAtMs(options);
  if (!customerOrderScheduler.beginGeneration({
    actionTime: generationStatus,
    nowMs,
    clockSource: generationStatus.clockSource,
    decision,
    timeTrusted: generationStatus.timeTrusted,
    requestStartedAtMs,
  })) {
    console.log(JSON.stringify({
      step: label,
      iface: ORDER_CUSTOMER_IFACES.genOrder,
      skipped: true,
      reason: "generation-request-deduplicated",
      schedulerReason: customerOrderScheduler.snapshot().lastSkipReason,
      beforeTotal: beforeStatus.total,
      guestNpcPlan,
      clockSource: generationStatus.clockSource,
      customerOrderScheduler: customerOrderScheduler.snapshot(),
    }));
    return customerOrderRefreshResult(syncValue, {
      attempted: false,
      requestSucceeded: false,
      generated: false,
      reason: "generation-request-deduplicated",
      customerNpcPlan: guestNpcPlan,
    }, options);
  }

  const beforeTotal = countCustomerOrders(syncValue);
  const beforeNpcIds = [...getExistingCustomerNpcIdSet(syncValue)].sort((a, b) => a - b);
  const schedulerAtRequestStart = customerOrderScheduler.snapshot();
  console.log(JSON.stringify({
    step: "customerOrderGenerationRequestStart",
    cycle: options.cycle ?? null,
    label,
    iface: ORDER_CUSTOMER_IFACES.genOrder,
    requestStartedAtMs: schedulerAtRequestStart.lastGenerationRequestStartAtMs
      ?? requestStartedAtMs,
    decisionAtMs: schedulerAtRequestStart.lastGenerationDecisionAtMs,
    nextGenTimeMs,
    dueAtMs: schedulerAtRequestStart.dueAtMs,
    dueToRequestMs: schedulerAtRequestStart.dueToRequestMs,
    guestNpcIdList,
    guestNpcIds: guestNpcPlan.guestNpcIds,
    guestNpcIdSource: guestNpcPlan.guestNpcIdSource,
    guestNpcIdsKnown: guestNpcPlan.guestNpcIdsKnown,
    existingOrderNpcIds: guestNpcPlan.existingOrderNpcIds,
    existingOrderNpcIdsKnown: guestNpcPlan.existingOrderNpcIdsKnown,
    existingOrderNpcIdsSource: guestNpcPlan.existingOrderNpcIdsSource,
    availableNpcIds: guestNpcPlan.availableNpcIds,
    availableNpcIdsKnown: guestNpcPlan.availableNpcIdsKnown,
    availableNpcSource: guestNpcPlan.availableNpcSource,
    availableNpcSourceKnown: guestNpcPlan.availableNpcSourceKnown,
    queue: getCustomerOrderQueueSnapshot(beforeStatus),
    dedupeResult: "in-flight-accepted",
    customerOrderScheduler: schedulerAtRequestStart,
  }));
  try {
    const rsp = await requestSync(
      ws,
      gsToken,
      ORDER_CUSTOMER_IFACES.genOrder,
      { guestNpcIdList },
      `${label} failed`,
      {
        requestStartedAtMs,
        timeAuthorityNowFn: getCustomerOrderRequestClockFn(options),
        timeAuthorityMaxAgeMs: options.timeAuthorityMaxAgeMs,
      },
    );
    const next = mergeLandSync(syncValue, rsp.value);
    const afterTotal = countCustomerOrders(next);
    const afterNpcIds = [...getExistingCustomerNpcIdSet(next)].sort((a, b) => a - b);
    const beforeNpcSet = new Set(beforeNpcIds);
    const newOrderNpcIds = afterNpcIds.filter((npcId) => !beforeNpcSet.has(npcId));
    const duplicateOrderNpcIds = afterNpcIds.filter((npcId) => beforeNpcSet.has(npcId));
    const responseNextGenTimeMs = getCustomerOrderNextGenTimeMs(rsp.value);
    const hasResponseNextGenTime = responseNextGenTimeMs !== null;
    const scheduledNextGenTimeMs = hasResponseNextGenTime
      && Number.isFinite(responseNextGenTimeMs)
      && responseNextGenTimeMs > 0
      ? responseNextGenTimeMs
      : null;
    const nextGenTimeInvalid = hasResponseNextGenTime && Number.isNaN(responseNextGenTimeMs);
    const generatedOrderCount = newOrderNpcIds.length;
    const responseAtMs = rsp.responseAtMs ?? nowMs;
    customerOrderScheduler.completeGeneration({
      nowMs: responseAtMs,
      requestStartedAtMs: rsp.requestStartedAtMs ?? requestStartedAtMs,
      responseAtMs,
      nextGenTimeMs: scheduledNextGenTimeMs,
      nextGenTimeInvalid,
      generatedOrderCount,
    });
    ws.observeSync?.(next, { customerOrderScheduler: customerOrderScheduler.snapshot() });
    const afterStatus = summarizeOrderCustomerStatus(next, {
      nameMap: flowerNames,
      customerOrderFlowerCurrencyRewardReleaseMask: rewardReleaseMask,
      customerOrderFlowerCurrencyHistory: options.customerOrderFlowerCurrencyHistory
        || loadCustomerOrderFlowerCurrencyHistoryContext(next, options),
      nowMs: responseAtMs,
      ...(Object.hasOwn(options, "orderCustomerNpcConfig")
        ? { orderCustomerNpcConfig: options.orderCustomerNpcConfig }
        : {}),
      ...(Object.hasOwn(options, "flowerArtConfig")
        ? { flowerArtConfig: options.flowerArtConfig }
        : {}),
    });
    const schedulerAfterResponse = customerOrderScheduler.snapshot();
    console.log(JSON.stringify({
      step: "customerOrderGenerationResponse",
      cycle: options.cycle ?? null,
      label,
      iface: ORDER_CUSTOMER_IFACES.genOrder,
      success: true,
      requestSucceeded: true,
      attempted: true,
      generated: generatedOrderCount > 0,
      requestStartedAtMs: rsp.requestStartedAtMs ?? requestStartedAtMs,
      responseAtMs,
      responseDurationMs: rsp.requestStartedAtMs == null || rsp.responseAtMs == null
        ? null
        : Math.max(0, rsp.responseAtMs - rsp.requestStartedAtMs),
      beforeTotal,
      afterTotal,
      generatedOrderCount,
      newOrderNpcIds,
      duplicateOrderNpcIds,
      dedupeResult: newOrderNpcIds.length ? "new-orders" : "no-new-orders",
      nextGenTimeMs: scheduledNextGenTimeMs,
      failureCategory: null,
      customerOrderScheduler: schedulerAfterResponse,
    }));
    const generated = generatedOrderCount > 0;
    console.log(JSON.stringify({
      step: label,
      iface: ORDER_CUSTOMER_IFACES.genOrder,
      event: "customer-order-generation-request-success",
      requestSucceeded: true,
      attempted: true,
      generated,
      guestNpcIdList,
      guestNpcIdSource: guestNpcPlan.guestNpcIdSource,
      guestNpcPlan,
      beforeTotal: beforeStatus.total,
      afterTotal: afterStatus.total,
      generatedOrderCount,
      newOrderNpcIds,
      duplicateOrderNpcIds,
      dedupeResult: newOrderNpcIds.length ? "new-orders" : "no-new-orders",
      requestStartedAtMs: rsp.requestStartedAtMs ?? requestStartedAtMs,
      responseAtMs,
      nowMs,
      localNowMs: generationStatus.localNowMs,
      timeTrusted: generationStatus.timeTrusted,
      clockSource: generationStatus.clockSource,
      dueToRequestMs: customerOrderScheduler.snapshot().dueToRequestMs,
      nextGenTimeMs: scheduledNextGenTimeMs,
      dsName: rsp.dsName,
      err: null,
      customerOrderScheduler: schedulerAfterResponse,
    }, null, 2));
    return customerOrderRefreshResult(next, {
      attempted: true,
      requestSucceeded: true,
      generated,
      generatedOrderCount,
      generationAtMs: rsp.requestStartedAtMs ?? requestStartedAtMs ?? nowMs,
      nextGenTimeMs: scheduledNextGenTimeMs,
      reason: generated ? "generation-success" : "generation-success-no-new-orders",
      customerNpcPlan: guestNpcPlan,
      requestStartedAtMs: rsp.requestStartedAtMs ?? requestStartedAtMs,
      responseAtMs,
      newOrderNpcIds,
      duplicateOrderNpcIds,
      dedupeResult: newOrderNpcIds.length ? "new-orders" : "no-new-orders",
      queueBefore: getCustomerOrderQueueSnapshot(beforeStatus),
      queueAfter: getCustomerOrderQueueSnapshot(afterStatus),
    }, options);
  } catch (err) {
    const category = customerOrderGenerationErrorCategory(err);
    customerOrderScheduler.failGeneration({
      nowMs,
      reason: "generation-request-failed",
      category,
    });
    console.log(JSON.stringify({
      step: label,
      iface: ORDER_CUSTOMER_IFACES.genOrder,
      event: "customer-order-generation-request-failure",
      guestNpcIdList,
      guestNpcIdSource: guestNpcPlan.guestNpcIdSource,
      guestNpcPlan,
      beforeTotal: beforeStatus.total,
      category,
      failureCategory: category,
      requestStartedAtMs,
      responseAtMs: err.responseAtMs ?? null,
      nowMs,
      localNowMs: generationStatus.localNowMs,
      clockSource: generationStatus.clockSource,
      timeAuthorityReason: generationStatus.timeAuthorityReason,
      dueToRequestMs: customerOrderScheduler.snapshot().dueToRequestMs,
      retryAtMs: customerOrderScheduler.snapshot().retryAtMs,
      customerOrderScheduler: customerOrderScheduler.snapshot(),
      queue: getCustomerOrderQueueSnapshot(beforeStatus),
      warn: err.message,
    }));
    if (isSessionExpiredError(err) || isWsRequestTimeoutError(err) || isUserStoppedError(err)) {
      throw err;
    }
    return customerOrderRefreshResult(syncValue, {
      attempted: true,
      requestSucceeded: false,
      generated: false,
      reason: "generation-request-failed",
      category,
      error: err.message,
      customerNpcPlan: guestNpcPlan,
      failureCategory: category,
      requestStartedAtMs,
      responseAtMs: err.responseAtMs ?? null,
      queue: getCustomerOrderQueueSnapshot(beforeStatus),
    }, options);
  }
}

async function autoSubmitCustomerOrders(
  ws,
  gsToken,
  syncValue,
  cycle = null,
  teamOrderRuntime = null,
  options = {},
) {
  if (process.env.AUTO_SUBMIT_CUSTOMER_ORDERS === "0") {
    console.log(JSON.stringify({ step: "customerOrderSubmitSkip", reason: "disabled" }));
    return { syncValue, actionCount: 0, actions: [] };
  }

  const maxSteps = Math.max(1, Number(process.env.CUSTOMER_ORDER_MAX_STEPS_PER_CYCLE || 20));
  const flowerNames = options.flowerNames || loadFlowerNameMap();
  const customerOrderScheduler = options.customerOrderScheduler || createCustomerOrderScheduler({
    nowFn: options.nowFn || Date.now,
    retryIntervalMs: getCustomerOrderGenerationDuringWaitRetryIntervalMs(),
    healthCheckIntervalMs: CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS,
  });
  let next = await refreshFlowerArtActivation(
    ws,
    gsToken,
    syncValue,
    "customerFlowerArtActivationRefreshBeforeAction",
    { ...options, flowerNames },
  );
  const actionTime = resolveResourceActionTime(next, options);
  const orderTimeOptions = { nowMs: actionTime.nowMs };
  let customerOrderFlowerCurrencyHistory = options.customerOrderFlowerCurrencyHistory
    || loadCustomerOrderFlowerCurrencyHistoryContext(next, options);
  const customerOrderRewardReleaseContext = Object.hasOwn(
    options,
    "customerOrderFlowerCurrencyRewardReleaseMask",
  )
    ? {
      customerOrderFlowerCurrencyRewardReleaseMask:
        options.customerOrderFlowerCurrencyRewardReleaseMask,
    }
    : {};
  const rewardReleaseMask = Object.hasOwn(
    options,
    "customerOrderFlowerCurrencyRewardReleaseMask",
  )
    ? normalizeExplicitCustomerOrderFlowerCurrencyRewardReleaseMask(
      options.customerOrderFlowerCurrencyRewardReleaseMask,
    )
    : getCustomerOrderFlowerCurrencyRewardReleaseSetting().mask;
  const customerOrderStatusConfig = {
    ...(Object.hasOwn(options, "flowerArtConfig")
      ? { flowerArtConfig: options.flowerArtConfig }
      : {}),
    ...(Object.hasOwn(options, "orderCustomerNpcConfig")
      ? { orderCustomerNpcConfig: options.orderCustomerNpcConfig }
      : {}),
  };
  const generationRefresh = await refreshCustomerOrders(
    ws,
    gsToken,
    next,
    "customerOrderGenBeforeAction",
    {
      ...options,
      flowerNames,
      actionTime,
      customerOrderFlowerCurrencyHistory,
      customerOrderScheduler,
      returnGenerationResult: true,
    },
  );
  next = generationRefresh.syncValue;
  if (generationRefresh.generated) {
    console.log(JSON.stringify({
      step: "customerOrderGenerationReadyForAction",
      cycle,
      generatedOrderCount: generationRefresh.generatedOrderCount,
      generationAtMs: generationRefresh.generationAtMs,
      customerOrderScheduler: customerOrderScheduler.snapshot(),
    }));
  }
  let orderStatus = logOrderStatusParsed(next, {
    cycle,
    mode: process.env.ACTION || "once",
    phase: "customerBeforeAction",
    teamOrderCapability: teamOrderRuntime?.capability(next),
    customerOrderFlowerCurrencyHistory,
    ...customerOrderRewardReleaseContext,
    ...customerOrderStatusConfig,
    flowerNames,
    ...orderTimeOptions,
  });
  const handledActions = [];
  const skippedCustomerNpcIds = new Set();

  for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex++) {
    const customerStatus = orderStatus.customer;
    const actions = getAutoSubmitCustomerOrderActions(customerStatus)
      .filter((action) => !skippedCustomerNpcIds.has(Number(action.npcId)));
    console.log(JSON.stringify({
      step: "customerOrderActionPlan",
      cycle,
      customerStep: stepIndex,
      rule: CUSTOMER_ORDER_ACTION_RULE_TEXT,
      customerOrderFlowerCurrencyHistory,
      flowerCurrencySelection: customerStatus?.flowerCurrencySelection || null,
      dailyLimit: customerStatus?.dailyLimit || null,
      doubleGoldGate: customerStatus?.doubleGoldGate || null,
      customerOrderQueue: getCustomerOrderQueueSnapshot(customerStatus, actions),
      parsedCustomerOrders: (customerStatus?.orders || []).map((order) => ({
        npcId: order.npcId,
        artId: order.artId,
        needArt: order.needArt,
        haveArt: order.haveArt,
        missingArt: order.missingArt,
        status: order.status,
        statusText: order.statusText,
        actionText: order.actionText,
        artActivated: order.artActivated,
        artActivationKnown: order.artActivationKnown,
        artActivationSource: order.artActivationSource,
        flowerCurrencyItemId: order.flowerCurrencyItemId,
        flowerCurrencyBaseReward: order.flowerCurrencyBaseReward,
        flowerCurrencyQuantity: order.flowerCurrencyQuantity,
        flowerCurrencyReward: order.flowerCurrencyReward,
        flowerCurrencyRewardKnown: order.flowerCurrencyRewardKnown,
        flowerCurrencyRewardReason: order.flowerCurrencyRewardReason,
        flowerCurrencyDecision: order.flowerCurrencyDecision,
        flowerCurrencyDecisionText: order.flowerCurrencyDecisionText,
        flowerRequirements: order.flowerRequirements,
      })),
      actions: actions.map((action) => ({
        ...action,
        ...describeCustomerOrderAction(action),
      })),
    }, null, 2));
    const checkEntry = recordCustomerOrderCheck(runHistory, {
      cycle,
      customerStep: stepIndex,
      customerStatus,
      actions,
    });
    console.log(JSON.stringify({
      step: "customerOrderCheckRecorded",
      cycle,
      customerStep: stepIndex,
      checkEntry,
    }, null, 2));

    if (!actions.length) {
      return { syncValue: next, actionCount: handledActions.length, actions: handledActions, orderStatus };
    }

    const action = actions[0];
    const actionOutcome = describeCustomerOrderAction(action);
    const orderBeforeAction = (customerStatus?.orders || []).find((order) => order.npcId === action.npcId);
    const localDeltaPatches = [];
    const authoritativeActionPayloads = [];
    let makeBeforeArtCount = null;
    let actionFailed = false;
    let actionTiming = null;
    for (const actionStep of action.steps || []) {
      const beforeActionSync = next;
      const requestStartedAtMs = getCustomerOrderRequestStartAtMs(options);
      const requestSequence = customerOrderScheduler.snapshot().actionSequence + 1;
      actionTiming = customerOrderScheduler.recordAction({
        nowMs: requestStartedAtMs ?? getCustomerOrderTimeContext(next, options).nowMs,
        requestStartedAtMs,
        requestSequence,
        type: actionStep.type,
        npcId: action.npcId,
      });
      console.log(JSON.stringify({
        step: "customerOrderActionRequestStart",
        cycle,
        customerStep: stepIndex,
        npcId: action.npcId,
        artId: action.artId,
        type: actionStep.type,
        iface: actionStep.iface,
        args: actionStep.args || {},
        reason: action.reason,
        requestStartedAtMs: actionTiming.requestStartAtMs,
        requestSequence: actionTiming.requestSequence,
        generationToFirstActionRequestStartMs: actionTiming.generationToFirstActionMs
          ?? customerOrderScheduler.snapshot().generationToFirstActionMs,
        makeToFinishRequestStartDelayMs: actionTiming.makeToFinishDelayMs,
        latencyMetricBasis: actionTiming.latencyMetricBasis,
        queue: getCustomerOrderQueueSnapshot(customerStatus, actions, {
          processingNpcIds: [action.npcId],
        }),
      }));
      let rsp;
      try {
        rsp = await requestSync(
          ws,
          gsToken,
          actionStep.iface,
          actionStep.args || {},
          `${actionStep.iface} failed`,
          {
            requestStartedAtMs,
            timeAuthorityNowFn: getCustomerOrderRequestClockFn(options),
            timeAuthorityMaxAgeMs: options.timeAuthorityMaxAgeMs,
          },
        );
      } catch (err) {
        const failureCategory = customerOrderActionFailureCategory(err, actionStep);
        console.log(JSON.stringify({
          step: "customerOrderActionResponse",
          cycle,
          customerStep: stepIndex,
          npcId: action.npcId,
          artId: action.artId,
          type: actionStep.type,
          iface: actionStep.iface,
          args: actionStep.args || {},
          requestStartedAtMs: actionTiming.requestStartAtMs,
          responseAtMs: err.responseAtMs ?? null,
          requestSequence: actionTiming.requestSequence,
          success: false,
          failureCategory,
          experienceEstimateSource: err.experienceGuard?.predictionSource ?? null,
          warn: err.message,
        }));
        if (isExperienceActionBlockedError(err)) {
          if (actionStep.type !== "finishCustomerOrder") throw err;
          options.recordCycleError?.("customerOrderSubmitError", err);
          skippedCustomerNpcIds.add(Number(action.npcId));
          const blockedAction = {
            ...action,
            ...actionOutcome,
            outcome: "skipped",
            outcomeText: "经验保护跳过本单，订单保留且不写成功历史；继续检查后续安全动作",
            customerOrderActionType: "finishCustomerOrder",
            customerOrderFlowerCurrencyHistoryUpdate: "finish-blocked-no-history-update",
            customerOrderHistoricalMaxRewardAfter: customerOrderFlowerCurrencyHistory.historicalMaxReward ?? null,
            requestStartedAtMs: actionTiming.requestStartAtMs,
            responseAtMs: err.responseAtMs ?? null,
            requestSequence: actionTiming.requestSequence,
            failureCategory,
            experienceEstimateSource: err.experienceGuard?.predictionSource ?? null,
            error: err.message,
          };
          handledActions.push(blockedAction);
          const historyEntry = recordCustomerOrderSubmission(runHistory, {
            cycle,
            action: blockedAction,
            order: orderBeforeAction,
          });
          console.log(JSON.stringify({
            step: "customerOrderFinishExperienceBlocked",
            cycle,
            customerStep: stepIndex,
            npcId: action.npcId,
            iface: actionStep.iface,
            args: actionStep.args || {},
            reason: action.reason,
            orderRetained: true,
            historyUpdate: blockedAction.customerOrderFlowerCurrencyHistoryUpdate,
            historyEntry,
            continueCustomerOrderActions: true,
            requestStartedAtMs: actionTiming.requestStartAtMs,
            responseAtMs: err.responseAtMs ?? null,
            requestSequence: actionTiming.requestSequence,
            failureCategory,
            experienceEstimateSource: err.experienceGuard?.predictionSource ?? null,
            warn: err.message,
          }));
          orderStatus = logOrderStatusParsed(next, {
            cycle,
            mode: process.env.ACTION || "once",
            phase: "customerAfterActionBlocked",
            customerStep: stepIndex,
            lastCustomerAction: blockedAction,
            teamOrderCapability: teamOrderRuntime?.capability(next),
            customerOrderFlowerCurrencyHistory,
            ...customerOrderRewardReleaseContext,
            ...customerOrderStatusConfig,
            flowerNames,
            ...orderTimeOptions,
          });
          actionFailed = true;
          break;
        }
        if (isExperienceGuardError(err)) throw err;
        if (actionStep.type === "rejectCustomerOrder") {
          skippedCustomerNpcIds.add(Number(action.npcId));
          const failedAction = {
            ...action,
            ...actionOutcome,
            outcome: "failed",
            outcomeText: "暂时没货拒绝失败，订单保留且不更新历史审计记录",
            customerOrderActionType: "rejectCustomerOrder",
            customerOrderRejectReasonText: action.reasonText || orderBeforeAction?.actionText || null,
            customerOrderFlowerCurrencyHistoryUpdate: "reject-failed-no-history-update",
            customerOrderHistoricalMaxRewardAfter: customerOrderFlowerCurrencyHistory.historicalMaxReward ?? null,
            requestStartedAtMs: actionTiming.requestStartAtMs,
            responseAtMs: err.responseAtMs ?? null,
            requestSequence: actionTiming.requestSequence,
            failureCategory,
            error: err.message,
          };
          handledActions.push(failedAction);
          const historyEntry = recordCustomerOrderSubmission(runHistory, {
            cycle,
            action: failedAction,
            order: orderBeforeAction,
          });
          console.log(JSON.stringify({
            step: "customerOrderRejectFailed",
            cycle,
            customerStep: stepIndex,
            npcId: action.npcId,
            iface: actionStep.iface,
            args: actionStep.args || {},
            reason: action.reason,
            reasonText: failedAction.customerOrderRejectReasonText,
            historyUpdate: failedAction.customerOrderFlowerCurrencyHistoryUpdate,
            orderRetained: true,
            requestStartedAtMs: actionTiming.requestStartAtMs,
            responseAtMs: err.responseAtMs ?? null,
            requestSequence: actionTiming.requestSequence,
            failureCategory,
            historyEntry,
            warn: err.message,
          }));
          orderStatus = logOrderStatusParsed(next, {
            cycle,
            mode: process.env.ACTION || "once",
            phase: "customerAfterActionFailure",
            customerStep: stepIndex,
            lastCustomerAction: failedAction,
            teamOrderCapability: teamOrderRuntime?.capability(next),
            customerOrderFlowerCurrencyHistory,
            ...customerOrderRewardReleaseContext,
            ...customerOrderStatusConfig,
            flowerNames,
            ...orderTimeOptions,
          });
          actionFailed = true;
          break;
        }
        const shortage = actionStep.type === "finishCustomerOrder"
          ? parseCustomerOrderItemShortageError(err)
          : null;
        if (!shortage) throw err;

        next = setLocalItemCount(next, shortage.itemId, 0);
        skippedCustomerNpcIds.add(Number(action.npcId));
        const failedAction = {
          ...action,
          ...actionOutcome,
          outcome: "failed",
          outcomeText: "提交失败，跳过本单继续处理其他顾客订单",
          code: shortage.code,
          itemId: shortage.itemId,
          requestStartedAtMs: actionTiming.requestStartAtMs,
          responseAtMs: err.responseAtMs ?? null,
          requestSequence: actionTiming.requestSequence,
          failureCategory,
        };
        handledActions.push(failedAction);
        console.log(JSON.stringify({
          step: "customerOrderActionStepFailed",
          cycle,
          customerStep: stepIndex,
          npcId: action.npcId,
          artId: action.artId,
          type: actionStep.type,
          iface: actionStep.iface,
          args: actionStep.args || {},
          reason: action.reason,
          code: shortage.code,
          itemId: shortage.itemId,
          skippedThisCycle: true,
          requestStartedAtMs: actionTiming.requestStartAtMs,
          responseAtMs: err.responseAtMs ?? null,
          requestSequence: actionTiming.requestSequence,
          failureCategory,
          err: shortage.payload,
          warn: err.message,
        }));
        orderStatus = logOrderStatusParsed(next, {
          cycle,
          mode: process.env.ACTION || "once",
          phase: "customerAfterActionFailure",
          customerStep: stepIndex,
          lastCustomerAction: failedAction,
          teamOrderCapability: teamOrderRuntime?.capability(next),
          customerOrderFlowerCurrencyHistory,
          ...customerOrderRewardReleaseContext,
          ...customerOrderStatusConfig,
          flowerNames,
          ...orderTimeOptions,
        });
        actionFailed = true;
        break;
      }
      actionTiming = {
        ...actionTiming,
        responseAtMs: rsp.responseAtMs ?? null,
      };
      if (actionStep.type === "makeFlowerArt") {
        if (makeBeforeArtCount == null) makeBeforeArtCount = getItemCount(beforeActionSync, action.artId);
        authoritativeActionPayloads.push({
          source: "makeFlowerArt.response",
          value: rsp.value,
        });
      }
      next = mergeLandSync(next, rsp.value);
      const localDeltas = customerOrderActionStepLocalDeltas(action, actionStep, orderBeforeAction);
      next = applyLocalItemDeltasForUnchanged(
        beforeActionSync,
        next,
        localDeltas,
      );
      if (localDeltas.length) {
        localDeltaPatches.push({
          beforeSync: beforeActionSync,
          deltas: localDeltas,
        });
      }
      console.log(JSON.stringify({
        step: "customerOrderActionResponse",
        cycle,
        customerStep: stepIndex,
        npcId: action.npcId,
        artId: action.artId,
        type: actionStep.type,
        iface: actionStep.iface,
        args: actionStep.args || {},
        requestStartedAtMs: rsp.requestStartedAtMs ?? actionTiming.requestStartAtMs,
        responseAtMs: rsp.responseAtMs ?? null,
        requestSequence: actionTiming.requestSequence,
        success: true,
        failureCategory: null,
        dsName: rsp.dsName,
      }));
      console.log(JSON.stringify({
        step: "customerOrderActionStepDone",
        cycle,
        customerStep: stepIndex,
        npcId: action.npcId,
        artId: action.artId,
        type: actionStep.type,
        iface: actionStep.iface,
        args: actionStep.args || {},
        reason: action.reason,
        outcome: actionOutcome.outcome,
        outcomeText: actionOutcome.outcomeText,
        generationToFirstActionMs: actionTiming.generationToFirstActionMs
          ?? customerOrderScheduler.snapshot().generationToFirstActionMs,
        makeToFinishDelayMs: actionTiming.makeToFinishDelayMs,
        generationToFirstActionRequestStartMs: actionTiming.generationToFirstActionMs
          ?? customerOrderScheduler.snapshot().generationToFirstActionMs,
        makeToFinishRequestStartDelayMs: actionTiming.makeToFinishDelayMs,
        requestStartedAtMs: rsp.requestStartedAtMs ?? actionTiming.requestStartAtMs,
        responseAtMs: rsp.responseAtMs ?? null,
        requestSequence: actionTiming.requestSequence,
        latencyMetricBasis: actionTiming.latencyMetricBasis
          ?? customerOrderScheduler.snapshot().latencyMetricBasis,
        dsName: rsp.dsName,
        err: null,
      }));
    }

    if (actionFailed) {
      continue;
    }

    const successfulReward = Number(orderBeforeAction?.flowerCurrencyReward);
    const finalizesOrder = action.finalizesOrder !== false;
    const isRejectAction = (action.steps || []).some((step) => step.type === "rejectCustomerOrder");
    let historyUpdate = null;
    let historyUpdateReason = "not-finalized";
    if (finalizesOrder && !isRejectAction) {
      if (!Number.isSafeInteger(successfulReward)
        || !CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD_VALUES.includes(successfulReward)) {
        throw new Error("customer order completed without a known selected reward value");
      }
      try {
        historyUpdate = await updateCustomerOrderFlowerCurrencyHistory({
          historyPath: customerOrderFlowerCurrencyHistory.historyPath,
          accountId: customerOrderFlowerCurrencyHistory.accountId,
          reward: successfulReward,
          completed: true,
          settlementStatus: "completed",
          now: actionTime.nowMs,
        });
        customerOrderFlowerCurrencyHistory = historyUpdate.account;
        console.log(JSON.stringify({
          step: "customerOrderFlowerCurrencyHistoryUpdated",
          cycle,
          customerStep: stepIndex,
          npcId: action.npcId,
          reward: successfulReward,
          updated: historyUpdate.updated,
          reason: historyUpdate.reason,
          historicalMaxReward: historyUpdate.account.historicalMaxReward,
          accountId: historyUpdate.account.accountId,
          historyPath: historyUpdate.filePath,
        }));
      } catch (err) {
        console.log(JSON.stringify({
          step: "customerOrderFlowerCurrencyHistoryUpdateFailed",
          cycle,
          customerStep: stepIndex,
          npcId: action.npcId,
          reward: successfulReward,
          accountId: customerOrderFlowerCurrencyHistory.accountId,
          historyPath: customerOrderFlowerCurrencyHistory.historyPath,
          warn: err.message,
        }));
        throw err;
      }
      historyUpdateReason = historyUpdate?.reason || "not-updated";
      next = removeCustomerOrder(next, action.npcId);
      console.log(JSON.stringify({
        step: "customerOrderLocalCleared",
        cycle,
        customerStep: stepIndex,
        npcId: action.npcId,
        reason: action.reason,
        outcome: actionOutcome.outcome,
        outcomeText: actionOutcome.outcomeText,
      }));
    } else if (finalizesOrder && isRejectAction) {
      historyUpdateReason = "reject-no-history-update";
      next = removeCustomerOrder(next, action.npcId);
      console.log(JSON.stringify({
        step: "customerOrderRejectCompleted",
        cycle,
        customerStep: stepIndex,
        npcId: action.npcId,
        iface: ORDER_CUSTOMER_IFACES.rejectOrder,
        reason: action.reason,
        reasonText: action.reasonText || orderBeforeAction?.actionText || null,
        outcome: actionOutcome.outcome,
        outcomeText: actionOutcome.outcomeText,
        historyUpdate: historyUpdateReason,
      }));
    } else {
      console.log(JSON.stringify({
        step: "customerOrderLocalKept",
        cycle,
        customerStep: stepIndex,
        npcId: action.npcId,
        reason: action.reason,
        outcome: actionOutcome.outcome,
        outcomeText: actionOutcome.outcomeText,
      }));
    }

    const handledAction = {
      ...action,
      ...actionOutcome,
      generationToFirstActionMs: customerOrderScheduler.snapshot().generationToFirstActionMs,
      makeToFinishDelayMs: actionTiming?.makeToFinishDelayMs
        ?? customerOrderScheduler.snapshot().lastMakeToFinishDelayMs,
      generationToFirstActionRequestStartMs: customerOrderScheduler.snapshot().generationToFirstActionMs,
      makeToFinishRequestStartDelayMs: actionTiming?.makeToFinishDelayMs
        ?? customerOrderScheduler.snapshot().lastMakeToFinishDelayMs,
      latencyMetricBasis: customerOrderScheduler.snapshot().latencyMetricBasis,
      requestStartedAtMs: actionTiming?.requestStartAtMs ?? null,
      responseAtMs: actionTiming?.responseAtMs ?? null,
      requestSequence: actionTiming?.requestSequence ?? null,
      failureCategory: actionOutcome.outcome === "completed" ? null : "action-outcome",
      customerOrderActionType: isRejectAction
        ? "rejectCustomerOrder"
        : action.steps?.some((step) => step.type === "makeFlowerArt")
          ? "makeFlowerArt"
          : "finishCustomerOrder",
      customerOrderRejectReasonText: isRejectAction
        ? action.reasonText || orderBeforeAction?.actionText || null
        : null,
      customerOrderFlowerCurrencyHistoryUpdate: historyUpdateReason,
      customerOrderHistoricalMaxRewardAfter:
        historyUpdate?.account?.historicalMaxReward
        ?? customerOrderFlowerCurrencyHistory.historicalMaxReward
        ?? null,
    };
    handledActions.push(handledAction);
    const historyEntry = recordCustomerOrderSubmission(runHistory, {
      cycle,
      action: handledAction,
      order: orderBeforeAction,
    });
    console.log(JSON.stringify({
      step: "customerOrderHistoryRecorded",
      cycle,
      historyEntry,
    }, null, 2));
    const isMakeAction = action.steps?.some((step) => step.type === "makeFlowerArt");
    const lazySyncAfterAction = await refreshLazySync(
      ws,
      gsToken,
      next,
      "customerOrderLazySyncAfterAction",
      isMakeAction
        ? {
          returnDetails: true,
          timeAuthorityNowFn: getCustomerOrderRequestClockFn(options),
          timeAuthorityMaxAgeMs: options.timeAuthorityMaxAgeMs,
        }
        : {},
    );
    next = isMakeAction ? lazySyncAfterAction.syncValue : lazySyncAfterAction;
    if (isMakeAction) {
      authoritativeActionPayloads.push({
        source: "customerOrderLazySyncAfterMake",
        value: lazySyncAfterAction.authoritativePayload,
      });
    }
    ws.observeSync?.(next, { cycle, customerOrderScheduler: customerOrderScheduler.snapshot() });
    const afterLazySyncPatch = applyLocalItemDeltaPatchesForUnchanged(next, localDeltaPatches);
    next = afterLazySyncPatch.syncValue;
    const postActionGenerationTime = getCustomerOrderTimeContext(next, options);
    const schedulerBeforeLazySync = customerOrderScheduler.snapshot();
    const postActionNextGenTimeMs = getCustomerOrderNextGenTimeMs(next);
    customerOrderScheduler.observeSync({
      nextGenTimeMs: Number.isFinite(postActionNextGenTimeMs) ? postActionNextGenTimeMs : null,
      nextGenTimeInvalid: Number.isNaN(postActionNextGenTimeMs),
      nowMs: postActionGenerationTime.nowMs,
    });
    const schedulerAfterLazySync = customerOrderScheduler.snapshot();
    if (schedulerAfterLazySync.nextGenTimeMs !== schedulerBeforeLazySync.nextGenTimeMs) {
      console.log(JSON.stringify({
        step: "customerOrderGenerationScheduleUpdated",
        cycle,
        customerStep: stepIndex,
        source: "customer-order-lazy-sync-after-action",
        nextGenTimeMs: schedulerAfterLazySync.nextGenTimeMs,
        dueAtMs: schedulerAfterLazySync.dueAtMs,
        timeTrusted: postActionGenerationTime.timeTrusted,
        timeAuthorityReason: postActionGenerationTime.timeAuthorityReason,
        customerOrderScheduler: schedulerAfterLazySync,
      }));
    }
    if (afterLazySyncPatch.appliedPatchCount > 0) {
      console.log(JSON.stringify({
        step: "customerOrderLocalDeltasPreservedAfterLazySync",
        cycle,
        customerStep: stepIndex,
        npcId: action.npcId,
        artId: action.artId,
        appliedPatchCount: afterLazySyncPatch.appliedPatchCount,
      }));
    }
    if (!finalizesOrder && isMakeAction) {
      const madeArtCount = (action.steps || [])
        .filter((step) => step.type === "makeFlowerArt")
        .reduce((sum, step) => sum + Math.max(0, Math.floor(Number(step.args?.num || 0))), 0);
      const beforeArtCount = Math.max(0, Math.floor(Number(
        makeBeforeArtCount ?? orderBeforeAction?.haveArt ?? 0,
      )));
      const maxArtCountAfterMake = beforeArtCount + madeArtCount;
      const expectedCount = Number(orderBeforeAction?.needArt || maxArtCountAfterMake || action.steps?.[0]?.args?.num || 0);
      const authority = resolveCustomerOrderArtAuthority({
        payloads: authoritativeActionPayloads,
        itemId: action.artId,
        baselineCount: beforeArtCount,
        expectedCount,
      });
      const mergedArtCount = getItemCount(next, action.artId);
      const confirmedArtCount = authority.confirmedArtCount;
      if (authority.confirmed && confirmedArtCount != null) {
        next = setLocalItemCount(next, action.artId, confirmedArtCount);
      } else {
        next = setLocalItemCount(next, action.artId, beforeArtCount);
        skippedCustomerNpcIds.add(Number(action.npcId));
      }
      console.log(JSON.stringify({
        step: "customerOrderAuthoritativeSyncAfterMake",
        cycle,
        customerStep: stepIndex,
        npcId: action.npcId,
        artId: action.artId,
        expectedCount,
        confirmedArtCount,
        mergedArtCount,
        confirmed: authority.confirmed,
        confirmationKnown: authority.confirmationKnown,
        syncSource: authority.syncSource,
        authorityEvidence: authority.authorityEvidence,
        failureCategory: authority.failureCategory,
      }));
      if (!authority.confirmed) {
        const pendingArtSync = {
          artId: action.artId,
          expectedCount,
          reason: "make-flower-art-unconfirmed",
        };
        next = markCustomerOrderPendingArtSync(next, action.npcId, pendingArtSync);
        console.log(JSON.stringify({
          step: "customerOrderArtSyncPending",
          cycle,
          customerStep: stepIndex,
          npcId: action.npcId,
          artId: action.artId,
          expectedCount,
          confirmedArtCount,
          confirmationKnown: authority.confirmationKnown,
          failureCategory: authority.failureCategory,
          reason: pendingArtSync.reason,
        }));
      }
    }
    orderStatus = logOrderStatusParsed(next, {
      cycle,
      mode: process.env.ACTION || "once",
      phase: "customerAfterAction",
      customerStep: stepIndex,
      lastCustomerAction: handledAction,
      teamOrderCapability: teamOrderRuntime?.capability(next),
      customerOrderFlowerCurrencyHistory,
      ...customerOrderRewardReleaseContext,
      ...customerOrderStatusConfig,
      flowerNames,
      ...orderTimeOptions,
    });
    if (finalizesOrder) {
      const postActionRefresh = await refreshCustomerOrders(
        ws,
        gsToken,
        next,
        isRejectAction ? "customerOrderGenAfterReject" : "customerOrderGenAfterFinish",
        {
          ...options,
          flowerNames,
          actionTime: getCustomerOrderTimeContext(next, options),
          customerOrderFlowerCurrencyHistory,
          customerOrderScheduler,
          returnGenerationResult: true,
        },
      );
      next = postActionRefresh.syncValue;
      const reassessmentStatus = summarizeOrderCustomerStatus(next, {
        nameMap: flowerNames,
        customerOrderFlowerCurrencyRewardReleaseMask: rewardReleaseMask,
        customerOrderFlowerCurrencyHistory,
        nowMs: getCustomerOrderTimeContext(next, options).nowMs,
        ...(Object.hasOwn(options, "orderCustomerNpcConfig")
          ? { orderCustomerNpcConfig: options.orderCustomerNpcConfig }
          : {}),
        ...(Object.hasOwn(options, "flowerArtConfig")
          ? { flowerArtConfig: options.flowerArtConfig }
          : {}),
      });
      console.log(JSON.stringify({
        step: "customerOrderGenerationReassessment",
        cycle,
        customerStep: stepIndex,
        npcId: action.npcId,
        finalizationType: isRejectAction ? "reject" : "finish",
        reassessmentDepth: 0,
        attempted: postActionRefresh.attempted === true,
        requestSucceeded: postActionRefresh.requestSucceeded === true,
        generated: postActionRefresh.generated === true,
        generatedOrderCount: postActionRefresh.generatedOrderCount ?? 0,
        decision: postActionRefresh.reason || null,
        requestStartedAtMs: postActionRefresh.requestStartedAtMs ?? null,
        responseAtMs: postActionRefresh.responseAtMs ?? null,
        newOrderNpcIds: postActionRefresh.newOrderNpcIds || [],
        duplicateOrderNpcIds: postActionRefresh.duplicateOrderNpcIds || [],
        dedupeResult: postActionRefresh.dedupeResult || null,
        queue: getCustomerOrderQueueSnapshot(
          reassessmentStatus,
          getAutoSubmitCustomerOrderActions(reassessmentStatus),
        ),
        customerOrderScheduler: customerOrderScheduler.snapshot(),
      }));
      if (postActionRefresh.generated) {
        console.log(JSON.stringify({
          step: "customerOrderGenerationAfterFinalization",
          cycle,
          npcId: action.npcId,
          finalizationType: isRejectAction ? "reject" : "finish",
          generatedOrderCount: postActionRefresh.generatedOrderCount,
          generationAtMs: postActionRefresh.generationAtMs,
          customerOrderScheduler: customerOrderScheduler.snapshot(),
        }));
      }
      orderStatus = logOrderStatusParsed(next, {
        cycle,
        mode: process.env.ACTION || "once",
        phase: "customerAfterFinalizationGenerationCheck",
        customerStep: stepIndex,
        lastCustomerAction: handledAction,
        teamOrderCapability: teamOrderRuntime?.capability(next),
        customerOrderFlowerCurrencyHistory,
        ...customerOrderRewardReleaseContext,
        ...customerOrderStatusConfig,
        flowerNames,
        ...orderTimeOptions,
      });
    }
  }

  console.log(JSON.stringify({
    step: "customerOrderActionLimitReached",
    cycle,
    maxSteps,
    actionCount: handledActions.length,
  }));
  return { syncValue: next, actionCount: handledActions.length, actions: handledActions, orderStatus };
}

async function plantEmptyLands(ws, gsToken, syncValue, recommendation, options = {}) {
  const emptyLandIds = recommendation.emptyLandIds;
  const flowerId = Number(process.env.FLOWER_ID || recommendation.plantFlower?.flowerId);
  if (!emptyLandIds.length) {
    console.log(JSON.stringify({ step: "plantEmptySkip", reason: "no-empty-land" }));
    return { syncValue, plantedCount: 0, flowerId: flowerId || null };
  }
  if (!flowerId) throw new Error("No plant candidate available for plant-empty");

  const maxPlantCount = options.maxPlantCount == null
    ? emptyLandIds.length
    : Math.max(0, Math.floor(Number(options.maxPlantCount) || 0));
  if (maxPlantCount <= 0) {
    console.log(JSON.stringify({
      step: "plantEmptySkip",
      reason: options.skipReason || "no-water-for-plant",
      emptyLandCount: emptyLandIds.length,
      waterDropCount: options.waterDropCount ?? null,
      seededBacklogCount: options.seededBacklogCount ?? null,
    }));
    return { syncValue, plantedCount: 0, flowerId };
  }
  const landIds = emptyLandIds.slice(0, maxPlantCount);
  console.log(JSON.stringify({ step: "plantEmptyPlan", landCount: landIds.length, flowerId, firstLandId: landIds[0], lastLandId: landIds[landIds.length - 1] }));
  let next = syncValue;
  let plantedBy = "plantBatch";
  if (options.preferSingle === true) {
    plantedBy = "plant";
    for (const landId of landIds) {
      const one = await requestSync(ws, gsToken, "gs.usrLand.plant", { landId, flowerId }, `Plant failed on land ${landId}`);
      next = mergeLandSync(next, one.value);
    }
  } else {
    let plantRaw = await ws.request("gs.usrLand.plantBatch", { landIds, flowerId }, gsToken);
    let plant = washResponse(plantRaw);
    if (plant.errMsg && options.noFallback !== true && process.env.NO_PLANT_FALLBACK !== "1") {
      plantedBy = "plant";
      for (const landId of landIds) {
        const one = await requestSync(ws, gsToken, "gs.usrLand.plant", { landId, flowerId }, `Plant failed on land ${landId}`);
        next = mergeLandSync(next, one.value);
      }
    } else {
      if (plant.errMsg) throw new Error(`Plant batch failed: ${JSON.stringify(plant.errMsg)}`);
      next = mergeLandSync(next, plant.value);
    }
  }
  console.log(JSON.stringify({ step: "plantEmpty", plantedBy, landCount: landIds.length, flowerId }));
  return { syncValue: next, plantedCount: landIds.length, flowerId };
}

async function plantOneLand(ws, gsToken, syncValue, landId, flowerId) {
  if (!landId) return { syncValue, plantedCount: 0, flowerId: flowerId || null, landId: null };
  if (!flowerId) throw new Error("No plant candidate available for plant-one");

  console.log(JSON.stringify({ step: "plantOnePlan", landId, flowerId }));
  const planted = await requestSync(ws, gsToken, "gs.usrLand.plant", { landId, flowerId }, `Plant failed on land ${landId}`);
  const next = mergeLandSync(syncValue, planted.value);
  console.log(JSON.stringify({ step: "plantOne", plantedBy: "plant", landId, flowerId }));
  return { syncValue: next, plantedCount: 1, flowerId, landId };
}

const PLANT_LAND_GROUP_SIZE = 16;
const PLANT_LAND_GROUP_BASE_ID = 1001;
const PLANT_LAND_GROUP_WINDOW_MS = 60 * 1000;
const PLANT_LAND_GROUP_WINDOW_SECONDS = Math.floor(PLANT_LAND_GROUP_WINDOW_MS / 1000);
const PLANT_LAND_GROUP_WINDOW_BLOCK_REASONS = new Set([
  "existing-land-group-mature-window-exceeded",
  "predicted-land-group-mature-window-exceeded",
]);

function getPlantingRuleStatus() {
  return {
    keepGroupMatureWindow: true,
    groupSize: PLANT_LAND_GROUP_SIZE,
    groupBaseLandId: PLANT_LAND_GROUP_BASE_ID,
    groupMatureWindowMs: PLANT_LAND_GROUP_WINDOW_MS,
    groupMatureWindowSeconds: PLANT_LAND_GROUP_WINDOW_SECONDS,
    ruleText: "保留同组同熟窗口：同一 16 块地分组的当前或预测成熟跨度超过 60 秒时，即使水滴足够也跳过补种。",
  };
}

function plantingBlockerReasonText(reason) {
  if (PLANT_LAND_GROUP_WINDOW_BLOCK_REASONS.has(reason)) return "保留同组同熟窗口导致跳过补种";
  if (reason === "waiting-water-for-land-group") return "水滴不足，等待补水后再补种";
  if (reason === "waiting-empty-for-land-group") return "同组土地未全部空出，等待整组空出后再种植";
  if (reason === "cycle-land-group-window-exceeded") return "本轮同组补种耗时超过窗口，停止继续补种";
  if (reason === "mixed-land-group-flower") return "同组已有不同目标花，跳过补种";
  return reason || "-";
}

function durationTextOrNull(ms) {
  return ms == null ? null : formatDuration(ms);
}

function decoratePlantingBlocker(blocker) {
  const reason = blocker?.reason || "unknown";
  const emptyLandIds = Array.isArray(blocker?.emptyLandIds) ? blocker.emptyLandIds : [];
  return {
    type: "land-group",
    reason,
    reasonText: plantingBlockerReasonText(reason),
    keptByGroupMatureWindowRule: PLANT_LAND_GROUP_WINDOW_BLOCK_REASONS.has(reason),
    groupKey: blocker?.groupKey ?? null,
    groupIndex: blocker?.groupIndex ?? null,
    groupStartId: blocker?.groupStartId ?? null,
    groupEndId: blocker?.groupEndId ?? null,
    actualGroupSize: blocker?.actualGroupSize ?? null,
    maxGroupSize: blocker?.maxGroupSize ?? PLANT_LAND_GROUP_SIZE,
    source: blocker?.source ?? null,
    flowerId: blocker?.flowerId ?? null,
    existingFlowerIds: blocker?.existingFlowerIds || [],
    emptyLandIds,
    emptyLandCount: emptyLandIds.length,
    requiredWaterCount: blocker?.requiredWaterCount ?? null,
    waterDropCount: blocker?.waterDropCount ?? null,
    elapsedMs: blocker?.elapsedMs ?? null,
    elapsedText: durationTextOrNull(blocker?.elapsedMs),
    currentMatureSpanMs: blocker?.currentMatureSpanMs ?? null,
    currentMatureSpanText: durationTextOrNull(blocker?.currentMatureSpanMs),
    predictedMatureSpanMs: blocker?.predictedMatureSpanMs ?? null,
    predictedMatureSpanText: durationTextOrNull(blocker?.predictedMatureSpanMs),
    groupMatureWindowMs: PLANT_LAND_GROUP_WINDOW_MS,
    groupMatureWindowSeconds: PLANT_LAND_GROUP_WINDOW_SECONDS,
  };
}

function getPlantingBlockersFromSummary(summary = {}) {
  const groups = [
    ...(Array.isArray(summary.blockedPlantGroups) ? summary.blockedPlantGroups : []),
    ...(Array.isArray(summary.waterBlockedPlantGroups) ? summary.waterBlockedPlantGroups : []),
  ];
  return groups.map(decoratePlantingBlocker);
}

function formatPlantingBlockerStatus(blockers = []) {
  if (!blockers.length) return "暂无同熟窗口阻断";
  const first = blockers[0];
  const emptyLandCount = blockers.reduce((sum, item) => sum + (Number(item.emptyLandCount) || 0), 0);
  return `${first.reasonText}：空地 ${emptyLandCount}，水滴 ${first.waterDropCount ?? "-"}，组 ${first.groupIndex ?? first.groupKey ?? "-"}，目标花 ${first.flowerId ?? "-"}，当前成熟跨度 ${first.currentMatureSpanText ?? first.currentMatureSpanMs ?? "-"}，预测成熟跨度 ${first.predictedMatureSpanText ?? first.predictedMatureSpanMs ?? "-"}`;
}

function getPlantLandGroup(syncValue, landId) {
  const targetLandId = Number(landId);
  const rows = getState(syncValue).land.rows
    .map((row) => ({ ...row, landId: Number(row.landId), flowerId: Number(row.flowerId) || 0 }))
    .sort((a, b) => a.landId - b.landId);
  const index = rows.findIndex((row) => row.landId === targetLandId);
  if (index < 0) {
    return {
      groupIndex: null,
      groupKey: `land:${targetLandId}`,
      groupLandIds: [targetLandId],
      groupRows: [],
    };
  }

  const fixedRange = targetLandId >= PLANT_LAND_GROUP_BASE_ID;
  const groupIndex = fixedRange
    ? Math.floor((targetLandId - PLANT_LAND_GROUP_BASE_ID) / PLANT_LAND_GROUP_SIZE)
    : Math.floor(index / PLANT_LAND_GROUP_SIZE);
  const groupStartId = fixedRange
    ? PLANT_LAND_GROUP_BASE_ID + groupIndex * PLANT_LAND_GROUP_SIZE
    : rows[groupIndex * PLANT_LAND_GROUP_SIZE]?.landId ?? targetLandId;
  const groupEndId = fixedRange
    ? groupStartId + PLANT_LAND_GROUP_SIZE - 1
    : rows[Math.min(rows.length - 1, groupIndex * PLANT_LAND_GROUP_SIZE + PLANT_LAND_GROUP_SIZE - 1)]?.landId ?? groupStartId;
  const groupRows = fixedRange
    ? rows.filter((row) => row.landId >= groupStartId && row.landId <= groupEndId)
    : rows.slice(groupIndex * PLANT_LAND_GROUP_SIZE, groupIndex * PLANT_LAND_GROUP_SIZE + PLANT_LAND_GROUP_SIZE);
  const groupLandIds = groupRows.map((row) => row.landId);
  return {
    groupIndex,
    groupStartId,
    groupEndId,
    groupKey: `${groupStartId}-${groupEndId}`,
    groupLandIds,
    groupRows,
  };
}

function chooseExistingGroupFlowerId(groupRows) {
  const stats = new Map();
  for (const [index, row] of groupRows.entries()) {
    const flowerId = Number(row.flowerId) || 0;
    if (!flowerId || row.empty) continue;
    const current = stats.get(flowerId) || { flowerId, count: 0, firstIndex: index };
    current.count += 1;
    stats.set(flowerId, current);
  }
  return [...stats.values()]
    .sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex || a.flowerId - b.flowerId)[0]?.flowerId || 0;
}

function nonEmptyGroupFlowerIds(groupRows) {
  return [...new Set(groupRows
    .filter((row) => !row.empty)
    .map((row) => Number(row.flowerId) || 0)
    .filter(Boolean))];
}

function selectPlantLandGroupFlower(syncValue, landId, fallbackFlowerId, groupTargets, options = {}) {
  const group = getPlantLandGroup(syncValue, landId);
  const forcedFlowerId = Number(options.forcedFlowerId) || 0;
  if (forcedFlowerId) {
    groupTargets.set(group.groupKey, forcedFlowerId);
    return { ...group, flowerId: forcedFlowerId, source: "forced-flower-id" };
  }

  const existingFlowerId = chooseExistingGroupFlowerId(group.groupRows);
  if (existingFlowerId) {
    groupTargets.set(group.groupKey, existingFlowerId);
    return { ...group, flowerId: existingFlowerId, source: "existing-land-group" };
  }

  const cachedFlowerId = Number(groupTargets.get(group.groupKey)) || 0;
  if (cachedFlowerId) {
    return { ...group, flowerId: cachedFlowerId, source: "cached-land-group" };
  }

  const flowerId = Number(fallbackFlowerId) || 0;
  if (flowerId) groupTargets.set(group.groupKey, flowerId);
  return { ...group, flowerId, source: "recommended-land-group" };
}

function getSortedPlantLandGroups(syncValue) {
  const groups = new Map();
  const rows = getState(syncValue).land.rows
    .map((row) => ({ ...row, landId: Number(row.landId) }))
    .filter((row) => Number.isFinite(row.landId))
    .sort((a, b) => a.landId - b.landId);
  for (const row of rows) {
    const group = getPlantLandGroup(syncValue, row.landId);
    if (!groups.has(group.groupKey)) groups.set(group.groupKey, group);
  }
  return [...groups.values()].sort((a, b) => {
    const ai = Number.isFinite(a.groupIndex) ? a.groupIndex : Number.MAX_SAFE_INTEGER;
    const bi = Number.isFinite(b.groupIndex) ? b.groupIndex : Number.MAX_SAFE_INTEGER;
    const as = Number.isFinite(a.groupStartId) ? a.groupStartId : (a.groupLandIds?.[0] ?? Number.MAX_SAFE_INTEGER);
    const bs = Number.isFinite(b.groupStartId) ? b.groupStartId : (b.groupLandIds?.[0] ?? Number.MAX_SAFE_INTEGER);
    return as - bs || ai - bi;
  });
}

function getPlantLandGroupSortIndex(sortedGroups, groupSelection) {
  const directIndex = sortedGroups.findIndex((group) => group.groupKey === groupSelection.groupKey);
  if (directIndex >= 0) return directIndex;
  const groupIndex = Number(groupSelection.groupIndex);
  return Number.isFinite(groupIndex) && groupIndex >= 0 ? groupIndex : 0;
}

function resolvePlantLandGroupFlower(syncValue, groupSelection, fallbackFlowerId, groupTargets, options = {}) {
  const forcedFlowerId = Number(options.forcedFlowerId) || 0;
  if (forcedFlowerId) {
    groupTargets.set(groupSelection.groupKey, forcedFlowerId);
    return { flowerId: forcedFlowerId, source: "forced-flower-id" };
  }

  const existingFlowerId = chooseExistingGroupFlowerId(groupSelection.groupRows);
  if (existingFlowerId) {
    groupTargets.set(groupSelection.groupKey, existingFlowerId);
    return { flowerId: existingFlowerId, source: "existing-land-group" };
  }

  const cachedFlowerId = Number(groupTargets.get(groupSelection.groupKey)) || 0;
  if (cachedFlowerId) return { flowerId: cachedFlowerId, source: "cached-land-group" };

  const plantCandidates = Array.isArray(options.plantCandidates)
    ? options.plantCandidates
    : summarizePlantCandidates(syncValue);
  const sortedGroups = Array.isArray(options.sortedGroups)
    ? options.sortedGroups
    : getSortedPlantLandGroups(syncValue);
  const groupSortIndex = getPlantLandGroupSortIndex(sortedGroups, groupSelection);
  const mappedFlowerId = Number(plantCandidates[groupSortIndex]?.flowerId) || 0;
  if (mappedFlowerId) {
    groupTargets.set(groupSelection.groupKey, mappedFlowerId);
    return { flowerId: mappedFlowerId, source: "sorted-land-group-candidate" };
  }

  const flowerId = Number(fallbackFlowerId) || 0;
  if (flowerId) groupTargets.set(groupSelection.groupKey, flowerId);
  return { flowerId, source: "recommended-land-group" };
}

function getPlantGroupEmptyLandIds(groupRows) {
  return groupRows
    .filter((row) => row.empty)
    .map((row) => Number(row.landId))
    .filter((id) => Number.isFinite(id))
    .sort((a, b) => a - b);
}

function getSeededLandGroup(syncValue, landId) {
  const groupSelection = getPlantLandGroup(syncValue, landId);
  const seededLandIds = groupSelection.groupRows
    .filter((row) => Number(row.state) === 1)
    .map((row) => Number(row.landId))
    .filter((id) => Number.isFinite(id))
    .sort((a, b) => a - b);
  return {
    ...groupSelection,
    seededLandIds,
    requiredWaterCount: seededLandIds.length,
    actualGroupSize: groupSelection.groupLandIds.length || seededLandIds.length,
  };
}

function getFirstSeededLandGroup(syncValue) {
  const seeded = getState(syncValue).land.rows.find((row) => row.state === 1);
  return seeded ? getSeededLandGroup(syncValue, seeded.landId) : null;
}

function getPlantLandGroupCandidates(syncValue, fallbackFlowerId, groupTargets, options = {}) {
  const forcedFlowerId = Number(options.forcedFlowerId) || 0;
  const emptyLandIds = getState(syncValue).recommendation.emptyLandIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id))
    .sort((a, b) => a - b);
  const seenGroupKeys = new Set();
  const candidates = [];
  for (const landId of emptyLandIds) {
    const groupSelection = getPlantLandGroup(syncValue, landId);
    if (seenGroupKeys.has(groupSelection.groupKey)) continue;
    seenGroupKeys.add(groupSelection.groupKey);
    const emptyGroupLandIds = getPlantGroupEmptyLandIds(groupSelection.groupRows);
    if (!emptyGroupLandIds.length) continue;
    const actualGroupSize = groupSelection.groupLandIds.length || emptyGroupLandIds.length;
    candidates.push({
      ...groupSelection,
      startLandId: emptyGroupLandIds[0],
      emptyLandIds: emptyGroupLandIds,
      actualGroupSize,
      wholeGroupEmpty: emptyGroupLandIds.length === actualGroupSize,
      requiredWaterCount: actualGroupSize,
    });
  }
  const sortedCandidates = candidates.sort((a, b) => {
    const ai = Number.isFinite(a.groupIndex) ? a.groupIndex : Number.MAX_SAFE_INTEGER;
    const bi = Number.isFinite(b.groupIndex) ? b.groupIndex : Number.MAX_SAFE_INTEGER;
    return ai - bi || a.startLandId - b.startLandId;
  });
  const plantCandidates = summarizePlantCandidates(syncValue);
  const sortedGroups = getSortedPlantLandGroups(syncValue);
  return sortedCandidates.map((candidate) => {
    const resolved = resolvePlantLandGroupFlower(
      syncValue,
      candidate,
      fallbackFlowerId,
      groupTargets,
      { forcedFlowerId, plantCandidates, sortedGroups },
    );
    return {
      ...candidate,
      flowerId: resolved.flowerId,
      source: resolved.source,
    };
  });
}

function getFlowerMaturityMs(syncValue, flowerId) {
  const targetFlowerId = Number(flowerId) || 0;
  if (!targetFlowerId) return null;
  const item = getCultivatedFlowerInventory(syncValue).find((row) => Number(row.flowerId) === targetFlowerId);
  const seconds = Number(item?.maturitySeconds);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function groupNextTimeStats(groupRows, flowerId, nowMs = Date.now()) {
  const targetFlowerId = Number(flowerId) || 0;
  const times = groupRows
    .filter((row) => !row.empty)
    .filter((row) => !targetFlowerId || Number(row.flowerId) === targetFlowerId)
    .map((row) => row.nextTime ? Date.parse(row.nextTime) : 0)
    .filter((time) => Number.isFinite(time) && time > nowMs)
    .sort((a, b) => a - b);
  if (!times.length) return { count: 0, minMs: null, maxMs: null, spanMs: 0 };
  const minMs = times[0];
  const maxMs = times[times.length - 1];
  return { count: times.length, minMs, maxMs, spanMs: maxMs - minMs };
}

function getPlantLandGroupWindowDecision(syncValue, groupSelection, groupStartedAtMs, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const flowerId = Number(groupSelection?.flowerId) || 0;
  if (!flowerId) return { ok: false, reason: "no-flower-id" };

  const existingFlowerIds = nonEmptyGroupFlowerIds(groupSelection.groupRows);
  if (existingFlowerIds.length === 1 && existingFlowerIds[0] !== flowerId) {
    return {
      ok: false,
      reason: "existing-land-group-flower-mismatch",
      existingFlowerIds,
      flowerId,
    };
  }

  if (groupStartedAtMs && nowMs - groupStartedAtMs > PLANT_LAND_GROUP_WINDOW_MS) {
    return {
      ok: false,
      reason: "cycle-land-group-window-exceeded",
      elapsedMs: nowMs - groupStartedAtMs,
      windowMs: PLANT_LAND_GROUP_WINDOW_MS,
    };
  }

  const nextTimeStats = groupNextTimeStats(groupSelection.groupRows, flowerId, nowMs);
  if (nextTimeStats.spanMs > PLANT_LAND_GROUP_WINDOW_MS) {
    return {
      ok: false,
      reason: "existing-land-group-mature-window-exceeded",
      ...nextTimeStats,
      windowMs: PLANT_LAND_GROUP_WINDOW_MS,
    };
  }

  const maturityMs = getFlowerMaturityMs(syncValue, flowerId);
  if (!groupStartedAtMs && nextTimeStats.count && maturityMs) {
    const predictedNextTimeMs = nowMs + maturityMs;
    const minMs = Math.min(nextTimeStats.minMs, predictedNextTimeMs);
    const maxMs = Math.max(nextTimeStats.maxMs, predictedNextTimeMs);
    const predictedSpanMs = maxMs - minMs;
    if (predictedSpanMs > PLANT_LAND_GROUP_WINDOW_MS) {
      return {
        ok: false,
        reason: "predicted-land-group-mature-window-exceeded",
        ...nextTimeStats,
        predictedNextTimeMs,
        predictedSpanMs,
        maturityMs,
        windowMs: PLANT_LAND_GROUP_WINDOW_MS,
      };
    }
  }

  return {
    ok: true,
    reason: existingFlowerIds.length > 1 ? "mixed-existing-land-group-healing" : "within-land-group-window",
    existingFlowerIds,
    ...nextTimeStats,
    maturityMs,
    windowMs: PLANT_LAND_GROUP_WINDOW_MS,
  };
}

function getPlantWaterRefillContext(syncValue) {
  const threshold = getPlantWaterRefillThreshold();
  const waterDrop = getWaterDropStatus(syncValue);
  const authority = getWaterDropAuthority(syncValue);
  const waterDropActionable = isActionableWaterDropAuthority(authority);
  const state = getState(syncValue);
  const waterDropCount = waterDrop.count;
  const serverWaterDropCount = waterDropActionable ? authority.serverWaterDropCount : null;
  const decisionWaterDropCount = serverWaterDropCount ?? waterDropCount;
  const waterDropTrust = waterDropActionable
    ? "authoritative"
    : authority.trust === "unknown"
      ? "unknown"
      : "partial";
  const seededBacklogCount = state.land.rows.filter((row) => row.state === 1).length;
  const emptyLandCount = state.recommendation.emptyLandIds.length;

  const base = {
    threshold,
    waterDropCount,
    decisionWaterDropCount,
    waterDropText: `${waterDrop.count}/${waterDrop.displayLimit}`,
    waterDropLow: decisionWaterDropCount < threshold,
    waterDropTrust,
    waterDropAuthoritative: waterDropActionable,
    waterDropActionable,
    serverWaterDropCount,
    serverWaterDropReason: authority.serverWaterDropReason,
    serverWaterDropSourcePath: authority.sourcePath,
    waterDropAuthorityTrust: authority.trust,
    waterDropAuthorityLabel: authority.label,
    seededBacklogCount,
    emptyLandCount,
    needsPlanting: false,
  };

  if (seededBacklogCount) {
    const seededGroup = getFirstSeededLandGroup(syncValue);
    const seededThreshold = Math.max(1, Number(seededGroup?.requiredWaterCount) || seededBacklogCount);
    const waterKnown = waterDropActionable;
    const seededDecisionWaterDropCount = waterKnown ? Number(serverWaterDropCount) : waterDropCount;
    const waterEnough = waterKnown && seededDecisionWaterDropCount >= seededThreshold;
    return {
      ...base,
      threshold: seededThreshold,
      decisionWaterDropCount: seededDecisionWaterDropCount,
      waterDropLow: seededDecisionWaterDropCount < seededThreshold,
      needsPlanting: true,
      needsWater: !waterEnough,
      refillTarget: "seeded-land-group",
      reason: !waterKnown ? "waiting-authoritative-water-drop" : waterEnough ? "seeded-water-enough" : "seeded-water-refill-needed",
      reasonText: waterEnough
        ? `已种未浇土地组水滴足够，先浇完整组 ${seededDecisionWaterDropCount} >= ${seededThreshold}`
        : `已种未浇土地组需要补水，当前权威水滴 ${seededDecisionWaterDropCount} < ${seededThreshold}`,
      groupKey: seededGroup?.groupKey ?? null,
      groupIndex: seededGroup?.groupIndex ?? null,
      groupStartId: seededGroup?.groupStartId ?? null,
      groupEndId: seededGroup?.groupEndId ?? null,
      actualGroupSize: seededGroup?.actualGroupSize ?? seededBacklogCount,
      maxGroupSize: PLANT_LAND_GROUP_SIZE,
      requiredWaterCount: seededThreshold,
      seededLandIds: seededGroup?.seededLandIds || [],
      seededLandCount: seededGroup?.seededLandIds?.length ?? seededBacklogCount,
    };
  }

  if (seededBacklogCount) {
    return {
      ...base,
      reason: "seeded-backlog-before-plant",
      reasonText: "存在已种未浇水土地，先处理已种土地，不领取补水",
    };
  }

  if (!emptyLandCount) {
    return {
      ...base,
      reason: "no-empty-land",
      reasonText: "当前没有空地需要种植",
    };
  }

  const forcedFlowerId = Number(process.env.FLOWER_ID) || 0;
  const fallbackFlowerId = forcedFlowerId || state.recommendation.plantFlower?.flowerId;
  const candidates = getPlantLandGroupCandidates(
    syncValue,
    fallbackFlowerId,
    new Map(),
    { forcedFlowerId },
  );
  const blockedGroups = [];

  for (const candidate of candidates) {
    const candidateThreshold = Math.max(1, Number(candidate.requiredWaterCount) || threshold);
    if (!candidate.wholeGroupEmpty) {
      blockedGroups.push({
        groupKey: candidate.groupKey,
        groupIndex: candidate.groupIndex,
        groupStartId: candidate.groupStartId,
        groupEndId: candidate.groupEndId,
        actualGroupSize: candidate.actualGroupSize ?? candidate.groupLandIds.length,
        maxGroupSize: PLANT_LAND_GROUP_SIZE,
        reason: "waiting-empty-for-land-group",
        flowerId: candidate.flowerId,
        emptyLandIds: candidate.emptyLandIds,
        requiredWaterCount: candidateThreshold,
        waterDropCount,
      });
      continue;
    }

    const groupWindow = getPlantLandGroupWindowDecision(syncValue, candidate, null);
    if (!groupWindow.ok) {
      blockedGroups.push({
        groupKey: candidate.groupKey,
        groupIndex: candidate.groupIndex,
        groupStartId: candidate.groupStartId,
        groupEndId: candidate.groupEndId,
        actualGroupSize: candidate.actualGroupSize ?? candidate.groupLandIds.length,
        maxGroupSize: PLANT_LAND_GROUP_SIZE,
        reason: groupWindow.reason,
        flowerId: candidate.flowerId,
        emptyLandIds: candidate.emptyLandIds,
        requiredWaterCount: candidateThreshold,
        waterDropCount,
      });
      continue;
    }

    return {
      ...base,
      threshold: candidateThreshold,
      waterDropLow: decisionWaterDropCount < candidateThreshold,
      needsPlanting: true,
      reason: !waterDropActionable
        ? "waiting-authoritative-water-drop"
        : decisionWaterDropCount < candidateThreshold ? "plant-water-refill-needed" : "plant-water-enough",
      reasonText: !waterDropActionable
        ? "waiting authoritative water drop before planting"
        : decisionWaterDropCount < candidateThreshold
          ? `plant group needs water: ${decisionWaterDropCount} < ${candidateThreshold}`
          : `plant group water ready: ${decisionWaterDropCount} >= ${candidateThreshold}`,
      groupKey: candidate.groupKey,
      groupIndex: candidate.groupIndex,
      groupStartId: candidate.groupStartId,
      groupEndId: candidate.groupEndId,
      actualGroupSize: candidate.actualGroupSize ?? candidate.groupLandIds.length,
      maxGroupSize: PLANT_LAND_GROUP_SIZE,
      requiredWaterCount: candidateThreshold,
      emptyLandIds: candidate.emptyLandIds,
      flowerId: candidate.flowerId,
      flowerSource: candidate.source,
    };
  }

  return {
    ...base,
    reason: blockedGroups.some((group) => group.reason === "waiting-empty-for-land-group")
      ? "waiting-empty-for-land-group"
      : candidates.length
        ? "no-eligible-empty-land"
        : "no-plant-candidate",
    reasonText: blockedGroups.some((group) => group.reason === "waiting-empty-for-land-group")
      ? plantingBlockerReasonText("waiting-empty-for-land-group")
      : candidates.length
        ? "当前空地组暂不满足同组种植窗口"
        : "当前没有可种植的土地组",
    blockedGroups,
  };
}

function isWaterDropShortageError(err) {
  if (!err || typeof err !== "object") return false;
  return Number(err.code) === 301 && Number(err.param?.iid) === 7;
}

function countActuallyWateredLands(beforeSync, afterSync, targetLandIds) {
  const beforeRows = new Map(getState(beforeSync).land.rows.map((row) => [Number(row.landId), row]));
  const afterRows = new Map(getState(afterSync).land.rows.map((row) => [Number(row.landId), row]));
  return targetLandIds.reduce((count, landId) => {
    const before = beforeRows.get(Number(landId));
    const after = afterRows.get(Number(landId));
    if (before?.state === 1 && after && after.state !== 1) return count + 1;
    return count;
  }, 0);
}

function hasOwnItemValue(map, itemId) {
  if (!map || typeof map !== "object") return false;
  return Object.prototype.hasOwnProperty.call(map, itemId)
    || Object.prototype.hasOwnProperty.call(map, String(itemId));
}

function readOwnItemValue(map, itemId) {
  if (!hasOwnItemValue(map, itemId)) return null;
  const raw = Object.prototype.hasOwnProperty.call(map, itemId) ? map[itemId] : map[String(itemId)];
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function getExplicitWaterDropCountFromResponse(value) {
  const usrTot = value?.$usrTot || {};
  const data = usrTot.data || usrTot.usr || {};
  const waterItemId = ITEM_IDS.WATER_DROP;
  let explicitBaseCount = null;
  for (const map of [data.bag, data.itemMap, usrTot.bag, usrTot.itemMap]) {
    const count = readOwnItemValue(map, waterItemId);
    if (count != null) {
      explicitBaseCount = Math.max(0, Math.floor(count));
      break;
    }
  }
  if (explicitBaseCount == null) return null;

  const hasRestoreExt = hasOwnItemValue(data.itemExtMap, waterItemId)
    || hasOwnItemValue(data.itemExt, waterItemId)
    || hasOwnItemValue(usrTot.itemExtMap, waterItemId)
    || hasOwnItemValue(usrTot.itemExt, waterItemId);
  if (hasRestoreExt) return getWaterDropStatus(value).count;
  return explicitBaseCount;
}

async function waterSeededLands(ws, gsToken, syncValue) {
  const state = getState(syncValue);
  const landIds = state.land.rows.filter((row) => row.state === 1).map((row) => row.landId);
  if (!landIds.length || process.env.AUTO_WATER === "0") {
    console.log(JSON.stringify({ step: "waterSeededSkip", reason: landIds.length ? "disabled" : "no-seeded-land", seededCount: landIds.length }));
    return { syncValue, wateredCount: 0 };
  }

  const waterBefore = getWaterDropStatus(syncValue);
  if (waterBefore.count <= 0) {
    console.log(JSON.stringify({ step: "waterSeededSkip", reason: "no-water-drop", seededCount: landIds.length, waterDropCount: waterBefore.count }));
    return { syncValue, wateredCount: 0, waterDropTargetCount: 0, waterDropConsumedAtMs: Date.now() };
  }
  const targetLandIds = landIds.slice(0, waterBefore.count);
  const consumedAtMs = Date.now();
  const clampAfterWater = (nextSync, wateredCount) => {
    const count = Number(wateredCount) || 0;
    if (!count) return nextSync;
    return setWaterDropCount(nextSync, Math.max(0, waterBefore.count - count), consumedAtMs);
  };
  let next = syncValue;
  let wateredBy = "waterBatch";
  const raw = await ws.request("gs.usrLand.waterBatch", { landIds: targetLandIds }, gsToken);
  const rsp = washResponse(raw);
  if (rsp.errMsg && isSessionExpiredPayload(rsp.errMsg)) {
    throw new Error(`Water batch failed: ${JSON.stringify(rsp.errMsg)}`);
  }
  if (rsp.errMsg && isWaterDropShortageError(rsp.errMsg)) {
    const clamped = clampWaterDropCount(next, 0, consumedAtMs);
    console.log(JSON.stringify({ step: "waterSeededError", requestedCount: targetLandIds.length, err: rsp.errMsg, reason: "water-drop-shortage" }));
    return { syncValue: clamped, wateredCount: 0, waterDropTargetCount: 0, waterDropConsumedAtMs: consumedAtMs };
  }
  if (rsp.errMsg && process.env.NO_WATER_FALLBACK !== "1") {
    wateredBy = "water";
    let count = 0;
    let shortage = false;
    for (const landId of targetLandIds) {
      const oneRaw = await ws.request("gs.usrLand.water", { landId }, gsToken);
      const one = washResponse(oneRaw);
      if (one.errMsg) {
        if (isSessionExpiredPayload(one.errMsg)) {
          throw new Error(`Water land ${landId} failed: ${JSON.stringify(one.errMsg)}`);
        }
        console.log(JSON.stringify({ step: "waterSeededLandError", landId, err: one.errMsg }));
        if (isWaterDropShortageError(one.errMsg)) {
          shortage = true;
          break;
        }
        continue;
      }
      count++;
      next = mergeLandSync(next, one.value);
    }
    const targetCount = shortage ? 0 : Math.max(0, waterBefore.count - count);
    next = shortage ? clampWaterDropCount(next, 0, consumedAtMs) : clampAfterWater(next, count);
    console.log(JSON.stringify({ step: "waterSeeded", wateredBy, requestedCount: targetLandIds.length, wateredCount: count, stoppedReason: shortage ? "water-drop-shortage" : null }));
    return {
      syncValue: next,
      wateredCount: count,
      waterDropTargetCount: targetCount,
      waterDropConsumedAtMs: consumedAtMs,
    };
  }
  if (rsp.errMsg) {
    console.log(JSON.stringify({ step: "waterSeededError", requestedCount: landIds.length, err: rsp.errMsg }));
    return { syncValue, wateredCount: 0 };
  }
  next = mergeLandSync(next, rsp.value);
  let actualWateredCount = countActuallyWateredLands(syncValue, next, targetLandIds);
  if (actualWateredCount !== targetLandIds.length) {
    const verified = await refreshLand(ws, gsToken, next, "waterSeededVerifyRefresh");
    next = verified;
    actualWateredCount = countActuallyWateredLands(syncValue, next, targetLandIds);
  }
  next = clampAfterWater(next, actualWateredCount);
  console.log(JSON.stringify({
    step: "waterSeeded",
    wateredBy,
    requestedCount: targetLandIds.length,
    wateredCount: actualWateredCount,
    partial: actualWateredCount !== targetLandIds.length,
  }));
  return {
    syncValue: next,
    wateredCount: actualWateredCount,
    waterDropTargetCount: Math.max(0, waterBefore.count - actualWateredCount),
    waterDropConsumedAtMs: consumedAtMs,
  };
}

async function waterSeededLandGroup(ws, gsToken, syncValue, seededGroup, options = {}) {
  const allTargetLandIds = Array.isArray(seededGroup?.seededLandIds)
    ? seededGroup.seededLandIds.map((id) => Number(id)).filter((id) => Number.isFinite(id))
    : [];
  const targetLandIds = options.maxWaterCount == null
    ? allTargetLandIds
    : allTargetLandIds.slice(0, Math.max(0, Math.floor(Number(options.maxWaterCount) || 0)));
  const phase = options.phase || "waterSeededGroup";
  if (!targetLandIds.length || process.env.AUTO_WATER === "0") {
    console.log(JSON.stringify({
      step: "waterSeededGroupSkip",
      phase,
      reason: targetLandIds.length ? "disabled" : "no-seeded-land",
      seededLandCount: targetLandIds.length,
      groupKey: seededGroup?.groupKey ?? null,
    }));
    return { syncValue, wateredCount: 0, waterDropTargetCount: getWaterDropStatus(syncValue).count, waterDropConsumedAtMs: Date.now(), stopped: true };
  }

  let next = await refreshAuthoritativeWaterDrop(ws, gsToken, syncValue, `${phase}AuthoritativeWaterDropBeforeWater`);
  let waterBefore = getWaterDropStatus(next);
  let plantWaterRefill = getPlantWaterRefillContext(next);
  const consumedAtMs = Date.now();
  const requiredWaterCount = Math.max(1, Number(seededGroup?.requiredWaterCount) || targetLandIds.length);
  if (plantWaterRefill.waterDropTrust !== "authoritative") {
    const refreshed = await refreshLandForPotentialWaterAuthority(
      ws,
      gsToken,
      next,
      plantWaterRefill,
      `${phase}AuthoritativeLandRefreshBeforeWater`,
    );
    next = refreshed.syncValue;
    waterBefore = getWaterDropStatus(next);
    plantWaterRefill = refreshed.plantWaterRefill;
  }
  const refreshedAuthoritativeWaterDropCount = getAuthoritativeWaterDropCount(plantWaterRefill);
  if (plantWaterRefill.waterDropTrust !== "authoritative") {
    console.log(JSON.stringify({
      step: "waterSeededGroupSkip",
      phase,
      reason: "waiting-authoritative-water-drop-before-water-seeded",
      reasonText: "waiting authoritative water drop before watering seeded land group",
      groupKey: seededGroup?.groupKey ?? null,
      groupIndex: seededGroup?.groupIndex ?? null,
      groupStartId: seededGroup?.groupStartId ?? null,
      groupEndId: seededGroup?.groupEndId ?? null,
      actualGroupSize: seededGroup?.actualGroupSize ?? null,
      maxGroupSize: PLANT_LAND_GROUP_SIZE,
      seededLandIds: targetLandIds,
      seededLandCount: targetLandIds.length,
      requiredWaterCount,
      waterDropTrust: plantWaterRefill.waterDropTrust,
      serverWaterDropCount: plantWaterRefill.serverWaterDropCount,
      serverWaterDropReason: plantWaterRefill.serverWaterDropReason,
      waterDropCount: waterBefore.count,
    }));
    return { syncValue: next, wateredCount: 0, waterDropTargetCount: waterBefore.count, waterDropConsumedAtMs: consumedAtMs, stopped: true };
  }
  if (refreshedAuthoritativeWaterDropCount < requiredWaterCount) {
    console.log(JSON.stringify({
      step: "waterSeededGroupSkip",
      phase,
      reason: "waiting-water-for-seeded-land-group",
      reasonText: "水滴不足，等待足够浇完整组已种土地后再继续",
      groupKey: seededGroup?.groupKey ?? null,
      groupIndex: seededGroup?.groupIndex ?? null,
      groupStartId: seededGroup?.groupStartId ?? null,
      groupEndId: seededGroup?.groupEndId ?? null,
      actualGroupSize: seededGroup?.actualGroupSize ?? null,
      maxGroupSize: PLANT_LAND_GROUP_SIZE,
      seededLandIds: targetLandIds,
      seededLandCount: targetLandIds.length,
      requiredWaterCount,
      waterDropCount: waterBefore.count,
      decisionWaterDropCount: refreshedAuthoritativeWaterDropCount,
      serverWaterDropCount: plantWaterRefill.serverWaterDropCount,
      serverWaterDropReason: plantWaterRefill.serverWaterDropReason,
      serverWaterDropSourcePath: plantWaterRefill.serverWaterDropSourcePath,
    }));
    return { syncValue: next, wateredCount: 0, waterDropTargetCount: refreshedAuthoritativeWaterDropCount, waterDropConsumedAtMs: consumedAtMs, stopped: true };
  }

  let actualWateredCount = 0;
  let waterDropTargetCount = refreshedAuthoritativeWaterDropCount;
  let lastServerWaterDropCount = null;
  let usedServerWaterDropCount = false;
  for (const landId of targetLandIds) {
    const oneRaw = await ws.request("gs.usrLand.water", { landId }, gsToken);
    const one = washResponse(oneRaw);
    if (one.errMsg && isSessionExpiredPayload(one.errMsg)) {
      throw new Error(`Water land ${landId} failed: ${JSON.stringify(one.errMsg)}`);
    }
    if (one.errMsg && isWaterDropShortageError(one.errMsg)) {
      const clamped = clampWaterDropCount(next, 0, consumedAtMs);
      console.log(JSON.stringify({
        step: "waterSeededGroupError",
        phase,
        reason: "water-drop-shortage",
        groupKey: seededGroup?.groupKey ?? null,
        groupIndex: seededGroup?.groupIndex ?? null,
        groupStartId: seededGroup?.groupStartId ?? null,
        groupEndId: seededGroup?.groupEndId ?? null,
        seededLandIds: targetLandIds,
        requestedCount: targetLandIds.length,
        wateredCount: actualWateredCount,
        beforeWaterDropCount: waterBefore.count,
        waterDropTargetCount,
        requiredWaterCount,
        err: one.errMsg,
      }));
      return { syncValue: clamped, wateredCount: actualWateredCount, waterDropTargetCount: 0, waterDropConsumedAtMs: consumedAtMs, stopped: true };
    }
    if (one.errMsg) {
      console.log(JSON.stringify({
        step: "waterSeededGroupError",
        phase,
        groupKey: seededGroup?.groupKey ?? null,
        groupIndex: seededGroup?.groupIndex ?? null,
        groupStartId: seededGroup?.groupStartId ?? null,
        groupEndId: seededGroup?.groupEndId ?? null,
        landId,
        requestedCount: targetLandIds.length,
        wateredCount: actualWateredCount,
        beforeWaterDropCount: waterBefore.count,
        waterDropTargetCount,
        requiredWaterCount,
        err: one.errMsg,
      }));
      return {
        syncValue: next,
        wateredCount: actualWateredCount,
        waterDropTargetCount,
        waterDropConsumedAtMs: consumedAtMs,
        stopped: true,
      };
    }
    const beforeOne = next;
    next = mergeLandSync(next, one.value);
    const changedCount = countActuallyWateredLands(beforeOne, next, [landId]);
    const wateredIncrement = changedCount || 1;
    actualWateredCount += wateredIncrement;
    const responseWaterDropCount = getExplicitWaterDropCountFromResponse(one.value);
    if (responseWaterDropCount != null && responseWaterDropCount < waterDropTargetCount) {
      waterDropTargetCount = responseWaterDropCount;
      lastServerWaterDropCount = responseWaterDropCount;
      usedServerWaterDropCount = true;
    } else {
      waterDropTargetCount = Math.max(0, waterDropTargetCount - wateredIncrement);
    }
    next = setWaterDropCount(next, waterDropTargetCount, consumedAtMs);
  }
  next = setWaterDropCount(next, waterDropTargetCount, consumedAtMs);
  console.log(JSON.stringify({
    step: "waterSeededGroup",
    phase,
    wateredBy: "water",
    groupKey: seededGroup?.groupKey ?? null,
    groupIndex: seededGroup?.groupIndex ?? null,
    groupStartId: seededGroup?.groupStartId ?? null,
    groupEndId: seededGroup?.groupEndId ?? null,
    requestedLandIds: targetLandIds,
    requestedCount: targetLandIds.length,
    wateredCount: actualWateredCount,
    partial: actualWateredCount !== targetLandIds.length,
    beforeWaterDropCount: waterBefore.count,
    waterDropTargetCount,
    serverWaterDropCount: lastServerWaterDropCount,
    usedServerWaterDropCount,
  }));
  return {
    syncValue: next,
    wateredCount: actualWateredCount,
    waterDropTargetCount,
    waterDropConsumedAtMs: consumedAtMs,
    stopped: actualWateredCount !== targetLandIds.length,
  };
}

async function waterOneSeededLand(ws, gsToken, syncValue, landId) {
  if (process.env.AUTO_WATER === "0") {
    console.log(JSON.stringify({ step: "waterSeededOneSkip", reason: "disabled", landId }));
    return { syncValue, wateredCount: 0, waterDropTargetCount: getWaterDropStatus(syncValue).count, waterDropConsumedAtMs: Date.now(), stopped: true };
  }

  const state = getState(syncValue);
  const row = state.land.rows.find((item) => Number(item.landId) === Number(landId));
  if (!row || row.state !== 1) {
    console.log(JSON.stringify({ step: "waterSeededOneSkip", reason: "not-seeded-land", landId, state: row?.state ?? null }));
    return { syncValue, wateredCount: 0, waterDropTargetCount: getWaterDropStatus(syncValue).count, waterDropConsumedAtMs: Date.now(), stopped: true };
  }

  const waterBefore = getWaterDropStatus(syncValue);
  const consumedAtMs = Date.now();
  if (waterBefore.count <= 0) {
    console.log(JSON.stringify({ step: "waterSeededOneSkip", reason: "no-water-drop", landId, waterDropCount: waterBefore.count }));
    return { syncValue, wateredCount: 0, waterDropTargetCount: 0, waterDropConsumedAtMs: consumedAtMs, stopped: true };
  }

  const raw = await ws.request("gs.usrLand.water", { landId }, gsToken);
  const rsp = washResponse(raw);
  if (rsp.errMsg && isSessionExpiredPayload(rsp.errMsg)) {
    throw new Error(`Water land ${landId} failed: ${JSON.stringify(rsp.errMsg)}`);
  }
  if (rsp.errMsg && isWaterDropShortageError(rsp.errMsg)) {
    const clamped = clampWaterDropCount(syncValue, 0, consumedAtMs);
    console.log(JSON.stringify({ step: "waterSeededOneError", landId, err: rsp.errMsg, reason: "water-drop-shortage" }));
    return { syncValue: clamped, wateredCount: 0, waterDropTargetCount: 0, waterDropConsumedAtMs: consumedAtMs, stopped: true };
  }
  if (rsp.errMsg) {
    console.log(JSON.stringify({ step: "waterSeededOneError", landId, err: rsp.errMsg }));
    return { syncValue, wateredCount: 0, waterDropTargetCount: waterBefore.count, waterDropConsumedAtMs: consumedAtMs, stopped: true };
  }

  let next = mergeLandSync(syncValue, rsp.value);
  let actualWateredCount = countActuallyWateredLands(syncValue, next, [landId]);
  if (actualWateredCount !== 1) {
    next = await refreshLand(ws, gsToken, next, "waterSeededOneVerifyRefresh");
    actualWateredCount = countActuallyWateredLands(syncValue, next, [landId]);
  }
  const targetCount = Math.max(0, waterBefore.count - actualWateredCount);
  next = actualWateredCount ? setWaterDropCount(next, targetCount, consumedAtMs) : next;
  console.log(JSON.stringify({
    step: "waterSeededOne",
    wateredBy: "water",
    landId,
    wateredCount: actualWateredCount,
    partial: actualWateredCount !== 1,
  }));
  return {
    syncValue: next,
    wateredCount: actualWateredCount,
    waterDropTargetCount: targetCount,
    waterDropConsumedAtMs: consumedAtMs,
    stopped: actualWateredCount !== 1,
  };
}

function getFreeSpeedUpThresholdMs() {
  const seconds = Number(process.env.FREE_SPEEDUP_SECONDS || 59);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 59) * 1000;
}

function isNearMatureLandRow(row, now, thresholdMs) {
  const nextMs = row.nextTime ? Date.parse(row.nextTime) : 0;
  return row.state === 2 && nextMs > now && nextMs - now <= thresholdMs;
}

export function getNearMatureLandRows(
  syncValue,
  now = getResourceActionNowMs(syncValue),
  thresholdMs = getFreeSpeedUpThresholdMs(),
) {
  return getState(syncValue, now).land.rows.filter((row) => isNearMatureLandRow(row, now, thresholdMs));
}

function shouldRunFinalGrowthCheck(syncValue, options = {}) {
  const now = getResourceActionNowMs(syncValue, options);
  const state = getState(syncValue, now);
  if (state.land.mature.length) return true;
  if (process.env.AUTO_SPEEDUP_FREE === "0") return false;

  const thresholdMs = getFreeSpeedUpThresholdMs();
  return state.land.rows.some((row) => isNearMatureLandRow(row, now, thresholdMs));
}

async function speedUpNearMature(ws, gsToken, syncValue, options = {}) {
  if (process.env.AUTO_SPEEDUP_FREE === "0") return { syncValue, speedUp: false };
  const thresholdMs = getFreeSpeedUpThresholdMs();
  const now = getResourceActionNowMs(syncValue, options);
  const near = getNearMatureLandRows(syncValue, now, thresholdMs);
  if (!near.length) {
    console.log(JSON.stringify({ step: "speedUpFreeSkip", reason: "no-near-mature-land", thresholdSeconds: Math.floor(thresholdMs / 1000) }));
    return { syncValue, speedUp: false };
  }

  const rsp = await requestSync(ws, gsToken, "gs.usrLand.speedUpFree", {}, "Free speed-up failed");
  const next = mergeLandSync(syncValue, rsp.value);
  console.log(JSON.stringify({ step: "speedUpFree", nearCount: near.length, thresholdSeconds: Math.floor(thresholdMs / 1000) }));
  return { syncValue: next, speedUp: true };
}

async function harvestMatureLands(ws, gsToken, syncValue, options = {}) {
  const state = getState(syncValue, getResourceActionNowMs(syncValue, options));
  const allMatureLandIds = state.recommendation.harvestLandIds;
  const matureLandIds = options.maxHarvestCount == null
    ? allMatureLandIds
    : allMatureLandIds.slice(0, Math.max(0, Math.floor(Number(options.maxHarvestCount) || 0)));
  if (!matureLandIds.length) {
    console.log(JSON.stringify({ step: "harvestMatureSkip", reason: "no-mature-land" }));
    return { syncValue, harvestedCount: 0 };
  }

  let next = syncValue;
  let harvestedCount = 0;
  let experienceBlocked = false;
  let blockedError = null;
  for (const landId of matureLandIds) {
    let raw;
    const landMap = next?.usrLandTot?.usrLand?.landMap || {};
    const landBefore = landMap[String(landId)] ?? landMap[landId] ?? null;
    try {
      raw = await ws.request(
        "gs.usrLand.harvest",
        { landId },
        gsToken,
        {
          experienceActionEvidence: {
            land: {
              landId,
              snapshot: landBefore == null
                ? null
                : stableSettlementSnapshot(landBefore),
            },
          },
        },
      );
    } catch (err) {
      if (!isExperienceActionBlockedError(err)) throw err;
      experienceBlocked = true;
      console.log(JSON.stringify({
        step: "harvestMature",
        requestedCount: matureLandIds.length,
        harvestedCount,
        experienceBlocked,
        blockedReason: err.experienceGuard?.reason || err.reason || "experience-action-blocked",
      }));
      blockedError = err;
      break;
    }
    const rsp = washResponse(raw);
    if (rsp.errMsg) {
      console.log(JSON.stringify({ step: "harvestMatureLandError", landId, err: rsp.errMsg }));
      continue;
    }
    harvestedCount++;
    next = mergeLandSync(next, rsp.value);
  }
  console.log(JSON.stringify({
    step: "harvestMature",
    requestedCount: matureLandIds.length,
    harvestedCount,
    experienceBlocked,
  }));
  return { syncValue: next, harvestedCount, experienceBlocked, blockedError };
}

async function autoUpgradeFlowers(ws, gsToken, syncValue, options = {}) {
  const cycle = options.cycle;
  const moduleHealth = options.moduleHealth || activeAutomationModuleHealth;
  const rejectionBackoffMs = Math.max(
    0,
    Number(options.rejectionBackoffMs ?? process.env.FLOWER_UPGRADE_REJECTION_BACKOFF_MS ?? 5 * 60 * 1000) || 0,
  );
  if (process.env.AUTO_HANDLE_FLOWER_UPGRADE === "0") {
    console.log(JSON.stringify({ step: "flowerUpgradeSkip", cycle, reason: "disabled" }));
    return { syncValue, upgradedCount: 0, failedCount: 0, skippedBackoffCount: 0, actions: [], failedActions: [] };
  }
  const flowerLevelConfig = options.flowerLevelConfig || loadFlowerLevelConfig();
  let next = syncValue;
  let upgradedCount = 0;
  const actions = [];
  const failedActions = [];
  let skippedBackoffCount = 0;
  const attemptedFlowerIds = new Set();
  while (true) {
    const candidates = getFlowerUpgradeCandidates(next, flowerLevelConfig);
    const candidate = candidates.find((item) => !attemptedFlowerIds.has(item.flowerId));
    if (!candidate) break;
    attemptedFlowerIds.add(candidate.flowerId);
    const fingerprint = getFlowerUpgradeFingerprint(next, candidate);
    const gate = moduleHealth?.canAttempt?.("flowerUpgrade", fingerprint);
    if (gate && !gate.allowed) {
      skippedBackoffCount += 1;
      console.log(JSON.stringify({
        step: "flowerUpgradeBackoffSkip",
        cycle,
        flowerId: candidate.flowerId,
        lvl: candidate.lvl,
        nextRetryAt: gate.nextRetryAt,
      }));
      continue;
    }
    moduleHealth?.begin?.("flowerUpgrade", { cycle });
    const rawRsp = await ws.request("gs.cultivate.upgrade", { flowerId: candidate.flowerId }, gsToken);
    const rsp = washResponse(rawRsp);
    if (rsp.errMsg) {
      const deterministic = isDeterministicStructuredRejection(rsp.errMsg);
      const failedAction = {
        flowerId: candidate.flowerId,
        lvl: candidate.lvl,
        fingerprint,
        error: rsp.errMsg,
        message: formatAutomationModuleError(rsp.errMsg),
      };
      failedActions.push(failedAction);
      moduleHealth?.failure?.("flowerUpgrade", rsp.errMsg, {
        cycle,
        fingerprint,
        backoffMs: deterministic ? rejectionBackoffMs : 0,
      });
      console.log(JSON.stringify({ step: "flowerUpgradeError", cycle, flowerId: candidate.flowerId, lvl: candidate.lvl, err: rsp.errMsg }));
      continue;
    }
    moduleHealth?.success?.("flowerUpgrade", { cycle, fingerprint });
    upgradedCount += 1;
    actions.push({ flowerId: candidate.flowerId, lvl: candidate.lvl });
    next = mergeLandSync(next, rsp.value);
  }
  console.log(JSON.stringify({ step: "flowerUpgrade", cycle, upgradedCount, failedCount: failedActions.length, skippedBackoffCount }));
  return {
    syncValue: next,
    upgradedCount,
    failedCount: failedActions.length,
    skippedBackoffCount,
    actions,
    failedActions,
  };
}

function getFlowerUpgradeFingerprint(syncValue, candidate) {
  const eliteCount = getItemCount(syncValue, candidate.eliteId) ?? 0;
  return [
    candidate.flowerId,
    candidate.lvl,
    candidate.gldCost,
    candidate.eliteId,
    candidate.eliteCost,
    eliteCount,
  ].join(":");
}

function isDeterministicStructuredRejection(error) {
  return Boolean(error && typeof error === "object" && error.code != null);
}

function formatAutomationModuleError(error) {
  if (error && typeof error === "object") {
    return error.message || (error.code != null ? `server-rejected:${error.code}` : "server-rejected");
  }
  return String(error?.message || error || "unknown-error");
}

async function handleTimeCriticalGrowth(
  ws,
  gsToken,
  syncValue,
  label = "timeCriticalGrowth",
  options = {},
) {
  let next = syncValue;
  let speedUpFree = false;
  let harvestedCount = 0;
  const actionTimeOptions = {
    actionTime: resolveResourceActionTime(syncValue, options),
  };

  if (process.env.AUTO_SPEEDUP_FREE !== "0" && getNearMatureLandRows(next, actionTimeOptions.actionTime.nowMs).length) {
    const speed = await speedUpNearMature(ws, gsToken, next, actionTimeOptions);
    next = speed.syncValue;
    speedUpFree = speed.speedUp;
    if (speed.speedUp) {
      next = await refreshLand(ws, gsToken, next, `${label}RefreshAfterSpeedUp`, { log: false });
    }
  }

  if (getState(next, actionTimeOptions.actionTime.nowMs).land.mature.length) {
    const harvested = await harvestMatureLands(ws, gsToken, next, actionTimeOptions);
    next = harvested.syncValue;
    harvestedCount = harvested.harvestedCount;
    if (harvested.harvestedCount) {
      next = await refreshLand(ws, gsToken, next, `${label}RefreshAfterHarvest`, { log: false });
    }
  }

  if (speedUpFree || harvestedCount) {
    console.log(JSON.stringify({
      step: label,
      speedUpFree,
      harvestedCount,
    }));
  }

  return {
    syncValue: next,
    speedUpFree,
    harvestedCount,
  };
}

function printSummary(step, cycle, syncValue, extra = {}) {
  const { flowerNames: providedFlowerNames, ...summaryExtra } = extra;
  const localNowMs = Date.now();
  const nowMs = getTrustedGardenNowMs(syncValue?.$timeAuthority, localNowMs);
  const state = getState(syncValue, nowMs);
  const waterDrop = decorateWaterDropStatus(getWaterDropStatus(syncValue, nowMs));
  const doubleGold = decorateDoubleGoldStatus(getDoubleGoldStatus(syncValue, nowMs));
  const resourceItems = getGardenResourceStatus(syncValue);
  const flowerNames = providedFlowerNames || loadFlowerNameMap();
  const plantingRule = getPlantingRuleStatus();
  const plantingBlockers = getPlantingBlockersFromSummary(summaryExtra);
  const decorateCandidate = (item) => item ? {
    ...item,
    flowerName: flowerName(item.flowerId, flowerNames),
    flowerLabel: formatFlowerLabel(item.flowerId, flowerNames),
    cTimeText: formatDateTime(item.cTime),
  } : null;
  const summary = {
    step,
    cycle,
    land: {
      total: state.land.total,
      emptyCount: state.land.empty.length,
      growingCount: state.land.growing.length,
      matureCount: state.land.mature.length,
      seededCount: state.land.rows.filter((row) => row.state === 1).length,
      nextMatureTime: formatDateTime(getNextMatureTime(state.land)),
      nextMatureInSeconds: getNextMatureInSeconds(state.land),
    },
    recommendation: {
      plantFlower: decorateCandidate(state.recommendation.plantFlower),
      candidateTop5: state.recommendation.candidateTop5.map(decorateCandidate),
    },
    plantingRule,
    plantingBlockers,
    plantingBlockerCount: plantingBlockers.length,
    resources: {
      waterDropCount: waterDrop.count,
      waterDrop,
      items: resourceItems,
      doubleGold,
    },
    ...summaryExtra,
  };
  logStructured(summary, {
    step,
    cycle,
    cycleErrorCount: extra.cycleErrors?.length ?? 0,
    land: summary.land,
    recommendation: {
      plantFlower: summary.recommendation.plantFlower ? {
        flowerId: summary.recommendation.plantFlower.flowerId,
        flowerName: summary.recommendation.plantFlower.flowerName,
        flowerLabel: summary.recommendation.plantFlower.flowerLabel,
        count: summary.recommendation.plantFlower.count,
        lvl: summary.recommendation.plantFlower.lvl,
        cTimeText: summary.recommendation.plantFlower.cTimeText,
      } : null,
    },
    waterDropText: waterDrop.displayText,
    waterDropFormulaText: waterDrop.formulaText,
    waterDropNextRestoreText: waterDrop.nextRestoreText,
    waterDropFlowText: extra.waterDropFlow?.flowText ?? null,
    plantingBlockerCount: plantingBlockers.length,
    plantingBlockers,
    waterDecision: extra.waterDecision || null,
    waterRefillBlockedReason: extra.waterRefillBlockedReason || null,
    waterwheelActionCount: extra.waterwheelActionCount ?? 0,
    waterwheelReceivedCount: extra.waterwheelReceivedCount ?? 0,
    waterwheelNormalReceivedCount: extra.waterwheelNormalReceivedCount ?? 0,
    waterwheelVideoBaseReceivedCount: extra.waterwheelVideoBaseReceivedCount ?? 0,
    freeWaterActionCount: extra.freeWaterActionCount ?? 0,
    freeWaterReceivedCount: extra.freeWaterReceivedCount ?? 0,
    doubleGoldRemainingText: doubleGold.remainingText,
    doubleGoldEndTimeText: doubleGold.eTimeText,
    plantedCount: extra.plantedCount ?? 0,
    wateredCount: extra.wateredCount ?? 0,
    harvestedCount: extra.harvestedCount ?? 0,
    specialOrderSubmittedCount: extra.specialOrderSubmittedCount ?? 0,
    ordinaryResidentOrderSubmittedCount: extra.ordinaryResidentOrderSubmittedCount ?? 0,
    palaceOrderSubmittedCount: extra.palaceOrderSubmittedCount ?? 0,
    mainTaskSubmittedCount: extra.mainTaskSubmittedCount ?? 0,
    cyclicStoryActionCount: extra.cyclicStoryActionCount ?? 0,
    cyclicStorySubmittedCount: extra.cyclicStorySubmittedCount ?? 0,
    cyclicStoryFailedCount: extra.cyclicStoryFailedCount ?? 0,
    cyclicStoryActions: extra.cyclicStoryActions ?? [],
    cyclicStoryFailedActions: extra.cyclicStoryFailedActions ?? [],
    cyclicNoteActionCount: extra.cyclicNoteActionCount ?? 0,
    cyclicNoteReceivedCount: extra.cyclicNoteReceivedCount ?? 0,
    cyclicNoteFailedCount: extra.cyclicNoteFailedCount ?? 0,
    cyclicNoteActions: extra.cyclicNoteActions ?? [],
    cyclicNoteFailedActions: extra.cyclicNoteFailedActions ?? [],
    customerOrderActionCount: extra.customerOrderActionCount ?? 0,
    flowerRackActionCount: extra.flowerRackActionCount ?? 0,
    flowerRackGoldReceivedCount: extra.flowerRackGoldReceivedCount ?? 0,
    flowerRackMakeActionCount: extra.flowerRackMakeActionCount ?? 0,
    flowerRackMadeCount: extra.flowerRackMadeCount ?? 0,
    flowerRackShelvedCount: extra.flowerRackShelvedCount ?? 0,
    flowerRackFailedCount: extra.flowerRackFailedCount ?? 0,
    pearlActionCount: extra.pearlActionCount ?? 0,
    pearlReceivedCount: extra.pearlReceivedCount ?? 0,
    pearlHireCount: extra.pearlHireCount ?? 0,
    pearlDailyFreeCount: extra.pearlDailyFreeCount ?? 0,
    fmlLandScanned: extra.fmlLandScanned ?? false,
    fmlLandActionCount: extra.fmlLandActionCount ?? 0,
    fmlLandHarvestedCount: extra.fmlLandHarvestedCount ?? 0,
    fmlLandFailedCount: extra.fmlLandFailedCount ?? 0,
    materialShopActionCount: extra.materialShopActionCount ?? 0,
    materialShopBoughtCount: extra.materialShopBoughtCount ?? 0,
    materialShopSpentGold: extra.materialShopSpentGold ?? 0,
    materialShopFailedCount: extra.materialShopFailedCount ?? 0,
    materialShopRefreshCount: extra.materialShopRefreshCount ?? 0,
    materialShopFreeRefreshCount: extra.materialShopFreeRefreshCount ?? 0,
    materialShopPaidRefreshCount: extra.materialShopPaidRefreshCount ?? 0,
    materialShopSpentYuanbao: extra.materialShopSpentYuanbao ?? 0,
    materialShopRefreshFailedCount: extra.materialShopRefreshFailedCount ?? 0,
    materialShopRefreshStopReason: extra.materialShopRefreshStopReason ?? null,
    speedUpFree: extra.speedUpFree ?? false,
    postWaterSpeedUpFree: extra.postWaterSpeedUpFree ?? false,
  });
  writeStatusDocuments(syncValue, {
    step,
    cycle,
    summary,
    flowerNames,
    nowMs: localNowMs,
    ...(Object.hasOwn(summaryExtra, "customerOrderFlowerCurrencyRewardReleaseMask")
      ? {
        customerOrderFlowerCurrencyRewardReleaseMask:
          summaryExtra.customerOrderFlowerCurrencyRewardReleaseMask,
      }
      : {}),
    customerOrderScheduler: summaryExtra.customerOrderScheduler ?? null,
  });
}

function getStatusMode(context = {}) {
  if (context.statusMode) return context.statusMode;
  if (context.step === "loopStatusRefresh") return "loop-refresh";
  if (String(context.step || "").includes("Error")) return "error";
  return "cycle-action";
}

function getStatusPageLifecycle(context = {}) {
  const stopped = context.summary?.automationStopped?.stopped === true
    || Boolean(context.summary?.automationStopped?.reason);
  return {
    stopped,
    refreshEnabled: !stopped,
    countdownEnabled: !stopped,
  };
}

function readStatusDocument(jsonPath) {
  try {
    if (!fs.existsSync(jsonPath)) return null;
    return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } catch {}
  return null;
}

function cloneStatusContextValue(value) {
  if (value == null) return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function projectStatusDocumentContext(status = {}) {
  const summary = status?.summary && typeof status.summary === "object"
    ? status.summary
    : {};
  return {
    statusMode: status?.statusMode ?? null,
    lastActionWaterDropFlow: cloneStatusContextValue(status?.lastActionWaterDropFlow ?? null),
    resources: {
      waterDropFlow: cloneStatusContextValue(status?.resources?.waterDropFlow ?? null),
    },
    moduleHealth: cloneStatusContextValue(status?.moduleHealth ?? null),
    accountScheduler: cloneStatusContextValue(status?.accountScheduler ?? null),
    customerOrderScheduler: cloneStatusContextValue(status?.customerOrderScheduler ?? null),
    summary: {
      cycleErrors: cloneStatusContextValue(summary.cycleErrors ?? null),
      accountScheduler: cloneStatusContextValue(summary.accountScheduler ?? null),
      customerOrderScheduler: cloneStatusContextValue(summary.customerOrderScheduler ?? null),
    },
  };
}

function getStatusDocumentContextCacheKey(jsonPath) {
  return path.resolve(String(jsonPath));
}

function readStatusDocumentContext(jsonPath) {
  const cacheKey = getStatusDocumentContextCacheKey(jsonPath);
  const cached = statusDocumentContextCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt <= STATUS_DOCUMENT_CONTEXT_CACHE_TTL_MS) {
    return cached.context;
  }
  if (cached) statusDocumentContextCache.delete(cacheKey);
  const previous = readStatusDocument(jsonPath);
  if (!previous) return null;
  const context = projectStatusDocumentContext(previous);
  statusDocumentContextCache.set(cacheKey, { cachedAt: Date.now(), context });
  return context;
}

function rememberStatusDocumentContext(jsonPath, status) {
  statusDocumentContextCache.set(getStatusDocumentContextCacheKey(jsonPath), {
    cachedAt: Date.now(),
    context: projectStatusDocumentContext(status),
  });
}

function clearStatusDocumentContextCache(jsonPath = null) {
  if (jsonPath == null) {
    statusDocumentContextCache.clear();
    return;
  }
  statusDocumentContextCache.delete(getStatusDocumentContextCacheKey(jsonPath));
}

function readLastActionWaterDropFlow(jsonPath, previousStatus = null) {
  try {
    const previous = previousStatus || readStatusDocumentContext(jsonPath);
    if (previous?.lastActionWaterDropFlow) return previous.lastActionWaterDropFlow;
    const previousFlow = previous?.resources?.waterDropFlow || null;
    if (previous?.statusMode === "cycle-action" && previousFlow?.mode !== "loop-refresh-snapshot") {
      return previousFlow;
    }
  } catch {}
  return null;
}

function getNextMatureTime(land) {
  const times = land.rows
    .map((row) => row.nextTime ? Date.parse(row.nextTime) : 0)
    .filter((time) => time && time > Date.now())
    .sort((a, b) => a - b);
  return times[0] ? new Date(times[0]).toISOString() : null;
}

function getNextMatureInSeconds(land) {
  const times = land.rows
    .map((row) => row.nextTime ? Date.parse(row.nextTime) : 0)
    .filter((time) => time && time > Date.now())
    .sort((a, b) => a - b);
  return times[0] ? Math.max(0, Math.ceil((times[0] - Date.now()) / 1000)) : null;
}

function fmtDuration(ms) {
  return formatDuration(ms);
}

function decorateDoubleGoldStatus(status) {
  return {
    ...status,
    remainingText: status?.active ? formatDuration(status.remainingMs) : "未开启",
    eTimeText: formatDateTime(status?.eTime),
  };
}

function landStatusText(row) {
  if (row.empty) return "空地";
  if (row.mature) return "可收获";
  if (row.state === 1) return "已种植/待浇水";
  if (row.state === 2) return "成长中";
  if (row.state === 3) return "可收获";
  return `状态${row.state}`;
}

function remainingMs(row) {
  if (row.empty) return null;
  if (row.mature) return 0;
  if (!row.nextTime) return null;
  return Date.parse(row.nextTime) - Date.now();
}

function formatOrderRequirements(requirements = []) {
  if (!requirements.length) return "-";
  return requirements
    .map((item) => `${item.name} ${item.have}/${item.need}${item.missing ? ` 缺${item.missing}` : ""}`)
    .join("；");
}

function formatCustomerRequirements(requirements = []) {
  if (!requirements.length) return "-";
  return requirements
    .map((item) => `${item.name} ${item.have}/${item.need}${item.missing ? ` 缺${item.missing}` : ""}`)
    .join("；");
}

function orderAutoSubmitText(order) {
  if (order.canFinish) return "会提交";
  if (order.isVideo) return "跳过：视频/广告";
  return "不会提交";
}

function formatCompletedCount(order) {
  return order?.completedCount ?? "-";
}

function formatNullableCount(value) {
  return value ?? "-";
}

function formatHistoryCustomerRequirement(requirements = []) {
  if (!requirements.length) return "-";
  return formatCustomerRequirements(requirements);
}

function formatCustomerCheckOrders(orders = []) {
  if (!orders.length) return "-";
  return orders
    .map((order) => {
      const req = formatHistoryCustomerRequirement(order.flowerRequirements);
      return `NPC${order.npcId ?? "-"} ${order.statusText ?? "-"} ${order.artLabel ?? "-"} ${req}`;
    })
    .join("；");
}

const CUSTOMER_ORDER_STATUS_RULE_TEXT = "不限制双倍金币时间；花坊币收益按官方 item 1002 与 cPrice×order.num 计算；按账号独立的花坊币收益放行列表精确选择 1/2/3，多选值均在满足既有库存/制作规则时制作或提交；已知但未选中的收益按官方按钮拒绝顾客订单，不更新历史审计记录；收益未知、订单/配置数据不足或放行列表为空时保持待处理并 fail-closed；历史最高收益仅作为审计数据，不参与当前放行决策；只有最终完成后才更新历史审计记录";
const CUSTOMER_ORDER_ACTION_RULE_TEXT = "derive flower-shop coin from official item id 1002 and cPrice multiplied by order num; the account-scoped exact release list for rewards 1/2/3 decides which known orders may use the existing make/finish flow; confirmed insufficient recipe-flower stock or an inactive flower art takes priority and uses the official gs.orderCustomer.rejectOrder button; known rewards outside the selected list use the same official reject button; unknown reward, recipe/order data, or an empty release list remains pending and fail closed; historical maximum is audit-only and never gates the current decision, while history updates only after final completion";

function writeStatusDocuments(syncValue, context = {}) {
  const outDir = process.env.STATUS_DOC_DIR || "outputs";
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = process.env.STATUS_HTML_PATH || `${outDir}/garden-status.html`;
  const mdPath = process.env.STATUS_MD_PATH || `${outDir}/garden-status.md`;
  const jsonPath = process.env.STATUS_JSON_PATH || `${outDir}/garden-status.json`;
  const statusMode = getStatusMode(context);
  const automationRunId = String(process.env.XJSKP_AUTOMATION_RUN_ID || "").trim() || null;
  const automationStopped = context.summary?.automationStopped
    ? {
      ...context.summary.automationStopped,
      ...(automationRunId ? { runId: automationRunId } : {}),
    }
    : null;
  const previousStatus = statusMode === "loop-refresh" ? readStatusDocumentContext(jsonPath) : null;
  const localNowMs = Number.isFinite(context.nowMs) ? context.nowMs : Date.now();
  const timeAuthority = getTimeAuthoritySnapshot(syncValue?.$timeAuthority, {
    nowMs: localNowMs,
  });
  const nowMs = timeAuthority.trusted && Number.isFinite(timeAuthority.correctedNowMs)
    ? timeAuthority.correctedNowMs
    : localNowMs;
  const cyclicNoteActionTime = {
    nowMs,
    localNowMs,
    timeTrusted: timeAuthority.trusted === true && Number.isFinite(timeAuthority.correctedNowMs),
    clockSource: timeAuthority.trusted ? timeAuthority.clockSource : "local-fallback",
    timeAuthorityReason: timeAuthority.trusted ? null : (timeAuthority.rejectionReason || "no-trusted-time-authority"),
  };
  const state = getState(syncValue, nowMs);
  const plantInventory = getCultivatedFlowerInventory(syncValue);
  const inventory = getFlowerInventory(syncValue);
  const now = new Date(localNowMs);
  const waterDrop = decorateWaterDropStatus(getWaterDropStatus(syncValue, nowMs));
  const waterDropCount = waterDrop.count;
  const waterDropFlow = context.summary?.waterDropFlow
    || (statusMode === "loop-refresh"
      ? buildLoopRefreshWaterDropFlow(waterDrop)
      : buildWaterDropFlow(context.summary?.waterDropBeforeWater, waterDrop, context.summary?.wateredCount));
  const lastActionWaterDropFlow = statusMode === "loop-refresh"
    ? (context.summary?.lastActionWaterDropFlow || readLastActionWaterDropFlow(jsonPath, previousStatus))
    : waterDropFlow;
  const plantingRule = context.summary?.plantingRule || getPlantingRuleStatus();
  const plantingBlockers = Array.isArray(context.summary?.plantingBlockers)
    ? context.summary.plantingBlockers
    : getPlantingBlockersFromSummary(context.summary || {});
  const plantingBlockerStatusText = formatPlantingBlockerStatus(plantingBlockers);
  const doubleGold = decorateDoubleGoldStatus(getDoubleGoldStatus(syncValue, nowMs));
  const resourceItems = getGardenResourceStatus(syncValue);
  const resourceList = Object.values(resourceItems);
  const flowerNames = context.flowerNames || loadFlowerNameMap();
  const decoratedInventory = sortStatusFlowerInventory(decorateFlowerRows(inventory, flowerNames, getBag(syncValue)));
  const flowerArtInventory = summarizeFlowerArtInventory(syncValue, { nameMap: flowerNames });
  const flowerRackStatus = summarizeFlowerRackStatus(syncValue, { nowMs: now.getTime(), flowerArtInventory, nameMap: flowerNames });
  const orderStatus = summarizeOrderFlowerStatus(syncValue, { nameMap: flowerNames, nowMs });
  const customerOrderFlowerCurrencyHistoryPath = context.customerOrderFlowerCurrencyHistoryPath
    || context.customerOrderFlowerCurrencyHistory?.historyPath
    || process.env.CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_PATH;
  const customerOrderFlowerCurrencyHistory = customerOrderFlowerCurrencyHistoryPath
    ? loadCustomerOrderFlowerCurrencyHistoryContext(syncValue, {
      ...context,
      customerOrderFlowerCurrencyHistoryPath,
    })
    : context.customerOrderFlowerCurrencyHistory
      || loadCustomerOrderFlowerCurrencyHistoryContext(syncValue, { ...context, statusDir: outDir });
  const customerOrderRewardReleaseMask = Object.hasOwn(
    context,
    "customerOrderFlowerCurrencyRewardReleaseMask",
  )
    ? normalizeExplicitCustomerOrderFlowerCurrencyRewardReleaseMask(
      context.customerOrderFlowerCurrencyRewardReleaseMask,
    )
    : getCustomerOrderFlowerCurrencyRewardReleaseSetting().mask;
  const customerStatus = summarizeOrderCustomerStatus(syncValue, {
    nameMap: flowerNames,
    nowMs,
    customerOrderFlowerCurrencyRewardReleaseMask: customerOrderRewardReleaseMask,
    customerOrderFlowerCurrencyHistory,
  });
  const palaceStatus = summarizeOrderPalaceStatus(syncValue, { nameMap: flowerNames, nowMs });
  const mainTaskStatus = summarizeMainTaskStatus(syncValue);
  const accountLevel = summarizeAccountLevel(syncValue, { serverIdx: context.serverIdx ?? context.summary?.serverIdx });
  const experienceGuard = context.summary?.experienceGuard
    || summarizeExperienceGuard(syncValue, {
      accountLevel,
      stopped: context.summary?.automationStopped?.reason === "experience-guard",
    });
  const pearlStatus = summarizePearlStatus(syncValue, { nowMs });
  const materialShopStatus = summarizeMaterialShopStatus(syncValue, { nowMs });
  const materialShopRefreshOptions = getMaterialShopMidnightRefreshOptions();
  const fmlLandStatus = summarizeFmlLandStatus(syncValue, { nowMs });
  const plantWaterRefill = getPlantWaterRefillContext(syncValue);
  const waterRefillBlockedReason = context.summary?.waterRefillBlockedReason || null;
  const waterRefillBlockedReasonText = context.summary?.waterRefillBlockedReasonText || null;
  const waterDecision = buildWaterDecision(context.summary?.waterDecision || plantWaterRefill, {
    blockedReason: waterRefillBlockedReason,
    blockedReasonText: waterRefillBlockedReasonText,
  });
  const freeWaterStatus = summarizeFreeWaterStatus(syncValue, {
    nowMs: now.getTime(),
    waterDropThreshold: plantWaterRefill.threshold,
    plantWaterRefill,
  });
  const waterwheelAutomationSetting = getWaterwheelAutomationSetting();
  const waterwheelStatus = {
    ...summarizeWaterwheelStatus(syncValue, {
      nowMs,
      waterDropThreshold: plantWaterRefill.threshold,
      plantWaterRefill,
      autoReceiveEnabled: waterwheelAutomationSetting.effectiveAutoReceiveEnabled,
      autoReceiveDisabledReason: waterwheelAutomationSetting.reason,
      autoReceiveDisabledReasonText: waterwheelAutomationSetting.reasonText,
      skipVideoBuckets: waterwheelAutomationSetting.configuredSkipVideoBucketsEnabled,
    }),
    configuredAutoReceiveEnabled: waterwheelAutomationSetting.configuredAutoReceiveEnabled,
    effectiveAutoReceiveEnabled: waterwheelAutomationSetting.effectiveAutoReceiveEnabled,
    configuredSkipVideoBucketsEnabled: waterwheelAutomationSetting.configuredSkipVideoBucketsEnabled,
    effectiveSkipVideoBucketsEnabled: waterwheelAutomationSetting.effectiveSkipVideoBucketsEnabled,
    autoReceiveEnabled: waterwheelAutomationSetting.effectiveAutoReceiveEnabled,
    skipVideoBucketsEnabled: waterwheelAutomationSetting.effectiveSkipVideoBucketsEnabled,
    autoReceiveSettingSource: waterwheelAutomationSetting.source,
    autoReceiveDisabledReason: waterwheelAutomationSetting.reason,
    autoReceiveDisabledReasonText: waterwheelAutomationSetting.reasonText,
  };
  const ordinaryResidentAutoSubmitSetting = getOrdinaryResidentAutoSubmitSetting();
  const cyclicStoryAutoSubmitSetting = getCyclicStoryAutoSubmitSetting();
  const cyclicStoryOnlyHighestExperienceSetting = getCyclicStoryOnlyHighestExperienceSetting();
  const orderActions = getAutoSubmitOrderActions(orderStatus);
  const ordinaryResidentOrderActions = getAutoSubmitOrdinaryResidentOrderActions(orderStatus, mainTaskStatus, {
    autoSubmitEnabled: ordinaryResidentAutoSubmitSetting.ordinaryAutoSubmitEnabled,
    bypassSpecialOrderDailyLimit:
      ordinaryResidentAutoSubmitSetting.bypassSpecialOrderDailyLimit === true,
  });
  const ordinaryResidentOrderGateReason = getOrdinaryResidentOrderGateReason(
    orderStatus,
    ordinaryResidentOrderActions,
    ordinaryResidentAutoSubmitSetting,
  );
  const customerOrderActions = getAutoSubmitCustomerOrderActions(customerStatus);
  const palaceOrderActions = getAutoSubmitPalaceOrderActions(palaceStatus);
  const mainTaskActions = getAutoSubmitMainTaskActions(mainTaskStatus);
  const cyclicStoryStatus = summarizeCyclicStoryStatus(syncValue, {
    autoSubmitEnabled: cyclicStoryAutoSubmitSetting.enabled,
    onlyHighestExperienceOrder: cyclicStoryOnlyHighestExperienceSetting.enabled,
  });
  const cyclicStoryActions = (cyclicStoryAutoSubmitSetting.enabled
    ? getAutoSubmitCyclicStoryActions(cyclicStoryStatus, {
      onlyHighestExperienceOrder: cyclicStoryOnlyHighestExperienceSetting.enabled,
    })
    : []
  ).slice(0, CYCLIC_STORY_MAX_SUBMIT_PER_CYCLE);
  const cyclicNoteStatus = summarizeCyclicNoteWithResourceActionTime(syncValue, {
    actionTime: cyclicNoteActionTime,
  });
  const cyclicNoteNaturalCompletion = getCyclicNoteNaturalCompletionSetting();
  const cyclicNoteNaturalPlan = cyclicNoteNaturalCompletion.enabled
    ? planCyclicNoteNaturalCompletion(cyclicNoteStatus, {
      onlyHighestRewardTask: cyclicNoteNaturalCompletion.onlyHighestRewardTask,
    })
    : null;
  const cyclicNoteActions = cyclicNoteNaturalCompletion.enabled
    ? (cyclicNoteNaturalPlan?.kind === "receive" ? cyclicNoteNaturalPlan.receives : [])
    : [];
  const decoratedCustomerOrderActions = customerOrderActions.map((action) => ({
    ...action,
    ...describeCustomerOrderAction(action),
  }));
  const customerOrderQueue = getCustomerOrderQueueSnapshot(
    customerStatus,
    decoratedCustomerOrderActions,
  );
  const waterwheelActions = getAutoWaterwheelActions(waterwheelStatus);
  const pearlHireItemReserveCount = getPearlHireItemReserveCount();
  const pearlActions = getAutoPearlActions(pearlStatus, {
    maxHires: getPearlMaxHiresPerCycle(),
    hireItemReserveCount: pearlHireItemReserveCount,
  });
  const materialShopActions = materialShopStatus.actions || [];
  const flowerRackActions = flowerRackStatus.actions || [];
  const flowerRackTargetText = `${flowerRackStatus.targetArt.name}(${flowerRackStatus.targetArt.artId})`;
  const flowerRackRuleText = `双倍金币剩余大于 1 分钟时，收取到期金币；${flowerRackTargetText} 库存+可制作不少于 ${flowerRackStatus.targetArt.need} 才上架 ${flowerRackStatus.targetArt.targetGroups} 组，每组 ${flowerRackStatus.targetArt.groupSize} 个`;
  const mainTaskDetailText = mainTaskStatus.exists
    ? `当前任务详情：任务 ${mainTaskStatus.taskId ?? "-"}，${mainTaskStatus.desc || "配置中没有任务说明"}；进度 ${mainTaskStatus.progressText}；状态 ${mainTaskStatus.statusText}；自动处理：${mainTaskStatus.actionText}。`
    : `当前任务详情：${mainTaskStatus.statusText || "暂无主线任务状态"}；当前值 ${mainTaskStatus.curValue ?? "-"}；数据来源 ${mainTaskStatus.sourcePath || "-"}${mainTaskStatus.rawFieldText ? `；原始字段 ${mainTaskStatus.rawFieldText}` : ""}。`;
  const statusPageLifecycle = getStatusPageLifecycle(context);
  const statusLifecycleProfileId = String(process.env.PROFILE_ID || "");
  const htmlRefreshSeconds = statusPageLifecycle.refreshEnabled
    ? Math.max(1, Math.ceil((getStatusRefreshIntervalMs() || 60_000) / 1000))
    : null;
  const htmlRefreshMeta = htmlRefreshSeconds == null
    ? ""
    : `  <meta http-equiv="refresh" content="${htmlRefreshSeconds}">`;
  const countdownScript = statusPageLifecycle.countdownEnabled
    ? `
  <script>
    function fmt(ms) {
      if (!Number.isFinite(ms)) return "-";
      if (ms <= 0) return "可收获";
      const total = Math.ceil(ms / 1000);
      const d = Math.floor(total / 86400);
      const h = Math.floor((total % 86400) / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (d) return d + "天" + String(h).padStart(2, "0") + "小时" + String(m).padStart(2, "0") + "分" + String(s).padStart(2, "0") + "秒";
      return h ? h + "小时" + String(m).padStart(2, "0") + "分" + String(s).padStart(2, "0") + "秒" : m + "分" + String(s).padStart(2, "0") + "秒";
    }
    function tick() {
      const now = Date.now();
      document.querySelectorAll(".countdown").forEach((el) => {
        if (el.dataset.mature === "1") {
          el.textContent = "可收获";
          return;
        }
        const next = Number(el.dataset.nextMs || 0);
        el.textContent = next ? fmt(next - now) : "-";
      });
    }
    tick();
    let countdownTimer = setInterval(tick, 1000);
    let lifecycleTimer = null;
    let pageStopped = false;
    const profileId = ${JSON.stringify(statusLifecycleProfileId)};
    function stopPageLifecycle() {
      if (pageStopped) return;
      pageStopped = true;
      clearInterval(countdownTimer);
      if (lifecycleTimer) clearInterval(lifecycleTimer);
      document.querySelector('meta[http-equiv="refresh"]')?.remove();
      document.documentElement.dataset.statusLifecycle = "stopped";
    }
    async function pollPageLifecycle() {
      if (pageStopped || !profileId) return;
      try {
        const lifecycleUrl = "/api/profiles/"
          + encodeURIComponent(profileId)
          + "/status?full=0";
        const response = await fetch(lifecycleUrl, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const status = await response.json();
        const stopped = status?.summary?.risk?.automationStopped
          || status?.projection?.garden?.summary?.automationStopped
          || status?.summary?.automationStopped;
        if (stopped?.stopped === true || stopped?.reason) stopPageLifecycle();
      } catch {}
    }
    if (profileId) {
      lifecycleTimer = setInterval(pollPageLifecycle, 5000);
      pollPageLifecycle();
    }
  </script>`
    : "";
  const recommendedFlower = state.recommendation.plantFlower?.flowerId;
  const recommendedFlowerLabel = formatFlowerLabel(recommendedFlower, flowerNames);
  const selectedPlantInventory = recommendedFlower
    ? plantInventory.find((item) => item.flowerId === recommendedFlower)
    : null;
  const nextMatureTime = getNextMatureTime(state.land);
  const nextMatureInSeconds = getNextMatureInSeconds(state.land);
  const nextMatureText = nextMatureInSeconds == null ? "-" : fmtDuration(nextMatureInSeconds * 1000);
  const fmlLandScanIntervalMs = getFmlLandScanIntervalMs();
  const nextFmlLandScanAtMs = lastFmlLandScanAttemptAtMs ? lastFmlLandScanAttemptAtMs + fmlLandScanIntervalMs : 0;
  const nextFmlLandScanText = nextFmlLandScanAtMs ? formatDateTime(nextFmlLandScanAtMs) : "下一轮";
  const pearlHireItemText = `雇佣卡 ${pearlStatus.hireItemCount ?? "-"}`;
  const waterwheelSwitchStatusText = waterwheelStatus.effectiveAutoReceiveEnabled
    ? "领取水车水桶：开启"
    : `领取水车水桶：关闭（${waterwheelStatus.autoReceiveDisabledReasonText || "未生效"}）`;
  const waterwheelRuleText = !waterwheelStatus.effectiveAutoReceiveEnabled
    ? "领取开关未生效；仅同步水车状态，不调用 skip/recv"
    : waterwheelStatus.effectiveSkipVideoBucketsEnabled
      ? `需要种植土地组且种植前水滴少于 ${waterwheelStatus.threshold} 时，普通桶直接领取；视频桶跳过视频并领取基础水滴`
      : `需要种植土地组且种植前水滴少于 ${waterwheelStatus.threshold} 时，普通桶直接领取；保留视频桶不领取`;
  const waterwheelAutoReceiveRule = !waterwheelStatus.effectiveAutoReceiveEnabled
    ? "status sync only while bucket receive is disabled; do not call gs.waterwheel.skip or gs.waterwheel.recv"
    : waterwheelStatus.effectiveSkipVideoBucketsEnabled
      ? "only when a plantable land group exists and pre-plant water drops are below the plant refill threshold; receive normal buckets directly; for a video bucket, skip the video requirement then receive its base water drops"
      : "only when a plantable land group exists and pre-plant water drops are below the plant refill threshold; receive normal buckets directly; retain video buckets without receiving them";
  const waterwheelAutomationRow = {
    area: "水车水桶",
    pending: waterwheelActions.length,
    status: `${waterwheelSwitchStatusText}；已储存水桶 ${waterwheelStatus.storedBucketCount}/${waterwheelStatus.storedBucketMax}；今日已领取 ${waterwheelStatus.claimedBucketCount}/${waterwheelStatus.maxBucketCount}；今日剩余 ${waterwheelStatus.remainingDailyBucketCount}；下一桶 ${waterwheelStatus.nextBucketNo ?? "-"}；视频桶：${waterwheelStatus.nextBucketVideoText}；${waterwheelStatus.reasonText}`,
    rule: waterwheelRuleText,
  };
  const plantingAutomationRow = {
    area: "土地补种",
    pending: plantingBlockers.length,
    status: plantingBlockerStatusText,
    rule: plantingRule.ruleText,
  };
  const experienceGuardThresholdPercentText =
    formatExperienceGuardThresholdPercent(experienceGuard.thresholdPercent);
  const experienceGuardAutomationRow = {
    area: "经验保护",
    pending: experienceGuard.blocked ? 1 : 0,
    status: experienceGuard.reasonText,
    rule: `${experienceGuardThresholdPercentText}%经验保护门槛：保护线为升级所需经验 × ${experienceGuardThresholdPercentText}% = ${experienceGuard.thresholdRemainingExp ?? "未知"}；已知有经验动作逐次按“当前经验 + 预测经验上界 < 升级所需经验 - 保护线”放行；到达或越过保护线仅跳过有经验动作，无经验动作继续`,
    state: experienceGuard.blocked ? "blocked" : "idle",
  };
  const cyclicNoteAutomationRow = cyclicNoteStatus.active
    ? {
      area: "花笺集芳",
      pending: cyclicNoteActions.length,
      status: !cyclicNoteStatus.executionSafe
        ? cyclicNoteStatus.reasonText
        : cyclicNoteStatus.active
        ? (cyclicNoteNaturalCompletion.enabled
          ? cyclicNoteNaturalPlan?.kind === "receive"
            ? `可领取 ${cyclicNoteActions.length} / 当前任务 ${cyclicNoteStatus.taskSlots.length}`
            : `目标 ${cyclicNoteNaturalPlan?.target?.slotIndex ?? "-"} 槽 / ${cyclicNoteNaturalPlan?.reason || "等待权威快照"}`
          : `自动执行已关闭 / 当前任务 ${cyclicNoteStatus.taskSlots.length}`)
        : cyclicNoteStatus.reasonText,
      rule: cyclicNoteNaturalCompletion.enabled
        ? (cyclicNoteNaturalCompletion.onlyHighestRewardTask
          ? "活动进行期先领取权威三槽中全部已完成任务；无完成任务时优先推进1107奖励最高的可支持任务；不使用元宝立即完成、不刷新星级、不解锁、不买礼包、不领宝箱、不进商店。"
          : "活动进行期先领取权威三槽中全部已完成任务；无完成任务时依槽位推进全部可支持任务；不使用元宝立即完成、不刷新星级、不解锁、不买礼包、不领宝箱、不进商店。")
        : "自动执行已关闭：仅展示活动与当前三槽任务进度，不自动推进或领取；不刷新星级、不解锁、不立即完成、不买礼包、不领宝箱、不进商店兑换",
      state: cyclicNoteActions.length ? "pending" : "idle",
      cyclicNote: cyclicNoteStatus,
    }
    : null;
  const cyclicStoryAutomationRow = cyclicStoryStatus.active
    ? {
      area: "莳花纪闻",
      pending: cyclicStoryActions.length,
      autoSubmitEnabled: cyclicStoryAutoSubmitSetting.enabled,
      onlyHighestExperienceOrder: cyclicStoryOnlyHighestExperienceSetting.enabled,
      status: cyclicStoryAutoSubmitSetting.enabled
        ? cyclicStoryOnlyHighestExperienceSetting.enabled
          ? `最高经验模式：可提交 ${cyclicStoryActions.length} / 当前订单 ${cyclicStoryStatus.orders.length}；经验单 ${cyclicStoryStatus.expOrderNum}/${cyclicStoryStatus.expOrderMax ?? "-"}`
          : `可提交 ${cyclicStoryActions.length} / 当前订单 ${cyclicStoryStatus.orders.length}；经验单 ${cyclicStoryStatus.expOrderNum}/${cyclicStoryStatus.expOrderMax ?? "-"}`
        : "已关闭：自动提交莳花纪闻订单开关关闭",
      rule: cyclicStoryOnlyHighestExperienceSetting.enabled
        ? "活动进行期锁定最新 enter 返回的当前3单；任一订单冷却时整轮等待，三单均结束后只提交 expectedExperience 最高的一单；最高经验单缺库存不降级；每轮最多1单；每单先过经验保护；不重随、不花元宝去冷却、不买礼包、不领进度奖励、不进商店"
        : "活动进行期仅提交倒计时结束且库存足够的当前订单；每单先过经验保护；不重随、不花元宝去冷却、不买礼包、不领进度奖励、不进商店",
      state: cyclicStoryActions.length ? "pending" : "idle",
      cyclicStory: cyclicStoryStatus,
    }
    : null;
  const automationRows = [
    experienceGuardAutomationRow,
    plantingAutomationRow,
    waterwheelAutomationRow,
    {
      area: "挑水工水滴",
      pending: freeWaterStatus.canReceive ? 1 : 0,
      status: freeWaterStatus.canReceive
        ? `水滴 ${freeWaterStatus.waterDropText}，可领取第 ${freeWaterStatus.nextReceiveNo} 次，每次 +${freeWaterStatus.receiveWaterDropCount}`
        : `${freeWaterStatus.reasonText}；今日 ${freeWaterStatus.receivedCountToday}/${freeWaterStatus.maxDailyCount}`,
      rule: `需要种植土地组且种植前水滴少于 ${freeWaterStatus.threshold} 时，只在 ${freeWaterStatus.slots.map((slot) => slot.timeWindowText).join("、")} 时间段调用挑水工领取，每天最多 ${freeWaterStatus.maxDailyCount} 次，不处理补领/广告/水车`,
    },
    {
      area: "丝绸/建材",
      pending: orderActions.length,
      status: orderActions.length ? "有可提交订单" : "暂无可提交",
      rule: "非视频/广告、材料足够、冷却结束才提交",
    },
    {
      area: "普通居民订单",
      pending: ordinaryResidentOrderActions.length,
      gateReason: ordinaryResidentOrderGateReason,
      ordinaryResidentOrderGateReason,
      ordinaryAutoSubmitEnabled: ordinaryResidentAutoSubmitSetting.ordinaryAutoSubmitEnabled,
      levelUpAutoSubmitEnabled: ordinaryResidentAutoSubmitSetting.levelUpEnabled,
      singleSampleValidationEnabled:
        ordinaryResidentAutoSubmitSetting.singleSampleValidationEnabled === true,
      specialDailyLimitBypassed:
        ordinaryResidentAutoSubmitSetting.bypassSpecialOrderDailyLimit === true,
      status: ordinaryResidentAutoSubmitSetting.singleSampleValidationEnabled
        ? `单次验证；可提交 ${orderStatus.ordinary?.readyCount ?? 0}/${orderStatus.ordinary?.total ?? 0}；本进程最多 1 轮、普通订单最多 1 笔`
        : !ordinaryResidentAutoSubmitSetting.ordinaryAutoSubmitEnabled
          ? "已关闭：自动提交普通居民订单开关关闭"
          : `开关已开启；主线仅作观测；可提交 ${orderStatus.ordinary?.readyCount ?? 0}/${orderStatus.ordinary?.total ?? 0}；丝绸上限 ${orderStatus.satin?.dailyLimitReached ? "是" : "否"}；建材上限 ${orderStatus.decorate?.dailyLimitReached ? "是" : "否"}`,
      rule: ordinaryResidentAutoSubmitSetting.singleSampleValidationEnabled
        ? "仅显式单次样本环境可旁路项目内部的丝绸/建材日上限门槛；必须同时满足单轮、单步和其他收益处理器关闭"
        : "开关开启后仅按普通居民订单自身的库存、视频、冷却、补位、每日上限、49/99及团队经验保护判断；主线任务状态只展示不设门禁",
    },
    {
      area: "宫廷订单",
      pending: palaceOrderActions.length,
      status: palaceStatus.exists
        ? `${palaceStatus.statusText}; ${palaceStatus.flowerLabel} ${palaceStatus.have ?? "-"}/${palaceStatus.need ?? "-"}; double gold ${palaceStatus.doubleGoldGate?.remainingText ?? "-"}`
        : palaceStatus.statusText,
      rule: "双倍金币剩余至少 1 分钟且所需花朵库存足够时自动提交",
    },
    {
      area: "主线任务",
      pending: mainTaskActions.length,
      status: mainTaskStatus.exists
        ? `任务 ${mainTaskStatus.taskId ?? "-"}：${mainTaskStatus.statusText}；进度 ${mainTaskStatus.progressText}`
        : mainTaskDetailText,
      rule: "当前主线任务进度达标且未领取时调用 gs.taskMain.recv；同轮最多领取 MAIN_TASK_MAX_SUBMIT_PER_CYCLE 次",
    },
    {
      area: "顾客订单",
      pending: customerOrderActions.length,
      status: customerOrderActions.length ? "有可处理订单" : "暂无可执行动作",
      rule: CUSTOMER_ORDER_STATUS_RULE_TEXT,
    },
    {
      area: "公会土地",
      pending: fmlLandStatus.harvestableCount,
      status: !fmlLandStatus.exists
        ? "暂无公会土地状态"
        : `可收获 ${fmlLandStatus.harvestableCount} / ${fmlLandStatus.total}，下次扫描：${nextFmlLandScanText}`,
      rule: "明细每 5 秒刷新；自动收获每 15 分钟主动扫描一次，若刷新状态已可收获则立即复核并收获；成熟判断按 c_fmlLandLvl[lvl].time/stock 和 lastCalcTime/startTime，不按花朵自身成熟时间",
    },
    {
      area: "花架金币",
      pending: flowerRackActions.length,
      status: !flowerRackStatus.exists
        ? "暂无花架状态"
        : flowerRackStatus.reasonText,
      rule: flowerRackRuleText,
    },
    {
      area: "珍珠采集",
      pending: pearlActions.length,
      status: !pearlStatus.exists
        ? "暂无珍珠状态"
        : pearlActions.length
          ? `可收取/可雇佣，${pearlHireItemText}`
          : `空闲坑位 ${pearlStatus.freePlaceIds.length}，世界推荐 ${pearlStatus.recommendCount}，${pearlHireItemText}`,
      rule: `只用世界推荐；空闲坑位且雇佣卡大于 ${pearlHireItemReserveCount} 张时才自动雇佣，始终保留 ${pearlHireItemReserveCount} 张`,
    },
    {
      area: "材料商城",
      pending: materialShopActions.length,
      status: !materialShopStatus.exists
        ? "等待进入材料商店"
        : materialShopStatus.reasonText,
      rule: `右下角悬浮面板 -> 商城 -> 材料；仅当前可买项全部为金币且金币足够时才全部购买；午夜刷新${materialShopRefreshOptions.enabled ? `已开启（${materialShopRefreshOptions.windowStart}-${materialShopRefreshOptions.windowEnd}，单次价格 ≤ ${materialShopRefreshOptions.maxCostYuanbao} 元宝）` : "未开启"}`,
    },
  ];
  if (cyclicStoryAutomationRow) automationRows.push(cyclicStoryAutomationRow);
  if (cyclicNoteAutomationRow) automationRows.push(cyclicNoteAutomationRow);

  const cultivatedInventory = decoratedInventory.filter((item) => item.cultivated);
  const uncultivatedInventory = sortUncultivatedFlowerInventory(decoratedInventory.filter((item) => !item.cultivated));
  const cultivatedFlowerInventoryRows = (rows) => rows.map((item) => `
      <tr>
        <td>${escHtml(item.flowerName)}</td>
        <td>${item.flowerId}</td>
        <td>${item.count}</td>
        <td>${item.lvl}</td>
        <td>${escHtml(item.acquisitionText)}</td>
        <td>${escHtml(item.maturityText)}</td>
        <td>${item.plantedCount}</td>
        <td>${escHtml(item.cTimeText)}</td>
      </tr>`).join("");
  const uncultivatedFlowerInventoryRows = (rows) => rows.map((item) => `
      <tr>
        <td>${escHtml(item.flowerName)}</td>
        <td>${item.flowerId}</td>
        <td>${item.count}</td>
        <td>${item.lvl}</td>
        <td>${escHtml(item.acquisitionText)}</td>
        <td>${escHtml(item.maturityText)}</td>
        <td>${escHtml(item.cTimeText)}</td>
        <td>${escHtml(item.cultivationCostText)}</td>
        <td>${escHtml(item.missingCultivationCostText)}</td>
      </tr>`).join("");
  const cultivatedInventoryRows = cultivatedFlowerInventoryRows(cultivatedInventory);
  const uncultivatedInventoryRows = uncultivatedFlowerInventoryRows(uncultivatedInventory);
  const flowerArtRows = flowerArtInventory.map((item) => `
      <tr>
        <td>${escHtml(item.artName)}</td>
        <td>${escHtml(item.artId)}</td>
        <td>${escHtml(item.artCount)}</td>
        <td>${escHtml(item.salePriceText)}</td>
        <td>${escHtml(item.vaseText)}</td>
        <td>${escHtml(item.flowersText)}</td>
      </tr>`).join("");
  const orderRows = [orderStatus.satin, orderStatus.decorate].map((order) => `
      <tr>
        <td>${escHtml(order.kindText)}</td>
        <td>${escHtml(order.statusText)}</td>
        <td>${escHtml(formatCompletedCount(order))}</td>
        <td>${escHtml(order.completedCountSourceText || "-")}</td>
        <td>${escHtml(formatNullableCount(order.homePopupCompletedCount))}</td>
        <td>${escHtml(formatNullableCount(order.businessStatsCompletedCount))}</td>
        <td>${escHtml(formatNullableCount(order.finishCnt))}</td>
        <td>${escHtml(orderAutoSubmitText(order))}</td>
        <td>${order.isVideo ? "是" : "否"}</td>
        <td>${escHtml(order.remainingText)}</td>
        <td>${escHtml(order.cdTimeText)}</td>
        <td>${escHtml(formatOrderRequirements(order.requirements))}</td>
      </tr>`).join("");
  const palaceRows = palaceStatus.exists ? `
      <tr>
        <td>${escHtml(palaceStatus.statusText)}</td>
        <td>${escHtml(palaceStatus.actionText)}</td>
        <td>${escHtml(palaceStatus.flowerLabel)}</td>
        <td>${escHtml(palaceStatus.flowerId ?? "-")}</td>
        <td>${escHtml(palaceStatus.have ?? "-")}</td>
        <td>${escHtml(palaceStatus.need ?? "-")}</td>
        <td>${escHtml(palaceStatus.missing ?? "-")}</td>
        <td>${escHtml(palaceStatus.doubleGoldGate?.remainingText ?? "-")}</td>
        <td>${escHtml(palaceStatus.cTimeText)}</td>
      </tr>`
    : "";
  const mainTaskRows = `
      <tr>
        <td>${escHtml(mainTaskStatus.taskId ?? "-")}</td>
        <td>${escHtml(mainTaskStatus.statusText)}</td>
        <td>${escHtml(mainTaskStatus.actionText)}</td>
        <td>${escHtml(mainTaskStatus.progressText)}</td>
        <td>${escHtml(mainTaskStatus.curValue ?? "-")}</td>
        <td>${escHtml(mainTaskStatus.targetValue ?? "-")}</td>
        <td>${escHtml(mainTaskStatus.desc || mainTaskStatus.rawFieldText || "-")}</td>
        <td>${escHtml(mainTaskStatus.sourcePath || "-")}</td>
      </tr>`;
  const residentBoard = orderStatus.residentBoard || {};
  const residentBoardStopText = residentBoard.pauseSpecialOrders
    ? "已触发暂停丝绸/建材自动提交"
    : "未触发暂停";
  const residentBoardSummary = `居民订单板总数：${formatNullableCount(residentBoard.completedCount)}；来源：${residentBoard.completedCountSourceText || "-"}；触发前停单点：${(residentBoard.stopCounts || []).join("/") || "-"}；本轮还会限制批量提交，避免推进到 50/100；${residentBoardStopText}`;
  const customerRows = (customerStatus.orders || []).map((order) => `
      <tr>
        <td>${escHtml(order.npcId ?? "-")}</td>
        <td>${escHtml(order.statusText)}</td>
        <td>${escHtml(order.actionText)}</td>
        <td>${escHtml(order.flowerCurrencyReward ?? "-")}</td>
        <td>${escHtml(customerStatus.flowerCurrencySelection.historicalMaxReward ?? "-")}</td>
        <td>${escHtml(customerStatus.flowerCurrencySelection.releaseRewards?.join("、") || "未选择")}</td>
        <td>${escHtml(order.flowerCurrencyDecisionText ?? order.flowerCurrencyDecision ?? "-")}</td>
        <td>${escHtml(order.artLabel)}</td>
        <td>${escHtml(order.artId ?? "-")}</td>
        <td>${escHtml(order.haveArt ?? "-")}</td>
        <td>${escHtml(order.needArt ?? "-")}</td>
        <td>${escHtml(order.missingArt ?? "-")}</td>
        <td>${escHtml(order.vaseId ?? "-")}</td>
        <td>${escHtml(formatCustomerRequirements(order.flowerRequirements))}</td>
        <td>${escHtml(customerStatus.doubleGoldGate?.remainingText ?? "-")}</td>
        <td>${escHtml(order.cTimeText)}</td>
      </tr>`).join("");
  const customerDailyCountText = customerStatus.dailyLimit?.dailyCountKnown
    && customerStatus.dailyLimit?.tdyCompletedCount != null
    ? String(customerStatus.dailyLimit.tdyCompletedCount)
    : "-";
  const customerDailyLimitText = customerStatus.dailyLimit?.dailyLimit != null
    ? String(customerStatus.dailyLimit.dailyLimit)
    : "-";
  const customerHistorySummaryText = `账号 ${customerStatus.flowerCurrencySelection.historyAccountId ?? "-"}；历史最高（审计） ${customerStatus.flowerCurrencySelection.historicalMaxReward ?? "-"}；当前放行列表 ${customerStatus.flowerCurrencySelection.releaseRewards?.join("、") || "未选择"}；记录 ${customerStatus.flowerCurrencySelection.historyRecordStatus ?? "-"}`;
  const customerSummaryText = `今日完成 ${customerDailyCountText}/${customerDailyLimitText}；当前 ${customerStatus.total} 单；可提交 ${customerStatus.readyCount} 单；可制作并提交 ${customerStatus.makeArtReadyCount} 单；未在放行列表/暂时没货（按官方按钮拒绝）${customerStatus.temporaryOutOfStockCount} 单；花艺未激活 ${customerStatus.inactiveArtCount} 单；等待完成 ${customerStatus.pendingWaitCount} 单。${customerHistorySummaryText}。`;
  const pearlRows = (pearlStatus.placeRows || []).map((row) => `
      <tr>
        <td>${escHtml(row.placeId)}</td>
        <td>${escHtml(row.stateText)}</td>
        <td>${escHtml(row.laborDisplayText ?? row.laborUid ?? "-")}</td>
        <td>${escHtml(row.canRecvNum ?? 0)}</td>
        <td>${escHtml(row.totalRecvNum ?? "-")}</td>
        <td>${escHtml(row.remainingText ?? "-")}</td>
        <td>${escHtml(row.restRemainingText ?? "-")}</td>
        <td>${escHtml(row.laborEndTimeText ?? "-")}</td>
      </tr>`).join("");
  const materialShopRows = (materialShopStatus.rows || []).map((row) => `
      <tr>
        <td>${escHtml(row.index)}</td>
        <td>${escHtml(row.shopId)}</td>
        <td>${escHtml(row.itemName)}</td>
        <td>${escHtml(row.itemId ?? "-")}</td>
        <td>${escHtml(row.itemNum ?? "-")}</td>
        <td>${escHtml(row.priceText)}</td>
        <td>${escHtml(row.limitNum)}</td>
        <td>${escHtml(row.boughtCount)}</td>
        <td>${escHtml(row.remainingCount)}</td>
        <td>${escHtml(row.statusText)}</td>
        <td>${escHtml(row.reasonText)}</td>
      </tr>`).join("");
  const flowerRackRows = (flowerRackStatus.rows || []).map((row) => {
    const artText = row.artId
      ? row.artId === flowerRackStatus.targetArt.artId
        ? `${flowerRackStatus.targetArt.name} (${row.artId})`
        : String(row.artId)
      : "-";
    return `
      <tr>
        <td>${escHtml(row.rackId)}</td>
        <td>${escHtml(row.statusText)}</td>
        <td>${escHtml(artText)}</td>
        <td>${escHtml(row.num || "-")}</td>
        <td>${escHtml(row.sellStartTimeText)}</td>
        <td>${escHtml(row.remainingText)}</td>
      </tr>`;
  }).join("");
  const fmlLandRows = (fmlLandStatus.rows || []).map((row) => `
      <tr>
        <td>${escHtml(row.landId)}</td>
        <td>${escHtml(row.flowerId ? flowerName(row.flowerId, flowerNames) : "-")}</td>
        <td>${escHtml(row.flowerId || "-")}</td>
        <td>${escHtml(row.lvl ?? "-")}</td>
        <td>${escHtml(row.displayMatureFlwCnt ?? row.matureFlwCnt ?? 0)}</td>
        <td>${escHtml(row.stock ?? "-")}</td>
        <td>${escHtml(row.statusText)}</td>
        <td>${escHtml(formatDateTime(row.startTime))}</td>
        <td>${escHtml(formatDateTime(row.matureAtMs))}</td>
        <td>${escHtml(formatDateTime(row.lastCalcTime))}</td>
        <td>${escHtml(row.matureSource ?? "-")}</td>
      </tr>`).join("");
  const automationHtmlRows = automationRows.map((row) => `
      <tr>
        <td>${escHtml(row.area)}</td>
        <td>${escHtml(row.pending)}</td>
        <td>${escHtml(row.status)}</td>
        <td>${escHtml(row.rule)}</td>
      </tr>`).join("");
  const plantingBlockerHtmlRows = plantingBlockers.map((row) => `
      <tr>
        <td>${escHtml(row.groupIndex ?? row.groupKey ?? "-")}</td>
        <td>${escHtml(row.reasonText)}</td>
        <td>${escHtml(row.emptyLandCount)}</td>
        <td>${escHtml(row.waterDropCount ?? "-")}</td>
        <td>${escHtml(row.flowerId ?? "-")}</td>
        <td>${escHtml(row.currentMatureSpanText ?? "-")}</td>
        <td>${escHtml(row.predictedMatureSpanText ?? "-")}</td>
      </tr>`).join("");
  const waterwheelCardHtml = `
    <div class="card resource">水车水桶<b>${escHtml(`${waterwheelStatus.storedBucketCount}/${waterwheelStatus.storedBucketMax}`)}</b><small>今日已领取：${escHtml(`${waterwheelStatus.claimedBucketCount}/${waterwheelStatus.maxBucketCount}`)}；今日剩余：${escHtml(waterwheelStatus.remainingDailyBucketCount)}；下一桶：${escHtml(waterwheelStatus.nextBucketNo ?? "-")}；下一桶生成：${escHtml(waterwheelStatus.nextBucketGenerationInSeconds == null ? "-" : `${waterwheelStatus.nextBucketGenerationInSeconds}秒`)}；视频桶：${escHtml(waterwheelStatus.nextBucketVideoText)}；${escHtml(waterwheelStatus.reasonText)}</small></div>`;
  const resourceCardHtml = resourceList.map((item) => `
    <div class="card resource">${escHtml(item.label)}<b>${escHtml(item.displayText)}</b><small>itemId ${escHtml(item.itemId)}</small></div>`).join("");
  const customerHistoryRows = runHistory.customerOrderSubmissions.map((entry) => `
      <tr>
        <td>${escHtml(entry.submittedAtText)}</td>
        <td>${escHtml(entry.cycle ?? "-")}</td>
        <td>${escHtml(entry.npcId ?? "-")}</td>
        <td>${escHtml(entry.artLabel ?? "-")}</td>
        <td>${escHtml(entry.haveArt ?? "-")}/${escHtml(entry.needArt ?? "-")}</td>
        <td>${escHtml(formatHistoryCustomerRequirement(entry.flowerRequirements))}</td>
        <td>${escHtml(entry.outcomeText ?? "-")}</td>
        <td>${escHtml(entry.reason ?? "-")}</td>
      </tr>`).join("");
  const customerCheckRows = (runHistory.customerOrderChecks || []).map((entry) => `
      <tr>
        <td>${escHtml(entry.checkedAtText)}</td>
        <td>${escHtml(entry.cycle ?? "-")}</td>
        <td>${escHtml(entry.customerStep ?? "-")}</td>
        <td>${escHtml(entry.total ?? 0)}</td>
        <td>${escHtml(entry.actionCount ?? 0)}</td>
        <td>${escHtml(entry.resultText ?? "-")}</td>
        <td>${entry.doubleGoldReady ? "是" : "否"}</td>
        <td>${escHtml(entry.doubleGoldRemainingText ?? "-")}</td>
        <td>${escHtml(formatCustomerCheckOrders(entry.orders))}</td>
      </tr>`).join("");
  const landRows = state.land.rows.map((row) => {
    const remain = remainingMs(row);
    const nextMs = row.nextTime ? Date.parse(row.nextTime) : "";
    return `
      <tr>
        <td>${row.landId}</td>
        <td>${escHtml(row.flowerId ? flowerName(row.flowerId, flowerNames) : "-")}</td>
        <td>${row.flowerId || "-"}</td>
        <td>${row.lvl ?? "-"}</td>
        <td>${landStatusText(row)}</td>
        <td>${escHtml(formatDateTime(row.nextTime))}</td>
        <td class="countdown" data-next-ms="${nextMs}" data-mature="${row.mature ? "1" : "0"}">${fmtDuration(remain)}</td>
        <td>${row.harvestCnt ?? "-"}</td>
      </tr>`;
  }).join("");
  const runtimeError = context.summary?.loopError || null;
  const runtimeErrorAt = context.summary?.loopErrorAt || null;
  const runtimeErrorHtml = runtimeError
    ? `<div class="panel error"><h2>自动任务异常</h2><p>${escHtml(runtimeErrorAt ? `${runtimeErrorAt}：` : "")}${escHtml(runtimeError)}</p></div>`
    : "";
  const runtimeErrorMd = runtimeError
    ? `\n> 自动任务异常：${mdCell(runtimeErrorAt ? `${runtimeErrorAt}：${runtimeError}` : runtimeError)}\n`
    : "";
  const cycleErrors = resolvePersistentCycleErrors({
    statusMode,
    currentErrors: context.summary?.cycleErrors,
    previousErrors: previousStatus?.summary?.cycleErrors,
  });
  const moduleHealth = context.summary?.moduleHealth
    || activeAutomationModuleHealth?.snapshot?.()
    || previousStatus?.moduleHealth
    || { status: "healthy", unhealthyCount: 0, modules: {} };
  const accountScheduler = context.summary?.accountScheduler
    || previousStatus?.accountScheduler
    || previousStatus?.summary?.accountScheduler
    || null;
  const customerOrderScheduler = context.customerOrderScheduler
    || context.summary?.customerOrderScheduler
    || previousStatus?.customerOrderScheduler
    || previousStatus?.summary?.customerOrderScheduler
    || null;
  const cycleErrorsHtml = cycleErrors.length
    ? `<div class="panel warning"><h2>本轮非致命异常</h2><ul>${cycleErrors.map((item) => `<li>${escHtml(item.step)}：${escHtml(item.message)}</li>`).join("")}</ul></div>`
    : "";
  const cycleErrorsMd = cycleErrors.length
    ? `\n> 本轮非致命异常：${cycleErrors.map((item) => `${mdCell(item.step)}：${mdCell(item.message)}`).join("；")}\n`
    : "";

  const waterDropFlowLabel = statusMode === "loop-refresh" ? "休眠刷新水滴快照" : "本轮水滴流水";
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
${htmlRefreshMeta}
  <title>花园自动化状态</title>
  <style>
    body { font-family: "Microsoft YaHei", Arial, sans-serif; margin: 24px; color: #1f2933; background: #f6f8fa; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    h2 { margin: 0 0 10px; font-size: 18px; }
    .meta { color: #52616b; margin-bottom: 16px; }
    .cards { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
    .card { background: #fff; border: 1px solid #d9e2ec; border-radius: 8px; padding: 12px 16px; min-width: 120px; }
    .card.resource { border-color: #b6d7ff; background: #f8fbff; }
    .card b { display: block; font-size: 22px; margin-top: 4px; }
    .card small { display: block; margin-top: 4px; color: #627d98; font-size: 12px; line-height: 1.35; }
    .panel { margin: 16px 0; background: #fff; border: 1px solid #d9e2ec; border-radius: 8px; padding: 14px; }
    .panel.important { border-color: #b6d7ff; background: #fbfdff; }
    .panel.warning { border-color: #f5c542; background: #fffaf0; }
    .panel.error { border-color: #f5a3a3; background: #fff5f5; color: #8a1f1f; }
    .panel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .quick { border: 1px solid #d9e2ec; border-radius: 8px; padding: 10px 12px; background: #fff; }
    .quick span { color: #627d98; display: block; font-size: 12px; }
    .quick b { display: block; margin-top: 4px; font-size: 17px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d9e2ec; }
    th, td { border: 1px solid #d9e2ec; padding: 7px 9px; text-align: left; font-size: 13px; }
    th { background: #edf2f7; position: sticky; top: 0; }
    .section { border: 1px solid #d9e2ec; }
    .hint { color: #627d98; font-size: 13px; }
  </style>
</head>
<body>
  <h1>花园自动化状态</h1>
  <div class="meta">更新时间：${escHtml(formatDateTime(now))} | 当前轮次：${escHtml(context.cycle ?? "-")} | 最近步骤：${escHtml(context.step ?? "-")}</div>
  ${runtimeErrorHtml}
  ${cycleErrorsHtml}
  <div class="cards">
    <div class="card">总土地<b>${state.land.total}</b></div>
    <div class="card">空地<b>${state.land.empty.length}</b></div>
    <div class="card">成长中<b>${state.land.growing.length}</b></div>
    <div class="card">可收获<b>${state.land.mature.length}</b></div>
    <div class="card">推荐种植<b>${escHtml(recommendedFlowerLabel)}</b></div>
    <div class="card resource">水滴<b>${escHtml(waterDrop.displayText)}</b><small>${escHtml(waterDrop.formulaText)}；下一滴：${escHtml(waterDrop.nextRestoreText)}；${escHtml(waterDropFlowLabel)}：${escHtml(waterDropFlow.flowText)}</small></div>
    <div class="card resource">双倍金币<b>${escHtml(doubleGold.remainingText)}</b></div>
    ${waterwheelCardHtml}
    ${resourceCardHtml}
  </div>

  <div class="panel important">
    <h2>自动化队列</h2>
    <div class="panel-grid">
      <div class="quick"><span>下一块成熟土地</span><b>${escHtml(nextMatureText)}</b></div>
      <div class="quick"><span>成熟时间</span><b>${escHtml(formatDateTime(nextMatureTime))}</b></div>
      <div class="quick"><span>本次启动记录</span><b>顾客检查 ${(runHistory.customerOrderChecks || []).length} / 顾客处理 ${runHistory.customerOrderSubmissions.length}</b></div>
    </div>
    <div class="section" style="margin-top: 12px;">
      <table>
        <thead><tr><th>模块</th><th>待执行动作</th><th>当前状态</th><th>规则</th></tr></thead>
        <tbody>${automationHtmlRows}</tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h2>补种阻断诊断</h2>
    <p class="hint">${escHtml(plantingRule.ruleText)}</p>
    <div class="section">
    <table>
      <thead><tr><th>组</th><th>原因</th><th>空地</th><th>水滴</th><th>目标花</th><th>当前成熟跨度</th><th>预测成熟跨度</th></tr></thead>
      <tbody>${plantingBlockerHtmlRows || '<tr><td colspan="7">暂无同熟窗口阻断</td></tr>'}</tbody>
    </table>
    </div>
  </div>

  <div class="panel">
    <h2>公会土地状态</h2>
    <p class="hint">${statusPageLifecycle.refreshEnabled ? `明细每 ${htmlRefreshSeconds} 秒随状态页刷新；` : "页面已终止，不再刷新；"}自动收获每 ${Math.floor(fmlLandScanIntervalMs / 1000)} 秒主动扫描一次，若刷新状态已可收获则立即复核并收获。成熟判断按 c_fmlLandLvl[lvl].time/stock 和 lastCalcTime/startTime，不按花朵自身成熟时间。</p>
    <div class="section">
    <table>
      <thead><tr><th>土地ID</th><th>花名</th><th>flowerId</th><th>等级</th><th>成熟数量</th><th>stock</th><th>状态</th><th>开始时间</th><th>预计成熟</th><th>lastCalcTime</th><th>判定来源</th></tr></thead>
      <tbody>${fmlLandRows || '<tr><td colspan="11">暂无公会土地状态</td></tr>'}</tbody>
    </table>
    </div>
  </div>

  <div class="panel">
    <h2>花架金币状态</h2>
    <p class="hint">${escHtml(flowerRackRuleText)}；若库存不足但材料可补齐，会先制作再上架。</p>
    <div class="section">
    <table>
      <thead><tr><th>花架</th><th>状态</th><th>花艺</th><th>数量</th><th>上架时间</th><th>剩余时间</th></tr></thead>
      <tbody>${flowerRackRows || '<tr><td colspan="6">暂无花架状态</td></tr>'}</tbody>
    </table>
    </div>
  </div>

  <div class="panel">
    <h2>珍珠采集状态</h2>
    <p class="hint">只使用世界推荐；空闲坑位且雇佣卡大于 ${escHtml(pearlHireItemReserveCount)} 张时自动雇佣，始终保留 ${escHtml(pearlHireItemReserveCount)} 张；已产出的珍珠会一键收取。雇佣卡剩余：${escHtml(pearlStatus.hireItemCount ?? "-")}（itemId ${escHtml(pearlStatus.hireItemId ?? "-")}）。</p>
    <div class="section">
    <table>
      <thead><tr><th>坑位</th><th>状态</th><th>雇佣玩家</th><th>可收珍珠</th><th>本轮总产量</th><th>采集剩余</th><th>休息剩余</th><th>采集结束</th></tr></thead>
      <tbody>${pearlRows || '<tr><td colspan="8">暂无珍珠状态</td></tr>'}</tbody>
    </table>
    </div>
  </div>

  <div class="panel">
    <h2>材料商城状态</h2>
    <p class="hint">入口：右下角悬浮面板 -> 商城 -> 材料。当前金币 ${escHtml(materialShopStatus.goldCount)}，当前可买金币总价 ${escHtml(materialShopStatus.totalGoldCost)}；${escHtml(materialShopStatus.reasonText)}。自动刷新：${materialShopRefreshOptions.enabled ? `已开启（${escHtml(materialShopRefreshOptions.windowStart)}-${escHtml(materialShopRefreshOptions.windowEnd)}，单次价格 ≤ ${escHtml(materialShopRefreshOptions.maxCostYuanbao)} 元宝）` : "未开启"}；剩余基础免费次数 ${escHtml(materialShopStatus.refresh.remainingFreeRefreshTimes)}，下一次价格 ${escHtml(materialShopStatus.refresh.nextRefreshCostYuanbao)} 元宝，本轮已刷新 ${escHtml(context.summary?.materialShopRefreshCount ?? 0)} 次、已消费 ${escHtml(context.summary?.materialShopSpentYuanbao ?? 0)} 元宝，停止原因 ${escHtml(context.summary?.materialShopRefreshStopReason ?? "-")}。自动刷新倒计时：${escHtml(materialShopStatus.refresh.remainingText)}。</p>
    <div class="section">
    <table>
      <thead><tr><th>序号</th><th>shopId</th><th>材料</th><th>itemId</th><th>数量</th><th>单价</th><th>限购</th><th>已购</th><th>剩余</th><th>状态</th><th>说明</th></tr></thead>
      <tbody>${materialShopRows || '<tr><td colspan="11">暂无材料商城状态</td></tr>'}</tbody>
    </table>
    </div>
  </div>

  <div class="panel">
    <h2>丝绸/建材订单状态</h2>
    <p class="hint">只在非视频/广告订单、材料足够且冷却结束时自动提交；已完成订单数优先取发布板 cntMap，缺失时才取经营状况面板，订单finishCnt仅作原始参考。自动提交会预测本轮提交后的居民订单板总数，避免把总数推进 50/100。${escHtml(residentBoardSummary)}。</p>
    <div class="section">
    <table>
      <thead><tr><th>订单</th><th>状态</th><th>已完成订单数</th><th>采用来源</th><th>弹窗完成数</th><th>经营状况完成数</th><th>订单finishCnt</th><th>自动提交</th><th>视频/广告</th><th>剩余时间</th><th>冷却时间</th><th>需求</th></tr></thead>
      <tbody>${orderRows || '<tr><td colspan="12">暂无数据</td></tr>'}</tbody>
    </table>
    </div>
  </div>

  <div class="panel">
    <h2>宫廷订单状态</h2>
    <p class="hint">只在双倍金币剩余时间大于等于 1 分钟，并且所需花朵库存足够时自动提交。</p>
    <div class="section">
    <table>
      <thead><tr><th>状态</th><th>自动处理</th><th>花朵</th><th>flowerId</th><th>库存</th><th>需求</th><th>缺少</th><th>双倍金币剩余</th><th>生成时间</th></tr></thead>
      <tbody>${palaceRows || '<tr><td colspan="9">暂无宫廷订单</td></tr>'}</tbody>
    </table>
    </div>
  </div>

  <div class="panel">
    <h2>主线任务状态</h2>
    <p class="hint">当前主线任务进度达标且未领取时自动提交；接口：gs.taskMain.recv。${escHtml(mainTaskDetailText)}</p>
    <div class="section">
    <table>
      <thead><tr><th>任务ID</th><th>状态</th><th>自动处理</th><th>进度</th><th>当前值</th><th>目标值</th><th>任务说明</th><th>数据来源</th></tr></thead>
      <tbody>${mainTaskRows || '<tr><td colspan="8">暂无主线任务状态</td></tr>'}</tbody>
    </table>
    </div>
  </div>

  <div class="panel">
    <h2>花朵库存明细（已培育 ${cultivatedInventory.length} 种，未培育 ${uncultivatedInventory.length} 种）</h2>
    <div class="body">
    <p class="hint">显示仓库里已有的花、已获取但未培育的花，以及培育/土地记录中出现过的花；已培育表按花朵库存 > flowerId 排序，未培育表按已获得 > 花朵库存 > flowerId 排序。已培育按 cultivateMap 等级大于 1 判断，已获得按 cultivateMap 中存在培育等级判断。获取途径从 c_flower.seedId 对应的种子道具读取，培育所需材料从 c_flower.culCost 读取。收获间隔时间 = 等级基础时间 - 进阶技能“收获间隔时间减少”，不是土地倒计时。</p>
    <h3>已培育花库存</h3>
    <div class="section">
    <table>
      <thead><tr><th>花名</th><th>flowerId</th><th>库存</th><th>培育等级</th><th>获取途径</th><th>收获间隔时间</th><th>当前种植数</th><th>培育时间</th></tr></thead>
      <tbody>${cultivatedInventoryRows || '<tr><td colspan="8">暂无已培育花朵</td></tr>'}</tbody>
    </table>
    </div>
    <h3>未培育花库存</h3>
    <div class="section">
    <table>
      <thead><tr><th>花名</th><th>flowerId</th><th>库存</th><th>培育等级</th><th>获取途径</th><th>收获间隔时间</th><th>培育时间</th><th>培育所需材料</th><th>缺少的材料清单</th></tr></thead>
      <tbody>${uncultivatedInventoryRows || '<tr><td colspan="9">暂无未培育花朵</td></tr>'}</tbody>
    </table>
    </div>
    </div>
  </div>

  <div class="panel">
    <h2>土地种植明细（总 ${state.land.total}，成长中 ${state.land.growing.length}，可收获 ${state.land.mature.length}）</h2>
    <div class="body">
    <div class="section">
    <table>
      <thead><tr><th>土地ID</th><th>花名</th><th>flowerId</th><th>等级</th><th>状态</th><th>成熟时间</th><th>剩余时间</th><th>已收获次数</th></tr></thead>
      <tbody>${landRows || '<tr><td colspan="8">暂无数据</td></tr>'}</tbody>
    </table>
    </div>
    </div>
  </div>

  <div class="panel">
    <h2>花艺库存（${flowerArtInventory.length} 种，按售卖单价从高到低）</h2>
    <div class="body">
    <p class="hint">只显示当前背包中数量大于 0 的花艺；花艺名称在道具名与花瓶名相同时按“花瓶名：花朵组合”生成。</p>
    <div class="section">
    <table>
      <thead><tr><th>花艺名称</th><th>artId</th><th>花艺数量</th><th>售卖单价</th><th>所用花瓶</th><th>花朵及数量</th></tr></thead>
      <tbody>${flowerArtRows || '<tr><td colspan="6">暂无花艺库存</td></tr>'}</tbody>
    </table>
    </div>
    </div>
  </div>

  <div class="panel">
    <h2>顾客订单状态</h2>
    <p class="hint">${escHtml(CUSTOMER_ORDER_STATUS_RULE_TEXT)}。${escHtml(customerSummaryText)}</p>
    <div class="section">
    <table>
      <thead><tr><th>NPC</th><th>状态</th><th>自动处理</th><th>花坊币收益</th><th>历史最高（审计）</th><th>当前放行列表</th><th>收益决策</th><th>花艺</th><th>artId</th><th>成品库存</th><th>需要成品</th><th>缺少成品</th><th>花瓶</th><th>所需花库存</th><th>双倍金币剩余</th><th>生成时间</th></tr></thead>
      <tbody>${customerRows || '<tr><td colspan="16">暂无顾客订单</td></tr>'}</tbody>
    </table>
    </div>
  </div>

  <div class="panel">
    <h2>本次启动记录（顾客检查 ${(runHistory.customerOrderChecks || []).length}，顾客处理 ${runHistory.customerOrderSubmissions.length}）</h2>
    <div class="body">
    <p class="hint">脚本启动时间：${escHtml(runHistory.startedAtText)}；${escHtml(customerHistorySummaryText)}；检查记录用于说明每轮是否看到顾客订单，处理记录记录本次脚本进程启动后的自动制作、提交或官方拒绝动作；未在放行列表的已知收益订单标记为暂时没货并按官方按钮拒绝，不制作、不提交且不更新历史审计记录；收益未知、订单/配置数据不足或放行列表为空保持待处理并 fail-closed；只有最终完成才更新历史审计记录。</p>
    <h2>顾客订单检查记录</h2>
    <div class="section">
    <table>
      <thead><tr><th>检查时间</th><th>轮次</th><th>步骤</th><th>订单数</th><th>待执行动作</th><th>结果</th><th>双倍金币可用</th><th>双倍金币剩余</th><th>订单摘要</th></tr></thead>
      <tbody>${customerCheckRows || '<tr><td colspan="9">本次启动后暂无顾客订单检查记录</td></tr>'}</tbody>
    </table>
    </div>
    <h2 style="margin-top: 14px;">顾客订单处理记录</h2>
    <div class="section">
    <table>
      <thead><tr><th>处理时间</th><th>轮次</th><th>NPC</th><th>花艺</th><th>成品库存/需求</th><th>所需花库存</th><th>处理结果</th><th>原因</th></tr></thead>
      <tbody>${customerHistoryRows || '<tr><td colspan="8">本次启动后暂无顾客订单处理</td></tr>'}</tbody>
    </table>
    </div>
    </div>
  </div>

${countdownScript}
</body>
</html>`;

  const cultivatedInvMd = cultivatedInventory.map((item) => `| ${mdCell(item.flowerName)} | ${item.flowerId} | ${item.count} | ${mdCell(item.lvl)} | ${mdCell(item.acquisitionText)} | ${mdCell(item.maturityText)} | ${item.plantedCount} | ${mdCell(item.cTimeText)} |`).join("\n");
  const uncultivatedInvMd = uncultivatedInventory.map((item) => `| ${mdCell(item.flowerName)} | ${item.flowerId} | ${item.count} | ${mdCell(item.lvl)} | ${mdCell(item.acquisitionText)} | ${mdCell(item.maturityText)} | ${mdCell(item.cTimeText)} | ${mdCell(item.cultivationCostText)} | ${mdCell(item.missingCultivationCostText)} |`).join("\n");
  const flowerArtMd = flowerArtInventory.map((item) => `| ${mdCell(item.artName)} | ${item.artId} | ${item.artCount} | ${mdCell(item.salePriceText)} | ${mdCell(item.vaseText)} | ${mdCell(item.flowersText)} |`).join("\n");
  const orderMd = [orderStatus.satin, orderStatus.decorate].map((order) => `| ${mdCell(order.kindText)} | ${mdCell(order.statusText)} | ${mdCell(formatCompletedCount(order))} | ${mdCell(order.completedCountSourceText || "-")} | ${mdCell(formatNullableCount(order.homePopupCompletedCount))} | ${mdCell(formatNullableCount(order.businessStatsCompletedCount))} | ${mdCell(formatNullableCount(order.finishCnt))} | ${mdCell(orderAutoSubmitText(order))} | ${order.isVideo ? "是" : "否"} | ${mdCell(order.remainingText)} | ${mdCell(order.cdTimeText)} | ${mdCell(formatOrderRequirements(order.requirements))} |`).join("\n");
  const customerMd = (customerStatus.orders || []).map((order) => `| ${mdCell(order.npcId ?? "-")} | ${mdCell(order.statusText)} | ${mdCell(order.actionText)} | ${mdCell(order.flowerCurrencyReward ?? "-")} | ${mdCell(customerStatus.flowerCurrencySelection.historicalMaxReward ?? "-")} | ${mdCell(customerStatus.flowerCurrencySelection.releaseRewards?.join("、") || "未选择")} | ${mdCell(order.flowerCurrencyDecisionText ?? order.flowerCurrencyDecision ?? "-")} | ${mdCell(order.artLabel)} | ${mdCell(order.artId ?? "-")} | ${mdCell(order.haveArt ?? "-")} | ${mdCell(order.needArt ?? "-")} | ${mdCell(order.missingArt ?? "-")} | ${mdCell(order.vaseId ?? "-")} | ${mdCell(formatCustomerRequirements(order.flowerRequirements))} | ${mdCell(customerStatus.doubleGoldGate?.remainingText ?? "-")} | ${mdCell(order.cTimeText)} |`).join("\n");
  const pearlMd = (pearlStatus.placeRows || []).map((row) => `| ${mdCell(row.placeId)} | ${mdCell(row.stateText)} | ${mdCell(row.laborDisplayText ?? row.laborUid ?? "-")} | ${mdCell(row.canRecvNum ?? 0)} | ${mdCell(row.totalRecvNum ?? "-")} | ${mdCell(row.remainingText ?? "-")} | ${mdCell(row.restRemainingText ?? "-")} | ${mdCell(row.laborEndTimeText ?? "-")} |`).join("\n");
  const materialShopMd = (materialShopStatus.rows || []).map((row) => `| ${mdCell(row.index)} | ${mdCell(row.shopId)} | ${mdCell(row.itemName)} | ${mdCell(row.itemId ?? "-")} | ${mdCell(row.itemNum ?? "-")} | ${mdCell(row.priceText)} | ${mdCell(row.limitNum)} | ${mdCell(row.boughtCount)} | ${mdCell(row.remainingCount)} | ${mdCell(row.statusText)} | ${mdCell(row.reasonText)} |`).join("\n");
  const flowerRackMd = (flowerRackStatus.rows || []).map((row) => {
    const artText = row.artId
      ? row.artId === flowerRackStatus.targetArt.artId
        ? `${flowerRackStatus.targetArt.name} (${row.artId})`
        : String(row.artId)
      : "-";
    return `| ${mdCell(row.rackId)} | ${mdCell(row.statusText)} | ${mdCell(artText)} | ${mdCell(row.num || "-")} | ${mdCell(row.sellStartTimeText)} | ${mdCell(row.remainingText)} |`;
  }).join("\n");
  const fmlLandMd = (fmlLandStatus.rows || []).map((row) => `| ${mdCell(row.landId)} | ${mdCell(row.flowerId ? flowerName(row.flowerId, flowerNames) : "-")} | ${mdCell(row.flowerId || "-")} | ${mdCell(row.lvl ?? "-")} | ${mdCell(row.displayMatureFlwCnt ?? row.matureFlwCnt ?? 0)} | ${mdCell(row.stock ?? "-")} | ${mdCell(row.statusText)} | ${mdCell(formatDateTime(row.startTime))} | ${mdCell(formatDateTime(row.matureAtMs))} | ${mdCell(formatDateTime(row.lastCalcTime))} | ${mdCell(row.matureSource ?? "-")} |`).join("\n");
  const automationMd = automationRows.map((row) => `| ${mdCell(row.area)} | ${row.pending} | ${mdCell(row.status)} | ${mdCell(row.rule)} |`).join("\n");
  const plantingBlockerMd = plantingBlockers.map((row) => `| ${mdCell(row.groupIndex ?? row.groupKey ?? "-")} | ${mdCell(row.reasonText)} | ${mdCell(row.emptyLandCount)} | ${mdCell(row.waterDropCount ?? "-")} | ${mdCell(row.flowerId ?? "-")} | ${mdCell(row.currentMatureSpanText ?? "-")} | ${mdCell(row.predictedMatureSpanText ?? "-")} |`).join("\n");
  const palaceMd = palaceStatus.exists
    ? `| ${mdCell(palaceStatus.statusText)} | ${mdCell(palaceStatus.actionText)} | ${mdCell(palaceStatus.flowerLabel)} | ${mdCell(palaceStatus.flowerId ?? "-")} | ${mdCell(palaceStatus.have ?? "-")} | ${mdCell(palaceStatus.need ?? "-")} | ${mdCell(palaceStatus.missing ?? "-")} | ${mdCell(palaceStatus.doubleGoldGate?.remainingText ?? "-")} | ${mdCell(palaceStatus.cTimeText)} |`
    : "";
  const mainTaskMd = `| ${mdCell(mainTaskStatus.taskId ?? "-")} | ${mdCell(mainTaskStatus.statusText)} | ${mdCell(mainTaskStatus.actionText)} | ${mdCell(mainTaskStatus.progressText)} | ${mdCell(mainTaskStatus.curValue ?? "-")} | ${mdCell(mainTaskStatus.targetValue ?? "-")} | ${mdCell(mainTaskStatus.desc || mainTaskStatus.rawFieldText || "-")} | ${mdCell(mainTaskStatus.sourcePath || "-")} |`;
  const customerCheckMd = (runHistory.customerOrderChecks || []).map((entry, idx) => `| ${entry.index ?? idx + 1} | ${mdCell(entry.timeText ?? entry.checkedAtText)} | ${mdCell(entry.cycle ?? "-")} | ${mdCell(entry.customerStep ?? "-")} | ${mdCell(entry.total ?? 0)} | ${mdCell(entry.actionCount ?? 0)} | ${mdCell(entry.resultText ?? "-")} | ${entry.doubleGoldReady ? "是" : "否"} | ${mdCell(entry.doubleGoldRemainingText ?? "-")} | ${mdCell(formatCustomerCheckOrders(entry.orders))} |`).join("\n");
  const customerHistoryMd = runHistory.customerOrderSubmissions.map((entry, idx) => `| ${entry.index ?? idx + 1} | ${mdCell(entry.timeText ?? entry.submittedAtText)} | ${mdCell(entry.cycle ?? "-")} | ${mdCell(entry.npcId ?? "-")} | ${mdCell(entry.artLabel)} | ${mdCell(entry.outcomeText ?? "-")} | ${mdCell(entry.reason)} | ${mdCell(formatHistoryCustomerRequirement(entry.flowerRequirements))} |`).join("\n");
  const landMd = state.land.rows.map((row) => `| ${row.landId} | ${mdCell(row.flowerId ? flowerName(row.flowerId, flowerNames) : "-")} | ${row.flowerId || "-"} | ${row.lvl ?? "-"} | ${landStatusText(row)} | ${mdCell(formatDateTime(row.nextTime))} | ${fmtDuration(remainingMs(row))} | ${row.harvestCnt ?? "-"} |`).join("\n");
  const md = `# 花园自动化状态

更新时间：${formatDateTime(now)}

当前轮次：${context.cycle ?? "-"}

最近步骤：${context.step ?? "-"}
${runtimeErrorMd}
${cycleErrorsMd}

## 汇总

| 总土地 | 空地 | 成长中 | 可收获 | 下一块成熟 | 推荐种植 | 水滴 | 珍珠 | 花坊币 | 丝绸/绸缎 | 建材 | 元宝 | 金币 | 双倍金币 | 双倍金币结束时间 |
| --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| ${state.land.total} | ${state.land.empty.length} | ${state.land.growing.length} | ${state.land.mature.length} | ${mdCell(nextMatureText)} | ${mdCell(recommendedFlowerLabel)} | ${mdCell(waterDrop.displayText)} | ${mdCell(resourceItems.pearl.displayText)} | ${mdCell(resourceItems.flowerShopCoin.displayText)} | ${mdCell(resourceItems.satinSilk.displayText)} | ${mdCell(resourceItems.buildingMaterial.displayText)} | ${mdCell(resourceItems.yuanbao.displayText)} | ${mdCell(resourceItems.gold.displayText)} | ${mdCell(doubleGold.remainingText)} | ${mdCell(doubleGold.eTimeText)} |

水滴计算：${waterDrop.formulaText}；恢复间隔：${waterDrop.restoreIntervalText}；下一滴：${waterDrop.nextRestoreText}。

${waterDropFlowLabel}：${waterDropFlow.flowText}。

## 自动化队列

| 模块 | 待执行动作 | 当前状态 | 规则 |
| --- | ---: | --- | --- |
${automationMd}

## 补种阻断诊断
${plantingRule.ruleText}

| 组 | 原因 | 空地 | 水滴 | 目标花 | 当前成熟跨度 | 预测成熟跨度 |
| --- | --- | ---: | ---: | ---: | --- | --- |
${plantingBlockerMd || "| - | 暂无同熟窗口阻断 | - | - | - | - | - |"}

## 公会土地状态

明细每 ${htmlRefreshSeconds} 秒随状态页刷新；自动收获每 ${Math.floor(fmlLandScanIntervalMs / 1000)} 秒主动扫描一次，若刷新状态已可收获则立即复核并收获。成熟判断按 c_fmlLandLvl[lvl].time/stock 和 lastCalcTime/startTime，不按花朵自身成熟时间。

| 土地ID | 花名 | flowerId | 等级 | 成熟数量 | stock | 状态 | 开始时间 | 预计成熟 | lastCalcTime | 判定来源 |
| ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
${fmlLandMd || "| - | 暂无公会土地状态 | - | - | - | - | - | - | - | - | - |"}

## 花架金币状态

${flowerRackRuleText}；若库存不足但材料可补齐，会先制作再上架。

| 花架 | 状态 | 花艺 | 数量 | 上架时间 | 剩余时间 |
| ---: | --- | --- | ---: | --- | --- |
${flowerRackMd || "| - | 暂无花架状态 | - | - | - | - |"}

## 珍珠采集状态

只使用世界推荐；空闲坑位且雇佣卡大于 ${mdCell(pearlHireItemReserveCount)} 张时自动雇佣，始终保留 ${mdCell(pearlHireItemReserveCount)} 张；已产出的珍珠会一键收取。雇佣卡剩余：${mdCell(pearlStatus.hireItemCount ?? "-")}（itemId ${mdCell(pearlStatus.hireItemId ?? "-")}）。

| 坑位 | 状态 | 雇佣玩家 | 可收珍珠 | 本轮总产量 | 采集剩余 | 休息剩余 | 采集结束 |
| ---: | --- | ---: | ---: | ---: | --- | --- | --- |
${pearlMd || "| - | 暂无珍珠状态 | - | - | - | - | - | - |"}

## 材料商城状态

入口：右下角悬浮面板 -> 商城 -> 材料。当前金币 ${materialShopStatus.goldCount}，当前可买金币总价 ${materialShopStatus.totalGoldCost}；${materialShopStatus.reasonText}。自动刷新：${materialShopRefreshOptions.enabled ? `已开启（${materialShopRefreshOptions.windowStart}-${materialShopRefreshOptions.windowEnd}，单次价格 ≤ ${materialShopRefreshOptions.maxCostYuanbao} 元宝）` : "未开启"}；剩余基础免费次数 ${materialShopStatus.refresh.remainingFreeRefreshTimes}，下一次价格 ${materialShopStatus.refresh.nextRefreshCostYuanbao} 元宝，本轮已刷新 ${context.summary?.materialShopRefreshCount ?? 0} 次、已消费 ${context.summary?.materialShopSpentYuanbao ?? 0} 元宝，停止原因 ${context.summary?.materialShopRefreshStopReason ?? "-"}。自动刷新倒计时：${materialShopStatus.refresh.remainingText}。

| 序号 | shopId | 材料 | itemId | 数量 | 单价 | 限购 | 已购 | 剩余 | 状态 | 说明 |
| ---: | ---: | --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |
${materialShopMd || "| - | - | 暂无材料商城状态 | - | - | - | - | - | - | - | - |"}

## 丝绸/建材订单状态

只在非视频/广告订单、材料足够且冷却结束时自动提交；已完成订单数优先取发布板 cntMap，缺失时才取经营状况面板，订单finishCnt仅作原始参考。自动提交会预测本轮提交后的居民订单板总数，避免把总数推进 50/100。${residentBoardSummary}。

| 订单 | 状态 | 已完成订单数 | 采用来源 | 弹窗完成数 | 经营状况完成数 | 订单finishCnt | 自动提交 | 视频/广告 | 剩余时间 | 冷却时间 | 需求 |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |
${orderMd || "| - | - | - | - | - | - | - | - | - | - | - | - |"}

## 宫廷订单状态

只在双倍金币剩余时间大于等于 1 分钟，并且所需花朵库存足够时自动提交。

| 状态 | 自动处理 | 花朵 | flowerId | 库存 | 需求 | 缺少 | 双倍金币剩余 | 生成时间 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
${palaceMd || "| 暂无宫廷订单 | - | - | - | - | - | - | - | - |"}

## 主线任务状态

当前主线任务进度达标且未领取时自动提交；接口：gs.taskMain.recv。

${mainTaskDetailText}

| 任务ID | 状态 | 自动处理 | 进度 | 当前值 | 目标值 | 任务说明 | 数据来源 |
| ---: | --- | --- | --- | ---: | ---: | --- | --- |
${mainTaskMd}

## 顾客订单状态

${CUSTOMER_ORDER_STATUS_RULE_TEXT}。${customerSummaryText}

| NPC | 状态 | 自动处理 | 花坊币收益 | 历史最高（审计） | 当前放行列表 | 收益决策 | 花艺 | artId | 成品库存 | 需要成品 | 缺少成品 | 花瓶 | 所需花库存 | 双倍金币剩余 | 生成时间 |
| ---: | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
${customerMd || "| - | 暂无顾客订单 | - | - | - | - | - | - | - | - | - | - | - | - | - | - |"}

## 本次启动记录

脚本启动时间：${mdCell(runHistory.startedAtText)}；${mdCell(customerHistorySummaryText)}；检查记录用于说明每轮是否看到顾客订单，处理记录记录本次脚本进程启动后的自动制作、提交或官方拒绝动作；未在放行列表的已知收益订单标记为暂时没货并按官方按钮拒绝，不制作、不提交且不更新历史审计记录；收益未知、订单/配置数据不足或放行列表为空保持待处理并 fail-closed；只有最终完成才更新历史审计记录。

### 顾客订单检查记录

| 序号 | 时间 | 轮次 | 步骤 | 订单数 | 待执行动作 | 结果 | 双倍金币可用 | 双倍金币剩余 | 订单摘要 |
| ---: | --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
${customerCheckMd || "| - | 本次启动后暂无顾客订单检查记录 | - | - | - | - | - | - | - | - |"}

### 顾客订单处理记录

| 序号 | 时间 | 轮次 | NPC | 花艺 | 处理结果 | 原因 | 所需花 |
| ---: | --- | ---: | ---: | --- | --- | --- | --- |
${customerHistoryMd || "| - | 本次启动后暂无顾客订单处理 | - | - | - | - | - | - |"}

## 花艺库存


只显示当前背包中数量大于 0 的花艺；花艺名称在道具名与花瓶名相同时按“花瓶名：花朵组合”生成。

| 花艺名称 | artId | 花艺数量 | 售卖单价 | 所用花瓶 | 花朵及数量 |
| --- | ---: | ---: | --- | --- | --- |
${flowerArtMd || "| - | - | - | - | - | 暂无花艺库存 |"}


## 已培育花库存


显示仓库里已有的花、已获取但未培育的花，以及培育/土地记录中出现过的花；已培育和未培育分表显示。已培育表按花朵库存 > flowerId 排序，未培育表按已获得 > 花朵库存 > flowerId 排序。已培育按 cultivateMap 等级大于 1 判断，已获得按 cultivateMap 中存在培育等级判断。获取途径从 c_flower.seedId 对应的种子道具读取，培育所需材料从 c_flower.culCost 读取。收获间隔时间 = 等级基础时间 - 进阶技能“收获间隔时间减少”，不是土地倒计时。

| 花名 | flowerId | 库存 | 培育等级 | 获取途径 | 收获间隔时间 | 当前种植数 | 培育时间 |
| --- | --- | ---: | --- | --- | --- | ---: | --- |
${cultivatedInvMd || "| - | - | - | - | 暂无已培育花朵 | - | - | - |"}


## 未培育花库存


| 花名 | flowerId | 库存 | 培育等级 | 获取途径 | 收获间隔时间 | 培育时间 | 培育所需材料 | 缺少的材料清单 |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- |
${uncultivatedInvMd || "| - | - | - | - | 暂无未培育花朵 | - | - | - | - |"}


## 土地种植状态


| 土地ID | 花名 | flowerId | 等级 | 状态 | 成熟时间 | 剩余时间 | 已收获次数 |
| --- | --- | --- | ---: | --- | --- | --- | ---: |
${landMd || "| - | - | - | - | - | - | - | - |"}

`;

  const statusJson = {
    updatedAt: formatDateTime(now),
    ...(automationRunId ? { automationRunId } : {}),
    statusMode,
    moduleHealth,
    accountScheduler,
    customerOrderScheduler,
    customerOrderQueue,
    timeAuthority,
    cycle: context.cycle ?? null,
    step: context.step ?? null,
    selectionRule: PLANT_SELECTION_RULE_TEXT,
    plantingRule,
    plantingBlockers,
    waterDecision,
    waterRefillBlockedReason,
    waterRefillBlockedReasonText,
    lastActionWaterDropFlow,
    inventoryScope: "owned/acquired flower inventory plus cultivated and planted flowers",
    inventorySource: "$usrTot.data.bag merged with $usrTot.itemAddChg.itemMap, cultivateTot.cultivateMap, current land flower ids, and c_flower.seedId -> c_item acquisition text",
    resources: {
      waterDropItemId: 7,
      waterDropCount,
      waterDrop,
      waterDropFlow,
      lastActionWaterDropFlow,
      items: resourceItems,
      pearlCount: resourceItems.pearl.count,
      flowerShopCoinCount: resourceItems.flowerShopCoin.count,
      satinSilkCount: resourceItems.satinSilk.count,
      buildingMaterialCount: resourceItems.buildingMaterial.count,
      yuanbaoCount: resourceItems.yuanbao.count,
      goldCount: resourceItems.gold.count,
      doubleGold,
    },
    accountLevel,
    experienceGuard,
    automationQueue: {
      nextMatureTime,
      nextMatureTimeText: formatDateTime(nextMatureTime),
      nextMatureInSeconds,
      nextMatureText,
      nextFmlLandScanAt: nextFmlLandScanText,
      rows: automationRows,
    },
    freeWater: {
      autoReceiveRule: "only when a plantable land group exists and pre-plant water drops are below the plant refill threshold, call gs.freeWater.recv inside a free water worker slot; do not use bucket, ad, share, or patch receive",
      pendingReceive: freeWaterStatus.canReceive,
      ...freeWaterStatus,
    },
    waterwheel: {
      autoReceiveRule: waterwheelAutoReceiveRule,
      ...waterwheelStatus,
      pendingWaterwheelActions: waterwheelActions,
      receivedCount: context.summary?.waterwheelReceivedCount ?? 0,
      normalReceivedCount: context.summary?.waterwheelNormalReceivedCount ?? 0,
      videoBaseReceivedCount: context.summary?.waterwheelVideoBaseReceivedCount ?? 0,
    },
    runHistory,
    flowerRack: {
      autoHandleRule: "only while double gold has more than one minute left; collect mature rack gold; shelf configured flower art in configured groups; make missing flower art first when stock plus craftable count reaches target",
      pendingFlowerRackActions: flowerRackActions,
      ...flowerRackStatus,
    },
    pearl: {
      autoHandleRule: `use world recommended users only; hire into idle pearl places only when hire item count is greater than ${pearlHireItemReserveCount}; keep ${pearlHireItemReserveCount} hire items reserved; never use friend/random sources`,
      pendingPearlActions: pearlActions,
      ...serializePearlStatus(pearlStatus),
    },
    materialShop: {
      autoHandleRule: "open the third shop under right-bottom floating panel -> shop -> material; list current shopCultivate.infoMap rows; buy all visible gold-priced materials only when current gold covers the full total; optional pre-midnight refresh is fail-closed and uses the configured inclusive per-refresh yuanbao cap (hard maximum 16)",
      pendingMaterialShopActions: materialShopActions,
      ...materialShopStatus,
      refreshAutomation: {
        ...materialShopRefreshOptions,
        refreshCount: context.summary?.materialShopRefreshCount ?? 0,
        freeRefreshCount: context.summary?.materialShopFreeRefreshCount ?? 0,
        paidRefreshCount: context.summary?.materialShopPaidRefreshCount ?? 0,
        spentYuanbao: context.summary?.materialShopSpentYuanbao ?? 0,
        failedCount: context.summary?.materialShopRefreshFailedCount ?? 0,
        stopReason: context.summary?.materialShopRefreshStopReason ?? null,
      },
    },
    fmlLand: {
      autoHandleRule: "refresh guild land status with status page; actively scan every 15 minutes; bypass the interval when cached status is harvestable; estimate maturity from c_fmlLandLvl[lvl].time/stock and lastCalcTime/startTime, not flower maturity",
      scanIntervalSeconds: Math.floor(fmlLandScanIntervalMs / 1000),
      lastScanAt: lastFmlLandScanAttemptAtMs ? formatDateTime(lastFmlLandScanAttemptAtMs) : "-",
      nextScanAt: nextFmlLandScanText,
      ...fmlLandStatus,
    },
    specialOrders: {
      autoSubmitRule: "satin/decorate completion count uses home-popup cntMap first and business-statistics fallback; submit only when canFinish=true, isVideo=false, and this cycle will not advance resident board total to 50/100",
      pendingAutoSubmitActions: orderActions,
      ...orderStatus,
    },
    ordinaryResidentOrders: {
      autoSubmitRule: ordinaryResidentAutoSubmitSetting.singleSampleValidationEnabled
        ? "explicit single-sample validation only: one auto-loop cycle, one ordinary step, other configured reward handlers disabled, special daily-limit automation gate bypassed"
        : "ordinary resident order auto-submit switch is independent of main-task type, progress, and receive status; submit only when ordinary order conditions and satin/decorate daily limits pass",
      autoSubmitEnabled: ordinaryResidentAutoSubmitSetting.ordinaryAutoSubmitEnabled,
      ordinaryAutoSubmitEnabled: ordinaryResidentAutoSubmitSetting.ordinaryAutoSubmitEnabled,
      levelUpAutoSubmitEnabled: ordinaryResidentAutoSubmitSetting.levelUpEnabled,
      autoSubmitSource: ordinaryResidentAutoSubmitSetting.source,
      singleSampleValidationEnabled:
        ordinaryResidentAutoSubmitSetting.singleSampleValidationEnabled === true,
      specialDailyLimitBypassed:
        ordinaryResidentAutoSubmitSetting.bypassSpecialOrderDailyLimit === true,
      pendingAutoSubmitActions: ordinaryResidentOrderActions,
      ordinaryResidentOrderGateReason,
      submittedCount: context.summary?.ordinaryResidentOrderSubmittedCount ?? 0,
      submittedActions: context.summary?.ordinaryResidentOrderSubmittedActions ?? [],
      failedActions: context.summary?.ordinaryResidentOrderFailedActions ?? [],
      mainTaskStatusAfter: mainTaskStatus,
      satinDailyLimitReached: orderStatus.satin?.dailyLimitReached ?? false,
      decorateDailyLimitReached: orderStatus.decorate?.dailyLimitReached ?? false,
      ...orderStatus.ordinary,
    },
    palaceOrders: {
      autoSubmitRule: "submit palace order only while double gold has at least one minute left and required flower stock is enough",
      pendingPalaceOrderActions: palaceOrderActions,
      ...palaceStatus,
    },
    mainTasks: {
      autoSubmitRule: "when taskTot.main current task progress is complete and not received, call gs.taskMain.recv; repeat within MAIN_TASK_MAX_SUBMIT_PER_CYCLE",
      detailText: mainTaskDetailText,
      pendingMainTaskActions: mainTaskActions,
      ...mainTaskStatus,
    },
    cyclicNote: {
      autoReceiveRule: cyclicNoteNaturalCompletion.enabled
        ? (cyclicNoteNaturalCompletion.onlyHighestRewardTask
          ? "Active phase only: receive all authoritative completed three-slot tasks first; when none is complete, prefer the highest 1107 reward supported unfinished task; never direct-finish, reroll, unlock, gift, box, or shop."
          : "Active phase only: receive all authoritative completed three-slot tasks first; when none is complete, process supported unfinished tasks in slot order without allowing a blocked candidate to starve the next task; never direct-finish, reroll, unlock, gift, box, or shop.")
        : "Automation disabled: display the current activity and three-slot task progress only; do not enter, advance, or receive tasks; forbids refresh, unlock, direct finish, gift, box, and shop actions.",
      naturalCompletion: cyclicNoteNaturalCompletion,
      naturalPlan: cyclicNoteNaturalPlan,
      pendingReceiveActions: cyclicNoteActions,
      actionCount: context.summary?.cyclicNoteActionCount ?? 0,
      receivedCount: context.summary?.cyclicNoteReceivedCount ?? 0,
      failedCount: context.summary?.cyclicNoteFailedCount ?? 0,
      actions: context.summary?.cyclicNoteActions ?? [],
      failedActions: context.summary?.cyclicNoteFailedActions ?? [],
      ...cyclicNoteStatus,
    },
    cyclicStory: {
      autoSubmitRule: cyclicStoryOnlyHighestExperienceSetting.enabled
        ? "Active phase only: lock the latest enter three orders; if any is cooling, wait for all three; then submit only the highest expectedExperience order; do not downgrade for shortage; maximum 1 per cycle; forbids reroll, paid cooldown removal, gift, progress reward, and shop actions."
        : "Active phase only: submit an expired order when configured flower inventory is enough; re-enter after every success; maximum 3 per cycle; forbids reroll, paid cooldown removal, gift, progress reward, and shop actions.",
      autoSubmitEnabled: cyclicStoryAutoSubmitSetting.enabled,
      autoSubmitSource: cyclicStoryAutoSubmitSetting.source,
      onlyHighestExperienceOrder: cyclicStoryOnlyHighestExperienceSetting.enabled,
      onlyHighestExperienceSource: cyclicStoryOnlyHighestExperienceSetting.source,
      pendingAutoSubmitActions: cyclicStoryActions,
      actionCount: context.summary?.cyclicStoryActionCount ?? 0,
      submittedCount: context.summary?.cyclicStorySubmittedCount ?? 0,
      failedCount: context.summary?.cyclicStoryFailedCount ?? 0,
      actions: context.summary?.cyclicStoryActions ?? [],
      failedActions: context.summary?.cyclicStoryFailedActions ?? [],
      ...cyclicStoryStatus,
    },
    customerOrders: {
      autoSubmitRule: CUSTOMER_ORDER_ACTION_RULE_TEXT,
      pendingCustomerOrderActions: decoratedCustomerOrderActions,
      customerOrderQueue,
      ...customerStatus,
    },
    flowerArtInventory: {
      sortRule: "owned flower art only; unit sell price descending, then artId ascending",
      sourcePath: "c_flowerArt + c_item + flower-names + $usrTot.data.bag",
      total: flowerArtInventory.length,
      rows: flowerArtInventory,
    },
    selectedPlantFlower: state.recommendation.plantFlower ? {
      ...state.recommendation.plantFlower,
      flowerName: flowerName(state.recommendation.plantFlower.flowerId, flowerNames),
      flowerLabel: formatFlowerLabel(state.recommendation.plantFlower.flowerId, flowerNames),
      maturitySeconds: selectedPlantInventory?.maturitySeconds ?? null,
      maturityRawCd: selectedPlantInventory?.maturityRawCd ?? null,
      maturityText: formatMaturitySeconds(selectedPlantInventory?.maturitySeconds),
      baseMaturityText: formatMaturitySeconds(selectedPlantInventory?.maturityRawCd),
      advanceHarvestIntervalReductionSeconds: selectedPlantInventory?.advanceHarvestIntervalReductionSeconds ?? 0,
      advanceHarvestIntervalReductionText: formatPlainSeconds(selectedPlantInventory?.advanceHarvestIntervalReductionSeconds ?? 0),
      advanceEffects: selectedPlantInventory?.advanceEffects || {},
      advanceSlots: selectedPlantInventory?.advanceSlots || [],
      maturitySource: selectedPlantInventory?.maturitySource || "-",
      cTimeText: formatDateTime(state.recommendation.plantFlower.cTime),
    } : null,
    inventorySorted: decoratedInventory.map((item) => ({
      ...item,
      flowerLabel: formatFlowerLabel(item.flowerId, flowerNames),
    })),
    cultivatedInventorySorted: cultivatedInventory.map((item) => ({
      ...item,
      flowerLabel: formatFlowerLabel(item.flowerId, flowerNames),
    })),
    uncultivatedInventorySorted: uncultivatedInventory.map((item) => ({
      ...item,
      flowerLabel: formatFlowerLabel(item.flowerId, flowerNames),
    })),
    plantCandidatesSorted: state.candidates.map((item) => ({
      ...item,
      flowerName: flowerName(item.flowerId, flowerNames),
      flowerLabel: formatFlowerLabel(item.flowerId, flowerNames),
      cTimeText: formatDateTime(item.cTime),
    })),
    landRows: state.land.rows.map((row) => ({
      ...row,
      flowerName: row.flowerId ? flowerName(row.flowerId, flowerNames) : "-",
      statusText: landStatusText(row),
      nextTimeText: formatDateTime(row.nextTime),
      remainingText: fmtDuration(remainingMs(row)),
    })),
    summary: {
      loopError: context.summary?.loopError ?? null,
      loopErrorAt: context.summary?.loopErrorAt ?? null,
      automationStopped,
      accountLevel,
      experienceGuard,
      timeAuthority,
      statusMode,
      moduleHealth,
      accountScheduler,
      customerOrderScheduler,
      customerOrderQueue,
      moduleHealthUnhealthyCount: moduleHealth.unhealthyCount ?? 0,
      cycleErrors,
      cycleErrorCount: cycleErrors.length,
      totalLand: state.land.total,
      emptyCount: state.land.empty.length,
      growingCount: state.land.growing.length,
      matureCount: state.land.mature.length,
      waterDropCount,
      waterDropText: waterDrop.displayText,
      pearlCount: resourceItems.pearl.count,
      pearlText: resourceItems.pearl.displayText,
      flowerShopCoinCount: resourceItems.flowerShopCoin.count,
      flowerShopCoinText: resourceItems.flowerShopCoin.displayText,
      satinSilkCount: resourceItems.satinSilk.count,
      satinSilkText: resourceItems.satinSilk.displayText,
      buildingMaterialCount: resourceItems.buildingMaterial.count,
      buildingMaterialText: resourceItems.buildingMaterial.displayText,
      yuanbaoCount: resourceItems.yuanbao.count,
      yuanbaoText: resourceItems.yuanbao.displayText,
      goldCount: resourceItems.gold.count,
      goldText: resourceItems.gold.displayText,
      waterDropFormulaText: waterDrop.formulaText,
      waterDropNextRestoreText: waterDrop.nextRestoreText,
      waterDropBeforeWaterText: waterDropFlow.beforeWaterText,
      waterDropRestoredBeforeWater: waterDropFlow.restoredBeforeWater,
      waterDropWateredCount: waterDropFlow.wateredCount,
      waterDropFlowText: waterDropFlow.flowText,
      lastActionWaterDropFlowText: lastActionWaterDropFlow?.flowText ?? null,
      waterDecisionReason: waterDecision.reason ?? null,
      waterDecisionCanReceiveWater: waterDecision.canReceiveWater,
      waterRefillBlockedReason,
      plantedCount: context.summary?.plantedCount ?? 0,
      plantingBlockerCount: plantingBlockers.length,
      wateredCount: context.summary?.wateredCount ?? 0,
      freeWaterActionCount: context.summary?.freeWaterActionCount ?? 0,
      freeWaterReceivedCount: context.summary?.freeWaterReceivedCount ?? 0,
      freeWaterThreshold: freeWaterStatus.threshold,
      freeWaterTodayReceivedCount: freeWaterStatus.receivedCountToday,
      freeWaterDailyMaxCount: freeWaterStatus.maxDailyCount,
      waterwheelActionCount: context.summary?.waterwheelActionCount ?? 0,
      waterwheelReceivedCount: context.summary?.waterwheelReceivedCount ?? 0,
      waterwheelNormalReceivedCount: context.summary?.waterwheelNormalReceivedCount ?? 0,
      waterwheelVideoBaseReceivedCount: context.summary?.waterwheelVideoBaseReceivedCount ?? 0,
      waterwheelThreshold: waterwheelStatus.threshold,
      waterwheelRemainingBucketCount: waterwheelStatus.remainingBucketCount,
      waterwheelMaxBucketCount: waterwheelStatus.maxBucketCount,
      waterwheelStoredBucketCount: waterwheelStatus.storedBucketCount,
      waterwheelStoredBucketMax: waterwheelStatus.storedBucketMax,
      waterwheelStoredBucketCapacity: waterwheelStatus.storedBucketCapacity,
      waterwheelClaimedBucketCount: waterwheelStatus.claimedBucketCount,
      waterwheelRemainingDailyBucketCount: waterwheelStatus.remainingDailyBucketCount,
      waterwheelNextBucketNo: waterwheelStatus.nextBucketNo,
      waterwheelNextBucketIsVideo: waterwheelStatus.nextBucketIsVideo,
      waterwheelNextBucketGenerationAt: waterwheelStatus.nextBucketGenerationAt,
      waterwheelNextBucketGenerationAtMs: waterwheelStatus.nextBucketGenerationAtMs,
      waterwheelNextBucketGenerationInSeconds: waterwheelStatus.nextBucketGenerationInSeconds,
      speedUpFree: context.summary?.speedUpFree ?? false,
      harvestedCount: context.summary?.harvestedCount ?? 0,
      postWaterSpeedUpFree: context.summary?.postWaterSpeedUpFree ?? false,
      postWaterHarvestedCount: context.summary?.postWaterHarvestedCount ?? 0,
      doubleGoldRemainingText: doubleGold.remainingText,
      doubleGoldEndTimeText: doubleGold.eTimeText,
      specialOrderSubmittedCount: context.summary?.specialOrderSubmittedCount ?? 0,
      ordinaryResidentOrderSubmittedCount: context.summary?.ordinaryResidentOrderSubmittedCount ?? 0,
      ordinaryResidentOrderCompletedCount: orderStatus.ordinary?.completedCount ?? null,
      ordinaryResidentOrderCompletedCountSourceText: orderStatus.ordinary?.completedCountSourceText ?? null,
      palaceOrderSubmittedCount: context.summary?.palaceOrderSubmittedCount ?? 0,
      mainTaskSubmittedCount: context.summary?.mainTaskSubmittedCount ?? 0,
      cyclicStoryActionCount: context.summary?.cyclicStoryActionCount ?? 0,
      cyclicStorySubmittedCount: context.summary?.cyclicStorySubmittedCount ?? 0,
      cyclicStoryFailedCount: context.summary?.cyclicStoryFailedCount ?? 0,
      cyclicNoteActionCount: context.summary?.cyclicNoteActionCount ?? 0,
      cyclicNoteReceivedCount: context.summary?.cyclicNoteReceivedCount ?? 0,
      cyclicNoteFailedCount: context.summary?.cyclicNoteFailedCount ?? 0,
      customerOrderActionCount: context.summary?.customerOrderActionCount ?? 0,
      flowerRackActionCount: context.summary?.flowerRackActionCount ?? 0,
      flowerRackGoldReceivedCount: context.summary?.flowerRackGoldReceivedCount ?? 0,
      flowerRackMakeActionCount: context.summary?.flowerRackMakeActionCount ?? 0,
      flowerRackMadeCount: context.summary?.flowerRackMadeCount ?? 0,
      flowerRackShelvedCount: context.summary?.flowerRackShelvedCount ?? 0,
      flowerRackFailedCount: context.summary?.flowerRackFailedCount ?? 0,
      pearlActionCount: context.summary?.pearlActionCount ?? 0,
      pearlReceivedCount: context.summary?.pearlReceivedCount ?? 0,
      pearlHireCount: context.summary?.pearlHireCount ?? 0,
      pearlDailyFreeCount: context.summary?.pearlDailyFreeCount ?? 0,
      materialShopActionCount: context.summary?.materialShopActionCount ?? 0,
      materialShopBoughtCount: context.summary?.materialShopBoughtCount ?? 0,
      materialShopSpentGold: context.summary?.materialShopSpentGold ?? 0,
      materialShopFailedCount: context.summary?.materialShopFailedCount ?? 0,
      materialShopRefreshCount: context.summary?.materialShopRefreshCount ?? 0,
      materialShopFreeRefreshCount: context.summary?.materialShopFreeRefreshCount ?? 0,
      materialShopPaidRefreshCount: context.summary?.materialShopPaidRefreshCount ?? 0,
      materialShopSpentYuanbao: context.summary?.materialShopSpentYuanbao ?? 0,
      materialShopRefreshFailedCount: context.summary?.materialShopRefreshFailedCount ?? 0,
      materialShopRefreshStopReason: context.summary?.materialShopRefreshStopReason ?? null,
      flowerArtInventoryCount: flowerArtInventory.length,
    },
  };

  const fingerprint = buildStatusArtifactFingerprint(statusJson);
  const writeResults = writeStatusArtifacts([
    { path: htmlPath, content: html, fingerprint },
    { path: mdPath, content: md, fingerprint },
    {
      path: jsonPath,
      content: `${JSON.stringify(statusJson, null, 2)}\n`,
      fingerprint,
    },
  ]);
  const artifactCompletion = summarizeArtifactSubmission("garden", writeResults, {
    requiredTargets: [jsonPath, htmlPath, mdPath],
  });
  lastGardenArtifactCompletion = artifactCompletion;
  if (artifactCompletion.complete) rememberStatusDocumentContext(jsonPath, statusJson);
  for (const result of writeResults) {
    if (!result.ok) {
      console.warn(JSON.stringify({
        step: "statusDocumentWriteError",
        path: result.path,
        attempts: result.attempts,
        errorCode: result.errorCode,
        message: result.errorMessage,
      }));
    }
  }
  if (context.log !== false) {
    console.log(JSON.stringify({ step: "statusDocumentUpdated", htmlPath, mdPath, jsonPath }));
  }
  return {
    chain: "garden",
    fingerprint,
    writeResults,
    artifactCompletion,
  };
}

async function runGardenCycle(ws, gsToken, syncValue, cycle, options = {}) {
  options = {
    ...options,
    signal: options.signal || options.teamOrderRuntime?.signal || null,
    specialOrderRefreshState: options.specialOrderRefreshState
      || createSpecialOrderRefreshState(),
  };
  const flowerNames = options.flowerNames || loadFlowerNameMap();
  await throwIfAutomationStopped(options);
  if (!isAccountCommandGateway(ws)) {
    ws = createAutomationAccountCommandGateway(ws, gsToken, syncValue, options);
  }
  ws.observeSync(syncValue, { ...options, cycle });
  const accountScheduler = options.accountScheduler || null;
  const customerOrderScheduler = options.customerOrderScheduler || createCustomerOrderScheduler({
    nowFn: options.schedulerNowFn || options.nowFn || Date.now,
    retryIntervalMs: getCustomerOrderGenerationDuringWaitRetryIntervalMs(),
    healthCheckIntervalMs: CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS,
  });
  options = { ...options, customerOrderScheduler };
  const initialCustomerOrderTime = getCustomerOrderTimeContext(syncValue, options);
  const initialNextGenTimeMs = getCustomerOrderNextGenTimeMs(syncValue);
  customerOrderScheduler.observeSync({
    nextGenTimeMs: Number.isFinite(initialNextGenTimeMs) ? initialNextGenTimeMs : null,
    nextGenTimeInvalid: Number.isNaN(initialNextGenTimeMs),
    nowMs: initialCustomerOrderTime.nowMs,
  });
  accountScheduler?.observeAuthoritativeSnapshot?.(syncValue);
  const cycleErrors = [];
  let cyclicNote = { syncValue, actionCount: 0, receivedCount: 0, failedCount: 0, actions: [], failedActions: [] };
  const moduleHealth = options.moduleHealth || activeAutomationModuleHealth;
  const recordCycleError = (step, err) => {
    if (isExperienceActionBlockedError(err)) {
      const entry = {
        step,
        category: "action-blocked",
        customerOrderFailureCategory: step === "customerOrderSubmitError"
          ? "experience-guard-blocked"
          : null,
        submitErrorCategory: step === "customerOrderSubmitError"
          ? "experience-guard-blocked"
          : null,
        skipped: true,
        reason: err.experienceGuard?.reason || err.reason,
        message: err.message,
        iface: err.iface || err.experienceGuard?.blockedIface || null,
        experienceEstimateSource: err.experienceGuard?.predictionSource ?? null,
        customerOrderNobleStateUnknown:
          err.experienceGuard?.predictionSource === "customer-order-noble-state-unknown",
        experienceGuard: err.experienceGuard || null,
      };
      cycleErrors.push(entry);
      moduleHealth?.failure?.(step, err, { cycle });
      console.log(JSON.stringify({
        step,
        cycle,
        category: entry.category,
        customerOrderFailureCategory: entry.customerOrderFailureCategory,
        submitErrorCategory: entry.submitErrorCategory,
        experienceEstimateSource: entry.experienceEstimateSource,
        reason: entry.reason,
        message: entry.message,
      }));
      return entry;
    }
    if (isSessionExpiredError(err) || isWsRequestTimeoutError(err) || isExperienceGuardError(err) || isUserStoppedError(err)) throw err;
    const entry = {
      step,
      message: err?.message || String(err),
      customerOrderFailureCategory: step === "customerOrderSubmitError"
        ? customerOrderActionFailureCategory(err, { type: "finishCustomerOrder" })
        : null,
      submitErrorCategory: step === "customerOrderSubmitError"
        ? customerOrderActionFailureCategory(err, { type: "finishCustomerOrder" })
        : null,
      iface: err?.iface || null,
      experienceEstimateSource: err?.experienceGuard?.predictionSource ?? null,
    };
    cycleErrors.push(entry);
    moduleHealth?.failure?.(step, err, { cycle });
    console.log(JSON.stringify({
      step,
        cycle,
        message: entry.message,
        customerOrderFailureCategory: entry.customerOrderFailureCategory,
        submitErrorCategory: entry.submitErrorCategory,
        experienceEstimateSource: entry.experienceEstimateSource,
    }));
    return entry;
  };
  const isCycleSyncValue = (value) => Boolean(
    value
    && typeof value === "object"
    && (
      Object.hasOwn(value, "$usrTot")
      || Object.hasOwn(value, "usrLandTot")
      || Object.hasOwn(value, "orderCustomerTot")
      || Object.hasOwn(value, "orderFlowerTot")
    )
  );
  const adoptCycleStepSync = (result) => {
    const candidate = result?.syncValue || (isCycleSyncValue(result) ? result : null);
    if (candidate) syncValue = candidate;
    return candidate;
  };
  let customerOrderDueEventInFlight = false;
  const processCustomerOrderDueEvent = async (trigger) => {
    if (
      customerOrderDueEventInFlight
      || !isCustomerOrderGenerationDuringWaitEnabled()
    ) return;
    const timeContext = getCustomerOrderTimeContext(syncValue, options);
    const currentNextGenTimeMs = getCustomerOrderNextGenTimeMs(syncValue);
    customerOrderScheduler.observeSync({
      nextGenTimeMs: Number.isFinite(currentNextGenTimeMs) ? currentNextGenTimeMs : null,
      nextGenTimeInvalid: Number.isNaN(currentNextGenTimeMs),
      nowMs: timeContext.nowMs,
    });
    const before = customerOrderScheduler.snapshot();
    if (before.nextGenTimeMs == null || before.awaitingNextGenTime) return;
    const dueInMs = customerOrderScheduler.dueInMs({
      actionTime: timeContext,
      nowMs: timeContext.nowMs,
      clockSource: timeContext.clockSource,
      timeTrusted: timeContext.timeTrusted,
      allowInitialGeneration: false,
    });
    if (dueInMs > 0 || dueInMs === Infinity) return;

    customerOrderDueEventInFlight = true;
    try {
      console.log(JSON.stringify({
        step: "customerOrderDueEvent",
        event: "customer-order-next-generation-due",
        trigger,
        dueInMs,
        nowMs: timeContext.nowMs,
        localNowMs: timeContext.localNowMs,
        timeTrusted: timeContext.timeTrusted,
        clockSource: timeContext.clockSource,
        timeAuthorityReason: timeContext.timeAuthorityReason,
        nextGenTimeMs: before.nextGenTimeMs,
        dueAtMs: before.dueAtMs,
        customerOrderScheduler: before,
      }));
      const processed = await autoSubmitCustomerOrders(
        ws,
        gsToken,
        syncValue,
        cycle,
        teamOrderRuntime,
        {
          ...options,
          flowerNames,
          customerOrderScheduler,
          recordCycleError,
        },
      );
      syncValue = processed?.syncValue || syncValue;
      console.log(JSON.stringify({
        step: "customerOrderDueEventHandled",
        event: "customer-order-next-generation-processed",
        trigger,
        actionCount: processed?.actionCount || 0,
        generationToFirstActionMs: customerOrderScheduler.snapshot().generationToFirstActionMs,
        generationToFirstActionRequestStartMs: customerOrderScheduler.snapshot().generationToFirstActionMs,
        latencyMetricBasis: customerOrderScheduler.snapshot().latencyMetricBasis,
        customerOrderScheduler: customerOrderScheduler.snapshot(),
      }));
    } finally {
      customerOrderDueEventInFlight = false;
    }
  };
  const runCycleStep = async (errorStep, fallback, fn, stepOptions = {}) => {
    const manageHealth = stepOptions.manageHealth !== false;
    if (manageHealth) moduleHealth?.begin?.(errorStep, { cycle });
    try {
      let result = await fn();
      adoptCycleStepSync(result);
      if (manageHealth) moduleHealth?.success?.(errorStep, { cycle });
      if (errorStep !== "customerOrderSubmitError") {
        const syncBeforeCustomerOrderEvent = syncValue;
        try {
          await processCustomerOrderDueEvent(errorStep);
        } catch (err) {
          recordCycleError("customerOrderSchedulerEventError", err);
        }
        if (syncValue !== syncBeforeCustomerOrderEvent) {
          result = result && typeof result === "object" && Object.hasOwn(result, "syncValue")
            ? { ...result, syncValue }
            : isCycleSyncValue(result)
              ? syncValue
              : result;
        }
      }
      return result;
    } catch (err) {
      recordCycleError(errorStep, err);
      return fallback;
    }
  };
  const runScheduledCycleStep = async (
    moduleName,
    intervalMs,
    errorStep,
    fallback,
    fn,
    stepOptions = {},
  ) => {
    if (!accountScheduler) return runCycleStep(errorStep, fallback, fn, stepOptions);
    const scheduled = await accountScheduler.runDue(moduleName, {
      intervalMs,
      task: () => runCycleStep(errorStep, fallback, fn, stepOptions),
    });
    if (scheduled.ran) return scheduled.value;
    return fallback;
  };
  const refreshCycleState = async (errorStep, currentSyncValue, fn) => runCycleStep(
    errorStep,
    currentSyncValue,
    fn,
  );
  const teamOrderRuntime = options.teamOrderRuntime
    || createTeamOrderSessionRuntime(syncValue, options);
  const singleSampleValidation =
    resolveOrdinaryResidentSingleSampleValidation();

  syncValue = await refreshCycleState(
    "cycleRefreshStartError",
    syncValue,
    () => refreshLand(ws, gsToken, syncValue, "cycleRefreshStart"),
  );
  syncValue = await runScheduledCycleStep(
    "onlineHeartbeat",
    getOnlineHeartTickIntervalMs(),
    "cycleHeartTickStartError",
    syncValue,
    () => refreshOnlineState(
      ws,
      gsToken,
      syncValue,
      "cycleHeartTickStart",
      accountScheduler ? { force: true } : {},
    ),
  );
  const startupTeamOrder = await handleTeamOrderCheckpoint(ws, gsToken, syncValue, {
    cycle,
    trigger: "startup",
    teamOrderRuntime,
    recordCycleError,
    teamOrderSettlementPollMs: options.teamOrderSettlementPollMs,
    signal: options.signal,
    stopPath: options.stopPath,
    waitFn: options.waitFn,
    delayNowFn: options.delayNowFn,
    flowerNames,
  });
  syncValue = startupTeamOrder.syncValue;
  ws.observeSync(syncValue, { cycle });

  let waterwheel = {
    actionCount: 0,
    receivedCount: 0,
    normalReceivedCount: 0,
    videoBaseReceivedCount: 0,
    actions: [],
  };
  let freeWater = { actionCount: 0, receivedCount: 0, actions: [] };

  let speed = { syncValue, speedUp: false };
  let harvested = { syncValue, harvestedCount: 0 };
  if (singleSampleValidation.enabled) {
    console.log(JSON.stringify({
      step: "ordinaryResidentSingleSampleGardenSkip",
      cycle,
      reason: "single-sample-isolation",
    }));
  } else {
    speed = await runCycleStep(
      "speedUpFreeError",
      speed,
      () => speedUpNearMature(ws, gsToken, syncValue, options),
    );
    syncValue = speed.syncValue;
    if (speed.speedUp) {
      syncValue = await refreshCycleState(
        "cycleRefreshAfterSpeedUpError",
        syncValue,
        () => refreshLand(ws, gsToken, syncValue, "cycleRefreshAfterSpeedUp"),
      );
    }

    harvested = await runCycleStep(
      "harvestMatureError",
      { syncValue, harvestedCount: 0 },
      () => harvestMatureLands(ws, gsToken, syncValue, options),
    );
    syncValue = harvested.syncValue;
    if (harvested.experienceBlocked && harvested.blockedError) {
      recordCycleError("harvestMatureError", harvested.blockedError);
    }
    if (harvested.harvestedCount) {
      syncValue = await refreshCycleState(
        "cycleRefreshAfterHarvestError",
        syncValue,
        () => refreshLand(ws, gsToken, syncValue, "cycleRefreshAfterHarvest"),
      );
    }
    const flowerUpgrade = await runScheduledCycleStep(
      "flowerUpgrade",
      ACCOUNT_MODULE_INTERVAL_MS.flowerUpgrade,
      "flowerUpgradeError",
      { syncValue, failedActions: [] },
      () => autoUpgradeFlowers(ws, gsToken, syncValue, { cycle, moduleHealth }),
      { manageHealth: false },
    );
    syncValue = flowerUpgrade.syncValue;
    for (const failure of flowerUpgrade.failedActions || []) {
      cycleErrors.push({ step: "flowerUpgradeError", message: failure.message });
    }
  }

  const orderActionTime = resolveResourceActionTime(syncValue, options);
  const customerOrderFlowerCurrencyHistory = options.customerOrderFlowerCurrencyHistory
    || loadCustomerOrderFlowerCurrencyHistoryContext(syncValue, options);
  const customerOrderFlowerCurrencyHistoryPath = options.customerOrderFlowerCurrencyHistoryPath
    || process.env.CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_PATH
    || customerOrderFlowerCurrencyHistory.historyPath;
  const orderActionOptions = {
    ...options,
    flowerNames,
    actionTime: orderActionTime,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory,
    customerOrderFlowerCurrencyHistoryPath,
    recordCycleError,
  };
  let specialOrders = { submittedCount: 0, submittedActions: [] };
  specialOrders = await runCycleStep("specialOrderSubmitError", specialOrders, async () => {
    specialOrders = await autoSubmitSpecialOrders(
      ws,
      gsToken,
      syncValue,
      cycle,
      teamOrderRuntime,
      recordCycleError,
      orderActionOptions,
    );
    syncValue = specialOrders.syncValue;
    return specialOrders;
  });

  let ordinaryResidentOrders = { submittedCount: 0, submittedActions: [], failedActions: [] };
  ordinaryResidentOrders = await runCycleStep("ordinaryResidentOrderSubmitError", ordinaryResidentOrders, async () => {
    ordinaryResidentOrders = await autoSubmitOrdinaryResidentOrders(
      ws,
      gsToken,
      syncValue,
      cycle,
      teamOrderRuntime,
      recordCycleError,
      orderActionOptions,
    );
    syncValue = ordinaryResidentOrders.syncValue;
    return ordinaryResidentOrders;
  });

  if (singleSampleValidation.enabled) {
    const summary = {
      cycleErrors,
      cycleErrorCount: cycleErrors.length,
      speedUpFree: false,
      harvestedCount: 0,
      plantedCount: 0,
      wateredCount: 0,
      specialOrderSubmittedCount: specialOrders.submittedCount || 0,
      ordinaryResidentOrderSubmittedCount:
        ordinaryResidentOrders.submittedCount || 0,
      ordinaryResidentOrderSubmittedActions:
        ordinaryResidentOrders.submittedActions || [],
      ordinaryResidentOrderFailedActions:
        ordinaryResidentOrders.failedActions || [],
      palaceOrderSubmittedCount: 0,
      customerOrderActionCount: 0,
      mainTaskSubmittedCount: 0,
    };
    console.log(JSON.stringify({
      step: "ordinaryResidentSingleSampleComplete",
      cycle,
      ordinaryResidentOrderSubmittedCount:
        summary.ordinaryResidentOrderSubmittedCount,
      harvestedCount: 0,
      plantedCount: 0,
      wateredCount: 0,
    }));
    console.log(JSON.stringify({
      step: "cycleSummary",
      cycle,
      ...summary,
    }));
    writeStatusDocuments(syncValue, {
      step: "ordinaryResidentSingleSampleComplete",
      cycle,
      summary,
      flowerNames,
      customerOrderFlowerCurrencyHistoryPath,
    });
    return syncValue;
  }

  let palaceOrders = { submittedCount: 0, submittedActions: [] };
  palaceOrders = await runCycleStep("palaceOrderSubmitError", palaceOrders, async () => {
    palaceOrders = await autoSubmitPalaceOrders(ws, gsToken, syncValue, cycle, orderActionOptions);
    syncValue = palaceOrders.syncValue;
    return palaceOrders;
  });

  let customerOrders = { actionCount: 0, actions: [] };
  customerOrders = await runCycleStep("customerOrderSubmitError", customerOrders, async () => {
    customerOrders = await autoSubmitCustomerOrders(
      ws,
      gsToken,
      syncValue,
      cycle,
      teamOrderRuntime,
      orderActionOptions,
    );
    syncValue = customerOrders.syncValue;
    return customerOrders;
  });

  let fmlLand = { syncValue, scanned: false, actionCount: 0, actions: [], harvestedCount: 0, failedCount: 0 };
  fmlLand = await runScheduledCycleStep(
    "fmlLand",
    ACCOUNT_MODULE_INTERVAL_MS.fmlLand,
    "fmlLandHandleError",
    fmlLand,
    async () => {
    fmlLand = await autoHarvestFmlLand(ws, gsToken, syncValue, cycle, options);
    syncValue = fmlLand.syncValue;
    return fmlLand;
    },
  );
  syncValue = fmlLand.syncValue || syncValue;

  let flowerRack = { syncValue, actionCount: 0, actions: [], receivedCount: 0, makeActionCount: 0, madeCount: 0, shelvedCount: 0, failedCount: 0 };
  flowerRack = await runScheduledCycleStep(
    "flowerRack",
    ACCOUNT_MODULE_INTERVAL_MS.flowerRack,
    "flowerRackHandleError",
    flowerRack,
    async () => {
    flowerRack = await autoHandleFlowerRack(ws, gsToken, syncValue, cycle);
    syncValue = flowerRack.syncValue;
    return flowerRack;
    },
  );
  syncValue = flowerRack.syncValue || syncValue;

  let pearl = { syncValue, actionCount: 0, actions: [], receivedCount: 0, hireCount: 0, dailyFreeCount: 0 };
  pearl = await runScheduledCycleStep(
    "pearl",
    ACCOUNT_MODULE_INTERVAL_MS.pearl,
    "pearlHandleError",
    pearl,
    async () => {
    pearl = await autoHandlePearl(ws, gsToken, syncValue, cycle, options);
    syncValue = pearl.syncValue;
    return pearl;
    },
  );
  syncValue = pearl.syncValue || syncValue;

  let materialShop = {
    actionCount: 0,
    actions: [],
    boughtCount: 0,
    spentGold: 0,
    failedCount: 0,
    refreshActions: [],
    refreshCount: 0,
    freeRefreshCount: 0,
    paidRefreshCount: 0,
    spentYuanbao: 0,
    refreshFailedCount: 0,
    refreshStopReason: null,
  };
  materialShop.syncValue = syncValue;
  materialShop = await runScheduledCycleStep(
    "materialShop",
    ACCOUNT_MODULE_INTERVAL_MS.materialShop,
    "materialShopHandleError",
    materialShop,
    async () => {
    materialShop = await autoHandleMaterialShop(ws, gsToken, syncValue, cycle, options);
    syncValue = materialShop.syncValue;
    return materialShop;
    },
  );
  syncValue = materialShop.syncValue || syncValue;

  waterwheel = await runCycleStep("waterwheelHandleError", waterwheel, async () => {
    waterwheel = await autoReceiveWaterwheelBuckets(ws, gsToken, syncValue, cycle, options);
    syncValue = waterwheel.syncValue;
    return waterwheel;
  });

  freeWater = await runCycleStep("freeWaterHandleError", freeWater, async () => {
    freeWater = await autoReceiveFreeWaterDrops(ws, gsToken, syncValue, cycle);
    syncValue = freeWater.syncValue;
    return freeWater;
  });

  let waterRefillBlockedReason = waterwheel.blockedReason || freeWater.blockedReason || null;
  let waterRefillBlockedReasonText = waterwheel.blockedReasonText || freeWater.blockedReasonText || null;
  const plantWaterRefillAfterRefill = getPlantWaterRefillContext(syncValue);
  let waterRefillBlockClearedForPlanting = false;
  if (waterRefillBlockedReason) {
    const seededBacklogAfterRefill = getState(syncValue).land.rows.filter((row) => row.state === 1).length;
    const waterDropAfterRefill = getWaterDropStatus(syncValue);
    const authoritativeWaterAfterRefill = getAuthoritativeWaterDropCount(plantWaterRefillAfterRefill);
    const canPlantGroupAfterRefill = isPlantWaterEnoughForRefill(plantWaterRefillAfterRefill);
    const seededGroupAfterRefill = getFirstSeededLandGroup(syncValue);
    const canWaterSeededAfterRefill = Boolean(
      seededGroupAfterRefill
      && seededGroupAfterRefill.requiredWaterCount > 0
      && authoritativeWaterAfterRefill != null
      && authoritativeWaterAfterRefill >= seededGroupAfterRefill.requiredWaterCount,
    );
    if (canPlantGroupAfterRefill || canWaterSeededAfterRefill) {
      console.log(JSON.stringify({
        step: "waterRefillBlockClearedForPlanting",
        cycle,
        originalReason: waterRefillBlockedReason,
        originalReasonText: waterRefillBlockedReasonText,
        clearReason: canPlantGroupAfterRefill ? "plant-water-enough" : "seeded-water-available",
        waterDropCount: waterDropAfterRefill.count,
        waterDropText: `${waterDropAfterRefill.count}/${waterDropAfterRefill.displayLimit}`,
        threshold: plantWaterRefillAfterRefill.threshold,
        requiredWaterCount: plantWaterRefillAfterRefill.requiredWaterCount || plantWaterRefillAfterRefill.threshold,
        groupKey: plantWaterRefillAfterRefill.groupKey ?? null,
        groupIndex: plantWaterRefillAfterRefill.groupIndex ?? null,
        groupStartId: plantWaterRefillAfterRefill.groupStartId ?? null,
        groupEndId: plantWaterRefillAfterRefill.groupEndId ?? null,
        actualGroupSize: plantWaterRefillAfterRefill.actualGroupSize ?? null,
        maxGroupSize: plantWaterRefillAfterRefill.maxGroupSize ?? PLANT_LAND_GROUP_SIZE,
        emptyLandIds: plantWaterRefillAfterRefill.emptyLandIds || [],
        emptyLandCount: plantWaterRefillAfterRefill.emptyLandCount,
        seededBacklogCount: seededBacklogAfterRefill,
        seededGroupKey: seededGroupAfterRefill?.groupKey ?? null,
        seededRequiredWaterCount: seededGroupAfterRefill?.requiredWaterCount ?? null,
        flowerId: plantWaterRefillAfterRefill.flowerId ?? null,
        flowerSource: plantWaterRefillAfterRefill.flowerSource ?? null,
      }));
      waterRefillBlockedReason = null;
      waterRefillBlockedReasonText = null;
      waterRefillBlockClearedForPlanting = true;
    }
  }
  let cycleWaterDecision = buildWaterDecision(
    waterRefillBlockClearedForPlanting
      ? plantWaterRefillAfterRefill
      : freeWater.waterDecision || waterwheel.waterDecision || plantWaterRefillAfterRefill,
    {
      blockedReason: waterRefillBlockedReason,
      blockedReasonText: waterRefillBlockedReasonText,
    },
  );
  const waterDropBeforeWater = decorateWaterDropStatus(getWaterDropStatus(syncValue));
  let postWaterSpeed = { syncValue, speedUp: false };
  let postWaterHarvested = { syncValue, harvestedCount: 0 };
  const runGrowthAfterWater = async (phase, startSync) => {
    let next = startSync;
    let speedResult = await runCycleStep(
      `${phase}SpeedUpFreeError`,
      { syncValue: next, speedUp: false },
      () => speedUpNearMature(ws, gsToken, next, options),
    );
    next = speedResult.syncValue;
    if (speedResult.speedUp) {
      next = await refreshCycleState(
        `${phase}RefreshAfterSpeedUpError`,
        next,
        () => refreshLand(ws, gsToken, next, `${phase}RefreshAfterSpeedUp`),
      );
    }

    let harvestResult = await runCycleStep(
      `${phase}HarvestMatureError`,
      { syncValue: next, harvestedCount: 0 },
      () => harvestMatureLands(ws, gsToken, next, options),
    );
    next = harvestResult.syncValue;
    if (harvestResult.harvestedCount) {
      next = await refreshCycleState(
        `${phase}RefreshAfterHarvestError`,
        next,
        () => refreshLand(ws, gsToken, next, `${phase}RefreshAfterHarvest`),
      );
    }
    return { syncValue: next, speedUp: speedResult.speedUp, harvestedCount: harvestResult.harvestedCount };
  };
  const mergePostWaterGrowth = (growth) => {
    postWaterSpeed = { syncValue: growth.syncValue, speedUp: postWaterSpeed.speedUp || growth.speedUp };
    postWaterHarvested = {
      syncValue: growth.syncValue,
      harvestedCount: postWaterHarvested.harvestedCount + (growth.harvestedCount || 0),
    };
    syncValue = growth.syncValue;
  };
  const waterSeededUntilBlocked = async (phase) => {
    let next = syncValue;
    let totalWateredCount = 0;
    let speedUp = false;
    let harvestedCount = 0;
    const maxPasses = Math.max(1, getState(next).land.total || 1);
    const attemptedGroupKeys = new Set();
    for (let pass = 1; pass <= maxPasses; pass++) {
      const passState = getState(next);
      const seeded = passState.land.rows.find((row) => {
        if (row.state !== 1) return false;
        const group = getSeededLandGroup(next, row.landId);
        return !attemptedGroupKeys.has(group.groupKey);
      });
      const passWaterDrop = getWaterDropStatus(next);
      if (!seeded) break;
      const seededGroup = getSeededLandGroup(next, seeded.landId);
      if (false && seededGroup.requiredWaterCount > 0 && passWaterDrop.count < seededGroup.requiredWaterCount) {
        console.log(JSON.stringify({
          step: "waterSeededGroupSkip",
          phase,
          reason: "waiting-water-for-seeded-land-group",
          reasonText: "水滴不足，等待足够浇完整组已种土地后再继续",
          landId: Number(seeded.landId),
          groupKey: seededGroup.groupKey,
          groupIndex: seededGroup.groupIndex,
          groupStartId: seededGroup.groupStartId,
          groupEndId: seededGroup.groupEndId,
          actualGroupSize: seededGroup.actualGroupSize,
          maxGroupSize: PLANT_LAND_GROUP_SIZE,
          seededLandIds: seededGroup.seededLandIds,
          seededLandCount: seededGroup.seededLandIds.length,
          requiredWaterCount: seededGroup.requiredWaterCount,
          waterDropCount: passWaterDrop.count,
        }));
        break;
      }
      attemptedGroupKeys.add(seededGroup.groupKey);
      const watered = await runCycleStep(
        `${phase}Error`,
        { syncValue: next, wateredCount: 0, stopped: true },
        () => waterSeededLandGroup(ws, gsToken, next, seededGroup, { phase }),
      );
      next = watered.syncValue;
      if (!watered.wateredCount) break;
      totalWateredCount += watered.wateredCount;
      next = await refreshCycleState(
        `${phase}RefreshError`,
        next,
        () => refreshLand(ws, gsToken, next, `${phase}Refresh`),
      );
      next = setWaterDropCount(next, watered.waterDropTargetCount, watered.waterDropConsumedAtMs);
      const growth = await runGrowthAfterWater(`${phase}PostWater`, next);
      next = growth.syncValue;
      speedUp = speedUp || growth.speedUp;
      harvestedCount += growth.harvestedCount || 0;
      if (watered.stopped) break;
    }
    return { syncValue: next, wateredCount: totalWateredCount, speedUp, harvestedCount };
  };

  let firstWatered = { syncValue, wateredCount: 0, speedUp: false, harvestedCount: 0 };
  if (waterRefillBlockedReason) {
    console.log(JSON.stringify({
      step: "waterInvariantStop",
      source: "planting",
      cycle,
      reason: waterRefillBlockedReason,
      reasonText: waterRefillBlockedReasonText,
      waterDropCount: getWaterDropStatus(syncValue).count,
    }));
  } else {
    firstWatered = await waterSeededUntilBlocked("waterSeededBeforePlant");
    syncValue = firstWatered.syncValue;
    mergePostWaterGrowth(firstWatered);
  }

  let state = getState(syncValue);
  let plantWaterDrop = getWaterDropStatus(syncValue);
  let seededBacklogCount = state.land.rows.filter((row) => row.state === 1).length;
  if (!waterRefillBlockedReason && !seededBacklogCount && state.recommendation.emptyLandIds.length) {
    const beforeInventoryRefreshForPlant = syncValue;
    syncValue = await refreshCycleState(
      "cycleInventoryRefreshBeforePlantError",
      syncValue,
      () => refreshInventoryBeforePlant(ws, gsToken, syncValue, "cycleInventoryRefreshBeforePlant"),
    );
    if ((waterwheel.receivedCount || 0) > 0 || (freeWater.receivedCount || 0) > 0) {
      const preserved = preserveWaterDropCountAfterRefillSync(beforeInventoryRefreshForPlant, syncValue);
      syncValue = preserved.syncValue;
      if (preserved.preserved) {
        console.log(JSON.stringify({
          step: "waterRefillWaterDropPreservedAfterLazySync",
          cycle,
          sources: [
            (waterwheel.receivedCount || 0) > 0 ? "waterwheel" : null,
            (freeWater.receivedCount || 0) > 0 ? "freeWater" : null,
          ].filter(Boolean),
          beforeWaterDropCount: preserved.beforeWaterDropCount,
          staleAfterWaterDropCount: preserved.afterWaterDropCount,
          preservedWaterDropCount: preserved.preservedWaterDropCount,
        }));
      }
    }
    const waterwheelPatch = applyLocalItemDeltaPatchesForUnchanged(syncValue, waterwheel.localItemDeltaPatches || []);
    syncValue = waterwheelPatch.syncValue;
    if (waterwheelPatch.appliedPatchCount > 0) {
      console.log(JSON.stringify({
        step: "waterwheelConservativeCreditPreservedAfterLazySync",
        cycle,
        appliedPatchCount: waterwheelPatch.appliedPatchCount,
        waterDropCount: getWaterDropStatus(syncValue).count,
      }));
    }
    state = getState(syncValue);
    plantWaterDrop = getWaterDropStatus(syncValue);
    let plantWaterRefillBeforePlant = getPlantWaterRefillContext(syncValue);
    if (plantWaterRefillBeforePlant.waterDropTrust !== "authoritative") {
      try {
        const refreshed = await refreshLandForPotentialWaterAuthority(
          ws,
          gsToken,
          syncValue,
          plantWaterRefillBeforePlant,
          "plantingAuthoritativeLandRefreshBeforeBlock",
        );
        syncValue = refreshed.syncValue;
        plantWaterRefillBeforePlant = refreshed.plantWaterRefill;
        state = getState(syncValue);
        plantWaterDrop = getWaterDropStatus(syncValue);
      } catch (err) {
        recordCycleError("plantingAuthoritativeLandRefreshBeforeBlockError", err);
      }
    }
    if (plantWaterRefillBeforePlant.waterDropTrust !== "authoritative") {
      waterRefillBlockedReason = "waiting-authoritative-water-drop-before-plant";
      waterRefillBlockedReasonText = "waiting authoritative water drop before planting";
      logWaterRefillSkip("planting", cycle, waterRefillBlockedReason, waterRefillBlockedReasonText, plantWaterRefillBeforePlant);
    }
    logPlantSelectionParsed(syncValue, {
      cycle,
      mode: "auto-loop",
      emptyLandCount: state.recommendation.emptyLandIds.length,
      flowerNames,
    });
  }
  seededBacklogCount = getState(syncValue).land.rows.filter((row) => row.state === 1).length;
  let planted = { syncValue, plantedCount: 0, flowerId: state.recommendation.plantFlower?.flowerId || null };
  let postPlantWatered = { syncValue, wateredCount: 0 };
  const blockedPlantGroups = [];
  const waterBlockedPlantGroups = [];
  if (waterRefillBlockedReason) {
    console.log(JSON.stringify({
      step: "plantEmptySkip",
      reason: waterRefillBlockedReason,
      reasonText: waterRefillBlockedReasonText,
      emptyLandCount: state.recommendation.emptyLandIds.length,
      waterDropCount: plantWaterDrop.count,
      seededBacklogCount,
    }));
  } else if (seededBacklogCount) {
    console.log(JSON.stringify({
      step: "plantEmptySkip",
      reason: "seeded-backlog-before-plant",
      emptyLandCount: state.recommendation.emptyLandIds.length,
      waterDropCount: plantWaterDrop.count,
      seededBacklogCount,
    }));
  } else {
    const plantGroupTargets = new Map();
    const plantGroupStartedAtMs = new Map();
    const maxPlantPasses = Math.max(1, getState(syncValue).land.total || 1);
    for (let pass = 1; pass <= maxPlantPasses; pass++) {
      state = getState(syncValue);
      plantWaterDrop = getWaterDropStatus(syncValue);
      if (plantWaterDrop.count <= 0) {
        if (!planted.plantedCount) {
          console.log(JSON.stringify({
            step: "plantEmptySkip",
            reason: "no-water-for-plant",
            emptyLandCount: state.recommendation.emptyLandIds.length,
            waterDropCount: plantWaterDrop.count,
            seededBacklogCount: 0,
          }));
        }
        break;
      }
      const forcedFlowerId = Number(process.env.FLOWER_ID) || 0;
      const fallbackFlowerId = forcedFlowerId || state.recommendation.plantFlower?.flowerId;
      const candidates = getPlantLandGroupCandidates(
        syncValue,
        fallbackFlowerId,
        plantGroupTargets,
        { forcedFlowerId },
      );
      let selectedGroup = null;
      const passBlockedGroups = [];
      const passWaterBlockedGroups = [];
      for (const candidate of candidates) {
        const actualGroupSize = candidate.actualGroupSize ?? candidate.groupLandIds.length;
        const groupStartedAtMs = plantGroupStartedAtMs.get(candidate.groupKey) || null;
        const existingFlowerIds = nonEmptyGroupFlowerIds(candidate.groupRows);
        if (!candidate.wholeGroupEmpty) {
          const blockedGroup = {
            groupKey: candidate.groupKey,
            groupIndex: candidate.groupIndex,
            groupStartId: candidate.groupStartId,
            groupEndId: candidate.groupEndId,
            actualGroupSize,
            maxGroupSize: PLANT_LAND_GROUP_SIZE,
            reason: "waiting-empty-for-land-group",
            source: candidate.source,
            flowerId: candidate.flowerId,
            existingFlowerIds,
            emptyLandIds: candidate.emptyLandIds,
            requiredWaterCount: candidate.requiredWaterCount,
            waterDropCount: plantWaterDrop.count,
          };
          passBlockedGroups.push(blockedGroup);
          console.log(JSON.stringify({
            step: "plantLandGroupSkip",
            landId: candidate.startLandId,
            flowerId: candidate.flowerId,
            reason: "waiting-empty-for-land-group",
            reasonText: plantingBlockerReasonText("waiting-empty-for-land-group"),
            source: candidate.source,
            actualGroupSize,
            maxGroupSize: PLANT_LAND_GROUP_SIZE,
            groupWindowSeconds: PLANT_LAND_GROUP_WINDOW_SECONDS,
            groupIndex: candidate.groupIndex,
            groupStartId: candidate.groupStartId,
            groupEndId: candidate.groupEndId,
            groupLandIds: candidate.groupLandIds,
            emptyLandIds: candidate.emptyLandIds,
            existingFlowerIds,
            requiredWaterCount: candidate.requiredWaterCount,
            waterDropCount: plantWaterDrop.count,
          }));
          continue;
        }

        const groupWindow = getPlantLandGroupWindowDecision(syncValue, candidate, groupStartedAtMs);
        const windowExistingFlowerIds = groupWindow.existingFlowerIds || existingFlowerIds;
        if (!groupWindow.ok) {
          const blockedGroup = {
            groupKey: candidate.groupKey,
            groupIndex: candidate.groupIndex,
            groupStartId: candidate.groupStartId,
            groupEndId: candidate.groupEndId,
            actualGroupSize,
            maxGroupSize: PLANT_LAND_GROUP_SIZE,
            reason: groupWindow.reason,
            source: candidate.source,
            flowerId: candidate.flowerId,
            existingFlowerIds: windowExistingFlowerIds,
            emptyLandIds: candidate.emptyLandIds,
            requiredWaterCount: candidate.requiredWaterCount,
            waterDropCount: plantWaterDrop.count,
            elapsedMs: groupWindow.elapsedMs ?? null,
            currentMatureSpanMs: groupWindow.spanMs ?? null,
            predictedMatureSpanMs: groupWindow.predictedSpanMs ?? null,
          };
          passBlockedGroups.push(blockedGroup);
          console.log(JSON.stringify({
            step: "plantLandGroupSkip",
            landId: candidate.startLandId,
            flowerId: candidate.flowerId,
            reason: groupWindow.reason,
            reasonText: plantingBlockerReasonText(groupWindow.reason),
            source: candidate.source,
            actualGroupSize,
            maxGroupSize: PLANT_LAND_GROUP_SIZE,
            groupWindowSeconds: PLANT_LAND_GROUP_WINDOW_SECONDS,
            groupIndex: candidate.groupIndex,
            groupStartId: candidate.groupStartId,
            groupEndId: candidate.groupEndId,
            groupLandIds: candidate.groupLandIds,
            emptyLandIds: candidate.emptyLandIds,
            existingFlowerIds: windowExistingFlowerIds,
            requiredWaterCount: candidate.requiredWaterCount,
            waterDropCount: plantWaterDrop.count,
            elapsedMs: groupWindow.elapsedMs ?? null,
            currentMatureSpanMs: groupWindow.spanMs ?? null,
            predictedMatureSpanMs: groupWindow.predictedSpanMs ?? null,
          }));
          continue;
        }
        if (plantWaterDrop.count < candidate.requiredWaterCount) {
          const waterBlockedGroup = {
            groupKey: candidate.groupKey,
            groupIndex: candidate.groupIndex,
            groupStartId: candidate.groupStartId,
            groupEndId: candidate.groupEndId,
            actualGroupSize,
            maxGroupSize: PLANT_LAND_GROUP_SIZE,
            reason: "waiting-water-for-land-group",
            source: candidate.source,
            flowerId: candidate.flowerId,
            existingFlowerIds: windowExistingFlowerIds,
            emptyLandIds: candidate.emptyLandIds,
            requiredWaterCount: candidate.requiredWaterCount,
            waterDropCount: plantWaterDrop.count,
          };
          passWaterBlockedGroups.push(waterBlockedGroup);
          continue;
        }
        selectedGroup = {
          ...candidate,
          groupWindow,
          groupStartedAtMs,
          existingFlowerIds: windowExistingFlowerIds,
        };
        break;
      }
      blockedPlantGroups.push(...passBlockedGroups);
      waterBlockedPlantGroups.push(...passWaterBlockedGroups);
      if (!selectedGroup) {
        if (!planted.plantedCount) {
          const emptyLandCount = state.recommendation.emptyLandIds.length;
          const passWaitingEmptyOnly = passBlockedGroups.length
            && passBlockedGroups.every((group) => group.reason === "waiting-empty-for-land-group")
            && !passWaterBlockedGroups.length;
          const reason = emptyLandCount && passWaterBlockedGroups.length && !passBlockedGroups.length
            ? "waiting-water-for-land-group"
            : emptyLandCount && passWaitingEmptyOnly
              ? "waiting-empty-for-land-group"
              : emptyLandCount && (passBlockedGroups.length || blockedPlantGroups.length)
                ? "no-eligible-empty-land"
                : emptyLandCount
                  ? "waiting-water-for-land-group"
                  : "no-empty-land";
          console.log(JSON.stringify({
            step: "plantEmptySkip",
            reason,
            reasonText: reason === "no-eligible-empty-land"
              ? "保留同组同熟窗口导致跳过补种"
              : plantingBlockerReasonText(reason),
            emptyLandCount,
            waterDropCount: plantWaterDrop.count,
            blockedGroupCount: blockedPlantGroups.length,
            waterBlockedGroupCount: waterBlockedPlantGroups.length,
            blockedGroups: blockedPlantGroups.map(decoratePlantingBlocker),
            waterBlockedGroups: waterBlockedPlantGroups.map(decoratePlantingBlocker),
          }));
          if (plantWaterDrop.count > 0 && emptyLandCount && reason !== "waiting-water-for-land-group") {
            console.log(JSON.stringify({
              step: "plantingBlockedWithEnoughWater",
              reason,
              reasonText: reason === "no-eligible-empty-land"
                ? "保留同组同熟窗口导致跳过补种"
                : plantingBlockerReasonText(reason),
              emptyLandCount,
              waterDropCount: plantWaterDrop.count,
              blockedGroupCount: blockedPlantGroups.length,
              waterBlockedGroupCount: waterBlockedPlantGroups.length,
              blockedGroups: blockedPlantGroups.map(decoratePlantingBlocker),
              waterBlockedGroups: waterBlockedPlantGroups.map(decoratePlantingBlocker),
            }));
          }
        }
        break;
      }

      console.log(JSON.stringify({
        step: "plantLandGroupSelect",
        landId: selectedGroup.startLandId,
        flowerId: selectedGroup.flowerId,
        source: selectedGroup.source,
        actualGroupSize: selectedGroup.groupLandIds.length,
        maxGroupSize: PLANT_LAND_GROUP_SIZE,
        emptyLandIds: selectedGroup.emptyLandIds,
        requiredWaterCount: selectedGroup.requiredWaterCount,
        waterDropCount: plantWaterDrop.count,
        groupWindowSeconds: PLANT_LAND_GROUP_WINDOW_SECONDS,
        groupWindowReason: selectedGroup.groupWindow.reason,
        currentMatureSpanMs: selectedGroup.groupWindow.spanMs ?? null,
        predictedMatureSpanMs: selectedGroup.groupWindow.predictedSpanMs ?? null,
        groupIndex: selectedGroup.groupIndex,
        groupStartId: selectedGroup.groupStartId,
        groupEndId: selectedGroup.groupEndId,
        groupLandIds: selectedGroup.groupLandIds,
        existingFlowerIds: selectedGroup.existingFlowerIds,
      }));
      if (!selectedGroup.groupStartedAtMs) plantGroupStartedAtMs.set(selectedGroup.groupKey, Date.now());

      let groupStopped = false;
      const plantedGroup = await runCycleStep(
        "plantLandGroupError",
        { syncValue, plantedCount: 0, flowerId: selectedGroup.flowerId, failed: true },
        () => plantEmptyLands(
          ws,
          gsToken,
          syncValue,
          {
            emptyLandIds: selectedGroup.emptyLandIds,
            plantFlower: { flowerId: selectedGroup.flowerId },
          },
        {
            maxPlantCount: selectedGroup.emptyLandIds.length,
            preferSingle: true,
            noFallback: true,
          },
        ),
      );
      syncValue = plantedGroup.syncValue;
      planted = {
        syncValue,
        plantedCount: planted.plantedCount + (plantedGroup.plantedCount || 0),
        flowerId: plantedGroup.flowerId || planted.flowerId,
      };
      if (plantedGroup.plantedCount !== selectedGroup.emptyLandIds.length) {
        groupStopped = true;
      } else {
        syncValue = await refreshCycleState(
          "cycleRefreshAfterPlantGroupError",
          syncValue,
          () => refreshLand(ws, gsToken, syncValue, "cycleRefreshAfterPlantGroup"),
        );
        const seededGroupAfterPlant = getSeededLandGroup(syncValue, selectedGroup.startLandId);
        const wateredGroup = await runCycleStep(
          "waterSeededAfterPlantGroupError",
          { syncValue, wateredCount: 0, stopped: true },
          () => waterSeededLandGroup(ws, gsToken, syncValue, seededGroupAfterPlant, { phase: "waterSeededAfterPlantGroup" }),
        );
        syncValue = wateredGroup.syncValue;
        if (wateredGroup.wateredCount) {
          postPlantWatered = {
            syncValue,
            wateredCount: postPlantWatered.wateredCount + wateredGroup.wateredCount,
          };
          syncValue = await refreshCycleState(
            "cycleRefreshAfterWaterGroupError",
            syncValue,
            () => refreshLand(ws, gsToken, syncValue, "cycleRefreshAfterWaterGroup"),
          );
          syncValue = setWaterDropCount(syncValue, wateredGroup.waterDropTargetCount, wateredGroup.waterDropConsumedAtMs);
          const growth = await runGrowthAfterWater("waterSeededAfterPlantGroupPostWater", syncValue);
          mergePostWaterGrowth(growth);
        }
        if (!wateredGroup.wateredCount || wateredGroup.stopped) {
          groupStopped = true;
        }
      }
      if (groupStopped) break;
    }
  }
  const watered = {
    syncValue,
    wateredCount: (firstWatered.wateredCount || 0) + (postPlantWatered.wateredCount || 0),
  };
  syncValue = watered.syncValue;

  if (watered.wateredCount || shouldRunFinalGrowthCheck(syncValue, options)) {
    // Mid-cycle order/shop/pearl work can move lands into the free speed-up window.
    const finalGrowth = await runGrowthAfterWater("postWater", syncValue);
    mergePostWaterGrowth(finalGrowth);
  }

  let mainTasks = { submittedCount: 0, submittedActions: [], failedActions: [] };
  mainTasks = await runCycleStep("mainTaskSubmitError", mainTasks, async () => {
    mainTasks = await autoSubmitMainTasks(ws, gsToken, syncValue, cycle);
    syncValue = mainTasks.syncValue;
    return mainTasks;
  });

  let cyclicStory = { syncValue, actionCount: 0, submittedCount: 0, failedCount: 0, actions: [], failedActions: [] };
  cyclicStory = await runScheduledCycleStep(
    "cyclicStory",
    ACCOUNT_MODULE_INTERVAL_MS.cyclicStory,
    "cyclicStorySubmitError",
    cyclicStory,
    async () => {
    cyclicStory = await autoSubmitCyclicStoryOrders(ws, gsToken, syncValue, cycle);
    syncValue = cyclicStory.syncValue;
    return cyclicStory;
    },
  );
  syncValue = cyclicStory.syncValue || syncValue;

  cyclicNote = await runScheduledCycleStep(
    "cyclicNote",
    ACCOUNT_MODULE_INTERVAL_MS.cyclicNote,
    "cyclicNoteHandleError",
    cyclicNote,
    async () => {
    cyclicNote = await autoHandleCyclicNote(ws, gsToken, syncValue, cycle, options);
    syncValue = cyclicNote.syncValue;
    return cyclicNote;
    },
  );
  syncValue = cyclicNote.syncValue || syncValue;

  if (ws.getSyncValue()) syncValue = mergeAccountGatewaySync(syncValue, ws.getSyncValue());
  if (getState(syncValue).land.rows.some((row) => row.state === 1)) {
    cycleWaterDecision = buildWaterDecision(getPlantWaterRefillContext(syncValue), {
      blockedReason: waterRefillBlockedReason,
      blockedReasonText: waterRefillBlockedReasonText,
    });
  }
  printSummary("cycleSummary", cycle, syncValue, {
    flowerNames,
    ...(Object.hasOwn(options, "customerOrderFlowerCurrencyRewardReleaseMask")
      ? {
        customerOrderFlowerCurrencyRewardReleaseMask:
          options.customerOrderFlowerCurrencyRewardReleaseMask,
      }
      : {}),
    cycleErrors,
    rateLimit: ws.getRateLimitState?.() || null,
    moduleHealth: moduleHealth?.snapshot?.() || null,
    accountScheduler: accountScheduler?.snapshot?.() || null,
    customerOrderScheduler: customerOrderScheduler.snapshot(),
    speedUpFree: speed.speedUp || postWaterSpeed.speedUp,
    harvestedCount: harvested.harvestedCount + postWaterHarvested.harvestedCount,
    postWaterSpeedUpFree: postWaterSpeed.speedUp,
    postWaterHarvestedCount: postWaterHarvested.harvestedCount,
    waterwheelActionCount: waterwheel.actionCount,
    waterwheelActions: waterwheel.actions,
    waterwheelReceivedCount: waterwheel.receivedCount,
    waterwheelNormalReceivedCount: waterwheel.normalReceivedCount,
    waterwheelVideoBaseReceivedCount: waterwheel.videoBaseReceivedCount,
    freeWaterActionCount: freeWater.actionCount,
    freeWaterActions: freeWater.actions,
    freeWaterReceivedCount: freeWater.receivedCount,
    waterDecision: cycleWaterDecision,
    waterRefillBlockedReason,
    waterRefillBlockedReasonText,
    specialOrderSubmittedCount: specialOrders.submittedCount,
    specialOrderSubmittedActions: specialOrders.submittedActions,
    ordinaryResidentOrderSubmittedCount: ordinaryResidentOrders.submittedCount,
    ordinaryResidentOrderSubmittedActions: ordinaryResidentOrders.submittedActions,
    ordinaryResidentOrderFailedActions: ordinaryResidentOrders.failedActions,
    palaceOrderSubmittedCount: palaceOrders.submittedCount,
    palaceOrderSubmittedActions: palaceOrders.submittedActions,
    mainTaskSubmittedCount: mainTasks.submittedCount,
    mainTaskSubmittedActions: mainTasks.submittedActions,
    cyclicStoryActionCount: cyclicStory.actionCount,
    cyclicStorySubmittedCount: cyclicStory.submittedCount,
    cyclicStoryFailedCount: cyclicStory.failedCount,
    cyclicStoryActions: cyclicStory.actions,
    cyclicStoryFailedActions: cyclicStory.failedActions,
    cyclicNoteActionCount: cyclicNote.actionCount,
    cyclicNoteReceivedCount: cyclicNote.receivedCount,
    cyclicNoteFailedCount: cyclicNote.failedCount,
    cyclicNoteActions: cyclicNote.actions,
    cyclicNoteFailedActions: cyclicNote.failedActions,
    customerOrderActionCount: customerOrders.actionCount,
    customerOrderActions: customerOrders.actions,
    customerOrderFlowerCurrencyHistoryPath,
    fmlLandScanned: fmlLand.scanned,
    fmlLandActionCount: fmlLand.actionCount,
    fmlLandActions: fmlLand.actions,
    fmlLandHarvestedCount: fmlLand.harvestedCount,
    fmlLandFailedCount: fmlLand.failedCount,
    flowerRackActionCount: flowerRack.actionCount,
    flowerRackActions: flowerRack.actions,
    flowerRackGoldReceivedCount: flowerRack.receivedCount,
    flowerRackMakeActionCount: flowerRack.makeActionCount,
    flowerRackMadeCount: flowerRack.madeCount,
    flowerRackShelvedCount: flowerRack.shelvedCount,
    flowerRackFailedCount: flowerRack.failedCount,
    pearlActionCount: pearl.actionCount,
    pearlActions: pearl.actions,
    pearlReceivedCount: pearl.receivedCount,
    pearlHireCount: pearl.hireCount,
    pearlDailyFreeCount: pearl.dailyFreeCount,
    materialShopActionCount: materialShop.actionCount,
    materialShopActions: materialShop.actions,
    materialShopBoughtCount: materialShop.boughtCount,
    materialShopSpentGold: materialShop.spentGold,
    materialShopFailedCount: materialShop.failedCount,
    materialShopRefreshActions: materialShop.refreshActions,
    materialShopRefreshCount: materialShop.refreshCount,
    materialShopFreeRefreshCount: materialShop.freeRefreshCount,
    materialShopPaidRefreshCount: materialShop.paidRefreshCount,
    materialShopSpentYuanbao: materialShop.spentYuanbao,
    materialShopRefreshFailedCount: materialShop.refreshFailedCount,
    materialShopRefreshStopReason: materialShop.refreshStopReason,
    plantedCount: planted.plantedCount,
    wateredCount: watered.wateredCount,
    waterDropFlow: buildWaterDropFlow(
      waterDropBeforeWater,
      decorateWaterDropStatus(getWaterDropStatus(syncValue)),
      watered.wateredCount,
    ),
    plantedFlowerId: planted.flowerId || null,
    blockedPlantGroups,
    waterBlockedPlantGroups,
  });
  ws.observeSync(syncValue, { cycle });
  accountScheduler?.observeAuthoritativeSnapshot?.(syncValue);
  return syncValue;
}

async function openGameWsSession(gsInfo, gsLoginArg, previousSyncValue = null, options = {}) {
  const connectStep = options.connectStep || "wsConnect";
  const loginStep = options.loginStep || "gsLogin";
  const debugLabel = options.debugLabel || loginStep;
  const wsFactory = options.wsFactory || ((url) => new GameWs(url));
  const ws = wsFactory(`wss://${gsInfo.host}:${gsInfo.port_ssl}`);
  await runAtAutomationRequestBoundary(
    options,
    () => ws.connect(),
    () => ws.close?.(),
  );
  console.log(JSON.stringify({ step: connectStep, ok: true }));

  const gsLoginRaw = await runAtAutomationRequestBoundary(
    options,
    () => ws.request("gs.index.login", gsLoginArg, null),
  );
  const gsLoginRsp = washResponse(gsLoginRaw);
  if (gsLoginRsp.errMsg) throw new Error(`GS login err: ${JSON.stringify(gsLoginRsp.errMsg)}`);
  const gsLoginValue = gsLoginRsp.value;
  debugLandRaw(debugLabel, gsLoginRaw, gsLoginValue);
  const gsToken = gsLoginValue?.$other?.token || gsLoginArg.token;
  const loginWithNobleState = gsLoginValue
    ? markNobleSessionState(gsLoginValue, { authoritativeComplete: true })
    : null;
  const loginSyncValue = previousSyncValue && gsLoginValue
    ? previousSyncValue
    : null;
  const syncValue = loginWithNobleState
    ? {
        ...mergeAuthoritativeWaterDropSync(loginSyncValue, loginWithNobleState, loginStep, {
          rawSourcePrefix: loginStep,
          mergedSourcePrefix: "merged",
        }),
        [NOBLE_SESSION_STATE_FIELD]: loginWithNobleState[NOBLE_SESSION_STATE_FIELD],
      }
    : gsLoginValue;
  console.log(JSON.stringify({
    step: loginStep,
    dsName: gsLoginRsp.dsName,
    usrId: gsLoginValue?.$usrTot?.data?.id || gsLoginValue?.$usrTot?.usr?.id,
    gsTokenLen: String(gsToken).length,
  }));
  return {
    ws: createStopGuardedWs(ws, options),
    gsToken,
    syncValue,
  };
}

const CLIENT_GAME_WS_RECONNECT_DELAYS_MS = Object.freeze([0, 2_000, 5_000, 10_000, 30_000]);

function getWsReconnectDelayMs(attempt, options = {}) {
  const schedule = Array.isArray(options.reconnectDelaysMs) && options.reconnectDelaysMs.length
    ? options.reconnectDelaysMs
    : CLIENT_GAME_WS_RECONNECT_DELAYS_MS;
  const baseDelayMs = Math.max(
    0,
    Number(schedule[Math.min(attempt, schedule.length - 1)]) || 0,
  );
  const jitterRatio = Number.isFinite(Number(options.reconnectJitterRatio))
    ? Math.max(0, Number(options.reconnectJitterRatio))
    : 0.15;
  if (!baseDelayMs || !jitterRatio) return baseDelayMs;
  const randomFn = options.randomFn || Math.random;
  const jitter = Math.round(baseDelayMs * jitterRatio * ((randomFn() * 2) - 1));
  return Math.max(0, baseDelayMs + jitter);
}

async function autoSubmitCyclicStoryOrders(ws, gsToken, syncValue, cycle = null) {
  const autoSubmitSetting = getCyclicStoryAutoSubmitSetting();
  const onlyHighestExperienceSetting = getCyclicStoryOnlyHighestExperienceSetting();
  const onlyHighestExperienceOrder = onlyHighestExperienceSetting.enabled;
  const initialStatus = summarizeCyclicStoryStatus(syncValue, {
    autoSubmitEnabled: autoSubmitSetting.enabled,
    onlyHighestExperienceOrder,
  });
  const emptyResult = (status = initialStatus) => ({
    syncValue,
    actionCount: 0,
    submittedCount: 0,
    failedCount: 0,
    actions: [],
    failedActions: [],
    status,
  });
  if (!autoSubmitSetting.enabled) {
    console.log(JSON.stringify({
      step: "cyclicStorySkip",
      cycle,
      reason: "auto-submit-disabled",
      reasonText: "自动提交莳花纪闻订单已关闭",
      phase: initialStatus.phase,
      batchId: initialStatus.batchId,
    }));
    return emptyResult();
  }
  if (!initialStatus.exists || initialStatus.reason === "unknown") {
    console.log(JSON.stringify({
      step: "cyclicStorySkip",
      cycle,
      reason: initialStatus.reason || "unknown",
      reasonText: initialStatus.reasonText,
      phase: initialStatus.phase,
      batchId: initialStatus.batchId,
    }));
    return emptyResult();
  }
  if (!initialStatus.active) {
    console.log(JSON.stringify({
      step: "cyclicStorySkip",
      cycle,
      reason: "inactive",
      reasonText: initialStatus.reasonText,
      phase: initialStatus.phase,
      batchId: initialStatus.batchId,
    }));
    return emptyResult();
  }
  if (!initialStatus.batchId) {
    console.log(JSON.stringify({
      step: "cyclicStorySkip",
      cycle,
      reason: "missing-batch-id",
      phase: initialStatus.phase,
      batchId: initialStatus.batchId,
    }));
    return emptyResult();
  }

  let next = await refreshCyclicStoryStatus(
    ws,
    gsToken,
    syncValue,
    initialStatus.batchId,
    cycle,
  );
  let status = summarizeCyclicStoryStatus(next, {
    autoSubmitEnabled: autoSubmitSetting.enabled,
    onlyHighestExperienceOrder,
  });
  const submittedActions = [];
  const failedActions = [];
  const attemptedOrderKeys = new Set();
  let actionCount = 0;

  const maxSubmitPerCycle = onlyHighestExperienceOrder ? 1 : CYCLIC_STORY_MAX_SUBMIT_PER_CYCLE;
  for (let stepIndex = 1; stepIndex <= maxSubmitPerCycle; stepIndex += 1) {
    const action = getAutoSubmitCyclicStoryActions(status, {
      onlyHighestExperienceOrder,
    })
      .find((candidate) => !attemptedOrderKeys.has(`${candidate.batchId}:${candidate.orderIdx}`));
    if (!action) break;
    actionCount += 1;
    attemptedOrderKeys.add(`${action.batchId}:${action.orderIdx}`);
    console.log(JSON.stringify({
      step: "cyclicStoryActionPlan",
      cycle,
      storyStep: stepIndex,
      batchId: action.batchId,
      orderIdx: action.orderIdx,
      flowerId: action.flowerId,
      cost: action.cost,
      have: action.have,
      expectedExperience: action.expectedExperience,
      iface: action.iface,
    }));

    try {
      const rsp = await requestSync(
        ws,
        gsToken,
        action.iface,
        action.args,
        "Cyclic story order submit failed",
      );
      next = rsp.value ? mergeLandSync(next, rsp.value) : next;
      submittedActions.push(action);
      console.log(JSON.stringify({
        step: "cyclicStoryOrderSubmitted",
        cycle,
        storyStep: stepIndex,
        batchId: action.batchId,
        orderIdx: action.orderIdx,
        orderId: action.orderId,
        flowerId: action.flowerId,
        cost: action.cost,
        expectedExperience: action.expectedExperience,
        iface: action.iface,
        dsName: rsp.dsName,
        err: null,
      }));
      next = await refreshCyclicStoryStatus(
        ws,
        gsToken,
        next,
        action.batchId,
        cycle,
        "cyclicStoryEnterAfterSubmit",
      );
      status = summarizeCyclicStoryStatus(next, {
        autoSubmitEnabled: autoSubmitSetting.enabled,
        onlyHighestExperienceOrder,
      });
      if (!status.active || status.batchId !== action.batchId) break;
    } catch (err) {
      if (isSessionExpiredError(err) || isWsRequestTimeoutError(err) || isExperienceGuardError(err)) throw err;
      if (isExperienceActionBlockedError(err)) break;
      const failedAction = {
        ...action,
        reason: "recv-order-rwd-failed",
        message: err.message,
      };
      failedActions.push(failedAction);
      console.log(JSON.stringify({
        step: "cyclicStoryOrderSubmitFailed",
        cycle,
        batchId: action.batchId,
        orderIdx: action.orderIdx,
        flowerId: action.flowerId,
        iface: action.iface,
        reason: failedAction.reason,
        message: failedAction.message,
      }));
      break;
    }
  }

  return {
    syncValue: next,
    actionCount,
    submittedCount: submittedActions.length,
    failedCount: failedActions.length,
    actions: submittedActions,
    failedActions,
    status,
  };
}

async function reopenGameWsSessionWithRetry(options = {}) {
  const {
    ws,
    gsInfo,
    gsLoginArg,
    syncValue,
    cycle = null,
    reason = "ws-timeout",
    openSession = openGameWsSession,
    refreshLandFn = refreshLand,
    connectStep = "wsReconnect",
    loginStep = "gsReconnectLogin",
    debugLabel = "gsReconnectLogin",
  } = options;
  const reconnectDelaysMs = Array.isArray(options.reconnectDelaysMs) && options.reconnectDelaysMs.length
    ? options.reconnectDelaysMs
    : CLIENT_GAME_WS_RECONNECT_DELAYS_MS;

  try {
    ws?.close?.();
  } catch {}

  let attempt = 0;
  while (true) {
    await throwIfAutomationStopped(options);
    attempt++;
    console.log(JSON.stringify({ step: "wsReconnectStart", cycle, reason, attempt }));
    try {
      const reopened = await openSession(gsInfo, gsLoginArg, syncValue, {
        connectStep,
        loginStep,
        debugLabel,
        signal: options.signal,
        stopPath: options.stopPath,
      });
      await throwIfAutomationStopped(options);
      let refreshedSyncValue = reopened.syncValue;
      try {
        refreshedSyncValue = await refreshLandFn(
          reopened.ws,
          reopened.gsToken,
          refreshedSyncValue,
          "cycleRefreshAfterReconnect",
        );
      } catch (refreshErr) {
        rethrowGlobalAutomationError(refreshErr);
        console.log(JSON.stringify({
          step: "cycleRefreshAfterReconnectError",
          cycle,
          message: refreshErr.message,
        }));
      }
      return {
        ws: reopened.ws,
        gsToken: reopened.gsToken,
        syncValue: refreshedSyncValue,
      };
    } catch (err) {
      if (isSessionExpiredError(err) || isUserStoppedError(err)) throw err;
      if (attempt >= reconnectDelaysMs.length) {
        console.log(JSON.stringify({
          step: "wsReconnectExhausted",
          cycle,
          reason,
          attempt,
          message: err.message,
        }));
        throw err;
      }
      const retryDelayMs = getWsReconnectDelayMs(attempt, options);
      console.log(JSON.stringify({
        step: "wsReconnectError",
        cycle,
        reason,
        attempt,
        message: err.message,
        retryInSeconds: Math.ceil(retryDelayMs / 1000),
      }));
      await waitForAutomationDelay(retryDelayMs, {
        ...options,
        waitFn: options.waitFn || wait,
      });
    }
  }
}

async function main(options = {}) {
  await throwIfAutomationStopped(options);
  const moduleHealth = options.moduleHealth || createAutomationModuleHealthRegistry();
  activeAutomationModuleHealth = moduleHealth;
  validateConfig();
  console.log(JSON.stringify({
    step: "schemas",
    count: Object.keys(schemas).length,
    hasISyncData: !!schemas["G.ISyncData"],
    gameJsPath: schemaGameJsPath,
  }));

  const auth = await runAtAutomationRequestBoundary(
    options,
    () => webgw(
      "com.alipay.gamecenterhome.common.facade.service.GameCenterPcGameFacade",
      "queryPcGameAuthInfo",
      "uprodhatchstation66500008",
      { appId: APP_ID },
    ),
  );
  const authCode = auth?.data?.authCode;
  if (!authCode) throw new Error(`No authCode: ${JSON.stringify(auth).slice(0, 300)}`);
  console.log(JSON.stringify({ step: "pcAuth", success: auth.success === true, authCodeLen: authCode.length }));

  const openData = JSON.stringify({
    query: {
      gameId: GAME_ID,
      chInfo: "pc_default",
      mBizScenario: "",
      mPageState: "",
      fullURL: "https://www.wanyiwan.top/game/xjskp",
      ref: "https://www.wanyiwan.top/game/xjskp",
    },
    scene: "other",
  });
  const systemInfo = JSON.stringify({
    model: "Windows PC",
    brand: "",
    platform: "windows",
    system: "Windows 10",
    screenHeight: 1280,
    screenWidth: 2048,
    language: "zh-CN",
  });
  const pack = await runAtAutomationRequestBoundary(
    options,
    () => postJson(`https://apizfbfast.babigame.cn/pack/init/packageName/${PACKAGE_NAME}`, {
      open_data: openData,
      system_info: systemInfo,
      version: "2.2.209",
      userParams: 1,
    }),
  );
  const packData = pack.data || pack;
  const up = typeof packData.userParams === "string" ? JSON.parse(packData.userParams) : packData.userParams;
  const loginPackageInfo = getLoginPackageInfo(up);
  console.log(JSON.stringify({
    step: "packInit",
    status: pack.status || packData.status || "ok",
    appVersion: up?.appVersion,
    manifestAppVersion: loginPackageInfo.manifestAppVersion,
    loginAppVersion: loginPackageInfo.appVersion,
    loginAppVersionSource: loginPackageInfo.appVersionSource,
    packageId: up?.packageId,
    loginPackageId: loginPackageInfo.packageId,
  }));

  const yxt = await runAtAutomationRequestBoundary(
    options,
    () => postForm("https://h5sdk.hnycgames.cn/Channel/login/yxtGame/wdhysj/yxtChannel/myxyx/yxtSubChannel/myxyx", {
      authCode,
      scene: "other",
    }),
  );
  if (yxt.errorCode !== 0) throw new Error(`YXT login failed: ${JSON.stringify(yxt).slice(0, 300)}`);
  const yd = yxt.data;
  console.log(JSON.stringify({ step: "yxtLogin", ok: true, yxtUserIdLen: String(yd.yxtUserId || "").length }));

  const gameLogin = await runAtAutomationRequestBoundary(
    options,
    () => postJson(`https://apizfbfast.babigame.cn/game/login/mdcl/c${MDCL}/mdgid/${MDGID}/env/prod`, {
      open_data: openData,
      system_info: systemInfo,
      yxtGame: yd.yxtGame,
      yxtChannel: yd.yxtChannel,
      yxtUserId: yd.yxtUserId,
      yxtLoginTime: yd.yxtLoginTime,
      yxtSign: yd.yxtSign,
      yxtChannelUserId: yd.yxtChannelUserId,
    }),
  );
  const content = gameLogin?.data?.content;
  if (!content) throw new Error(`No game login content: ${JSON.stringify(gameLogin).slice(0, 300)}`);
  console.log(JSON.stringify({ step: "gameLogin", status: gameLogin.status, code: gameLogin.code, contentLen: content.length }));

  const now = Date.now();
  const gwLoginRaw = await runAtAutomationRequestBoundary(
    options,
    () => gwRequest("gw.index.login", {
      sdkId: 10000,
      chnId: MDCL,
      params: {
        token: cfg.babiToken,
        open_id: cfg.openId,
        content,
        zoneCode: loginPackageInfo.zoneCode,
        appVersion: loginPackageInfo.appVersion,
        packageId: loginPackageInfo.packageId,
        $ms: now,
      },
      msBeforeLogin: now - 1000,
      msAfterLogin: now,
      osType: 0,
      deviceId: "pc-web",
      isSimulator: 0,
    }),
  );
  const gwLogin = washResponse(gwLoginRaw).value;
  const gwToken = gwLogin?.$other?.token;
  if (!gwToken) throw new Error(`No GW token: ${JSON.stringify(gwLoginRaw).slice(0, 500)}`);
  const serverIdx = resolveGatewayServerIndex(gwLogin);
  console.log(JSON.stringify({ step: "gwLogin", accId: gwLogin?.acc?.id, lastGsIdx: gwLogin?.acc?.lastGsIdx, serverIdx, gwTokenLen: gwToken.length }));

  const gsListRaw = await runAtAutomationRequestBoundary(
    options,
    () => gwRequest(
      "gw.index.getGsInfoList",
      { aid: gwLogin.acc.id, idx: serverIdx, chnId: MDCL },
      gwToken,
    ),
  );
  const gsSync = washResponse(gsListRaw).value;
  const gsInfo = (gsSync?.$gsTot?.gsInfoList || [])
    .map((item) => ({ ...item, idx: item.idx || serverIdx || DEFAULT_SERVER_IDX }))
    .find((item) => Number(item.idx) === Number(serverIdx));
  if (!gsInfo) throw new Error(`No GS info for ${serverIdx}: ${JSON.stringify(gsSync?.$gsTot || {}).slice(0, 1000)}`);
  console.log(JSON.stringify({ step: "gsInfo", idx: gsInfo.idx, host: gsInfo.host, port_ssl: gsInfo.port_ssl, status: gsInfo.status }));

  const gsLoginArg = {
    aid: gwLogin.acc.id,
    gsIdx: serverIdx,
    token: gwToken,
    osType: 0,
    isNative: false,
    deviceId: "pc-web",
    isSimulator: 0,
    deviceInfo: {
      osType: "Windows",
      deviceId: "pc-web",
      isEmulator: 0,
      osVersion: "Windows 10",
      brand: "",
      model: "Windows PC",
      networkType: "4g",
      sysLanguage: "zh-CN",
      screenWidthPx: 2048,
      screenHeightPx: 1280,
      deviceType: "PC",
      appVersion: loginPackageInfo.appVersion,
    },
  };
  let { ws, gsToken, syncValue } = await openGameWsSession(
    gsInfo,
    gsLoginArg,
    null,
    options,
  );
  syncValue = { ...syncValue, $loginServerIdx: serverIdx };
  try {
    const lazyRaw = await ws.request("gs.usr.lazySync", {}, gsToken);
    const lazy = washResponse(lazyRaw);
    if (!lazy.errMsg && lazy.value) {
      syncValue = {
        ...mergeAuthoritativeWaterDropSync(syncValue, lazy.value, "lazySync", {
          rawSourcePrefix: "lazySync",
          mergedSourcePrefix: "merged",
        }),
        $loginServerIdx: serverIdx,
      };
    }
    debugLandRaw("lazySync", lazyRaw, lazy.value);
    console.log(JSON.stringify({ step: "lazySync", dsName: lazy.dsName, err: lazy.errMsg || null }));
  } catch (err) {
    console.log(JSON.stringify({ step: "lazySync", warn: err.message }));
  }

  try {
    const refreshRaw = await ws.request("gs.usrLand.refresh", {}, gsToken);
    const refresh = washResponse(refreshRaw);
    if (!refresh.errMsg && refresh.value) {
      syncValue = {
        ...mergeAuthoritativeWaterDropSync(syncValue, refresh.value, "usrLandRefresh", {
          rawSourcePrefix: "usrLandRefresh",
          mergedSourcePrefix: "merged",
        }),
        $loginServerIdx: serverIdx,
      };
    }
    debugLandRaw("usrLandRefresh", refreshRaw, refresh.value);
    console.log(JSON.stringify({ step: "usrLandRefresh", dsName: refresh.dsName, err: refresh.errMsg || null }));
  } catch (err) {
    if (isSessionExpiredError(err)) throw err;
    console.log(JSON.stringify({ step: "usrLandRefresh", warn: err.message }));
  }

  const startupExperienceLevelGuard = createAutomationExperienceLevelGuard(options);
  let initialAuthorityEligibleRearmRequestId = null;
  if (process.env.ACTION !== "orders-status") {
    const startupPendingRearmRequestId = startupExperienceLevelGuard
      ?.getPendingRearm?.()?.requestId ?? null;
    const startupRefresh = await refreshExperienceGuardSync(
      ws,
      gsToken,
      syncValue,
      "experienceGuardRefreshBeforeAction",
      process.env.ACTION || null,
      { returnEvidence: true },
    );
    syncValue = startupRefresh.syncValue;
    initialAuthorityEligibleRearmRequestId = startupPendingRearmRequestId;
  }

  syncValue = attachFlowerRackRecommendations(syncValue);
  ws = createAutomationAccountCommandGateway(ws, gsToken, syncValue, {
    ...options,
    experienceLevelGuard: startupExperienceLevelGuard,
    initialAuthorityEligibleRearmRequestId,
  });
  syncValue = ws.getSyncValue() || syncValue;

  if (process.env.ACTION !== "orders-status") {
    const readyContext = { step: "startupReady", cycle: "startup" };
    writeStatusDocuments(syncValue, readyContext);
    emitAutomationReady(syncValue, readyContext);
  }

  if (process.env.ACTION === "orders-status") {
    const orderRaw = await ws.request("gs.orderFlower.enter", {}, gsToken);
    const orderRsp = washResponse(orderRaw);
    if (orderRsp.errMsg) throw new Error(`Order flower enter failed: ${JSON.stringify(orderRsp.errMsg)}`);
    if (orderRsp.value) syncValue = mergeLandSync(syncValue, orderRsp.value);
    console.log(JSON.stringify({ step: "orderFlowerEnter", dsName: orderRsp.dsName, err: null }));
    logOrderStatusParsed(syncValue, { iface: "gs.orderFlower.enter" });
    writeStatusDocuments(syncValue, { step: "ordersStatus", cycle: "orders-status" });
    await waitForAutomationDelay(100, options);
    ws.close();
    return;
  }

  if (["auto-loop", "loop", "watch"].includes(process.env.ACTION)) {
    const intervalConfig = getLoopIntervalConfig(process.env);
    const maxCycles = Math.max(0, Number(process.env.MAX_CYCLES || 0));
    const teamOrderRuntime = createTeamOrderSessionRuntime(syncValue, options);
    const accountData = syncValue?.$usrTot?.data || syncValue?.$usrTot?.usr || {};
    const accountScheduler = options.accountScheduler || createAccountScheduler({
      accountId: process.env.PROFILE_ID || accountData.id || accountData.uid || null,
      nowFn: options.schedulerNowFn || Date.now,
    });
    const customerOrderScheduler = options.customerOrderScheduler || createCustomerOrderScheduler({
      nowFn: options.schedulerNowFn || Date.now,
      retryIntervalMs: getCustomerOrderGenerationDuringWaitRetryIntervalMs(),
      healthCheckIntervalMs: CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS,
    });
    const specialOrderRefreshState = createSpecialOrderRefreshState();
    let cycle = 0;
    console.log(JSON.stringify({ step: "loopIntervalConfig", ...intervalConfig }));
    try {
      while (!maxCycles || cycle < maxCycles) {
        cycle++;
        let retryAfterReconnect = false;
        try {
          syncValue = await runGardenCycle(ws, gsToken, syncValue, cycle, {
            teamOrderRuntime,
            accountScheduler,
            customerOrderScheduler,
            specialOrderRefreshState,
          });
        } catch (err) {
          console.log(JSON.stringify({ step: "cycleError", cycle, message: err.message }));
          if (isUserStoppedError(err)) {
            await finalizeUserStopped(syncValue, teamOrderRuntime, { cycle });
            return;
          }
          const summary = {
            ...(isSessionExpiredError(err) || isExperienceGuardError(err)
              ? buildAutomationStoppedSummary(err, { cycle, step: "cycleError" })
              : {
                  loopError: err.message,
                  loopErrorAt: formatDateTime(new Date()),
                }),
            customerOrderScheduler: customerOrderScheduler.snapshot(),
          };
          writeStatusDocuments(syncValue, {
            step: "cycleError",
            cycle,
            summary,
          });
          if (isSessionExpiredError(err) || isExperienceGuardError(err)) throw err;
          if (isWsRequestTimeoutError(err)) {
            retryAfterReconnect = true;
            const reopened = await reopenGameWsSessionWithRetry({
              ...options,
              ws,
              gsInfo,
              gsLoginArg,
              syncValue,
              cycle,
              reason: err.message,
            });
            const reopenedSyncValue = {
              ...reopened.syncValue,
              $flowerRackRecommendations: syncValue.$flowerRackRecommendations,
            };
            await ws.replaceTransport(reopened.ws, {
              token: reopened.gsToken,
              syncValue: reopenedSyncValue,
              context: { cycle },
            });
            gsToken = reopened.gsToken;
            syncValue = reopenedSyncValue;
          }
        }
        if (maxCycles && cycle >= maxCycles) break;
        if (retryAfterReconnect) {
          console.log(JSON.stringify({ step: "loopReconnectRetry", cycle, seconds: 0 }));
          continue;
        }
        const sleepSeconds = getLoopSleepSeconds(process.env);
        console.log(JSON.stringify({ step: "loopSleep", cycle, seconds: sleepSeconds, intervalMode: intervalConfig.mode }));
        try {
          syncValue = await waitWithOnlineHeartTick(ws, gsToken, syncValue, sleepSeconds * 1000, {
            ...options,
            cycle,
            accountScheduler,
            customerOrderScheduler,
          });
        } catch (err) {
          console.log(JSON.stringify({ step: "loopWaitError", cycle, message: err.message }));
          if (isUserStoppedError(err)) {
            await finalizeUserStopped(syncValue, teamOrderRuntime, { cycle });
            return;
          }
          const summary = {
            ...(isSessionExpiredError(err) || isExperienceGuardError(err)
              ? buildAutomationStoppedSummary(err, { cycle, step: "loopWaitError" })
              : {
                  loopError: err.message,
                  loopErrorAt: formatDateTime(new Date()),
                }),
            customerOrderScheduler: customerOrderScheduler.snapshot(),
          };
          writeStatusDocuments(syncValue, {
            step: "loopWaitError",
            cycle,
            summary,
          });
          if (isSessionExpiredError(err) || isExperienceGuardError(err)) throw err;
          if (!isWsRequestTimeoutError(err)) throw err;
          const reopened = await reopenGameWsSessionWithRetry({
            ...options,
            ws,
            gsInfo,
            gsLoginArg,
            syncValue,
            cycle,
            reason: err.message,
          });
          const reopenedSyncValue = {
            ...reopened.syncValue,
            $flowerRackRecommendations: syncValue.$flowerRackRecommendations,
          };
          await ws.replaceTransport(reopened.ws, {
            token: reopened.gsToken,
            syncValue: reopenedSyncValue,
            context: { cycle },
          });
          gsToken = reopened.gsToken;
          syncValue = reopenedSyncValue;
          console.log(JSON.stringify({ step: "loopReconnectRetry", cycle, seconds: 0 }));
        }
      }
      await teamOrderRuntime.flush();
      await waitForAutomationDelay(100, options);
    } catch (err) {
      if (!isUserStoppedError(err)) throw err;
      await finalizeUserStopped(syncValue, teamOrderRuntime, { cycle });
    } finally {
      ws.close();
    }
    return;
  }

  let land = summarizeLand(syncValue);
  let candidates = summarizePlantCandidates(syncValue);
  let recommendation = {
    harvestLandIds: land.mature.map((item) => item.landId),
    emptyLandIds: land.empty,
    plantFlower: candidates[0] || null,
    candidateTop5: candidates.slice(0, 5),
  };

  if (process.env.ACTION === "plant-one") {
    const landId = Number(process.env.LAND_ID || recommendation.emptyLandIds[0]);
    if (!landId) throw new Error("No empty land available for plant-one");

    syncValue = await refreshInventoryBeforePlant(ws, gsToken, syncValue, "plantOneInventoryRefreshBeforePlant");
    land = summarizeLand(syncValue);
    candidates = summarizePlantCandidates(syncValue);
    recommendation = {
      harvestLandIds: land.mature.map((item) => item.landId),
      emptyLandIds: land.empty,
      plantFlower: candidates[0] || null,
      candidateTop5: candidates.slice(0, 5),
    };
    logPlantSelectionParsed(syncValue, {
      mode: "plant-one",
      targetLandId: landId,
      emptyLandCount: recommendation.emptyLandIds.length,
    });

    const flowerId = Number(process.env.FLOWER_ID || recommendation.plantFlower?.flowerId);
    if (!flowerId) throw new Error("No plant candidate available for plant-one");

    console.log(JSON.stringify({ step: "plantOnePlan", landId, flowerId }));
    const plantRaw = await ws.request("gs.usrLand.plant", { landId, flowerId }, gsToken);
    const plant = washResponse(plantRaw);
    debugLandRaw("plantOne", plantRaw, plant.value);
    if (plant.errMsg) throw new Error(`Plant failed: ${JSON.stringify(plant.errMsg)}`);
    syncValue = mergeLandSync(syncValue, plant.value);
    console.log(JSON.stringify({ step: "plantOne", dsName: plant.dsName, err: null }));

    const verifyRaw = await ws.request("gs.usrLand.refresh", {}, gsToken);
    const verify = washResponse(verifyRaw);
    if (verify.errMsg) throw new Error(`Verify refresh failed: ${JSON.stringify(verify.errMsg)}`);
    syncValue = mergeLandSync(syncValue, verify.value);
    const verifyLand = summarizeLand(syncValue);
    const planted = verifyLand.rows.find((row) => row.landId === landId);
    console.log(JSON.stringify({
      step: "plantOneVerify",
      planted,
      emptyCount: verifyLand.empty.length,
      growingCount: verifyLand.growing.length,
      matureCount: verifyLand.mature.length,
    }, null, 2));
    land = verifyLand;
    candidates = summarizePlantCandidates(syncValue);
    recommendation = {
      harvestLandIds: land.mature.map((item) => item.landId),
      emptyLandIds: land.empty,
      plantFlower: candidates[0] || null,
      candidateTop5: candidates.slice(0, 5),
    };
  }

  if (process.env.ACTION === "plant-empty" || process.env.ACTION === "plant-all-empty") {
    const landIds = (process.env.LAND_IDS
      ? process.env.LAND_IDS.split(",").map((item) => Number(item.trim())).filter(Boolean)
      : recommendation.emptyLandIds
    );
    if (!landIds.length) {
      console.log(JSON.stringify({
        step: "plantEmptySkip",
        reason: "no-empty-land",
        emptyCount: 0,
        growingCount: land.growing.length,
        matureCount: land.mature.length,
      }));
    } else {
      syncValue = await refreshInventoryBeforePlant(ws, gsToken, syncValue, "plantEmptyInventoryRefreshBeforePlant");
      land = summarizeLand(syncValue);
      candidates = summarizePlantCandidates(syncValue);
      recommendation = {
        harvestLandIds: land.mature.map((item) => item.landId),
        emptyLandIds: land.empty,
        plantFlower: candidates[0] || null,
        candidateTop5: candidates.slice(0, 5),
      };
      logPlantSelectionParsed(syncValue, {
        mode: process.env.ACTION,
        targetLandCount: landIds.length,
        emptyLandCount: recommendation.emptyLandIds.length,
      });
      const flowerId = Number(process.env.FLOWER_ID || recommendation.plantFlower?.flowerId);
      if (!flowerId) throw new Error("No plant candidate available for plant-empty");

      console.log(JSON.stringify({ step: "plantEmptyPlan", landCount: landIds.length, flowerId, firstLandId: landIds[0], lastLandId: landIds[landIds.length - 1] }));
      let plantedBy = "plantBatch";
      let plantRaw = await ws.request("gs.usrLand.plantBatch", { landIds, flowerId }, gsToken);
      let plant = washResponse(plantRaw);
      if (plant.errMsg && process.env.NO_PLANT_FALLBACK !== "1") {
        plantedBy = "plant";
        for (const landId of landIds) {
          const oneRaw = await ws.request("gs.usrLand.plant", { landId, flowerId }, gsToken);
          const one = washResponse(oneRaw);
          if (one.errMsg) throw new Error(`Plant failed on land ${landId}: ${JSON.stringify(one.errMsg)}`);
          syncValue = mergeLandSync(syncValue, one.value);
        }
      } else {
        if (plant.errMsg) throw new Error(`Plant batch failed: ${JSON.stringify(plant.errMsg)}`);
        syncValue = mergeLandSync(syncValue, plant.value);
      }
      console.log(JSON.stringify({ step: "plantEmpty", plantedBy, landCount: landIds.length, flowerId }));

      const verifyRaw = await ws.request("gs.usrLand.refresh", {}, gsToken);
      const verify = washResponse(verifyRaw);
      if (verify.errMsg) throw new Error(`Verify refresh failed: ${JSON.stringify(verify.errMsg)}`);
      syncValue = mergeLandSync(syncValue, verify.value);
      const verifyLand = summarizeLand(syncValue);
      const plantedRows = verifyLand.rows.filter((row) => landIds.includes(row.landId));
      console.log(JSON.stringify({
        step: "plantEmptyVerify",
        requestedCount: landIds.length,
        plantedCount: plantedRows.filter((row) => !row.empty && row.flowerId === flowerId).length,
        emptyCount: verifyLand.empty.length,
        growingCount: verifyLand.growing.length,
        matureCount: verifyLand.mature.length,
        flowerId,
        sample: plantedRows.slice(0, 5),
      }, null, 2));
      land = verifyLand;
      candidates = summarizePlantCandidates(syncValue);
      recommendation = {
        harvestLandIds: land.mature.map((item) => item.landId),
        emptyLandIds: land.empty,
        plantFlower: candidates[0] || null,
        candidateTop5: candidates.slice(0, 5),
      };
    }
  }

  if (process.env.SUMMARY_ONLY === "1") {
    writeStatusDocuments(syncValue, { step: "summary", cycle: process.env.ACTION || "once" });
    console.log(JSON.stringify({
      step: "summary",
      land: {
        total: land.total,
        emptyCount: land.empty.length,
        growingCount: land.growing.length,
        matureCount: land.mature.length,
      },
      recommendation: {
        harvestLandIds: recommendation.harvestLandIds,
        emptyLandIds: recommendation.emptyLandIds,
        plantFlower: recommendation.plantFlower,
        candidateTop5: recommendation.candidateTop5,
      },
    }, null, 2));
  } else {
    writeStatusDocuments(syncValue, { step: "dryRun", cycle: process.env.ACTION || "once" });
    console.log(JSON.stringify({ step: "dryRun", land, recommendation }, null, 2));
  }
    await waitForAutomationDelay(100, options);
  ws.close();
}

export {
  SESSION_EXPIRED_EXIT_CODE,
  EXPERIENCE_GUARD_EXIT_CODE,
  buildAutomationStoppedSummary,
  classifyAutomationError,
  isSessionExpiredPayload,
  readPackageAppVersionFromManifest,
  getLoginPackageInfo,
  resolveGatewayServerIndex,
  buildTeamOrderRunnerContext,
  getOrdinaryResidentPreflightActions,
  getCyclicNoteOrdinaryResidentAutoSubmitSetting,
  resolveOrdinaryResidentSingleSampleValidation,
  isExperienceRewardIface,
  createAutomationAccountCommandGateway,
  createExperienceGuardedWs,
  mergeAccountGatewaySync,
  requestResidentOrderAction,
  refreshSpecialOrders,
  refreshLazySync,
  refreshOnlineState,
  runGardenCycle,
  autoHandleCyclicNote,
  autoUpgradeFlowers,
  createTeamOrderSessionRuntime,
  finalizeUserStopped,
  openGameWsSession,
  refreshStatusSnapshot,
  reopenGameWsSessionWithRetry,
  main as runAutomationSession,
  waitWithOnlineHeartTick,
  summarizeAccountLevel,
  summarizeExperienceGuard,
  normalizeProfileSettings as normalizeProfileAutomationSettings,
  getWaterwheelAutomationSetting,
  getCyclicStoryAutoSubmitSetting,
  getCyclicStoryOnlyHighestExperienceSetting,
  getMaterialShopMidnightRefreshOptions,
  getCustomerOrderGenerationStatus,
  getCustomerOrderNpcPlan,
  refreshCustomerOrders,
  writeStatusDocuments,
  clearStatusDocumentContextCache,
  writeStatusArtifacts,
  GameWs,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    assertGameDataSyncStartAllowed({
      runtimeDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime"),
    });
    await main();
  })().catch((err) => {
    const classified = classifyAutomationError(err);
    console.error(JSON.stringify({
      step: "error",
      reason: classified.reason,
      category: classified.category,
      message: classified.message,
      rawMessage: classified.rawMessage,
      stack: err.stack?.split("\n").slice(0, 3),
    }, null, 2));
    process.exitCode = classified.exitCode;
  });
}
