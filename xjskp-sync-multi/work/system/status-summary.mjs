import path from "node:path";

import { formatAccountLevelProgress, formatWanNumber } from "../status-format.mjs";

export function buildProfileStatusSummary({
  profileId,
  statusDir,
  logDir,
  gardenStatus,
  orderStatus,
  logs = [],
}) {
  const garden = gardenStatus?.ok ? gardenStatus.data : null;
  const order = orderStatus?.ok ? orderStatus.data : null;
  const summary = garden?.summary || {};
  const automationStopped = summary.automationStopped || null;
  const experienceGuard = summary.experienceGuard || garden?.experienceGuard || null;
  const moduleHealth = garden?.moduleHealth || summary.moduleHealth || {
    status: "healthy",
    unhealthyCount: 0,
    modules: {},
  };
  const queueRows = garden?.automationQueue?.rows || [];
  const ok = Boolean(garden);
  const loginState = automationStopped?.reason === "session-expired"
    ? "expired"
    : ok
      ? "normal"
      : "unknown";
  return {
    profileId,
    ok,
    reason: ok ? "ok" : `garden-status-${gardenStatus?.errorType || "missing"}`,
    updatedAt: garden?.updatedAt || null,
    cycle: garden?.cycle ?? null,
    step: garden?.step || null,
    land: {
      total: summary.totalLand ?? null,
      empty: summary.emptyCount ?? null,
      growing: summary.growingCount ?? null,
      mature: summary.matureCount ?? null,
      nextMatureText: garden?.automationQueue?.nextMatureText || "-",
    },
    resources: {
      waterDropText: summary.waterDropText || "-",
      waterDropNextRestoreText: summary.waterDropNextRestoreText || "-",
      goldText: formatGoldText(summary),
      pearlText: summary.pearlText || "-",
      flowerShopCoinText: summary.flowerShopCoinText || "-",
      satinSilkText: summary.satinSilkText || "-",
      buildingMaterialText: summary.buildingMaterialText || "-",
      yuanbaoText: summary.yuanbaoText || "-",
      hireItemCountText: garden?.pearl?.hireItemCount ?? "-",
      doubleGoldRemainingText: summary.doubleGoldRemainingText || "-",
    },
    accountLevel: formatAccountLevelSummary(summary.accountLevel || garden?.accountLevel || null),
    experienceGuard,
    risk: {
      cycleErrorCount: summary.cycleErrorCount ?? 0,
      moduleHealth,
      hasAutomationRisk: (summary.cycleErrorCount ?? 0) > 0 || (moduleHealth.unhealthyCount ?? 0) > 0,
      loopError: summary.loopError || null,
      automationStopped,
      experienceGuardBlocked: experienceGuard?.blocked === true,
      experienceGuardText: experienceGuard?.reasonText || null,
      loginState,
      loginStateText: loginState === "expired" ? "已失效" : loginState === "normal" ? "正常" : "待验证",
      statusAgeText: garden?.updatedAt ? "已刷新" : "暂无状态",
    },
    queue: queueRows.map((row) => ({
      area: row.area,
      pending: Number(row.pending || 0),
      status: row.status || "-",
      rule: row.rule || "",
      gateReason: row.gateReason || null,
      state: row.state || (Number(row.pending || 0) > 0 ? "pending" : "idle"),
    })),
    orders: {
      residentBoardCompletedCount: order?.residentBoard?.completedCount ?? null,
      ordinaryReadyCount: order?.ordinary?.readyCount ?? null,
      ordinaryTotalCount: order?.ordinary?.total ?? garden?.ordinaryResidentOrders?.total ?? null,
      ordinaryCompletedCount: garden?.ordinaryResidentOrders?.completedCount
        ?? order?.ordinary?.completedCount
        ?? summary.ordinaryResidentOrderCompletedCount
        ?? null,
      customerPendingCount: Array.isArray(order?.pendingCustomerOrderActions)
        ? order.pendingCustomerOrderActions.length
        : (garden?.customerOrders?.pendingCustomerOrderActions || []).length,
      ordinarySubmittedCount: garden?.ordinaryResidentOrders?.submittedCount ?? summary.ordinaryResidentOrderSubmittedCount ?? 0,
      mainTaskProgressText: garden?.mainTasks?.current?.progressText || garden?.automationQueue?.rows?.find((row) => row.area === "主线任务")?.status || "-",
    },
    inventory: {
      total: garden?.inventorySorted?.length ?? 0,
      cultivated: garden?.cultivatedInventorySorted?.length ?? 0,
      uncultivated: garden?.uncultivatedInventorySorted?.length ?? 0,
      flowerArt: garden?.flowerArtInventory?.total ?? garden?.flowerArtInventory?.rows?.length ?? summary.flowerArtInventoryCount ?? 0,
    },
    landRows: (garden?.landRows || []).slice(0, 60).map((row) => ({
      landId: row.landId,
      flowerName: row.flowerName || "-",
      flowerId: row.flowerId || "",
      statusText: row.statusText || "-",
      remainingText: row.remainingText || "-",
      nextTimeText: row.nextTimeText || "-",
    })),
    artifacts: {
      statusDir,
      logDir,
      gardenHtmlPath: path.join(statusDir, "garden-status.html"),
      gardenJsonPath: gardenStatus?.path || path.join(statusDir, "garden-status.json"),
      orderJsonPath: orderStatus?.path || path.join(statusDir, "order-status.json"),
    },
    logs,
  };
}

function formatGoldText(summary = {}) {
  if (summary.goldCount !== null && summary.goldCount !== undefined) return formatWanNumber(summary.goldCount);
  return formatWanNumber(summary.goldText || "-");
}

function formatAccountLevelSummary(accountLevel) {
  if (!accountLevel) return null;
  const serverIdx = accountLevel.serverIdx ?? accountLevel.lastGsIdx ?? null;
  return {
    ...accountLevel,
    serverIdx,
    serverText: accountLevel.serverText || (serverIdx == null ? null : `区服 ${serverIdx}`),
    progressText: formatAccountLevelProgress(accountLevel),
  };
}
