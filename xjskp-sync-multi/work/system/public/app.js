import {
  getTeamOrderProtectionView,
} from "./profile-settings-state.js";
import { createProfileSettingsClient } from "./profile-settings-client.js";
import {
  TEAM_ORDER_VISIBLE_DAY_COUNT,
  computeTeamOrderGuardExp,
  formatTeamOrderGuardMultiplier,
  getRecentCompletedTeamOrderGroups,
  getRecentTeamOrderCutoffMs,
  parseTeamOrderGuardMultiplierInput,
} from "./team-order-view.js";
import {
  buildExperienceGuardView,
  formatExperienceGuardThresholdPercent,
  parseExperienceGuardThresholdPercentInput,
} from "./experience-guard-view.js";
import { createKeyedCollectionsRenderer } from "./keyed-collections-view.js";
import { buildCyclicStoryView, formatPhaseRemaining } from "./cyclic-story-view.js";
import { createQueueDashboardRenderer } from "./queue-dashboard-view.js";
import { buildSpecialOrderCategoryView } from "./special-order-view.js";
import { createQueueCollectionsRenderer } from "./queue-collections-view.js";
import { createTeamOrderArchiveRenderer } from "./team-order-archive-view.js";
import { createUpperDashboardRenderer } from "./upper-dashboard-view.js";
import {
  formatAllowedHostsInput,
  parseAllowedHostsInput,
} from "./allowed-hosts-view.js";
import {
  buildGameVersionView,
  formatGameDataSyncFailure,
  formatGameDataSyncSuccess,
} from "./game-version-view.js";

const QUEUE_MODULE_GROUPS = {
  common: [
    { label: "水车水滴", aliases: ["水车水桶"] },
    { label: "挑水工水滴" },
    { label: "普通居民订单" },
    { label: "丝绸建材", aliases: ["丝绸/建材"] },
    { label: "经验保护" },
    { label: "土地补种" },
    { label: "主线任务" },
    { label: "顾客订单" },
  ],
  secondary: [
    { label: "宫廷订单" },
    { label: "公会土地" },
    { label: "花架金币" },
    { label: "珍珠采集" },
    { label: "材料商城" },
  ],
  activities: [
    { area: "莳花纪闻" },
  ],
};

const QUEUE_TAB_KEYS = new Set(["common", "secondary", "activities", "cyclic-note", "team-orders"]);

const MATERIAL_SHOP_REFRESH_MAX_COST_OPTIONS = [0, 1, 2, 4, 8, 12, 16];
const GAME_VERSION_COPY = {
  unknown: "尚未检查官方版本",
  same: "当前运行版本已是官方最新版本",
  newer: "发现官方新版本",
  older: "当前运行版本高于官方返回版本",
  different: "当前运行版本与官方版本不同",
};

function getMaterialShopRefreshMaxSpend(maxCostYuanbao) {
  return [1, 2, 4, 8, 12, 16]
    .filter((cost) => cost <= maxCostYuanbao)
    .reduce((total, cost) => total + cost, 0);
}

function normalizeCustomerOrderRewardReleaseMask(value) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 7
    ? value
    : 4;
}

const state = {
  selectedProfileId: null,
  queueTab: "common",
  profiles: [],
  runtime: null,
  runtimeTransport: {
    state: "unknown",
    lastSuccessAt: null,
    lastError: null,
    recoveredAt: null,
  },
  migration: null,
  status: null,
  statusEtag: null,
  statusReadMeta: null,
  experienceGuardControl: null,
  experienceGuardControlLoadError: null,
  gardenData: null,
  orderData: null,
  logs: [],
  teamOrders: {
    items: [],
    page: 1,
    pageSize: 50,
    total: 0,
  },
  teamOrderLoading: false,
  teamOrderLoadedProfileId: null,
  teamOrderLoadingProfileId: null,
  teamOrderLoadError: null,
  statusLoadError: null,
  validationError: null,
  pendingAction: null,
  gameVersion: null,
  versionCheckPending: false,
  gameDataSyncPending: false,
  gameDataSyncFeedback: null,
};

const $ = (id) => document.getElementById(id);
const upperDashboard = createUpperDashboardRenderer($);
const keyedCollections = createKeyedCollectionsRenderer($, {
  onProfileSelect: selectProfileFromCard,
});
const queueDashboard = createQueueDashboardRenderer($, {
  materialShopCostOptions: MATERIAL_SHOP_REFRESH_MAX_COST_OPTIONS,
  onExperienceGuardRearm: () => {
    guarded(rearmCurrentExperienceGuard).catch(() => {});
  },
});
const queueCollections = createQueueCollectionsRenderer($);
const teamOrderArchive = createTeamOrderArchiveRenderer($);

const START_CONFIRM_POLL_ATTEMPTS = 8;
const START_CONFIRM_POLL_INTERVAL_MS = 500;
const ORDINARY_RESIDENT_ORDER_SLOT_COUNT = 6;
const TEAM_ORDER_FETCH_PAGE_SIZE = 50;
const FULL_READ_TRIGGER_LABELS = Object.freeze({
  "first-open": "首次打开",
  "manual-refresh": "手动刷新",
  "account-switch": "切换账号",
  "first-complete": "首次完整落盘",
  "browser-reconnect": "连接恢复",
});
let refreshInFlight = null;
let refreshGeneration = 0;
let gameVersionStateGeneration = 0;
let localSessionToken = null;
let lastQueueProfileId = null;
const experienceGuardRearmFlights = new Set();
const queueControlDrafts = new Map();
const QUEUE_VALUE_CONTROL_IDS = new Set([
  "experienceGuardThresholdInput",
  "flowerRackTargetSelect",
  "pearlHireItemReserveInput",
  "materialShopRefreshWindowStartInput",
  "materialShopRefreshMaxCostSelect",
  "teamOrderGuardMultiplierInput",
]);
const PROFILE_SETTINGS_CONTROL_IDS = Object.freeze({
  autoReceiveWaterwheelBuckets: "waterwheelBucketReceiveToggle",
  skipWaterwheelVideoBuckets: "waterwheelVideoBucketSkipToggle",
  experienceGuardThresholdPercent: "experienceGuardThresholdInput",
  autoSubmitOrdinaryResidentOrdersForLevelUp: "ordinaryAutoSubmitToggle",
  autoSubmitCyclicStoryOrders: "cyclicStoryAutoSubmitToggle",
  cyclicStoryOnlyHighestExperienceOrder: "cyclicStoryOnlyHighestExperienceToggle",
  autoHandleCyclicNote: "cyclicNoteAutomationToggle",
  autoCompleteCyclicNoteHighestRewardTask: "cyclicNoteNaturalCompletionToggle",
  customerOrderFlowerCurrencyRewardReleaseMask: "customerOrderReward1Toggle",
  teamOrderTriggerProtectionEnabled: "teamOrderProtectionToggle",
  teamOrderPaidRenewProtectionEnabled: "teamOrderPaidRenewProtectionToggle",
  flowerRackTargetArtId: "flowerRackTargetSelect",
  pearlHireItemReserveCount: "pearlHireItemReserveInput",
  materialShopMidnightRefreshEnabled: "materialShopMidnightRefreshToggle",
  materialShopRefreshWindowStart: "materialShopRefreshWindowStartInput",
  materialShopRefreshMaxCostYuanbao: "materialShopRefreshMaxCostSelect",
  teamOrderGuardMultiplier: "teamOrderGuardMultiplierInput",
});
const profileSettingsClient = createProfileSettingsClient({
  sendMutation: sendProfileSettingsMutation,
  sendReconcile: sendProfileSettingsReconcile,
  refreshSession: () => getLocalSessionToken(true),
  onChange: handleProfileSettingsChange,
  onNotice: handleProfileSettingsNotice,
});

on("refreshButton", "click", () => guardedRefreshAll({ fullReadReason: "manual-refresh" }));
on("remoteAccessButton", "click", toggleRemoteAccessPanel);
on("saveAllowedHostsButton", "click", () => guarded(saveAllowedHosts));
on("reloadProfilesButton", "click", () => guardedRefreshAll({ fullReadReason: "manual-refresh" }));
on("openImportButton", "click", () => $("importDialog").showModal());
on("closeImportButton", "click", () => $("importDialog").close());
on("importButton", "click", () => guarded(importProfile));
on("migrateLegacyButton", "click", () => guarded(migrateLegacyCredentials));
on("validateProfileButton", "click", () => guarded(validateProfile));
on("resetCredentialsButton", "click", () => guarded(resetCredentials));
on("startButton", "click", () => guarded(() => runProfileAction("start")));
on("stopButton", "click", () => guarded(() => runProfileAction("stop")));
on("onceButton", "click", () => guarded(() => runProfileAction("once")));
on("ordersButton", "click", () => guarded(() => runProfileAction("orders")));
on("checkGameVersionButton", "click", () => guarded(checkGameVersion));
on("syncGameDataButton", "click", () => guarded(syncGameData));
on("closeSystemButton", "click", () => guarded(closeSystem));
on("stopLegacyButton", "click", () => guarded(stopLegacy));
on("takeoverButton", "click", () => guarded(takeoverLegacy));
on("settingsReconcileButton", "click", () => guarded(reconcileCurrentProfileSettings));
on("settingsAdoptCurrentButton", "click", () => guarded(() => resolveCurrentSettingsConflict("adopt-current")));
on("settingsReapplyButton", "click", () => guarded(() => resolveCurrentSettingsConflict("reapply")));

document.querySelectorAll("[data-queue-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    const nextTab = QUEUE_TAB_KEYS.has(button.dataset.queueTab) ? button.dataset.queueTab : "common";
    if (state.queueTab === nextTab) return;
    state.queueTab = nextTab;
    renderQueue();
    if (nextTab === "team-orders") {
      renderTeamOrders();
      guarded(loadCurrentProfileTeamOrders, { silent: true }).catch(() => {});
    }
  });
});

document.addEventListener("input", (event) => {
  const controlId = event.target?.id;
  if (!QUEUE_VALUE_CONTROL_IDS.has(controlId)) return;
  queueControlDrafts.set(controlId, {
    profileId: currentProfile()?.id || null,
  });
});

