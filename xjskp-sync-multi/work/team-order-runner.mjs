import {
  calculateTeamOrderReward,
  selectEarliestStoredOrder,
  shouldRefreshProtectedTeamOrderFlower,
  summarizeTeamOrder,
  TEAM_ORDER_IFACES,
} from "./team-order-state.mjs";
import { getBag, getGardenResourceStatus } from "./garden-state.mjs";

export const TEAM_ORDER_LIMITS = Object.freeze({
  safetyMarginMs: 0,
  maxRequests: 400,
  maxUnknownState: 8,
});

export const TEAM_ORDER_UI_TIMINGS = Object.freeze({
  dialogReadyMs: 200,
  nextActionMs: 300,
  maxCompleteMs: 600,
  rewardReadyMs: 1_300,
});

const ARCHIVE_CALL_TIMEOUT_MS = 2_000;
const MAX_ARCHIVE_START_ATTEMPTS = 2;
const DEFAULT_REWARD_ITEM_NAMES = Object.freeze({
  2: "经验",
  11: "金币",
});
const SENSITIVE_TEXT_PATTERN =
  /\b(?:token|cookie|authorization|password|session(?:id)?|credential|login)\b(?=\s|[:=]|$)/i;

function safeText(value) {
  if (value == null) return value;
  const text = String(value);
  return SENSITIVE_TEXT_PATTERN.test(text) ? "[REDACTED]" : text;
}

function safeErrorSummary(error) {
  if (error == null) return null;
  if (typeof error !== "object") {
    return { message: safeText(error) };
  }
  const summary = {};
  for (const key of [
    "name",
    "message",
    "code",
    "status",
    "statusCode",
    "reason",
    "param",
    "schema",
  ]) {
    if (!Object.hasOwn(error, key) && !(key in error)) continue;
    const value = error[key];
    if (value == null) continue;
    summary[key] =
      typeof value === "string" ? safeText(value) : value;
  }
  return Object.keys(summary).length > 0
    ? summary
    : { message: safeText(String(error)) };
}

function safeServerErrorSummary(response) {
  const summary = safeErrorSummary(response?.errMsg) || {};
  const schema = safeText(response?.dsName);
  return schema == null || schema === ""
    ? summary
    : { ...summary, schema };
}

function rewardAmount(source, itemId, fallback = null) {
  const value = source?.[itemId] ?? source?.[String(itemId)];
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function formatRewardAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? "—");
  const [integerPart, fractionPart] = String(numeric).split(".");
  const sign = integerPart.startsWith("-") ? "-" : "";
  const digits = sign ? integerPart.slice(1) : integerPart;
  const grouped = digits.replace(/\B(?=(\d{4})+(?!\d))/g, ",");
  return `${sign}${grouped}${fractionPart ? `.${fractionPart}` : ""}`;
}

function buildRewardDetails(rawReward, calculatedReward, itemNames = {}) {
  const raw = rawReward && typeof rawReward === "object" ? rawReward : {};
  const displayed = calculatedReward?.displayed || {};
  const itemIds = new Set([
    ...Object.keys(raw),
    ...Object.keys(displayed),
    ...Object.keys(DEFAULT_REWARD_ITEM_NAMES),
  ]);
  const items = [...itemIds]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => {
      const preferred = [2, 11];
      const leftIndex = preferred.indexOf(left);
      const rightIndex = preferred.indexOf(right);
      if (leftIndex >= 0 || rightIndex >= 0) {
        return (leftIndex >= 0 ? leftIndex : preferred.length)
          - (rightIndex >= 0 ? rightIndex : preferred.length);
      }
      return left - right;
    })
    .map((itemId) => ({
      itemId,
      itemName:
        itemNames?.[itemId]
        ?? itemNames?.[String(itemId)]
        ?? DEFAULT_REWARD_ITEM_NAMES[itemId]
        ?? `物品 #${itemId}`,
      rawAmount: rewardAmount(raw, itemId, 0),
      displayedAmount: rewardAmount(displayed, itemId, null),
    }));
  const displayText = items
    .map((item) => (
      `${item.itemName} ${formatRewardAmount(
        item.displayedAmount ?? item.rawAmount,
      )}`
    ))
    .join("；");
  return { items, displayText };
}

function getOrder(syncValue) {
  return syncValue?.orderTeamTot?.orderTeam || null;
}

function storedOrdersOf(syncValue) {
  return getOrder(syncValue)?.storedOrders || null;
}

function isValidArchiveTime(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime());
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 && Number.isFinite(Date.parse(text));
  }
  return false;
}

function firstValidArchiveTime(...values) {
  for (const value of values) {
    if (isValidArchiveTime(value)) return value;
  }
  return null;
}

function archiveIdentityOf(syncValue, storedOrder, {
  profileId,
  uid,
  trigger,
}) {
  const order = getOrder(syncValue);
  const startTime = firstValidArchiveTime(
    order?.startTime,
    order?.activeTime,
    order?.cTime,
    storedOrder?.startTime,
  );
  const activeTime = firstValidArchiveTime(
    order?.activeTime,
    storedOrder?.activeTime,
  );
  const createdTime = firstValidArchiveTime(
    order?.cTime,
    storedOrder?.cTime,
    storedOrder?.createTime,
    storedOrder?.createdTime,
  );
  if (startTime == null) return null;
  return {
    profileId,
    uid,
    startTime,
    activeTime,
    createdTime,
    trigger,
  };
}

function stableChallengeIdentityKey(syncValue, storedOrder, identity) {
  const value = archiveIdentityOf(syncValue, storedOrder, {
    ...identity,
    trigger: null,
  });
  if (!value) return null;
  const stablePart = (part) => {
    if (part instanceof Date) return `date:${part.toISOString()}`;
    return `${typeof part}:${String(part ?? "")}`;
  };
  return JSON.stringify([
    stablePart(value.profileId),
    stablePart(value.uid),
    stablePart(value.startTime),
  ]);
}

function isAlreadyReceivedMessage(value) {
  const text = String(value ?? "");
  return /already\s+(?:(?:been\s+)?received|claimed)|已(?:经)?领取|领取过|已领/i.test(text);
}

function stateSignature(summary) {
  return JSON.stringify([
    summary.status,
    summary.effectiveStatus,
    summary.startTime,
    summary.orderNum,
    summary.flowerId,
    summary.need,
  ]);
}

function actionResponseConfirmed(
  action,
  before,
  after,
  beforeOrder,
  afterOrder,
) {
  if (!["submit", "refresh"].includes(action)) {
    return stateSignature(after) !== stateSignature(before);
  }
  return Boolean(afterOrder && typeof afterOrder === "object");
}

function eventFields(before, after = null) {
  return {
    orderNumBefore: before?.orderNum ?? null,
    orderNumAfter: after?.orderNum ?? before?.orderNum ?? null,
    flowerId: before?.flowerId ?? after?.flowerId ?? null,
    flowerName: before?.flowerName ?? after?.flowerName ?? null,
    need: before?.need ?? after?.need ?? null,
    inventoryBefore: before?.have ?? null,
    inventoryAfter: after?.have ?? before?.have ?? null,
  };
}

function responseHasTeamState(result) {
  const order = result?.value?.orderTeamTot?.orderTeam;
  if (!order || typeof order !== "object") return false;
  return [
    "status",
    "startTime",
    "orderNum",
    "flowerId",
    "remainingNum",
    "rwd",
    "storedOrders",
    "highCntMap",
  ].some((field) => Object.hasOwn(order, field));
}

function responseHasInventoryEvidence(value, itemId) {
  if (itemId == null) return false;
  const usrTot = value?.$usrTot;
  if (!usrTot || typeof usrTot !== "object") return false;
  const hasItem = (itemMap) => Boolean(
    itemMap
    && typeof itemMap === "object"
    && (
      Object.hasOwn(itemMap, itemId)
      || Object.hasOwn(itemMap, String(itemId))
    )
  );
  const data = usrTot.data;
  const usr = usrTot.usr;
  const maps = [
    data?.bag,
    data?.itemMap,
    usr?.bag,
    usr?.itemMap,
    usrTot.bag,
    usrTot.itemMap,
    usrTot.itemAddChg?.itemMap,
    usrTot.oi?.bd,
    usrTot.oi?.bi,
    usrTot.oi?.bo,
  ];
  if (maps.some(hasItem)) return true;
  return (usrTot.itemAddChg?.itemAddRcdList || [])
    .some((record) => hasItem(record?.itemMap));
}

function completedCountFromServerOrderNum(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number - 1) : null;
}

function normalizePaidRenewCost(config) {
  const raw = config?.paidRenewCost;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const itemId = Number(raw[0]);
  const amount = Number(raw[1]);
  if (itemId !== 1 || !Number.isInteger(amount) || amount <= 0) return null;
  return { itemId, amount };
}

function paidRenewBalance(syncValue, itemId) {
  const balance = itemId === 1
    ? Number(getGardenResourceStatus(syncValue)?.yuanbao?.count ?? 0)
    : 0;
  return Number.isFinite(balance) ? Math.max(0, balance) : 0;
}

function finalStatusFor(reason) {
  if ([
    "server-ended",
    "order-max-reached",
    "accepted",
    "restored",
    "paid-renew-continued",
  ].includes(reason)) {
    return "completed";
  }
  if (reason === "experience-guard") return "protected";
  if (
    reason === "user-stop"
  ) {
    return "user-stopped";
  }
  if (
    reason === "aborted"
    || reason.endsWith("-stop")
    || reason.includes("stop")
  ) {
    return "stopped";
  }
  if (reason === "idle") return "idle";
  return "degraded";
}

