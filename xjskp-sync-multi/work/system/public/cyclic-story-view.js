import {
  setAttributeIfChanged,
  setBooleanPropertyIfChanged,
  setTextIfChanged,
  toggleClassIfChanged,
} from "./dom-patch.js";

const ACTIVE_PHASE = 2;
const SLOT_COUNT = 3;
const CARD_STATES = ["pending", "idle", "blocked"];
const SLOT_STATES = ["ready", "cooling", "shortage", "unknown"];
const FIXED_RULE = "规则：仅阶段2；冷却结束且库存充足时提交；每轮最多3单，不刷新/付费";
const HIGHEST_EXPERIENCE_RULE = "最高经验模式：锁定当前3单；任一单冷却时整轮等待，三单均结束后只提交经验最高的一单；缺库存不降级";

export function buildCyclicStoryView(row, fallbackCyclicStory, options) {
  const story = row?.cyclicStory || fallbackCyclicStory || {};
  const phaseView = getPhaseView(story);
  const phaseOpen = phaseView.phase === ACTIVE_PHASE;
  const orders = Array.isArray(story.orders) ? story.orders.slice(0, SLOT_COUNT) : [];
  const pending = row?.pending ?? story.pendingAutoSubmitActions?.length ?? 0;
  const cardState = row?.state === "blocked" ? "blocked" : Number(pending) > 0 ? "pending" : "idle";
  const phaseStatus = phaseOpen
    ? row?.status || story.reasonText || phaseView.statusText
    : phaseView.statusText;
  const autoSubmitEnabled = options?.autoSubmitEnabled
    ?? story.autoSubmitEnabled
    ?? false;
  const onlyHighestExperienceEnabled = options?.onlyHighestExperienceEnabled
    ?? story.onlyHighestExperienceEnabled
    ?? story.onlyHighestExperienceOrder
    ?? false;
  return {
    cardState,
    pendingCount: displayValue(pending, "0"),
    phase: phaseView.phase,
    phaseText: phaseView.phaseText,
    phaseStatus,
    phaseRemaining: formatPhaseRemaining(story.phaseRemainingMs),
    orderCount: String(phaseOpen ? orders.length : 0),
    scoreItemName: story.scoreItemName || "花史残页",
    score: displayValue(story.score),
    expCurrent: displayValue(story.expOrderNum),
    expMax: displayValue(story.expOrderMax),
    slots: Array.from({ length: SLOT_COUNT }, (_, index) => (
      phaseOpen ? buildOpenSlot(orders[index]) : buildInactiveSlot(phaseView)
    )),
    autoSubmitEnabled: Boolean(autoSubmitEnabled),
    enabledText: autoSubmitEnabled ? "开启" : "关闭",
    onlyHighestExperienceEnabled: Boolean(onlyHighestExperienceEnabled),
    onlyHighestExperienceEnabledText: onlyHighestExperienceEnabled ? "开启" : "关闭",
    onlyHighestExperienceDisabled: !options?.hasProfile || !autoSubmitEnabled,
    disabled: !options?.hasProfile,
  };
}

export function createCyclicStoryRenderer(document, layoutClass = "queue-layout-activities-1") {
  const root = createElement(document, "div", [
    "queue-card", "cyclic-story-queue-card", ...String(layoutClass).split(/\s+/).filter(Boolean),
  ]);
  const nodes = createCardNodes(document, root);
  return {
    root,
    render(view) {
      patchExclusiveClass(root, CARD_STATES, view.cardState);
      setTextIfChanged(nodes.pending, view.pendingCount);
      setTextIfChanged(nodes.phase, view.phaseText);
      setTextIfChanged(nodes.phaseRemaining, view.phaseRemaining);
      setTextIfChanged(nodes.orderCount, view.orderCount);
      setTextIfChanged(nodes.scoreName, view.scoreItemName);
      setTextIfChanged(nodes.score, view.score);
      setTextIfChanged(nodes.expCurrent, view.expCurrent);
      setTextIfChanged(nodes.expMax, view.expMax);
      setTextIfChanged(nodes.phaseStatus, view.phaseStatus);
      setBooleanPropertyIfChanged(nodes.autoSubmitInput, "checked", view.autoSubmitEnabled);
      setBooleanPropertyIfChanged(nodes.autoSubmitInput, "disabled", view.disabled);
      setTextIfChanged(nodes.autoSubmitEnabledText, view.enabledText);
      setBooleanPropertyIfChanged(
        nodes.onlyHighestExperienceInput,
        "checked",
        view.onlyHighestExperienceEnabled,
      );
      setBooleanPropertyIfChanged(
        nodes.onlyHighestExperienceInput,
        "disabled",
        view.onlyHighestExperienceDisabled,
      );
      setTextIfChanged(
        nodes.onlyHighestExperienceEnabledText,
        view.onlyHighestExperienceEnabledText,
      );
      for (let index = 0; index < SLOT_COUNT; index += 1) {
        patchSlot(nodes.slots[index], view.slots[index]);
      }
    },
  };
}