document.addEventListener("change", (event) => {
  if (event.target?.id === "experienceGuardThresholdInput") {
    queueControlDrafts.delete(event.target.id);
    const profile = currentProfile();
    const experienceGuardThresholdPercent = parseExperienceGuardThresholdPercentInput(
      event.target.value,
    );
    if (!profile) {
      showToast("请先选择账号。");
      renderQueue({ forceControlIds: [event.target.id] });
      return;
    }
    if (experienceGuardThresholdPercent === null) {
      event.target.value = formatExperienceGuardThresholdPercent(
        profile.settings?.experienceGuardThresholdPercent,
      );
      showToast("经验保护百分比不能小于 0，且最多保留两位小数。");
      renderQueue({ forceControlIds: [event.target.id] });
      return;
    }
    event.target.value = formatExperienceGuardThresholdPercent(
      experienceGuardThresholdPercent,
    );
    guarded(() => updateProfileSettings(
      { experienceGuardThresholdPercent },
      { successMessage: `经验保护百分比已更新为 ${formatExperienceGuardThresholdPercent(experienceGuardThresholdPercent)}%。` },
    ));
    return;
  }
  if (event.target?.id === "teamOrderGuardMultiplierInput") {
    queueControlDrafts.delete(event.target.id);
    const profile = currentProfile();
    const teamOrderGuardMultiplier = parseTeamOrderGuardMultiplierInput(
      event.target.value,
    );
    if (!profile) {
      showToast("请先选择账号。");
      renderQueue({ forceControlIds: [event.target.id] });
      return;
    }
    if (teamOrderGuardMultiplier === null) {
      event.target.value = formatTeamOrderGuardMultiplier(
        profile.settings?.teamOrderGuardMultiplier,
      );
      showToast("团队订单守卫倍数必须在 0～10 之间，且最多保留两位小数。");
      renderQueue({ forceControlIds: [event.target.id] });
      return;
    }
    event.target.value = formatTeamOrderGuardMultiplier(
      teamOrderGuardMultiplier,
    );
    guarded(() => updateProfileSettings(
      { teamOrderGuardMultiplier },
      { successMessage: `团队订单守卫倍数已更新为 ${formatTeamOrderGuardMultiplier(teamOrderGuardMultiplier)}。` },
    ));
    return;
  }
  if (event.target?.id === "waterwheelBucketReceiveToggle") {
    guarded(() => updateProfileSettings(
      { autoReceiveWaterwheelBuckets: event.target.checked },
      {
        successMessage: event.target.checked
          ? "领取水车水桶已开启，下一轮自动化循环生效。"
          : "领取水车水桶已关闭，水车状态仍会继续刷新。",
      },
    ));
    return;
  }
  if (event.target?.id === "waterwheelVideoBucketSkipToggle") {
    guarded(() => updateProfileSettings(
      { skipWaterwheelVideoBuckets: event.target.checked },
      {
        successMessage: event.target.checked
          ? "跳过视频桶已开启，下一轮可免看视频领取当前桶基础水滴。"
          : "跳过视频桶已关闭，遇到视频桶时将保留不领取。",
      },
    ));
    return;
  }
  if (event.target?.id === "materialShopMidnightRefreshToggle") {
    const materialShopMidnightRefreshEnabled = event.target.checked;
    const maxCostYuanbao = currentProfile()?.settings?.materialShopRefreshMaxCostYuanbao ?? 4;
    const maxSpendYuanbao = getMaterialShopRefreshMaxSpend(maxCostYuanbao);
    const confirmationMessage = `开启材料商城午夜前主动刷新？每天先用免费次数，再执行单次价格不超过 ${maxCostYuanbao} 元宝的刷新（包含所选值）；当前公式下最多累计消费 ${maxSpendYuanbao} 元宝。`;
    if (
      materialShopMidnightRefreshEnabled
      && !confirm(confirmationMessage)
    ) {
      event.target.checked = false;
      return;
    }
    guarded(() => updateProfileSettings(
      { materialShopMidnightRefreshEnabled },
      {
        successMessage: materialShopMidnightRefreshEnabled
          ? "材料商城午夜前主动刷新已开启，下一轮在指定窗口生效。"
          : "材料商城午夜前主动刷新已关闭。",
        reconfirm: materialShopMidnightRefreshEnabled
          ? () => confirm(confirmationMessage)
          : () => true,
      },
    ));
    return;
  }
  if (event.target?.id === "materialShopRefreshWindowStartInput") {
    queueControlDrafts.delete(event.target.id);
    const materialShopRefreshWindowStart = event.target.value;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(materialShopRefreshWindowStart)) {
      showToast("材料商城刷新开始时间必须是 HH:MM。");
      renderQueue({ forceControlIds: [event.target.id] });
      return;
    }
    guarded(() => updateProfileSettings(
      { materialShopRefreshWindowStart },
      { successMessage: `材料商城刷新窗口已更新为 ${materialShopRefreshWindowStart}–24:00。` },
    ));
    return;
  }
  if (event.target?.id === "materialShopRefreshMaxCostSelect") {
    queueControlDrafts.delete(event.target.id);
    const materialShopRefreshMaxCostYuanbao = Number(event.target.value);
    if (!MATERIAL_SHOP_REFRESH_MAX_COST_OPTIONS.includes(materialShopRefreshMaxCostYuanbao)) {
      showToast("元宝刷新上限不合法。");
      renderQueue({ forceControlIds: [event.target.id] });
      return;
    }
    const previous = currentProfile()?.settings?.materialShopRefreshMaxCostYuanbao ?? 4;
    const maxSpendYuanbao = getMaterialShopRefreshMaxSpend(materialShopRefreshMaxCostYuanbao);
    const confirmationMessage = `提高元宝刷新上限？单次价格等于 ${materialShopRefreshMaxCostYuanbao} 元宝时也会执行；当前公式下最多累计消费 ${maxSpendYuanbao} 元宝。`;
    if (
      materialShopRefreshMaxCostYuanbao > previous
      && !confirm(confirmationMessage)
    ) {
      renderQueue({ forceControlIds: [event.target.id] });
      return;
    }
    guarded(() => updateProfileSettings(
      { materialShopRefreshMaxCostYuanbao },
      {
        successMessage: `材料商城元宝刷新上限已更新为单次 ≤ ${materialShopRefreshMaxCostYuanbao}，包含所选值；最多累计 ${maxSpendYuanbao} 元宝。`,
        reconfirm: materialShopRefreshMaxCostYuanbao > previous
          ? () => confirm(confirmationMessage)
          : () => true,
      },
    ));
    return;
  }
  if (event.target?.id === "teamOrderProtectionToggle") {
    const teamOrderTriggerReleaseEnabled = event.target.checked;
    const teamOrderTriggerProtectionEnabled = !teamOrderTriggerReleaseEnabled;
    const confirmationMessage = "开启 49/99 组团触发放行？只有双倍金币剩余超过3分钟时才会跨过 49/99 并触发免费组团；否则仍强制保护。是否付费续开由右侧的元宝续次数放行独立控制。";
    if (
      teamOrderTriggerReleaseEnabled
      && !confirm(confirmationMessage)
    ) {
      event.target.checked = false;
      return;
    }
    guarded(() => updateProfileSettings(
      { teamOrderTriggerProtectionEnabled },
      {
        successMessage: teamOrderTriggerReleaseEnabled
          ? "49/99 组团触发放行已开启；双倍金币超过3分钟门禁仍强制生效。"
          : "49/99 组团触发放行已关闭，下一次提交决策生效。",
        reconfirm: teamOrderTriggerReleaseEnabled
          ? () => confirm(confirmationMessage)
          : () => true,
      },
    ));
    return;
  }
  if (event.target?.id === "teamOrderPaidRenewProtectionToggle") {
    const teamOrderPaidRenewReleaseEnabled = event.target.checked;
    const teamOrderPaidRenewProtectionEnabled = !teamOrderPaidRenewReleaseEnabled;
    const confirmationMessage = "开启元宝续次数放行？这是按自然触发持续生效的付费授权；当前每次最多消费 60 元宝续开 1 次。每天可能在第 50/100 单触发两次，若都有续开机会，当日最多可能消费 120 元宝。";
    if (
      teamOrderPaidRenewReleaseEnabled
      && !confirm(confirmationMessage)
    ) {
      event.target.checked = false;
      return;
    }
    guarded(() => updateProfileSettings(
      { teamOrderPaidRenewProtectionEnabled },
      {
        successMessage: teamOrderPaidRenewReleaseEnabled
          ? "元宝续次数放行已开启；下一次符合条件的自然触发将最多消费 60 元宝续开 1 次。"
          : "元宝续次数放行已关闭，不会自动消费元宝续次数。",
        reconfirm: teamOrderPaidRenewReleaseEnabled
          ? () => confirm(confirmationMessage)
          : () => true,
      },
    ));
    return;
  }
  if (event.target?.id === "ordinaryAutoSubmitToggle") {
    guarded(() => updateProfileSettings({ autoSubmitOrdinaryResidentOrdersForLevelUp: event.target.checked }));
    return;
  }
  const customerRewardMatch = /^customerOrderReward([123])Toggle$/.exec(event.target?.id || "");
  if (customerRewardMatch) {
    const profile = currentProfile();
    if (!profile) {
      showToast("请先选择账号。");
      renderQueue({ forceControlIds: [event.target.id] });
      return;
    }
    const effectiveSettings = profileSettingsClient.getEffectiveSettings(profile.id)
      || profile.settings
      || {};
    const currentMask = normalizeCustomerOrderRewardReleaseMask(
      effectiveSettings.customerOrderFlowerCurrencyRewardReleaseMask,
    );
    const reward = Number(customerRewardMatch[1]);
    const bit = 1 << (reward - 1);
    const nextMask = event.target.checked ? currentMask | bit : currentMask & ~bit;
    guarded(() => updateProfileSettings(
      { customerOrderFlowerCurrencyRewardReleaseMask: nextMask },
      { successMessage: "顾客订单花坊币收益放行列表已更新，下一轮自动化循环生效。" },
    ));
    return;
  }
  if (event.target?.id === "cyclicStoryAutoSubmitToggle") {
    guarded(() => updateProfileSettings(
      { autoSubmitCyclicStoryOrders: event.target.checked },
      {
        successMessage: event.target.checked
          ? "自动提交莳花纪闻订单已开启。"
          : "自动提交莳花纪闻订单已关闭。",
      },
    ));
    return;
  }
  if (event.target?.id === "cyclicStoryOnlyHighestExperienceToggle") {
    guarded(() => updateProfileSettings(
      { cyclicStoryOnlyHighestExperienceOrder: event.target.checked },
      {
        successMessage: event.target.checked
          ? "莳花纪闻已切换为只做最高经验订单；任一当前订单冷却时整轮等待，最高经验单缺库存也不会降级。"
          : "莳花纪闻最高经验订单模式已关闭，恢复按当前订单顺序最多提交三单。",
      },
    ));
    return;
  }
  if (event.target?.id === "cyclicNoteAutomationToggle") {
    guarded(() => updateProfileSettings(
      { autoHandleCyclicNote: event.target.checked },
      {
        successMessage: event.target.checked
          ? "自动进行花笺集芳任务已开启；将按当前子策略推进或领取任务。"
          : "自动进行花笺集芳任务已关闭；仅展示活动与任务进度。",
      },
    ));
    return;
  }
  if (event.target?.id === "cyclicNoteNaturalCompletionToggle") {
    guarded(() => updateProfileSettings(
      { autoCompleteCyclicNoteHighestRewardTask: event.target.checked },
      {
        successMessage: event.target.checked
          ? "花笺集芳已切换为只做最高集芳笺任务：仅真实行为推进，绝不使用元宝立即完成。"
          : "花笺集芳已切换为处理全部可执行未完成任务；仍只使用真实行为推进。",
      },
    ));
    return;
  }
  if (event.target?.id === "flowerRackTargetSelect") {
    queueControlDrafts.delete(event.target.id);
    const flowerRackTargetArtId = event.target.value ? Number(event.target.value) : null;
    guarded(() => updateProfileSettings(
      { flowerRackTargetArtId },
      { successMessage: "花架上架花艺已更新。" },
    ));
    return;
  }
  if (event.target?.id === "pearlHireItemReserveInput") {
    queueControlDrafts.delete(event.target.id);
    const reserveText = event.target.value.trim();
    const pearlHireItemReserveCount = Number(reserveText);
    if (!reserveText || !Number.isSafeInteger(pearlHireItemReserveCount) || pearlHireItemReserveCount < 0) {
      showToast("珍珠雇佣卡保留量必须是非负整数。");
      renderQueue({ forceControlIds: [event.target.id] });
      return;
    }
    guarded(() => updateProfileSettings(
      { pearlHireItemReserveCount },
      { successMessage: "珍珠雇佣卡保留量已更新。" },
    ));
  }
});

await initializeProfileSettingsProtocol();
await guardedRefreshAll({ fullReadReason: "first-open" });
guarded(loadSystemSettings, { silent: true }).catch(() => {});
setInterval(() => guardedRefreshLive({ silent: true }).catch(() => {}), 5000);

function toggleRemoteAccessPanel() {
  const panel = $("remoteAccessPanel");
  const willOpen = panel.hidden;
  panel.hidden = !willOpen;
  $("remoteAccessButton").classList.toggle("active", willOpen);
  if (willOpen) guarded(loadSystemSettings, { silent: true }).catch(() => {});
}

async function loadSystemSettings() {
  const settings = await api("/api/system/settings");
  $("allowedHostsInput").value = formatAllowedHostsInput(settings.allowedHosts);
}

async function saveAllowedHosts() {
  const allowedHosts = parseAllowedHostsInput($("allowedHostsInput").value);
  const settings = await api("/api/system/settings", {
    method: "POST",
    body: { allowedHosts },
  });
  $("allowedHostsInput").value = formatAllowedHostsInput(settings.allowedHosts);
  showToast(allowedHosts.length > 0
    ? `远程访问白名单已保存：${allowedHosts.join("、")}。`
    : "已清空远程访问白名单，仅本机可访问。");
}

function guardedRefreshAll(options = {}) {
  if (refreshInFlight) return refreshInFlight;
  const { silent = false, ...refreshOptions } = options;
  refreshInFlight = guarded(() => refreshAll(refreshOptions), { silent })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

function guardedRefreshLive(options = {}) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = guarded(refreshLive, options)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

async function refreshAll(options = {}) {
  const generation = beginRefreshGeneration();
  const gameVersionGeneration = gameVersionStateGeneration;
  const fullReadReason = options.fullReadReason || null;
  const previousTransportState = state.runtimeTransport?.state;
  const [runtime, profilesData, migration, gameVersionResult] = await Promise.all([
    api("/api/runtime"),
    api("/api/profiles"),
    api("/api/migration/legacy-credentials"),
    api("/api/system/game-version").then(
      (value) => ({ ok: true, value }),
      () => ({ ok: false }),
    ),
  ]);
  const profiles = sortProfiles(profileSettingsClient.applyProfilesResponse(profilesData));
  const selectedProfileId = chooseProfileId(profiles, state.selectedProfileId);
  const selectedProfileChanged = selectedProfileId !== state.selectedProfileId;
  const profileStatus = selectedProfileId
    ? fullReadReason
      ? await fetchProfileStatus(selectedProfileId, {
          full: true,
          trigger: fullReadReason,
          generation,
        })
      : selectedProfileChanged
        ? emptySelectedProfileView()
        : null
    : emptySelectedProfileView();
  const gameVersion = gameVersionResult.ok
    ? gameVersionResult.value
    : {
        ...(state.gameVersion || {}),
        checking: false,
        lastError: {
          code: "VERSION_STATUS_UNAVAILABLE",
          message: "游戏版本状态暂时无法读取",
        },
      };
  const snapshot = {
    runtime,
    runtimeTransport: {
      state: "healthy",
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      recoveredAt: previousTransportState === "offline"
        ? new Date().toISOString()
        : state.runtimeTransport?.recoveredAt || null,
    },
    profiles,
    selectedProfileId,
    migration,
    gameVersion,
    ...(selectedProfileChanged && !profileStatus ? emptySelectedProfileView() : {}),
    ...(profileStatus || {}),
  };
  if (!isCurrentRefreshGeneration(generation)) return false;
  if (gameVersionGeneration !== gameVersionStateGeneration) {
    snapshot.gameVersion = state.gameVersion;
  }
  Object.assign(state, snapshot);
  renderAll();
  if (state.queueTab === "team-orders") {
    guarded(loadCurrentProfileTeamOrders, { silent: true }).catch(() => {});
  }
  profileSettingsClient.pumpDue(profiles.map((profile) => profile.id)).catch(() => {});
  return true;
}

async function refreshLive() {
  const generation = beginRefreshGeneration();
  const profileId = state.selectedProfileId;
  const wasOffline = state.runtimeTransport?.state === "offline";
  let runtime;
  try {
    runtime = await api("/api/runtime");
  } catch (error) {
    if (!isCurrentRefreshGeneration(generation)) return false;
    state.runtimeTransport = {
      state: "offline",
      lastSuccessAt: state.runtimeTransport?.lastSuccessAt || null,
      lastError: errorMessage(error),
      recoveredAt: state.runtimeTransport?.recoveredAt || null,
    };
    renderAll();
    return false;
  }
  if (!isCurrentRefreshGeneration(generation) || state.selectedProfileId !== profileId) return false;
  state.runtime = runtime;
  state.runtimeTransport = {
    state: wasOffline ? "recovering" : "healthy",
    lastSuccessAt: new Date().toISOString(),
    lastError: null,
    recoveredAt: wasOffline ? new Date().toISOString() : state.runtimeTransport?.recoveredAt || null,
  };
  renderAll();
  if (wasOffline && profileId) {
    const loaded = await loadProfileStatus(profileId, {
      generation,
      trigger: "browser-reconnect",
    });
    if (!loaded) return false;
    if (isCurrentRefreshGeneration(generation)) {
      state.runtimeTransport = {
        ...state.runtimeTransport,
        state: "healthy",
      };
      renderAll();
    }
  }
  return true;
}

async function loadProfileStatus(profileId, options = {}) {
  const generation = options.generation ?? beginRefreshGeneration();
  const profileStatus = await fetchProfileStatus(profileId, {
    full: true,
    trigger: options.trigger || "account-switch",
    generation,
    loadExperienceGuard: options.loadExperienceGuard,
  });
  if (!isCurrentRefreshGeneration(generation) || state.selectedProfileId !== profileId) return false;
  Object.assign(state, profileStatus);
  if (state.queueTab === "team-orders") {
    guarded(loadCurrentProfileTeamOrders, { silent: true }).catch(() => {});
  }
  return true;
}

async function fetchProfileStatus(profileId, options = {}) {
  const encodedProfileId = encodeURIComponent(profileId);
  const query = new URLSearchParams();
  if (options.full) {
    query.set("full", "1");
    query.set("trigger", options.trigger || "unknown");
    query.set("generation", String(options.generation ?? ""));
  }
  const statusPath = `/api/profiles/${encodedProfileId}/status${query.toString() ? `?${query}` : ""}`;
  let statusResponse;
  try {
    statusResponse = await api(statusPath, {
      headers: !options.full && options.etag ? { "if-none-match": options.etag } : {},
      allowNotModified: true,
      withResponseMetadata: true,
    });
  } catch (error) {
    return {
      notModified: false,
      statusEtag: options.etag || null,
      statusReadMeta: options.full
        ? {
            full: true,
            trigger: options.trigger || "unknown",
            generation: String(options.generation ?? ""),
            source: "local-runtime-artifacts",
            status: "failed",
          }
        : state.statusReadMeta,
      status: null,
      gardenData: null,
      orderData: null,
      logs: [],
      statusLoadError: errorMessage(error),
      experienceGuardControl: null,
      experienceGuardControlLoadError: null,
    };
  }
  if (statusResponse.notModified) {
    return {
      notModified: true,
      statusEtag: statusResponse.etag || options.etag || null,
      statusReadMeta: state.statusReadMeta,
    };
  }
  const status = statusResponse.data || {};
  const shouldLoadExperienceGuardControl = options.loadExperienceGuard !== false;
  const experienceGuardResult = shouldLoadExperienceGuardControl
    ? await api(`/api/profiles/${encodedProfileId}/experience-guard`).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      )
    : null;
  return {
    notModified: false,
    status: status.summary || null,
    statusEtag: statusResponse.etag || null,
    statusReadMeta: status.readMeta || (options.full
      ? {
          full: true,
          trigger: options.trigger || "unknown",
          generation: String(options.generation ?? ""),
          source: "local-runtime-artifacts",
          status: "success",
        }
      : state.statusReadMeta),
    gardenData: status.projection?.garden || null,
    orderData: status.projection?.order || null,
    logs: Array.isArray(status.logs) ? status.logs : [],
    statusLoadError: null,
    experienceGuardControl: experienceGuardResult?.ok
      ? experienceGuardResult.value
      : null,
    experienceGuardControlLoadError: experienceGuardResult && !experienceGuardResult.ok
      ? errorMessage(experienceGuardResult.error)
      : null,
  };
}