function createRefreshLimiter({
  maximum,
  monotonicMs,
  sleep,
  beforeWait,
  state,
}) {
  const windowMs = 1_000;

  function resetWindowIfNeeded(current) {
    if (
      state.refreshWindowStartedMs == null
      || current - state.refreshWindowStartedMs >= windowMs
    ) {
      state.refreshWindowStartedMs = current;
      state.refreshSuccessCount = 0;
    }
  }

  return {
    async acquire() {
      while (true) {
        const stop = await beforeWait();
        if (stop) return stop;
        const current = monotonicMs();
        resetWindowIfNeeded(current);
        if (state.refreshSuccessCount < maximum) return null;
        const waitMs = Math.max(
          1,
          windowMs - (current - state.refreshWindowStartedMs),
        );
        await sleep(waitMs);
      }
    },
    recordSuccess() {
      const current = monotonicMs();
      resetWindowIfNeeded(current);
      state.refreshSuccessCount += 1;
    },
    resetAt(current = monotonicMs()) {
      state.refreshWindowStartedMs = current;
      state.refreshSuccessCount = 0;
    },
  };
}

function shouldFinishArchive(reason) {
  return [
    "server-ended",
    "paid-renew-continued",
    "order-max-reached",
    "request-limit",
    "unknown-state-limit",
    "unknown-status",
    "missing-order-config",
    "experience-guard",
    "paid-renew-server-rejected",
    "paid-renew-result-unknown",
    "runner-error",
  ].includes(reason)
    || reason === "aborted"
    || reason === "fatal-error"
    || reason === "user-stop"
    || reason.endsWith("-stop");
}

function normalizeStopReason(marker) {
  if (!marker) return null;
  if (typeof marker === "string") return marker;
  return marker.reason || marker.message || "user-stop";
}

