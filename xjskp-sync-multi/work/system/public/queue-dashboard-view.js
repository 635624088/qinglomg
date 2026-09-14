import {
  setAttributeIfChanged,
  setBooleanPropertyIfChanged,
  setTextIfChanged,
  setValueIfChanged,
  toggleClassIfChanged,
} from "./dom-patch.js";
import { createCyclicStoryRenderer } from "./cyclic-story-view.js";

const QUEUE_STATES = ["pending", "idle", "blocked"];
const TAB_KEYS = ["common", "secondary", "activities", "cyclic-note", "team-orders"];

export function createQueueDashboardRenderer(getNode, options = {}) {
  const document = getNode("queueMatrix").ownerDocument;
  const tabs = new Map([
    ["common", getNode("queueTabCommon")],
    ["secondary", getNode("queueTabSecondary")],
    ["activities", getNode("queueTabActivities")],
    ["cyclic-note", getNode("queueTabCyclicNote")],
    ["team-orders", getNode("queueTabTeamOrders")],
  ]);
  const shell = {
    queueMatrix: getNode("queueMatrix"),
    teamOrderPanel: getNode("teamOrderPanel"),
    cycle: getNode("queueCycleValue"),
    step: getNode("queueStepValue"),
    stopBanner: getNode("automationStopBanner"),
    stopTitle: getNode("automationStopTitle"),
    stopMessage: getNode("automationStopMessage"),
  };
  setAttributeIfChanged(shell.cycle, "data-queue-field", "cycle");
  setAttributeIfChanged(shell.step, "data-queue-field", "step");

  const common = createCommonCards(document, options);
  const secondary = createSecondaryCards(document, options);
  const cyclicStory = createCyclicStoryRenderer(document, "queue-layout-activities-1");
  setAttributeIfChanged(cyclicStory.root, "data-queue-card", "cyclic-story");
  const cyclicNoteHost = createElement(document, "div", ["queue-dynamic-items"]);
  cyclicNoteHost.id = "cyclicNoteHost";
  const empty = createTextLeaf(
    document,
    "div",
    "暂无自动化监控数据。可先执行“只查订单”或等待当前循环写入状态。",
    "queue-empty",
    ["queue-empty"],
  );
  shell.queueMatrix.append(
    ...Object.values(common).map((record) => record.root),
    ...Object.values(secondary).map((record) => record.root),
    cyclicStory.root,
    cyclicNoteHost,
    empty,
  );
  const teamOrderSettings = createTeamOrderSettings(document, getNode("teamOrderProtectionControl"));

  return {
    render(view, renderOptions = {}) {
      const activeTab = TAB_KEYS.includes(view.activeTab) ? view.activeTab : "common";
      patchTabs(tabs, activeTab);
      setTextIfChanged(shell.cycle, view.cycle);
      setTextIfChanged(shell.step, view.step);
      patchStopBanner(shell, view.stopInfo);
      setBooleanPropertyIfChanged(shell.queueMatrix, "hidden", activeTab === "team-orders");
      setBooleanPropertyIfChanged(shell.teamOrderPanel, "hidden", activeTab !== "team-orders");
      setAttributeIfChanged(shell.queueMatrix, "class", `queue-matrix queue-matrix-${activeTab}`);
      patchVisibility(common, activeTab === "common");
      patchVisibility(secondary, activeTab === "secondary");
      setBooleanPropertyIfChanged(
        cyclicStory.root,
        "hidden",
        activeTab !== "activities",
      );
      setBooleanPropertyIfChanged(
        cyclicNoteHost,
        "hidden",
        activeTab !== "cyclic-note" || !view.statusOk || !view.secondary.cyclicNoteVisible,
      );
      setBooleanPropertyIfChanged(empty, "hidden", activeTab === "team-orders" || view.statusOk);

      patchCommon(common, view.common, document, renderOptions);
      patchSecondary(secondary, view.secondary, document, renderOptions);
      cyclicStory.render(view.cyclicStory);
      patchTeamOrderSettings(teamOrderSettings, view.teamOrderSettings, document, renderOptions);
    },
  };
}

function createCommonCards(document, options) {
  return {
    waterwheel: createWaterwheelCard(document, "queue-layout-common-1"),
    freeWater: createGenericCard(document, "free-water", "挑水工水滴", "queue-layout-common-2"),
    ordinary: createOrdinaryCard(document, "queue-layout-common-3"),
    satin: createSatinMaterialCard(document, "queue-layout-common-4"),
    experienceGuard: createExperienceGuardCard(document, "queue-layout-common-5", options),
    land: createGenericCard(document, "land-replant", "土地补种", "queue-layout-common-6"),
    mainTask: createMainTaskCard(document, "queue-layout-common-7"),
    customer: createCustomerOrderCard(document, "queue-layout-common-8"),
  };
}

function createSecondaryCards(document, options) {
  return {
    flowerRack: createFlowerRackCard(document, "queue-layout-secondary-1"),
    palace: createGenericCard(document, "palace-order", "宫廷订单", "queue-layout-secondary-2"),
    guild: createGenericCard(document, "guild-land", "公会土地", "queue-layout-secondary-3"),
    pearl: createPearlCard(document, "queue-layout-secondary-4"),
    materialShop: createMaterialShopCard(
      document,
      "queue-layout-secondary-5",
      options.materialShopCostOptions || [],
    ),
  };
}