async function fetchRecentTeamOrders(encodedProfileId, now = new Date()) {
  const cutoffMs = getRecentTeamOrderCutoffMs(now);
  const items = [];
  let total = 0;
  let summary = emptyTeamOrderSummary();

  for (let page = 1; ; page += 1) {
    const result = await api(
      `/api/profiles/${encodedProfileId}/team-orders?page=${page}&pageSize=${TEAM_ORDER_FETCH_PAGE_SIZE}`,
    );
    const pageItems = Array.isArray(result.items) ? result.items : [];
    if (page === 1) {
      total = Math.max(0, Number(result.total) || 0);
      summary = result.summary || summary;
    }
    items.push(...pageItems);

    const reachedCutoff = pageItems.some((item) => {
      const finishedAtMs = Date.parse(item?.finishedAt);
      return Number.isFinite(finishedAtMs) && finishedAtMs < cutoffMs;
    });
    const reachedEnd = items.length >= total || pageItems.length < TEAM_ORDER_FETCH_PAGE_SIZE;
    if (reachedCutoff || reachedEnd) break;
  }

  return {
    items,
    page: 1,
    pageSize: TEAM_ORDER_FETCH_PAGE_SIZE,
    total,
    summary,
  };
}

async function loadCurrentProfileTeamOrders() {
  const profileId = state.selectedProfileId;
  if (!profileId) return false;
  if (state.teamOrderLoadedProfileId === profileId) return true;
  if (state.teamOrderLoadingProfileId === profileId) return false;
  state.teamOrderLoading = true;
  state.teamOrderLoadingProfileId = profileId;
  state.teamOrderLoadError = null;
  renderTeamOrders();
  try {
    const teamOrders = await fetchRecentTeamOrders(encodeURIComponent(profileId));
    if (state.selectedProfileId !== profileId) return false;
    state.teamOrders = teamOrders;
    state.teamOrderLoadedProfileId = profileId;
    return true;
  } catch (error) {
    if (state.selectedProfileId === profileId) {
      state.teamOrderLoadError = errorMessage(error);
    }
    throw error;
  } finally {
    if (state.teamOrderLoadingProfileId === profileId) {
      state.teamOrderLoading = false;
      state.teamOrderLoadingProfileId = null;
      if (state.selectedProfileId === profileId) renderTeamOrders();
    }
  }
}

function beginRefreshGeneration() {
  refreshGeneration += 1;
  return refreshGeneration;
}

function isCurrentRefreshGeneration(generation) {
  return generation === refreshGeneration;
}

async function refreshAfterAction(options = {}) {
  try {
    if (options.fullReadReason) {
      return await guardedRefreshAll({ fullReadReason: options.fullReadReason });
    }
    if (options.refreshProfiles) {
      return await refreshAll({ fullReadReason: null });
    }
    return await refreshLive();
  } catch (err) {
    console.warn("操作已提交，但状态刷新失败", err);
    return false;
  }
}

async function importProfile() {
  const credentials = {
    PC_USER_ID: $("manualPcUserId").value.trim(),
    OPEN_ID: $("manualOpenId").value.trim(),
    CTOKEN: $("manualCtoken").value.trim(),
    PC_TOKEN: $("manualPcToken").value.trim(),
    BABI_TOKEN: $("manualBabiToken").value.trim(),
  };
  for (const [key, value] of Object.entries(credentials)) {
    if (!value) delete credentials[key];
  }
  const data = await api("/api/profiles/import", {
    method: "POST",
    body: {
      label: $("profileLabel").value.trim(),
      credentialText: $("credentialText").value,
      credentials,
    },
  });
  state.selectedProfileId = data.profile.id;
  state.validationError = null;
  $("importDialog").close();
  clearImportForm();
  await refreshAfterAction({ refreshProfiles: true });
  showToast("账号已导入，凭据完整后可先验证账号。");
}

async function migrateLegacyCredentials() {
  const data = await api("/api/migration/legacy-credentials", { method: "POST", body: {} });
  state.selectedProfileId = data.profile.id;
  state.validationError = null;
  await refreshAfterAction({ refreshProfiles: true });
  showToast("迁移完成，旧账号已写入绿色包账号档案。");
}

async function validateProfile() {
  const profile = currentProfile();
  if (!profile?.hasCredentials) {
    showToast("请先迁移或导入完整凭据。");
    return;
  }
  const actionProfileId = profile.id;
  setPendingAction("validate", actionProfileId);
  try {
    const data = await api(`/api/profiles/${encodeURIComponent(profile.id)}/validate`, {
      method: "POST",
      body: {},
    });
    state.selectedProfileId = data.profile.id;
    state.validationError = null;
    const refreshOk = await refreshAfterAction();
    showToast(refreshOk ? "验证账号通过，已更新最近验证时间。" : "验证账号已提交成功，状态刷新失败，请稍后刷新。");
  } catch (err) {
    state.validationError = formatValidationErrorMessage(err);
    await refreshAfterAction();
    renderWizard();
    showToast(state.validationError);
  } finally {
    clearPendingAction("validate", actionProfileId);
  }
}

async function resetCredentials() {
  const profile = currentProfile();
  if (!profile) {
    showToast("请先选择账号。");
    return;
  }
  if (!confirm(`请先停止 ${profile.label} 并等待状态收敛。确认重置凭据？账号卡和设置会保留，启动前需要重新导入。`)) return;
  await api(`/api/profiles/${encodeURIComponent(profile.id)}/reset`, { method: "POST", body: {} });
  state.validationError = null;
  await refreshAfterAction({ refreshProfiles: true });
  showToast("凭据已重置。");
}

async function runProfileAction(action) {
  const profile = currentProfile();
  if (!profile?.hasCredentials) {
    showToast("请先迁移或导入完整凭据。");
    return;
  }
  const actionProfileId = profile.id;
  setPendingAction(action, actionProfileId);
  try {
    const result = await api(`/api/profiles/${encodeURIComponent(actionProfileId)}/${action}`, {
      method: "POST",
      body: {},
    });
    const refreshOk = await refreshAfterAction();
    if (action === "start") {
      const outcome = await waitForStartOutcome(actionProfileId, result);
      if (outcome.state === "running" && state.selectedProfileId === actionProfileId) {
        const loaded = await loadProfileStatus(actionProfileId, { trigger: "first-complete" });
        if (loaded) renderAll();
      }
      showToast(getStartOutcomeMessage(outcome, result, actionProfileId, refreshOk));
      return;
    }
    showToast(refreshOk ? getActionResultMessage(action, result, actionProfileId) : "操作已提交，但状态刷新失败，请稍后刷新。");
  } catch (err) {
    await refreshAfterFailedAction();
    showToast(getActionErrorMessage(action, err, actionProfileId));
  } finally {
    clearPendingAction(action, actionProfileId);
  }
}

async function rearmCurrentExperienceGuard() {
  const profile = currentProfile();
  if (!profile) {
    showToast("请先选择账号。");
    return;
  }
  const actionProfileId = profile.id;
  const actionProfileLabel = profile.label || actionProfileId;
  if (experienceGuardRearmFlights.has(actionProfileId)) return;
  experienceGuardRearmFlights.add(actionProfileId);
  renderQueue();

  try {
    const encodedProfileId = encodeURIComponent(actionProfileId);
    const guardControl = await api(`/api/profiles/${encodedProfileId}/experience-guard`);
    if (state.selectedProfileId !== actionProfileId) {
      showToast(`已切换账号，未对 ${actionProfileLabel} 执行重新布防。`);
      return;
    }
    if (guardControl?.pendingRearm) {
      state.experienceGuardControl = guardControl;
      renderQueue();
      showToast("重新布防已提交，等待实时等级确认。");
      return;
    }
    if (guardControl?.pendingSettlementRecovery) {
      state.experienceGuardControl = guardControl;
      renderQueue();
      showToast(
        guardControl.pendingSettlementRecovery.recoveryMode === "legacy-unverified"
          ? "历史未决锁人工解除已提交；不会自动重试收益。"
          : "未决结算恢复已提交，等待新鲜土地权威核对；不会自动重试收获。",
      );
      return;
    }

    const guardState = guardControl?.state || null;
    if (!Number.isInteger(guardState?.stateRevision)) {
      throw new Error("经验保护状态缺少有效 revision，请刷新后重试。");
    }
    const settlementUncertain = guardState?.invalid === true
      && guardState?.invalidReason === "experience-guard-settlement-unresolved";
    if (settlementUncertain) {
      const pendingSettlement = guardControl?.pendingSettlement;
      if (!pendingSettlement?.requestId) {
        throw new Error("未决收益请求缺少可核对的账号状态，请刷新后重试。");
      }
      if (!isExperienceGuardSettlementRecoveryAvailable(pendingSettlement)) {
        if (!isExperienceGuardLegacyRecoveryAvailable(pendingSettlement)) {
          throw new Error("未决收益请求缺少可用的权威核对路径，保护锁保持不变。");
        }
        if (currentProfileRun()) {
          throw new Error("当前账号仍在运行，请先停止账号后再人工解除历史保护锁。");
        }
        const legacyConfirmed = confirm(
          `账号“${actionProfileLabel}”缺少未决请求的执行前快照，无法证明请求未发送。\n\n`
          + `请求：${pendingSettlement.iface || "未知接口"}，土地：${pendingSettlement.actionArgs?.landId ?? "未知"}\n`
          + "确认后仅人工解除当前保护锁，并记录远端可能已执行的风险；不会自动重试收获，也不会按时间或重启判定安全。\n"
          + "请确认账号已停止，且你接受该历史请求无法核实的风险。",
        );
        if (!legacyConfirmed || state.selectedProfileId !== actionProfileId) return;

        const legacyOperatorReason = "用户停止后遗留请求缺少执行前快照；人工接受远端可能已执行的不确定性，仅解除当前经验保护锁，不自动重试收益。";
        const result = await api(`/api/profiles/${encodedProfileId}/experience-guard/resolve-legacy-settlement`, {
          method: "POST",
          body: {
            confirm: true,
            legacyUnverified: true,
            expectedStateRevision: guardState.stateRevision,
            pendingRequestId: pendingSettlement.requestId,
            operatorReason: legacyOperatorReason,
          },
        });
        if (state.selectedProfileId === actionProfileId) {
          state.experienceGuardControl = {
            ...guardControl,
            state: result?.state || guardControl.state,
            pendingSettlement: null,
            pendingSettlementRecovery: null,
          };
          renderQueue();
        }
        const refreshOk = await refreshAfterAction({ refreshProfiles: true });
        showToast(refreshOk
          ? `账号“${actionProfileLabel}”历史保护锁已人工解除；不会自动重试收益。`
          : `账号“${actionProfileLabel}”历史保护锁已人工解除，但状态刷新失败，请稍后刷新。`);
        return result;
      }
      const confirmed = confirm(
        `确认核对账号“${actionProfileLabel}”的未决收益请求吗？\n\n`
        + `请求：${pendingSettlement.iface || "未知接口"}，土地：${pendingSettlement.actionArgs?.landId ?? "未知"}\n`
        + "系统只会使用新鲜 gs.usrLand.refresh 权威状态；土地仍保持执行前完全相同的成熟快照时，才判定为未发送/未结算。"
        + "不会自动重试收获，也不会仅按时间或重启解除保护。",
      );
      if (!confirmed || state.selectedProfileId !== actionProfileId) return;

      const result = await api(`/api/profiles/${encodedProfileId}/experience-guard/recover-settlement`, {
        method: "POST",
        body: {
          confirm: true,
          expectedStateRevision: guardState.stateRevision,
          pendingRequestId: pendingSettlement.requestId,
        },
      });
      if (state.selectedProfileId === actionProfileId) {
        state.experienceGuardControl = {
          ...guardControl,
          pendingSettlementRecovery: result?.request || { requestId: "pending" },
        };
        renderQueue();
      }
      const refreshOk = await refreshAfterAction({ refreshProfiles: true });
      showToast(refreshOk
        ? `账号“${actionProfileLabel}”未决结算恢复已提交，等待土地权威核对；不会自动重试收获。`
        : `账号“${actionProfileLabel}”未决结算恢复已提交，但状态刷新失败，请稍后刷新。`);
      return result;
    }
    if (!isExperienceGuardRearmRecoverable(guardState)) {
      throw new Error("当前经验保护状态不能通过重新布防恢复，请先查看异常原因。");
    }

    const level = guardState.lastAuthoritativeLevel ?? guardState.ceilingLevel ?? "未知";
    const confirmed = confirm(
      `确认重新布防账号“${actionProfileLabel}”吗？\n\n`
      + `系统将在下一次实时权威读取后，以当时等级（当前记录：${level}）作为新的等级上限。\n`
      + "停止或重启任务不会解除该锁；本操作不会自动启动或停止账号。",
    );
    if (!confirmed || state.selectedProfileId !== actionProfileId) return;

    const result = await api(`/api/profiles/${encodedProfileId}/experience-guard`, {
      method: "POST",
      body: {
        confirm: true,
        expectedStateRevision: guardState.stateRevision,
      },
    });
    if (state.selectedProfileId === actionProfileId) {
      state.experienceGuardControl = {
        profileId: actionProfileId,
        state: guardState,
        pendingRearm: result?.request || { requestId: "pending" },
      };
      renderQueue();
    }
    const refreshOk = await refreshAfterAction({ refreshProfiles: true });
    showToast(refreshOk
      ? `账号“${actionProfileLabel}”重新布防已提交，等待实时等级确认。`
      : `账号“${actionProfileLabel}”重新布防已提交，但状态刷新失败，请稍后刷新。`);
    return result;
  } catch (error) {
    if (error?.status === 409) {
      await refreshAfterFailedAction();
      throw new Error("经验保护状态已更新，请查看最新状态后重新确认；系统没有自动重试。");
    }
    throw error;
  } finally {
    experienceGuardRearmFlights.delete(actionProfileId);
    renderQueue();
  }
}

function isExperienceGuardRearmRecoverable(guardState) {
  if (!guardState) return false;
  if (guardState.invalid === true) {
    return false;
  }
  return guardState.breached === true;
}

