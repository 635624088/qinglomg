export const CUSTOMER_ORDER_GENERATION_DELAY_MS = 1_001;
export const CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS = 30_000;
export const CUSTOMER_ORDER_SCHEDULER_VERSION = 1;
export const CUSTOMER_ORDER_LATENCY_METRIC_BASIS = "request-start";

function finite(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegative(value, fallback = 0) {
  return Math.max(0, finite(value, fallback));
}

function nonNegativeInteger(value) {
  const number = finite(value, null);
  return number != null && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizeTime(value) {
  const time = finite(value, null);
  return time != null && time > 0 ? time : null;
}

function normalizeNpcIdList(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value
    .map((npcId) => Number(npcId))
    .filter((npcId) => Number.isSafeInteger(npcId) && npcId > 0))];
}

function normalizePreconditions(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const availableNpcIds = normalizeNpcIdList(source.availableNpcIds);
  const pendingOrderCount = nonNegativeInteger(source.pendingOrderCount);
  const availableNpcCount = Object.hasOwn(source, "availableNpcCount")
    ? nonNegativeInteger(source.availableNpcCount)
    : availableNpcIds?.length ?? null;
  return {
    dailyCountKnown: source.dailyCountKnown === true,
    tdyCompletedCount: nonNegativeInteger(source.tdyCompletedCount),
    dailyLimit: nonNegativeInteger(source.dailyLimit),
    pendingOrderCount,
    customerMax: nonNegativeInteger(source.customerMax),
    guestNpcIds: normalizeNpcIdList(source.guestNpcIds) || [],
    availableNpcIds,
    availableNpcCount,
    availableNpcSourceKnown: source.availableNpcSourceKnown === true,
  };
}

function preconditionReason(preconditions) {
  const value = normalizePreconditions(preconditions);
  if (!value.dailyCountKnown || value.dailyLimit == null || value.tdyCompletedCount == null) {
    return "daily-generation-state-unknown";
  }
  if (value.pendingOrderCount == null) return "pending-order-state-unknown";
  if (value.customerMax == null || value.customerMax < 0) return "customer-max-state-unknown";
  if (value.pendingOrderCount >= value.customerMax) {
    return "customer-max-reached";
  }
  if (
    value.dailyCountKnown
    && value.dailyLimit != null
    && value.tdyCompletedCount != null
    && value.tdyCompletedCount + value.pendingOrderCount >= value.dailyLimit
  ) {
    return "daily-generation-limit-reached";
  }
  if (
    !value.availableNpcSourceKnown
    || !value.availableNpcIds
    || value.availableNpcCount == null
    || value.availableNpcCount !== value.availableNpcIds.length
  ) return "available-npc-state-unknown";
  if (!value.availableNpcIds.length) return "no-available-npcs";
  return null;
}

function initialState() {
  return {
    version: CUSTOMER_ORDER_SCHEDULER_VERSION,
    nextGenTimeMs: null,
    nextGenTimeInvalid: false,
    dueAtMs: null,
    retryAtMs: null,
    healthCheckAtMs: null,
    generationInFlight: false,
    generationSequence: 0,
    generationCount: 0,
    generatedOrderCount: 0,
    lastAttemptAtMs: null,
    lastGenerationDecisionAtMs: null,
    lastGenerationRequestStartAtMs: null,
    lastGenerationResponseAtMs: null,
    lastGenerationAtMs: null,
    lastObservedAtMs: null,
    lastOutcome: "pending",
    lastReason: null,
    lastFailureCategory: null,
    lastSkipReason: null,
    lastClockSource: null,
    lastDueToRequestMs: null,
    hasGenerated: false,
    awaitingNextGenTime: false,
    firstActionAtMs: null,
    generationToFirstActionMs: null,
    lastActionAtMs: null,
    lastActionRequestStartAtMs: null,
    lastActionRequestSequence: null,
    actionSequence: 0,
    lastActionType: null,
    lastActionNpcId: null,
    lastMakeToFinishDelayMs: null,
    makeAtByNpcId: new Map(),
  };
}