function patchCommon(records, view, document, options) {
  patchWaterwheelCard(records.waterwheel, view.waterwheel);
  patchGenericCard(records.freeWater, view.freeWater);
  patchOrdinaryCard(records.ordinary, view.ordinary);
  patchGenericCard(records.satin, view.satin);
  for (const [field, value] of [
    ["satin-value", view.satin.satin],
    ["material-value", view.satin.material],
    ["satin-completed", view.satin.satinCompleted],
    ["satin-limit", view.satin.satinLimit],
    ["satin-cooldown", view.satin.satinCooldown],
    ["satin-missing", view.satin.satinMissing],
    ["material-completed", view.satin.materialCompleted],
    ["material-limit", view.satin.materialLimit],
    ["material-cooldown", view.satin.materialCooldown],
    ["material-missing", view.satin.materialMissing],
  ]) patchMetric(records.satin.metrics, field, value);
  patchExperienceGuardCard(records.experienceGuard, view.experienceGuard, document, options);
  patchGenericCard(records.land, view.land);
  patchMainTaskCard(records.mainTask, view.mainTask);
  patchCustomerOrderCard(records.customer, view.customer);
}

function patchSecondary(records, view, document, options) {
  patchGenericCard(records.palace, view.palace);
  patchGenericCard(records.guild, view.guild);
  patchFlowerRackCard(records.flowerRack, view.flowerRack, document, options);
  patchPearlCard(records.pearl, view.pearl, document, options);
  patchMaterialShopCard(records.materialShop, view.materialShop, document, options);
}

function createGenericCard(document, key, title, layoutClass, metricDefinitions = []) {
  const record = createCardShell(document, key, title, layoutClass, { pending: true, status: true, rule: true });
  record.metrics = createMetrics(document, metricDefinitions);
  if (record.metrics.root) record.root.append(record.metrics.root);
  record.root.append(record.status, record.rule);
  return record;
}

function createSatinMaterialCard(document, layoutClass) {
  const record = createGenericCard(document, "satin-material", "丝绸建材", layoutClass, [
    metric("丝绸", "satin-value"),
    metric("建材", "material-value"),
    pairMetric("丝绸完成", "satin-completed", "satin-limit"),
    metric("丝绸状态", "satin-cooldown"),
    metric("丝绸缺货", "satin-missing"),
    pairMetric("建材完成", "material-completed", "material-limit"),
    metric("建材状态", "material-cooldown"),
    metric("建材缺货", "material-missing"),
  ]);
  record.metrics.root.classList.add("satin-material-metrics");
  return record;
}

function createWaterwheelCard(document, layoutClass) {
  const record = createCardShell(
    document,
    "waterwheel",
    "水车水滴",
    layoutClass,
    { pending: true, status: true, rule: true },
  );
  const bucketReceiveLabel = createElement(document, "label", ["queue-switch"]);
  setAttributeIfChanged(bucketReceiveLabel, "for", "waterwheelBucketReceiveToggle");
  const bucketReceiveToggle = createControl(
    document,
    "input",
    "waterwheelBucketReceiveToggle",
    { type: "checkbox" },
  );
  const bucketReceiveEnabledText = createTextLeaf(
    document,
    "b",
    "",
    "waterwheel-bucket-receive-enabled",
  );
  bucketReceiveLabel.append(
    bucketReceiveToggle,
    createTextLeaf(document, "span", "领取水车水桶"),
    bucketReceiveEnabledText,
  );

  const videoBucketSkipLabel = createElement(
    document,
    "label",
    ["queue-switch", "waterwheel-video-bucket-skip-switch"],
  );
  setAttributeIfChanged(videoBucketSkipLabel, "for", "waterwheelVideoBucketSkipToggle");
  const videoBucketSkipToggle = createControl(
    document,
    "input",
    "waterwheelVideoBucketSkipToggle",
    { type: "checkbox" },
  );
  const videoBucketSkipText = createElement(document, "span");
  const videoBucketSkipDescription = createTextLeaf(
    document,
    "small",
    "跳过视频观看，领取当前桶基础 3–7 水滴；不是丢弃该桶",
    "waterwheel-video-bucket-skip-description",
  );
  videoBucketSkipText.append(
    createTextLeaf(document, "strong", "跳过视频桶"),
    videoBucketSkipDescription,
  );
  videoBucketSkipLabel.append(videoBucketSkipToggle, videoBucketSkipText);

  const metrics = createMetrics(document, [
    metric("水滴", "waterwheel-water-drop"),
    metric("下一滴", "waterwheel-next-drop"),
    pairMetric("已储存水桶", "waterwheel-bucket-current", "waterwheel-bucket-max"),
    pairMetric("今日已领取", "waterwheel-claimed-today", "waterwheel-daily-max"),
    metric("今日剩余", "waterwheel-daily-remaining"),
    metric("下一桶生成", "waterwheel-next-generation"),
    videoMetric("下一桶", "waterwheel-next-bucket", "waterwheel-next-video"),
  ]);
  record.root.append(
    bucketReceiveLabel,
    videoBucketSkipLabel,
    metrics.root,
    record.status,
    record.rule,
  );
  return {
    ...record,
    bucketReceiveLabel,
    bucketReceiveToggle,
    bucketReceiveEnabledText,
    videoBucketSkipLabel,
    videoBucketSkipToggle,
    videoBucketSkipDescription,
    metrics,
  };
}