function isExperienceGuardSettlementRecoveryAvailable(pendingSettlement) {
  if (!pendingSettlement?.requestId) return false;
  if (!["gs.usrLand.harvest", "gs.usrLand.harvestOneKey"].includes(String(pendingSettlement.iface || ""))) {
    return false;
  }
  return Boolean(pendingSettlement.actionEvidence?.land?.snapshot);
}

function isExperienceGuardLegacyRecoveryAvailable(pendingSettlement) {
  if (!pendingSettlement?.requestId) return false;
  const iface = String(pendingSettlement.iface || "");
  return ["gs.usrLand.harvest", "gs.usrLand.harvestOneKey"].includes(iface)
    || iface.startsWith("gs.orderFlower.finish")
    || iface === "gs.orderCustomer.finishOrder"
    || iface === "gs.orderPalace.finishOrder";
}

async function refreshAfterFailedAction() {
  const staleRefresh = refreshInFlight;
  if (staleRefresh) await staleRefresh.catch(() => {});
  await refreshLive().catch(() => {});
}

async function waitForStartOutcome(profileId, result = {}) {
  for (let attempt = 0; attempt < START_CONFIRM_POLL_ATTEMPTS; attempt++) {
    const run = getProfileRun(profileId);
    if (isRunReadyForFullRead(run)) return { state: "running", run };
    const lastExit = getProfileLastExit(profileId);
    if (lastExit?.startedAt === result?.startedAt) return { state: "exited", lastExit };
    if (attempt < START_CONFIRM_POLL_ATTEMPTS - 1) {
      await wait(START_CONFIRM_POLL_INTERVAL_MS);
    await refreshAfterAction({ refreshProfiles: true });
    }
  }
  return { state: "unknown" };
}

function isRunReadyForFullRead(run) {
  if (!run?.pid) return false;
  const garden = run.artifactCompletion?.garden;
  if (garden) return garden.complete === true;
  return run.startupState === "ready" || Boolean(run.readyAt);
}

function getStartOutcomeMessage(outcome, result, actionProfileId, refreshOk = true) {
  if (outcome?.state === "running") return "循环已启动。";
  if (outcome?.state === "exited") return getStartFailureMessage(outcome.lastExit || result);
  if (!refreshOk) return "启动已提交，但状态刷新失败，请稍后刷新。";
  return getActionResultMessage("start", result, actionProfileId);
}

function getStartFailureMessage(result = {}) {
  const reason = result.reason || result.lastExit?.reason;
  if (reason === "session-expired") return "启动失败：会话失效，请先验证账号。";
  if (reason === "experience-guard") return `启动失败：${result.message || result.lastExit?.message || "经验保护检测到异常经验，已停止后续收益动作。"}`;
  if (reason === "startup-not-ready") return result.message || "启动确认超时：任务可能仍在启动中，请稍后刷新。";
  return result.message || "启动失败：未检测到运行中的任务。";
}

function getActionResultMessage(action, result, actionProfileId) {
  if (action === "start") {
    const currentRunAfterAction = getProfileRun(actionProfileId);
    if (currentRunAfterAction?.pid) return "循环已启动。";
    const stopped = getProfileAutomationStopped(actionProfileId);
    const lastExit = getProfileLastExit(actionProfileId);
    const reason = stopped?.reason || lastExit?.reason || result?.reason;
    if (reason === "session-expired") return "启动失败：会话失效，请先验证账号。";
    if (reason === "experience-guard") return `启动失败：${lastExit?.message || stopped?.message || "经验保护检测到异常经验，已停止后续收益动作。"}`;
    return "启动失败：未检测到运行中的任务。";
  }
  if (action === "stop") return result.stopped ? "任务已停止。" : "当前没有可停止的任务。";
  if (action === "once") {
    if (Number(result?.exitCode ?? 0) !== 0) return formatRunActionFailure("一轮执行失败", result);
    return "一轮执行完成。";
  }
  if (action === "orders") {
    if (Number(result?.exitCode ?? 0) !== 0) return formatRunActionFailure("订单查询失败", result);
    return "订单查询完成。";
  }
  return "操作完成。";
}

function formatRunActionFailure(prefix, result = {}) {
  const reason = result.reason || result.lastExit?.reason;
  if (reason === "session-expired") return `${prefix}：会话失效，请先验证账号。`;
  if (reason === "experience-guard") return `${prefix}：经验保护检测到异常经验，已停止后续收益动作。`;
  return `${prefix}：${result.message || reason || `退出码 ${valueOrDash(result.exitCode)}`}`;
}

function getActionErrorMessage(action, err, actionProfileId) {
  const data = err?.data || {};
  const lastExit = data.lastExit || getProfileLastExit(actionProfileId);
  const reason = data.reason || lastExit?.reason;
  if (action === "start") {
    if (reason === "session-expired") return "启动失败：会话失效，请先验证账号。";
    if (reason === "experience-guard") return `启动失败：${lastExit?.message || data.message || "经验保护检测到异常经验，已停止后续收益动作。"}`;
    return data.message || err?.message || "启动失败。";
  }
  if (action === "once") return formatRunActionFailure("一轮执行失败", { ...data, message: data.message || err?.message, lastExit });
  if (action === "orders") return formatRunActionFailure("订单查询失败", { ...data, message: data.message || err?.message, lastExit });
  return data.message || err?.message || "操作失败。";
}

function formatValidationErrorMessage(err) {
  const data = err?.data || {};
  const reason = data.reason || data.lastExit?.reason;
  if (data.error === "SESSION_EXPIRED" || reason === "session-expired") {
    return "验证失败：会话已过期，请重新导入最新凭据。";
  }
  if (data.error === "MISSING_ACCOUNT_SERVER") {
    return data.message || "验证失败：未能确认账号区服，请重新导入最新凭据。";
  }
  return data.message || err?.message || "验证失败，请重新导入凭据。";
}

function setPendingAction(action, profileId) {
  beginRefreshGeneration();
  state.pendingAction = { action, profileId };
  renderWizard();
  renderTask();
}

function clearPendingAction(action, profileId) {
  if (state.pendingAction?.action !== action || state.pendingAction?.profileId !== profileId) return;
  state.pendingAction = null;
  renderWizard();
  renderTask();
}

async function updateProfileSettings(nextSettings, options = {}) {
  const profile = currentProfile();
  if (!profile) {
    showToast("请先选择账号。");
    return;
  }
  const profileId = profile.id;
  const changedControlIds = getControlIdsForSettings(nextSettings);
  try {
    profileSettingsClient.enqueue(profileId, nextSettings, {
      successMessage: options.successMessage,
      reconfirm: options.reconfirm,
    });
    renderQueue({ forceControlIds: changedControlIds });
  } catch (err) {
    if (state.selectedProfileId === profileId) {
      renderQueue({ forceControlIds: changedControlIds });
    }
    showToast(`设置暂不可修改：${err.message || "未知错误"}`);
  }
}

function handleProfileSettingsChange({ profileId, changedKeys = [] }) {
  const effectiveSettings = profileSettingsClient.getEffectiveSettings(profileId);
  if (effectiveSettings) {
    state.profiles = state.profiles.map((profile) => (
      profile.id === profileId ? { ...profile, settings: effectiveSettings } : profile
    ));
  }
  if (state.selectedProfileId === profileId) {
    renderQueue({ forceControlIds: getControlIdsForSettingKeys(changedKeys) });
  }
  renderProfileSettingsTransactionPanel();
}

function handleProfileSettingsNotice({ profileId, transaction, context }) {
  if (state.selectedProfileId !== profileId) return;
  const messages = {
    "committed-superseded": "设置已保存，但随后又被其他页面修改。",
    satisfied: "当前服务端状态已满足，无需重复保存。",
    "explicit-failed": "设置保存失败，未改变其他待保存设置。",
    "profile-recreated": "账号设置已重建，旧页面中的待保存设置已终止。",
    "profile-missing": "账号已不存在，待保存设置已终止。",
    terminated: "已按你的选择结束原设置事务。",
  };
  if (transaction.status === "committed") {
    showToast(context.successMessage || "设置已保存。下一轮自动化循环生效。");
    renderQueue();
    return;
  }
  showToast(messages[transaction.status] || `设置事务已结束：${transaction.status}`);
}

async function sendProfileSettingsMutation(effect) {
  const token = await getLocalSessionToken();
  return await fetchProfileSettingsResponse(
    `/api/profiles/${encodeURIComponent(effect.profileId)}/settings`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xjskp-session-token": token,
        "if-match": effect.ifMatch,
        "x-xjskp-settings-transaction-id": effect.transactionId,
      },
      body: JSON.stringify(effect.patch),
    },
  );
}

async function sendProfileSettingsReconcile(effect, { signal } = {}) {
  return await fetchProfileSettingsResponse(
    `/api/profiles/${encodeURIComponent(effect.profileId)}/settings`,
    { method: "GET", cache: "no-store", signal },
  );
}

async function fetchProfileSettingsResponse(path, init) {
  const response = await fetch(path, init);
  const text = await response.text();
  let data = {};
  if (text) data = JSON.parse(text);
  return { status: response.status, data };
}

async function initializeProfileSettingsProtocol() {
  try {
    await getLocalSessionToken(true);
  } catch {
    profileSettingsClient.setSessionProtocolVersion(null);
  }
}

async function reconcileCurrentProfileSettings() {
  const profileId = state.selectedProfileId;
  if (!profileId) return;
  await profileSettingsClient.manualReconcile(profileId);
  renderProfileSettingsTransactionPanel();
}

async function resolveCurrentSettingsConflict(decision) {
  const profileId = state.selectedProfileId;
  if (!profileId) return;
  const transaction = profileSettingsClient.getProfileState(profileId).inflightTransaction;
  if (!transaction) return;
  await profileSettingsClient.resolve(profileId, transaction.transactionId, decision);
  renderQueue();
  renderProfileSettingsTransactionPanel();
}

async function closeSystem() {
  if (!confirm("关闭本地控制台服务？正在运行的托管任务会先停止。")) return;
  await api("/api/system/stop", { method: "POST", body: {} });
  showToast("控制台正在关闭。");
}

async function stopLegacy() {
  const result = await api("/api/system/stop-legacy", { method: "POST", body: {} });
  await refreshAll({ fullReadReason: null });
  showToast(result.stopped ? `已停止 ${result.count || 0} 个旧进程。` : "未发现需要停止的旧进程。");
}

async function takeoverLegacy() {
  await stopLegacy();
  await runProfileAction("start");
}

function getControlIdsForSettings(settings) {
  return getControlIdsForSettingKeys(Object.keys(settings));
}

function getControlIdsForSettingKeys(keys) {
  return keys
    .map((key) => PROFILE_SETTINGS_CONTROL_IDS[key])
    .filter(Boolean);
}

async function checkGameVersion() {
  const profileId = state.selectedProfileId;
  const checking = state.versionCheckPending || state.gameVersion?.checking === true;
  if (!profileId || checking) return;
  gameVersionStateGeneration += 1;
  state.versionCheckPending = true;
  renderGameVersion();
  try {
    const checked = await api("/api/system/game-version/check", {
      method: "POST",
      body: { profileId },
    });
    gameVersionStateGeneration += 1;
    state.gameVersion = { ...(state.gameVersion || {}), ...checked };
    try {
      state.gameVersion = await api("/api/system/game-version");
    } catch {
      // 检查已经成功时保留 POST 结果；组合状态会在后续刷新恢复。
    }
    const copy = GAME_VERSION_COPY[checked.comparison] || GAME_VERSION_COPY.unknown;
    showToast(`${copy}：运行版 ${checked.localVersion || "-"}，最新版 ${checked.remoteVersion || "-"}。`);
  } catch (error) {
    try {
      const gameVersion = await api("/api/system/game-version");
      gameVersionStateGeneration += 1;
      state.gameVersion = gameVersion;
    } catch {
      // 保留页面已有的最后成功状态，并继续显示原始安全错误。
    }
    throw error;
  } finally {
    state.versionCheckPending = false;
    renderGameVersion();
  }
}

async function syncGameData() {
  const profileId = state.selectedProfileId;
  if (!profileId || state.gameDataSyncPending) return;
  const syncGeneration = ++gameVersionStateGeneration;
  state.gameDataSyncPending = true;
  state.gameDataSyncFeedback = null;
  renderGameVersion();
  const polling = { stopped: false };
  const pollPromise = pollGameDataSyncStatus(polling, syncGeneration);
  try {
    const result = await api("/api/system/game-data/sync", {
      method: "POST",
      body: { profileId },
    });
    polling.stopped = true;
    const finalGeneration = ++gameVersionStateGeneration;
    await pollPromise;
    if (finalGeneration === gameVersionStateGeneration) {
      state.gameVersion = {
        ...(state.gameVersion || {}),
        data: result.data,
      };
    }
    try {
      const gameVersion = await api("/api/system/game-version");
      if (finalGeneration === gameVersionStateGeneration) state.gameVersion = gameVersion;
    } catch {
      // POST 已确认成功时保留响应内的数据状态；后续刷新会恢复完整组合状态。
    }
    state.gameDataSyncFeedback = {
      visible: true,
      state: "success",
      text: formatGameDataSyncSuccess(result),
    };
    showToast(state.gameDataSyncFeedback.text);
  } catch (error) {
    polling.stopped = true;
    const finalGeneration = ++gameVersionStateGeneration;
    await pollPromise;
    try {
      const gameVersion = await api("/api/system/game-version");
      if (finalGeneration === gameVersionStateGeneration) state.gameVersion = gameVersion;
    } catch {
      // 保留当前页面已知状态；错误响应仍带有当前活跃数据版本。
    }
    state.gameDataSyncFeedback = {
      visible: true,
      state: "error",
      text: formatGameDataSyncFailure(error, state.gameVersion?.data),
    };
    showToast(state.gameDataSyncFeedback.text);
  } finally {
    polling.stopped = true;
    await pollPromise;
    state.gameDataSyncPending = false;
    renderGameVersion();
  }
}

async function pollGameDataSyncStatus(control, generation) {
  while (!control.stopped && generation === gameVersionStateGeneration) {
    try {
      const gameVersion = await api("/api/system/game-version");
      if (control.stopped || generation !== gameVersionStateGeneration) return;
      state.gameVersion = gameVersion;
      renderGameVersion();
    } catch {
      // 同步主请求负责最终反馈；轮询失败不产生未处理 Promise。
    }
    await wait(600);
  }
}

function renderAll() {
  renderRuntime();
  renderGameVersion();
  renderLegacyBanner();
  renderProfiles();
  renderWizard();
  renderTask();
  renderSummary();
  renderQueue();
  renderAccountLevelSummary();
  renderArtifactLinks();
  renderTeamOrders();
}

function renderRuntime() {
  const runtime = state.runtime || {};
  upperDashboard.renderRuntime({
    servicePort: runtime.port || runtime.server?.port || "-",
    servicePid: runtime.server?.pid || "-",
    refreshTime: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    lockState: runtime.server?.lock ? "正常" : "-",
  });
}

function renderGameVersion() {
  const view = buildGameVersionView({
    version: state.gameVersion,
    profile: currentProfile(),
    runtime: state.runtime,
    pendingAction: state.pendingAction,
    versionCheckPending: state.versionCheckPending,
    syncPending: state.gameDataSyncPending,
  });
  if (state.gameDataSyncFeedback) view.feedback = state.gameDataSyncFeedback;
  upperDashboard.renderGameVersion(view);
}