function createCardNodes(document, root) {
  const stats = createElement(document, "div", ["queue-stats"]);
  const pending = createStat(document, stats, "待提交", "pending").value;
  const phase = createStat(document, stats, "阶段", "phase").value;
  const phaseRemaining = createStat(document, stats, "阶段剩余", "phase-remaining").value;
  const orderCount = createStat(document, stats, "当前订单", "order-count").value;
  const scoreStat = createStat(document, stats, "", "score");
  const scoreName = scoreStat.label;
  setAttributeIfChanged(scoreName, "data-cyclic-story-field", "score-name");
  const expStat = createElement(document, "span", ["queue-stat"]);
  const expValue = createElement(document, "strong");
  const expCurrent = createField(document, "span", "exp-current");
  const expMax = createField(document, "span", "exp-max");
  expValue.append(expCurrent, createText(document, "span", "/"), expMax);
  expStat.append(createText(document, "span", "经验订单"), expValue);
  stats.append(expStat);

  const phaseStatus = createField(document, "small", "phase-status");
  const grid = createElement(document, "div", ["cyclic-story-order-grid"]);
  const slots = Array.from({ length: SLOT_COUNT }, (_, index) => createSlot(document, index + 1));
  grid.append(...slots.map((slot) => slot.root));
  const autoSubmitControl = createElement(document, "label", ["queue-switch", "cyclic-story-auto-submit-switch"]);
  setAttributeIfChanged(autoSubmitControl, "for", "cyclicStoryAutoSubmitToggle");
  const autoSubmitInput = createElement(document, "input");
  setAttributeIfChanged(autoSubmitInput, "type", "checkbox");
  setAttributeIfChanged(autoSubmitInput, "id", "cyclicStoryAutoSubmitToggle");
  const autoSubmitEnabledText = createField(document, "b", "auto-submit-enabled");
  autoSubmitControl.append(
    autoSubmitInput,
    createText(document, "span", "自动提交莳花纪闻订单"),
    autoSubmitEnabledText,
  );
  const onlyHighestExperienceControl = createElement(document, "label", [
    "queue-switch",
    "cyclic-story-highest-experience-switch",
  ]);
  setAttributeIfChanged(
    onlyHighestExperienceControl,
    "for",
    "cyclicStoryOnlyHighestExperienceToggle",
  );
  const onlyHighestExperienceInput = createElement(document, "input");
  setAttributeIfChanged(onlyHighestExperienceInput, "type", "checkbox");
  setAttributeIfChanged(
    onlyHighestExperienceInput,
    "id",
    "cyclicStoryOnlyHighestExperienceToggle",
  );
  const onlyHighestExperienceText = createElement(document, "span");
  const onlyHighestExperienceDescription = createText(
    document,
    "small",
    "任一当前订单冷却时整轮等待；最高经验单缺库存不降级",
  );
  const onlyHighestExperienceEnabledText = createField(
    document,
    "b",
    "only-highest-experience-enabled",
  );
  onlyHighestExperienceText.append(
    createText(document, "strong", "只做最高经验订单"),
    onlyHighestExperienceDescription,
  );
  onlyHighestExperienceControl.append(
    onlyHighestExperienceInput,
    onlyHighestExperienceText,
    onlyHighestExperienceEnabledText,
  );
  const rule = createElement(document, "p", ["queue-note"]);
  setTextIfChanged(rule, `${FIXED_RULE}；${HIGHEST_EXPERIENCE_RULE}`);
  root.append(stats, autoSubmitControl, onlyHighestExperienceControl, phaseStatus, grid, rule);
  return {
    pending,
    phase,
    phaseRemaining,
    orderCount,
    scoreName,
    score: scoreStat.value,
    expCurrent,
    expMax,
    phaseStatus,
    autoSubmitInput,
    autoSubmitEnabledText,
    onlyHighestExperienceInput,
    onlyHighestExperienceDescription,
    onlyHighestExperienceEnabledText,
    slots,
  };
}