function patchWaterwheelCard(record, view) {
  patchGenericCard(record, view);
  setBooleanPropertyIfChanged(record.bucketReceiveToggle, "checked", view.bucketReceiveEnabled);
  setBooleanPropertyIfChanged(record.bucketReceiveToggle, "disabled", view.bucketReceiveDisabled);
  setTextIfChanged(record.bucketReceiveEnabledText, view.bucketReceiveEnabledText);
  setBooleanPropertyIfChanged(record.videoBucketSkipToggle, "checked", view.videoBucketSkipEnabled);
  setBooleanPropertyIfChanged(record.videoBucketSkipToggle, "disabled", view.videoBucketSkipDisabled);
  patchMetric(record.metrics, "waterwheel-water-drop", view.waterDrop);
  patchMetric(record.metrics, "waterwheel-next-drop", view.nextDrop);
  patchMetric(record.metrics, "waterwheel-bucket-current", view.bucketCurrent);
  patchMetric(record.metrics, "waterwheel-bucket-max", view.bucketMax);
  patchMetric(record.metrics, "waterwheel-claimed-today", view.claimedToday);
  patchMetric(record.metrics, "waterwheel-daily-max", view.dailyMax);
  patchMetric(record.metrics, "waterwheel-daily-remaining", view.dailyRemaining);
  patchMetric(record.metrics, "waterwheel-next-generation", view.nextGeneration);
  patchMetric(record.metrics, "waterwheel-next-bucket", view.nextBucket);
  patchMetric(record.metrics, "waterwheel-next-video", "视频");
  setBooleanPropertyIfChanged(
    record.metrics.get("waterwheel-next-video"),
    "hidden",
    !view.nextBucketVideo,
  );
}

function patchGenericCard(record, view) {
  patchQueueState(record.root, view.state);
  patchPending(record, view.hasData, view.pending);
  setTextIfChanged(record.status, view.status || "-");
  setTextIfChanged(record.rule, view.rule || "");
  setBooleanPropertyIfChanged(record.rule, "hidden", !view.rule);
}

function createCardShell(document, key, title, layoutClass, parts = {}) {
  const root = createElement(document, "div", ["queue-card", layoutClass]);
  setAttributeIfChanged(root, "data-queue-card", key);
  const heading = createTextLeaf(document, "strong", title);
  root.append(heading);
  const record = { root, heading };
  if (parts.pending) {
    const pending = createElement(document, "span");
    const pendingData = createElement(document, "span");
    const pendingValue = createTextLeaf(document, "span", "", `${key}-pending`);
    pendingData.append(pendingValue, createTextLeaf(document, "span", " 项待处理"));
    const noData = createTextLeaf(document, "span", "暂无数据");
    pending.append(pendingData, noData);
    root.append(pending);
    Object.assign(record, { pending, pendingData, pendingValue, noData });
  }
  if (parts.status) record.status = createTextLeaf(document, "small", "", `${key}-status`);
  if (parts.rule) {
    const noteStyle = parts.rule === "note";
    record.rule = createTextLeaf(
      document,
      noteStyle ? "p" : "em",
      "",
      `${key}-rule`,
      noteStyle ? ["queue-note"] : [],
    );
  }
  return record;
}

function patchPending(record, hasData, pending) {
  setBooleanPropertyIfChanged(record.pendingData, "hidden", !hasData);
  setBooleanPropertyIfChanged(record.noData, "hidden", hasData);
  setTextIfChanged(record.pendingValue, pending);
}

function createOrdinaryCard(document, layoutClass) {
  const record = createCardShell(document, "ordinary-resident", "普通居民订单", layoutClass);
  const control = createElement(document, "label", ["queue-switch"]);
  setAttributeIfChanged(control, "for", "ordinaryAutoSubmitToggle");
  const input = createControl(document, "input", "ordinaryAutoSubmitToggle", { type: "checkbox" });
  const label = createTextLeaf(document, "span", "自动提交普通居民订单");
  const enabledText = createTextLeaf(document, "b", "", "ordinary-enabled");
  control.append(input, label, enabledText);
  const metrics = createMetrics(document, [
    metric("今日完成", "ordinary-completed"),
    pairMetric("可完成", "ordinary-ready", "ordinary-total"),
    metric("放行原因", "ordinary-gate"),
  ]);
  const slotsHost = createElement(document, "div");
  slotsHost.id = "ordinaryResidentSlotsHost";
  record.root.append(control, metrics.root, slotsHost);
  return { ...record, input, enabledText, metrics, slotsHost };
}

function patchOrdinaryCard(record, view) {
  patchQueueState(record.root, view.state);
  setBooleanPropertyIfChanged(record.input, "checked", view.enabled);
  setBooleanPropertyIfChanged(record.input, "disabled", view.disabled);
  setTextIfChanged(record.enabledText, view.enabledText);
  patchMetric(record.metrics, "ordinary-completed", view.completed);
  patchMetric(record.metrics, "ordinary-ready", view.ready);
  patchMetric(record.metrics, "ordinary-total", view.total);
  patchMetric(record.metrics, "ordinary-gate", view.gateReason);
}

