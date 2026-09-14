import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { loadFlowerNameMap } from "./status-format.mjs";

const HTML_REFRESH_DELAY_MS = 225;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const FAILED_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "rejected",
  "server-rejected",
  "timeout",
]);
const SENSITIVE_KEY_PATTERN =
  /(token|cookie|authorization|password|session|credential|login)/i;
const EVENT_FIELDS = [
  "action",
  "status",
  "flowerId",
  "flowerName",
  "need",
  "inventoryBefore",
  "inventoryAfter",
  "orderNumBefore",
  "orderNumAfter",
  "flowerConsumed",
  "inventoryShortage",
  "description",
  "message",
  "error",
  "reason",
  "costItemId",
  "costAmount",
  "balanceBefore",
  "balanceAfter",
  "remainingNumBefore",
  "remainingNumAfter",
  "confirmationEvidence",
  "serverConfirmed",
];
const ERROR_FIELDS = [
  "name",
  "message",
  "code",
  "status",
  "statusCode",
  "reason",
  "param",
  "schema",
  "phase",
  "context",
  "details",
  "cause",
];

function redactSensitiveText(value) {
  const text = String(value);
  return /\b(?:token|cookie|authorization|password|session(?:id)?|login(?:[\s_-]*credential)?|credential)\b(?=\s|[:=]|$)/i.test(
    text,
  )
    ? "[REDACTED]"
    : text;
}

function sanitizeJsonValue(value, seen = new WeakSet()) {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeJsonValue(item, seen) ?? null);
    }

    const result = {};
    for (const key of Object.keys(value)) {
      if (
        SENSITIVE_KEY_PATTERN.test(key) ||
        key === "__proto__" ||
        key === "prototype" ||
        key === "constructor"
      ) {
        continue;
      }
      let child;
      try {
        child = sanitizeJsonValue(value[key], seen);
      } catch {
        child = "[unavailable]";
      }
      if (child !== undefined) {
        result[key] = child;
      }
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function jsonSafeSnapshot(value) {
  return sanitizeJsonValue(value);
}

function sanitizeErrorSummary(error) {
  if (
    error === null ||
    error === undefined ||
    typeof error === "string" ||
    typeof error !== "object"
  ) {
    return jsonSafeSnapshot(error);
  }

  const summary = {};
  for (const key of ERROR_FIELDS) {
    if (!Object.hasOwn(error, key) || SENSITIVE_KEY_PATTERN.test(key)) {
      continue;
    }
    const value =
      key === "message" || key === "reason"
        ? redactSensitiveText(error[key])
        : jsonSafeSnapshot(error[key]);
    if (value !== undefined) {
      summary[key] = value;
    }
  }
  if (Object.keys(summary).length > 0) {
    return summary;
  }
  return redactSensitiveText(String(error));
}

function normalizeEvent(event = {}) {
  const source = event && typeof event === "object" ? event : {};
  const normalized = {};
  for (const key of EVENT_FIELDS) {
    if (!Object.hasOwn(source, key)) {
      continue;
    }
    const value =
      key === "error"
        ? sanitizeErrorSummary(source[key])
        : jsonSafeSnapshot(source[key]);
    if (value !== undefined) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function normalizeRestoredEvent(event, fallbackSequence) {
  const normalized = normalizeEvent(event);
  normalized.sequence = Number.isFinite(Number(event?.sequence))
    ? Number(event.sequence)
    : fallbackSequence;
  normalized.timestampMs = Number.isFinite(Number(event?.timestampMs))
    ? Number(event.timestampMs)
    : null;
  normalized.timestamp = jsonSafeSnapshot(event?.timestamp ?? null);
  return normalized;
}

function normalizeArchiveError(error, fallbackSequence) {
  return {
    sequence: Number.isFinite(Number(error?.sequence))
      ? Number(error.sequence)
      : fallbackSequence,
    timestampMs: Number.isFinite(Number(error?.timestampMs))
      ? Number(error.timestampMs)
      : null,
    timestamp: jsonSafeSnapshot(error?.timestamp ?? null),
    phase: jsonSafeSnapshot(error?.phase ?? "archive-write"),
    message: redactSensitiveText(
      error?.message ?? error ?? "Archive write failed",
    ).slice(0, 500),
  };
}

export function createTeamOrderRunId(identity = {}) {
  const stable = [
    identity.profileId,
    identity.uid,
    identity.startTime,
  ]
    .map((value) => String(value ?? ""))
    .join("|");
  return createHash("sha256").update(stable).digest("hex").slice(0, 24);
}

function assertSafeSegment(value, label) {
  if (!SAFE_SEGMENT_PATTERN.test(String(value || ""))) {
    throw new Error(`Invalid ${label}`);
  }
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Invalid archive timestamp");
  }
  return date;
}

function timestampForFile(value) {
  return asDate(value)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "")
    .replace("Z", "Z");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayValue(value, fallback = "—") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[unserializable]";
    }
  }
  return String(value);
}