function copySnapshot(state) {
  return {
    version: state.version,
    latencyMetricBasis: CUSTOMER_ORDER_LATENCY_METRIC_BASIS,
    nextGenTimeMs: state.nextGenTimeMs,
    nextGenTimeInvalid: state.nextGenTimeInvalid,
    dueAtMs: state.dueAtMs,
    retryAtMs: state.retryAtMs,
    healthCheckAtMs: state.healthCheckAtMs,
    generationInFlight: state.generationInFlight,
    generationSequence: state.generationSequence,
    generationCount: state.generationCount,
    generatedOrderCount: state.generatedOrderCount,
    lastAttemptAtMs: state.lastAttemptAtMs,
    lastGenerationDecisionAtMs: state.lastGenerationDecisionAtMs,
    lastGenerationRequestStartAtMs: state.lastGenerationRequestStartAtMs,
    lastGenerationResponseAtMs: state.lastGenerationResponseAtMs,
    lastGenerationAtMs: state.lastGenerationAtMs,
    lastObservedAtMs: state.lastObservedAtMs,
    lastOutcome: state.lastOutcome,
    lastReason: state.lastReason,
    lastFailureCategory: state.lastFailureCategory,
    lastSkipReason: state.lastSkipReason,
    clockSource: state.lastClockSource,
    dueToRequestMs: state.lastDueToRequestMs,
    hasGenerated: state.hasGenerated,
    awaitingNextGenTime: state.awaitingNextGenTime,
    firstActionAtMs: state.firstActionAtMs,
    generationToFirstActionMs: state.generationToFirstActionMs,
    lastActionAtMs: state.lastActionAtMs,
    lastActionRequestStartAtMs: state.lastActionRequestStartAtMs,
    lastActionRequestSequence: state.lastActionRequestSequence,
    actionSequence: state.actionSequence,
    lastActionType: state.lastActionType,
    lastActionNpcId: state.lastActionNpcId,
    lastMakeToFinishDelayMs: state.lastMakeToFinishDelayMs,
  };
}

function resolveActionTime({ nowMs, actionTime, clockSource }, readNow) {
  const action = actionTime && typeof actionTime === "object" ? actionTime : null;
  const hasActionNow = action && Object.hasOwn(action, "nowMs");
  const rawNowMs = hasActionNow ? action.nowMs : nowMs;
  const atMs = rawNowMs === undefined ? readNow() : finite(rawNowMs, null);
  return {
    atMs,
    clockSource: action?.clockSource || clockSource || null,
  };
}

function isInvalidNextGenTime(input, rawValue) {
  if (input?.nextGenTimeInvalid === true) return true;
  if (!Object.hasOwn(input || {}, "nextGenTimeMs")) return false;
  return rawValue != null && rawValue !== "" && normalizeTime(rawValue) == null;
}

