const CODE_COMPARISON_COPY = Object.freeze({
  same: "已是最新",
  newer: "待分析",
  older: "版本异常",
  different: "版本不同",
  unknown: "未检查",
});

const DATA_PHASE_COPY = Object.freeze({
  preflight: "前置检查",
  credentials: "凭据检查",
  discovery: "候选发现",
  download: "下载",
  downloading: "下载",
  validation: "兼容校验",
  validating: "兼容校验",
  activation: "激活",
  activating: "激活",
  complete: "完成",
  status: "状态保存",
  unknown: "未知",
});

const TRANSIENT_DATA_STATUSES = new Set(["downloading", "validating", "activating"]);
const OFFICIAL_QUERY_FIELDS = new Set(["CTOKEN", "PC_USER_ID", "PC_TOKEN"]);

export function buildGameVersionView(options = {}) {
  const version = objectValue(options.version);
  const code = objectValue(version.code);
  const data = objectValue(version.data);
  const profile = objectValue(options.profile);
  const runtime = objectValue(options.runtime);
  const checking = options.versionCheckPending === true || version.checking === true;
  const syncing = options.syncPending === true || TRANSIENT_DATA_STATUSES.has(data.syncStatus);
  const runtimeBlocked = options.pendingAction != null || hasBlockingGameDataRuntime(runtime);

  const codeView = buildCodeView({ version, code, checking });
  const dataView = buildDataView(data, code.localVersion || version.localVersion);
  const selected = Boolean(profile.id);
  const ready = selected && hasOfficialQueryCredentials(profile);
  const officialBusy = checking || syncing;

  const checkButton = {
    disabled: !selected || officialBusy,
    text: checking ? "检查中…" : "检查游戏官方版本",
    title: !selected
      ? "请先选择账号"
      : syncing
        ? "游戏数据同步正在进行"
        : checking
          ? "游戏官方版本检查正在进行"
          : codeView.title,
  };

  const syncReason = !selected
    ? "请先选择账号"
    : !ready
      ? Array.isArray(profile.missingFields)
        ? "当前账号缺少 CTOKEN、PC_USER_ID 或 PC_TOKEN"
        : "当前账号凭据不完整"
      : runtimeBlocked
        ? "请先停止全部账号任务，并等待启动、停止或恢复状态收敛"
        : checking
          ? "游戏官方版本检查正在进行"
          : syncing
            ? `游戏数据${dataView.statusText}`
            : dataView.title;

  return {
    code: codeView,
    data: dataView,
    checkButton,
    syncButton: {
      disabled: !ready || runtimeBlocked || officialBusy,
      text: syncing
        ? `同步中…${dataView.statusText}`
        : runtimeBlocked
          ? "请先停止全部任务再同步"
          : "同步最新版游戏代码和数据",
      title: syncReason,
    },
    feedback: buildPersistedFeedback(data),
  };
}

function hasOfficialQueryCredentials(profile) {
  if (Array.isArray(profile.missingFields)) {
    return !profile.missingFields.some((field) => OFFICIAL_QUERY_FIELDS.has(field));
  }
  return profile.hasCredentials === true;
}

export function hasBlockingGameDataRuntime(runtime = {}) {
  const value = objectValue(runtime);
  if (Number(value.runningCount || 0) > 0) return true;
  if (arrayValue(value.activeTasks).length > 0) return true;
  if (arrayValue(value.legacyProcesses).length > 0) return true;
  if (arrayValue(value.desiredRuns).some((entry) => ["running", "unresolved"].includes(entry?.desiredState))) return true;
  return Object.values(objectValue(value.recoveryByProfile)).some((entry) => (
    entry?.recoveryPending === true
    || ["scheduled", "starting", "running"].includes(entry?.recoveryStatus)
  ));
}