function createCustomerOrderCard(document, layoutClass) {
  const record = createCardShell(
    document,
    "customer-order",
    "顾客订单",
    layoutClass,
    { pending: true, status: true, rule: true },
  );
  const metrics = createMetrics(document, [
    pairMetric("今日完成", "customer-order-daily-completed", "customer-order-daily-limit"),
  ]);
  metrics.root.classList.add("customer-order-daily-metrics");
  const releasePanel = createElement(document, "div", ["customer-order-reward-switches"]);
  releasePanel.append(createTextLeaf(document, "strong", "花坊币收益放行"));
  const controls = {};
  for (const reward of [1, 2, 3]) {
    const id = `customerOrderReward${reward}Toggle`;
    const label = createElement(document, "label", ["queue-switch"]);
    setAttributeIfChanged(label, "for", id);
    const input = createControl(document, "input", id, { type: "checkbox" });
    label.append(input, createTextLeaf(document, "span", `收益 ${reward}`));
    releasePanel.append(label);
    controls[reward] = { label, input };
  }
  const releaseSummary = createTextLeaf(document, "small", "", "customer-order-release-summary");
  const settingsStatus = createTextLeaf(document, "small", "", "customer-order-settings-status");
  record.root.append(metrics.root, releasePanel, releaseSummary, settingsStatus, record.status, record.rule);
  return { ...record, metrics, releasePanel, controls, releaseSummary, settingsStatus };
}

function patchCustomerOrderCard(record, view) {
  patchQueueState(record.root, view.state);
  patchPending(record, view.hasData, view.pending);
  patchMetric(record.metrics, "customer-order-daily-completed", view.dailyCompleted);
  patchMetric(record.metrics, "customer-order-daily-limit", view.dailyLimit);
  for (const reward of [1, 2, 3]) {
    const control = record.controls[reward];
    const enabled = view[`reward${reward}`] ?? view[`reward${reward}Enabled`];
    setBooleanPropertyIfChanged(control.input, "checked", enabled === true);
    setBooleanPropertyIfChanged(control.input, "disabled", view.rewardControlsDisabled === true);
    setAttributeIfChanged(control.input, "aria-busy", view.rewardSettingsBusy ? "true" : "false");
    setAttributeIfChanged(
      control.input,
      "data-settings-transaction-state",
      view.rewardSettingsState || "idle",
    );
  }
  setTextIfChanged(record.releaseSummary, view.releaseSummary || view.rewardReleaseSummary || "");
  setTextIfChanged(record.settingsStatus, view.settingsStatus || "");
  setTextIfChanged(record.status, view.status || "-");
  setTextIfChanged(record.rule, view.rule || "");
  setBooleanPropertyIfChanged(record.rule, "hidden", !view.rule);
}

function createExperienceGuardCard(document, layoutClass, options = {}) {
  const record = createCardShell(
    document,
    "experience-guard",
    "经验保护",
    layoutClass,
    { pending: true, rule: true },
  );
  record.root.classList.add("experience-guard-queue-card");
  const panel = createElement(document, "section", ["experience-guard-panel"]);
  setAttributeIfChanged(panel, "aria-label", "经验保护设置与状态");
  const control = createElement(document, "label", ["experience-guard-percent-control"]);
  const inputWrap = createElement(document, "span", ["experience-guard-input-wrap"]);
  const input = createControl(document, "input", "experienceGuardThresholdInput", {
    type: "number",
    min: "0",
    step: "0.01",
    inputmode: "decimal",
  });
  inputWrap.append(input, createTextLeaf(document, "span", "%"));
  control.append(createTextLeaf(document, "span", "经验保护百分比"), inputWrap);
  const status = createLabeledValue(document, "经验保护状态：", "experience-status");
  const threshold = createLabeledValue(document, "经验保护线：", "experience-threshold");
  const remaining = createLabeledValue(document, "距离经验保护线：", "experience-remaining");
  const rearm = createElement(document, "div", ["experience-guard-rearm"]);
  const rearmButton = createControl(document, "button", "experienceGuardRearmButton", {
    type: "button",
  });
  const rearmStatus = createTextLeaf(
    document,
    "small",
    "",
    "experience-rearm-status",
  );
  rearmButton.addEventListener("click", () => options.onExperienceGuardRearm?.());
  rearm.append(rearmButton, rearmStatus);
  panel.append(control, status.root, threshold.root, remaining.root, rearm);
  record.root.append(panel, record.rule);
  return {
    ...record,
    panel,
    input,
    status: status.value,
    threshold: threshold.value,
    remaining: remaining.value,
    rearm,
    rearmButton,
    rearmStatus,
  };
}

