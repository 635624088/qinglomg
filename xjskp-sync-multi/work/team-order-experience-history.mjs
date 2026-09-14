import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER,
  isValidTeamOrderGuardMultiplier,
} from "./experience-settlement.mjs";

const HISTORY_VERSION = 1;

function toPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function toNonNegativeNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function accountKey(accountId) {
  const key = String(accountId ?? "").trim();
  return key || null;
}

export function loadTeamOrderExperienceHistory(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    return {
      version: HISTORY_VERSION,
      accounts: {},
      damaged: true,
      damageReason: error?.message || String(error),
    };
  }
}

export function saveTeamOrderExperienceHistory(filePath, history) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(history, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Preserve the original persistence error.
    }
    throw error;
  }
}

export function getAccountTeamOrderExperienceHistory(history, accountId) {
  const key = accountKey(accountId);
  if (!key || history?.damaged === true) return history?.damaged ? { damaged: true } : null;
  const value = history?.accounts?.[key];
  return value && typeof value === "object" ? value : null;
}

export function recordCompletedTeamOrderExperience({
  history,
  accountId,
  actualExpDelta,
  completed,
  settlementStatus,
  now = new Date().toISOString(),
} = {}) {
  const key = accountKey(accountId);
  const sample = toPositiveNumber(actualExpDelta);
  if (!key || completed !== true || settlementStatus !== "completed" || sample == null) {
    return history && typeof history === "object" ? history : {};
  }

  const source = history && typeof history === "object" && !Array.isArray(history)
    ? history
    : {};
  const accounts = {
    ...(source.accounts && typeof source.accounts === "object" ? source.accounts : {}),
  };
  const previous = accounts[key] && typeof accounts[key] === "object"
    ? accounts[key]
    : {};
  const previousMax = toPositiveNumber(previous.accountHistoricalMaxFinalExp) ?? 0;
  accounts[key] = {
    ...previous,
    accountHistoricalMaxFinalExp: Math.max(previousMax, sample),
    sampleCount: Math.max(0, Number(previous.sampleCount) || 0) + 1,
    lastFinalExp: sample,
    updatedAt: now,
  };
  return {
    ...source,
    version: HISTORY_VERSION,
    accounts,
  };
}

export function evaluateTeamOrderTrigger({
  remainingLevelExp,
  minimumRemainingExp,
  triggeringResidentOrderMaxExp,
  triggerProtectionEnabled,
  history,
  guardMultiplier,
} = {}) {
  const effectiveGuardMultiplier = isValidTeamOrderGuardMultiplier(guardMultiplier)
    ? guardMultiplier
    : DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER;

  if (triggerProtectionEnabled !== false) {
    return {
      blocked: true,
      coldStartBypass: false,
      forceTriggerProtectionEnabled: true,
      accountHistoricalMaxFinalExp: null,
      teamOrderGuardExp: null,
      requiredExperienceSpace: null,
      reason: "trigger-protection-enabled",
    };
  }

  if (history == null) {
    return {
      blocked: false,
      coldStartBypass: true,
      forceTriggerProtectionEnabled: false,
      accountHistoricalMaxFinalExp: null,
      teamOrderGuardExp: null,
      requiredExperienceSpace: null,
      reason: "cold-start-user-authorized",
    };
  }

  const historicalMax = toPositiveNumber(history?.accountHistoricalMaxFinalExp);
  if (history?.damaged === true || historicalMax == null) {
    return {
      blocked: true,
      coldStartBypass: false,
      forceTriggerProtectionEnabled: true,
      accountHistoricalMaxFinalExp: historicalMax,
      teamOrderGuardExp: historicalMax == null ? null : historicalMax * effectiveGuardMultiplier,
      requiredExperienceSpace: null,
      reason: "team-history-invalid",
    };
  }

  const remaining = toPositiveNumber(remainingLevelExp);
  const minimumRemaining = toNonNegativeNumber(minimumRemainingExp);
  const triggerExp = toPositiveNumber(triggeringResidentOrderMaxExp);
  const teamOrderGuardExp = historicalMax * effectiveGuardMultiplier;
  if (remaining == null || minimumRemaining == null || triggerExp == null) {
    return {
      blocked: true,
      coldStartBypass: false,
      forceTriggerProtectionEnabled: true,
      accountHistoricalMaxFinalExp: historicalMax,
      minimumRemainingExp: minimumRemaining,
      teamOrderGuardExp,
      requiredExperienceSpace: null,
      reason: "team-trigger-experience-unknown",
    };
  }

  const requiredExperienceSpace =
    minimumRemaining + triggerExp + teamOrderGuardExp;
  const blocked = remaining <= requiredExperienceSpace;
  return {
    blocked,
    coldStartBypass: false,
    forceTriggerProtectionEnabled: blocked,
    accountHistoricalMaxFinalExp: historicalMax,
    minimumRemainingExp: minimumRemaining,
    teamOrderGuardExp,
    requiredExperienceSpace,
    reason: blocked
      ? "insufficient-experience-space"
      : "historical-experience-space-available",
  };
}