function renderLegacyBanner() {
  const legacy = state.runtime?.legacyProcesses || [];
  upperDashboard.renderLegacyShell({ visible: legacy.length > 0 });
  keyedCollections.renderLegacy(legacy);
}

function renderProfiles() {
  upperDashboard.renderProfileCount({ value: String(state.profiles.length) });
  keyedCollections.renderProfiles({
    empty: state.profiles.length === 0,
    items: state.profiles.map((profile) => {
      const missingCount = profile.missingFields?.length || 0;
      const hasValidation = Boolean(profile.lastValidatedAt);
      const runBadge = getProfileRunBadge(profile);
      return {
        id: profile.id,
        label: profile.label || profile.id,
        missingTitle: missingCount ? `缺少 ${profile.missingFields.join(", ")}` : "凭据完整",
        hasCredentials: Boolean(profile.hasCredentials),
        hasMissingFields: missingCount > 0,
        missingCount: String(missingCount),
        hasValidation,
        validationTime: hasValidation ? formatCompactDateTime(profile.lastValidatedAt) : "",
        selected: profile.id === state.selectedProfileId,
        runState: runBadge.state,
        runLabel: runBadge.label,
        runPid: runBadge.pid,
        runMode: runBadge.mode,
        runStartedAt: runBadge.startedAt,
        runHasMissingFields: runBadge.hasMissingFields,
        runMissingCount: runBadge.missingCount,
        runError: runBadge.error,
      };
    }),
  });
}

function selectProfileFromCard(profileId) {
  const generation = beginRefreshGeneration();
  state.selectedProfileId = profileId;
  state.validationError = null;
  clearSelectedProfileView();
  renderAll();
  if (state.queueTab === "team-orders") {
    guarded(loadCurrentProfileTeamOrders, { silent: true }).catch(() => {});
  }
  guarded(async () => {
    const loaded = await loadProfileStatus(profileId, {
      generation,
      trigger: "account-switch",
    });
    if (!loaded) return;
    renderAll();
  });
}

function renderWizard() {
  const profile = currentProfile();
  const hasReadyProfile = state.profiles.some((item) => item.hasCredentials);
  const migration = state.migration || {};
  const legacyCanMigrate = migration.exists && migration.complete && !hasReadyProfile;
  const actionPending = Boolean(state.pendingAction);
  let mode = "missing";
  let title = "需要导入账号凭据";
  let badge = "缺凭据";
  let copyState = "missing";
  let validationError = "";
  let validatedAt = "";
  let missing = profile?.missingFields || migration.missingFields || [];

  if (state.validationError) {
    mode = "invalid";
    title = "账号验证失败";
    badge = "需重导";
    copyState = "invalid";
    validationError = state.validationError;
  } else if (profile?.hasCredentials) {
    mode = "ready";
    title = "账号可用";
    badge = "可运行";
    copyState = profile.lastValidatedAt ? "ready-validated" : "ready-unvalidated";
    validatedAt = profile.lastValidatedAt ? formatCompactDateTime(profile.lastValidatedAt) : "";
    missing = [];
  } else if (legacyCanMigrate) {
    mode = "legacy-found";
    title = "发现旧账号凭据";
    badge = "可迁移";
    copyState = "legacy-found";
    missing = [];
  } else if (profile && !profile.hasCredentials) {
    title = "当前账号缺少字段";
    copyState = "profile-missing";
    missing = profile.missingFields || [];
  } else if (migration.exists && !migration.complete) {
    title = "旧凭据不完整";
    copyState = "legacy-incomplete";
    missing = migration.missingFields || [];
  }

  upperDashboard.renderWizard({
    state: mode,
    badgeText: badge,
    badgeState: mode,
    title,
    copyState,
    validationError,
    validatedAt,
    migrationProfileId: migration.profileId || "旧账号",
    missingVisible: missing.length > 0,
    migrateDisabled: !legacyCanMigrate,
    validateDisabled: actionPending || !profile?.hasCredentials || Boolean(currentProfileRun()),
    importPrimary: !profile?.hasCredentials && !legacyCanMigrate,
  });
  keyedCollections.renderMissingFields(missing);
}

function renderTask() {
  const profile = currentProfile();
  const currentRun = currentProfileRun();
  const canOperate = Boolean(profile?.hasCredentials);
  const actionPending = Boolean(state.pendingAction);
  const canRunNow = canOperate && !currentRun && Boolean(profile?.serverIdx);
  const canRunOnceNow = canOperate && !currentRun && Boolean(profile?.serverIdx);
  const canRunOrdersNow = canOperate && !currentRun && Boolean(profile?.serverIdx);

  upperDashboard.renderTask({
    profileName: profile ? profile.label || profile.id : "未选择账号",
    profileId: profile?.id || "",
    hasProfile: Boolean(profile),
    mode: currentRun ? modeText(currentRun.mode) : "待命",
    pid: currentRun?.pid || "-",
    startedAt: currentRun?.startedAt ? formatDateTime(currentRun.startedAt) : "-",
    doubleGoldRemaining: state.status?.resources?.doubleGoldRemainingText
      || state.gardenData?.summary?.doubleGoldRemainingText
      || "-",
    startDisabled: actionPending || !canRunNow,
    onceDisabled: actionPending || !canRunOnceNow,
    ordersDisabled: actionPending || !canRunOrdersNow,
    stopDisabled: actionPending || !currentRun,
    resetDisabled: !profile,
  });
}

function renderSummary() {
  const summary = state.status;
  const staleStatus = getCurrentStatusStaleInfo();
  const loginStopInfo = getLoginStopInfo();
  const hasCredentials = Boolean(currentProfile()?.hasCredentials);
  const transportState = state.runtimeTransport?.state;
  const transportUnavailable = transportState === "offline";
  const transportRecovering = transportState === "recovering";
  const readLabel = formatFullReadTrigger(state.statusReadMeta?.trigger);
  const loadedLabel = summary?.updatedAt
    ? `已刷新${readLabel ? `（${readLabel}）` : ""}`
    : "暂无状态";
  upperDashboard.renderSummary({
    statusLabel: transportUnavailable
      ? "状态不再实时"
      : staleStatus
      ? "最近状态早于本次启动/退出，查看日志"
      : loadedLabel,
    statusValue: transportUnavailable
      ? (state.runtimeTransport?.lastError || "轻量状态读取失败")
      : !staleStatus && summary?.updatedAt ? formatDateTime(summary.updatedAt) : "",
    landTotal: valueOrDash(summary?.land?.total),
    landEmpty: valueOrDash(summary?.land?.empty),
    landGrowing: valueOrDash(summary?.land?.growing),
    landMature: valueOrDash(summary?.land?.mature),
    nextMature: summary?.land?.nextMatureText || "-",
    waterDrop: summary?.resources?.waterDropText || "-",
    waterNext: summary?.resources?.waterDropNextRestoreText || "-",
    waterNeed: state.gardenData?.summary?.waterDropNeedText || "",
    resources: {
      gold: formatWanNumber(summary?.resources?.goldText),
      pearl: formatWanNumber(summary?.resources?.pearlText),
      flowerShopCoin: formatWanNumber(summary?.resources?.flowerShopCoinText),
      satinSilk: formatWanNumber(summary?.resources?.satinSilkText),
      buildingMaterial: formatWanNumber(summary?.resources?.buildingMaterialText),
      yuanbao: formatWanNumber(summary?.resources?.yuanbaoText),
      hireItemCount: formatWanNumber(summary?.resources?.hireItemCountText),
    },
    risks: {
      errors: {
        value: summary?.risk?.cycleErrorCount ?? 0,
        state: Number(summary?.risk?.cycleErrorCount || 0) > 0 ? "danger" : "ok",
      },
      status: {
        value: transportUnavailable
          ? "状态不再实时"
          : transportRecovering
            ? "状态已恢复，校正中"
            : staleStatus ? "状态过期" : summary?.updatedAt ? "已刷新" : "暂无状态",
        state: transportUnavailable || transportRecovering
          ? "warn"
          : staleStatus ? "warn" : summary?.updatedAt ? "ok" : "warn",
      },
      login: {
        value: loginStopInfo ? "已失效" : (summary?.risk?.loginStateText || "待验证"),
        state: loginStopInfo ? "danger" : summary?.risk?.loginState === "normal" ? "ok" : "warn",
      },
      credentials: {
        value: hasCredentials ? "完整" : "不完整",
        state: hasCredentials ? "ok" : "danger",
      },
    },
  });
}

function renderQueue({ forceControlIds = [] } = {}) {
  const rows = state.status?.queue || [];
  const byArea = new Map(rows.map((row) => [row.area, row]));
  const activeTab = QUEUE_TAB_KEYS.has(state.queueTab) ? state.queueTab : "common";
  const profileId = currentProfile()?.id || null;
  const forced = new Set(forceControlIds);
  if (profileId !== lastQueueProfileId) {
    queueControlDrafts.clear();
    for (const controlId of QUEUE_VALUE_CONTROL_IDS) forced.add(controlId);
    lastQueueProfileId = profileId;
  }
  const dirtyControlIds = new Set(
    [...queueControlDrafts]
      .filter(([, draft]) => draft.profileId === profileId)
      .map(([controlId]) => controlId),
  );
  const view = buildQueueDashboardView(activeTab, byArea);
  queueDashboard.render(view, {
    dirtyControlIds,
    forceControlIds: forced,
  });

  queueCollections.renderOrdinary(buildOrdinaryResidentSlotsView(
    state.gardenData?.ordinaryResidentOrders?.orders,
  ));
  queueCollections.renderCyclicNote(
    view.secondary.cyclicNoteVisible
      ? buildCyclicNoteQueueView(findQueueRow(byArea, { area: "花笺集芳" }))
      : null,
  );
  applyProfileSettingsControlStates();
  renderProfileSettingsTransactionPanel();
}

function getProfileSettingsControlState(profileId, key) {
  if (!profileId) return { busy: false, status: "unavailable" };
  const profileState = profileSettingsClient.getProfileState(profileId);
  const active = [profileState.inflightTransaction, ...profileState.queuedTransactions]
    .filter((transaction) => transaction && Object.hasOwn(transaction.patch || {}, key));
  const transaction = active[0] || null;
  return {
    busy: Boolean(transaction),
    status: transaction?.status || "idle",
  };
}

function canMutateProfileSettings(profileId) {
  if (!profileId || !profileSettingsClient.isProtocolCompatible()) return false;
  const profileState = profileSettingsClient.getProfileState(profileId);
  return profileState.authority === "authoritative"
    && profileState.readState === "ready"
    && !profileState.blockState;
}

function applyProfileSettingsControlStates() {
  const profile = currentProfile();
  const profileId = profile?.id || null;
  const canMutate = canMutateProfileSettings(profileId);
  for (const [key, controlId] of Object.entries(PROFILE_SETTINGS_CONTROL_IDS)) {
    const control = $(controlId);
    if (!control) continue;
    const transactionView = getProfileSettingsControlState(profileId, key);
    const dependencyBlocked = (
      key === "skipWaterwheelVideoBuckets"
      && profile?.settings?.autoReceiveWaterwheelBuckets === false
    ) || (
      key === "cyclicStoryOnlyHighestExperienceOrder"
      && profile?.settings?.autoSubmitCyclicStoryOrders === false
    ) || (
      key === "autoCompleteCyclicNoteHighestRewardTask"
      && profile?.settings?.autoHandleCyclicNote === false
    );
    const customerRewardBlocked = key === "customerOrderFlowerCurrencyRewardReleaseMask"
      && [
        "conflict",
        "blocked-runtime-degraded",
        "profile-committed-runtime-degraded",
        "blocked-canonical-collision",
        "blocked-settings-state-invalid",
        "protocol-incompatible",
        "profile-missing",
        "unavailable",
      ].includes(transactionView.status);
    control.disabled = !canMutate || dependencyBlocked || customerRewardBlocked;
    control.setAttribute("aria-busy", transactionView.busy ? "true" : "false");
    control.dataset.settingsTransactionState = transactionView.status;
  }
}

function renderProfileSettingsTransactionPanel() {
  const panel = $("settingsTransactionPanel");
  if (!panel) return;
  const profileId = state.selectedProfileId;
  const profileState = profileId ? profileSettingsClient.getProfileState(profileId) : null;
  const transaction = profileState?.inflightTransaction || null;
  const queuedCount = profileState?.queuedTransactions?.length || 0;
  const status = transaction?.status
    || profileState?.blockState
    || (profileState?.readState === "ready" ? "idle" : profileState?.readState)
    || "unavailable";
  const copy = {
    idle: "设置已同步",
    ready: "设置等待发送",
    sending: "正在保存设置",
    queued: "设置已加入队列",
    confirming: transaction?.reason === "replay-result-unknown"
      ? "重发结果未知，正在确认服务端状态"
      : "正在确认保存结果",
    conflict: "设置与其他页面发生冲突，需要你确认",
    "blocked-runtime-degraded": "运行时设置暂未同步，正在修复",
    "profile-committed-runtime-degraded": "设置已写入，正在修复运行时同步",
    "blocked-canonical-collision": "账号标识存在冲突，设置已暂停",
    "blocked-settings-state-invalid": "账号设置状态损坏，设置已暂停",
    "protocol-incompatible": "页面与本地服务协议不匹配，请刷新或重启匹配版本",
    "profile-missing": "账号不存在，设置不可用",
    unavailable: "设置状态尚未加载",
    degraded: "设置状态暂不可确认",
  };
  const label = $("settingsTransactionStatus");
  if (label) label.textContent = `${copy[status] || status}${queuedCount ? `；队列 ${queuedCount} 项` : ""}`;
  const reconcileButton = $("settingsReconcileButton");
  const adoptButton = $("settingsAdoptCurrentButton");
  const reapplyButton = $("settingsReapplyButton");
  const reconcilable = [
    "confirming",
    "blocked-runtime-degraded",
    "profile-committed-runtime-degraded",
  ].includes(transaction?.status);
  if (reconcileButton) reconcileButton.hidden = !reconcilable;
  if (adoptButton) adoptButton.hidden = transaction?.status !== "conflict";
  if (reapplyButton) {
    reapplyButton.hidden = transaction?.status !== "conflict"
      && !(transaction?.status === "confirming" && transaction?.reason === "replay-result-unknown");
  }
  panel.dataset.state = status;
  panel.hidden = !profileId;
}