function patchExperienceGuardCard(record, view, document, options) {
  patchQueueState(record.root, view.state);
  patchPending(record, view.hasData, view.pending);
  patchDraftValue(document, record.input, view.inputValue, options);
  setBooleanPropertyIfChanged(record.input, "disabled", view.inputDisabled);
  setAttributeIfChanged(record.input, "aria-busy", view.inputBusy ? "true" : "false");
  toggleClassIfChanged(record.panel, "blocked", view.panelBlocked);
  toggleClassIfChanged(record.panel, "pending", view.panelPending);
  setTextIfChanged(record.status, view.status);
  setTextIfChanged(record.threshold, view.threshold);
  setTextIfChanged(record.remaining, view.remaining);
  setBooleanPropertyIfChanged(record.rearm, "hidden", !view.rearmVisible);
  setBooleanPropertyIfChanged(record.rearmButton, "hidden", !view.rearmVisible);
  setBooleanPropertyIfChanged(record.rearmButton, "disabled", view.rearmDisabled);
  setAttributeIfChanged(record.rearmButton, "aria-busy", view.rearmPending ? "true" : "false");
  setTextIfChanged(
    record.rearmButton,
    view.settlementUncertain
      ? view.settlementRecoveryPending
        ? view.settlementRecoveryLegacy
          ? "等待历史锁解除生效"
          : "等待未决结算核对"
        : view.legacySettlementRecoveryAvailable
          ? "人工解除历史锁"
          : view.rearmDisabled
            ? "待核对未决请求"
          : "确认恢复未决收益"
      : view.rearmPending ? "等待权威确认" : "重新布防当前等级",
  );
  setTextIfChanged(record.rearmStatus, view.rearmStatus || "");
  setTextIfChanged(record.rule, view.rule || "");
  setBooleanPropertyIfChanged(record.rule, "hidden", !view.rule);
}

function createMainTaskCard(document, layoutClass) {
  const record = createCardShell(document, "main-task", "主线任务", layoutClass, { rule: true });
  const metrics = createMetrics(document, [
    metric("任务", "main-task-id"),
    prefixedMetric("类型", "type=", "main-task-type"),
    metric("进度", "main-task-progress"),
    wrappedMetric("剩余", "还差", "main-task-remaining", "次"),
  ]);
  const status = createTextLeaf(document, "small", "", "main-task-status");
  const detail = createElement(document, "p", ["queue-note"]);
  const detailTask = createElement(document, "span");
  const detailEmpty = createTextLeaf(document, "span", "暂无任务");
  detailTask.append(
    createTextLeaf(document, "span", "任务 "),
    createTextLeaf(document, "span", "", "main-task-detail-id"),
  );
  detail.append(
    createTextLeaf(document, "span", "任务详情："),
    detailTask,
    detailEmpty,
    createTextLeaf(document, "span", "；"),
    createTextLeaf(document, "span", "", "main-task-description"),
    createTextLeaf(document, "span", "；"),
    createTextLeaf(document, "span", "", "main-task-receive-state"),
  );
  record.root.append(metrics.root, status, detail, record.rule);
  return { ...record, metrics, status, detail, detailTask, detailEmpty };
}

function patchMainTaskCard(record, view) {
  patchQueueState(record.root, view.state);
  for (const [field, value] of [
    ["main-task-id", view.taskId],
    ["main-task-type", view.taskType],
    ["main-task-progress", view.progress],
    ["main-task-remaining", view.remaining],
    ["main-task-detail-id", view.detailTaskId],
    ["main-task-description", view.description],
    ["main-task-receive-state", view.receiveState],
  ]) setTextIfChanged(findField(record.root, field), value);
  setBooleanPropertyIfChanged(record.detailTask, "hidden", !view.hasTask);
  setBooleanPropertyIfChanged(record.detailEmpty, "hidden", view.hasTask);
  setTextIfChanged(record.status, view.status);
  setTextIfChanged(record.rule, view.rule || "");
  setBooleanPropertyIfChanged(record.rule, "hidden", !view.rule);
}

function createFlowerRackCard(document, layoutClass) {
  const record = createCardShell(document, "flower-rack", "花架金币", layoutClass, { pending: true, status: true, rule: "note" });
  const control = createElement(document, "label", ["queue-switch", "flower-rack-target-switch"]);
  setAttributeIfChanged(control, "for", "flowerRackTargetSelect");
  const select = createControl(document, "select", "flowerRackTargetSelect");
  const description = createTextLeaf(document, "b", "", "flower-rack-description");
  control.append(createTextLeaf(document, "span", "上架花艺"), select, description);
  const metrics = createMetrics(document, [
    metric("待处理", "flower-rack-metric-pending"),
    metric("当前选择", "flower-rack-selected-label"),
  ]);
  record.root.append(control, record.pending, metrics.root, record.status, record.rule);
  return { ...record, select, description, metrics };
}

function patchFlowerRackCard(record, view, document, options) {
  patchQueueState(record.root, view.state);
  if (!shouldPreserveDraft(document, record.select, options)) {
    patchFlowerRackOptions(record.select, view.options, document);
  }
  patchDraftValue(document, record.select, view.selectedArtId, options);
  setBooleanPropertyIfChanged(record.select, "disabled", view.disabled);
  setTextIfChanged(record.description, view.description);
  patchPending(record, view.hasData, view.pending);
  patchMetric(record.metrics, "flower-rack-metric-pending", view.pending);
  patchMetric(record.metrics, "flower-rack-selected-label", view.selectedLabel);
  setTextIfChanged(record.status, view.status || "-");
  setTextIfChanged(record.rule, view.rule || "");
  setBooleanPropertyIfChanged(record.rule, "hidden", !view.rule);
}

function patchFlowerRackOptions(select, options, document) {
  const desired = (Array.isArray(options) ? options : []).map((option) => ({
    value: option?.artId == null ? "" : String(option.artId),
    label: String(option?.label || ""),
  }));
  const current = Array.from(select.children || []);
  if (
    current.length === desired.length
    && current.every((node, index) => (
      node.getAttribute("value") === desired[index].value
      && node.textContent === desired[index].label
    ))
  ) return;

  const available = new Map(current.map((node) => [node.getAttribute("value") || "", node]));
  const nextNodes = desired.map((option) => {
    const node = available.get(option.value) || createElement(document, "option");
    setAttributeIfChanged(node, "value", option.value);
    setTextIfChanged(node, option.label);
    available.delete(option.value);
    return node;
  });
  for (const node of available.values()) select.removeChild(node);
  for (const node of nextNodes) select.append(node);
}