function createSlot(document, slotNo) {
  const root = createElement(document, "section", ["cyclic-story-order-panel"]);
  setAttributeIfChanged(root, "data-cyclic-story-slot", slotNo);
  const header = createElement(document, "header");
  const title = createText(document, "strong", `提交面板 ${slotNo}`);
  const status = createElement(document, "span");
  const genericStatus = createField(document, "span", `slot-${slotNo}-status-generic`);
  const coolingStatus = createText(document, "span", "冷却中，暂不可提交");
  const shortageStatus = createElement(document, "span");
  const missing = createField(document, "span", `slot-${slotNo}-missing`);
  shortageStatus.append(createText(document, "span", "库存不足，缺"), missing, createText(document, "span", "朵"));
  status.append(genericStatus, coolingStatus, shortageStatus);
  header.append(title, status);

  const message = createField(document, "p", `slot-${slotNo}-empty-message`);
  const orderContent = createElement(document, "div", ["cyclic-story-order-content"]);
  const flower = createElement(document, "div", ["cyclic-story-flower"]);
  const flowerTitle = createElement(document, "strong");
  const flowerName = createField(document, "span", `slot-${slotNo}-flower-name`);
  const headlineCost = createField(document, "span", `slot-${slotNo}-headline-cost`);
  flowerTitle.append(flowerName, createText(document, "span", " × "), headlineCost);
  const flowerMeta = createElement(document, "small");
  const flowerId = createField(document, "span", `slot-${slotNo}-flower-id`);
  flowerMeta.append(createText(document, "span", "本单只消耗这一种花 · 花朵 ID "), flowerId);
  flower.append(flowerTitle, flowerMeta);

  const metrics = createElement(document, "div", ["cyclic-story-order-metrics"]);
  const stockMetric = createElement(document, "div", ["cyclic-story-order-metric"]);
  const stockValue = createElement(document, "strong");
  const demand = createField(document, "span", `slot-${slotNo}-demand`);
  const inventory = createField(document, "span", `slot-${slotNo}-inventory`);
  stockValue.append(demand, createText(document, "span", "/"), inventory);
  stockMetric.append(createText(document, "span", "需求/库存"), stockValue);
  metrics.append(stockMetric);
  const cooldown = createMetric(document, metrics, "冷却", `slot-${slotNo}-cooldown`);
  const page = createMetric(document, metrics, "残页", `slot-${slotNo}-page`);
  const experience = createMetric(document, metrics, "经验", `slot-${slotNo}-experience`);
  const gold = createMetric(document, metrics, "金币", `slot-${slotNo}-gold`);
  orderContent.append(flower, metrics);
  root.append(header, message, orderContent);
  return {
    root,
    genericStatus,
    coolingStatus,
    shortageStatus,
    missing,
    message,
    orderContent,
    flowerName,
    headlineCost,
    flowerId,
    stockMetric,
    demand,
    inventory,
    cooldown,
    page,
    experience,
    gold,
  };
}

function patchSlot(nodes, view) {
  const hasOrder = view.mode === "order";
  toggleClassIfChanged(nodes.root, "empty", !hasOrder);
  toggleClassIfChanged(nodes.root, "waiting", view.mode === "inactive");
  for (const state of SLOT_STATES) {
    toggleClassIfChanged(nodes.root, state, hasOrder && state === view.state);
  }
  setBooleanPropertyIfChanged(nodes.genericStatus, "hidden", view.statusKind !== "generic");
  setBooleanPropertyIfChanged(nodes.coolingStatus, "hidden", view.statusKind !== "cooling");
  setBooleanPropertyIfChanged(nodes.shortageStatus, "hidden", view.statusKind !== "shortage");
  if (view.statusKind === "generic") setTextIfChanged(nodes.genericStatus, view.statusText);
  if (view.statusKind === "shortage") setTextIfChanged(nodes.missing, view.missing);
  setBooleanPropertyIfChanged(nodes.message, "hidden", hasOrder);
  if (!hasOrder) setTextIfChanged(nodes.message, view.messageText);
  setBooleanPropertyIfChanged(nodes.orderContent, "hidden", !hasOrder);
  if (!hasOrder) return;
  setTextIfChanged(nodes.flowerName, view.flowerName);
  setTextIfChanged(nodes.headlineCost, view.cost);
  setTextIfChanged(nodes.flowerId, view.flowerId);
  setTextIfChanged(nodes.demand, view.cost);
  setTextIfChanged(nodes.inventory, view.have);
  setTextIfChanged(nodes.cooldown, view.cooldown);
  setTextIfChanged(nodes.page, view.page);
  setTextIfChanged(nodes.experience, view.experience);
  setTextIfChanged(nodes.gold, view.gold);
  toggleClassIfChanged(nodes.stockMetric, "shortage", Number(view.missing) > 0);
}

function buildInactiveSlot(phaseView) {
  return {
    mode: "inactive",
    state: "unknown",
    statusKind: "generic",
    statusText: phaseView.slotStatus,
    messageText: phaseView.slotText,
  };
}

