import fs from "node:fs";
import {
  decodeConfigRows,
  findConfigTable,
} from "./flower-level-config.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

export const MAIN_TASK_IFACES = {
  recv: "gs.taskMain.recv",
};
export const RESIDENT_ORDER_MAIN_TASK_TYPE = 1009;
export const RESIDENT_ORDER_MAIN_TASK_TYPES = new Set([RESIDENT_ORDER_MAIN_TASK_TYPE, 3006]);
export const LEVEL_UP_MAIN_TASK_TYPE = 2;

const DEFAULT_GAME_CONFIG_PATH = getDefaultStaticConfigPath();
const MAIN_TASK_STATE_PATHS = [
  ["taskTot", "main"],
  ["taskTot", "task"],
  ["taskTot", "mainTask"],
  ["taskTot", "taskCtrl_main"],
  ["$taskTot", "main"],
  ["$taskTot", "task"],
  ["$taskTot", "mainTask"],
  ["$taskTot", "taskCtrl_main"],
  ["taskCtrl_main"],
  ["mainTaskTot", "main"],
  ["mainTaskTot", "mainTask"],
  ["mainTaskTot", "task"],
  ["$mainTaskTot", "main"],
  ["$mainTaskTot", "mainTask"],
  ["$mainTaskTot", "task"],
];
const MAIN_TASK_ID_KEYS = ["curTaskId", "taskId", "currentTaskId", "mainTaskId"];

let cachedConfigPath = null;
let cachedMainTaskConfig = null;

function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[key];
  }
  return cur && typeof cur === "object" ? cur : null;
}

function getMapValue(map, key) {
  if (map instanceof Map) return map.get(key) ?? map.get(String(key)) ?? null;
  return map?.[key] ?? map?.[String(key)] ?? null;
}

function getMainTaskIdFromData(data) {
  for (const key of MAIN_TASK_ID_KEYS) {
    const value = toNumber(data?.[key], null);
    if (value) return value;
  }
  return null;
}

function summarizeMainTaskRawFields(data) {
  if (!data || typeof data !== "object") return "";
  return Object.entries(data)
    .filter(([, value]) => value == null || ["string", "number", "boolean"].includes(typeof value))
    .map(([key, value]) => `${key}=${value ?? "-"}`)
    .join("; ");
}

function normalizeMainTaskConfig(config) {
  if (!config) return { tasks: new Map(), endId: 0, guideEnd: 0 };
  if (config.tasks instanceof Map) return config;
  const rows = Array.isArray(config.rows) ? config.rows : [];
  const tasks = new Map(rows.map((row) => [toNumber(row.id), row]));
  return {
    tasks,
    endId: toNumber(config.endId || config.$endId || rows.at(-1)?.id),
    guideEnd: toNumber(config.guideEnd || config.$guideEnd),
  };
}

