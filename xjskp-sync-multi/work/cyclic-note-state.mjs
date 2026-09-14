import fs from "node:fs";
import {
  decodeConfigRows,
  findConfigTable,
} from "./flower-level-config.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

export const CYCLIC_NOTE_IFACES = {
  enter: "gs.actCyclicNote.enter",
  recvTaskRwd: "gs.actCyclicNote.recvTaskRwd",
};
export const CYCLIC_NOTE_ACTIVITY_TYPE = 4002;
export const CYCLIC_NOTE_SCORE_ITEM_ID = 1107;
export const CYCLIC_NOTE_MAX_TASK_SLOTS = 3;

const DEFAULT_STATIC_CONFIG_PATH = getDefaultStaticConfigPath();
const CYCLIC_NOTE_CONFIG_CACHE = new Map();
const CYCLIC_NOTE_PHASE_ACTIVE = 2;

function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toFiniteNumberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function getMapValue(map, key) {
  if (map instanceof Map) return map.get(key) ?? map.get(String(key)) ?? null;
  return map?.[key] ?? map?.[String(key)] ?? null;
}

function getOwnMapEntry(map, key) {
  if (map instanceof Map) {
    if (map.has(key)) return { exists: true, value: map.get(key) };
    const stringKey = String(key);
    if (map.has(stringKey)) return { exists: true, value: map.get(stringKey) };
    return { exists: false, value: null };
  }
  if (!map || typeof map !== "object") return { exists: false, value: null };
  const stringKey = String(key);
  return Object.hasOwn(map, stringKey)
    ? { exists: true, value: map[stringKey] }
    : { exists: false, value: null };
}

function readOwnedPath(root, path) {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return { exists: false, value: null };
    }
    current = current[segment];
  }
  return { exists: true, value: current };
}

function itemName(itemId, itemNameMap = {}) {
  if (!itemId) return `物品-${itemId}`;
  return itemNameMap[itemId] || itemNameMap[String(itemId)] || `物品-${itemId}`;
}

function normalizeRowMap(value) {
  if (value instanceof Map) {
    return new Map(
      [...value.entries()]
        .map(([key, row]) => {
          const normalizedKey = toFiniteNumberOrNull(key) ?? key;
          return [normalizedKey, row];
        }),
    );
  }

  if (Array.isArray(value)) {
    return new Map(
      value
        .map((row) => {
          const rowId = toFiniteNumberOrNull(row?.id);
          return rowId != null ? [rowId, row] : null;
        })
        .filter(Boolean),
    );
  }

  if (value && typeof value === "object") {
    return new Map(
      Object.entries(value).map(([key, row]) => {
        const rowId = toFiniteNumberOrNull(row?.id) ?? toFiniteNumberOrNull(key) ?? key;
        return [rowId, row];
      }),
    );
  }

  return new Map();
}

function normalizeItemNames(value) {
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, name]) => [String(key), name]));
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((row) => {
          const itemId = toFiniteNumberOrNull(row?.id);
          return itemId != null && row?.name ? [String(itemId), row.name] : null;
        })
        .filter(Boolean),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, rowOrName]) => {
        if (rowOrName && typeof rowOrName === "object") {
          const itemId = toFiniteNumberOrNull(rowOrName.id) ?? toFiniteNumberOrNull(key) ?? key;
          return [String(itemId), rowOrName.name || `物品-${itemId}`];
        }
        return [String(key), rowOrName];
      }),
    );
  }
  return {};
}

function normalizeCyclicNoteConfig(config) {
  if (!config) {
    return {
      actCyclicNote: new Map(),
      taskType: new Map(),
      itemNames: {},
      sourcePath: null,
    };
  }

  if (config.actCyclicNote instanceof Map && config.taskType instanceof Map) {
    return {
      actCyclicNote: config.actCyclicNote,
      taskType: config.taskType,
      itemNames: normalizeItemNames(config.itemNames),
      sourcePath: config.sourcePath || null,
    };
  }

  return {
    actCyclicNote: normalizeRowMap(config.actCyclicNote || config.tasks || config.rows),
    taskType: normalizeRowMap(config.taskType || config.taskTypes),
    itemNames: normalizeItemNames(config.itemNames || config.items || config.cItem),
    sourcePath: config.sourcePath || null,
  };
}