export function createCustomerOrderScheduler({
  nowFn = Date.now,
  retryIntervalMs = CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS,
  healthCheckIntervalMs = CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS,
} = {}) {
  if (typeof nowFn !== "function") throw new TypeError("CustomerOrderScheduler requires nowFn");
  const retryMs = Math.max(1, nonNegative(retryIntervalMs, CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS));
  const healthMs = Math.max(1, nonNegative(healthCheckIntervalMs, CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS));
  const state = initialState();
  const readNow = (value) => value === undefined
    ? finite(nowFn(), null)
    : finite(value, null);

  const setHealthCheck = (nowMs) => {
    const atMs = readNow(nowMs);
    if (atMs == null) return null;
    state.healthCheckAtMs = atMs + healthMs;
    return state.healthCheckAtMs;
  };

  const observeSync = (input = {}) => {
    const source = input && typeof input === "object" ? input : {};
    const rawNext = Object.hasOwn(source, "nextGenTimeMs") ? source.nextGenTimeMs : null;
    const invalid = isInvalidNextGenTime(source, rawNext);
    const next = invalid ? null : normalizeTime(rawNext);
    if (invalid) {
      state.nextGenTimeInvalid = true;
      state.nextGenTimeMs = null;
      state.dueAtMs = null;
      state.retryAtMs = null;
      state.healthCheckAtMs = null;
      state.awaitingNextGenTime = false;
      state.lastReason = "next-generation-time-invalid";
      if (source.nowMs !== undefined) state.lastObservedAtMs = readNow(source.nowMs);
      return copySnapshot(state);
    }
    if (
      state.awaitingNextGenTime
      && (next == null || (state.lastGenerationAtMs != null && next <= state.lastGenerationAtMs))
    ) {
      state.lastReason = "next-generation-time-unknown";
      if (source.nowMs !== undefined) state.lastObservedAtMs = readNow(source.nowMs);
      return copySnapshot(state);
    }
    if (
      next != null
      && state.nextGenTimeMs != null
      && next < state.nextGenTimeMs
    ) {
      state.lastReason = "next-generation-time-stale";
      if (source.nowMs !== undefined) state.lastObservedAtMs = readNow(source.nowMs);
      return copySnapshot(state);
    }
    if (next !== state.nextGenTimeMs || state.nextGenTimeInvalid) {
      state.nextGenTimeInvalid = false;
      state.nextGenTimeMs = next;
      state.dueAtMs = next == null ? null : next + CUSTOMER_ORDER_GENERATION_DELAY_MS;
      state.retryAtMs = null;
      state.healthCheckAtMs = null;
      state.awaitingNextGenTime = false;
      state.lastReason = next == null ? "next-generation-time-missing" : "next-generation-time-updated";
    }
    if (source.nowMs !== undefined) state.lastObservedAtMs = readNow(source.nowMs);
    return copySnapshot(state);
  };

  const evaluate = ({
    nowMs,
    actionTime = null,
    clockSource = null,
    enabled = true,
    timeTrusted = true,
    allowInitialGeneration = true,
    preconditions = null,
  } = {}) => {
    const timing = resolveActionTime({ nowMs, actionTime, clockSource }, readNow);
    const atMs = timing.atMs;
    const normalized = normalizePreconditions(preconditions);
    let reason = null;
    let due = false;
    if (!enabled) reason = "disabled";
    else if (state.generationInFlight) reason = "generation-in-flight";
    else if (atMs == null) reason = "invalid-clock";
    else if (state.nextGenTimeInvalid) reason = "next-generation-time-invalid";
    else if (state.awaitingNextGenTime) reason = "next-generation-time-unknown";
    else reason = preconditionReason(normalized);

    if (!reason && state.retryAtMs != null && atMs < state.retryAtMs) {
      reason = "generation-retry-backoff";
    }
    if (!reason && state.nextGenTimeMs != null && atMs < state.dueAtMs) {
      reason = "next-generation-cooldown";
    }
    if (!reason && state.nextGenTimeMs == null && !allowInitialGeneration) {
      reason = "initial-generation-disabled";
    }
    if (!reason) {
      due = true;
      reason = state.nextGenTimeMs == null ? "initial-generation-due" : "next-generation-due";
    }

    if (!due && [
      "invalid-clock",
      "next-generation-time-invalid",
      "next-generation-time-unknown",
      "daily-generation-state-unknown",
      "pending-order-state-unknown",
      "customer-max-state-unknown",
      "customer-max-reached",
      "daily-generation-limit-reached",
      "available-npc-state-unknown",
      "no-available-npcs",
    ].includes(reason)) {
      setHealthCheck(atMs);
    }
    state.lastClockSource = timing.clockSource;
    state.lastSkipReason = due ? null : reason;
    state.lastReason = reason;
    return {
      due,
      reason,
      nowMs: atMs,
      clockSource: timing.clockSource,
      timeTrusted,
      dueAtMs: state.dueAtMs,
      retryAtMs: state.retryAtMs,
      healthCheckAtMs: state.healthCheckAtMs,
      snapshot: copySnapshot(state),
    };
  };

  const dueInMs = ({
    nowMs,
    actionTime = null,
    clockSource = null,
    enabled = true,
    timeTrusted = true,
    allowInitialGeneration = true,
    preconditions = null,
  } = {}) => {
    const timing = resolveActionTime({ nowMs, actionTime, clockSource }, readNow);
    const atMs = timing.atMs;
    state.lastClockSource = timing.clockSource;
    if (!enabled || state.generationInFlight || atMs == null) return Infinity;
    const hasPreconditions = preconditions != null;
    const blocked = state.nextGenTimeInvalid
      ? "next-generation-time-invalid"
      : state.awaitingNextGenTime
        ? "next-generation-time-unknown"
        : hasPreconditions
          ? preconditionReason(preconditions)
          : null;
    if (blocked) {
      if (state.healthCheckAtMs == null || state.healthCheckAtMs <= atMs) setHealthCheck(atMs);
      return state.healthCheckAtMs == null ? Infinity : Math.max(0, state.healthCheckAtMs - atMs);
    }
    if (state.retryAtMs != null && atMs < state.retryAtMs) {
      return state.retryAtMs - atMs;
    }
    if (state.healthCheckAtMs != null && atMs < state.healthCheckAtMs) {
      return state.healthCheckAtMs - atMs;
    }
    if (state.nextGenTimeMs != null) return Math.max(0, state.dueAtMs - atMs);
    return allowInitialGeneration ? 0 : Infinity;
  };

  const beginGeneration = ({
    nowMs,
    actionTime = null,
    clockSource = null,
    decision = null,
    timeTrusted = true,
    requestStartedAtMs = null,
  } = {}) => {
    const timing = resolveActionTime({ nowMs, actionTime, clockSource }, readNow);
    const atMs = timing.atMs;
    state.lastClockSource = timing.clockSource;
    if (state.generationInFlight) {
      state.lastSkipReason = "generation-in-flight";
      return false;
    }
    if (atMs == null) {
      state.lastSkipReason = "invalid-clock";
      return false;
    }
    if (state.nextGenTimeInvalid) {
      state.lastSkipReason = "next-generation-time-invalid";
      return false;
    }
    if (decision && decision.due !== true) {
      state.lastSkipReason = decision.reason || "not-due";
      return false;
    }
    if (!decision) {
      const due = state.nextGenTimeMs == null
        ? true
        : atMs >= state.dueAtMs && (state.retryAtMs == null || atMs >= state.retryAtMs);
      if (!due) {
        state.lastSkipReason = "not-due";
        return false;
      }
    }
    state.generationInFlight = true;
    state.generationSequence += 1;
    state.lastAttemptAtMs = atMs;
    state.lastGenerationDecisionAtMs = atMs;
    state.lastGenerationRequestStartAtMs = finite(requestStartedAtMs, null);
    state.lastDueToRequestMs = state.dueAtMs == null
      ? null
      : Math.max(0, (state.lastGenerationRequestStartAtMs ?? atMs) - state.dueAtMs);
    state.lastOutcome = "in-flight";
    state.lastReason = "generation-request";
    state.lastSkipReason = null;
    return true;
  };

  const completeGeneration = ({
    nowMs,
    requestStartedAtMs = null,
    responseAtMs = null,
    nextGenTimeMs = null,
    nextGenTimeInvalid = false,
    generatedOrderCount = 0,
  } = {}) => {
    const atMs = readNow(nowMs);
    const requestStartMs = finite(requestStartedAtMs, null)
      ?? state.lastGenerationRequestStartAtMs
      ?? atMs;
    const responseMs = finite(responseAtMs, null) ?? atMs;
    state.generationInFlight = false;
    state.generationCount += 1;
    state.generatedOrderCount = Math.max(0, Math.floor(finite(generatedOrderCount, 0)));
    state.lastGenerationDecisionAtMs = state.lastGenerationDecisionAtMs ?? atMs;
    state.lastGenerationRequestStartAtMs = requestStartMs;
    state.lastGenerationResponseAtMs = responseMs;
    state.lastGenerationAtMs = requestStartMs;
    state.lastOutcome = "success";
    state.lastReason = "generation-success";
    state.lastFailureCategory = null;
    state.retryAtMs = null;
    state.healthCheckAtMs = null;
    state.hasGenerated = true;
    state.firstActionAtMs = null;
    state.generationToFirstActionMs = null;
    state.lastMakeToFinishDelayMs = null;
    state.makeAtByNpcId.clear();
    const invalid = nextGenTimeInvalid || (
      nextGenTimeMs != null
      && nextGenTimeMs !== ""
      && normalizeTime(nextGenTimeMs) == null
    );
    state.nextGenTimeInvalid = invalid;
    const next = invalid ? null : normalizeTime(nextGenTimeMs);
    state.nextGenTimeMs = next;
    state.dueAtMs = next == null ? null : next + CUSTOMER_ORDER_GENERATION_DELAY_MS;
    state.awaitingNextGenTime = !invalid && next == null;
    if (invalid) {
      state.lastReason = "next-generation-time-invalid";
      setHealthCheck(atMs);
    } else if (state.generatedOrderCount === 0) {
      state.retryAtMs = (requestStartMs ?? responseMs ?? atMs) + retryMs;
      state.lastReason = "generation-success-no-new-orders";
      if (next == null) setHealthCheck(atMs);
    } else if (next == null) {
      setHealthCheck(atMs);
    }
    return copySnapshot(state);
  };

  const failGeneration = ({ nowMs, reason = "generation-failed", category = "unknown" } = {}) => {
    const atMs = readNow(nowMs);
    state.generationInFlight = false;
    state.lastOutcome = "failure";
    state.lastReason = reason;
    state.lastFailureCategory = category;
    state.retryAtMs = atMs == null ? null : atMs + retryMs;
    state.healthCheckAtMs = null;
    return copySnapshot(state);
  };

  const recordAction = ({
    nowMs,
    requestStartedAtMs = null,
    requestSequence = null,
    type,
    npcId = null,
  } = {}) => {
    const atMs = readNow(nowMs);
    const requestStartMs = finite(requestStartedAtMs, null) ?? atMs;
    const explicitSequence = nonNegativeInteger(requestSequence);
    const sequence = explicitSequence ?? (state.actionSequence + 1);
    state.actionSequence = Math.max(state.actionSequence, sequence ?? 0);
    const actionType = String(type || "unknown");
    let generationToFirstActionMs = null;
    let makeToFinishDelayMs = null;
    if (state.firstActionAtMs == null) {
      state.firstActionAtMs = requestStartMs;
      generationToFirstActionMs = state.lastGenerationAtMs == null || requestStartMs == null
        ? null
        : Math.max(0, requestStartMs - state.lastGenerationAtMs);
      state.generationToFirstActionMs = generationToFirstActionMs;
    }
    const key = npcId == null ? null : String(npcId);
    if (actionType === "makeFlowerArt" && key != null) state.makeAtByNpcId.set(key, requestStartMs);
    if (actionType === "finishCustomerOrder" && key != null && state.makeAtByNpcId.has(key)) {
      makeToFinishDelayMs = requestStartMs == null
        ? null
        : Math.max(0, requestStartMs - state.makeAtByNpcId.get(key));
      state.lastMakeToFinishDelayMs = makeToFinishDelayMs;
      state.makeAtByNpcId.delete(key);
    }
    state.lastActionAtMs = requestStartMs;
    state.lastActionRequestStartAtMs = requestStartMs;
    state.lastActionRequestSequence = sequence;
    state.lastActionType = actionType;
    state.lastActionNpcId = npcId;
    return {
      latencyMetricBasis: CUSTOMER_ORDER_LATENCY_METRIC_BASIS,
      requestStartAtMs: requestStartMs,
      requestSequence: sequence,
      generationToFirstActionMs,
      makeToFinishDelayMs,
      snapshot: copySnapshot(state),
    };
  };

  return Object.freeze({
    observeSync,
    evaluate,
    dueInMs,
    beginGeneration,
    completeGeneration,
    failGeneration,
    recordAction,
    snapshot() {
      return copySnapshot(state);
    },
  });
}
