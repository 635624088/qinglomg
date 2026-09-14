const DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT = 0.5;

export function parseExperienceGuardThresholdPercentInput(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text)) return null;
  const percent = Number(text);
  return Number.isFinite(percent) && percent >= 0 ? percent : null;
}

export function formatExperienceGuardThresholdPercent(value) {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT.toFixed(2);
  }
  const percent = Number(value);
  return Number.isFinite(percent) && percent >= 0
    ? percent.toFixed(2)
    : DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT.toFixed(2);
}

export function buildExperienceGuardView({
  accountLevel,
  thresholdPercent,
  experienceGuard,
} = {}) {
  let normalizedThresholdPercent;
  if (thresholdPercent === null || thresholdPercent === undefined || thresholdPercent === "") {
    normalizedThresholdPercent = DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT;
  } else {
    const parsedThresholdPercent = Number(thresholdPercent);
    normalizedThresholdPercent = Number.isFinite(parsedThresholdPercent)
      && parsedThresholdPercent >= 0
      ? parsedThresholdPercent
      : DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT;
  }
  const noThreshold = normalizedThresholdPercent === 0;
  const currentExp = Number(accountLevel?.currentExp);
  const requiredExp = Number(accountLevel?.requiredExp);
  const known = accountLevel?.currentExp !== null
    && accountLevel?.currentExp !== undefined
    && accountLevel?.currentExp !== ""
    && accountLevel?.requiredExp !== null
    && accountLevel?.requiredExp !== undefined
    && accountLevel?.requiredExp !== ""
    && Number.isFinite(currentExp)
    && Number.isFinite(requiredExp)
    && requiredExp > 0;

  if (!known) {
    return {
      thresholdPercent: normalizedThresholdPercent,
      thresholdPercentText: formatExperienceGuardThresholdPercent(normalizedThresholdPercent),
      known: false,
      blocked: false,
      statusText: "待刷新",
      thresholdRemainingExp: null,
      remainingToProtectionExp: null,
    };
  }

  const thresholdRemainingExp = noThreshold
    ? null
    : Math.ceil(
      requiredExp * normalizedThresholdPercent / 100,
    );
  const remainingExp = requiredExp - currentExp;
  const matchingGuardThreshold = Number(experienceGuard?.thresholdPercent)
    === normalizedThresholdPercent;
  const settlementUncertain = experienceGuard?.settlementUncertain === true;
  const persistentExperienceBlocked = experienceGuard?.experienceProtectionBlocked === true
    || (
      experienceGuard?.experienceProtectionBlocked === undefined
      && experienceGuard?.blocked === true
      && !settlementUncertain
    );
  const blocked = !noThreshold
    && (remainingExp <= thresholdRemainingExp
      || (matchingGuardThreshold && persistentExperienceBlocked));

  return {
    thresholdPercent: normalizedThresholdPercent,
    thresholdPercentText: formatExperienceGuardThresholdPercent(normalizedThresholdPercent),
    known: true,
    blocked,
    settlementUncertain,
    statusText: settlementUncertain
      ? "收益请求待权威核对，未判定为经验保护线命中"
      : noThreshold
      ? "不设门槛"
      : blocked ? "有经验动作暂停，无经验动作继续" : "正常",
    thresholdRemainingExp,
    remainingToProtectionExp: noThreshold
      ? null
      : Math.max(0, remainingExp - thresholdRemainingExp),
  };
}
