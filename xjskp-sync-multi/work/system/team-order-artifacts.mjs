import fs from "node:fs/promises";
import path from "node:path";

const MAX_PAGE = 100000;
const MAX_PAGE_SIZE = 50;
const SAFE_RUN_ID = /^[a-f0-9]{24}$/i;
const SAFE_LEDGER_NAME = /^[A-Za-z0-9_-]+\.json$/;

export function isSafeTeamOrderHtmlName(name) {
  return /^team-order-\d{8}T\d{6}\d{3}Z-[a-f0-9]{24}\.html$/i.test(String(name || ""));
}

export async function listTeamOrderArtifacts(dir, options = {}) {
  const page = boundedInteger(options.page, 1, MAX_PAGE, 1);
  const pageSize = boundedInteger(options.pageSize, 1, MAX_PAGE_SIZE, 20);
  let entries;
  let canonicalDir;
  try {
    canonicalDir = await resolveRealPathWithinRoot(options.containmentRoot || dir, dir);
    entries = await fs.readdir(canonicalDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { items: [], page, pageSize, total: 0, summary: emptySummary() };
    }
    throw error;
  }

  const items = await Promise.all(entries
    .filter((entry) => entry.isFile() && SAFE_LEDGER_NAME.test(entry.name))
    .map((entry) => readArtifactSummary(canonicalDir, entry.name)));
  items.sort((left, right) => (
    right.sortTime - left.sortTime
    || right.sourceName.localeCompare(left.sourceName)
  ));

  const start = (page - 1) * pageSize;
  const recent = items.find((item) => !item.readError && item.finishedAt) || null;
  return {
    items: items.slice(start, start + pageSize).map(publicItem),
    page,
    pageSize,
    total: items.length,
    summary: {
      current: null,
      recent: recent ? publicItem(recent) : null,
    },
  };
}

export async function resolveRealPathWithinRoot(rootDir, targetPath) {
  const canonicalRoot = await fs.realpath(rootDir);
  const canonicalTarget = await fs.realpath(targetPath);
  const relative = path.relative(canonicalRoot, canonicalTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const error = new Error("Team order artifact path escapes its profile root");
    error.code = "INVALID_PATH";
    error.statusCode = 400;
    throw error;
  }
  return canonicalTarget;
}

async function readArtifactSummary(canonicalDir, sourceName) {
  const filePath = path.join(canonicalDir, sourceName);
  const runId = sourceName.slice(0, -".json".length);
  let stat;
  try {
    const canonicalFilePath = await resolveRealPathWithinRoot(canonicalDir, filePath);
    stat = await fs.stat(canonicalFilePath);
    const ledger = JSON.parse(await fs.readFile(canonicalFilePath, "utf8"));
    const startedAt = valueOrNull(ledger?.startedAt);
    const ledgerRunId = String(ledger?.runId || "");
    const htmlName = String(ledger?.htmlFile || "");
    if (
      !SAFE_RUN_ID.test(runId)
      || ledgerRunId.toLowerCase() !== runId.toLowerCase()
      || htmlName.toLowerCase() !== canonicalHtmlName(startedAt, ledgerRunId).toLowerCase()
      || !isSafeTeamOrderHtmlName(htmlName)
    ) {
      return invalidArtifactSummary(runId, stat, sourceName, startedAt);
    }
    const eventSummary = summarizeEvents(ledger?.events);
    const serverOrderNum = valueOrNull(
      ledger?.serverOrderNum ?? ledger?.finalOrderNum,
    );
    const completedOrderCount = valueOrNull(
      ledger?.completedOrderCount
      ?? completedCountFromServerOrderNum(serverOrderNum),
    );
    return {
      runId,
      profileId: valueOrNull(ledger?.profileId),
      uid: valueOrNull(ledger?.uid),
      label: valueOrNull(ledger?.label),
      serverIdx: valueOrNull(ledger?.serverIdx),
      trigger: valueOrNull(ledger?.trigger),
      startedAt,
      finishedAt: valueOrNull(ledger?.finishedAt),
      initialOrderNum: valueOrNull(ledger?.initialOrderNum),
      finalOrderNum: valueOrNull(ledger?.finalOrderNum),
      serverOrderNum,
      completedOrderCount,
      finalStatus: valueOrNull(ledger?.finalStatus),
      stopReason: valueOrNull(ledger?.stopReason),
      multiplier: valueOrNull(ledger?.multiplier),
      reward: valueOrNull(ledger?.reward),
      paidRenew: ledger?.paidRenew === true,
      paidRenewAvailable: ledger?.paidRenewAvailable === true,
      paidRenewSkipped: ledger?.paidRenewSkipped === true,
      ...eventSummary,
      htmlName,
      readError: false,
      sortTime: validTime(ledger?.finishedAt, validTime(startedAt, stat.mtimeMs)),
      sourceName,
    };
  } catch {
    if (!stat) {
      stat = await fs.lstat(filePath).catch(() => ({ mtimeMs: 0 }));
    }
    return invalidArtifactSummary(runId, stat, sourceName);
  }
}

function summarizeEvents(events) {
  const source = Array.isArray(events) ? events : [];
  const latestOrderEvent = [...source].reverse().find((event) => (
    event?.flowerId != null
    || event?.flowerName != null
    || event?.need != null
  )) || null;
  return {
    flowerId: valueOrNull(latestOrderEvent?.flowerId),
    flowerName: valueOrNull(latestOrderEvent?.flowerName),
    need: valueOrNull(latestOrderEvent?.need),
    have: valueOrNull(
      latestOrderEvent?.inventoryAfter
      ?? latestOrderEvent?.inventoryBefore,
    ),
    submittedCount: source.filter((event) => (
      event?.action === "submit" && event?.status === "success"
    )).length,
    refreshedCount: source.filter((event) => (
      event?.action === "refresh" && event?.status === "success"
    )).length,
    skippedCount: source.filter((event) => (
      event?.action === "protected-flower" && event?.status === "skipped"
    )).length,
    errorCount: source.filter((event) => (
      event?.action !== "inventory-shortage"
      && event?.action !== "shortage"
      && event?.inventoryShortage !== true
      && (
        event?.action === "failure"
        || ["failure", "timeout", "server-rejected"].includes(event?.status)
      )
    )).length,
    inventoryShortageCount: source.filter((event) => (
      event?.action === "inventory-shortage"
      || event?.inventoryShortage === true
    )).length,
  };
}

function invalidArtifactSummary(runId, stat, sourceName, startedAt = null) {
  return {
    runId,
    profileId: null,
    startedAt,
    finishedAt: null,
    finalStatus: null,
    htmlName: null,
    readError: true,
    sortTime: validTime(startedAt, stat.mtimeMs),
    sourceName,
  };
}

function publicItem({ sortTime, sourceName, ...item }) {
  return item;
}

function emptySummary() {
  return { current: null, recent: null };
}

function canonicalHtmlName(startedAt, runId) {
  if (startedAt === null || startedAt === undefined || startedAt === "") return "";
  const timestamp = new Date(startedAt);
  if (!Number.isFinite(timestamp.getTime()) || !SAFE_RUN_ID.test(runId)) return "";
  const fileTimestamp = timestamp.toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".", "");
  return `team-order-${fileTimestamp}-${runId}.html`;
}

function boundedInteger(value, minimum, maximum, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function valueOrNull(value) {
  return value === undefined || value === "" ? null : value;
}

function completedCountFromServerOrderNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number - 1) : null;
}

function validTime(value, fallback) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : fallback;
}