export function loadMainTaskConfig(configPath = DEFAULT_GAME_CONFIG_PATH) {
  if (cachedMainTaskConfig && cachedConfigPath === configPath) return cachedMainTaskConfig;
  if (!fs.existsSync(configPath)) {
    cachedConfigPath = configPath;
    cachedMainTaskConfig = { tasks: new Map(), endId: 0, guideEnd: 0 };
    return cachedMainTaskConfig;
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const table = findConfigTable(raw, "c_task_main");
  const rows = decodeConfigRows(table, "c_task_main");
  const tasks = new Map(rows.map((row) => [toNumber(row.id), row]));
  const ids = rows.map((row) => toNumber(row.id)).filter(Boolean).sort((a, b) => a - b);
  cachedConfigPath = configPath;
  cachedMainTaskConfig = {
    tasks,
    endId: toNumber(table?.$endId || rows.find((row) => row.$endId != null)?.$endId || ids.at(-1)),
    guideEnd: toNumber(table?.$guideEnd || rows.find((row) => row.$guideEnd != null)?.$guideEnd),
  };
  return cachedMainTaskConfig;
}

function getMainTaskData(sync) {
  const candidates = [];
  for (const path of MAIN_TASK_STATE_PATHS) {
    const data = getPath(sync, path);
    if (data) {
      candidates.push({
        data,
        sourcePath: path.join("."),
        taskId: getMainTaskIdFromData(data),
      });
    }
  }
  const selected = candidates.find((candidate) => candidate.taskId) || candidates[0];
  if (selected) {
    const fallback = candidates[0];
    const data = fallback && fallback !== selected
      ? { ...fallback.data, ...selected.data }
      : selected.data;
    return {
      data,
      sourcePath: selected.sourcePath,
      fallbackSourcePath: fallback && fallback !== selected ? fallback.sourcePath : null,
      candidateSourcePaths: candidates.map((candidate) => candidate.sourcePath),
    };
  }
  return { data: null, sourcePath: null };
}

export function summarizeMainTaskStatus(sync, options = {}) {
  const { data, sourcePath, fallbackSourcePath, candidateSourcePaths = [] } = getMainTaskData(sync);
  const mainTaskConfig = normalizeMainTaskConfig(options.mainTaskConfig || loadMainTaskConfig(options.configPath));
  if (!data) {
    return {
      exists: false,
      status: "missing",
      statusText: "暂无主线任务状态",
      actionText: "不处理",
      sourcePath,
      canReceive: false,
      taskId: null,
      curValue: null,
      targetValue: null,
      remainingValue: null,
      taskType: null,
      isResidentOrderMainTask: false,
      canProgressResidentOrderMainTask: false,
      isLevelUpMainTask: false,
      canProgressLevelUpMainTask: false,
      canSubmitOrdinaryResidentOrderForMainTask: false,
      ordinaryResidentOrderGateReason: null,
      progressText: "-",
      dataKeys: [],
      rawFieldText: "",
      candidateSourcePaths,
    };
  }

  const taskId = getMainTaskIdFromData(data);
  const dataKeys = Object.keys(data);
  const rawFieldText = summarizeMainTaskRawFields(data);
  if (!taskId) {
    return {
      exists: false,
      status: "no-current-task",
      statusText: "暂无当前主线任务",
      actionText: "不处理",
      sourcePath,
      canReceive: false,
      taskId: null,
      curValue: toNumber(data.curValue),
      targetValue: null,
      remainingValue: null,
      taskType: null,
      isResidentOrderMainTask: false,
      canProgressResidentOrderMainTask: false,
      isLevelUpMainTask: false,
      canProgressLevelUpMainTask: false,
      canSubmitOrdinaryResidentOrderForMainTask: false,
      ordinaryResidentOrderGateReason: null,
      progressText: "-",
      dataKeys,
      rawFieldText,
      fallbackSourcePath,
      candidateSourcePaths,
    };
  }

  if (mainTaskConfig.endId && taskId > mainTaskConfig.endId) {
    return {
      exists: true,
      status: "completed-all",
      statusText: "主线任务已全部完成",
      actionText: "不处理",
      sourcePath,
      canReceive: false,
      taskId,
      curValue: toNumber(data.curValue),
      targetValue: null,
      remainingValue: null,
      taskType: null,
      isResidentOrderMainTask: false,
      canProgressResidentOrderMainTask: false,
      isLevelUpMainTask: false,
      canProgressLevelUpMainTask: false,
      canSubmitOrdinaryResidentOrderForMainTask: false,
      ordinaryResidentOrderGateReason: null,
      progressText: "-",
      dataKeys,
      rawFieldText,
      fallbackSourcePath,
      candidateSourcePaths,
    };
  }

  const cfg = getMapValue(mainTaskConfig.tasks, taskId);
  if (!cfg) {
    return {
      exists: true,
      status: "unknown-config",
      statusText: "未找到主线任务配置",
      actionText: "跳过：配置缺失",
      sourcePath,
      canReceive: false,
      taskId,
      curValue: toNumber(data.curValue),
      targetValue: null,
      remainingValue: null,
      taskType: null,
      isResidentOrderMainTask: false,
      canProgressResidentOrderMainTask: false,
      isLevelUpMainTask: false,
      canProgressLevelUpMainTask: false,
      canSubmitOrdinaryResidentOrderForMainTask: false,
      ordinaryResidentOrderGateReason: null,
      progressText: "-",
      dataKeys,
      rawFieldText,
      fallbackSourcePath,
      candidateSourcePaths,
    };
  }

  const curValue = toNumber(data.curValue);
  const targetValue = toNumber(cfg.value);
  const taskType = toNumber(cfg.type, null);
  const recvMap = data.recvMap || {};
  const received = Boolean(getMapValue(recvMap, taskId));
  const canReceive = !received && targetValue > 0 && curValue >= targetValue;
  const remainingValue = targetValue > 0 ? Math.max(0, targetValue - curValue) : null;
  const isResidentOrderMainTask = RESIDENT_ORDER_MAIN_TASK_TYPES.has(taskType);
  const canProgressResidentOrderMainTask = isResidentOrderMainTask
    && !received
    && targetValue > 0
    && curValue < targetValue;
  const isLevelUpMainTask = taskType === LEVEL_UP_MAIN_TASK_TYPE;
  const canProgressLevelUpMainTask = isLevelUpMainTask
    && !received
    && targetValue > 0
    && curValue < targetValue;
  const ordinaryResidentOrderGateReason = canProgressResidentOrderMainTask
    ? "resident-order-main-task"
    : canProgressLevelUpMainTask
      ? "level-up-main-task"
      : null;
  const canSubmitOrdinaryResidentOrderForMainTask = Boolean(ordinaryResidentOrderGateReason);
  const progressText = `${Math.min(curValue, targetValue)}/${targetValue}`;
  let status = "in-progress";
  let statusText = "进行中";
  let actionText = "未完成";
  if (received) {
    status = "received";
    statusText = "已领取";
    actionText = "不处理";
  } else if (canReceive) {
    status = "ready";
    statusText = "可提交";
    actionText = "会提交";
  }

  return {
    exists: true,
    status,
    statusText,
    actionText,
    sourcePath,
    canReceive,
    taskId,
    taskIndex: cfg.index ?? taskId,
    taskType,
    desc: cfg.desc || "",
    curValue,
    targetValue,
    remainingValue,
    progressText,
    received,
    isResidentOrderMainTask,
    canProgressResidentOrderMainTask,
    isLevelUpMainTask,
    canProgressLevelUpMainTask,
    canSubmitOrdinaryResidentOrderForMainTask,
    ordinaryResidentOrderGateReason,
    rewards: cfg.rewards || [],
    dataKeys,
    rawFieldText,
    fallbackSourcePath,
    candidateSourcePaths,
  };
}

export function isResidentOrderMainTaskStatus(status) {
  return Boolean(status?.canProgressResidentOrderMainTask);
}

export function getAutoSubmitMainTaskActions(status) {
  if (!status?.canReceive) return [];
  return [{
    kind: "mainTask",
    iface: MAIN_TASK_IFACES.recv,
    args: {},
    reason: "main-task-progress-ready",
    taskId: status.taskId,
    curValue: status.curValue,
    targetValue: status.targetValue,
  }];
}
