import fs from "node:fs";
import { getDefaultFlowerNamePaths } from "./game-data-version.mjs";
import { readActiveGameRelease } from "./game-release-version.mjs";

const flowerNameMapCache = new Map();

function fileStamp(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return [stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  } catch {
    return null;
  }
}

function cloneFlowerNameMap(names) {
  return { ...names };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

export function formatDateTime(value, emptyText = "-") {
  if (value == null || value === "") return emptyText;
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  if (!Number.isFinite(ms)) return emptyText;

  const dt = new Date(ms);
  return [
    dt.getFullYear(),
    pad2(dt.getMonth() + 1),
    pad2(dt.getDate()),
  ].join("-") + " " + [
    pad2(dt.getHours()),
    pad2(dt.getMinutes()),
    pad2(dt.getSeconds()),
  ].join(":");
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return "-";
  if (ms <= 0) return "可收获";

  const total = Math.ceil(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  if (d) return `${d}天${pad2(h)}小时${pad2(m)}分${pad2(s)}秒`;
  if (h) return `${h}小时${pad2(m)}分${pad2(s)}秒`;
  return `${m}分${pad2(s)}秒`;
}

export function formatWanNumber(value, emptyText = "-") {
  if (value === null || value === undefined || value === "") return emptyText;
  const text = String(value).trim().replace(/,/g, "");
  if (!/^-?\d+$/.test(text)) return String(value);
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  const groups = [];
  for (let end = digits.length; end > 0; end -= 4) {
    groups.unshift(digits.slice(Math.max(0, end - 4), end));
  }
  return `${negative ? "-" : ""}${groups.join(",")}`;
}

export function formatAccountLevelProgress(accountLevel = {}, emptyText = "-") {
  const currentExp = accountLevel.currentExp;
  const requiredExp = accountLevel.requiredExp;
  if (currentExp === null && requiredExp === null) return emptyText;
  if (currentExp === undefined && requiredExp === undefined) return accountLevel.progressText || emptyText;
  const currentText = formatWanNumber(currentExp);
  const requiredText = formatWanNumber(requiredExp);
  const currentNumber = Number(currentExp);
  const requiredNumber = Number(requiredExp);
  const hasCurrent = currentExp !== null && currentExp !== undefined && currentExp !== "";
  const hasRequired = requiredExp !== null && requiredExp !== undefined && requiredExp !== "";
  const percentText = hasCurrent && hasRequired && Number.isFinite(currentNumber) && Number.isFinite(requiredNumber) && requiredNumber > 0
    ? `（${((currentNumber / requiredNumber) * 100).toFixed(1)}%）`
    : "";
  return `${currentText}/${requiredText}${percentText}`;
}

function normalizeNameValue(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  for (const key of ["name", "zhName", "cnName", "nameCn", "title"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return "";
}

export function loadFlowerNameMap(paths, options = {}) {
  const release = paths ? null : readActiveGameRelease({ rootDir: options.rootDir || process.cwd() });
  const resolvedPaths = paths || (release ? [release.data.flowerNamesPath] : getDefaultFlowerNamePaths(options));
  const cacheKey = JSON.stringify(resolvedPaths.map((filePath) => String(filePath)));
  const stamps = resolvedPaths.map((filePath) => [String(filePath), fileStamp(filePath)]);
  const hasMissingFile = stamps.some(([, stamp]) => stamp === null);
  const cached = flowerNameMapCache.get(cacheKey);
  if (!hasMissingFile && cached && JSON.stringify(cached.stamps) === JSON.stringify(stamps)) {
    return cloneFlowerNameMap(cached.names);
  }
  const names = {};
  for (const filePath of resolvedPaths) {
    if (!fs.existsSync(filePath)) continue;
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) continue;
    const parsed = JSON.parse(raw);
    for (const [id, value] of Object.entries(parsed)) {
      const name = normalizeNameValue(value);
      if (name) names[String(id)] = name;
    }
  }
  if (!hasMissingFile) flowerNameMapCache.set(cacheKey, { names, stamps });
  return cloneFlowerNameMap(names);
}

export function flowerName(flowerId, nameMap = {}) {
  if (!flowerId) return "-";
  const key = String(flowerId);
  return nameMap[key] || `花-${key}`;
}

export function formatFlowerLabel(flowerId, nameMap = {}) {
  if (!flowerId) return "-";
  return `${flowerName(flowerId, nameMap)} (${flowerId})`;
}
