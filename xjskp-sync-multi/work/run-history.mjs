import { formatDateTime } from "./status-format.mjs";

function nowDate(options = {}) {
  const value = options.now ? options.now() : new Date();
  return value instanceof Date ? value : new Date(value);
}

export function createRunHistory(options = {}) {
  const startedAt = nowDate(options);
  return {
    startedAt: startedAt.toISOString(),
    startedAtText: formatDateTime(startedAt),
    customerOrderCheckSeq: 0,
    customerOrderChecks: [],
    customerOrderSubmissions: [],
  };
}

function pushCapped(list, entry, max = 200) {
  list.push(entry);
  while (list.length > max) list.shift();
  return entry;
}

export function describeCustomerOrderAction(action = {}, order = {}) {
  const steps = action.steps || [];
  if (action.outcome && action.outcomeText) {
    return {
      outcome: action.outcome,
      outcomeText: action.outcomeText,
    };
  }
  if (String(action.reason || "").includes("temporary-out-of-stock")) {
    return {
      outcome: "temporary-out-of-stock",
      outcomeText: "暂时没货：按官方按钮拒绝顾客订单",
    };
  }
  if (
    action.finalizesOrder === false
    || (
      steps.some((step) => step.type === "makeFlowerArt")
      && !steps.some((step) => step.type === "finishCustomerOrder")
    )
  ) {
    return {
      outcome: "made-flower-art",
      outcomeText: "制作花艺，等待刷新后提交",
    };
  }
  if (["customer-art-stock-ready", "customer-flowers-ready-make-art"].includes(action.reason)) {
    return {
      outcome: "completed",
      outcomeText: "完成订单",
    };
  }
  if (steps.some((step) => step.type === "rejectCustomerOrder")) {
    return {
      outcome: "temporary-out-of-stock",
      outcomeText: "暂时没货：按官方按钮拒绝顾客订单",
    };
  }
  if (steps.some((step) => step.type === "finishCustomerOrder") || order.canFinish) {
    return {
      outcome: "completed",
      outcomeText: "完成订单",
    };
  }
  return {
    outcome: "unknown",
    outcomeText: "处理结果未知",
  };
}

