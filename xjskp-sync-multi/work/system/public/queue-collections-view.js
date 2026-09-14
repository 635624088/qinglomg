import {
  setAttributeIfChanged,
  setBooleanPropertyIfChanged,
  setTextIfChanged,
  toggleClassIfChanged,
} from "./dom-patch.js";

const ORDINARY_SLOT_COUNT = 6;
const ORDINARY_SLOT_STATES = ["empty", "refill", "video", "ready", "blocked"];
const CYCLIC_NOTE_STATES = ["pending", "idle", "blocked"];

export function createQueueCollectionsRenderer(getNode) {
  const ordinaryHost = getNode("ordinaryResidentSlotsHost");
  const cyclicNoteHost = getNode("cyclicNoteHost");
  const document = ordinaryHost.ownerDocument;
  ordinaryHost.classList.add("ordinary-resident-order-slots");
  const ordinarySlots = Array.from(
    { length: ORDINARY_SLOT_COUNT },
    (_, index) => createOrdinarySlot(document, index + 1),
  );
  ordinaryHost.append(...ordinarySlots.map((record) => record.root));
  for (const record of ordinarySlots) patchOrdinarySlot(record, emptyOrdinarySlot(record.boxId));
  let cyclicNote = null;

  return {
    renderOrdinary(view = {}) {
      const byBoxId = new Map(
        (Array.isArray(view.slots) ? view.slots : [])
          .map((slot) => [Number(slot?.boxId), slot])
          .filter(([boxId]) => Number.isInteger(boxId) && boxId >= 1 && boxId <= ORDINARY_SLOT_COUNT),
      );
      for (const record of ordinarySlots) {
        patchOrdinarySlot(record, byBoxId.get(record.boxId) || emptyOrdinarySlot(record.boxId));
      }
    },
    renderCyclicNote(view) {
      if (!view) {
        cyclicNote?.root.remove();
        return;
      }
      if (!cyclicNote) cyclicNote = createCyclicNoteCard(document);
      if (cyclicNote.root.parentNode !== cyclicNoteHost) cyclicNoteHost.append(cyclicNote.root);
      patchCyclicNoteCard(cyclicNote, view);
    },
  };
}

function createOrdinarySlot(document, boxId) {
  const root = createElement(document, "div", ["ordinary-resident-order-slot"]);
  setAttributeIfChanged(root, "data-ordinary-resident-slot", boxId);
  setAttributeIfChanged(root, "aria-label", `普通居民订单槽位 ${boxId}`);
  const empty = createTextLeaf(document, "span", "空槽位");
  const refill = createElement(document, "span");
  const refillCountdown = createElement(document, "span");
  const refillSeconds = createTextLeaf(
    document,
    "span",
    "",
    "data-ordinary-resident-field",
    `slot-${boxId}-refill-seconds`,
  );
  refillCountdown.append(
    createTextLeaf(document, "span", "等待补位 "),
    refillSeconds,
    createTextLeaf(document, "span", "秒"),
  );
  const refillService = createTextLeaf(document, "span", "等待服务端补位");
  refill.append(refillCountdown, refillService);
  const video = createTextLeaf(document, "span", "视频订单");
  const waiting = createTextLeaf(document, "span", "等待刷新");
  const requirements = createElement(document, "span", ["ordinary-resident-order-requirements"]);
  root.append(empty, refill, video, waiting, requirements);
  return {
    boxId,
    root,
    empty,
    refill,
    refillCountdown,
    refillSeconds,
    refillService,
    video,
    waiting,
    requirements,
    requirementRecords: new Map(),
  };
}