export function formatGameDataSyncSuccess(result = {}) {
  const data = objectValue(result.data);
  const previous = display(data.previousVersion);
  const active = display(data.activeVersion);
  const previousCode = display(data.previousCodeVersion);
  const activeCode = display(data.activeCodeVersion || data.activeSourceCodeVersion || data.candidateSourceCodeVersion);
  const loaderCount = Number.isFinite(Number(data.loaderCount)) ? Number(data.loaderCount) : null;
  const loaderText = loaderCount === null ? "生产加载器校验通过" : `${loaderCount} 个加载器通过`;
  const compatibility = compatibilityCopy(data.compatibilityStatus);
  return `游戏代码已从 ${previousCode} 更新为 ${activeCode}，游戏数据已从 ${previous} 同步为 ${active}；自动任务代码兼容分析通过，${loaderText}，数据兼容结论：${compatibility}。`;
}

export function formatGameDataSyncFailure(error = {}, fallbackData = {}) {
  const detail = objectValue(error.data);
  const data = { ...objectValue(fallbackData), ...detail };
  const phase = phaseCopy(data.phase);
  const message = cleanText(error.message) || cleanText(data.lastError?.message) || "游戏数据同步失败";
  const activeVersion = display(data.activeDataVersion || data.activeVersion);
  const report = cleanText(data.reportPath);
  return `失败阶段：${phase}；${stripSentenceEnd(message)}。未启用候选代码和数据，当前数据仍使用 ${activeVersion}${report ? `；诊断报告：${report}` : ""}。`;
}

function buildCodeView({ version, code, checking }) {
  const localVersion = display(code.localVersion || version.localVersion);
  const officialVersion = display(code.officialVersion || version.remoteVersion);
  const comparison = cleanText(code.comparison || version.comparison) || "unknown";
  const reviewStatus = cleanText(code.reviewStatus) || "unknown";
  const lastError = cleanText(version.lastError?.message);
  let state = comparison;
  let statusText = CODE_COMPARISON_COPY[comparison] || "分析状态未知";
  let summary = comparison === "newer"
    ? "发现官方新版本，需单独分析代码逻辑"
    : comparison === "same"
      ? "本地代码已是最近检查的官方版本"
      : comparison === "unknown"
        ? "尚未检查官方代码版本"
        : "本地代码与最近官方版本不同";

  if (reviewStatus === "current") statusText = comparison === "same" ? "已是最新" : "已分析";
  else if (reviewStatus === "pending-analysis") statusText = "待分析";
  else if (reviewStatus === "analysis-incomplete") statusText = "分析未完成";
  else if (reviewStatus === "analysis-failed") {
    statusText = "分析失败";
    state = "error";
  } else if (reviewStatus === "unknown" && comparison !== "unknown") statusText = "分析状态未知";

  if (checking) {
    state = "checking";
    statusText = "检查中";
    summary = "正在检查游戏官方代码版本";
  } else if (lastError) {
    state = "error";
    statusText = "检查失败";
    summary = `本次检查失败：${lastError}；保留最近成功结果`;
  }

  return {
    state,
    localVersion,
    officialVersion,
    statusText,
    title: `${summary}；最近成功检查：${formatDateTime(version.lastSuccessfulCheckAt)}；已分析版本：${display(code.analyzedVersion)}`,
  };
}

