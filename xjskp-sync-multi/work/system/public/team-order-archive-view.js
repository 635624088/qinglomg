import {
  setAttributeIfChanged,
  setBooleanPropertyIfChanged,
  setTextIfChanged,
  toggleClassIfChanged,
} from "./dom-patch.js";

const RENEWAL_STATES = ["paid", "ordinary"];

export function createTeamOrderArchiveRenderer(getNode) {
  const archiveList = getNode("teamOrderArchiveList");
  const pageText = getNode("teamOrderPageText");
  const document = archiveList.ownerDocument;
  const loading = createStateNode(document, "loading", "正在加载当前账号归档…");
  const error = createElement(document, "div", ["empty-state"]);
  setAttributeIfChanged(error, "data-team-order-state", "error");
  const errorMessage = createTextLeaf(document, "span", "", "error-message");
  error.append(createTextLeaf(document, "span", "组团归档加载失败："), errorMessage);
  const empty = createStateNode(document, "empty", "最近 7 天暂无已完成的组团订单。");
  const groupsHost = createElement(document, "div", ["team-order-groups"]);
  setAttributeIfChanged(groupsHost, "data-team-order-groups", "");
  archiveList.append(loading, error, empty, groupsHost);
  setBooleanPropertyIfChanged(error, "hidden", true);
  setBooleanPropertyIfChanged(empty, "hidden", true);
  setBooleanPropertyIfChanged(groupsHost, "hidden", true);
  const visibleDayCount = createTextLeaf(document, "span", "7", "visible-day-count");
  const visibleCount = createTextLeaf(document, "span", "0", "visible-count");
  pageText.append(
    createTextLeaf(document, "span", "最近 "),
    visibleDayCount,
    createTextLeaf(document, "span", " 天 · "),
    visibleCount,
    createTextLeaf(document, "span", " 条"),
  );
  const groupRecords = new Map();
  const itemRecords = new Map();

  return {
    render(view = {}) {
      const groups = Array.isArray(view.groups) ? view.groups : [];
      const mode = view.loading ? "loading" : view.error ? "error" : groups.length ? "groups" : "empty";
      setBooleanPropertyIfChanged(loading, "hidden", mode !== "loading");
      setBooleanPropertyIfChanged(error, "hidden", mode !== "error");
      setBooleanPropertyIfChanged(empty, "hidden", mode !== "empty");
      setBooleanPropertyIfChanged(groupsHost, "hidden", mode !== "groups");
      setTextIfChanged(errorMessage, view.error || "");
      setTextIfChanged(visibleDayCount, view.dayCount ?? "7");
      setTextIfChanged(visibleCount, view.visibleCount ?? "0");
      reconcileArchive(groupsHost, groupRecords, itemRecords, groups, view.profileId || null);
    },
  };
}

function reconcileArchive(groupsHost, groupRecords, itemRecords, groups, profileId) {
  const desiredGroups = [];
  const desiredGroupKeys = new Set();
  const desiredItemKeys = new Set();
  for (const group of groups) {
    const groupKey = String(group?.dateLabel || "");
    if (desiredGroupKeys.has(groupKey)) continue;
    desiredGroupKeys.add(groupKey);
    let groupRecord = groupRecords.get(groupKey);
    if (!groupRecord) {
      groupRecord = createDayGroupRecord(groupsHost.ownerDocument, groupKey);
      groupRecords.set(groupKey, groupRecord);
    }
    setTextIfChanged(groupRecord.dateLabel, group?.dateLabel || "-");
    setTextIfChanged(groupRecord.count, group?.count ?? `${group?.items?.length || 0} 条`);
    const desiredItems = [];
    for (const item of Array.isArray(group?.items) ? group.items : []) {
      const itemKey = archiveItemKey(item);
      if (desiredItemKeys.has(itemKey)) continue;
      desiredItemKeys.add(itemKey);
      let itemRecord = itemRecords.get(itemKey);
      if (!itemRecord) {
        itemRecord = createArchiveItemRecord(groupsHost.ownerDocument, itemKey);
        itemRecords.set(itemKey, itemRecord);
      }
      patchArchiveItemRecord(itemRecord, item, profileId);
      desiredItems.push(itemRecord);
    }
    reconcileOrder(groupRecord.grid, desiredItems);
    desiredGroups.push(groupRecord);
  }

  removeMissingRecords(itemRecords, desiredItemKeys);
  for (const [key, record] of groupRecords) {
    if (desiredGroupKeys.has(key)) continue;
    record.root.remove();
    groupRecords.delete(key);
  }
  reconcileOrder(groupsHost, desiredGroups);
}

function createDayGroupRecord(document, key) {
  const root = createElement(document, "section", ["team-order-day-group"]);
  setAttributeIfChanged(root, "data-team-order-date-key", key);
  const header = createElement(document, "header");
  const dateLabel = createTextLeaf(document, "strong", "");
  const countWrap = createElement(document, "span");
  const count = createTextLeaf(document, "span", "", "group-count");
  countWrap.append(count, createTextLeaf(document, "span", " 条"));
  header.append(dateLabel, countWrap);
  const grid = createElement(document, "div", ["team-order-day-grid"]);
  setAttributeIfChanged(grid, "data-team-order-items", "");
  root.append(header, grid);
  return { root, dateLabel, count, grid };
}