function patchOrdinarySlot(record, slot) {
  const mode = ["empty", "refill", "video", "order"].includes(slot.mode) ? slot.mode : "empty";
  const state = mode === "order"
    ? (slot.state === "ready" ? "ready" : "blocked")
    : mode;
  patchExclusiveClass(record.root, ORDINARY_SLOT_STATES, state);
  setBooleanPropertyIfChanged(record.empty, "hidden", mode !== "empty");
  setBooleanPropertyIfChanged(record.refill, "hidden", mode !== "refill");
  setBooleanPropertyIfChanged(record.video, "hidden", mode !== "video");
  const requirements = mode === "order" ? normalizeRequirements(slot.requirements) : [];
  const hasRequirements = requirements.length > 0;
  setBooleanPropertyIfChanged(record.waiting, "hidden", mode !== "order" || hasRequirements);
  setBooleanPropertyIfChanged(record.requirements, "hidden", mode !== "order" || !hasRequirements);
  const serviceWaiting = slot.serviceWaiting === true;
  setBooleanPropertyIfChanged(record.refillCountdown, "hidden", mode !== "refill" || serviceWaiting);
  setBooleanPropertyIfChanged(record.refillService, "hidden", mode !== "refill" || !serviceWaiting);
  setTextIfChanged(record.refillSeconds, slot.remainingSeconds ?? "0");
  reconcileRequirementRecords(record, requirements);
}

function normalizeRequirements(requirements) {
  const occurrences = new Map();
  return (Array.isArray(requirements) ? requirements : []).map((requirement) => {
    const itemId = String(requirement?.itemId ?? "");
    const occurrence = (occurrences.get(itemId) || 0) + 1;
    occurrences.set(itemId, occurrence);
    return {
      key: `${itemId}:${occurrence}`,
      name: requirement?.name ?? "",
      need: requirement?.need ?? "-",
    };
  });
}

function reconcileRequirementRecords(slot, requirements) {
  const desired = [];
  const desiredKeys = new Set();
  for (const requirement of requirements) {
    if (desiredKeys.has(requirement.key)) continue;
    desiredKeys.add(requirement.key);
    let record = slot.requirementRecords.get(requirement.key);
    if (!record) {
      record = createRequirementRecord(slot.root.ownerDocument, requirement.key);
      slot.requirementRecords.set(requirement.key, record);
    }
    setTextIfChanged(record.name, requirement.name);
    setTextIfChanged(record.need, requirement.need);
    desired.push(record);
  }
  removeMissingRecords(slot.requirementRecords, desiredKeys);
  reconcileOrder(slot.requirements, desired);
}

function createRequirementRecord(document, key) {
  const root = createElement(document, "span");
  setAttributeIfChanged(root, "data-ordinary-resident-item-key", key);
  const name = createTextLeaf(document, "span", "", "data-ordinary-resident-item-field", "name");
  const need = createTextLeaf(document, "span", "", "data-ordinary-resident-item-field", "need");
  root.append(name, createTextLeaf(document, "span", "*"), need);
  return { root, name, need };
}

