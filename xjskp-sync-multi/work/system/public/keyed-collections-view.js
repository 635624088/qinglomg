import {
  setAttributeIfChanged,
  setBooleanPropertyIfChanged,
  setTextIfChanged,
  toggleClassIfChanged,
} from "./dom-patch.js";

const PROFILE_STATES = ["running", "missing", "unverified", "expired", "error", "stopped"];

export function createKeyedCollectionsRenderer(getNode, options = {}) {
  const onProfileSelect = options.onProfileSelect || (() => {});
  const legacyList = createKeyedList({
    container: getNode("legacyList"),
    keyOf: (item) => String(item.pid),
    createRecord: createLegacyRecord,
    patchRecord: patchLegacyRecord,
  });
  const profileList = createKeyedList({
    container: getNode("profileItems"),
    keyOf: (item) => String(item.id),
    createRecord: (document, item, key) => createProfileRecord(document, item, key, onProfileSelect),
    patchRecord: patchProfileRecord,
  });
  const missingFieldList = createKeyedList({
    container: getNode("wizardMissingItems"),
    keyOf: (field) => String(field),
    createRecord: createMissingFieldRecord,
    patchRecord: patchMissingFieldRecord,
  });
  const profilesEmpty = getNode("profilesEmpty");

  return {
    renderLegacy(items) {
      legacyList.render(items);
    },
    renderProfiles(view) {
      setBooleanPropertyIfChanged(profilesEmpty, "hidden", !view.empty);
      profileList.render(view.items);
    },
    renderMissingFields(fields) {
      missingFieldList.render(fields);
    },
  };
}

function createKeyedList({ container, keyOf, createRecord, patchRecord }) {
  const records = new Map();
  return {
    render(items) {
      const desired = [];
      const desiredKeys = new Set();
      for (const item of items) {
        const key = keyOf(item);
        if (desiredKeys.has(key)) continue;
        desiredKeys.add(key);
        let record = records.get(key);
        if (!record) {
          record = createRecord(container.ownerDocument, item, key);
          records.set(key, record);
        }
        patchRecord(record, item);
        desired.push(record);
      }

      for (const [key, record] of records) {
        if (desiredKeys.has(key)) continue;
        record.root.remove();
        records.delete(key);
      }
      reconcileOrder(container, desired);
    },
  };
}