export function createTeamOrderRunner(deps = {}) {
  const {
    profileId,
    uid,
    request,
    mergeSync,
    refreshTruth,
    createArchive,
    nowMs,
    monotonicMs,
    sleep,
    archiveMonotonicMs = () => globalThis.performance.now(),
    archiveSleep = (milliseconds) => new Promise(
      (resolve) => setTimeout(resolve, milliseconds),
    ),
    archiveCallTimeoutMs = ARCHIVE_CALL_TIMEOUT_MS,
    uiTimings = TEAM_ORDER_UI_TIMINGS,
    officialTeamOrderActionLockHandled = false,
    signal = null,
    shouldStop,
    onStatus,
  } = deps;

  let inFlight = null;
  let stopReason = null;
  let transportLane = null;
  let settlementLane = null;
  let pendingMutation = null;
  let challengeSafety = null;
  let resultInDoubt = null;
  let oneShotArchiveSession = null;
  let provisionalArchiveSession = null;
  let paidRenewArchiveHandoff = null;
  let officialActionLockHandled = officialTeamOrderActionLockHandled === true;

  function createChallengeSafety(identityKey = null) {
    return {
      identityKey,
      requestCount: 0,
      unknownStateCount: 0,
      serverDeadlineMonotonicMs: null,
      refreshWindowStartedMs: null,
      refreshSuccessCount: 0,
      storeAttempted: false,
      dialogReadyWaited: false,
      rewardReadyWaited: false,
      rewardReadyOrderNum: null,
      finishCantBuy: null,
      paidRenewAttempted: false,
      paidRenewConfirmed: false,
    };
  }

  async function externalStopReason() {
    if (stopReason) return stopReason;
    if (signal?.aborted) return "aborted";
    try {
      return normalizeStopReason(await shouldStop?.());
    } catch (error) {
      return `stop-check-failed:${safeText(error?.message || error)}`;
    }
  }

  function beginTransport(kind, invoke, lane = "primary") {
    const current = lane === "settlement" ? settlementLane : transportLane;
    if (current && !current.settled) {
      return lane === "settlement" ? current : null;
    }
    const controller = new AbortController();
    const operation = {
      kind,
      lane,
      controller,
      settled: false,
      quarantined: false,
      value: undefined,
      error: null,
    };
    if (lane === "settlement") settlementLane = operation;
    else transportLane = operation;

    const settle = (field, value) => {
      operation[field] = value;
      operation.settled = true;
      if (lane === "primary" && transportLane === operation) {
        transportLane = null;
      }
    };

    let source;
    try {
      source = invoke({ signal: controller.signal });
    } catch (error) {
      settle("error", error);
      return operation;
    }
    Promise.resolve(source).then(
      (value) => settle("value", value),
      (error) => settle("error", error),
    );
    return operation;
  }

  async function waitForTransport(
    operation,
    deadlineState,
    { yieldIfPending = false } = {},
  ) {
    if (!operation) {
      return { kind: "blocked", reason: "transport-in-doubt" };
    }

    // Let already-fulfilled Promises publish their result before advancing the
    // injected monotonic clock.
    await Promise.resolve();
    if (yieldIfPending && !operation.settled) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    while (!operation.settled) {
      const stop = await externalStopReason();
      if (operation.settled) break;
      if (yieldIfPending && !stop) {
        return { kind: "pending", reason: "settlement-pending" };
      }
      const deadline = deadlineState();
      const reason = stop || deadline.reason;
      if (reason) {
        operation.quarantined = true;
        if (reason !== "server-window-ended") {
          operation.controller.abort(reason);
        }
        return { kind: "pending", reason };
      }
      const waitMs = Math.max(1, Math.min(50, deadline.remainingMs));
      await sleep(waitMs);
    }

    if (operation.error != null) {
      return { kind: "error", error: operation.error };
    }
    return { kind: "response", value: operation.value };
  }

  function stateOptions(config, context) {
    return {
      config,
      nowMs: nowMs(),
      flowerNames: context.flowerNames || context.nameMap || {},
    };
  }

  function summarize(syncValue, config, context) {
    return summarizeTeamOrder(syncValue, stateOptions(config, context));
  }

  async function runLocked(syncValue, context = {}) {
    const config = context.config;
    const capability = context.capability || { ready: true };
    const paidRenewState =
      oneShotArchiveSession?.paidRenewState
      || paidRenewArchiveHandoff?.paidRenewState
      || null;
    const result = {
      syncValue,
      handled: false,
      actionCount: 0,
      submittedCount: 0,
      refreshedCount: 0,
      finalReason: "idle",
      capability,
      archiveErrors: [],
      paidRenewAvailable: paidRenewState?.available === true,
      paidRenewSkipped: paidRenewState?.skipped === true,
      paidRenewPurchasedCount: Math.max(
        0,
        Number(paidRenewState?.purchasedCount) || 0,
      ),
      paidRenewConfirmedCost: Math.max(
        0,
        Number(paidRenewState?.confirmedCost) || 0,
      ),
    };
    let currentSync = syncValue;
    const provisionalSafety = createChallengeSafety();
    let safety = resultInDoubt?.safety || provisionalSafety;
    let archive = null;
    let oneShotArchive = false;
    let archiveInitial = null;
    let archiveStarted = false;
    let archiveStartAttempts = 0;
    let archiveCreationAttempted = false;
    let archiveQuarantined = false;
    let archiveOperation = null;
    let archiveWorker = null;
    let archiveWorkVersion = 0;
    let archiveCloseRequested = false;
    let archiveCloseDeadlineMs = null;
    let archiveFinishValue = null;
    let archiveFinishAttempted = false;
    let archiveFlushAttempted = false;
    let settlementOrderSnapshot = null;
    let pendingArchiveEvents =
      oneShotArchiveSession?.events
      || provisionalArchiveSession?.events
      || paidRenewArchiveHandoff?.events
      || [];

    function adoptChallengeSafety(candidateSync, candidateStoredOrder = null) {
      const identityKey = stableChallengeIdentityKey(
        candidateSync,
        candidateStoredOrder,
        { profileId, uid },
      );
      if (oneShotArchiveSession && challengeSafety) {
        safety = challengeSafety;
        return safety;
      }
      if (!identityKey) {
        if (challengeSafety) {
          safety = challengeSafety;
        } else {
          challengeSafety = safety;
        }
        return safety;
      }
      if (challengeSafety?.identityKey === identityKey) {
        safety = challengeSafety;
        return safety;
      }

      const nextSafety = safety.identityKey == null
        ? {
            ...safety,
            identityKey,
          }
        : createChallengeSafety(identityKey);
      challengeSafety = nextSafety;
      safety = nextSafety;
      return safety;
    }

    function deadlineState() {
      return {
        reason: null,
        remainingMs: Number.POSITIVE_INFINITY,
      };
    }

    function activeMutationDeadlineState() {
      if (safety.serverDeadlineMonotonicMs == null) {
        return deadlineState();
      }
      const remainingMs =
        safety.serverDeadlineMonotonicMs - monotonicMs();
      return {
        reason: remainingMs <= 0 ? "server-window-ended" : null,
        remainingMs: Math.max(0, remainingMs),
      };
    }

    function observeServerDeadline(summary) {
      if (summary?.startTimeMs == null) return;
      const durationMs = Math.max(0, Number(config?.durationSeconds) * 1_000);
      if (!Number.isFinite(durationMs) || durationMs <= 0) return;
      const remainingEpochMs =
        summary.startTimeMs
        + durationMs
        - TEAM_ORDER_LIMITS.safetyMarginMs
        - nowMs();
      const candidate =
        monotonicMs() + remainingEpochMs;
      safety.serverDeadlineMonotonicMs =
        safety.serverDeadlineMonotonicMs == null
          ? candidate
          : Math.min(safety.serverDeadlineMonotonicMs, candidate);
    }

    function applyServerDeadline(summary) {
      observeServerDeadline(summary);
      if (
        summary?.effectiveStatus === 2
        && safety.serverDeadlineMonotonicMs != null
        && monotonicMs() >= safety.serverDeadlineMonotonicMs
      ) {
        summary.effectiveStatus = 3;
        summary.expiredByServerTime = true;
        summary.remainingMs = 0;
      }
      return summary;
    }

    const initialSummary = summarize(currentSync, config, context);
    if (
      !oneShotArchiveSession
      && !provisionalArchiveSession
      && paidRenewArchiveHandoff?.events === pendingArchiveEvents
    ) {
      provisionalArchiveSession = {
        initial: {
          trigger: "paid-renew",
          initialOrderNum: initialSummary.orderNum,
        },
        events: pendingArchiveEvents,
      };
    }
    let storedOrder = initialSummary.effectiveStatus === 0
      ? selectEarliestStoredOrder(storedOrdersOf(currentSync), nowMs())
      : null;
    const terminalSettlementConfirmed = Boolean(
      initialSummary.effectiveStatus === 0
      && !storedOrder
      && oneShotArchiveSession
      && settlementLane
      && !settlementLane.consumed,
    );
    if (resultInDoubt) {
      const incomingIdentityKey = stableChallengeIdentityKey(
        currentSync,
        storedOrder,
        { profileId, uid },
      );
      const pendingIdentityKey = resultInDoubt.safety?.identityKey || null;
      const incomingIsTerminal =
        initialSummary.effectiveStatus === 0 && !storedOrder;
      const incomingProvesNewIdentity = Boolean(
        pendingIdentityKey
          && incomingIdentityKey
          && pendingIdentityKey !== incomingIdentityKey,
      );
      if (incomingIsTerminal || incomingProvesNewIdentity) {
        resultInDoubt = null;
        challengeSafety = null;
        safety = provisionalSafety;
      }
    }
    if (!resultInDoubt) {
      adoptChallengeSafety(currentSync, storedOrder);
    }
    if (safety.finishCantBuy == null) {
      safety.finishCantBuy = initialSummary.effectiveStatus === 3;
    }
    observeServerDeadline(initialSummary);
    if (
      !resultInDoubt
      && initialSummary.effectiveStatus === 0
      && !storedOrder
      && !terminalSettlementConfirmed
    ) {
      challengeSafety = null;
      provisionalArchiveSession = null;
      return result;
    }

    function recordArchiveFailure(method, kind, error = null) {
      const message = kind === "timeout"
        ? `archive ${method} timed out after ${archiveCallTimeoutMs}ms`
        : safeText(error?.message || error || `archive ${method} failed`);
      result.archiveErrors.push({ method, kind, message });
    }

    async function archiveCall(method, value) {
      if (
        archiveQuarantined
        || !archive
        || typeof archive[method] !== "function"
      ) {
        return { kind: "skipped" };
      }
      if (archiveOperation && !archiveOperation.settled) {
        archiveQuarantined = true;
        return { kind: "pending" };
      }

      const operation = {
        settled: false,
        error: null,
      };
      archiveOperation = operation;
      const settle = (error = null) => {
        operation.error = error;
        operation.settled = true;
        if (archiveOperation === operation) archiveOperation = null;
      };

      try {
        const source = archive[method](value);
        Promise.resolve(source).then(
          () => settle(),
          (error) => settle(error),
        );
      } catch (error) {
        settle(error);
      }

      await Promise.resolve();
      const deadline =
        archiveMonotonicMs() + archiveCallTimeoutMs;
      while (!operation.settled) {
        const effectiveDeadline = archiveCloseDeadlineMs == null
          ? deadline
          : Math.min(deadline, archiveCloseDeadlineMs);
        const remainingMs = effectiveDeadline - archiveMonotonicMs();
        if (remainingMs <= 0) {
          archiveQuarantined = true;
          recordArchiveFailure(method, "timeout");
          return { kind: "pending" };
        }
        await archiveSleep(Math.max(1, Math.min(50, remainingMs)));
      }
      if (operation.error == null) return { kind: "success" };
      if (method === "append" || method === "commit") {
        archiveQuarantined = true;
        recordArchiveFailure(method, "error", operation.error);
      }
      return { kind: "error", error: operation.error };
    }

    async function drainArchiveQueue() {
      if (archiveQuarantined || !archive) return;

      if (!archiveStarted) {
        archiveStartAttempts += 1;
        const started = await archiveCall("start", {
          trigger: context.trigger || "unknown",
          initialOrderNum: initialSummary.orderNum,
        });
        if (started.kind !== "success") {
          if (
            started.kind === "error"
            && archiveStartAttempts >= MAX_ARCHIVE_START_ATTEMPTS
          ) {
            archiveQuarantined = true;
            recordArchiveFailure("start", "error", started.error);
          }
          return;
        }
        archiveStarted = true;
      }

      while (!archiveQuarantined && pendingArchiveEvents.length > 0) {
        const appended = await archiveCall(
          "append",
          pendingArchiveEvents[0],
        );
        if (appended.kind === "pending") return;
        pendingArchiveEvents.shift();
        if (appended.kind === "error") return;
      }

      if (!archiveCloseRequested || archiveQuarantined) return;
      if (archiveFinishValue != null && !archiveFinishAttempted) {
        archiveFinishAttempted = true;
        const finished = await archiveCall("finish", archiveFinishValue);
        if (finished.kind === "pending") return;
      }
      if (!archiveFlushAttempted && !archiveQuarantined) {
        archiveFlushAttempted = true;
        await archiveCall("flush");
      }
    }

    function startArchiveWorker() {
      if (archiveWorker || archiveQuarantined || !archive) return;
      const workVersion = archiveWorkVersion;
      let worker;
      worker = Promise.resolve()
        .then(() => drainArchiveQueue())
        .catch(() => {
          archiveQuarantined = true;
        })
        .finally(() => {
          if (archiveWorker === worker) archiveWorker = null;
          if (
            !archiveQuarantined
            && archiveWorkVersion > workVersion
          ) {
            startArchiveWorker();
          }
        });
      archiveWorker = worker;
    }

    function queueArchiveWork() {
      archiveWorkVersion += 1;
      startArchiveWorker();
    }

    function ensureArchive() {
      if (archiveQuarantined) return false;
      if (!archive) {
        if (archiveCreationAttempted) return false;
        if (oneShotArchiveSession) {
          archiveCreationAttempted = true;
          archive = oneShotArchiveSession.archive;
          oneShotArchive = true;
          archiveInitial = oneShotArchiveSession.initial;
          pendingArchiveEvents = oneShotArchiveSession.events;
          return true;
        }
        const identity = archiveIdentityOf(currentSync, storedOrder, {
          profileId,
          uid,
          trigger: context.trigger || "unknown",
        });
        if (!identity) return false;
        archiveCreationAttempted = true;
        const identityKey = stableChallengeIdentityKey(
          currentSync,
          storedOrder,
          { profileId, uid },
        );
        if (
          identityKey
          && oneShotArchiveSession?.identityKey === identityKey
        ) {
          archive = oneShotArchiveSession.archive;
          oneShotArchive = true;
          archiveInitial = oneShotArchiveSession.initial;
          pendingArchiveEvents = oneShotArchiveSession.events;
          return true;
        }
        try {
          archive = createArchive?.(identity) || null;
        } catch {
          archive = null;
        }
        if (!archive) return false;
        oneShotArchive = typeof archive.commit === "function";
        const provisionalInitial = provisionalArchiveSession?.initial || {};
        const firstArchivedOrderNum = pendingArchiveEvents
          .map((event) => event?.orderNumBefore ?? event?.orderNumAfter)
          .find((value) => value != null);
        archiveInitial = {
          trigger:
            provisionalInitial.trigger
            ?? context.trigger
            ?? "unknown",
          initialOrderNum:
            provisionalInitial.initialOrderNum
            ?? firstArchivedOrderNum
            ?? initialSummary.orderNum,
          startedAt: identity.startTime,
        };
        if (oneShotArchive && identityKey) {
          oneShotArchiveSession = {
            identityKey,
            archive,
            initial: archiveInitial,
            events: pendingArchiveEvents,
            paidRenewState: {
              available: result.paidRenewAvailable,
              skipped: result.paidRenewSkipped,
              purchasedCount: result.paidRenewPurchasedCount,
              confirmedCost: result.paidRenewConfirmedCost,
            },
          };
        }
        if (provisionalArchiveSession?.events === pendingArchiveEvents) {
          provisionalArchiveSession = null;
        }
        if (paidRenewArchiveHandoff?.events === pendingArchiveEvents) {
          paidRenewArchiveHandoff = null;
        }
      }
      if (!oneShotArchive) queueArchiveWork();
      return true;
    }

    async function waitForUi(milliseconds) {
      const waitMs = Math.max(0, Number(milliseconds) || 0);
      if (waitMs <= 0) return null;
      const stop = await externalStopReason();
      if (stop) return stop;
      await sleep(waitMs);
      return externalStopReason();
    }

    async function ensureDialogReady() {
      if (safety.dialogReadyWaited) return null;
      if (safety.refreshWindowStartedMs == null) {
        safety.refreshWindowStartedMs = monotonicMs();
        safety.refreshSuccessCount = 0;
      }
      const stop = await waitForUi(uiTimings.dialogReadyMs);
      if (!stop) {
        safety.dialogReadyWaited = true;
      }
      return stop;
    }

    async function waitForNextAction(after = null, action = null) {
      const isMaxCompletion = after?.effectiveStatus === 3
        && after?.orderNum === config.maxOrderNum;
      const waitMs = isMaxCompletion
        ? uiTimings.maxCompleteMs
        : officialActionLockHandled
          && ["submit", "refresh"].includes(action)
          ? 0
          : uiTimings.nextActionMs;
      return waitForUi(waitMs);
    }

    async function ensureRewardReady() {
      const rawOrderNum = getOrder(currentSync)?.orderNum;
      const numericOrderNum = Number(rawOrderNum);
      const rewardOrderNum = Number.isFinite(numericOrderNum)
        ? numericOrderNum
        : rawOrderNum ?? null;
      if (
        safety.rewardReadyWaited
        && safety.rewardReadyOrderNum === rewardOrderNum
      ) {
        return null;
      }
      const stop = await waitForUi(uiTimings.rewardReadyMs);
      if (!stop) {
        safety.rewardReadyWaited = true;
        safety.rewardReadyOrderNum = rewardOrderNum;
      }
      return stop;
    }

    function append(event) {
      if (
        !archive
        && !oneShotArchiveSession
        && !provisionalArchiveSession
      ) {
        provisionalArchiveSession = {
          initial: {
            trigger: context.trigger || "unknown",
            initialOrderNum: initialSummary.orderNum,
          },
          events: pendingArchiveEvents,
        };
      }
      const timestampMs = nowMs();
      const timestampedEvent = {
        ...event,
        timestampMs,
        timestamp: Number.isFinite(timestampMs)
          ? new Date(timestampMs).toISOString()
          : null,
      };
      const firstEventOrderNum =
        timestampedEvent.orderNumBefore
        ?? timestampedEvent.orderNumAfter
        ?? null;
      if (
        archiveInitial
        && archiveInitial.initialOrderNum == null
        && firstEventOrderNum != null
      ) {
        archiveInitial = {
          ...archiveInitial,
          initialOrderNum: firstEventOrderNum,
        };
        if (oneShotArchiveSession?.archive === archive) {
          oneShotArchiveSession.initial = archiveInitial;
        }
      }
      pendingArchiveEvents.push(timestampedEvent);
      ensureArchive();
      publishActiveStatus(null, timestampedEvent);
    }

    function appendPaidRenewSkip(reason, description, extra = {}) {
      if (result.paidRenewSkipped) return;
      result.paidRenewSkipped = true;
      append({
        action: "paid-renew-skipped",
        status: "skipped",
        reason,
        description,
        serverConfirmed: false,
        ...extra,
      });
    }

    let paidRenewProtectionReadError = null;

    async function readPaidRenewProtectionEnabled() {
      try {
        if (typeof context.getPaidRenewProtectionEnabled === "function") {
          return (await context.getPaidRenewProtectionEnabled()) !== false;
        }
        return capability.teamOrderPaidRenewProtectionEnabled !== false;
      } catch (error) {
        paidRenewProtectionReadError = safeErrorSummary(error);
        return true;
      }
    }

    async function readPaidRenewExperienceGuard() {
      try {
        if (typeof context.getPaidRenewExperienceGuard === "function") {
          return await context.getPaidRenewExperienceGuard(currentSync);
        }
        return context.experienceGuard || { blocked: false };
      } catch (error) {
        return {
          blocked: true,
          reason: "experience-guard-read-failed",
          error: safeErrorSummary(error),
        };
      }
    }

    function resetSafetyForPaidChallenge(after) {
      const identityKey = stableChallengeIdentityKey(
        currentSync,
        null,
        { profileId, uid },
      );
      const nextSafety = createChallengeSafety(identityKey);
      nextSafety.finishCantBuy = true;
      nextSafety.paidRenewAttempted = true;
      nextSafety.paidRenewConfirmed = true;
      challengeSafety = nextSafety;
      safety = nextSafety;
      observeServerDeadline(after);
    }

    function lockPaidRenewAfterUnknownResult() {
      const identityKey = stableChallengeIdentityKey(
        currentSync,
        null,
        { profileId, uid },
      );
      const lockedSafety = identityKey
        ? createChallengeSafety(identityKey)
        : safety;
      lockedSafety.finishCantBuy = true;
      lockedSafety.paidRenewAttempted = true;
      lockedSafety.paidRenewConfirmed = false;
      challengeSafety = lockedSafety;
      safety = lockedSafety;
      observeServerDeadline(summarize(currentSync, config, context));
    }

    function paidRenewConfirmation(
      after,
      cost,
      remainingNumBefore,
      balanceBefore,
    ) {
      if (![2, 3].includes(Number(after?.effectiveStatus))) return null;
      const remainingNumAfter = Number(getOrder(currentSync)?.remainingNum);
      const balanceAfter = paidRenewBalance(currentSync, cost.itemId);
      const confirmationEvidence = [];
      if (
        Number.isFinite(remainingNumBefore)
        && Number.isFinite(remainingNumAfter)
        && remainingNumAfter >= 0
        && remainingNumAfter < remainingNumBefore
      ) {
        confirmationEvidence.push("remaining-num-decreased");
      }
      if (balanceBefore - balanceAfter === cost.amount) {
        confirmationEvidence.push("yuanbao-cost-debited");
      }
      if (confirmationEvidence.length === 0) return null;
      return {
        balanceAfter,
        remainingNumAfter: Number.isFinite(remainingNumAfter)
          ? remainingNumAfter
          : null,
        confirmationEvidence,
      };
    }

    function recordPaidRenewSuccess(
      before,
      after,
      cost,
      remainingNumBefore,
      balanceBefore,
      confirmation,
    ) {
      const timestampMs = nowMs();
      const paidRenewEvent = {
        action: "paid-renew",
        status: "success",
        reason: "server-confirmed",
        description: `服务端已确认消耗 ${cost.amount} 元宝续开组团次数`,
        costItemId: cost.itemId,
        costAmount: cost.amount,
        balanceBefore,
        balanceAfter: confirmation.balanceAfter,
        remainingNumBefore,
        remainingNumAfter: confirmation.remainingNumAfter,
        confirmationEvidence: confirmation.confirmationEvidence,
        serverConfirmed: true,
        ...eventFields(before, after),
        timestampMs,
        timestamp: Number.isFinite(timestampMs)
          ? new Date(timestampMs).toISOString()
          : null,
      };
      paidRenewArchiveHandoff = {
        events: [paidRenewEvent],
        paidRenewState: {
          available: true,
          skipped: false,
          purchasedCount: 1,
          confirmedCost: cost.amount,
        },
      };
      resetSafetyForPaidChallenge(after);
      return { kind: "rollover" };
    }

    async function confirmPaidRenewTruth(
      before,
      cost,
      remainingNumBefore,
      balanceBefore,
      error,
    ) {
      const refreshed = await refreshTruthOnce("paid-renew", before);
      if (refreshed.kind === "refreshed") {
        const after = applyServerDeadline(
          summarize(currentSync, config, context),
        );
        const confirmation = paidRenewConfirmation(
          after,
          cost,
          remainingNumBefore,
          balanceBefore,
        );
        if (confirmation) {
          return recordPaidRenewSuccess(
            before,
            after,
            cost,
            remainingNumBefore,
            balanceBefore,
            confirmation,
          );
        }
      }
      const remainingNumAfter = Number(getOrder(currentSync)?.remainingNum);
      lockPaidRenewAfterUnknownResult();
      append({
        action: "paid-renew",
        status: "timeout",
        reason: "paid-renew-result-unknown",
        description: "付费续开结果无法由服务端权威状态确认，已停止且不会盲目重试",
        error: safeErrorSummary(error),
        costItemId: cost.itemId,
        costAmount: cost.amount,
        balanceBefore,
        balanceAfter: paidRenewBalance(currentSync, cost.itemId),
        remainingNumBefore,
        remainingNumAfter: Number.isFinite(remainingNumAfter)
          ? remainingNumAfter
          : null,
        confirmationEvidence: [],
        serverConfirmed: false,
        ...eventFields(before),
      });
      return {
        kind: "finish",
        reason: refreshed.kind === "stop"
          ? refreshed.reason
          : "paid-renew-result-unknown",
      };
    }

    async function declinePaidRenew(reason, description, extra = {}) {
      safety.paidRenewAttempted = true;
      const requested = await requestOnce(
        "paid-renew-decline",
        TEAM_ORDER_IFACES.takeOrder,
        { isAgree: false, isCost: true },
      );
      if (requested.kind === "stop" || requested.kind === "limit") {
        return { kind: "finish", reason: requested.reason, stopped: true };
      }

      const responseError = requested.kind === "response"
        && requested.response?.errMsg
          ? safeServerErrorSummary(requested.response)
          : null;
      const requestError = requested.kind === "error"
        ? safeErrorSummary(requested.error)
        : responseError;
      const serverConfirmed = requestError == null;
      appendPaidRenewSkip(
        reason,
        serverConfirmed
          ? `${description}，已按官方协议拒绝本次付费续开`
          : `${description}；拒绝通知未确认，已停止且不会重试`,
        {
          ...extra,
          serverConfirmed,
          ...(requestError ? { error: requestError } : {}),
        },
      );
      return undefined;
    }

    async function handlePaidRenewAfterSettlement() {
      if (safety.finishCantBuy) return;
      const remainingNum = Number(getOrder(currentSync)?.remainingNum);
      if (!Number.isFinite(remainingNum) || remainingNum <= 0) return;
      result.paidRenewAvailable = true;
      if (safety.paidRenewAttempted) return;

      if (await readPaidRenewProtectionEnabled()) {
        return declinePaidRenew(
          paidRenewProtectionReadError
            ? "paid-renew-protection-read-failed"
            : "paid-renew-protection-enabled",
          paidRenewProtectionReadError
            ? "元宝续次数保护读取失败，已按保护开启处理"
            : `检测到 ${remainingNum} 次付费续开机会，元宝续次数保护已开启`,
          {
            remainingNumBefore: remainingNum,
            ...(paidRenewProtectionReadError
              ? { error: paidRenewProtectionReadError }
              : {}),
          },
        );
      }
      const experienceGuard = await readPaidRenewExperienceGuard();
      if (experienceGuard?.blocked === true) {
        return declinePaidRenew(
          "experience-guard",
          "经验保护已阻止本次元宝续开",
          {
            remainingNumBefore: remainingNum,
            error: experienceGuard.error,
          },
        );
      }
      const cost = normalizePaidRenewCost(config);
      if (!cost) {
        return declinePaidRenew(
          "invalid-paid-renew-config",
          "付费续开配置不是合法的元宝正整数成本，已停止购买",
          { remainingNumBefore: remainingNum },
        );
      }
      const balance = paidRenewBalance(currentSync, cost.itemId);
      if (balance < cost.amount) {
        return declinePaidRenew(
          "insufficient-yuanbao",
          `元宝余额 ${balance} 不足以支付 ${cost.amount}，已停止购买`,
          {
            costItemId: cost.itemId,
            costAmount: cost.amount,
            balanceBefore: balance,
            remainingNumBefore: remainingNum,
          },
        );
      }

      const stop = await externalStopReason();
      if (stop) return { kind: "finish", reason: stop, stopped: true };
      safety.paidRenewAttempted = true;
      const before = applyServerDeadline(summarize(currentSync, config, context));
      const requested = await requestOnce(
        "paid-renew",
        TEAM_ORDER_IFACES.takeOrder,
        { isAgree: true, isCost: true },
      );
      if (requested.kind === "stop" || requested.kind === "limit") {
        return { kind: "finish", reason: requested.reason, stopped: true };
      }
      if (requested.kind === "error") {
        return confirmPaidRenewTruth(
          before,
          cost,
          remainingNum,
          balance,
          requested.error,
        );
      }
      const response = requested.response;
      if (response?.errMsg) {
        append({
          action: "paid-renew",
          status: "server-rejected",
          reason: "paid-renew-server-rejected",
          description: "服务端拒绝付费续开，已停止且不会重试",
          error: safeServerErrorSummary(response),
          costItemId: cost.itemId,
          costAmount: cost.amount,
          remainingNumBefore: remainingNum,
          remainingNumAfter: remainingNum,
          serverConfirmed: false,
          ...eventFields(before),
        });
        return { kind: "finish", reason: "paid-renew-server-rejected" };
      }
      if (!responseHasTeamState(response)) {
        return confirmPaidRenewTruth(
          before,
          cost,
          remainingNum,
          balance,
          new Error("Paid renewal response state is unknown"),
        );
      }

      currentSync = mergeSync(currentSync, response.value);
      result.syncValue = currentSync;
      const after = applyServerDeadline(
        summarize(currentSync, config, context),
      );
      const confirmation = paidRenewConfirmation(
        after,
        cost,
        remainingNum,
        balance,
      );
      if (!confirmation) {
        return confirmPaidRenewTruth(
          before,
          cost,
          remainingNum,
          balance,
          new Error("Paid renewal was not confirmed by an active challenge"),
        );
      }
      return recordPaidRenewSuccess(
        before,
        after,
        cost,
        remainingNum,
        balance,
        confirmation,
      );
    }

    async function waitForBusinessEvents() {
      if (
        oneShotArchive
        ||
        archiveQuarantined
        || pendingArchiveEvents.length === 0
      ) {
        return;
      }
      while (
        !archiveQuarantined
        && pendingArchiveEvents.length > 0
      ) {
        queueArchiveWork();
        const worker = archiveWorker;
        if (!worker) return;
        await worker.catch(() => {});
      }
    }

    async function waitForArchiveClose() {
      await Promise.resolve();
      while (archiveWorker && !archiveQuarantined) {
        const remainingMs =
          archiveCloseDeadlineMs - archiveMonotonicMs();
        if (remainingMs <= 0) {
          archiveQuarantined = true;
          break;
        }
        await archiveSleep(Math.max(1, Math.min(50, remainingMs)));
        await Promise.resolve();
      }
    }

    function recordStop(reason, before = null) {
      append({
        action: "stop",
        status: reason === "experience-guard" ? "experience-guard" : "stopped",
        reason,
        ...eventFields(before),
      });
    }

    async function refreshTruthOnce(action, before) {
      const stop = await externalStopReason();
      if (stop) return { kind: "stop", reason: stop };
      const operation = beginTransport("refreshTruth", (options) => refreshTruth(
        currentSync,
        `team-order:${action}:confirm`,
        options,
      ));
      const transported = await waitForTransport(operation, deadlineState);
      if (transported.kind === "blocked" || transported.kind === "pending") {
        return { kind: "stop", reason: transported.reason };
      }
      if (transported.kind === "error") {
        append({
          action: "failure",
          status: "failure",
          reason: `${action}-truth-refresh`,
          error: safeErrorSummary(transported.error),
          ...eventFields(before),
        });
        return { kind: "refresh-error", error: transported.error };
      }
      const refreshed = transported.value;
      if (refreshed && typeof refreshed === "object") {
        currentSync = refreshed;
        result.syncValue = currentSync;
        adoptChallengeSafety(currentSync);
        const after = summarize(currentSync, config, context);
        observeServerDeadline(after);
        ensureArchive();
      }
      return { kind: "refreshed", syncValue: currentSync };
    }

    async function resyncAfterUnknown(action, before, error) {
      resultInDoubt = {
        action,
        before,
        syncValue: currentSync,
        safety,
      };
      const recordUnknownResult = () => {
        append({
          action,
          status: "timeout",
          reason: "request-result-unknown",
          ...eventFields(before),
        });
        append({
          action: "failure",
          status: "timeout",
          reason: action,
          error: safeErrorSummary(error),
          ...eventFields(before),
        });
      };
      const stop = await externalStopReason();
      if (stop) {
        recordUnknownResult();
        return { kind: "stop", reason: stop, syncValue: currentSync };
      }
      const refreshed = await refreshTruthOnce(action, before);
      if (refreshed.kind === "stop") {
        return refreshed;
      }
      if (refreshed.kind === "refresh-error") {
        recordUnknownResult();
        resultInDoubt.syncValue = currentSync;
        resultInDoubt.safety = safety;
        return {
          kind: "in-doubt",
          reason: "result-in-doubt",
          syncValue: currentSync,
        };
      }
      resultInDoubt = null;
      const after = summarize(currentSync, config, context);
      const stateChanged =
        stateSignature(after) !== stateSignature(before);
      if (!stateChanged) {
        recordUnknownResult();
        safety.unknownStateCount += 1;
        if (
          safety.unknownStateCount
          >= TEAM_ORDER_LIMITS.maxUnknownState
        ) {
          return {
            kind: "limit",
            reason: "unknown-state-limit",
            syncValue: currentSync,
          };
        }
      } else {
        safety.unknownStateCount = 0;
        append({
          action,
          status: "success",
          reason: "truth-confirmed",
          ...eventFields(before, after),
          ...(action === "submit"
            ? { flowerConsumed: before?.need ?? null }
            : {}),
        });
      }
      const limitReason = activeLimitReason(after);
      if (limitReason) {
        return {
          kind: "limit",
          reason: limitReason,
          syncValue: currentSync,
        };
      }
      return {
        kind: "resynced",
        reason: "request-timeout-resynced",
        syncValue: currentSync,
        stateChanged,
      };
    }

    async function requestOnce(action, iface, args) {
      const stop = await externalStopReason();
      if (stop) return { kind: "stop", reason: stop };
      await waitForBusinessEvents();
      const stoppedAfterArchive = await externalStopReason();
      if (stoppedAfterArchive) {
        return { kind: "stop", reason: stoppedAfterArchive };
      }
      const isSettlement = action === "settle";
      const deadline = isSettlement
        ? { reason: null, remainingMs: Number.POSITIVE_INFINITY }
        : deadlineState();
      if (deadline.reason) {
        return { kind: "limit", reason: deadline.reason };
      }
      if (
        safety.unknownStateCount
        >= TEAM_ORDER_LIMITS.maxUnknownState
      ) {
        return { kind: "limit", reason: "unknown-state-limit" };
      }
      if (safety.requestCount >= TEAM_ORDER_LIMITS.maxRequests) {
        return { kind: "limit", reason: "request-limit" };
      }

      if (action === "store") safety.storeAttempted = true;
      const existingSettlement =
        isSettlement && settlementLane && !settlementLane.consumed
          ? settlementLane
          : null;
      if (!existingSettlement) {
        safety.requestCount += 1;
        result.actionCount += 1;
      }
      const operation = existingSettlement || beginTransport(
        "request",
        (options) => request(
          iface,
          args,
          `team-order:${action}`,
          options,
        ),
        isSettlement ? "settlement" : "primary",
      );
      const transported = await waitForTransport(
        operation,
        ["submit", "refresh"].includes(action)
          ? activeMutationDeadlineState
          : deadlineState,
        { yieldIfPending: isSettlement },
      );
      if (
        isSettlement
        && operation
        && !["blocked", "pending"].includes(transported.kind)
      ) {
        operation.consumed = true;
        if (settlementLane === operation) settlementLane = null;
      }
      if (transported.kind === "blocked" || transported.kind === "pending") {
        return { kind: "stop", reason: transported.reason };
      }
      if (transported.kind === "error") {
        const stoppedAfterError = await externalStopReason();
        if (stoppedAfterError) {
          return { kind: "stop", reason: stoppedAfterError };
        }
        return { kind: "error", error: transported.error };
      }
      return { kind: "response", response: transported.value };
    }

    async function mergeActionResponse(action, before, response) {
      const beforeOrder = { ...(getOrder(currentSync) || {}) };
      currentSync = mergeSync(currentSync, response.value);
      result.syncValue = currentSync;
      if (safety.identityKey == null) {
        adoptChallengeSafety(currentSync);
      }
      let after = applyServerDeadline(
        summarize(currentSync, config, context),
      );
      ensureArchive();
      const afterOrder = getOrder(currentSync);
      const changed = actionResponseConfirmed(
        action,
        before,
        after,
        beforeOrder,
        afterOrder,
      );
      if (["submit", "refresh"].includes(action) && !changed) {
        return resyncAfterUnknown(
          action,
          before,
          new Error(`Team order ${action} response was not confirmed`),
        );
      }
      if (
        action === "submit"
        && changed
        && stateSignature(after) !== stateSignature(before)
      ) {
        applyConfirmedSubmitInventoryFallback(before, response.value);
        after = applyServerDeadline(
          summarize(currentSync, config, context),
        );
      }
      append({
        action,
        status: changed ? "success" : "unchanged",
        ...eventFields(before, after),
        ...(action === "submit" && changed
          ? { flowerConsumed: before?.need ?? null }
          : {}),
      });
      return {
        kind: "response",
        changed,
        before,
        after,
        syncValue: currentSync,
      };
    }

    function inventoryCount(flowerId) {
      if (flowerId == null) return null;
      const bag = getBag(currentSync);
      const value = Number(bag?.[flowerId] ?? bag?.[String(flowerId)]);
      return Number.isFinite(value) ? value : null;
    }

    function applyInventoryDelta(flowerId, delta) {
      if (flowerId == null || !Number.isFinite(delta) || delta === 0) {
        return false;
      }
      currentSync = mergeSync(currentSync, {
        $usrTot: {
          itemAddChg: {
            itemMap: { [flowerId]: delta },
          },
        },
      });
      result.syncValue = currentSync;
      return true;
    }

    function applyConfirmedSubmitInventoryFallback(before, responseValue) {
      const need = Number(before?.need);
      const priorCount = Number(before?.have);
      if (
        before?.flowerId == null
        || !Number.isFinite(need)
        || need <= 0
        || !Number.isFinite(priorCount)
        || responseHasInventoryEvidence(responseValue, before.flowerId)
      ) {
        return false;
      }
      const currentCount = inventoryCount(before.flowerId);
      if (currentCount !== priorCount) return false;
      return applyInventoryDelta(before.flowerId, -need);
    }

    function applyRejectedSubmitInventoryCeiling(before) {
      const need = Number(before?.need);
      const currentCount = inventoryCount(before?.flowerId);
      if (
        !Number.isFinite(need)
        || need <= 0
        || !Number.isFinite(currentCount)
      ) {
        return false;
      }
      const targetCount = Math.min(currentCount, Math.max(0, need - 1));
      return applyInventoryDelta(before.flowerId, targetCount - currentCount);
    }

    function isSubmitInventoryRejection(action, before, response) {
      if (action !== "submit" || Number(response?.errMsg?.code) !== 301) {
        return false;
      }
      const rejectedItemId = Number(response?.errMsg?.param?.iid);
      return !Number.isFinite(rejectedItemId)
        || rejectedItemId === Number(before?.flowerId);
    }

    async function waitAfterConfirmedSparseMutation(outcome) {
      if (outcome.kind !== "resynced" || !outcome.stateChanged) {
        return outcome;
      }
      const after = applyServerDeadline(
        summarize(currentSync, config, context),
      );
      const uiStop = await waitForNextAction(after);
      return uiStop
        ? { kind: "stop", reason: uiStop }
        : outcome;
    }

    async function executeAction(action, iface, args, before) {
      const requested = await requestOnce(action, iface, args);
      if (requested.kind === "stop" || requested.kind === "limit") {
        if (
          requested.reason === "server-window-ended"
          && ["submit", "refresh"].includes(action)
        ) {
          pendingMutation = {
            action,
            before,
            operation: transportLane,
          };
          append({
            action,
            status: "pending",
            reason: "server-window-ended",
            ...eventFields(before),
          });
          return { kind: "window-ended", reason: requested.reason };
        }
        return requested;
      }
      if (requested.kind === "error") {
        return resyncAfterUnknown(action, before, requested.error);
      }
      const response = requested.response;
      if (response?.errMsg) {
        append({
          action: "failure",
          status: "server-rejected",
          reason: action,
          error: safeServerErrorSummary(response),
          ...eventFields(before),
        });
        if (isSubmitInventoryRejection(action, before, response)) {
          applyRejectedSubmitInventoryCeiling(before);
          return {
            kind: "retry",
            reason: "server-inventory-shortage",
            syncValue: currentSync,
          };
        }
        if (["submit", "refresh"].includes(action)) {
          const refreshed = await refreshTruthOnce(action, before);
          if (refreshed.kind === "stop") return refreshed;
          if (refreshed.kind === "refresh-error") {
            return { kind: "failed", reason: "server-rejected" };
          }
          const uiStop = await waitForNextAction(
            summarize(currentSync, config, context),
          );
          if (uiStop) return { kind: "stop", reason: uiStop };
          return {
            kind: "retry",
            reason: "server-rejected-recovered",
            syncValue: currentSync,
          };
        }
        return { kind: "failed", reason: "server-rejected" };
      }
      if (action === "refresh") refreshLimiter.recordSuccess();
      if (!responseHasTeamState(response)) {
        return waitAfterConfirmedSparseMutation(
          await resyncAfterUnknown(
            action,
            before,
            new Error("Team order response state is unknown"),
          ),
        );
      }

      return waitAfterConfirmedSparseMutation(
        await mergeActionResponse(action, before, response),
      );
    }

    async function consumePendingMutationIfSettled() {
      const pending = pendingMutation;
      if (!pending?.operation?.settled) return null;
      pendingMutation = null;
      if (pending.operation.error != null) {
        append({
          action: "failure",
          status: "failure",
          reason: `${pending.action}-late-response`,
          error: safeErrorSummary(pending.operation.error),
          ...eventFields(pending.before),
        });
        return null;
      }
      const response = pending.operation.value;
      if (response?.errMsg || !responseHasTeamState(response)) {
        append({
          action: "failure",
          status: response?.errMsg ? "server-rejected" : "failure",
          reason: `${pending.action}-late-response`,
          error: response?.errMsg
            ? safeServerErrorSummary(response)
            : safeErrorSummary("Team order late response state is unknown"),
          ...eventFields(pending.before),
        });
        return null;
      }
      const outcome = await mergeActionResponse(
        pending.action,
        pending.before,
        response,
      );
      if (outcome.changed) {
        if (pending.action === "submit") result.submittedCount += 1;
        if (pending.action === "refresh") {
          result.refreshedCount += 1;
          refreshLimiter.recordSuccess();
        }
      }
      return outcome;
    }

    async function confirmSettlementTruth(before, error, rejected) {
      resultInDoubt = {
        action: "settle",
        before,
        syncValue: currentSync,
        safety,
      };
      append({
        action: "failure",
        status: rejected ? "server-rejected" : "timeout",
        reason: "settle",
        error: safeErrorSummary(error),
        ...eventFields(before),
      });
      const refreshed = await refreshTruthOnce("settle", before);
      if (refreshed.kind === "stop") return refreshed;
      if (refreshed.kind === "refresh-error") {
        resultInDoubt.syncValue = currentSync;
        resultInDoubt.safety = safety;
        return { kind: "in-doubt", reason: "result-in-doubt" };
      }
      resultInDoubt = null;
      const after = applyServerDeadline(
        summarize(currentSync, config, context),
      );
      if (after.effectiveStatus !== 3) {
        append({
          action: "settle",
          status: "success",
          reason: "idempotent-confirmed",
          ...eventFields(before, after),
        });
        return { kind: "settlement", reason: "server-ended", after };
      }
      return {
        kind: "settlement",
        reason: rejected ? "server-rejected" : "settlement-unconfirmed",
        after,
      };
    }

    async function executeSettlement(before) {
      const requested = await requestOnce(
        "settle",
        TEAM_ORDER_IFACES.recvRwd,
        {},
      );
      if (requested.kind === "stop" || requested.kind === "limit") {
        if (
          requested.reason === "settlement-pending"
          && settlementLane
          && !settlementLane.pendingRecorded
        ) {
          settlementLane.pendingRecorded = true;
          append({
            action: "settle",
            status: "pending",
            reason: "request-pending",
            ...eventFields(before),
          });
        }
        return requested;
      }
      if (requested.kind === "error") {
        return confirmSettlementTruth(before, requested.error, false);
      }
      const response = requested.response;
      if (response?.errMsg) {
        if (isAlreadyReceivedMessage(response.errMsg)) {
          return confirmSettlementTruth(
            before,
            safeServerErrorSummary(response),
            true,
          );
        }
        append({
          action: "failure",
          status: "server-rejected",
          reason: "settle",
          error: safeServerErrorSummary(response),
          ...eventFields(before),
        });
        return { kind: "failed", reason: "server-rejected" };
      }
      if (!responseHasTeamState(response)) {
        return confirmSettlementTruth(
          before,
          new Error("Team order response state is unknown"),
          false,
        );
      }
      const outcome = await mergeActionResponse("settle", before, response);
      if (outcome.after?.effectiveStatus !== 3) {
        pendingMutation = null;
      }
      return outcome;
    }

    function activeLimitReason(before) {
      observeServerDeadline(before);
      if (
        before.orderNum != null
        && before.orderNum > config.maxOrderNum
      ) {
        return "order-max-reached";
      }
      if (safety.requestCount >= TEAM_ORDER_LIMITS.maxRequests) {
        return "request-limit";
      }
      return null;
    }

    function accountConfirmedState(before, after) {
      return null;
    }

    const refreshLimiter = createRefreshLimiter({
      maximum: Math.max(1, Number(config.refreshPerSecond) || 1),
      monotonicMs,
      sleep,
      beforeWait: externalStopReason,
      state: safety,
    });

    function publishStatus(status) {
      if (typeof onStatus !== "function") return;
      try {
        onStatus(status);
      } catch {
        // Live console telemetry must never interrupt the 50-second business path.
      }
    }

    function publishActiveStatus(summary = null, lastEvent = null) {
      const currentSummary = summary
        || applyServerDeadline(summarize(currentSync, config, context));
      if (currentSummary.effectiveStatus === 0 && !storedOrder) return;
      const successfulSubmits = pendingArchiveEvents.filter((event) => (
        event.action === "submit" && event.status === "success"
      )).length;
      const successfulRefreshes = pendingArchiveEvents.filter((event) => (
        event.action === "refresh" && event.status === "success"
      )).length;
      const failedEvents = pendingArchiveEvents.filter((event) => (
        event.action !== "inventory-shortage"
        && (
          event.action === "failure"
          || ["failure", "timeout", "server-rejected"].includes(event.status)
        )
      ));
      const serverOrderNum = currentSummary.orderNum ?? null;
      const completedOrderCount =
        completedCountFromServerOrderNum(serverOrderNum);
      const remainingMs = currentSummary.effectiveStatus === 2
        && safety.serverDeadlineMonotonicMs != null
          ? Math.max(0, safety.serverDeadlineMonotonicMs - monotonicMs())
          : Math.max(0, Number(currentSummary.remainingMs) || 0);
      const updatedAtMs = nowMs();
      publishStatus({
        active: true,
        profileId,
        uid,
        trigger: context.trigger || "unknown",
        startedAt: currentSummary.startTimeMs ?? currentSummary.startTime ?? null,
        updatedAt: Number.isFinite(updatedAtMs)
          ? new Date(updatedAtMs).toISOString()
          : null,
        status: currentSummary.status ?? null,
        effectiveStatus: currentSummary.effectiveStatus ?? null,
        serverOrderNum,
        completedOrderCount,
        flowerId: currentSummary.flowerId ?? null,
        flowerName: currentSummary.flowerName ?? null,
        need: currentSummary.need ?? null,
        have: currentSummary.have ?? null,
        submittedCount: successfulSubmits,
        refreshedCount: successfulRefreshes,
        errorCount: failedEvents.length,
        inventoryShortageCount: pendingArchiveEvents.filter(
          (event) => event.action === "inventory-shortage",
        ).length,
        remainingMs,
        paidRenewAvailable: result.paidRenewAvailable,
        paidRenewSkipped: result.paidRenewSkipped,
        paidRenewPurchasedCount: result.paidRenewPurchasedCount,
        paidRenewConfirmedCost: result.paidRenewConfirmedCost,
        lastAction: lastEvent?.action ?? null,
        lastStatus: lastEvent?.status ?? null,
        lastReason: lastEvent?.reason ?? null,
        lastError: failedEvents.at(-1)?.error ?? null,
      });
    }

    async function finishWith(reason) {
      result.finalReason = reason;
      result.syncValue = currentSync;
      return result;
    }

    try {
      result.handled = true;
      ensureArchive();
      publishActiveStatus(initialSummary);

      if (terminalSettlementConfirmed) {
        settlementLane.consumed = true;
        settlementLane = null;
        pendingMutation = null;
        append({
          action: "settle",
          status: "success",
          reason: "truth-confirmed",
          ...eventFields(initialSummary),
        });
        const renewal = await handlePaidRenewAfterSettlement();
        if (renewal?.kind === "rollover") {
          return finishWith("paid-renew-continued");
        }
        if (renewal?.kind !== "continue") {
          if (renewal?.stopped) {
            recordStop(renewal.reason, initialSummary);
          }
          return finishWith(renewal?.reason || "server-ended");
        }
      }

      if (resultInDoubt) {
        const pending = resultInDoubt;
        currentSync = pending.syncValue || currentSync;
        result.syncValue = currentSync;
        safety = pending.safety || safety;
        const pendingLimit = activeLimitReason(
          summarize(currentSync, config, context),
        );
        if (pendingLimit) {
          recordStop(pendingLimit, pending.before);
          return finishWith(pendingLimit);
        }
        const refreshed = await refreshTruthOnce(
          pending.action,
          pending.before,
        );
        if (refreshed.kind === "stop") {
          recordStop(refreshed.reason, pending.before);
          return finishWith(refreshed.reason);
        }
        if (refreshed.kind === "refresh-error") {
          resultInDoubt.syncValue = currentSync;
          resultInDoubt.safety = safety;
          return finishWith("result-in-doubt");
        }
        resultInDoubt = null;
        const refreshedSummary = summarize(currentSync, config, context);
        storedOrder = refreshedSummary.effectiveStatus === 0
          ? selectEarliestStoredOrder(storedOrdersOf(currentSync), nowMs())
          : null;
      }

      if (storedOrder) {
        const before = applyServerDeadline(
          summarize(currentSync, config, context),
        );
        const restored = await executeAction(
          "restore",
          TEAM_ORDER_IFACES.takeStoredOrder,
          { npcId: storedOrder.npcId },
          before,
        );
        if (restored.kind === "stop" || restored.kind === "limit") {
          recordStop(restored.reason, before);
          return finishWith(restored.reason);
        }
        if (restored.kind === "in-doubt") {
          return finishWith(restored.reason);
        }
        if (restored.kind === "resynced" && !restored.stateChanged) {
          return finishWith(restored.reason);
        }
        if (restored.kind === "failed") {
          return finishWith(restored.reason);
        }
        const restoredLimit = accountConfirmedState(
          restored.before,
          restored.after,
        );
        if (restoredLimit) {
          recordStop(restoredLimit, restored.after);
          return finishWith(restoredLimit);
        }
        if (restored.changed) {
          const uiStop = await ensureDialogReady();
          if (uiStop) {
            recordStop(uiStop, restored.after);
            return finishWith(uiStop);
          }
        }
      }

      while (true) {
        const stop = await externalStopReason();
        const before = applyServerDeadline(
          summarize(currentSync, config, context),
        );
        if (stop) {
          recordStop(stop, before);
          return finishWith(stop);
        }

        if (before.effectiveStatus === 0) {
          return finishWith(result.actionCount > 0 ? "server-ended" : "idle");
        }

        if (before.effectiveStatus === 1) {
          const accepted = await executeAction(
            "accept",
            TEAM_ORDER_IFACES.takeOrder,
            { isAgree: true, isCost: false },
            before,
          );
          if (accepted.kind === "stop" || accepted.kind === "limit") {
            recordStop(accepted.reason, before);
            return finishWith(accepted.reason);
          }
          if (accepted.kind === "resynced" && accepted.stateChanged) {
            continue;
          }
          if (
            accepted.kind === "resynced"
            || accepted.kind === "in-doubt"
            || accepted.kind === "failed"
          ) {
            return finishWith(accepted.reason);
          }
          const acceptedLimit = accountConfirmedState(
            accepted.before,
            accepted.after,
          );
          if (acceptedLimit) {
            recordStop(acceptedLimit, accepted.after);
            return finishWith(acceptedLimit);
          }
          if (!accepted.changed) {
            return finishWith("accept-unconfirmed");
          }
          const uiStop = await ensureDialogReady();
          if (uiStop) {
            recordStop(uiStop, accepted.after);
            return finishWith(uiStop);
          }
          continue;
        }

        if (before.effectiveStatus === 3) {
          const uiStop = await ensureRewardReady();
          if (uiStop) {
            recordStop(uiStop, before);
            return finishWith(uiStop);
          }
          await consumePendingMutationIfSettled();
          const lateMutationUiStop = await ensureRewardReady();
          if (lateMutationUiStop) {
            recordStop(lateMutationUiStop, before);
            return finishWith(lateMutationUiStop);
          }
          settlementOrderSnapshot = {
            ...(getOrder(currentSync) || {}),
            rwd: { ...(getOrder(currentSync)?.rwd || {}) },
          };
          const settled = await executeSettlement(before);
          if (settled.kind === "stop" || settled.kind === "limit") {
            if (settled.reason === "settlement-pending") {
              return finishWith(settled.reason);
            }
            recordStop(settled.reason, before);
            return finishWith(settled.reason);
          }
          if (
            ["response", "settlement"].includes(settled.kind)
            && settled.after
          ) {
            const settledLimit = accountConfirmedState(
              before,
              settled.after,
            );
            if (settledLimit) {
              recordStop(settledLimit, settled.after);
              return finishWith(settledLimit);
            }
          }
          if (
            settled.kind === "settlement"
            || settled.kind === "in-doubt"
            || settled.kind === "failed"
          ) {
            if (settled.reason === "server-ended") {
              const renewal = await handlePaidRenewAfterSettlement();
              if (renewal?.kind === "rollover") {
                return finishWith("paid-renew-continued");
              }
              if (renewal?.kind === "continue") continue;
              if (renewal?.stopped) recordStop(renewal.reason, settled.after);
              return finishWith(renewal?.reason || settled.reason);
            }
            return finishWith(settled.reason);
          }
          if (settled.after.effectiveStatus !== 3) {
            const renewal = await handlePaidRenewAfterSettlement();
            if (renewal?.kind === "rollover") {
              return finishWith("paid-renew-continued");
            }
            if (renewal?.kind === "continue") continue;
            if (renewal?.stopped) recordStop(renewal.reason, settled.after);
            return finishWith(renewal?.reason || "server-ended");
          }
          return finishWith(
            settled.after.effectiveStatus === 3
              ? "settlement-unconfirmed"
              : "server-ended",
          );
        }

        if (before.effectiveStatus !== 2) {
          append({
            action: "failure",
            status: "failure",
            reason: "unknown-status",
            ...eventFields(before),
          });
          return finishWith("unknown-status");
        }

        const limitReason = activeLimitReason(before);
        if (limitReason) {
          recordStop(limitReason, before);
          return finishWith(limitReason);
        }
        if (!config.orders.get(before.orderNum)) {
          append({
            action: "failure",
            status: "failure",
            reason: "missing-order-config",
            ...eventFields(before),
          });
          return finishWith("missing-order-config");
        }
        const dialogStop = await ensureDialogReady();
        if (dialogStop) {
          recordStop(dialogStop, before);
          return finishWith(dialogStop);
        }

        let action;
        let iface;
        const protectedFlowerRefresh =
          shouldRefreshProtectedTeamOrderFlower(before.flowerName);
        if (!protectedFlowerRefresh && before.canSubmit) {
          action = "submit";
          iface = TEAM_ORDER_IFACES.submitOrder;
        } else {
          if (protectedFlowerRefresh) {
            append({
              action: "protected-flower",
              status: "skipped",
              reason: "protected-flower-refresh",
              protectedFlower: true,
              ...eventFields(before),
            });
          } else {
            append({
              action: "inventory-shortage",
              status: "failure",
              reason: "insufficient-inventory",
              inventoryShortage: true,
              ...eventFields(before),
            });
          }
          const limiterStop = await refreshLimiter.acquire();
          if (limiterStop) {
            recordStop(limiterStop, before);
            return finishWith(limiterStop);
          }
          const afterWait = applyServerDeadline(
            summarize(currentSync, config, context),
          );
          if (afterWait.effectiveStatus === 3) continue;
          const afterWaitLimit = activeLimitReason(afterWait);
          if (afterWaitLimit) {
            recordStop(afterWaitLimit, afterWait);
            return finishWith(afterWaitLimit);
          }
          action = "refresh";
          iface = TEAM_ORDER_IFACES.refreshOrder;
        }

        const outcome = await executeAction(action, iface, {}, before);
        if (outcome.kind === "window-ended") {
          continue;
        }
        if (outcome.kind === "stop" || outcome.kind === "limit") {
          recordStop(outcome.reason, before);
          return finishWith(outcome.reason);
        }
        if (outcome.kind === "resynced") {
          if (outcome.stateChanged) {
            if (action === "submit") result.submittedCount += 1;
            if (action === "refresh") result.refreshedCount += 1;
            continue;
          }
          return finishWith(outcome.reason);
        }
        if (outcome.kind === "in-doubt") {
          return finishWith(outcome.reason);
        }
        if (outcome.kind === "retry") continue;
        if (outcome.kind === "failed") {
          return finishWith(outcome.reason);
        }

        const outcomeLimit = accountConfirmedState(
          outcome.before,
          outcome.after,
        );
        if (outcomeLimit) {
          recordStop(outcomeLimit, outcome.after);
          return finishWith(outcomeLimit);
        }
        if (action === "submit") result.submittedCount += 1;
        if (action === "refresh") result.refreshedCount += 1;
        const uiStop = await waitForNextAction(outcome.after, action);
        if (uiStop) {
          recordStop(uiStop, outcome.after);
          return finishWith(uiStop);
        }
      }
    } catch (error) {
      append({
        action: "failure",
        status: "failure",
        reason: "runner-error",
        error: safeErrorSummary(error),
        ...eventFields(summarize(currentSync, config, context)),
      });
      return finishWith("runner-error");
    } finally {
      if (!archiveStarted && !archiveQuarantined) {
        ensureArchive();
      }
      if (archive && !archiveQuarantined) {
        const finalSummary = summarize(currentSync, config, context);
        const rewardOrder =
          settlementOrderSnapshot || getOrder(currentSync) || null;
        const calculatedReward = calculateTeamOrderReward(
          rewardOrder,
          config,
          { nobleExpAdd: context.nobleExpAdd },
        );
        const serverOrderNum = result.finalReason === "paid-renew-continued"
          ? rewardOrder?.orderNum ?? finalSummary.orderNum ?? null
          : finalSummary.orderNum ?? rewardOrder?.orderNum ?? null;
        const completedOrderCount =
          completedCountFromServerOrderNum(serverOrderNum);
        const rewardDetails = buildRewardDetails(
          rewardOrder?.rwd,
          calculatedReward,
          context.rewardItemNames,
        );
        archiveFinishValue = shouldFinishArchive(result.finalReason)
          ? {
              finalStatus: finalStatusFor(result.finalReason),
              finalOrderNum: serverOrderNum,
              serverOrderNum,
              completedOrderCount,
              multiplier: calculatedReward.multiplier,
              reward: {
                raw: rewardOrder?.rwd ?? null,
                calculated: calculatedReward,
                ...rewardDetails,
              },
              stopReason: result.finalReason,
              paidRenewAvailable: result.paidRenewAvailable,
              paidRenewSkipped: result.paidRenewSkipped,
              paidRenewPurchasedCount: result.paidRenewPurchasedCount,
              paidRenewConfirmedCost: result.paidRenewConfirmedCost,
            }
          : null;
        if (oneShotArchive) {
          if (archiveFinishValue != null) {
            archiveCloseDeadlineMs =
              archiveMonotonicMs() + archiveCallTimeoutMs;
            await archiveCall("commit", {
              initial: archiveInitial,
              events: pendingArchiveEvents,
              result: archiveFinishValue,
            });
            if (oneShotArchiveSession?.archive === archive) {
              oneShotArchiveSession = null;
            }
            if (provisionalArchiveSession?.events === pendingArchiveEvents) {
              provisionalArchiveSession = null;
            }
          }
        } else {
          archiveCloseRequested = true;
          archiveCloseDeadlineMs =
            archiveMonotonicMs() + archiveCallTimeoutMs;
          queueArchiveWork();
          await waitForArchiveClose();
        }
      }
      if (
        !resultInDoubt
        && result.finalReason === "server-ended"
        && summarize(currentSync, config, context).effectiveStatus === 0
        && !selectEarliestStoredOrder(storedOrdersOf(currentSync), nowMs())
      ) {
        challengeSafety = null;
      }
      if (
        !archive
        && shouldFinishArchive(result.finalReason)
        && result.finalReason !== "settlement-pending"
      ) {
        provisionalArchiveSession = null;
      }
      const finalSummary = summarize(currentSync, config, context);
      if (
        shouldFinishArchive(result.finalReason)
        || (
          finalSummary.effectiveStatus === 0
          && !selectEarliestStoredOrder(storedOrdersOf(currentSync), nowMs())
        )
      ) {
        publishStatus(null);
      } else {
        publishActiveStatus(finalSummary);
      }
    }
  }

  return {
    handle(syncValue, context = {}) {
      if (inFlight) return inFlight;
      inFlight = runLocked(syncValue, context).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    requestStop(reason = "user-stop") {
      stopReason = reason;
      transportLane?.controller.abort(reason);
      settlementLane?.controller.abort(reason);
    },
    setOfficialTeamOrderActionLockHandled(value) {
      officialActionLockHandled = value === true;
    },
    async flush() {
      await inFlight?.catch(() => {});
    },
  };
}