function createCyclicNoteCard(document) {
  const root = createElement(document, "div", ["queue-card", "cyclic-note-queue-card"]);
  setAttributeIfChanged(root, "data-queue-card", "cyclic-note");
  const pending = createTextLeaf(document, "span", "", "data-cyclic-note-field", "pending");
  const pendingWrap = createElement(document, "span");
  pendingWrap.append(pending, createTextLeaf(document, "span", " 项可领取"));
  const header = createElement(document, "div", ["cyclic-note-card-header"]);
  const metrics = createElement(document, "div", ["queue-stats"]);
  const phase = createMetric(document, "阶段", "phase");
  const phaseRemaining = createMetric(document, "阶段剩余", "phase-remaining");
  const taskCount = createMetric(document, "当前任务", "task-count");
  const score = createMetric(document, "集芳进度", "score");
  metrics.append(phase.root, phaseRemaining.root, taskCount.root, score.root);
  header.append(createTextLeaf(document, "strong", "花笺集芳"), pendingWrap, metrics);
  const status = createTextLeaf(document, "small", "", "data-cyclic-note-field", "status");
  const taskList = createElement(document, "div", ["cyclic-note-task-list", "cyclic-note-task-grid"]);
  setAttributeIfChanged(taskList, "data-cyclic-note-task-list", "true");
  const emptyTask = createElement(document, "div", ["cyclic-note-task-line"]);
  emptyTask.append(createTextLeaf(document, "span", "暂无当前任务"));
  taskList.append(emptyTask);
  const rule = createTextLeaf(document, "p", "", "data-cyclic-note-field", "rule", ["queue-note"]);
  const autoHandleControl = createElement(document, "label", ["queue-switch", "cyclic-story-auto-submit-switch"]);
  setAttributeIfChanged(autoHandleControl, "for", "cyclicNoteAutomationToggle");
  const autoHandleInput = createElement(document, "input");
  setAttributeIfChanged(autoHandleInput, "id", "cyclicNoteAutomationToggle");
  setAttributeIfChanged(autoHandleInput, "type", "checkbox");
  const autoHandleText = createTextLeaf(document, "b", "", "data-cyclic-note-field", "automation-enabled");
  autoHandleControl.append(
    autoHandleInput,
    createTextLeaf(document, "span", "自动进行花笺集芳任务"),
    autoHandleText,
  );
  const autoCompleteControl = createElement(document, "label", ["queue-switch", "cyclic-story-highest-experience-switch"]);
  setAttributeIfChanged(autoCompleteControl, "for", "cyclicNoteNaturalCompletionToggle");
  const autoCompleteInput = createElement(document, "input");
  setAttributeIfChanged(autoCompleteInput, "id", "cyclicNoteNaturalCompletionToggle");
  setAttributeIfChanged(autoCompleteInput, "type", "checkbox");
  const autoCompleteText = createTextLeaf(document, "b", "", "data-cyclic-note-field", "natural-enabled");
  const autoCompleteCopy = createElement(document, "span");
  autoCompleteCopy.append(
    createTextLeaf(document, "strong", "只做最高集芳笺任务"),
    createTextLeaf(document, "small", "真实执行既有自动任务，不用元宝立即完成"),
  );
  autoCompleteControl.append(
    autoCompleteInput,
    autoCompleteCopy,
    autoCompleteText,
  );
  root.append(
    autoHandleControl,
    autoCompleteControl,
    header,
    status,
    taskList,
    rule,
  );
  return {
    root,
    pending,
    phase: phase.value,
    phaseRemaining: phaseRemaining.value,
    taskCount: taskCount.value,
    score: score.value,
    status,
    taskList,
    emptyTask,
    rule,
    autoHandleInput,
    autoHandleText,
    autoCompleteInput,
    autoCompleteText,
    taskRecords: new Map(),
  };
}

function patchCyclicNoteCard(record, view) {
  const state = CYCLIC_NOTE_STATES.includes(view.state) ? view.state : "idle";
  patchExclusiveClass(record.root, CYCLIC_NOTE_STATES, state);
  setTextIfChanged(record.pending, view.pending ?? "0");
  setTextIfChanged(record.phase, view.phase ?? "-");
  setTextIfChanged(record.phaseRemaining, view.phaseRemaining ?? "--:--");
  setTextIfChanged(record.taskCount, view.taskCount ?? "0");
  setTextIfChanged(record.score, view.score ?? "-");
  setTextIfChanged(record.status, view.status ?? "-");
  setBooleanPropertyIfChanged(record.autoHandleInput, "checked", view.autoHandleEnabled === true);
  setBooleanPropertyIfChanged(record.autoHandleInput, "disabled", view.autoHandleDisabled === true);
  setTextIfChanged(record.autoHandleText, view.autoHandleEnabled ? "自动执行已开启" : "自动执行已关闭");
  setBooleanPropertyIfChanged(record.autoCompleteInput, "checked", view.autoCompleteEnabled === true);
  setBooleanPropertyIfChanged(record.autoCompleteInput, "disabled", view.autoCompleteDisabled === true);
  setTextIfChanged(record.autoCompleteText, view.autoCompleteEnabled ? "开启" : "关闭");
  setTextIfChanged(record.rule, view.rule ?? "");
  setBooleanPropertyIfChanged(record.rule, "hidden", !view.rule);
  const tasks = normalizeCyclicTasks(view.tasks).slice(0, 3);
  setBooleanPropertyIfChanged(record.emptyTask, "hidden", tasks.length > 0);
  reconcileCyclicTaskRecords(record, tasks);
}

function normalizeCyclicTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map((task, index) => {
    const slotIndex = Number.isInteger(Number(task?.slotIndex)) ? Number(task.slotIndex) : index + 1;
    const hasTaskId = task?.taskId !== null && task?.taskId !== undefined && String(task.taskId) !== "";
    return {
      ...task,
      key: hasTaskId ? `${String(task.taskId)}:${slotIndex}` : `slot:${slotIndex}`,
    };
  });
}

function reconcileCyclicTaskRecords(card, tasks) {
  const desired = [];
  const desiredKeys = new Set();
  for (const task of tasks) {
    if (desiredKeys.has(task.key)) continue;
    desiredKeys.add(task.key);
    let record = card.taskRecords.get(task.key);
    if (!record) {
      record = createCyclicTaskRecord(card.root.ownerDocument, task.key);
      card.taskRecords.set(task.key, record);
    }
    patchCyclicTaskRecord(record, task);
    desired.push(record);
  }
  removeMissingRecords(card.taskRecords, desiredKeys);
  reconcileOrder(card.taskList, desired, card.emptyTask);
}

function createCyclicTaskRecord(document, key) {
  const root = createElement(document, "div", ["cyclic-note-task-line"]);
  setAttributeIfChanged(root, "data-cyclic-note-task-key", key);
  const quality = createTextLeaf(document, "strong", "", "data-cyclic-note-task-field", "quality");
  const description = createTextLeaf(document, "span", "", "data-cyclic-note-task-field", "description");
  const progress = createTextLeaf(document, "em", "", "data-cyclic-note-task-field", "progress");
  const result = createElement(document, "small");
  const reward = createTextLeaf(document, "span", "", "data-cyclic-note-task-field", "reward");
  const status = createTextLeaf(document, "span", "", "data-cyclic-note-task-field", "status");
  result.append(reward, createTextLeaf(document, "span", " / "), status);
  root.append(quality, description, progress, result);
  return { root, quality, description, progress, reward, status };
}

function patchCyclicTaskRecord(record, task) {
  setTextIfChanged(record.quality, task.qualityText ?? "-");
  setTextIfChanged(record.description, task.desc ?? "暂无任务描述");
  setTextIfChanged(record.progress, task.progressText ?? "-");
  setTextIfChanged(record.reward, task.rewardText ?? "-");
  setTextIfChanged(record.status, task.statusText ?? task.status ?? "-");
}

function createMetric(document, label, field) {
  const root = createElement(document, "span", ["queue-stat"]);
  const value = createTextLeaf(document, "strong", "", "data-cyclic-note-field", field);
  root.append(createTextLeaf(document, "span", label), value);
  return { root, value };
}

function emptyOrdinarySlot(boxId) {
  return {
    boxId,
    mode: "empty",
    state: "empty",
    remainingSeconds: "0",
    requirements: [],
  };
}

function removeMissingRecords(records, desiredKeys) {
  for (const [key, record] of records) {
    if (desiredKeys.has(key)) continue;
    record.root.remove();
    records.delete(key);
  }
}

function reconcileOrder(container, desired, tailAnchor = null) {
  const oldIndex = new Map(Array.from(container.children).map((node, index) => [node, index]));
  const sequence = desired.map((record) => oldIndex.get(record.root) ?? -1);
  const stablePositions = new Set(longestIncreasingSubsequencePositions(sequence));
  for (let index = desired.length - 1; index >= 0; index -= 1) {
    const record = desired[index];
    const anchor = desired[index + 1]?.root || tailAnchor;
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

function createTextLeaf(document, tagName, text, attributeName = null, field = null, classNames = []) {
  const node = createElement(document, tagName, classNames);
  if (attributeName) setAttributeIfChanged(node, attributeName, field);
  setTextIfChanged(node, text);
  return node;
}