function createPearlCard(document, layoutClass) {
  const record = createCardShell(document, "pearl", "珍珠采集", layoutClass, { pending: true, status: true });
  const control = createElement(document, "label", ["queue-switch"]);
  setAttributeIfChanged(control, "for", "pearlHireItemReserveInput");
  const input = createControl(document, "input", "pearlHireItemReserveInput", {
    type: "number",
    min: "0",
    step: "1",
  });
  control.append(
    createTextLeaf(document, "span", "珍珠雇佣卡保留量"),
    input,
    createTextLeaf(document, "b", "默认保留 100 张，按账号独立保存"),
  );
  const rule = createElement(document, "p", ["queue-note"]);
  const serverRule = createTextLeaf(document, "span", "", "pearl-server-rule");
  const fallbackRule = createElement(document, "span");
  const fallbackReserve = createTextLeaf(document, "span", "", "pearl-rule-reserve");
  fallbackRule.append(
    createTextLeaf(document, "span", "始终保留 "),
    fallbackReserve,
    createTextLeaf(document, "span", " 张珍珠雇佣卡"),
  );
  rule.append(serverRule, fallbackRule);
  record.root.append(control, record.pending, record.status, rule);
  return { ...record, input, rule, serverRule, fallbackRule, fallbackReserve };
}

function patchPearlCard(record, view, document, options) {
  patchQueueState(record.root, view.state);
  patchDraftValue(document, record.input, view.reserve, options);
  setBooleanPropertyIfChanged(record.input, "disabled", view.disabled);
  patchPending(record, view.hasData, view.pending);
  setTextIfChanged(record.status, view.status || "-");
  setTextIfChanged(record.serverRule, view.rule || "");
  setBooleanPropertyIfChanged(record.serverRule, "hidden", !view.rule);
  setBooleanPropertyIfChanged(record.fallbackRule, "hidden", Boolean(view.rule));
  setTextIfChanged(record.fallbackReserve, view.reserve);
}

function createMaterialShopCard(document, layoutClass, costOptions) {
  const record = createCardShell(document, "material-shop", "材料商城", layoutClass, { pending: true, status: true });
  const enabledLabel = createElement(document, "label", ["queue-switch"]);
  setAttributeIfChanged(enabledLabel, "for", "materialShopMidnightRefreshToggle");
  const enabled = createControl(document, "input", "materialShopMidnightRefreshToggle", { type: "checkbox" });
  const enabledText = createTextLeaf(document, "b", "", "material-enabled-text");
  enabledLabel.append(enabled, createTextLeaf(document, "span", "午夜前主动刷新"), enabledText);
  const timeLabel = createElement(document, "label", ["queue-switch"]);
  setAttributeIfChanged(timeLabel, "for", "materialShopRefreshWindowStartInput");
  const time = createControl(document, "input", "materialShopRefreshWindowStartInput", { type: "time", step: "60" });
  timeLabel.append(createTextLeaf(document, "span", "开始时间"), time, createTextLeaf(document, "b", "至 24:00"));
  const costLabel = createElement(document, "label", ["queue-switch"]);
  setAttributeIfChanged(costLabel, "for", "materialShopRefreshMaxCostSelect");
  const cost = createControl(document, "select", "materialShopRefreshMaxCostSelect");
  for (const value of costOptions) {
    const option = createTextLeaf(document, "option", value === 0 ? "仅免费（0）" : `≤ ${value} 元宝`);
    setAttributeIfChanged(option, "value", value);
    cost.append(option);
  }
  costLabel.append(createTextLeaf(document, "span", "单次元宝价格上限"), cost, createTextLeaf(document, "b", "包含所选值"));
  const rule = createElement(document, "p", ["queue-note"]);
  const serverRule = createTextLeaf(document, "span", "", "material-server-rule");
  const fallbackRule = createElement(document, "span");
  fallbackRule.append(
    createTextLeaf(document, "span", "先用基础免费次数；付费单次价格 ≤ "),
    createTextLeaf(document, "span", "", "material-rule-max-cost"),
    createTextLeaf(document, "span", " 元宝（包含所选值），当前公式下最多累计 "),
    createTextLeaf(document, "span", "", "material-rule-max-spend"),
    createTextLeaf(document, "span", " 元宝"),
  );
  rule.append(serverRule, fallbackRule);
  record.root.append(enabledLabel, timeLabel, costLabel, record.pending, record.status, rule);
  return { ...record, enabled, enabledText, time, cost, rule, serverRule, fallbackRule };
}