function buildDataView(data, localCodeVersion) {
  const syncStatus = cleanText(data.syncStatus) || "idle";
  const compatibility = cleanText(data.compatibilityStatus) || "unknown";
  let state = "unknown";
  let statusText = data.activeVersion ? "当前启用" : "未知";

  if (syncStatus === "downloading") [state, statusText] = ["checking", "下载中"];
  else if (syncStatus === "validating") [state, statusText] = ["checking", "校验中"];
  else if (syncStatus === "activating") [state, statusText] = ["checking", "激活中"];
  else if (compatibility === "manual-review") [state, statusText] = ["manual-review", "需人工复核"];
  else if (compatibility === "incompatible") [state, statusText] = ["incompatible", "不兼容"];
  else if (syncStatus === "failed") [state, statusText] = ["error", "同步失败"];
  else if (syncStatus === "blocked") [state, statusText] = ["blocked", "同步受阻"];
  else if (syncStatus === "latest" && compatibility === "compatible") [state, statusText] = ["same", "最新"];
  else if (compatibility === "compatible" && data.candidateVersion) [state, statusText] = ["compatible", "兼容可启用"];
  else if (data.candidateVersion) [state, statusText] = ["candidate", "发现候选"];
  else if (data.activeVersion) state = "current";

  const titleParts = [
    `当前启用数据 ${display(data.activeVersion)}`,
    `来源代码 ${display(data.activeSourceCodeVersion)}`,
    `兼容结论：${compatibilityCopy(compatibility)}`,
    `最近成功同步：${formatDateTime(data.lastSuccessfulSyncAt)}`,
  ];
  if (data.candidateVersion) titleParts.push(`候选 ${data.candidateVersion}（来源 ${display(data.candidateSourceCodeVersion)}）`);
  const newestSource = data.candidateSourceCodeVersion || data.activeSourceCodeVersion;
  if (isVersionNewer(newestSource, localCodeVersion)) {
    titleParts.push("来源代码高于本地代码；数据通过兼容校验不代表代码已适配");
  }
  if (data.lastError?.message) titleParts.push(`最近失败：${data.lastError.message}，仍使用 ${display(data.activeVersion)}`);
  if (data.reportPath) titleParts.push(`报告：${data.reportPath}`);
  return {
    state,
    activeVersion: display(data.activeVersion),
    sourceCodeVersion: display(data.activeSourceCodeVersion),
    statusText,
    title: titleParts.join("；"),
  };
}

function isVersionNewer(candidate, baseline) {
  if (!/^\d+(?:\.\d+)*$/.test(String(candidate || "")) || !/^\d+(?:\.\d+)*$/.test(String(baseline || ""))) return false;
  const left = String(candidate).split(".").map(Number);
  const right = String(baseline).split(".").map(Number);
  if (!left.length || left.some((part) => !Number.isFinite(part)) || right.some((part) => !Number.isFinite(part))) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function buildPersistedFeedback(data) {
  const syncStatus = cleanText(data.syncStatus) || "idle";
  if (TRANSIENT_DATA_STATUSES.has(syncStatus)) {
    return { visible: true, state: "progress", text: `正在${phaseCopy(data.phase || syncStatus)}，当前数据 ${display(data.activeVersion)} 继续生效。` };
  }
  if (["manual-review", "incompatible"].includes(data.compatibilityStatus)) {
    const label = data.compatibilityStatus === "manual-review" ? "候选数据需要人工复核" : "候选数据与当前代码不兼容";
    return {
      visible: true,
      state: "warning",
      text: `${label}。未启用候选代码和数据，当前数据仍使用 ${display(data.activeVersion)}${data.reportPath ? `；诊断报告：${data.reportPath}` : ""}。`,
    };
  }
  if (["failed", "blocked"].includes(syncStatus) && data.lastError?.message) {
    return { visible: true, state: "error", text: formatGameDataSyncFailure({ message: data.lastError.message }, data) };
  }
  return { visible: false, state: "neutral", text: "" };
}

function compatibilityCopy(value) {
  if (value === "compatible") return "兼容";
  if (value === "manual-review") return "需人工复核";
  if (value === "incompatible") return "不兼容";
  if (value === "checking") return "检查中";
  return "未知";
}

function phaseCopy(value) {
  return DATA_PHASE_COPY[cleanText(value)] || DATA_PHASE_COPY.unknown;
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return cleanText(value) || "-";
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function display(value) {
  return cleanText(value) || "-";
}

function stripSentenceEnd(value) {
  return String(value).replace(/[。；;]+$/u, "");
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}