function reconcileOrder(container, desired) {
  const oldIndex = new Map(Array.from(container.children).map((node, index) => [node, index]));
  const sequence = desired.map((record) => oldIndex.get(record.root) ?? -1);
  const stablePositions = new Set(longestIncreasingSubsequencePositions(sequence));
  for (let index = desired.length - 1; index >= 0; index -= 1) {
    const record = desired[index];
    const anchor = desired[index + 1]?.root || null;
    if (sequence[index] < 0 || !stablePositions.has(index)) {
      container.insertBefore(record.root, anchor);
    }
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

function createLegacyRecord(document, _item, key) {
  const root = createElement(document, "div", ["legacy-process-item"]);
  setAttributeIfChanged(root, "data-legacy-pid", key);
  const pid = createElement(document, "span", ["legacy-process-pid"]);
  const pidLabel = createTextLeaf(document, "span", "PID ");
  const pidValue = createTextLeaf(document, "span", "", "pid");
  pid.append(pidLabel, pidValue);
  const name = createTextLeaf(document, "span", "", "name");
  const commandLine = createTextLeaf(document, "code", "", "command-line");
  root.append(pid, name, commandLine);
  return { root, pidValue, name, commandLine };
}

function patchLegacyRecord(record, item) {
  setTextIfChanged(record.pidValue, item.pid);
  setTextIfChanged(record.name, item.name || "进程");
  setTextIfChanged(record.commandLine, item.commandLine || "-");
}

function createMissingFieldRecord(document, _field, key) {
  const root = createTextLeaf(document, "span", "");
  setAttributeIfChanged(root, "data-missing-field", key);
  return { root };
}

function patchMissingFieldRecord(record, field) {
  setTextIfChanged(record.root, field);
}

function createProfileRecord(document, _item, key, onProfileSelect) {
  const root = createElement(document, "div", ["profile-card"]);
  setAttributeIfChanged(root, "data-profile-id", key);
  root.addEventListener("click", () => onProfileSelect(key));

  const main = createElement(document, "button", ["profile-main"]);
  setAttributeIfChanged(main, "type", "button");
  setAttributeIfChanged(main, "data-profile-id", key);
  const title = createTextLeaf(document, "span", "", "label", ["profile-title"]);
  const id = createTextLeaf(document, "span", "", "id", ["profile-id"]);
  const credential = createElement(document, "span", ["profile-meta"]);
  const credentialComplete = createTextLeaf(document, "span", "凭据完整");
  const credentialMissing = createElement(document, "span");
  credentialMissing.append(
    createTextLeaf(document, "span", "缺 "),
    createTextLeaf(document, "span", "", "missing-count"),
    createTextLeaf(document, "span", " 项"),
  );
  credential.append(credentialComplete, credentialMissing);
  const validation = createElement(document, "span", ["profile-meta"]);
  const validationUnknown = createTextLeaf(document, "span", "未验证");
  const validationKnown = createElement(document, "span");
  validationKnown.append(
    createTextLeaf(document, "span", "验 "),
    createTextLeaf(document, "span", "", "validation-time"),
  );
  validation.append(validationUnknown, validationKnown);
  main.append(title, id, credential, validation);

  const badge = createElement(document, "div", ["profile-run-badge"]);
  const runLabel = createTextLeaf(document, "strong", "", "run-label");
  const detail = createElement(document, "span", ["profile-run-detail"]);
  const runningDetail = createElement(document, "span");
  runningDetail.append(
    createTextLeaf(document, "span", "PID "),
    createTextLeaf(document, "span", "", "run-pid"),
    createTextLeaf(document, "span", " / "),
    createTextLeaf(document, "span", "", "run-mode"),
    createTextLeaf(document, "span", " / "),
    createTextLeaf(document, "span", "", "run-started-at"),
  );
  const missingDetail = createElement(document, "span");
  const runMissingCountWrap = createElement(document, "span");
  runMissingCountWrap.append(
    createTextLeaf(document, "span", "缺 "),
    createTextLeaf(document, "span", "", "run-missing-count"),
    createTextLeaf(document, "span", " 项"),
  );
  const runMissingImport = createTextLeaf(document, "span", "需要导入");
  missingDetail.append(runMissingCountWrap, runMissingImport);
  const unverifiedDetail = createTextLeaf(document, "span", "先验证账号");
  const expiredDetail = createTextLeaf(document, "span", "需重导凭据");
  const errorDetail = createTextLeaf(document, "span", "", "run-error");
  const stoppedDetail = createTextLeaf(document, "span", "可手动启动");
  detail.append(runningDetail, missingDetail, unverifiedDetail, expiredDetail, errorDetail, stoppedDetail);
  badge.append(runLabel, detail);
  root.append(main, badge);

  return {
    root,
    title,
    id,
    credential,
    credentialComplete,
    credentialMissing,
    missingCount: credentialMissing.children[1],
    validationUnknown,
    validationKnown,
    validationTime: validationKnown.children[1],
    badge,
    runLabel,
    runningDetail,
    runPid: runningDetail.children[1],
    runMode: runningDetail.children[3],
    runStartedAt: runningDetail.children[5],
    missingDetail,
    runMissingCountWrap,
    runMissingCount: runMissingCountWrap.children[1],
    runMissingImport,
    unverifiedDetail,
    expiredDetail,
    errorDetail,
    stoppedDetail,
  };
}

function patchProfileRecord(record, view) {
  setAttributeIfChanged(record.root, "title", view.missingTitle);
  toggleClassIfChanged(record.root, "active", view.selected);
  patchExclusiveClass(record.root, PROFILE_STATES, view.runState);
  setTextIfChanged(record.title, view.label);
  setTextIfChanged(record.id, view.id);
  toggleClassIfChanged(record.credential, "ok", view.hasCredentials);
  toggleClassIfChanged(record.credential, "warn", !view.hasCredentials);
  setBooleanPropertyIfChanged(record.credentialComplete, "hidden", view.hasMissingFields);
  setBooleanPropertyIfChanged(record.credentialMissing, "hidden", !view.hasMissingFields);
  setTextIfChanged(record.missingCount, view.missingCount);
  setBooleanPropertyIfChanged(record.validationUnknown, "hidden", view.hasValidation);
  setBooleanPropertyIfChanged(record.validationKnown, "hidden", !view.hasValidation);
  setTextIfChanged(record.validationTime, view.validationTime);
  patchExclusiveClass(record.badge, PROFILE_STATES, view.runState);
  setTextIfChanged(record.runLabel, view.runLabel);
  setBooleanPropertyIfChanged(record.runningDetail, "hidden", view.runState !== "running");
  setBooleanPropertyIfChanged(record.missingDetail, "hidden", view.runState !== "missing");
  setBooleanPropertyIfChanged(record.unverifiedDetail, "hidden", view.runState !== "unverified");
  setBooleanPropertyIfChanged(record.expiredDetail, "hidden", view.runState !== "expired");
  setBooleanPropertyIfChanged(record.errorDetail, "hidden", view.runState !== "error");
  setBooleanPropertyIfChanged(record.stoppedDetail, "hidden", view.runState !== "stopped");
  setTextIfChanged(record.runPid, view.runPid);
  setTextIfChanged(record.runMode, view.runMode);
  setTextIfChanged(record.runStartedAt, view.runStartedAt);
  setBooleanPropertyIfChanged(record.runMissingCountWrap, "hidden", !view.runHasMissingFields);
  setBooleanPropertyIfChanged(record.runMissingImport, "hidden", view.runHasMissingFields);
  setTextIfChanged(record.runMissingCount, view.runMissingCount);
  setTextIfChanged(record.errorDetail, view.runError);
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
  if (field) setAttributeIfChanged(node, "data-profile-field", field);
  setTextIfChanged(node, text);
  return node;
}