function patchMaterialShopCard(record, view, document, options) {
  patchQueueState(record.root, view.state);
  setBooleanPropertyIfChanged(record.enabled, "checked", view.enabled);
  setBooleanPropertyIfChanged(record.enabled, "disabled", view.disabled);
  setTextIfChanged(record.enabledText, view.enabledText);
  patchDraftValue(document, record.time, view.windowStart, options);
  patchDraftValue(document, record.cost, view.maxCost, options);
  setBooleanPropertyIfChanged(record.time, "disabled", view.disabled);
  setBooleanPropertyIfChanged(record.cost, "disabled", view.disabled);
  patchPending(record, view.hasData, view.pending);
  setTextIfChanged(record.status, view.status || "-");
  setTextIfChanged(record.serverRule, view.rule || "");
  setBooleanPropertyIfChanged(record.serverRule, "hidden", !view.rule);
  setBooleanPropertyIfChanged(record.fallbackRule, "hidden", Boolean(view.rule));
  setTextIfChanged(findField(record.fallbackRule, "material-rule-max-cost"), view.maxCost);
  setTextIfChanged(findField(record.fallbackRule, "material-rule-max-spend"), view.maxSpend);
}

function createTeamOrderSettings(document, container) {
  const empty = createTextLeaf(
    document,
    "span",
    "选择账号后可查看和修改 49/99 组团触发放行与元宝续次数放行。",
    null,
    ["muted"],
  );
  const triggerLabel = createElement(document, "label", ["queue-switch", "team-order-protection-switch"]);
  setAttributeIfChanged(triggerLabel, "for", "teamOrderProtectionToggle");
  const trigger = createControl(document, "input", "teamOrderProtectionToggle", { type: "checkbox" });
  const triggerText = createElement(document, "span");
  const triggerProtected = createTextLeaf(document, "small", "未放行：在第 49/99 单停止，避免自动触发组团。");
  const triggerReleased = createTextLeaf(document, "small", "已放行：仅在双倍金币剩余超过3分钟时，才允许跨过 49/99 触发免费组团；是否付费续开由元宝续次数放行独立控制。");
  const triggerForced = createElement(document, "small");
  const doubleGold = createTextLeaf(document, "span", "", "team-trigger-double-gold");
  triggerForced.append(
    createTextLeaf(document, "span", "已放行（当前仍强制保护）：双倍金币剩余 "),
    doubleGold,
    createTextLeaf(document, "span", "，必须超过3分钟才允许跨过 49/99。"),
  );
  triggerText.append(
    createTextLeaf(document, "strong", "49/99 组团触发放行"),
    triggerProtected,
    triggerReleased,
    triggerForced,
  );
  triggerLabel.append(trigger, triggerText);
  const paidLabel = createElement(document, "label", ["queue-switch", "team-order-protection-switch", "team-order-paid-renew-switch"]);
  setAttributeIfChanged(paidLabel, "for", "teamOrderPaidRenewProtectionToggle");
  const paid = createControl(document, "input", "teamOrderPaidRenewProtectionToggle", { type: "checkbox" });
  const paidText = createElement(document, "span");
  const paidProtected = createTextLeaf(document, "small", "未放行：不会自动消费元宝续次数。");
  const paidReleased = createTextLeaf(document, "small", "已放行；当前每个自然触发的组团最多消费 60 元宝续开 1 次，并自动继续组团。");
  paidText.append(createTextLeaf(document, "strong", "元宝续次数放行"), paidProtected, paidReleased);
  paidLabel.append(paid, paidText);
  const guardLabel = createElement(document, "label", ["queue-switch", "team-order-guard-control"]);
  setAttributeIfChanged(guardLabel, "for", "teamOrderGuardMultiplierInput");
  const guardInputWrap = createElement(document, "span", ["team-order-guard-input-wrap"]);
  const guardInput = createControl(document, "input", "teamOrderGuardMultiplierInput", {
    type: "number",
    min: "0",
    max: "10",
    step: "0.01",
    inputmode: "decimal",
  });
  guardInputWrap.append(guardInput, createTextLeaf(document, "span", "倍"));
  const guardText = createElement(document, "span");
  const guardFormula = createTextLeaf(document, "small", "", "team-order-guard-formula");
  guardText.append(
    createTextLeaf(document, "strong", "组团经验守卫倍数"),
    createTextLeaf(document, "small", "按 账号历史最高单次组团经验 × 倍数 预留经验空间；0 表示不设守卫空间。"),
    guardFormula,
  );
  guardLabel.append(guardInputWrap, guardText);
  container.append(empty, triggerLabel, paidLabel, guardLabel);
  return {
    empty,
    triggerLabel,
    trigger,
    triggerProtected,
    triggerReleased,
    triggerForced,
    doubleGold,
    paidLabel,
    paid,
    paidProtected,
    paidReleased,
    guardLabel,
    guardInput,
    guardFormula,
  };
}