function loadArchiveFlowerNames() {
  try {
    return loadFlowerNameMap();
  } catch {
    return {};
  }
}

function resolvedArchiveFlowerName(event, flowerNames = {}) {
  const flowerId = event?.flowerId;
  const mappedName = flowerId === null || flowerId === undefined
    ? ""
    : String(flowerNames[String(flowerId)] ?? "").trim();
  return mappedName || (event?.flowerName ?? null);
}

function eventDescription(event) {
  return (
    event.description ??
    event.message ??
    event.error ??
    event.reason ??
    ""
  );
}

function actionText(action) {
  return {
    accept: "接取订单",
    submit: "提交订单",
    refresh: "刷新订单",
    "inventory-shortage": "库存不足",
    shortage: "库存不足",
    settle: "结算奖励",
    failure: "执行错误",
    stop: "停止任务",
    "paid-renew": "付费续单",
    "paid-renew-skipped": "跳过付费续单",
  }[action] || displayValue(action);
}

function statusText(status) {
  return {
    success: "成功",
    failure: "失败",
    timeout: "超时",
    "server-rejected": "服务端拒绝",
    unchanged: "状态未变化",
    pending: "等待确认",
    skipped: "已跳过",
    stopped: "已停止",
  }[status] || displayValue(status);
}

function descriptionText(event) {
  const description = eventDescription(event);
  if (
    !description
    && ["inventory-shortage", "shortage"].includes(event?.action)
  ) {
    return "库存不足";
  }
  return {
    "paid-resource-disabled": "付费续单已禁用",
    "paid-renew-protection-enabled": "元宝续次数保护已开启",
    "paid-renew-protection-read-failed": "保护设置读取失败",
    "invalid-paid-renew-config": "付费续单配置异常",
    "insufficient-yuanbao": "元宝余额不足",
    "paid-renew-server-rejected": "服务端拒绝付费续单",
    "paid-renew-result-unknown": "付费续单结果无法确认",
    "server-confirmed": "服务端已确认付费续单",
    "user-stopped": "用户停止任务",
    "request-result-unknown": "请求结果暂无法确认",
    "truth-confirmed": "已由服务端状态确认",
    "result-in-doubt": "请求结果等待确认",
    "unknown-state-limit": "未知状态次数达到上限",
    "request-limit": "请求次数达到上限",
    "server-window-ended": "服务端挑战窗口已结束",
    "server-rejected": "服务端拒绝请求",
    "server-rejected-recovered": "服务端拒绝后已恢复",
    settle: "结算奖励",
    "idempotent-confirmed": "已确认重复结算结果",
    "request-pending": "请求仍在处理中",
    "unknown-status": "服务端返回未知状态",
    "missing-order-config": "缺少当前订单配置",
    "insufficient-inventory": "库存不足",
    "runner-error": "组团订单执行异常",
  }[description] || displayValue(description, "");
}

function detailResultText(detail) {
  if (detail.action === "submit" && detail.status === "success") {
    return "已提交";
  }
  if (["inventory-shortage", "shortage"].includes(detail.action)) {
    return "库存不足";
  }
  if (detail.action === "refresh" && detail.status === "success") {
    return "刷新成功";
  }
  return statusText(detail.status);
}