function buildQueueDashboardView(activeTab, byArea) {
  const module = (group, index) => findQueueRow(byArea, QUEUE_MODULE_GROUPS[group][index]);
  const waterwheelRow = module("common", 0);
  const freeWaterRow = module("common", 1);
  const ordinaryRow = module("common", 2);
  const satinRow = module("common", 3);
  const experienceRow = module("common", 4);
  const landRow = module("common", 5);
  const mainTaskRow = module("common", 6);
  const customerRow = module("common", 7);
  const cyclicStoryRow = findQueueRow(byArea, QUEUE_MODULE_GROUPS.activities[0]);
  const experienceStop = getExperienceGuardStopInfo();
  const loginStop = experienceStop ? null : getLoginStopInfo();
  return {
    activeTab,
    cycle: valueOrDash(state.status?.cycle),
    step: state.status?.step || "-",
    stopInfo: experienceStop
      ? { ...experienceStop, kind: "experience-guard" }
      : loginStop ? { ...loginStop, kind: "session-expired" } : null,
    statusOk: Boolean(state.status?.ok),
    common: {
      waterwheel: buildWaterwheelQueueView(waterwheelRow),
      freeWater: buildGenericQueueView(freeWaterRow),
      ordinary: buildOrdinaryResidentQueueView(ordinaryRow),
      satin: buildSatinMaterialQueueView(satinRow),
      experienceGuard: buildExperienceGuardQueueView(experienceRow),
      land: buildGenericQueueView(landRow),
      mainTask: buildMainTaskQueueView(mainTaskRow),
      customer: buildCustomerOrderQueueView(customerRow),
    },
    secondary: {
      palace: buildGenericQueueView(module("secondary", 0)),
      guild: buildGenericQueueView(module("secondary", 1)),
      flowerRack: buildFlowerRackQueueView(module("secondary", 2)),
      pearl: buildPearlQueueView(module("secondary", 3)),
      materialShop: buildMaterialShopQueueView(module("secondary", 4)),
      cyclicNoteVisible: shouldShowCyclicNoteQueueCard(byArea),
    },
    cyclicStory: buildCyclicStoryView(cyclicStoryRow, state.gardenData?.cyclicStory, {
      autoSubmitEnabled: currentProfile()?.settings?.autoSubmitCyclicStoryOrders,
      onlyHighestExperienceEnabled:
        currentProfile()?.settings?.cyclicStoryOnlyHighestExperienceOrder,
      hasProfile: Boolean(currentProfile()),
    }),
    teamOrderSettings: buildTeamOrderSettingsView(),
  };
}

function buildGenericQueueView(row) {
  return {
    state: normalizeQueueState(row),
    hasData: Boolean(row),
    pending: valueOrDash(row?.pending ?? 0),
    status: row?.status || "-",
    rule: row?.rule || "",
  };
}

function buildCustomerOrderQueueView(row) {
  const profile = currentProfile();
  const profileId = profile?.id || null;
  const customerOrders = state.gardenData?.customerOrders || {};
  const dailyLimit = customerOrders.dailyLimit || {};
  const dailyCompleted = dailyLimit.dailyCountKnown === true
    && dailyLimit.tdyCompletedCount != null
    ? dailyLimit.tdyCompletedCount
    : null;
  const releaseKey = "customerOrderFlowerCurrencyRewardReleaseMask";
  const settings = profileId
    ? profileSettingsClient.getEffectiveSettings(profileId) || profile?.settings || {}
    : {};
  const releaseMask = normalizeCustomerOrderRewardReleaseMask(
    settings[releaseKey],
  );
  const transactionView = getProfileSettingsControlState(profileId, releaseKey);
  const blockedStatuses = new Set([
    "conflict",
    "blocked-runtime-degraded",
    "profile-committed-runtime-degraded",
    "blocked-canonical-collision",
    "blocked-settings-state-invalid",
    "protocol-incompatible",
    "profile-missing",
    "unavailable",
  ]);
  const settingsBlocked = blockedStatuses.has(transactionView.status);
  const releaseSummary = !profile
    ? "选择账号后可设置花坊币收益放行列表。"
    : releaseMask === 0
      ? "未放行任何收益，顾客订单自动处理已暂停。"
      : `当前放行收益：${[1, 2, 3]
        .filter((reward) => (releaseMask & (1 << (reward - 1))) !== 0)
        .join("、")}`;
  const settingsStatus = !profile
    ? "暂无账号设置"
    : transactionView.status === "conflict"
      ? "设置冲突，请在顶部事务面板确认"
      : transactionView.busy
        ? "正在保存设置"
        : settingsBlocked
          ? "设置暂不可用"
          : "按账号独立保存，下一轮生效";
  const pending = customerOrders.pendingAutoSubmitActions?.length
    || customerOrders.pendingCustomerOrderActions?.length
    || row?.pending
    || 0;
  return {
    ...buildGenericQueueView(row),
    state: !profile || releaseMask === 0 ? "blocked" : normalizeQueueState(row),
    hasData: Boolean(row) || Object.keys(customerOrders).length > 0,
    pending: valueOrDash(pending),
    dailyCompleted: valueOrDash(dailyCompleted),
    dailyLimit: valueOrDash(dailyLimit.dailyLimit),
    reward1: (releaseMask & 1) !== 0,
    reward2: (releaseMask & 2) !== 0,
    reward3: (releaseMask & 4) !== 0,
    rewardControlsDisabled: !profile || !canMutateProfileSettings(profileId) || settingsBlocked,
    rewardSettingsBusy: transactionView.busy,
    rewardSettingsState: transactionView.status,
    releaseSummary,
    settingsStatus,
    rule: row?.rule
      || "收益按官方 item 1002 与 cPrice×order.num 计算；精确放行 1/2/3，历史最高仅作审计。",
  };
}

function buildWaterwheelQueueView(row) {
  const profile = currentProfile();
  const bucketReceiveEnabled =
    profile?.settings?.autoReceiveWaterwheelBuckets !== false;
  const videoBucketSkipEnabled =
    profile?.settings?.skipWaterwheelVideoBuckets === true;
  const resources = state.status?.resources || {};
  const summary = state.gardenData?.summary || {};
  const waterwheel = state.gardenData?.waterwheel || {};
  return {
    ...buildGenericQueueView(row),
    bucketReceiveEnabled,
    bucketReceiveDisabled: !profile,
    bucketReceiveEnabledText: bucketReceiveEnabled ? "开启" : "关闭",
    videoBucketSkipEnabled,
    videoBucketSkipDisabled: !profile || !bucketReceiveEnabled,
    waterDrop: valueOrDash(
      resources.waterDropText || summary.waterDropText || waterwheel.waterDropText,
    ),
    nextDrop: valueOrDash(
      resources.waterDropNextRestoreText || summary.waterDropNextRestoreText,
    ),
    bucketCurrent: valueOrDash(
      summary.waterwheelStoredBucketCount ?? waterwheel.storedBucketCount,
    ),
    bucketMax: valueOrDash(
      summary.waterwheelStoredBucketMax ?? waterwheel.storedBucketMax,
    ),
    claimedToday: valueOrDash(
      summary.waterwheelClaimedBucketCount ?? waterwheel.claimedBucketCount,
    ),
    dailyMax: valueOrDash(
      summary.waterwheelMaxBucketCount ?? waterwheel.maxBucketCount,
    ),
    dailyRemaining: valueOrDash(
      summary.waterwheelRemainingDailyBucketCount
        ?? summary.waterwheelRemainingBucketCount
        ?? waterwheel.remainingDailyBucketCount
        ?? waterwheel.remainingBucketCount,
    ),
    nextGeneration: valueOrDash(
      summary.waterwheelNextBucketGenerationInSeconds != null
        ? `${summary.waterwheelNextBucketGenerationInSeconds}秒`
        : waterwheel.nextBucketGenerationInSeconds != null
          ? `${waterwheel.nextBucketGenerationInSeconds}秒`
          : null,
    ),
    nextBucket: valueOrDash(
      summary.waterwheelNextBucketNo ?? waterwheel.nextBucketNo,
    ),
    nextBucketVideo: Boolean(
      summary.waterwheelNextBucketIsVideo ?? waterwheel.nextBucketIsVideo,
    ),
  };
}

function buildSatinMaterialQueueView(row) {
  const resources = state.status?.resources || {};
  const summary = state.gardenData?.summary || {};
  const specialOrders = state.gardenData?.specialOrders || {};
  const satin = specialOrders?.satin || {};
  const decorate = specialOrders?.decorate || {};
  const satinCompletion = getOrderCompletionParts(satin);
  const materialCompletion = getOrderCompletionParts(decorate);
  const satinView = buildSpecialOrderCategoryView(satin);
  const materialView = buildSpecialOrderCategoryView(decorate);
  return {
    ...buildGenericQueueView(row),
    satin: formatWanNumber(resources.satinSilkText || summary.satinSilkText),
    material: formatWanNumber(
      resources.buildingMaterialText || summary.buildingMaterialText,
    ),
    satinCompleted: satinCompletion.current,
    satinLimit: satinCompletion.limit,
    materialCompleted: materialCompletion.current,
    materialLimit: materialCompletion.limit,
    satinCooldown: valueOrDash(satinView.status),
    satinMissing: satinView.missing,
    materialCooldown: valueOrDash(materialView.status),
    materialMissing: materialView.missing,
  };
}

function getOrderCompletionParts(order) {
  const completed = order?.completedCount
    ?? order?.homePopupCompletedCount
    ?? order?.businessStatsCompletedCount;
  return {
    current: valueOrDash(completed),
    limit: valueOrDash(order?.dailyLimit),
  };
}

function buildOrdinaryResidentQueueView(row) {
  const ordinaryResidentOrders = state.gardenData?.ordinaryResidentOrders || {};
  const profile = currentProfile();
  const profileAutoSubmitEnabled =
    profile?.settings?.autoSubmitOrdinaryResidentOrdersForLevelUp === true;
  const enabled = ordinaryResidentOrders.ordinaryAutoSubmitEnabled
    ?? ordinaryResidentOrders.levelUpAutoSubmitEnabled
    ?? profileAutoSubmitEnabled;
  const pendingAutoSubmitActions = ordinaryResidentOrders.pendingAutoSubmitActions || [];
  const total = ordinaryResidentOrders.total
    ?? state.status?.orders?.ordinaryTotalCount;
  const ready = ordinaryResidentOrders.readyCount
    ?? state.status?.orders?.ordinaryReadyCount;
  const completed = ordinaryResidentOrders.completedCount
    ?? state.status?.orders?.ordinaryCompletedCount;
  const pending = pendingAutoSubmitActions.length || Number(row?.pending || 0);
  const gateReason = ordinaryResidentOrders.ordinaryResidentOrderGateReason
    || row?.ordinaryResidentOrderGateReason
    || row?.gateReason
    || "";
  const blocked = !enabled || (Number(ready || 0) > 0 && pending === 0);
  return {
    state: pending > 0 ? "pending" : blocked ? "blocked" : "idle",
    enabled: Boolean(enabled),
    disabled: !profile,
    enabledText: enabled ? "开启" : "关闭",
    completed: valueOrDash(completed),
    ready: valueOrDash(ready),
    total: valueOrDash(total),
    gateReason: valueOrDash(formatOrdinaryResidentGateReason(gateReason)),
  };
}

function buildExperienceGuardQueueView(row) {
  const profile = currentProfile();
  const guardControl = state.experienceGuardControl;
  const persistentState = guardControl?.state || null;
  const accountLevel = state.status?.accountLevel
    || state.gardenData?.summary?.accountLevel
    || state.gardenData?.accountLevel
    || null;
  const currentGuard = currentExperienceGuard();
  const settlementUncertain = persistentState?.invalid === true
    && persistentState?.invalidReason === "experience-guard-settlement-unresolved";
  const durableExperienceBlocked = persistentState?.breached === true
    || (persistentState?.invalid === true && !settlementUncertain);
  const effectiveGuard = guardControl
    ? {
        ...(currentGuard || {}),
        // The persistent guard is authoritative for durable blocked state;
        // status artifacts may still describe the previous worker cycle.
        blocked: durableExperienceBlocked,
        experienceProtectionBlocked: durableExperienceBlocked,
        settlementUncertain,
      }
    : currentGuard;
  const guardView = buildExperienceGuardView({
    accountLevel,
    thresholdPercent: profile?.settings?.experienceGuardThresholdPercent,
    experienceGuard: effectiveGuard,
  });
  const pending = getProfileSettingsControlState(
    profile?.id,
    "experienceGuardThresholdPercent",
  ).busy;
  const rearmPending = Boolean(guardControl?.pendingRearm)
    || Boolean(guardControl?.pendingSettlementRecovery)
    || experienceGuardRearmFlights.has(profile?.id);
  const rearmRecoverable = isExperienceGuardRearmRecoverable(persistentState);
  const settlementRecoveryPending = Boolean(guardControl?.pendingSettlementRecovery);
  const settlementRecoveryAvailable = settlementUncertain
    && isExperienceGuardSettlementRecoveryAvailable(guardControl?.pendingSettlement);
  const legacySettlementRecoveryAvailable = settlementUncertain
    && !settlementRecoveryAvailable
    && isExperienceGuardLegacyRecoveryAvailable(guardControl?.pendingSettlement);
  const settlementRecoveryLegacy = settlementRecoveryPending
    && guardControl?.pendingSettlementRecovery?.recoveryMode === "legacy-unverified";
  const rearmLoadFailed = Boolean(state.experienceGuardControlLoadError && guardView.blocked);
  const rearmVisible = rearmPending || rearmRecoverable || rearmLoadFailed || settlementUncertain;
  const rearmStatus = settlementRecoveryPending
    ? settlementRecoveryLegacy
      ? "历史未决保护锁人工解除已提交；不会自动重试收益。"
      : "未决结算恢复已提交，等待新鲜土地权威核对；不会自动重试收获。"
    : guardControl?.pendingRearm
    ? "重新布防已提交，等待实时等级确认；停止账号将在下次启动时确认。"
    : state.experienceGuardControlLoadError
      ? `重新布防状态读取失败：${state.experienceGuardControlLoadError}`
      : settlementUncertain
        ? settlementRecoveryAvailable
          ? "存在未确认的收益请求；请确认账号后核对新鲜土地权威状态，不会自动重试收获。"
          : legacySettlementRecoveryAvailable
            ? "存在缺少执行前快照的历史未决请求；停止账号后可人工解除并记录风险，不会自动重试收益。"
            : "存在未确认的收益请求；当前未暴露可用的权威核对路径，保持保护锁。"
      : rearmRecoverable
        ? "停止或重启不会解除；请确认当前等级后重新布防。"
        : "";
  return {
    state: guardView.blocked
      ? "blocked"
      : row?.state === "pending" ? "pending" : "idle",
    hasData: Boolean(row),
    pending: valueOrDash(row?.pending ?? 0),
    inputValue: guardView.thresholdPercentText,
    inputDisabled: !canMutateProfileSettings(profile?.id),
    inputBusy: pending,
    panelBlocked: guardView.blocked,
    panelPending: pending,
    status: guardView.statusText,
    threshold: formatWanNumber(guardView.thresholdRemainingExp),
    remaining: formatWanNumber(guardView.remainingToProtectionExp),
    rule: row?.rule || "",
    rearmVisible,
    rearmDisabled: !profile
      || rearmPending
      || (settlementUncertain
        ? !(settlementRecoveryAvailable || legacySettlementRecoveryAvailable)
        : !rearmRecoverable),
    rearmPending,
    settlementUncertain,
    settlementRecoveryPending,
    settlementRecoveryLegacy,
    legacySettlementRecoveryAvailable,
    rearmStatus,
  };
}