function patchTeamOrderSettings(record, view, document, options) {
  setBooleanPropertyIfChanged(record.empty, "hidden", view.hasProfile);
  setBooleanPropertyIfChanged(record.triggerLabel, "hidden", !view.hasProfile);
  setBooleanPropertyIfChanged(record.paidLabel, "hidden", !view.hasProfile);
  setBooleanPropertyIfChanged(record.trigger, "disabled", !view.hasProfile);
  setBooleanPropertyIfChanged(record.paid, "disabled", !view.hasProfile);
  setBooleanPropertyIfChanged(record.trigger, "checked", view.triggerReleaseEnabled);
  setBooleanPropertyIfChanged(record.paid, "checked", view.paidRenewReleaseEnabled);
  setBooleanPropertyIfChanged(record.triggerProtected, "hidden", view.triggerMode !== "protected");
  setBooleanPropertyIfChanged(record.triggerReleased, "hidden", view.triggerMode !== "released");
  setBooleanPropertyIfChanged(record.triggerForced, "hidden", view.triggerMode !== "forced");
  setTextIfChanged(record.doubleGold, view.doubleGoldRemaining);
  setBooleanPropertyIfChanged(record.paidProtected, "hidden", view.paidRenewReleaseEnabled);
  setBooleanPropertyIfChanged(record.paidReleased, "hidden", !view.paidRenewReleaseEnabled);
  toggleClassIfChanged(record.paidLabel, "protected", !view.paidRenewReleaseEnabled);
  toggleClassIfChanged(record.paidLabel, "unprotected", view.paidRenewReleaseEnabled);
  setBooleanPropertyIfChanged(record.guardLabel, "hidden", !view.hasProfile);
  setBooleanPropertyIfChanged(record.guardInput, "disabled", !view.hasProfile);
  patchDraftValue(document, record.guardInput, view.guardMultiplier, options);
  setAttributeIfChanged(record.guardInput, "aria-busy", view.guardMultiplierBusy ? "true" : "false");
  setTextIfChanged(record.guardFormula, view.guardFormulaText);
}

function patchTabs(tabs, activeTab) {
  for (const [key, button] of tabs) {
    const active = key === activeTab;
    toggleClassIfChanged(button, "active", active);
    setAttributeIfChanged(button, "aria-selected", active ? "true" : "false");
  }
}

function patchStopBanner(shell, stopInfo) {
  const visible = Boolean(stopInfo);
  setBooleanPropertyIfChanged(shell.stopBanner, "hidden", !visible);
  toggleClassIfChanged(shell.stopBanner, "visible", visible);
  setAttributeIfChanged(shell.stopBanner, "data-stop-kind", stopInfo?.kind || null);
  setTextIfChanged(shell.stopTitle, stopInfo?.title || "");
  setTextIfChanged(shell.stopMessage, stopInfo?.message || "");
}

function patchVisibility(records, active) {
  for (const record of Object.values(records)) {
    setBooleanPropertyIfChanged(record.root, "hidden", !active);
  }
}

function patchQueueState(root, state) {
  const activeState = QUEUE_STATES.includes(state) ? state : "idle";
  for (const name of QUEUE_STATES) toggleClassIfChanged(root, name, name === activeState);
}

function patchDraftValue(document, control, value, options) {
  if (shouldPreserveDraft(document, control, options)) return false;
  return setValueIfChanged(control, value);
}

function shouldPreserveDraft(document, control, options) {
  const dirty = options.dirtyControlIds?.has(control.id) === true;
  const force = options.forceControlIds?.has(control.id) === true;
  return dirty && document.activeElement === control && !force;
}

function createMetrics(document, definitions) {
  if (!definitions.length) return { root: null, nodes: new Map() };
  const root = createElement(document, "div", ["queue-stats"]);
  const nodes = new Map();
  for (const definition of definitions) {
    const metricRoot = createElement(document, "span", ["queue-stat"]);
    metricRoot.append(createTextLeaf(document, "span", definition.label));
    const valueWrap = createElement(document, "strong");
    for (const part of definition.parts) {
      if (part.field) {
        const node = createTextLeaf(document, "span", "", part.field);
        nodes.set(part.field, node);
        valueWrap.append(node);
      } else {
        valueWrap.append(createTextLeaf(document, "span", part.text));
      }
    }
    metricRoot.append(valueWrap);
    root.append(metricRoot);
  }
  return { root, nodes, get: (field) => nodes.get(field) };
}

function patchMetric(metrics, field, value) {
  setTextIfChanged(metrics.get(field), value);
}

function metric(label, field) {
  return { label, parts: [{ field }] };
}

function pairMetric(label, currentField, totalField) {
  return { label, parts: [{ field: currentField }, { text: "/" }, { field: totalField }] };
}

function videoMetric(label, valueField, videoField) {
  return { label, parts: [{ field: valueField }, { text: " " }, { field: videoField }] };
}

function prefixedMetric(label, prefix, field) {
  return { label, parts: [{ text: prefix }, { field }] };
}

function wrappedMetric(label, prefix, field, suffix) {
  return { label, parts: [{ text: prefix }, { field }, { text: suffix }] };
}

function createLabeledValue(document, label, field) {
  const root = createElement(document, "span", ["experience-guard-field"]);
  const value = createTextLeaf(document, "strong", "", field);
  root.append(createTextLeaf(document, "span", label), value);
  return { root, value };
}

function createControl(document, tagName, id, attributes = {}) {
  const control = createElement(document, tagName);
  control.id = id;
  for (const [name, value] of Object.entries(attributes)) setAttributeIfChanged(control, name, value);
  return control;
}

function createElement(document, tagName, classNames = []) {
  const node = document.createElement(tagName);
  if (classNames.length) node.classList.add(...classNames);
  return node;
}

function createTextLeaf(document, tagName, text, field = null, classNames = []) {
  const node = createElement(document, tagName, classNames);
  if (field) setAttributeIfChanged(node, "data-queue-field", field);
  setTextIfChanged(node, text);
  return node;
}

function findField(root, field) {
  if (root.getAttribute?.("data-queue-field") === field) return root;
  for (const child of root.children || []) {
    const match = findField(child, field);
    if (match) return match;
  }
  return null;
}