function consumedFlowerCount(event) {
  const explicit = Number(event?.flowerConsumed);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  if (event?.action !== "submit" || event?.status !== "success") return 0;
  const before = Number(event?.inventoryBefore);
  const after = Number(event?.inventoryAfter);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0;
  return Math.max(0, before - after);
}

function buildOrderDetails(events = [], flowerNames = {}) {
  return events
    .filter((event) => [
      "submit",
      "refresh",
      "inventory-shortage",
    ].includes(String(event?.action ?? "")))
    .map((event, index) => ({
      sequence: index + 1,
      eventSequence: event.sequence ?? null,
      timestamp: event.timestamp ?? null,
      orderNum: event.orderNumBefore ?? event.orderNumAfter ?? null,
      orderNumAfter: event.orderNumAfter ?? null,
      flowerId: event.flowerId ?? null,
      flowerName: resolvedArchiveFlowerName(event, flowerNames),
      need: event.need ?? null,
      inventoryBefore: event.inventoryBefore ?? null,
      inventoryAfter: event.inventoryAfter ?? null,
      flowerConsumed: consumedFlowerCount(event),
      action: event.action ?? null,
      actionText: actionText(event.action),
      status: event.status ?? null,
      statusText: statusText(event.status),
      submitted:
        event.action === "submit"
        && event.status === "success",
      description: displayValue(eventDescription(event), ""),
      descriptionText: descriptionText(event),
    }));
}

function formatChineseNumericGroup(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return displayValue(value);
  const [integerPart, fractionPart] = String(numeric).split(".");
  const sign = integerPart.startsWith("-") ? "-" : "";
  const digits = sign ? integerPart.slice(1) : integerPart;
  const grouped = digits.replace(/\B(?=(\d{4})+(?!\d))/g, ",");
  return `${sign}${grouped}${fractionPart ? `.${fractionPart}` : ""}`;
}