export function loadCyclicNoteConfig(configPath = DEFAULT_STATIC_CONFIG_PATH) {
  const cacheKey = configPath;
  if (CYCLIC_NOTE_CONFIG_CACHE.has(cacheKey)) return CYCLIC_NOTE_CONFIG_CACHE.get(cacheKey);

  if (!fs.existsSync(configPath)) {
    const empty = normalizeCyclicNoteConfig({ sourcePath: configPath });
    CYCLIC_NOTE_CONFIG_CACHE.set(cacheKey, empty);
    return empty;
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const actRows = decodeConfigRows(findConfigTable(raw, "c_actCyclicNote"), "c_actCyclicNote");
  const taskTypeRows = decodeConfigRows(findConfigTable(raw, "c_task_type"), "c_task_type");
  const itemRows = decodeConfigRows(findConfigTable(raw, "c_item"), "c_item");
  const loaded = normalizeCyclicNoteConfig({
    actCyclicNote: actRows,
    taskType: taskTypeRows,
    itemNames: itemRows,
    sourcePath: configPath,
  });
  CYCLIC_NOTE_CONFIG_CACHE.set(cacheKey, loaded);
  return loaded;
}

function safeLoadCyclicNoteConfig(options = {}) {
  if (Object.hasOwn(options, "cyclicNoteConfig")) {
    return normalizeCyclicNoteConfig(options.cyclicNoteConfig);
  }
  try {
    return loadCyclicNoteConfig(options.configPath || DEFAULT_STATIC_CONFIG_PATH);
  } catch {
    return normalizeCyclicNoteConfig();
  }
}

function safeLoadItemNameMap(options = {}, cyclicNoteConfig = normalizeCyclicNoteConfig()) {
  if (Object.hasOwn(options, "itemNameMap")) return normalizeItemNames(options.itemNameMap);
  return cyclicNoteConfig.itemNames || {};
}

function activityValue(act, key) {
  return act?.[key] ?? act?.d?.[key] ?? null;
}

function activityField(act, key) {
  const direct = act && typeof act === "object" && Object.hasOwn(act, key)
    ? { provided: true, value: act[key] }
    : null;
  const nested = act?.d && typeof act.d === "object" && Object.hasOwn(act.d, key)
    ? { provided: true, value: act.d[key] }
    : null;
  if (direct?.value != null || !nested) {
    return direct || { provided: false, value: null };
  }
  return nested;
}

function readOfficialTime(act) {
  const bmsField = activityField(act, "bms");
  const emsField = activityField(act, "ems");
  const durationBeforeField = activityField(act, "duration_before");
  const durationAfterField = activityField(act, "duration_after");
  // ActBaseCtrl._getMs uses JavaScript's `duration || 0` and only treats a
  // falsy bms/ems as a missing lifecycle boundary. Keep that display contract
  // separate from the stricter automation validation below.
  const bms = bmsField.value;
  const ems = emsField.value;
  const durationBefore = durationBeforeField.value || 0;
  const durationAfter = durationAfterField.value || 0;
  const hasOfficialBoundaries = Boolean(bms && ems);

  return {
    bms,
    ems,
    durationBefore: durationBeforeField.provided ? durationBefore : 0,
    durationAfter: durationAfterField.provided ? durationAfter : 0,
    rawDurationBefore: durationBeforeField.provided ? durationBeforeField.value : 0,
    rawDurationAfter: durationAfterField.provided ? durationAfterField.value : 0,
    hasOfficialBoundaries,
  };
}

function validateAutomationTime(time) {
  const bms = toFiniteNumberOrNull(time.bms);
  const ems = toFiniteNumberOrNull(time.ems);
  const durationBefore = toFiniteNumberOrNull(time.rawDurationBefore);
  const durationAfter = toFiniteNumberOrNull(time.rawDurationAfter);
  if (!time.hasOfficialBoundaries || bms == null || ems == null || bms <= 0 || ems <= 0) {
    return "automation-invalid-official-time";
  }
  if (ems <= bms) return "automation-invalid-official-time-range";
  if (durationBefore == null || durationAfter == null || durationBefore < 0 || durationAfter < 0) {
    return "automation-invalid-official-duration";
  }
  return null;
}

function resolveOfficialPhase(time, nowMs, nowError = null) {
  if (nowError) {
    return {
      phase: "unknown",
      phaseSource: "official-time",
      phaseStartMs: null,
      phaseEndMs: 0,
      phaseRemainingMs: null,
      bms: time.bms,
      ems: time.ems,
      durationBefore: time.durationBefore,
      durationAfter: time.durationAfter,
      timeError: nowError,
      automationSafetyError: validateAutomationTime(time),
    };
  }
  if (!time.hasOfficialBoundaries) {
    return {
      phase: 0,
      phaseSource: "official-time",
      phaseStartMs: null,
      phaseEndMs: 0,
      phaseRemainingMs: 0 - nowMs,
      bms: time.bms,
      ems: time.ems,
      durationBefore: time.durationBefore,
      durationAfter: time.durationAfter,
      timeError: "missing-official-time",
      automationSafetyError: validateAutomationTime(time),
    };
  }
  const { bms, ems, durationBefore, durationAfter } = time;

  const previewStartMs = bms - durationBefore;
  const exchangeEndMs = ems + durationAfter;
  const phase = nowMs < previewStartMs
    ? 0
    : nowMs < bms
      ? 1
      : nowMs < ems
        ? 2
        : nowMs < exchangeEndMs
          ? 3
          : 4;
  const phaseStartMs = phase === 0
    ? null
    : phase === 1
      ? previewStartMs
      : phase === 2
        ? bms
        : phase === 3
          ? ems
          : exchangeEndMs;
  const phaseEndMs = phase === 0
    ? previewStartMs
    : phase === 1
      ? bms
      : phase === 2
        ? ems
        : phase === 3
          ? exchangeEndMs
          : 0;
  return {
    phase,
    phaseSource: "official-time",
    phaseStartMs,
    phaseEndMs,
    phaseRemainingMs: phaseEndMs - nowMs,
    bms,
    ems,
    durationBefore,
    durationAfter,
    timeError: null,
    automationSafetyError: validateAutomationTime(time),
  };
}

function normalizePhase(act, nowMs, nowError = null) {
  const officialTime = readOfficialTime(act);
  return resolveOfficialPhase(officialTime, nowMs, nowError);
}

function recordStatusFor(act) {
  return {
    phase: act?.phase ?? act?.d?.phase ?? null,
    status: act?.status ?? act?.d?.status ?? null,
  };
}

function phaseTextFor(phase) {
  if (phase === 0) return "未开放（阶段0）";
  if (phase === 1) return "预告期（阶段1）";
  if (phase === CYCLIC_NOTE_PHASE_ACTIVE) return "进行期（阶段2）";
  if (phase === 3) return "兑换期（阶段3）";
  if (phase === 4) return "已结束（阶段4）";
  return "阶段未知";
}

function activityTypeValue(act) {
  return toFiniteNumberOrNull(act?.tmpType)
    ?? toFiniteNumberOrNull(act?.tmpId)
    ?? toFiniteNumberOrNull(act?.d?.tmpType)
    ?? toFiniteNumberOrNull(act?.d?.tmpId);
}

function activityBatchId(act) {
  return toFiniteNumberOrNull(act?.batchId) ?? toFiniteNumberOrNull(act?.d?.batchId);
}

function activityTmpId(act) {
  return toFiniteNumberOrNull(act?.tmpId)
    ?? toFiniteNumberOrNull(act?.tmpType)
    ?? toFiniteNumberOrNull(act?.d?.tmpId)
    ?? toFiniteNumberOrNull(act?.d?.tmpType);
}

function activityScoreLimit(syncValue, tmpId) {
  if (!isSafePositiveInteger(tmpId)) {
    return { value: null, sourcePath: null };
  }
  const template = getMapValue(syncValue?.actTot?.tmpMap, tmpId);
  const directBoxes = readOwnedPath(template, ["boxes"]);
  const nestedBoxes = readOwnedPath(template, ["d", "boxes"]);
  const boxes = directBoxes.exists ? directBoxes.value : nestedBoxes.value;
  if (!Array.isArray(boxes) || boxes.length === 0) {
    return { value: null, sourcePath: null };
  }
  const lastIndex = boxes.length - 1;
  const lastBox = boxes[lastIndex];
  const limit = Array.isArray(lastBox) ? toFiniteNumberOrNull(lastBox[1]) : null;
  if (!isSafePositiveInteger(limit)) {
    return { value: null, sourcePath: null };
  }
  const boxesPath = directBoxes.exists ? "boxes" : "d.boxes";
  return {
    value: limit,
    sourcePath: `actTot.tmpMap["${tmpId}"].${boxesPath}[${lastIndex}][1]`,
  };
}

function getActivities(syncValue) {
  const map = syncValue?.actTot?.map;
  if (!map || typeof map !== "object") return [];
  return Object.values(map)
    .filter((act) => act && typeof act === "object")
    .filter((act) => activityTypeValue(act) === CYCLIC_NOTE_ACTIVITY_TYPE);
}

function selectCurrentActivity(syncValue, nowMs, nowError) {
  const activities = getActivities(syncValue);
  if (!activities.length) return { act: null, ...normalizePhase(null, nowMs, nowError), candidates: [] };
  const candidates = activities.map((act) => ({ act, ...normalizePhase(act, nowMs, nowError) }));
  const activeCandidates = candidates.filter((candidate) => candidate.phase === CYCLIC_NOTE_PHASE_ACTIVE);
  if (activeCandidates.length > 1) {
    return {
      act: null,
      phase: CYCLIC_NOTE_PHASE_ACTIVE,
      phaseSource: "ambiguous",
      phaseStartMs: null,
      phaseEndMs: null,
      phaseRemainingMs: null,
      bms: null,
      ems: null,
      durationBefore: null,
      durationAfter: null,
      timeError: "ambiguous-active-activity",
      automationSafetyError: "ambiguous-active-activity",
      candidates,
      selectionError: "ambiguous-active-activity",
    };
  }
  const selected = activeCandidates[0] || candidates[0];
  return {
    ...selected,
    candidates,
    selectionError: null,
  };
}

function getTaskList(act) {
  const direct = readOwnedPath(act, ["ext", "cyclicNote", "taskList"]);
  if (direct.exists && Array.isArray(direct.value)) {
    return {
      value: direct.value.slice(),
      sourcePath: "ext.cyclicNote.taskList",
      valid: true,
    };
  }
  const nested = readOwnedPath(act, ["d", "ext", "cyclicNote", "taskList"]);
  if (nested.exists && Array.isArray(nested.value)) {
    return {
      value: nested.value.slice(),
      sourcePath: "d.ext.cyclicNote.taskList",
      valid: true,
    };
  }
  return { value: [], sourcePath: null, valid: false };
}

function getAuthoritativeTaskRecord(syncValue, batchId, idx = 0) {
  const taskRcdMap = syncValue?.actTot?.taskRcdMap;
  if (!taskRcdMap || typeof taskRcdMap !== "object") {
    return { available: false, record: null, sourceBasePath: null };
  }
  const key = `${batchId}|${idx}`;
  return {
    available: true,
    record: Object.hasOwn(taskRcdMap, key) && taskRcdMap[key] && typeof taskRcdMap[key] === "object"
      ? taskRcdMap[key]
      : null,
    sourceBasePath: `actTot.taskRcdMap["${key}"]`,
  };
}

function getTaskRecordField(syncValue, batchId, fieldName) {
  const taskRecord = getAuthoritativeTaskRecord(syncValue, batchId);
  if (!taskRecord.available) {
    return {
      value: null,
      sourcePath: null,
      authoritativeMapPresent: false,
      authoritativeRecordPresent: false,
      authoritativeFieldPresent: false,
    };
  }
  const sourcePath = taskRecord.record ? `${taskRecord.sourceBasePath}.${fieldName}` : null;
  const value = taskRecord.record?.[fieldName];
  const valid = value && typeof value === "object" && !Array.isArray(value);
  return {
    value: valid ? value : null,
    sourcePath,
    authoritativeMapPresent: true,
    authoritativeRecordPresent: Boolean(taskRecord.record),
    authoritativeFieldPresent: Boolean(valid),
  };
}

function renderTaskDesc(template, value) {
  if (!template) return "";
  return String(template).replaceAll("${value}", String(value ?? ""));
}

function buildRewards(rewardValue, itemNameMap) {
  if (!Array.isArray(rewardValue) || !rewardValue.length || !rewardValue.every((entry) => Array.isArray(entry) && entry.length === 2)) {
    return { rewards: [], rewardText: "奖励数据异常", rewardDataValid: false, rewardError: "invalid-reward-structure" };
  }
  const rewards = [];
  const itemIds = new Set();
  for (const entry of rewardValue) {
    const itemId = toFiniteNumberOrNull(entry[0]);
    const count = toFiniteNumberOrNull(entry[1]);
    if (!isSafePositiveInteger(itemId) || !isSafeNonNegativeInteger(count) || itemIds.has(itemId)) {
      return { rewards: [], rewardText: "奖励数据异常", rewardDataValid: false, rewardError: "invalid-reward-entry" };
    }
    itemIds.add(itemId);
    rewards.push({ itemId, name: itemName(itemId, itemNameMap), count });
  }
  return {
    rewards,
    rewardText: rewards.map((reward) => `${reward.name}x${reward.count}`).join("、"),
    rewardDataValid: true,
    rewardError: null,
  };
}

function statusTextFor(status) {
  if (status === "canReceive") return "可领取";
  if (status === "received") return "已领取";
  if (status === "inProgress") return "进行中";
  if (status === "empty") return "空槽";
  return "状态未知";
}

function qualityFromTaskConfig(taskCfg) {
  const quality = toFiniteNumberOrNull(taskCfg?.color) ?? toFiniteNumberOrNull(taskCfg?.group);
  return {
    quality,
    qualityText: quality != null ? `${quality}星` : "",
  };
}

function taskProgressForSlot(progressMap, taskId, missingMeansZero, strictRawProgress = false) {
  if (!progressMap || taskId == null) return null;
  const progress = getOwnMapEntry(progressMap, taskId);
  if (!progress.exists) return missingMeansZero ? 0 : null;
  if (strictRawProgress) {
    return isSafeNonNegativeInteger(progress.value) ? progress.value : null;
  }
  return toFiniteNumberOrNull(progress.value);
}

function buildTaskSlot(
  taskIdRaw,
  slotIndex,
  progressMap,
  recvMap,
  config,
  itemNameMap,
  missingProgressMeansZero = false,
  strictRawProgress = false,
) {
  const taskId = toFiniteNumberOrNull(taskIdRaw);
  const taskCfg = taskId != null ? getMapValue(config.actCyclicNote, taskId) : null;
  if (!taskCfg) {
    return {
      slotIndex,
      taskId,
      status: "unknown",
      statusText: statusTextFor("unknown"),
      desc: "",
      quality: null,
      qualityText: "",
      type: null,
      current: taskProgressForSlot(progressMap, taskId, missingProgressMeansZero, strictRawProgress),
      target: null,
      displayProgress: null,
      progressText: "-",
      received: false,
      canReceive: false,
      rewards: [],
      rewardText: "",
    };
  }

  const current = taskProgressForSlot(progressMap, taskId, missingProgressMeansZero, strictRawProgress);
  const target = toFiniteNumberOrNull(taskCfg.value);
  const displayProgress = current != null && target != null ? Math.min(current, target) : current;
  const receipt = getOwnMapEntry(recvMap, taskId);
  const received = receipt.exists && receipt.value != null;
  const canReceive = !received && current != null && target != null && current >= target;
  let status = "inProgress";
  if (received) status = "received";
  else if (canReceive) status = "canReceive";
  const { rewards, rewardText, rewardDataValid, rewardError } = buildRewards(taskCfg.reward, itemNameMap);
  const scoreRewards = rewards.filter((reward) => reward.itemId === CYCLIC_NOTE_SCORE_ITEM_ID);
  // A missing, duplicated, or malformed score reward cannot be compared safely.
  const rewardScoreCount = rewardDataValid
    && scoreRewards.length === 1
    && isSafeNonNegativeInteger(scoreRewards[0].count)
    ? scoreRewards[0].count
    : null;
  const { quality, qualityText } = qualityFromTaskConfig(taskCfg);

  return {
    slotIndex,
    taskId,
    status,
    statusText: statusTextFor(status),
    quality,
    qualityText,
    type: toFiniteNumberOrNull(taskCfg.type),
    group: toFiniteNumberOrNull(taskCfg.group),
    color: toFiniteNumberOrNull(taskCfg.color),
    current,
    target,
    displayProgress,
    progressText: target != null
      ? `${displayProgress != null ? displayProgress : "-"}/${target}`
      : "-",
    received,
    canReceive,
    desc: renderTaskDesc(getMapValue(config.taskType, taskCfg.type)?.desc || "", taskCfg.value),
    rewards,
    rewardText,
    rewardDataValid,
    rewardError,
    rewardScoreCount,
  };
}

function validateActiveSnapshot({
  selectionError,
  batchId,
  taskList,
  taskSlots,
  authoritativeProgress,
  authoritativeRecvMap,
}) {
  if (selectionError) return selectionError;
  if (!isSafePositiveInteger(batchId)) return "invalid-batch-id";
  if (!authoritativeProgress.authoritativeMapPresent || !authoritativeProgress.authoritativeRecordPresent) {
    return "missing-authoritative-task-record";
  }
  if (!authoritativeProgress.authoritativeFieldPresent) return "missing-authoritative-task-progress";
  if (!authoritativeRecvMap.authoritativeFieldPresent) return "missing-authoritative-task-recv-map";
  if (!taskList.valid || taskList.value.length !== CYCLIC_NOTE_MAX_TASK_SLOTS) {
    return "invalid-task-slot-count";
  }
  const taskIds = new Set();
  for (const slot of taskSlots) {
    if (
      !isSafePositiveInteger(slot?.taskId)
      || taskIds.has(slot.taskId)
      || !isSafePositiveInteger(slot?.type)
      || !isSafeNonNegativeInteger(slot?.current)
      || !isSafePositiveInteger(slot?.target)
      || slot?.rewardDataValid !== true
      || !isSafeNonNegativeInteger(slot?.rewardScoreCount)
    ) {
      return "invalid-task-slot";
    }
    taskIds.add(slot.taskId);
  }
  return null;
}

export function summarizeCyclicNoteStatus(syncValue, options = {}) {
  const config = safeLoadCyclicNoteConfig(options);
  const itemNameMap = safeLoadItemNameMap(options, config);
  const hasExplicitNowMs = Object.hasOwn(options, "nowMs");
  const requestedNowMs = toFiniteNumberOrNull(options.nowMs);
  const nowError = hasExplicitNowMs && requestedNowMs == null ? "invalid-now-ms" : null;
  const nowMs = requestedNowMs ?? Date.now();
  const timeTrusted = options.timeTrusted === true;
  const clockSource = typeof options.clockSource === "string" && options.clockSource
    ? options.clockSource
    : "local-fallback";
  const timeAuthorityReason = options.timeAuthorityReason ?? (timeTrusted ? null : "no-trusted-time-authority");
  const {
    act,
    phase,
    phaseSource,
    phaseStartMs,
    phaseEndMs,
    phaseRemainingMs,
    bms,
    ems,
    durationBefore,
    durationAfter,
    timeError,
    automationSafetyError = null,
    candidates,
    selectionError = null,
  } = selectCurrentActivity(syncValue, nowMs, nowError);
  if (!act) {
    return {
      exists: candidates.length > 0,
      active: phase === CYCLIC_NOTE_PHASE_ACTIVE,
      phase,
      phaseText: phaseTextFor(phase),
      phaseSource,
      phaseStartMs,
      phaseEndMs,
      phaseRemainingMs,
      bms,
      ems,
      durationBefore,
      durationAfter,
      timeError,
      recordStatus: null,
      timeTrusted,
      clockSource,
      timeAuthorityReason,
      reason: "unknown",
      reasonText: selectionError === "ambiguous-active-activity" ? "存在多个进行中的花笺集芳活动" : "活动ID不可用",
      batchId: null,
      tmpId: null,
      score: 0,
      scoreLimit: null,
      scoreLimitSourcePath: null,
      scoreItemId: CYCLIC_NOTE_SCORE_ITEM_ID,
      scoreItemName: itemName(CYCLIC_NOTE_SCORE_ITEM_ID, itemNameMap),
      taskSlots: [],
      configSourcePath: config.sourcePath || null,
      activityCount: candidates.length,
      activeActivityCount: candidates.filter((candidate) => candidate.phase === CYCLIC_NOTE_PHASE_ACTIVE).length,
      executionSafe: false,
      snapshotError: selectionError || automationSafetyError || timeError || "missing-activity",
      pendingReceiveActions: [],
    };
  }

  const batchId = activityBatchId(act);
  const tmpId = activityTmpId(act);
  const scoreLimit = activityScoreLimit(syncValue, tmpId);
  const taskList = getTaskList(act);
  const progress = getTaskRecordField(
    syncValue,
    batchId,
    "progress",
  );
  const recvMap = getTaskRecordField(
    syncValue,
    batchId,
    "recvMap",
  );
  const taskSlots = taskList.value.map((taskId, index) => buildTaskSlot(
    taskId,
    index + 1,
    progress.value,
    recvMap.value,
    config,
    itemNameMap,
    progress.authoritativeRecordPresent,
    progress.authoritativeRecordPresent,
  ));
  const active = phase === CYCLIC_NOTE_PHASE_ACTIVE;
  const snapshotError = selectionError
    || (timeError === "invalid-now-ms" ? timeError : null)
    || automationSafetyError
    || (active ? validateActiveSnapshot({
      selectionError,
      batchId,
      taskList,
      taskSlots,
      authoritativeProgress: progress,
      authoritativeRecvMap: recvMap,
    }) : null);
  const reason = phase === "unknown" || selectionError || snapshotError
    ? "unknown"
    : active ? "active" : "inactive";

  const status = {
    exists: true,
    active,
    phase,
    phaseText: phaseTextFor(phase),
    phaseSource,
    phaseStartMs,
    phaseEndMs,
    phaseRemainingMs,
    bms,
    ems,
    durationBefore,
    durationAfter,
    timeError,
    recordStatus: recordStatusFor(act),
    timeTrusted,
    clockSource,
    timeAuthorityReason,
    reason,
    reasonText: !timeTrusted
      ? "服务器标准时间未校准，已停止自动操作"
      : [
        "missing-authoritative-task-record",
        "missing-authoritative-task-progress",
        "missing-authoritative-task-recv-map",
      ].includes(snapshotError)
        ? "等待官方数据"
      : reason === "active"
        ? "活动进行中"
      : timeError
        ? "活动时间不完整，按官方规则显示为未开放"
      : automationSafetyError === "automation-invalid-official-time-range"
        ? "活动时间范围异常，已停止自动操作"
      : automationSafetyError === "automation-invalid-official-duration"
        ? "活动时长异常，已停止自动操作"
      : snapshotError === "invalid-task-slot-count"
        ? "权威任务槽位不是完整三个，已停止自动操作"
        : snapshotError === "invalid-task-slot"
          ? "权威任务或奖励数据异常，已停止自动操作"
      : reason === "inactive"
        ? `活动阶段 ${phase}`
        : "活动阶段未知",
    batchId,
    tmpId,
    score: toNumber(act.score ?? act.d?.score, 0),
    scoreLimit: scoreLimit.value,
    scoreLimitSourcePath: scoreLimit.sourcePath,
    scoreItemId: CYCLIC_NOTE_SCORE_ITEM_ID,
    scoreItemName: itemName(CYCLIC_NOTE_SCORE_ITEM_ID, itemNameMap),
    taskSlots,
    taskListSourcePath: taskList.sourcePath,
    progressSourcePath: progress.sourcePath,
    recvMapSourcePath: recvMap.sourcePath,
    configSourcePath: config.sourcePath || null,
    activityCount: candidates.length,
    activeActivityCount: candidates.filter((candidate) => candidate.phase === CYCLIC_NOTE_PHASE_ACTIVE).length,
    executionSafe: timeTrusted && active && phaseSource === "official-time" && !snapshotError,
    snapshotError,
  };
  status.pendingReceiveActions = getAutoReceiveCyclicNoteActions(status);
  return status;
}

export function getAutoReceiveCyclicNoteActions(status) {
  if (!status?.active || status?.phase !== CYCLIC_NOTE_PHASE_ACTIVE || status?.executionSafe !== true) return [];
  if (!isSafePositiveInteger(status?.batchId)) return [];
  return (status.taskSlots || [])
    .filter((slot) => slot?.canReceive)
    .map((slot) => ({
      kind: "cyclicNote",
      iface: CYCLIC_NOTE_IFACES.recvTaskRwd,
      args: {
        batchId: status.batchId,
        taskId: slot.taskId,
      },
      batchId: status.batchId,
      taskId: slot.taskId,
      slotIndex: slot.slotIndex,
      scoreItemId: status.scoreItemId,
      rewardText: slot.rewardText,
      statusText: slot.statusText,
      reason: "cyclic-note-task-ready",
    }));
}
