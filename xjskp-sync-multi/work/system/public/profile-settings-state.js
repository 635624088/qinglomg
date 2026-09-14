export function beginProfileSettingsUpdate(profile, nextSettings = {}) {
  const previousSettings = { ...(profile?.settings || {}) };
  const requestSettings = {
    ...previousSettings,
    ...nextSettings,
  };
  if (profile) profile.settings = requestSettings;
  return {
    profileId: profile?.id ?? null,
    previousSettings,
    requestSettings,
  };
}

export function rollbackProfileSettingsUpdate(profile, transaction) {
  if (!profile || profile.id !== transaction?.profileId) return false;
  profile.settings = { ...(transaction.previousSettings || {}) };
  return true;
}

export function getTeamOrderProtectionView(settings = {}, residentBoard = {}) {
  const protectionEnabled = settings?.teamOrderTriggerProtectionEnabled !== false;
  const releaseEnabled = !protectionEnabled;
  const doubleGoldForcedProtection =
    releaseEnabled
    && residentBoard?.teamOrderDoubleGoldReady === false;
  const doubleGoldRemainingText =
    residentBoard?.teamOrderDoubleGoldRemainingText || "-";
  return {
    releaseEnabled,
    description: !releaseEnabled
      ? "未放行：在第 49/99 单停止，避免自动触发组团。"
      : doubleGoldForcedProtection
        ? `已放行（当前仍强制保护）：双倍金币剩余 ${doubleGoldRemainingText}，必须超过3分钟才允许跨过 49/99。`
        : "已放行：仅在双倍金币剩余超过3分钟时，才允许跨过 49/99 触发免费组团；是否付费续开由元宝续次数放行独立控制。",
  };
}