function customerActionOutcomeSummary(actions = []) {
  if (!actions.length) return "-";
  const counts = new Map();
  for (const action of actions) {
    const { outcomeText } = describeCustomerOrderAction(action);
    counts.set(outcomeText, (counts.get(outcomeText) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([text, count]) => `${text} ${count}`)
    .join("，");
}

function customerCheckResultText(customerStatus = {}, actions = []) {
  if (!customerStatus.total) return "暂无顾客订单";
  if (actions.length) return `待执行 ${actions.length} 个动作（${customerActionOutcomeSummary(actions)}）`;
  if (customerStatus.temporaryOutOfStockCount) return "有顾客订单但暂时没货";
  return "有顾客订单但暂无可执行动作";
}

export function recordCustomerOrderCheck(history, { cycle = null, customerStep = null, customerStatus = {}, actions = [] } = {}, options = {}) {
  if (!history) return null;
  if (!history.customerOrderChecks) history.customerOrderChecks = [];
  history.customerOrderCheckSeq = (history.customerOrderCheckSeq || 0) + 1;
  const checkedAt = nowDate(options);
  const entry = {
    index: history.customerOrderCheckSeq,
    checkedAt: checkedAt.toISOString(),
    checkedAtText: formatDateTime(checkedAt),
    timeText: formatDateTime(checkedAt),
    cycle,
    customerStep,
    total: customerStatus.total ?? 0,
    readyCount: customerStatus.readyCount ?? 0,
    makeArtReadyCount: customerStatus.makeArtReadyCount ?? 0,
    temporaryOutOfStockCount: customerStatus.temporaryOutOfStockCount ?? 0,
    skippedCount: customerStatus.skippedCount ?? 0,
    actionCount: actions.length,
    actionOutcomeText: customerActionOutcomeSummary(actions),
    resultText: customerCheckResultText(customerStatus, actions),
    doubleGoldReady: Boolean(customerStatus.doubleGoldGate?.ready),
    doubleGoldReason: customerStatus.doubleGoldGate?.reasonText ?? "-",
    doubleGoldRemainingText: customerStatus.doubleGoldGate?.remainingText ?? "-",
    dailyLimit: customerStatus.dailyLimit || null,
    flowerCurrencySelection: customerStatus.flowerCurrencySelection || null,
    flowerCurrencyHistoricalMaxReward: customerStatus.flowerCurrencySelection?.historicalMaxReward ?? null,
    flowerCurrencyThreshold: customerStatus.flowerCurrencySelection?.threshold ?? null,
    flowerCurrencyHistoryStatus: customerStatus.flowerCurrencySelection?.historyRecordStatus ?? null,
    flowerCurrencyHistorySourceStatus: customerStatus.flowerCurrencySelection?.historySourceStatus ?? null,
    flowerCurrencyHistoryAccountId: customerStatus.flowerCurrencySelection?.historyAccountId ?? null,
    orders: (customerStatus.orders || []).map((order) => ({
      npcId: order.npcId ?? null,
      artId: order.artId ?? null,
      artLabel: order.artLabel ?? (order.artId ? `花艺-${order.artId}` : "-"),
      statusText: order.statusText ?? "-",
      actionText: order.actionText ?? "-",
      flowerCurrencyItemId: order.flowerCurrencyItemId ?? null,
      flowerCurrencyBaseReward: order.flowerCurrencyBaseReward ?? null,
      flowerCurrencyQuantity: order.flowerCurrencyQuantity ?? null,
      flowerCurrencyReward: order.flowerCurrencyReward ?? null,
      flowerCurrencyRewardKnown: order.flowerCurrencyRewardKnown === true,
      flowerCurrencyRewardReason: order.flowerCurrencyRewardReason ?? null,
      flowerCurrencyDecision: order.flowerCurrencyDecision ?? null,
      flowerCurrencyDecisionText: order.flowerCurrencyDecisionText ?? null,
      flowerStockShortageConfirmed: order.flowerStockShortageConfirmed === true,
      inactiveArtConfirmed: order.inactiveArtConfirmed === true,
      customerOrderPriorityReject: order.customerOrderPriorityReject === true,
      customerOrderPriorityRejectReason: order.customerOrderPriorityRejectReason ?? null,
      customerOrderPriorityRejectReasonText: order.customerOrderPriorityRejectReasonText ?? null,
      customerOrderRejectReasonText: order.flowerCurrencyDecision === "temporary-out-of-stock"
        ? order.actionText ?? null
        : null,
      flowerCurrencyHistoricalMaxReward: customerStatus.flowerCurrencySelection?.historicalMaxReward ?? null,
      flowerCurrencyThreshold: customerStatus.flowerCurrencySelection?.threshold ?? null,
      flowerRequirements: order.flowerRequirements || [],
    })),
  };
  return pushCapped(history.customerOrderChecks, entry);
}

export function recordCustomerOrderSubmission(history, { cycle = null, action = {}, order = {} } = {}, options = {}) {
  if (!history) return null;
  const submittedAt = nowDate(options);
  const index = history.customerOrderSubmissions.length + 1;
  const outcome = describeCustomerOrderAction(action, order);
  const entry = {
    index,
    submittedAt: submittedAt.toISOString(),
    submittedAtText: formatDateTime(submittedAt),
    timeText: formatDateTime(submittedAt),
    cycle,
    kind: "customer",
    orderName: "顾客订单",
    npcId: action.npcId ?? order.npcId ?? null,
    artId: action.artId ?? order.artId ?? null,
    artLabel: order.artLabel ?? (action.artId ? `花艺-${action.artId}` : "-"),
    statusText: order.statusText ?? "-",
    outcome: outcome.outcome,
    outcomeText: outcome.outcomeText,
    reason: action.reason ?? "-",
    needArt: order.needArt ?? null,
    haveArt: order.haveArt ?? null,
    missingArt: order.missingArt ?? null,
    flowerCurrencyItemId: order.flowerCurrencyItemId ?? null,
    flowerCurrencyBaseReward: order.flowerCurrencyBaseReward ?? null,
    flowerCurrencyQuantity: order.flowerCurrencyQuantity ?? null,
    flowerCurrencyReward: order.flowerCurrencyReward ?? null,
    flowerCurrencyRewardKnown: order.flowerCurrencyRewardKnown === true,
    flowerCurrencyDecision: order.flowerCurrencyDecision ?? null,
    flowerCurrencyDecisionText: order.flowerCurrencyDecisionText ?? null,
    flowerCurrencyHistoricalMaxReward: order.flowerCurrencyHistoricalMaxReward ?? null,
    actionText: order.actionText ?? null,
    flowerStockShortageConfirmed: order.flowerStockShortageConfirmed === true,
    inactiveArtConfirmed: order.inactiveArtConfirmed === true,
    customerOrderPriorityReject: action.customerOrderPriorityReject === true
      || order.customerOrderPriorityReject === true,
    customerOrderPriorityRejectReason: action.customerOrderPriorityRejectReason
      ?? order.customerOrderPriorityRejectReason
      ?? null,
    customerOrderActionType: action.customerOrderActionType ?? null,
    customerOrderRejectReasonText: action.customerOrderRejectReasonText ?? null,
    customerOrderFlowerCurrencyHistoryUpdate: action.customerOrderFlowerCurrencyHistoryUpdate ?? null,
    customerOrderHistoricalMaxRewardAfter: action.customerOrderHistoricalMaxRewardAfter ?? null,
    latencyMetricBasis: action.latencyMetricBasis ?? "request-start",
    generationToFirstActionMs: action.generationToFirstActionMs ?? null,
    makeToFinishDelayMs: action.makeToFinishDelayMs ?? null,
    generationToFirstActionRequestStartMs: action.generationToFirstActionRequestStartMs
      ?? action.generationToFirstActionMs
      ?? null,
    makeToFinishRequestStartDelayMs: action.makeToFinishRequestStartDelayMs
      ?? action.makeToFinishDelayMs
      ?? null,
    requestStartedAtMs: action.requestStartedAtMs ?? null,
    responseAtMs: action.responseAtMs ?? null,
    requestSequence: action.requestSequence ?? null,
    failureCategory: action.failureCategory ?? null,
    experienceEstimateSource: action.experienceEstimateSource ?? null,
    flowerRequirements: order.flowerRequirements || [],
    steps: action.steps || [],
  };
  history.customerOrderSubmissions.push(entry);
  return entry;
}