function createArchiveItemRecord(document, key) {
  const root = createElement(document, "article", ["team-order-archive-item"]);
  setAttributeIfChanged(root, "data-team-order-key", key);
  const heading = createElement(document, "div", ["team-order-card-heading"]);
  const headingMain = createElement(document, "div", ["team-order-card-heading-main"]);
  const finishedTime = createTextLeaf(document, "time", "", "finished-time");
  const renewal = createTextLeaf(document, "span", "", "renewal", ["team-order-renew-badge"]);
  headingMain.append(finishedTime, renewal);
  const detailLink = createTextLeaf(document, "a", "详情", null, ["team-order-detail-link"]);
  setAttributeIfChanged(detailLink, "target", "_blank");
  setAttributeIfChanged(detailLink, "rel", "noreferrer");
  const detailDisabled = createTextLeaf(
    document,
    "span",
    "详情不可用",
    null,
    ["team-order-detail-link", "disabled"],
  );
  heading.append(headingMain, detailLink, detailDisabled);
  const metrics = createElement(document, "div", ["team-order-card-metrics"]);
  const actions = createElement(document, "div", ["team-order-card-metric-row", "actions"]);
  const submitted = createMetric(document, "提交", "submitted");
  const refreshed = createMetric(document, "刷新", "refreshed");
  const skipped = createMetric(document, "跳过", "skipped");
  actions.append(submitted.root, refreshed.root, skipped.root);
  const rewards = createElement(document, "div", ["team-order-card-metric-row", "rewards"]);
  const experience = createMetric(document, "经验", "experience");
  const gold = createMetric(document, "金币", "gold");
  rewards.append(experience.root, gold.root);
  metrics.append(actions, rewards);
  root.append(heading, metrics);
  return {
    root,
    finishedTime,
    renewal,
    detailLink,
    detailDisabled,
    submitted: submitted.value,
    refreshed: refreshed.value,
    skipped: skipped.value,
    experience: experience.value,
    gold: gold.value,
  };
}

function patchArchiveItemRecord(record, item, profileId) {
  setAttributeIfChanged(record.root, "data-team-order-id", item?.runId || "");
  setAttributeIfChanged(record.finishedTime, "datetime", item?.finishedAt || null);
  setTextIfChanged(record.finishedTime, item?.timeText ?? "-");
  const renewalState = item?.paidRenew === true ? "paid" : "ordinary";
  patchExclusiveClass(record.renewal, RENEWAL_STATES, renewalState);
  setTextIfChanged(record.renewal, item?.renewalText ?? (item?.paidRenew === true ? "元宝续开" : "普通轮"));
  setTextIfChanged(record.submitted, item?.submitted ?? "0");
  setTextIfChanged(record.refreshed, item?.refreshed ?? "0");
  setTextIfChanged(record.skipped, item?.skipped ?? "0");
  setTextIfChanged(record.experience, item?.experience ?? "-");
  setTextIfChanged(record.gold, item?.gold ?? "-");
  const hasDetail = Boolean(profileId && item?.htmlName);
  setBooleanPropertyIfChanged(record.detailLink, "hidden", !hasDetail);
  setBooleanPropertyIfChanged(record.detailDisabled, "hidden", hasDetail);
  setAttributeIfChanged(record.detailLink, "data-team-order-field", hasDetail ? "detail" : null);
  setAttributeIfChanged(record.detailDisabled, "data-team-order-field", hasDetail ? null : "detail");
  setAttributeIfChanged(
    record.detailLink,
    "href",
    hasDetail
      ? `/artifacts/${encodeURIComponent(profileId)}/team-orders/${encodeURIComponent(item.htmlName)}`
      : null,
  );
}

function archiveItemKey(item) {
  const runId = item?.runId === null || item?.runId === undefined ? "" : String(item.runId);
  if (runId) return runId;
  return `${String(item?.finishedAt || "")}+${String(item?.htmlName || "")}`;
}

function createStateNode(document, state, text) {
  const node = createElement(document, "div", ["empty-state"]);
  setAttributeIfChanged(node, "data-team-order-state", state);
  setTextIfChanged(node, text);
  return node;
}

function createMetric(document, label, field) {
  const root = createElement(document, "span");
  const value = createTextLeaf(document, "b", "", field);
  root.append(createTextLeaf(document, "small", label), value);
  return { root, value };
}

function removeMissingRecords(records, desiredKeys) {
  for (const [key, record] of records) {
    if (desiredKeys.has(key)) continue;
    record.root.remove();
    records.delete(key);
  }
}

function reconcileOrder(container, desired) {
  const oldIndex = new Map(Array.from(container.children).map((node, index) => [node, index]));
  const sequence = desired.map((record) => oldIndex.get(record.root) ?? -1);
  const stablePositions = new Set(longestIncreasingSubsequencePositions(sequence));
  for (let index = desired.length - 1; index >= 0; index -= 1) {
    const record = desired[index];
    const anchor = desired[index + 1]?.root || null;
    if (sequence[index] < 0 || !stablePositions.has(index)) container.insertBefore(record.root, anchor);
  }
}

function longestIncreasingSubsequencePositions(values) {
  const tails = [];
  const tailPositions = [];
  const previous = new Array(values.length).fill(-1);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value < 0) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle] < value) low = middle + 1;
      else high = middle;
    }
    tails[low] = value;
    previous[index] = low > 0 ? tailPositions[low - 1] : -1;
    tailPositions[low] = index;
  }
  const result = [];
  let cursor = tailPositions[tails.length - 1];
  while (cursor !== undefined && cursor >= 0) {
    result.push(cursor);
    cursor = previous[cursor];
  }
  return result.reverse();
}

function patchExclusiveClass(node, states, activeState) {
  for (const state of states) toggleClassIfChanged(node, state, state === activeState);
}

function createElement(document, tagName, classNames = []) {
  const node = document.createElement(tagName);
  if (classNames.length) node.classList.add(...classNames);
  return node;
}

function createTextLeaf(document, tagName, text, field = null, classNames = []) {
  const node = createElement(document, tagName, classNames);
  if (field) setAttributeIfChanged(node, "data-team-order-field", field);
  setTextIfChanged(node, text);
  return node;
}
