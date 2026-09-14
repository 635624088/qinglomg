import { formatDateTime } from "./status-format.mjs";
import { formatPlainSeconds } from "./status-format-html.mjs";

export function decorateWaterDropStatus(status) {
  const nextRestoreText = status.nextRestoreInSeconds == null
    ? status.count >= status.displayLimit ? "已达自然恢复上限" : "无恢复倒计时"
    : formatPlainSeconds(status.nextRestoreInSeconds);
  return {
    ...status,
    restoreIntervalText: formatPlainSeconds(status.restoreIntervalSeconds),
    restoreStartText: formatDateTime(status.restoreStartMs),
    nextRestoreAtText: formatDateTime(status.nextRestoreAtMs),
    nextRestoreText,
    formulaText: `基数 ${status.baseCount} + 自然恢复 ${status.restoredCount} / 上限 ${status.displayLimit}`,
    displayText: `${status.count}/${status.displayLimit}`,
  };
}

export function compactWaterDropSnapshot(status) {
  if (!status) return null;
  return {
    baseCount: status.baseCount,
    count: status.count,
    restoredCount: status.restoredCount,
    displayText: status.displayText,
    restoreStartText: status.restoreStartText,
    nextRestoreText: status.nextRestoreText,
  };
}

export function buildWaterDropFlow(beforeWater, afterCycle, wateredCount = 0) {
  const before = beforeWater || afterCycle || null;
  const after = afterCycle || beforeWater || null;
  const restoredBeforeWater = before?.restoredCount ?? 0;
  const consumedByWatering = Number(wateredCount) || 0;
  const beforeText = before?.displayText ?? "-";
  const afterText = after?.displayText ?? "-";
  const flowText = `浇水前 ${beforeText}，自然恢复 ${restoredBeforeWater}；本轮自动浇水消耗 ${consumedByWatering}；结束 ${afterText}`;
  return {
    beforeWater: compactWaterDropSnapshot(before),
    afterCycle: compactWaterDropSnapshot(after),
    beforeWaterText: beforeText,
    afterCycleText: afterText,
    restoredBeforeWater,
    wateredCount: consumedByWatering,
    netChange: after && before ? after.count - before.count : null,
    flowText,
  };
}

export function buildLoopRefreshWaterDropFlow(waterDrop) {
  const snapshot = compactWaterDropSnapshot(waterDrop);
  return {
    mode: "loop-refresh-snapshot",
    beforeWater: snapshot,
    afterCycle: snapshot,
    beforeWaterText: waterDrop?.displayText ?? "-",
    afterCycleText: waterDrop?.displayText ?? "-",
    restoredBeforeWater: waterDrop?.restoredCount ?? 0,
    wateredCount: 0,
    netChange: 0,
    flowText: `休眠刷新快照：当前水滴 ${waterDrop?.displayText ?? "-"}；本次刷新未执行种植、浇水或领水`,
  };
}