function rewardDisplayText(reward) {
  if (Array.isArray(reward?.items) && reward.items.length > 0) {
    return reward.items
      .map((item) => (
        `${displayValue(item.itemName, `物品 #${displayValue(item.itemId)}`)} ${
          formatChineseNumericGroup(item.displayedAmount ?? item.rawAmount)
        }`
      ))
      .join("；");
  }
  if (reward?.displayText) return String(reward.displayText);
  return displayValue(reward);
}

const BEIJING_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function formatBeijingDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return displayValue(value);
  const parts = Object.fromEntries(
    BEIJING_DATE_TIME_FORMATTER
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function formatDuration(milliseconds) {
  let remainingSeconds = Math.floor(
    Math.max(0, Number(milliseconds) || 0) / 1_000,
  );
  const days = Math.floor(remainingSeconds / 86_400);
  remainingSeconds %= 86_400;
  const hours = Math.floor(remainingSeconds / 3_600);
  remainingSeconds %= 3_600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return [
    days ? `${days}天` : "",
    hours ? `${hours}小时` : "",
    minutes ? `${minutes}分` : "",
    seconds || (!days && !hours && !minutes) ? `${seconds}秒` : "",
  ].join("");
}

function summarize(ledger) {
  let successfulSubmissions = 0;
  let shortages = 0;
  let protectedFlowerSkips = 0;
  let refreshes = 0;
  let failures = 0;
  let flowersConsumed = 0;

  for (const event of ledger.events) {
    const action = String(event.action ?? "");
    const status = String(event.status ?? "");
    if (action === "submit" && status === "success") {
      successfulSubmissions += 1;
      const explicitConsumed = Number(event.flowerConsumed);
      const inventoryBefore = Number(event.inventoryBefore);
      const inventoryAfter = Number(event.inventoryAfter);
      if (Number.isFinite(explicitConsumed) && explicitConsumed >= 0) {
        flowersConsumed += explicitConsumed;
      } else if (
        Number.isFinite(inventoryBefore) &&
        Number.isFinite(inventoryAfter)
      ) {
        flowersConsumed += Math.max(0, inventoryBefore - inventoryAfter);
      }
    }
    if (
      action === "inventory-shortage" ||
      action === "shortage" ||
      event.inventoryShortage === true
    ) {
      shortages += 1;
    }
    if (action === "protected-flower" && status === "skipped") {
      protectedFlowerSkips += 1;
    }
    if (action === "refresh") {
      refreshes += 1;
    }
    if (
      !["inventory-shortage", "shortage"].includes(action)
      && event.inventoryShortage !== true
      && FAILED_STATUSES.has(status)
    ) {
      failures += 1;
    }
  }

  return {
    successfulSubmissions,
    shortages,
    protectedFlowerSkips,
    refreshes,
    failures,
    flowersConsumed,
  };
}

export function renderTeamOrderArchiveHtml(ledger, options = {}) {
  const flowerNames = options.flowerNames ?? loadArchiveFlowerNames();
  const summary = summarize(ledger);
  const startedMs = Date.parse(ledger.startedAt);
  const finishedMs = ledger.finishedAt ? Date.parse(ledger.finishedAt) : NaN;
  const duration =
    Number.isFinite(startedMs) && Number.isFinite(finishedMs)
      ? formatDuration(finishedMs - startedMs)
      : "进行中";
  const account = ledger.label
    ? `${displayValue(ledger.label)} (${displayValue(ledger.uid)})`
    : displayValue(ledger.uid);
  const rows = ledger.events
    .map((event) => {
      const orderProgress =
        event.orderNumBefore === undefined && event.orderNumAfter === undefined
          ? "—"
          : `${displayValue(event.orderNumBefore)} → ${displayValue(event.orderNumAfter)}`;
      const flowerName = resolvedArchiveFlowerName(event, flowerNames);
      const flower =
        event.flowerId === undefined && event.flowerName === undefined
          ? "—"
          : `${displayValue(flowerName)} (#${displayValue(event.flowerId)})`;
      return `<tr>
        <td>${escapeHtml(event.sequence)}</td>
        <td>${escapeHtml(formatBeijingDateTime(event.timestamp))}</td>
        <td>${escapeHtml(orderProgress)}</td>
        <td>${escapeHtml(flower)}</td>
        <td>${escapeHtml(displayValue(event.need))}</td>
        <td>${escapeHtml(displayValue(event.inventoryBefore))}</td>
        <td>${escapeHtml(actionText(event.action))}</td>
        <td>${escapeHtml(statusText(event.status))}</td>
        <td>${escapeHtml(descriptionText(event))}</td>
      </tr>`;
    })
    .join("\n");
  const item = (label, value) =>
    `<dt>${label}</dt><dd>${escapeHtml(displayValue(value))}</dd>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>组团订单归档 ${escapeHtml(ledger.runId)}</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 24px; color: #172033; background: #f4f7fb; }
    main { max-width: 1280px; margin: 0 auto; }
    h1 { margin: 0 0 18px; font-size: 26px; }
    dl { display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); gap: 1px; background: #d9e1ec; border: 1px solid #d9e1ec; }
    dt, dd { margin: 0; padding: 10px 12px; background: white; overflow-wrap: anywhere; }
    dt { color: #526074; font-weight: 600; }
    table { width: 100%; margin-top: 22px; border-collapse: collapse; background: white; }
    th, td { padding: 10px; border: 1px solid #d9e1ec; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { background: #edf2f8; white-space: nowrap; }
    tbody tr:nth-child(even) { background: #f8fafc; }
  </style>
</head>
<body>
<main>
  <h1>组团订单归档</h1>
  <dl>
    ${item("账号", account)}
    ${item("区服", ledger.serverIdx)}
    ${item("触发来源", ledger.trigger)}
    ${item("开始时间", formatBeijingDateTime(ledger.startedAt))}
    ${item(
      "结束时间",
      ledger.finishedAt ? formatBeijingDateTime(ledger.finishedAt) : "进行中",
    )}
    ${item("持续时间", duration)}
    ${item("初始订单号", ledger.initialOrderNum)}
    ${item("服务端最终订单号", ledger.serverOrderNum ?? ledger.finalOrderNum)}
    ${item("完成订单数", ledger.completedOrderCount)}
    ${item("成功提交", summary.successfulSubmissions)}
    ${item("库存不足", summary.shortages)}
    ${item("保护花跳过次数", summary.protectedFlowerSkips)}
    ${item("刷新次数", summary.refreshes)}
    ${item("失败次数", summary.failures)}
    ${item("累计消耗鲜花", summary.flowersConsumed)}
    ${item("最终倍率", ledger.multiplier)}
    ${item("奖励", rewardDisplayText(ledger.reward))}
    ${item("最终状态", ledger.finalStatus)}
    ${item("停止原因", ledger.stopReason)}
    ${item(
      "付费续单",
      Number(ledger.paidRenewPurchasedCount) > 0
        ? "已自动购买并完成续开"
        : ledger.paidRenewSkipped
        ? "检测到并已跳过"
        : ledger.paidRenewAvailable
          ? "可用但未执行"
          : "否",
    )}
    ${item("自动购买次数", ledger.paidRenewPurchasedCount ?? 0)}
    ${item("已确认元宝消耗", ledger.paidRenewConfirmedCost ?? 0)}
  </dl>
  <h2>完整操作流水</h2>
  <table>
    <thead>
      <tr><th>序号</th><th>时间</th><th>订单进度</th><th>花朵</th><th>数量</th><th>提交前库存</th><th>操作</th><th>状态</th><th>说明</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</main>
</body>
</html>
`;
}

export function createTeamOrderArchive(options = {}) {
  const statusDir = options.statusDir ?? process.env.STATUS_DOC_DIR;
  const profileId = String(options.profileId ?? "");
  const uid = String(options.uid ?? "");
  const runId = String(options.runId ?? "");
  const label = jsonSafeSnapshot(options.label ?? "");
  const serverIdx = jsonSafeSnapshot(options.serverIdx ?? "");
  assertSafeSegment(profileId, "profileId");
  assertSafeSegment(runId, "runId");
  if (!statusDir) {
    throw new Error("Missing statusDir");
  }

  const fileSystem = options.fileSystem ?? fs;
  const now = options.now ?? (() => new Date());
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  const flowerNames = options.flowerNames ?? loadArchiveFlowerNames();
  const archiveDir = path.join(path.resolve(String(statusDir)), "team-orders");
  const jsonPath = path.join(archiveDir, `${runId}.json`);
  const expectedHtmlPattern = new RegExp(
    `^team-order-[A-Za-z0-9_-]+-${runId}\\.html$`,
  );

  let ledger;
  let startPersisted = false;
  let finishPersisted = false;
  let ledgerDirty = false;
  let ledgerRevision = 0;
  let persistedLedger = null;
  let htmlTimer = null;
  let operationTail = Promise.resolve();
  let jsonWriteTail = Promise.resolve();
  let htmlWriteTail = Promise.resolve();

  async function atomicWrite(filePath, content) {
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await fileSystem.writeFile(tmpPath, content, "utf8");
      await fileSystem.rename(tmpPath, filePath);
    } finally {
      await fileSystem.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  function enqueueOperation(task) {
    const current = operationTail.catch(() => {}).then(task);
    operationTail = current;
    return current;
  }

  function markLedgerDirty() {
    ledgerDirty = true;
    ledgerRevision += 1;
  }

  function writeJsonSnapshot() {
    const revision = ledgerRevision;
    const snapshot = jsonSafeSnapshot(ledger);
    snapshot.orderDetails = buildOrderDetails(snapshot.events, flowerNames);
    const content = `${JSON.stringify(snapshot, null, 2)}\n`;
    const current = jsonWriteTail
      .catch(() => {})
      .then(async () => {
        await atomicWrite(jsonPath, content);
        persistedLedger = snapshot;
        if (ledgerRevision === revision) {
          ledgerDirty = false;
        }
      });
    jsonWriteTail = current;
    return current;
  }

  function htmlPath() {
    if (!ledger?.htmlFile || !expectedHtmlPattern.test(ledger.htmlFile)) {
      throw new Error("Invalid archive HTML filename");
    }
    return path.join(archiveDir, ledger.htmlFile);
  }

  function recordArchiveError(error) {
    const timestamp = asDate(now());
    ledger.archiveErrors.push({
      sequence: ledger.archiveErrors.length + 1,
      timestampMs: timestamp.getTime(),
      timestamp: timestamp.toISOString(),
      phase: "html-write",
      message: redactSensitiveText(
        error?.message ?? error ?? "HTML archive write failed",
      ).slice(0, 500),
    });
    markLedgerDirty();
  }

  function queueHtmlWrite() {
    const current = htmlWriteTail.catch(() => {}).then(async () => {
      try {
        if (!persistedLedger) {
          return;
        }
        await atomicWrite(
          htmlPath(),
          renderTeamOrderArchiveHtml(persistedLedger, { flowerNames }),
        );
      } catch (error) {
        recordArchiveError(error);
        await writeJsonSnapshot().catch(() => {});
      }
    });
    htmlWriteTail = current;
    return current;
  }

  function cancelHtmlTimer() {
    if (htmlTimer !== null) {
      clearTimeoutFn(htmlTimer);
      htmlTimer = null;
    }
  }

  function scheduleHtmlWrite() {
    if (htmlTimer !== null) {
      return;
    }
    htmlTimer = setTimeoutFn(() => {
      htmlTimer = null;
      void queueHtmlWrite();
    }, HTML_REFRESH_DELAY_MS);
  }

  async function forceHtmlWrite() {
    cancelHtmlTimer();
    await queueHtmlWrite();
    await jsonWriteTail.catch(() => {});
  }

  function assertStarted() {
    if (!startPersisted || !ledger) {
      throw new Error("Team order archive has not started");
    }
  }

  async function start(initial = {}) {
    const initialSnapshot = {
      trigger: jsonSafeSnapshot(initial?.trigger ?? ""),
      initialOrderNum: jsonSafeSnapshot(initial?.initialOrderNum ?? null),
    };
    await enqueueOperation(async () => {
      if (!ledger) {
        await fileSystem.mkdir(archiveDir, { recursive: true });
        try {
          const restored = JSON.parse(
            await fileSystem.readFile(jsonPath, "utf8"),
          );
          if (
            String(restored?.runId ?? "") !== runId ||
            String(restored?.profileId ?? "") !== profileId ||
            String(restored?.uid ?? "") !== uid ||
            String(restored?.serverIdx ?? "") !== String(serverIdx ?? "")
          ) {
            throw new Error("Archive identity mismatch");
          }
          const restoredHtmlFile = String(restored.htmlFile ?? "");
          if (!expectedHtmlPattern.test(restoredHtmlFile)) {
            throw new Error("Invalid archive HTML filename");
          }
          ledger = {
            version: 1,
            runId,
            profileId,
            uid,
            label: jsonSafeSnapshot(restored.label ?? label),
            serverIdx: jsonSafeSnapshot(restored.serverIdx ?? serverIdx),
            trigger: jsonSafeSnapshot(restored.trigger ?? ""),
            startedAt: jsonSafeSnapshot(restored.startedAt ?? null),
            finishedAt: jsonSafeSnapshot(restored.finishedAt ?? null),
            initialOrderNum: jsonSafeSnapshot(
              restored.initialOrderNum ?? null,
            ),
            finalOrderNum: jsonSafeSnapshot(restored.finalOrderNum ?? null),
            serverOrderNum: jsonSafeSnapshot(
              restored.serverOrderNum ?? restored.finalOrderNum ?? null,
            ),
            completedOrderCount: jsonSafeSnapshot(
              restored.completedOrderCount ?? null,
            ),
            finalStatus: jsonSafeSnapshot(restored.finalStatus ?? "running"),
            stopReason: jsonSafeSnapshot(restored.stopReason ?? null),
            multiplier: jsonSafeSnapshot(restored.multiplier ?? null),
            reward: jsonSafeSnapshot(restored.reward ?? null),
            paidRenew:
              restored.paidRenew === true
              || Math.max(0, Number(restored.paidRenewPurchasedCount) || 0) > 0,
            paidRenewAvailable: restored.paidRenewAvailable === true,
            paidRenewSkipped: restored.paidRenewSkipped === true,
            paidRenewPurchasedCount: Math.max(
              0,
              Number(restored.paidRenewPurchasedCount) || 0,
            ),
            paidRenewConfirmedCost: Math.max(
              0,
              Number(restored.paidRenewConfirmedCost) || 0,
            ),
            htmlFile: restoredHtmlFile,
            events: Array.isArray(restored.events)
              ? restored.events.map((event, index) =>
                  normalizeRestoredEvent(event, index + 1),
                )
              : [],
            archiveErrors: Array.isArray(restored.archiveErrors)
              ? restored.archiveErrors.map((error, index) =>
                  normalizeArchiveError(error, index + 1),
                )
              : [],
          };
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
          const startedAt = asDate(now());
          ledger = {
            version: 1,
            runId,
            profileId,
            uid,
            label,
            serverIdx,
            trigger: initialSnapshot.trigger,
            startedAt: startedAt.toISOString(),
            finishedAt: null,
            initialOrderNum: initialSnapshot.initialOrderNum,
            finalOrderNum: initialSnapshot.initialOrderNum,
            serverOrderNum: initialSnapshot.initialOrderNum,
            completedOrderCount: null,
            finalStatus: "running",
            stopReason: null,
            multiplier: null,
            reward: null,
            paidRenew: false,
            paidRenewAvailable: false,
            paidRenewSkipped: false,
            paidRenewPurchasedCount: 0,
            paidRenewConfirmedCost: 0,
            htmlFile: `team-order-${timestampForFile(startedAt)}-${runId}.html`,
            events: [],
            archiveErrors: [],
          };
        }
        markLedgerDirty();
      }
      if (!startPersisted || ledgerDirty) {
        await writeJsonSnapshot();
        startPersisted = true;
        finishPersisted = Boolean(ledger.finishedAt);
      }
    });
    await forceHtmlWrite();
  }

  function append(event = {}) {
    const eventSnapshot = normalizeEvent(event);
    return enqueueOperation(async () => {
      assertStarted();
      const timestamp = asDate(now());
      const record = {
        ...eventSnapshot,
        sequence: ledger.events.length + 1,
        timestampMs: timestamp.getTime(),
        timestamp: timestamp.toISOString(),
      };
      ledger.events.push(record);
      markLedgerDirty();
      await writeJsonSnapshot();
      scheduleHtmlWrite();
      return jsonSafeSnapshot(record);
    });
  }

  async function finish(result = {}) {
    const resultSnapshot = {
      finalStatus: jsonSafeSnapshot(result?.finalStatus),
      finalOrderNum: jsonSafeSnapshot(result?.finalOrderNum),
      serverOrderNum: jsonSafeSnapshot(result?.serverOrderNum),
      completedOrderCount: jsonSafeSnapshot(
        result?.completedOrderCount,
      ),
      multiplier: jsonSafeSnapshot(result?.multiplier),
      reward: jsonSafeSnapshot(result?.reward),
      stopReason: jsonSafeSnapshot(result?.stopReason),
      paidRenewAvailable: result?.paidRenewAvailable === true,
      paidRenewSkipped: result?.paidRenewSkipped === true,
      paidRenewPurchasedCount: Math.max(
        0,
        Number(result?.paidRenewPurchasedCount) || 0,
      ),
      paidRenewConfirmedCost: Math.max(
        0,
        Number(result?.paidRenewConfirmedCost) || 0,
      ),
    };
    await enqueueOperation(async () => {
      assertStarted();
      if (!ledger.finishedAt) {
        const finishedAt = asDate(now());
        ledger.finishedAt = finishedAt.toISOString();
        ledger.finalStatus =
          resultSnapshot.finalStatus ?? ledger.finalStatus;
        ledger.finalOrderNum =
          resultSnapshot.finalOrderNum ?? ledger.finalOrderNum;
        ledger.serverOrderNum =
          resultSnapshot.serverOrderNum
          ?? resultSnapshot.finalOrderNum
          ?? ledger.serverOrderNum;
        ledger.completedOrderCount =
          resultSnapshot.completedOrderCount
          ?? ledger.completedOrderCount;
        ledger.multiplier = resultSnapshot.multiplier ?? ledger.multiplier;
        ledger.reward = resultSnapshot.reward ?? ledger.reward;
        ledger.stopReason = resultSnapshot.stopReason ?? ledger.stopReason;
        ledger.paidRenew = resultSnapshot.paidRenewPurchasedCount > 0;
        ledger.paidRenewAvailable =
          resultSnapshot.paidRenewAvailable;
        ledger.paidRenewSkipped =
          resultSnapshot.paidRenewSkipped;
        ledger.paidRenewPurchasedCount =
          resultSnapshot.paidRenewPurchasedCount;
        ledger.paidRenewConfirmedCost =
          resultSnapshot.paidRenewConfirmedCost;
        finishPersisted = false;
        markLedgerDirty();
      }
      if (!finishPersisted || ledgerDirty) {
        await writeJsonSnapshot();
        finishPersisted = true;
      }
    });
    await forceHtmlWrite();
  }

  async function commit(payload = {}) {
    const initial = payload?.initial && typeof payload.initial === "object"
      ? payload.initial
      : {};
    const result = payload?.result && typeof payload.result === "object"
      ? payload.result
      : {};
    const sourceEvents = Array.isArray(payload?.events) ? payload.events : [];

    return enqueueOperation(async () => {
      const finishedAt = asDate(now());
      const startedAt = asDate(initial.startedAt ?? finishedAt);
      const htmlFile =
        `team-order-${timestampForFile(startedAt)}-${runId}.html`;
      const events = sourceEvents.map((event, index) => {
        const normalized = normalizeEvent(event);
        const eventTime = asDate(
          event?.timestampMs
          ?? event?.timestamp
          ?? finishedAt,
        );
        return {
          ...normalized,
          sequence: index + 1,
          timestampMs: eventTime.getTime(),
          timestamp: eventTime.toISOString(),
        };
      });
      const committedLedger = {
        version: 2,
        runId,
        profileId,
        uid,
        label,
        serverIdx,
        trigger: jsonSafeSnapshot(initial.trigger ?? ""),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        initialOrderNum: jsonSafeSnapshot(initial.initialOrderNum ?? null),
        finalOrderNum: jsonSafeSnapshot(
          result.finalOrderNum
          ?? initial.initialOrderNum
          ?? null,
        ),
        serverOrderNum: jsonSafeSnapshot(
          result.serverOrderNum
          ?? result.finalOrderNum
          ?? initial.initialOrderNum
          ?? null,
        ),
        completedOrderCount: jsonSafeSnapshot(
          result.completedOrderCount ?? null,
        ),
        finalStatus: jsonSafeSnapshot(result.finalStatus ?? "completed"),
        stopReason: jsonSafeSnapshot(result.stopReason ?? null),
        multiplier: jsonSafeSnapshot(result.multiplier ?? null),
        reward: jsonSafeSnapshot(result.reward ?? null),
        paidRenew: Math.max(
          0,
          Number(result.paidRenewPurchasedCount) || 0,
        ) > 0,
        paidRenewAvailable: result.paidRenewAvailable === true,
        paidRenewSkipped: result.paidRenewSkipped === true,
        paidRenewPurchasedCount: Math.max(
          0,
          Number(result.paidRenewPurchasedCount) || 0,
        ),
        paidRenewConfirmedCost: Math.max(
          0,
          Number(result.paidRenewConfirmedCost) || 0,
        ),
        htmlFile,
        events,
        orderDetails: buildOrderDetails(events, flowerNames),
        archiveErrors: [],
      };

      await atomicWrite(
        jsonPath,
        `${JSON.stringify(committedLedger, null, 2)}\n`,
      );
      await atomicWrite(
        path.join(archiveDir, htmlFile),
        renderTeamOrderArchiveHtml(committedLedger, { flowerNames }),
      );

      ledger = committedLedger;
      persistedLedger = jsonSafeSnapshot(committedLedger);
      startPersisted = true;
      finishPersisted = true;
      ledgerDirty = false;
      return jsonSafeSnapshot(committedLedger);
    });
  }

  async function flush() {
    await enqueueOperation(async () => {
      assertStarted();
      const paidRenew = Number(ledger.paidRenewPurchasedCount) > 0;
      if (ledger.paidRenew !== paidRenew) {
        ledger.paidRenew = paidRenew;
        markLedgerDirty();
      }
      if (ledgerDirty) {
        await writeJsonSnapshot();
      }
    });
    await forceHtmlWrite();
  }

  return {
    start,
    append,
    finish,
    commit,
    flush,
  };
}