function buildMainTaskQueueView(row) {
  const mainTaskStatus = getMainTaskStatus();
  const taskId = mainTaskStatus?.taskId;
  const taskType = mainTaskStatus?.taskType;
  const canReceive = Boolean(mainTaskStatus?.canReceive);
  return {
    state: canReceive ? "pending" : "idle",
    taskId: valueOrDash(taskId),
    taskType: valueOrDash(taskType),
    progress: valueOrDash(mainTaskStatus?.progressText),
    remaining: valueOrDash(mainTaskStatus?.remainingValue),
    status: formatMainTaskStatus(mainTaskStatus, row),
    hasTask: Boolean(taskId),
    detailTaskId: valueOrDash(taskId),
    description: stripTaskIndex(mainTaskStatus?.desc || "") || "配置中没有任务说明",
    receiveState: canReceive ? "可领取" : "进行中/未达标",
    rule: row?.rule ? shortenRule(row.rule) : "",
  };
}

function buildFlowerRackQueueView(row) {
  const profile = currentProfile();
  const flowerRack = state.gardenData?.flowerRack || null;
  const recommendationsLoaded = Array.isArray(flowerRack?.recommendedArts);
  const recommendations = recommendationsLoaded
    ? flowerRack.recommendedArts.map(normalizeFlowerRackOption).filter(Boolean).slice(0, 5)
    : [];
  const selectedArtId = normalizeFlowerRackArtId(profile?.settings?.flowerRackTargetArtId);
  const offOption = {
    artId: null,
    label: "不自动上架",
    description: recommendationsLoaded ? "只收取到期金币" : "启动账号后更新推荐列表",
  };
  const options = [offOption, ...recommendations];
  let selectedOption = recommendations.find((option) => option.artId === selectedArtId) || null;
  if (!selectedOption && selectedArtId !== null) {
    const retainedOption = buildRetainedFlowerRackOption(flowerRack?.targetArt, selectedArtId);
    if (retainedOption) {
      options.push(retainedOption);
      selectedOption = retainedOption;
    }
  }
  selectedOption ||= offOption;
  return {
    state: normalizeQueueState(row),
    hasData: Boolean(row),
    options,
    selectedArtId: selectedOption.artId == null ? "" : String(selectedOption.artId),
    disabled: !profile,
    description: selectedOption.description,
    pending: valueOrDash(row?.pending ?? 0),
    selectedLabel: selectedOption.label,
    status: row?.status || "-",
    rule: row?.rule || selectedOption.description,
  };
}

function normalizeFlowerRackArtId(value) {
  if (value === null || value === undefined || value === "") return null;
  const artId = Number(value);
  return Number.isSafeInteger(artId) && artId > 0 ? artId : null;
}

function normalizeFlowerRackOption(option) {
  const artId = normalizeFlowerRackArtId(option?.artId);
  const rawLabel = String(option?.label || "").trim();
  if (artId === null || !rawLabel) return null;
  const salePrice = Number(option?.salePrice);
  const rackGold = Number(option?.rackGold);
  const label = formatFlowerRackOptionLabel(artId, rawLabel, salePrice, rackGold);
  return {
    artId,
    label,
    description: Number.isFinite(rackGold)
      ? `双倍每架 ${formatChineseInteger(rackGold)} 金币；单件 ${formatChineseInteger(salePrice)}`
      : Number.isFinite(salePrice) ? `单件金币 ${formatChineseInteger(salePrice)}（旧状态）` : "账号推荐花艺",
  };
}

function buildRetainedFlowerRackOption(targetArt, selectedArtId) {
  if (normalizeFlowerRackArtId(targetArt?.artId) !== selectedArtId) return null;
  const materials = Array.isArray(targetArt?.recipe?.materials)
    ? targetArt.recipe.materials
    : [];
  const materialLabels = materials.map((material) => {
    const name = String(material?.itemName || "").trim();
    if (!name) return null;
    const need = Number(material?.needPerArt);
    return material?.kind === "flower" && Number.isFinite(need) && need > 1
      ? `${name}x${need}`
      : name;
  }).filter(Boolean);
  const recipeLabel = materialLabels.length
    ? `${selectedArtId}(${materialLabels.join("+")})`
    : String(targetArt?.label || `${selectedArtId}(${targetArt?.name || "上次选择"})`);
  const label = formatFlowerRackOptionLabel(
    selectedArtId,
    recipeLabel,
    targetArt?.salePrice,
    targetArt?.rackGold,
  );
  return {
    artId: selectedArtId,
    label,
    description: "上次选择，不在当前金币 Top 5 中",
  };
}

function formatFlowerRackOptionLabel(artId, label, salePrice, rackGold) {
  const rawLabel = String(label || "").trim();
  const recipeStart = rawLabel.indexOf("(");
  const recipeText = recipeStart >= 0 ? rawLabel.slice(recipeStart) : `(${rawLabel || "配方待更新"})`;
  const normalizedSalePrice = Number(salePrice);
  const normalizedRackGold = Number(rackGold);
  const priceText = Number.isFinite(normalizedRackGold) && normalizedRackGold > 0
    ? `双倍每架${formatChineseInteger(normalizedRackGold)}金币`
    : Number.isFinite(normalizedSalePrice) && normalizedSalePrice > 0
      ? `单件${formatChineseInteger(normalizedSalePrice)}金币（旧状态）`
    : "无金币售价";
  return `${artId}【${priceText}】${recipeText}`;
}

function formatChineseInteger(value) {
  const amount = Math.max(0, Math.round(Number(value) || 0));
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

function buildPearlQueueView(row) {
  const profile = currentProfile();
  return {
    state: normalizeQueueState(row),
    hasData: Boolean(row),
    reserve: String(profile?.settings?.pearlHireItemReserveCount ?? 100),
    disabled: !profile,
    pending: valueOrDash(row?.pending ?? 0),
    status: row?.status || "-",
    rule: row?.rule || "",
  };
}

function buildMaterialShopQueueView(row) {
  const profile = currentProfile();
  const enabled = profile?.settings?.materialShopMidnightRefreshEnabled === true;
  const maxCost = profile?.settings?.materialShopRefreshMaxCostYuanbao ?? 4;
  return {
    state: normalizeQueueState(row),
    hasData: Boolean(row),
    enabled,
    disabled: !profile,
    enabledText: enabled ? "已启用" : "默认关闭",
    windowStart: profile?.settings?.materialShopRefreshWindowStart || "23:50",
    maxCost: String(maxCost),
    maxSpend: String(getMaterialShopRefreshMaxSpend(maxCost)),
    pending: valueOrDash(row?.pending ?? 0),
    status: row?.status || "-",
    rule: "",
  };
}

function buildTeamOrderSettingsView() {
  const profile = currentProfile();
  const residentBoard = state.orderData?.residentBoard || {};
  const guardMultiplier = profile?.settings?.teamOrderGuardMultiplier ?? 2;
  const guardHistoryMaxExp = residentBoard.accountHistoricalMaxTeamExp ?? null;
  // 守卫经验本地实时计算（历史最高 × 倍数），与运行时触发决策算法一致；
  // 避免展示依赖 order-status.json 状态刷新（dryrun 30~58s/轮）造成倍数变更后显示滞后。
  const guardExp = computeTeamOrderGuardExp(guardHistoryMaxExp, guardMultiplier);
  const trigger = getTeamOrderProtectionView(profile?.settings, residentBoard);
  const triggerMode = !trigger.releaseEnabled
    ? "protected"
    : residentBoard.teamOrderDoubleGoldReady === false ? "forced" : "released";
  return {
    hasProfile: Boolean(profile),
    triggerReleaseEnabled: trigger.releaseEnabled,
    triggerMode,
    doubleGoldRemaining: residentBoard.teamOrderDoubleGoldRemainingText || "-",
    paidRenewReleaseEnabled:
      profile?.settings?.teamOrderPaidRenewProtectionEnabled === false,
    guardMultiplier: String(guardMultiplier),
    guardMultiplierBusy: getProfileSettingsControlState(
      profile?.id,
      "teamOrderGuardMultiplier",
    ).busy,
    guardFormulaText: guardHistoryMaxExp === null || guardExp === null
      ? "暂无组团经验历史"
      : `历史最高 ${guardHistoryMaxExp} × ${guardMultiplier} = ${guardExp}`,
  };
}

function normalizeQueueState(row) {
  if (row?.state === "blocked") return "blocked";
  if (row?.state === "pending") return "pending";
  return "idle";
}

function shouldShowCyclicNoteQueueCard(byArea) {
  const cyclicNote = state.gardenData?.cyclicNote;
  const statusOk = state.status?.ok === true;
  return statusOk || cyclicNote?.active === true || byArea.has("花笺集芳");
}

function getExperienceGuardStopInfo() {
  const profileId = currentProfile()?.id || state.selectedProfileId || null;
  const stopped = state.status?.risk?.automationStopped || state.gardenData?.summary?.automationStopped || null;
  if (!getCurrentStatusStaleInfo() && stopped?.reason === "experience-guard") {
    return {
      profileId,
      title: "经验保护检测到异常经验",
      message: stopped.message || currentExperienceGuard()?.reasonText || "已停止后续收益动作。",
      stoppedAt: stopped.stoppedAt || null,
      source: "status",
    };
  }

  const lastExit = profileId ? getProfileLastExit(profileId) : state.runtime?.lastExit || null;
  if (
    lastExit?.reason === "experience-guard"
    && (!profileId || !lastExit.profileId || lastExit.profileId === profileId)
  ) {
    return {
      profileId: lastExit.profileId || profileId,
      title: "经验保护检测到异常经验",
      message: lastExit.message || "已停止后续收益动作。",
      stoppedAt: lastExit.exitedAt || null,
      source: "runtime",
    };
  }

  return null;
}

function getLoginStopInfo() {
  const profileId = currentProfile()?.id || state.selectedProfileId || null;
  const stopped = state.status?.risk?.automationStopped || state.gardenData?.summary?.automationStopped || null;
  if (!getCurrentStatusStaleInfo() && stopped?.reason === "session-expired") {
    return {
      profileId,
      title: "已自动停止：登录态失效",
      message: stopped.message || "账号可能在手机端登录，建议先验证账号，再重新启动循环。",
      stoppedAt: stopped.stoppedAt || null,
      source: "status",
    };
  }

  const lastExit = profileId ? getProfileLastExit(profileId) : state.runtime?.lastExit || null;
  if (
    lastExit?.reason === "session-expired"
    && (!profileId || !lastExit.profileId || lastExit.profileId === profileId)
  ) {
    return {
      profileId: lastExit.profileId || profileId,
      title: "已自动停止：登录态失效",
      message: "账号可能在手机端登录，建议先验证账号，再重新启动循环。",
      stoppedAt: lastExit.exitedAt || null,
      source: "runtime",
    };
  }

  return null;
}

function getCurrentStatusStaleInfo() {
  const profileId = currentProfile()?.id || state.selectedProfileId || null;
  const statusUpdatedAt = parseStatusTime(state.status?.updatedAt);
  if (!profileId || !statusUpdatedAt) return null;
  const run = getProfileRun(profileId);
  const lastExit = getProfileLastExit(profileId);
  const referenceTimes = [
    parseStatusTime(run?.startedAt),
    parseStatusTime(lastExit?.startedAt),
    parseStatusTime(lastExit?.exitedAt),
  ].filter(Boolean);
  if (!referenceTimes.length) return null;
  const newestReference = referenceTimes.sort((a, b) => b.getTime() - a.getTime())[0];
  if (statusUpdatedAt.getTime() >= newestReference.getTime()) return null;
  return {
    profileId,
    statusUpdatedAt,
    referenceTime: newestReference,
  };
}

function parseStatusTime(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text.includes("T") ? text : text.replace(" ", "T"));
  if (!Number.isNaN(parsed.getTime())) return parsed;
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "0"] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isNaN(date.getTime()) ? null : date;
}

function findQueueRow(byArea, module) {
  const keys = [module.label, module.area, ...(module.aliases || [])].filter(Boolean);
  for (const key of keys) {
    const row = byArea.get(key);
    if (row) return row;
  }
  return null;
}

function buildCyclicNoteQueueView(row) {
  const cyclicNote = row?.cyclicNote || state.gardenData?.cyclicNote || {};
  const taskSlots = Array.isArray(cyclicNote.taskSlots) ? cyclicNote.taskSlots : [];
  const visibleTasks = Array.from({ length: 3 }, (_, index) => taskSlots[index] || ({
    slotIndex: index + 1,
    status: "empty",
    statusText: "空槽/等待服务端快照",
    desc: "暂无任务",
    progressText: "-",
    rewardText: "-",
  }));
  const pendingCount = row?.pending ?? cyclicNote.pendingReceiveActions?.length ?? 0;
  const phaseText = cyclicNote.phaseText || cyclicNotePhaseText(cyclicNote.phase);
  const statusText = row?.status || cyclicNote.reasonText || phaseText;
  const phaseRemaining = cyclicNote.timeTrusted === true
    && Number(cyclicNote.phaseEndMs) > 0
    && Number.isFinite(Number(cyclicNote.phaseRemainingMs))
    ? formatPhaseRemaining(cyclicNote.phaseRemainingMs)
    : "--:--";
  return {
    state: pendingCount > 0 ? "pending" : "idle",
    pending: valueOrDash(pendingCount),
    phase: phaseText,
    phaseRemaining,
    taskCount: String(visibleTasks.length),
    score: formatPair(cyclicNote.score, cyclicNote.scoreLimit) || "-",
    status: statusText,
    rule: row?.rule || cyclicNote.autoReceiveRule || "",
    autoHandleEnabled: currentProfile()?.settings?.autoHandleCyclicNote === true,
    autoHandleDisabled: !currentProfile() || !canMutateProfileSettings(currentProfile()?.id),
    autoCompleteEnabled: currentProfile()?.settings?.autoCompleteCyclicNoteHighestRewardTask === true,
    autoCompleteDisabled: !currentProfile()
      || !canMutateProfileSettings(currentProfile()?.id)
      || currentProfile()?.settings?.autoHandleCyclicNote !== true,
    tasks: visibleTasks.map((task, index) => ({
      slotIndex: task?.slotIndex ?? index + 1,
      taskId: task?.taskId,
      qualityText: task?.qualityText
        || (task?.quality ? `${task.quality}星` : `任务 ${valueOrDash(task?.taskId)}`),
      desc: task?.desc || "暂无任务描述",
      progressText: task?.progressText || formatPair(task?.current, task?.target) || "-",
      rewardText: task?.rewardText || "-",
      statusText: task?.statusText || task?.status || "-",
    })),
  };
}

function cyclicNotePhaseText(phase) {
  if (Number(phase) === 0) return "未开放（阶段0）";
  if (Number(phase) === 1) return "预告期（阶段1）";
  if (Number(phase) === 2) return "进行期（阶段2）";
  if (Number(phase) === 3) return "兑换期（阶段3）";
  if (Number(phase) === 4) return "已结束（阶段4）";
  return "阶段未知";
}