function buildOpenSlot(order) {
  if (!order) return {
    mode: "empty",
    state: "unknown",
    statusKind: "generic",
    statusText: "暂无订单",
    messageText: "等待服务端返回该槽位的订单详情",
  };
  const state = order.status === "ready"
    ? "ready"
    : order.status === "inventory-shortage"
      ? "shortage"
      : order.status === "cooling" ? "cooling" : "unknown";
  const statusKind = state === "cooling" ? "cooling" : state === "shortage" ? "shortage" : "generic";
  return {
    mode: "order",
    state,
    statusKind,
    statusText: order.statusText || order.status || "数据不完整",
    messageText: "",
    flowerName: order.flowerName || `花朵-${displayValue(order.flowerId)}`,
    flowerId: displayValue(order.flowerId),
    cost: order.cost == null ? "未知" : displayValue(order.cost),
    have: order.cost == null ? "未知" : displayValue(order.have),
    missing: displayValue(order.missing),
    cooldown: formatRemaining(order.remainingMs),
    page: getPageCount(order),
    experience: order.expectedExperience == null ? "未知" : displayValue(order.expectedExperience),
    gold: order.expectedGold == null ? "未知" : displayValue(order.expectedGold),
  };
}

function getPhaseView(story) {
  const phase = Number(story.phase);
  if (phase === 0) return phaseView(0, "未开放（阶段0）", "尚未进入预告期", "尚未开放", "等待活动预告");
  if (phase === 1) return phaseView(1, "预告期（阶段1）", "活动尚未开始；进入阶段2后刷新订单", "预告期", "活动开始后刷新订单");
  if (phase === ACTIVE_PHASE) return phaseView(2, "进行期（阶段2）", "可提交冷却结束且库存充足的订单", "进行中", "");
  if (phase === 3) return phaseView(3, "兑换期（阶段3）", "订单提交已结束；当前仅为兑换期", "提交已结束", "该阶段不再显示订单");
  if (phase === 4) return phaseView(4, "已结束（阶段4）", "活动已结束，不能提交", "活动已结束", "等待下一期活动");
  return phaseView("unknown", story.phaseText || "阶段未知", story.reasonText || "活动时间数据不完整，不能判断是否可提交", "阶段未知", "等待活动时间数据");
}

function phaseView(phase, phaseText, statusText, slotStatus, slotText) {
  return { phase, phaseText, statusText, slotStatus, slotText };
}

function formatRemaining(value) {
  if (value == null) return "--:--";
  const seconds = Number(value) <= 0 ? 0 : Math.ceil(Number(value) / 1_000);
  if (!Number.isFinite(seconds)) return "--:--";
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatPhaseRemaining(value) {
  if (value == null) return "--:--";
  const seconds = Number(value) <= 0 ? 0 : Math.ceil(Number(value) / 1_000);
  if (!Number.isFinite(seconds)) return "--:--";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  return `${days}天${padTwoDigits(hours)}时${padTwoDigits(minutes)}分${padTwoDigits(remainingSeconds)}秒`;
}

function padTwoDigits(value) {
  return String(value).padStart(2, "0");
}

function getPageCount(order) {
  const rewards = Array.isArray(order?.rewards) ? order.rewards : [];
  const reward = rewards.find((item) => String(item?.name || "").includes("残页")) || rewards[0];
  return reward?.count == null ? "未知" : displayValue(reward.count);
}

function displayValue(value, fallback = "-") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function createStat(document, parent, labelText, field) {
  const root = createElement(document, "span", ["queue-stat"]);
  const label = createText(document, "span", labelText);
  const value = createField(document, "strong", field);
  root.append(label, value);
  parent.append(root);
  return { root, label, value };
}

function createMetric(document, parent, labelText, field) {
  const root = createElement(document, "div", ["cyclic-story-order-metric"]);
  const value = createField(document, "strong", field);
  root.append(createText(document, "span", labelText), value);
  parent.append(root);
  return value;
}

function createField(document, tagName, field) {
  const node = createElement(document, tagName);
  setAttributeIfChanged(node, "data-cyclic-story-field", field);
  return node;
}

function createText(document, tagName, text) {
  const node = createElement(document, tagName);
  setTextIfChanged(node, text);
  return node;
}

function createElement(document, tagName, classes = []) {
  const node = document.createElement(tagName);
  for (const className of classes) toggleClassIfChanged(node, className, true);
  return node;
}

function patchExclusiveClass(node, classes, activeClass) {
  for (const className of classes) toggleClassIfChanged(node, className, className === activeClass);
}