function buildOrdinaryResidentSlotsView(orders = [], nowMs = Date.now()) {
  const orderByBoxId = new Map(
    (Array.isArray(orders) ? orders : [])
      .map((order) => [Number(order?.boxId), order])
      .filter(([boxId]) => Number.isInteger(boxId) && boxId >= 1 && boxId <= ORDINARY_RESIDENT_ORDER_SLOT_COUNT),
  );
  const slots = Array.from({ length: ORDINARY_RESIDENT_ORDER_SLOT_COUNT }, (_, index) => {
    const boxId = index + 1;
    const order = orderByBoxId.get(boxId);
    if (!order) {
      return { boxId, mode: "empty", state: "empty", remainingSeconds: "0", requirements: [] };
    }
    if (order.refillPending) {
      const refillAtMs = Date.parse(order.cdTime);
      const remainingSeconds = Number.isFinite(refillAtMs)
        ? Math.max(0, Math.ceil((refillAtMs - nowMs) / 1000))
        : Math.max(0, Math.ceil(Number(order.remainingMs || 0) / 1000));
      return {
        boxId,
        mode: "refill",
        state: "refill",
        statusText: remainingSeconds > 0 ? "等待补位" : "等待服务端补位",
        remainingSeconds: String(remainingSeconds),
        serviceWaiting: remainingSeconds <= 0,
        requirements: [],
      };
    }
    if (order.isVideo) {
      return { boxId, mode: "video", state: "video", remainingSeconds: "0", requirements: [] };
    }
    return {
      boxId,
      mode: "order",
      state: order.canFinish ? "ready" : "blocked",
      statusText: order.canFinish ? "可完成" : "未满足",
      remainingSeconds: "0",
      requirements: (Array.isArray(order.requirements) ? order.requirements : []).map((requirement) => ({
        itemId: requirement?.itemId,
        name: requirement?.name || requirement?.flowerName || `花朵${requirement?.itemId ?? ""}`,
        need: requirement?.need ?? "-",
      })),
    };
  });
  return { slots };
}

function getMainTaskStatus() {
  return state.gardenData?.mainTaskStatus
    || state.gardenData?.ordinaryResidentOrders?.mainTaskStatusAfter
    || state.gardenData?.mainTasks
    || null;
}

function formatOrdinaryResidentGateReason(reason) {
  if (reason === "ordinary-auto-submit-disabled") return "自动提交普通居民订单开关关闭";
  if (reason === "ordinary-order-ready") return "订单自身条件满足";
  if (reason === "special-order-daily-limit-not-reached") return "丝绸/建材每日上限未达到";
  if (reason === "resident-board-team-trigger-protection") return "居民订单板49/99或团队保护";
  if (reason === "ordinary-order-conditions-blocked") return "库存、视频、冷却或补位条件未满足";
  if (reason === "ordinary-no-ready-order") return "暂无可完成普通居民订单";
  return "";
}

function formatMainTaskStatus(mainTaskStatus, row) {
  if (!mainTaskStatus?.exists) return row?.status || "暂无主线任务状态";
  if (mainTaskStatus.canReceive) return "可领取：当前主线进度已达标";
  if (mainTaskStatus.taskType === 3001 && mainTaskStatus.status === "in-progress") {
    return "当前主线任务是种植任务，自动化会等土地成熟/空地出现后继续推进；当前不可领取";
  }
  if (mainTaskStatus.status === "in-progress") return `进行中：还差 ${valueOrDash(mainTaskStatus.remainingValue)} 次`;
  return mainTaskStatus.statusText || row?.status || "-";
}

function formatPair(current, total) {
  if (current === null || current === undefined) return "";
  if (total === null || total === undefined) return String(current);
  return `${current}/${total}`;
}

function stripTaskIndex(desc) {
  return String(desc || "").replace(/^\d+\./, "");
}

function shortenRule(rule) {
  return String(rule || "").replace(/^仅当前主线/, "规则：仅主线");
}

function renderAccountLevelSummary() {
  const accountLevel = state.status?.accountLevel
    || state.gardenData?.summary?.accountLevel
    || state.gardenData?.accountLevel
    || null;
  upperDashboard.renderAccountLevel({
    server: formatAccountServerValue(accountLevel),
    level: valueOrDash(accountLevel?.level),
    experience: formatAccountLevelProgress(accountLevel || {}),
  });
}

function renderArtifactLinks() {
  const profile = currentProfile();
  upperDashboard.renderArtifacts({
    visible: Boolean(profile),
    statusPageHref: profile ? artifactUrl("garden-status.html") : null,
    statusJsonHref: profile ? artifactUrl("garden-status.json") : null,
    orderJsonHref: profile ? artifactUrl("order-status.json") : null,
  });
}

function renderTeamOrders() {
  const profile = currentProfile();
  const page = state.teamOrders || emptyTeamOrderPage();
  const items = Array.isArray(page.items)
    ? page.items.filter((item) => item?.profileId === state.selectedProfileId)
    : [];
  const groups = getRecentCompletedTeamOrderGroups(items);
  const visibleCount = groups.reduce((count, group) => count + group.items.length, 0);
  teamOrderArchive.render({
    loading: state.teamOrderLoading,
    error: state.teamOrderLoadError || "",
    profileId: profile?.id || null,
    dayCount: String(TEAM_ORDER_VISIBLE_DAY_COUNT),
    visibleCount: String(visibleCount),
    groups: groups.map((group) => ({
      dateLabel: group.dateLabel,
      count: String(group.items.length),
      items: group.items.map(buildTeamOrderArchiveItemView),
    })),
  });
}

function buildTeamOrderArchiveItemView(item) {
  const reward = item?.reward?.calculated || item?.reward || {};
  const displayedReward = reward.displayed || {};
  return {
    runId: item?.runId || null,
    finishedAt: item?.finishedAt || null,
    timeText: formatTime(item?.finishedAt),
    paidRenew: item?.paidRenew === true,
    renewalText: item?.paidRenew === true ? "元宝续开" : "普通轮",
    htmlName: item?.htmlName || null,
    submitted: valueOrDash(item?.submittedCount ?? 0),
    refreshed: valueOrDash(item?.refreshedCount ?? 0),
    skipped: valueOrDash(item?.skippedCount ?? 0),
    experience: formatWanNumber(reward.exp ?? displayedReward[2] ?? null),
    gold: formatWanNumber(reward.gold ?? displayedReward[11] ?? null),
  };
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "-";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function emptyTeamOrderPage() {
  return {
    items: [],
    page: 1,
    pageSize: TEAM_ORDER_FETCH_PAGE_SIZE,
    total: 0,
  };
}

function emptyTeamOrderSummary() {
  return {
    current: null,
    recent: null,
  };
}

function emptySelectedProfileView() {
  return {
    status: null,
    statusEtag: null,
    statusReadMeta: null,
    gardenData: null,
    orderData: null,
    logs: [],
    teamOrders: emptyTeamOrderPage(),
    teamOrderLoading: false,
    teamOrderLoadedProfileId: null,
    teamOrderLoadingProfileId: null,
    teamOrderLoadError: null,
    statusLoadError: null,
    experienceGuardControl: null,
    experienceGuardControlLoadError: null,
  };
}

function clearSelectedProfileView() {
  Object.assign(state, emptySelectedProfileView());
}

function errorMessage(error) {
  return error?.message || String(error || "未知错误");
}

function chooseProfile() {
  state.selectedProfileId = chooseProfileId(state.profiles, state.selectedProfileId);
}

function chooseProfileId(profiles, selectedProfileId) {
  const current = profiles.find((profile) => profile.id === selectedProfileId);
  if (current) return selectedProfileId;
  return profiles.find((profile) => profile.hasCredentials)?.id
    || profiles[0]?.id
    || null;
}

function currentProfile() {
  return state.profiles.find((profile) => profile.id === state.selectedProfileId) || null;
}

function getProfileRun(profileId) {
  if (!profileId) return null;
  const activeByProfile = state.runtime?.activeByProfile || {};
  if (activeByProfile[profileId]) return activeByProfile[profileId];
  return (state.runtime?.activeTasks || []).find((task) => task.profileId === profileId) || null;
}

function currentProfileRun() {
  const profile = currentProfile();
  return profile ? getProfileRun(profile.id) : null;
}

function currentExperienceGuard() {
  return state.status?.experienceGuard
    || state.gardenData?.summary?.experienceGuard
    || state.gardenData?.experienceGuard
    || null;
}

function getProfileLastExit(profileId) {
  if (!profileId) return null;
  const lastTaskExits = state.runtime?.lastTaskExits || {};
  if (lastTaskExits[profileId]) return lastTaskExits[profileId];
  const lastExit = state.runtime?.lastExit || null;
  return lastExit?.profileId === profileId ? lastExit : null;
}

function getProfileAutomationStopped(profileId) {
  if (!profileId || profileId !== state.selectedProfileId) return null;
  return state.status?.risk?.automationStopped
    || state.gardenData?.summary?.automationStopped
    || null;
}

function getProfileRunBadge(profile) {
  const base = {
    pid: "-",
    mode: "-",
    startedAt: "-",
    hasMissingFields: false,
    missingCount: "0",
    error: "",
  };
  const run = getProfileRun(profile.id);
  if (run) {
    return {
      ...base,
      state: "running",
      label: "运行中",
      pid: String(run.pid || "-"),
      mode: modeText(run.mode),
      startedAt: run.startedAt ? formatCompactDateTime(run.startedAt) : "-",
    };
  }
  if (!profile.hasCredentials) {
    return {
      ...base,
      state: "missing",
      label: "凭据缺失",
      hasMissingFields: Boolean(profile.missingFields?.length),
      missingCount: String(profile.missingFields?.length || 0),
    };
  }
  if (!profile.serverIdx) {
    return { ...base, state: "unverified", label: "未验证区服" };
  }
  const lastExit = getProfileLastExit(profile.id);
  if (lastExit?.reason === "session-expired") {
    return { ...base, state: "expired", label: "会话失效" };
  }
  if (lastExit?.reason === "experience-guard") {
    return {
      ...base,
      state: "error",
      label: "经验保护异常",
      error: lastExit.message || "检测到未预期经验",
    };
  }
  if (lastExit && lastExit.reason && !["completed", "stopped"].includes(lastExit.reason)) {
    return {
      ...base,
      state: "error",
      label: "异常退出",
      error: lastExit.message || lastExit.reason,
    };
  }
  return { ...base, state: "stopped", label: "未运行" };
}

function sortProfiles(profiles) {
  return [...profiles].sort((a, b) => {
    if (a.hasCredentials !== b.hasCredentials) return a.hasCredentials ? -1 : 1;
    return (a.label || a.id).localeCompare(b.label || b.id, "zh-CN") || a.id.localeCompare(b.id);
  });
}

async function getLocalSessionToken(force = false) {
  if (localSessionToken && !force) return localSessionToken;
  const rsp = await fetch("/api/session", { cache: "no-store" });
  const data = await rsp.json();
  if (!rsp.ok || !data.token) throw new Error(data.message || "无法建立本地控制台会话");
  localSessionToken = data.token;
  profileSettingsClient.setSessionProtocolVersion(data.settingsProtocolVersion);
  return localSessionToken;
}

async function api(path, options = {}, attempt = 0) {
  const method = options.method || "GET";
  const init = { method, headers: { ...(options.headers || {}) } };
  if (method !== "GET") {
    init.headers["x-xjskp-session-token"] = await getLocalSessionToken();
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body ?? {});
  }
  const rsp = await fetch(path, init);
  const etag = rsp.headers?.get?.("etag") || null;
  if (rsp.status === 304 && options.allowNotModified) {
    return { notModified: true, etag };
  }
  const text = await rsp.text();
  const data = text ? JSON.parse(text) : {};
  if (rsp.status === 403 && data.error === "LOCAL_SESSION_TOKEN_INVALID" && attempt === 0) {
    await getLocalSessionToken(true);
    return await api(path, options, 1);
  }
  if (!rsp.ok) {
    const err = new Error(data.message || data.error || `HTTP ${rsp.status}`);
    err.status = rsp.status;
    err.data = data;
    throw err;
  }
  if (options.withResponseMetadata) return { data, etag, notModified: false };
  return data;
}

async function guarded(fn, options = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!options.silent) showToast(err.message || String(err));
    throw err;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function on(id, event, handler) {
  const node = $(id);
  if (node) node.addEventListener(event, handler);
}

function renderJsonBlock(value, emptyText) {
  if (value == null || (Array.isArray(value) && value.length === 0)) {
    return `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
  }
  return `<pre class="json-block">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function artifactUrl(kind, name = "") {
  const profile = currentProfile();
  if (!profile) return "#";
  const suffix = kind === "logs"
    ? `/logs/${encodeURIComponent(name)}`
    : `/${kind}`;
  return `/artifacts/${encodeURIComponent(profile.id)}${suffix}`;
}

function clearImportForm() {
  for (const id of ["profileLabel", "credentialText", "manualPcUserId", "manualOpenId", "manualCtoken", "manualPcToken", "manualBabiToken"]) {
    $(id).value = "";
  }
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 3600);
}

function modeText(mode) {
  if (mode === "loop") return "循环";
  if (mode === "once") return "一轮";
  if (mode === "orders") return "只查订单";
  return mode || "待命";
}

function valueOrDash(value) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function formatFullReadTrigger(trigger) {
  return FULL_READ_TRIGGER_LABELS[String(trigger || "")] || "";
}

function formatWanNumber(value, emptyText = "-") {
  if (value === null || value === undefined || value === "") return emptyText;
  const text = String(value).trim().replaceAll(",", "");
  if (!/^-?\d+$/.test(text)) return String(value);
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const groups = [];
  for (let end = digits.length; end > 0; end -= 4) {
    groups.unshift(digits.slice(Math.max(0, end - 4), end));
  }
  return `${negative ? "-" : ""}${groups.join(",")}`;
}

function formatAccountLevelProgress(accountLevel = {}, emptyText = "-") {
  const currentExp = accountLevel.currentExp;
  const requiredExp = accountLevel.requiredExp;
  if (currentExp === null && requiredExp === null) return emptyText;
  if (currentExp === undefined && requiredExp === undefined) {
    return accountLevel.progressText || emptyText;
  }
  const currentText = formatWanNumber(currentExp);
  const requiredText = formatWanNumber(requiredExp);
  const currentNumber = Number(currentExp);
  const requiredNumber = Number(requiredExp);
  const hasCurrent = currentExp !== null && currentExp !== undefined && currentExp !== "";
  const hasRequired = requiredExp !== null && requiredExp !== undefined && requiredExp !== "";
  const percentText = hasCurrent && hasRequired && Number.isFinite(currentNumber) && Number.isFinite(requiredNumber) && requiredNumber > 0
    ? `（${((currentNumber / requiredNumber) * 100).toFixed(1)}%）`
    : "";
  return `${currentText}/${requiredText}${percentText}`;
}

function formatAccountServerValue(accountLevel = {}) {
  if (accountLevel?.serverIdx !== null && accountLevel?.serverIdx !== undefined) {
    return valueOrDash(accountLevel.serverIdx);
  }
  const serverText = String(accountLevel?.serverText || "").trim();
  if (!serverText) return "-";
  return serverText.replace(/^区服\s*/, "") || "-";
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatCompactDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}/${day} ${hour}:${minute}`;
}

function formatBytes(size) {
  const number = Number(size || 0);
  if (number < 1024) return `${number} B`;
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`;
  return `${(number / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
