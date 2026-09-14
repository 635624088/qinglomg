import {
  createRateLimitGuard,
  isRequestRateLimitedError,
} from "./rate-limit-guard.mjs";

const ACCOUNT_COMMAND_GATEWAY = Symbol("xjskp.account-command-gateway");
const TRANSPORT_REQUEST_STATE = Symbol("xjskp.transport-request-state");
const DEFAULT_TEAM_ORDER_ACTION_LOCK_MS = 300;
const TEAM_ORDER_ACTION_LOCK_IFACES = new Set([
  "gs.orderTeam.submitOrder",
  "gs.orderTeam.refreshOrder",
]);
// Once the team-order flow has started, experience prediction must never
// interrupt its protocol. The trigger decision is made before admission;
// these requests must be allowed to finish, including reward collection.
const UNINTERRUPTIBLE_TEAM_ORDER_IFACES = new Set([
  "gs.orderTeam.takeOrder",
  "gs.orderTeam.takeStoredOrder",
  "gs.orderTeam.submitOrder",
  "gs.orderTeam.refreshOrder",
  "gs.orderTeam.recvRwd",
  "gs.orderTeam.storeOrder",
]);
const FLOWER_ORDER_TRACE_FIELDS = ["finishCnt", "cTime", "isVideo"];

function isTraceRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function summarizeFlowerOrderTraceValue(value) {
  if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  return `[${typeof value}]`;
}

function summarizeFlowerOrderTraceSlot(orderFlower, slotName) {
  const slot = isTraceRecord(orderFlower) && Object.hasOwn(orderFlower, slotName)
    ? orderFlower[slotName]
    : null;
  if (!isTraceRecord(slot)) {
    return { present: false, missing: FLOWER_ORDER_TRACE_FIELDS };
  }
  const missing = FLOWER_ORDER_TRACE_FIELDS.filter((field) => !Object.hasOwn(slot, field));
  return {
    present: true,
    ...(Object.hasOwn(slot, "finishCnt")
      ? { finishCnt: summarizeFlowerOrderTraceValue(slot.finishCnt) }
      : {}),
    ...(Object.hasOwn(slot, "cTime")
      ? { cTime: summarizeFlowerOrderTraceValue(slot.cTime) }
      : {}),
    ...(Object.hasOwn(slot, "isVideo")
      ? { isVideo: summarizeFlowerOrderTraceValue(slot.isVideo) }
      : {}),
    missing,
  };
}

function summarizeFlowerOrderTrace(syncValue) {
  const orderFlowerTot = isTraceRecord(syncValue) && isTraceRecord(syncValue.orderFlowerTot)
    ? syncValue.orderFlowerTot
    : null;
  const orderFlower = orderFlowerTot && Object.hasOwn(orderFlowerTot, "orderFlower")
    ? orderFlowerTot.orderFlower
    : null;
  return {
    present: isTraceRecord(orderFlower),
    satin: summarizeFlowerOrderTraceSlot(orderFlower, "orderSatin"),
    decorate: summarizeFlowerOrderTraceSlot(orderFlower, "orderDecorate"),
  };
}

function responseExplicitlyIncludesFlowerOrder(value) {
  return isTraceRecord(value)
    && isTraceRecord(value.orderFlowerTot)
    && Object.hasOwn(value.orderFlowerTot, "orderFlower");
}

function flowerOrderTraceChanged(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function emitFlowerOrderTrace(emit, entry) {
  try {
    emit?.(entry);
  } catch {
    // Diagnostics must not alter account-command flow.
  }
  try {
    console.log(JSON.stringify(entry));
  } catch {
    // Diagnostics must not alter account-command flow.
  }
}

function defaultTeamOrderActionSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertTransport(transport) {
  if (!transport || typeof transport.request !== "function") {
    throw new TypeError("AccountCommandGateway requires a request-capable transport");
  }
}

function assertFactory(factory, name) {
  if (typeof factory !== "function") {
    throw new TypeError(`AccountCommandGateway requires ${name}`);
  }
}

export function isAccountCommandGateway(value) {
  return value?.[ACCOUNT_COMMAND_GATEWAY] === true;
}

export function createAccountCommandGateway({
  transport: initialTransport,
  token: initialToken = null,
  syncRef = { current: null },
  contextRef = {},
  createExperienceClient,
  runAtRequestBoundary,
  rateLimitGuard: outerRateLimitGuard = null,
  rateLimitWindowMs,
  rateLimitMaxRequestsPerWindow,
  rateLimitMinBackoffMs,
  rateLimitMaxBackoffMs,
  onRateLimited,
  onFlowerOrderSyncTrace,
} = {}) {
  assertTransport(initialTransport);
  assertFactory(createExperienceClient, "createExperienceClient");
  assertFactory(runAtRequestBoundary, "runAtRequestBoundary");
  if (!syncRef || typeof syncRef !== "object" || !("current" in syncRef)) {
    throw new TypeError("AccountCommandGateway requires a mutable syncRef");
  }
  if (!contextRef || typeof contextRef !== "object") {
    throw new TypeError("AccountCommandGateway requires a mutable contextRef");
  }

  let transport = initialTransport;
  let token = initialToken;
  let requestQueue = Promise.resolve();
  let sessionGeneration = 1;

  const rateLimitGuard = outerRateLimitGuard
    || createRateLimitGuard({
      windowMs: rateLimitWindowMs,
      maxRequestsPerWindow: rateLimitMaxRequestsPerWindow,
      minBackoffMs: rateLimitMinBackoffMs,
      maxBackoffMs: rateLimitMaxBackoffMs,
    });
  const notifyRateLimited = typeof onRateLimited === "function"
    ? onRateLimited
    : null;
  const emitFlowerOrderSyncTrace = typeof onFlowerOrderSyncTrace === "function"
    ? onFlowerOrderSyncTrace
    : null;
  const getFlowerOrderSyncTraceSink = () => (
    emitFlowerOrderSyncTrace
    || (typeof contextRef.onFlowerOrderSyncTrace === "function"
      ? contextRef.onFlowerOrderSyncTrace
      : null)
  );

  const privateTransport = Object.freeze({
    async request(iface, args, requestToken = token, requestContext = {}) {
      requestContext?.[TRANSPORT_REQUEST_STATE] && (
        requestContext[TRANSPORT_REQUEST_STATE].started = true
      );
      return transport.request(iface, args, requestToken, requestContext);
    },
    close() {
      return transport.close?.();
    },
  });
  const experienceClient = createExperienceClient(
    privateTransport,
    initialToken,
    syncRef,
    contextRef,
    {
      rateLimitGuard,
      onRateLimited,
      rateLimitWindowMs,
      rateLimitMaxRequestsPerWindow,
      rateLimitMinBackoffMs,
      rateLimitMaxBackoffMs,
    },
  );
  if (!experienceClient || typeof experienceClient.request !== "function") {
    throw new TypeError("createExperienceClient must return a request-capable client");
  }

  const enqueue = (operation) => {
    const run = requestQueue.then(operation, operation);
    requestQueue = run.catch(() => {});
    return run;
  };

  const gateway = {
    [ACCOUNT_COMMAND_GATEWAY]: true,

    request(iface, args = {}, requestToken = token, requestContext = {}) {
      const queuedGeneration = sessionGeneration;
      return enqueue(async () => {
        if (queuedGeneration !== sessionGeneration) {
          const error = new Error("Account command belongs to a stale transport generation");
          error.code = "STALE_ACCOUNT_COMMAND_GENERATION";
          error.iface = iface;
          throw error;
        }
        const boundaryContext = {
          ...contextRef,
          ...requestContext,
          iface,
          sessionGeneration,
        };
        await rateLimitGuard.acquire(iface);
        const transportRequestState = { started: false };
        const gatewayRequestContext = {
          ...requestContext,
          [TRANSPORT_REQUEST_STATE]: transportRequestState,
        };
        try {
          return await runAtRequestBoundary(
            boundaryContext,
            async () => {
              try {
                const result = await experienceClient.request(
                  iface,
                  args,
                  requestToken ?? token,
                  gatewayRequestContext,
                );
                rateLimitGuard.observeSuccess(iface);
                return result;
              } catch (requestError) {
                if (isRequestRateLimitedError(requestError)) {
                  const backoffMs = rateLimitGuard.recordRateLimited(iface);
                  notifyRateLimited?.({
                    iface,
                    backoffMs,
                    message: requestError?.message || String(requestError),
                    error: requestError,
                  });
                }
                throw requestError;
              }
            },
            () => transport.close?.(),
          );
        } catch (requestError) {
          if (requestError && typeof requestError === "object") {
            requestError.transportRequestStarted = transportRequestState.started === true;
          }
          throw requestError;
        }
      });
    },

    observeSync(syncValue, context = {}) {
      const before = summarizeFlowerOrderTrace(syncRef.current);
      const persistentExperienceGuardState = syncRef.current?.$experienceGuardState;
      syncRef.current = persistentExperienceGuardState
        ? { ...syncValue, $experienceGuardState: persistentExperienceGuardState }
        : syncValue;
      Object.assign(contextRef, context);
      const after = summarizeFlowerOrderTrace(syncRef.current);
      if (flowerOrderTraceChanged(before, after)) {
        emitFlowerOrderTrace(getFlowerOrderSyncTraceSink(), {
          step: "flowerOrderObserveSyncTrace",
          context: {
            cycle: context?.cycle ?? null,
            source: context?.source ?? null,
            step: context?.step ?? null,
          },
          before,
          after,
        });
      }
      return syncRef.current;
    },

    updateContext(context = {}) {
      Object.assign(contextRef, context);
    },

    getSyncValue() {
      return syncRef.current;
    },

    getRateLimitState() {
      return rateLimitGuard.snapshot();
    },

    getSessionGeneration() {
      return sessionGeneration;
    },

    async flush() {
      await requestQueue;
    },

    async replaceTransport(nextTransport, options = {}) {
      assertTransport(nextTransport);
      await requestQueue;
      transport = nextTransport;
      if (Object.hasOwn(options, "token")) token = options.token;
      if (Object.hasOwn(options, "syncValue")) {
        syncRef.current = options.syncValue;
        experienceClient.observeAuthoritativeSync?.(
          options.syncValue,
          options.context?.source || "gateway-reconnect",
          options.context || {},
        );
      }
      if (options.context && typeof options.context === "object") {
        Object.assign(contextRef, options.context);
      }
      sessionGeneration += 1;
      return sessionGeneration;
    },

    close() {
      return transport.close?.();
    },
  };

  return Object.freeze(gateway);
}

export function createExperienceCommandClient(
  ws,
  gsToken,
  syncRef,
  options = {},
  dependencies = {},
) {
  const {
    DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT,
    ExperienceActionBlockedError,
    ExperienceGuardStopError,
    buildExperienceSettlementAudit,
    classifyAutomationExperienceInterface,
    estimateExperienceAction,
    evaluateExperienceAction,
    formatExperienceGuardThresholdPercent,
    getExperienceGuardThresholdPercent,
    isAuthorizedTeamColdStartRequest,
    isValidExperienceGuardThresholdPercent,
    loadExperienceSettlementConfig,
    logExperienceGuardActionSkip,
    mergeLandSync,
    parseExperienceSettlementEvidence,
    refreshExperienceGuardSync,
    summarizeAccountLevel,
    summarizeExperienceGuard,
    washResponse,
    isSessionExpiredError = null,
    isWsRequestTimeoutError = null,
    isUserStoppedError = null,
  } = dependencies;
  const experienceConfig = options.experienceConfig || loadExperienceSettlementConfig();
  const experienceLevelGuard = options.experienceLevelGuard || null;
  const rateLimitGuard = options.rateLimitGuard || createRateLimitGuard({});
  const onRateLimited = typeof options.onRateLimited === "function"
    ? options.onRateLimited
    : null;
  const teamOrderActionLockMs = Number.isFinite(
    Number(options.teamOrderActionLockMs),
  )
    ? Math.max(0, Number(options.teamOrderActionLockMs))
    : DEFAULT_TEAM_ORDER_ACTION_LOCK_MS;
  const teamOrderActionSleep = typeof options.teamOrderActionSleep === "function"
    ? options.teamOrderActionSleep
    : defaultTeamOrderActionSleep;
  const waitForTeamOrderActionLock = (iface) => {
    if (!TEAM_ORDER_ACTION_LOCK_IFACES.has(iface)) return Promise.resolve();
    return Promise.resolve().then(() => (
      teamOrderActionSleep(teamOrderActionLockMs)
    ));
  };
  const readThresholdPercent = () => {
    const configured = typeof options.getExperienceGuardThresholdPercent === "function"
      ? options.getExperienceGuardThresholdPercent()
      : getExperienceGuardThresholdPercent();
    return isValidExperienceGuardThresholdPercent(configured)
      ? configured
      : DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT;
  };
  const authoritySyncIfaces = new Set([
    "gs.index.login",
    "gs.usr.lazySync",
    "gs.usr.heartTick",
  ]);
  let experienceQueue = Promise.resolve();
  let unexpectedSettlement = null;
  let requestSequence = 0;

  const nextRequestId = () => (
    `exp-${options.cycle ?? "na"}-${++requestSequence}`
  );

  const isKnownBusinessRejection = (error) => Boolean(
    error?.errMsg
    || error?.code === 301
    || error?.code === "BUSINESS_REJECTED",
  );

  const isSessionExpired = (error) => (
    typeof isSessionExpiredError === "function"
      ? isSessionExpiredError(error)
      : /session expired|会话已过期|登录失效|未登录/i.test(error?.message || String(error || ""))
  );

  const isTransportUnknown = (error) => (
    typeof isWsRequestTimeoutError === "function"
      ? isWsRequestTimeoutError(error)
      : /ws closed|web socket is not open|timed out|timeout|network/i.test(
          error?.message || String(error || ""),
        )
  );

  const isUserStopped = (error) => (
    typeof isUserStoppedError === "function"
      ? isUserStoppedError(error)
      : error?.reason === "user-stopped"
        || error?.stopReason === "user-stopped"
        || /用户停止|user stopped/i.test(error?.message || String(error || ""))
  );

  const annotateAutomationClassification = (error, classification) => {
    if (error && (typeof error === "object" || typeof error === "function")) {
      error.automationClassification = {
        ...classification,
        iface: classification.iface ?? null,
        requestId: classification.requestId ?? null,
      };
      return error;
    }
    const out = new Error(String(error || "Unknown protected action error"));
    out.cause = error;
    out.automationClassification = {
      ...classification,
      iface: classification.iface ?? null,
      requestId: classification.requestId ?? null,
    };
    return out;
  };

  const observePersistentAuthority = (
    source,
    evidence = null,
    requestId = null,
    eligibleRearmRequestId = null,
  ) => {
    if (!experienceLevelGuard) return null;
    const accountLevel = summarizeAccountLevel(syncRef.current);
    if (accountLevel.level == null) return experienceLevelGuard.getState();
    const accountData = syncRef.current?.$usrTot?.data
      || syncRef.current?.$usrTot?.usr
      || {};
    const state = experienceLevelGuard.observeAuthoritative({
      level: accountLevel.level,
      currentExp: accountLevel.currentExp,
      requiredExp: accountLevel.requiredExp,
      accountUid: accountData.id ?? accountData.uid ?? accountData.usrId ?? null,
      serverIdx: accountLevel.serverIdx,
      enabled: readThresholdPercent() > 0,
      source,
      evidence: evidence ? { ...evidence, requestId } : { requestId },
      eligibleRearmRequestId,
    });
    syncRef.current = {
      ...syncRef.current,
      $experienceGuardState: state,
    };
    return state;
  };

  const throwPersistentLevelBreach = (
    iface,
    classification,
    thresholdPercent = readThresholdPercent(),
    requireArmed = false,
  ) => {
    if (!experienceLevelGuard || classification.kind === "none") return;
    const decision = experienceLevelGuard.getDecision({
      enabled: thresholdPercent > 0,
    });
    syncRef.current = {
      ...syncRef.current,
      $experienceGuardState: decision.state,
    };
    const mustWaitForBaseline = thresholdPercent > 0
      && decision.reason === "experience-level-ceiling-unarmed"
      && (
        requireArmed
        || classification.kind === "pending"
        || iface === "gs.orderTeam.recvRwd"
      );
    if (!decision.blocked && !mustWaitForBaseline) return;
    const state = decision.state || {};
    const blockedReason = mustWaitForBaseline
      ? "experience-level-ceiling-unarmed"
      : decision.reason;
    const settlementUncertain = state.invalid === true
      && decision.reason === "experience-guard-settlement-unresolved";
    const experienceGuard = {
      ...summarizeExperienceGuard(syncRef.current, {
        stopped: true,
        thresholdPercent,
      }),
      blocked: true,
      reason: blockedReason,
      armedLevel: state.armedLevel ?? null,
      ceilingLevel: state.ceilingLevel ?? null,
      breached: state.breached === true,
      breachEvidence: state.breachEvidence ?? null,
      stateRevision: state.stateRevision ?? null,
      blockedIface: iface,
      settlementKind: classification.kind,
      reasonText: mustWaitForBaseline
        ? `经验等级保护尚未取得权威等级基线，已跳过 ${iface}；无经验动作继续`
        : settlementUncertain
        ? `收益请求未确认（网络中断或任务停止），已暂缓 ${iface}；未判定为经验保护线命中`
        : state.invalid
        ? `经验等级保护状态不可用（${decision.reason}），已跳过 ${iface}；无经验动作继续`
        : `经验等级上限已越过：布防等级 ${state.armedLevel ?? "未知"}，上限等级 ${state.ceilingLevel ?? "未知"}，当前权威等级 ${state.lastAuthoritativeLevel ?? "未知"}；请在控制台明确重新布防后恢复收益动作`,
    };
    logExperienceGuardActionSkip({
      cycle: options.cycle ?? null,
      action: options.action || "reward-action",
      iface,
      experienceGuard,
    });
    const error = new ExperienceActionBlockedError(experienceGuard);
    error.iface = iface;
    throw error;
  };

  const throwInvalidPendingRearm = (
    iface,
    classification,
    pending,
    thresholdPercent = readThresholdPercent(),
  ) => {
    if (!pending?.invalid || classification.kind === "none" || thresholdPercent <= 0) return;
    const experienceGuard = {
      ...summarizeExperienceGuard(syncRef.current, {
        stopped: true,
        thresholdPercent,
      }),
      blocked: true,
      reason: pending.reason || "experience-guard-rearm-invalid",
      blockedIface: iface,
      settlementKind: classification.kind,
      reasonText: `经验等级重新布防请求不可用（${pending.reason || "experience-guard-rearm-invalid"}），已跳过 ${iface}；无经验动作继续`,
    };
    logExperienceGuardActionSkip({
      cycle: options.cycle ?? null,
      action: options.action || "reward-action",
      iface,
      experienceGuard,
    });
    const error = new ExperienceActionBlockedError(experienceGuard);
    error.iface = iface;
    throw error;
  };

  const emitSettlementAudit = (entry) => {
    options.onExperienceSettlementAudit?.(entry);
    if (entry.step === "experienceSnapshotRegression") return;
    console.log(JSON.stringify(entry));
  };

  const emitFlowerOrderSyncTrace = (entry) => {
    emitFlowerOrderTrace(options.onFlowerOrderSyncTrace, entry);
  };

  const runExperienceExclusive = (operation) => {
    const run = experienceQueue.then(operation, operation);
    experienceQueue = run.catch(() => {});
    return run;
  };

  const mergeSuccessfulResponse = (
    iface,
    raw,
    classification,
    estimate = null,
    requestId = null,
    eligibleRearmRequestId = null,
  ) => {
    const rsp = washResponse(raw);
    if (rsp.errMsg || !rsp.value) {
      return {
        raw,
        rsp,
        actualExpDelta: 0,
        businessRejected: Boolean(rsp.errMsg),
      };
    }
    const beforeFlowerOrder = summarizeFlowerOrderTrace(syncRef.current);
    const responseIncludesFlowerOrder = responseExplicitlyIncludesFlowerOrder(rsp.value);
    const responseFlowerOrder = responseIncludesFlowerOrder
      ? summarizeFlowerOrderTrace(rsp.value)
      : null;
    const evidence = parseExperienceSettlementEvidence(syncRef.current, rsp.value);
    syncRef.current = mergeLandSync(syncRef.current, rsp.value);
    if (responseIncludesFlowerOrder) {
      emitFlowerOrderSyncTrace({
        step: "flowerOrderResponseMergeTrace",
        iface,
        requestId,
        before: beforeFlowerOrder,
        response: responseFlowerOrder,
        after: summarizeFlowerOrderTrace(syncRef.current),
      });
    }
    const audit = buildExperienceSettlementAudit({
      cycle: options.cycle ?? null,
      requestId,
      iface,
      settlementKind: classification.kind,
      estimate,
      evidence,
    });
    if (
      evidence.responseLevel != null
      || (authoritySyncIfaces.has(iface) && eligibleRearmRequestId)
    ) {
      observePersistentAuthority(
        evidence.responseLevel != null ? iface : `${iface}-no-change-confirmed`,
        evidence,
        requestId,
        eligibleRearmRequestId,
      );
    }
    emitSettlementAudit(audit);
    if (evidence.regression) {
      emitSettlementAudit({
        ...audit,
        step: "experienceSnapshotRegression",
      });
      console.warn(JSON.stringify({
        ...audit,
        step: "experienceSnapshotRegression",
      }));
    }
    const actualExpDelta = Number.isFinite(Number(evidence.actualExpDelta))
      ? Number(evidence.actualExpDelta)
      : 0;
    const exceedsPrediction = estimate?.known === true
      && Number.isFinite(Number(estimate.maxExp))
      && actualExpDelta > Number(estimate.maxExp);
    const evidenceConflict = audit.conflict;
    const unexpected = !authoritySyncIfaces.has(iface)
      && (
        evidenceConflict
        || (
          actualExpDelta > 0
          && (
            classification.kind === "none"
            || classification.kind === "pending"
            || exceedsPrediction
          )
        )
      );
    if (unexpected) {
      unexpectedSettlement = {
        requestId,
        iface,
        settlementKind: classification.kind,
        actualExpDelta,
        predictedMaxExp: estimate?.maxExp ?? null,
        reason: evidence.regression
          ? "experience-snapshot-regression"
          : evidenceConflict
            ? "experience-evidence-conflict"
            : exceedsPrediction
              ? "experience-exceeded-prediction"
              : "experience-unexpected-settlement",
        conflict: audit.conflict,
        conflictReason: audit.conflictReason,
      };
      options.onUnexpectedExperienceSettlement?.(unexpectedSettlement);
      console.warn(JSON.stringify({
        step: "experienceUnexpectedSettlement",
        cycle: options.cycle ?? null,
        ...unexpectedSettlement,
      }));
    }
    return { raw, rsp, actualExpDelta, evidence, audit };
  };

  const reconcilePendingSettlement = async ({
    responseIface,
    responseValue,
    requestId,
  }) => {
    if (!experienceLevelGuard || typeof options.resolveProtectedActionSettlement !== "function") {
      return null;
    }
    const pending = experienceLevelGuard.getPendingSettlement?.();
    if (!pending || pending.invalid || pending.requestId === requestId) return null;
    const result = await options.resolveProtectedActionSettlement({
      pending,
      responseIface,
      responseValue,
      syncValue: syncRef.current,
      recoveryRequest: experienceLevelGuard.getPendingSettlementRecovery?.() ?? null,
    });
    if (!result || result.status === "not-applicable") return null;
    if (result.status === "confirmed" || result.status === "rejected") {
      const state = experienceLevelGuard.resolveProtectedAction({
        requestId: pending.requestId,
        outcome: result.status,
        source: result.source || responseIface,
        reason: result.reason || null,
        recoveryRequestId: result.recoveryRequestId || null,
      });
      syncRef.current = {
        ...syncRef.current,
        $experienceGuardState: state,
      };
      observePersistentAuthority(
        `settlement-resolution:${responseIface}`,
        null,
        requestId,
      );
      return result;
    }
    experienceLevelGuard.recordProtectedActionCheck?.({
      requestId: pending.requestId,
      source: result.source || responseIface,
      reason: result.reason || "authority-proof-inconclusive",
    });
    return result;
  };

  const throwUnexpectedSettlement = (iface, arg = {}, thresholdPercent = readThresholdPercent()) => {
    if (!unexpectedSettlement) return;
    const classification = classifyAutomationExperienceInterface(iface);
    const estimate = ["direct", "conditional"].includes(classification.kind)
      ? estimateExperienceAction({
          iface,
          arg,
          syncValue: syncRef.current,
          config: experienceConfig,
        })
      : null;
    emitSettlementAudit(buildExperienceSettlementAudit({
      cycle: options.cycle ?? null,
      requestId: nextRequestId(),
      iface,
      settlementKind: classification.kind,
      estimate,
      evidence: parseExperienceSettlementEvidence(
        syncRef.current,
        null,
      ),
      experienceSource: "blocked-existing-conflict",
      conflict: true,
      conflictReason:
        unexpectedSettlement.conflictReason
        || unexpectedSettlement.reason,
    }));
    const base = summarizeExperienceGuard(syncRef.current, {
      stopped: true,
      thresholdPercent,
    });
    const experienceGuard = {
      ...base,
      blocked: true,
      reason: unexpectedSettlement.reason,
      reasonText: `经验保护：接口 ${unexpectedSettlement.iface} 出现未预期经验 ${unexpectedSettlement.actualExpDelta}，已停止后续收益动作`,
      unexpectedSettlement,
      blockedIface: iface,
    };
    logExperienceGuardActionSkip({
      cycle: options.cycle ?? null,
      action: options.action || "reward-action",
      iface,
      experienceGuard,
    });
    throw new ExperienceGuardStopError(experienceGuard);
  };

  const requestAndMerge = async (
    iface,
    arg,
    token,
    classification,
    estimate = null,
    requestContext = {},
  ) => {
    const requestId = nextRequestId();
    const eligibleRearmRequestId = experienceLevelGuard
      ?.getPendingRearm?.()?.requestId ?? null;
    const persistentIntentRequired = Boolean(
      experienceLevelGuard
      && classification.kind !== "none"
      && readThresholdPercent() > 0
      && !UNINTERRUPTIBLE_TEAM_ORDER_IFACES.has(iface),
    );
    let persistentIntentStarted = false;
    let phase = "before-send";
    try {
      if (persistentIntentRequired) {
        try {
          experienceLevelGuard.beginProtectedAction({
            requestId,
            iface,
            actionArgs: arg,
            actionEvidence: requestContext?.experienceActionEvidence || null,
          });
          persistentIntentStarted = true;
        } catch (error) {
          throw annotateAutomationClassification(error, {
            category: "send-before",
            phase: "before-send",
            settlement: "not-sent",
            reason: "protected-intent-persist-failed",
            iface,
            requestId,
          });
        }
      }
      phase = "request-in-flight";
      const raw = await ws.request(iface, arg, token, requestContext);
      phase = "response-received";
      const merged = mergeSuccessfulResponse(
        iface,
        raw,
        classification,
        estimate,
        requestId,
        eligibleRearmRequestId,
      );
      if (merged?.businessRejected) {
        if (persistentIntentStarted) {
          experienceLevelGuard.completeProtectedAction({ requestId });
          persistentIntentStarted = false;
        }
        return raw;
      }
      await reconcilePendingSettlement({
        responseIface: iface,
        responseValue: merged?.rsp?.value ?? null,
        requestId,
      });
      let postActionVerification = Promise.resolve();
      if (
        persistentIntentStarted
        && merged?.evidence?.responseLevel == null
      ) {
        const verificationRequestId = nextRequestId();
        phase = "post-action-verification";
        postActionVerification = refreshExperienceGuardSync(
          ws,
          token,
          syncRef.current,
          "experienceGuardVerifyAfterAction",
          options.cycle ?? null,
          {
            requestId: verificationRequestId,
            onAudit: emitSettlementAudit,
            returnEvidence: true,
            thresholdPercent: readThresholdPercent(),
          },
        ).then((verification) => {
          syncRef.current = verification.syncValue;
          observePersistentAuthority(
            verification.evidence.responseLevel != null
              ? "post-action-authority-verification"
              : "post-action-authority-no-change-confirmed",
            verification.evidence,
            verificationRequestId,
          );
        });
      }
      // Keep the protocol spacing after the post-action authority refresh.
      // Starting the delay in parallel with lazySync lets the next team-order
      // mutation run immediately after a slow refresh, which can close the
      // socket while its protected settlement intent is still pending.
      await postActionVerification;
      phase = "complete-intent";
      await waitForTeamOrderActionLock(iface);
      if (persistentIntentStarted) {
        experienceLevelGuard.completeProtectedAction({ requestId });
        persistentIntentStarted = false;
      }
      return raw;
    } catch (error) {
      const businessRejected = isKnownBusinessRejection(error);
      if (businessRejected && persistentIntentStarted) {
        try {
          experienceLevelGuard.completeProtectedAction({ requestId });
          persistentIntentStarted = false;
        } catch (completionError) {
          annotateAutomationClassification(completionError, {
            category: "local-error",
            phase: "complete-intent",
            settlement: "unknown",
            reason: "business-rejection-intent-clear-failed",
            iface,
            requestId,
          });
        }
      }
      if (persistentIntentStarted) {
        const sessionExpired = isSessionExpired(error);
        const transportUnknown = isTransportUnknown(error);
        const transportRequestStarted = requestContext?.[TRANSPORT_REQUEST_STATE]?.started === true;
        const userStoppedBeforeSend = isUserStopped(error) && !transportRequestStarted;
        if (userStoppedBeforeSend) {
          try {
            experienceLevelGuard.cancelProtectedActionBeforeSend({
              requestId,
              reason: "user-stopped-before-send",
              message: error?.message || "用户停止",
            });
            persistentIntentStarted = false;
            annotateAutomationClassification(error, {
              category: "operator",
              phase: "before-send",
              settlement: "not-sent",
              reason: "user-stopped-before-send",
              iface,
              requestId,
            });
          } catch (cancellationError) {
            annotateAutomationClassification(error, {
              category: "local-error",
              phase: "cancel-before-send",
              settlement: "unknown",
              reason: "pre-send-cancellation-persist-failed",
              iface,
              requestId,
            });
            error.cancellationError = cancellationError;
          }
        }
        if (!userStoppedBeforeSend && persistentIntentStarted) {
          const category = phase === "post-action-verification"
          ? "post-action-verification-failed"
          : sessionExpired
            ? "session-expired"
            : transportUnknown || phase === "request-in-flight"
              ? "settlement-unknown"
              : "local-error";
          try {
            experienceLevelGuard.markProtectedActionUncertain({
              requestId,
              category,
              reason: category === "settlement-unknown"
                ? "request-settlement-unknown"
                : category,
              message: error?.message || String(error),
              phase,
            });
          } catch (persistenceError) {
            annotateAutomationClassification(persistenceError, {
              category: "local-error",
              phase: "persist-uncertainty",
              settlement: "unknown",
              reason: "uncertainty-persist-failed",
              iface,
              requestId,
            });
          }
          persistentIntentStarted = false;
          annotateAutomationClassification(error, {
            category,
            phase,
            settlement: "unknown",
            reason: category,
            iface,
            requestId,
          });
        }
      } else if (businessRejected) {
        annotateAutomationClassification(error, {
          category: "business-rejected",
          phase,
          settlement: "rejected",
          reason: "explicit-business-rejection",
          iface,
          requestId,
        });
      }
      if (["direct", "conditional"].includes(classification.kind)) {
        emitSettlementAudit(buildExperienceSettlementAudit({
          cycle: options.cycle ?? null,
          requestId,
          iface,
          settlementKind: classification.kind,
          estimate,
          evidence: parseExperienceSettlementEvidence(
            syncRef.current,
            null,
          ),
          experienceSource: "request-failed",
          conflict: false,
          conflictReason: null,
        }));
      }
      throw error;
    }
  };

  observePersistentAuthority(
    "account-session-start",
    null,
    null,
    options.initialAuthorityEligibleRearmRequestId ?? null,
  );

  return {
    ...ws,
    observeAuthoritativeSync(syncValue, source = "gateway-observe-sync", evidence = null) {
      syncRef.current = syncValue;
      return observePersistentAuthority(source, evidence);
    },
    async request(iface, arg, token = gsToken, requestContext = {}) {
      const classification = classifyAutomationExperienceInterface(iface);
      const uninterruptibleTeamOrder = UNINTERRUPTIBLE_TEAM_ORDER_IFACES.has(iface);
      const initialThresholdPercent = readThresholdPercent();
      const initialPendingRearm = experienceLevelGuard?.getPendingRearm?.() ?? null;
      if (!uninterruptibleTeamOrder) {
        throwInvalidPendingRearm(
          iface,
          classification,
          initialPendingRearm,
          initialThresholdPercent,
        );
      }
      const hasActionablePendingRearm = Boolean(
        initialPendingRearm
        && !initialPendingRearm.invalid
        && initialPendingRearm.requestId,
      );
      if (!uninterruptibleTeamOrder && !hasActionablePendingRearm) {
        throwPersistentLevelBreach(iface, classification, initialThresholdPercent);
      }
      if (uninterruptibleTeamOrder) {
        return requestAndMerge(iface, arg, token, classification, null, requestContext);
      }
      const activeTeamOrderReward =
        iface === "gs.orderTeam.recvRwd"
        && Number(syncRef.current?.orderTeamTot?.orderTeam?.status) === 3;
      if (classification.kind === "none") {
        return requestAndMerge(iface, arg, token, classification, null, requestContext);
      }
      if (classification.kind === "pending" && !hasActionablePendingRearm) {
        throwUnexpectedSettlement(iface, arg, initialThresholdPercent);
        return requestAndMerge(iface, arg, token, classification, null, requestContext);
      }

      return runExperienceExclusive(async () => {
        const thresholdPercent = readThresholdPercent();
        const thresholdPercentText = formatExperienceGuardThresholdPercent(thresholdPercent);
        const thresholdLabel = thresholdPercent > 0
          ? `${thresholdPercentText}%门槛`
          : "不设门槛";
        if (!activeTeamOrderReward) {
          throwUnexpectedSettlement(iface, arg, thresholdPercent);
        }
        let refreshResult;
        const refreshRequestId = nextRequestId();
        const refreshEligibleRearmRequestId = experienceLevelGuard
          ?.getPendingRearm?.()?.requestId ?? null;
        try {
          refreshResult = await refreshExperienceGuardSync(
            ws,
            token,
            syncRef.current,
            "experienceGuardRefreshBeforeAction",
            options.cycle ?? null,
            {
              requestId: refreshRequestId,
              onAudit: emitSettlementAudit,
              returnEvidence: true,
              thresholdPercent,
            },
          );
          syncRef.current = refreshResult.syncValue;
          if (
            refreshResult.evidence.responseLevel != null
            || refreshEligibleRearmRequestId
          ) {
            observePersistentAuthority(
              refreshResult.evidence.responseLevel != null
                ? "gs.usr.lazySync"
                : "gs.usr.lazySync-no-change-confirmed",
              refreshResult.evidence,
              refreshRequestId,
              refreshEligibleRearmRequestId,
            );
          }
        } catch (err) {
          const experienceGuard = {
            ...summarizeExperienceGuard(syncRef.current, { thresholdPercent }),
            blocked: true,
            reason: "authority-refresh-failed",
            reasonText: `权威经验刷新失败，已暂缓 ${iface}；未判定为经验保护线命中`,
          };
          const blockedEstimate = estimateExperienceAction({
            iface,
            arg,
            syncValue: syncRef.current,
            config: experienceConfig,
          });
          emitSettlementAudit(buildExperienceSettlementAudit({
            cycle: options.cycle ?? null,
            requestId: nextRequestId(),
            iface,
            settlementKind: classification.kind,
            estimate: blockedEstimate,
            evidence: parseExperienceSettlementEvidence(
              syncRef.current,
              null,
            ),
            experienceSource: "blocked-refresh-failed",
            conflict: false,
            conflictReason: null,
          }));
          logExperienceGuardActionSkip({
            cycle: options.cycle ?? null,
            action: options.action || "reward-action",
            iface,
            experienceGuard,
            error: err?.message || String(err),
          });
          const skip = new ExperienceActionBlockedError(experienceGuard);
          skip.iface = iface;
          skip.cause = err;
          throw skip;
        }
        throwPersistentLevelBreach(iface, classification, thresholdPercent, true);
        if (typeof options.validateActionAfterAuthorityRefresh === "function") {
          const validation = await options.validateActionAfterAuthorityRefresh({
            iface,
            arg,
            syncValue: syncRef.current,
            requestContext,
            cycle: options.cycle ?? null,
          });
          if (validation?.ok === false) {
            const rejected = new Error(
              validation.reasonText || validation.reason || "Action no longer matches the final authority snapshot",
            );
            rejected.code = "ACTION_AUTHORITY_REJECTED";
            rejected.iface = iface;
            rejected.authorityValidation = validation;
            // This is an authority/identity rejection before the protected
            // request starts; it must not be reported as an experience-guard
            // block or an unexpected settlement.
            throw rejected;
          }
        }
        if (classification.kind === "pending") {
          return requestAndMerge(iface, arg, token, classification, null, requestContext);
        }
        if (refreshResult.evidence.conflict && !activeTeamOrderReward) {
          const blockedEstimate = estimateExperienceAction({
            iface,
            arg,
            syncValue: syncRef.current,
            config: experienceConfig,
          });
          unexpectedSettlement = {
            requestId: refreshRequestId,
            iface: "gs.usr.lazySync",
            settlementKind: "authority-refresh",
            actualExpDelta: refreshResult.evidence.actualExpDelta,
            predictedMaxExp: null,
            reason: refreshResult.evidence.regression
              ? "experience-snapshot-regression"
              : "experience-evidence-conflict",
            conflict: true,
            conflictReason: refreshResult.evidence.conflictReason,
          };
          emitSettlementAudit(buildExperienceSettlementAudit({
            cycle: options.cycle ?? null,
            requestId: nextRequestId(),
            iface,
            settlementKind: classification.kind,
            estimate: blockedEstimate,
            evidence: refreshResult.evidence,
            experienceSource: "blocked-evidence-conflict",
            conflict: true,
            conflictReason: refreshResult.evidence.conflictReason,
          }));
          const experienceGuard = {
            ...summarizeExperienceGuard(syncRef.current, { thresholdPercent }),
            blocked: true,
            reason: refreshResult.evidence.regression
              ? "experience-snapshot-regression"
              : "experience-evidence-conflict",
            reasonText: refreshResult.evidence.regression
              ? `${iface} 执行前权威刷新出现同等级经验回退，已保留保护上界并跳过当前有经验动作`
              : `${iface} 执行前权威刷新出现经验响应冲突，已保留保护上界并跳过当前有经验动作`,
          };
          throw new ExperienceActionBlockedError(experienceGuard);
        }

        const estimate = estimateExperienceAction({
          iface,
          arg,
          syncValue: syncRef.current,
          config: experienceConfig,
        });
        if (activeTeamOrderReward) {
          return requestAndMerge(
            iface,
            arg,
            token,
            classification,
            estimate,
            requestContext,
          );
        }
        if (isAuthorizedTeamColdStartRequest(iface, requestContext)) {
          console.log(JSON.stringify({
            step: "teamOrderColdStartExperienceBypass",
            cycle: options.cycle ?? null,
            iface,
            reason: requestContext.teamTriggerDecision.reason,
            teamOrderReservationId:
              requestContext.teamTriggerDecision.teamOrderReservationId,
            predictedMaxExp: estimate.maxExp ?? null,
          }));
          return requestAndMerge(
            iface,
            arg,
            token,
            classification,
            estimate,
            requestContext,
          );
        }
        const accountLevel = summarizeAccountLevel(syncRef.current);
        const decision = evaluateExperienceAction({
          account: {
            known: accountLevel.currentExp != null && accountLevel.requiredExp != null,
            currentExp: accountLevel.currentExp,
            requiredExp: accountLevel.requiredExp,
          },
          estimate,
          thresholdPercent,
        });
        const summarizedGuard = summarizeExperienceGuard(syncRef.current, {
          stopped: decision.blocked,
          thresholdPercent,
        });
        const guard = {
          ...summarizedGuard,
          blocked: decision.blocked,
          reason: decision.reason,
          settlementKind: classification.kind,
          predictedMinExp: estimate.minExp,
          predictedMaxExp: estimate.maxExp,
          predictionSource: estimate.source,
          projectedExp: decision.projectedExp ?? null,
          thresholdPercent: decision.thresholdPercent ?? summarizedGuard.thresholdPercent,
          thresholdRemainingExp:
            decision.thresholdRemainingExp ?? summarizedGuard.thresholdRemainingExp,
          protectionLimitExp:
            decision.protectionLimitExp ?? summarizedGuard.protectionLimitExp,
          remainingToProtectionExp:
            decision.remainingToProtectionExp ?? summarizedGuard.remainingToProtectionExp,
          reasonText: decision.blocked
            ? `经验保护（${thresholdLabel}）：${iface} 预测经验上界 ${estimate.maxExp ?? "未知"}，距保护线 ${decision.remainingToProtectionExp ?? summarizedGuard.remainingToProtectionExp ?? "未知"}，已跳过当前有经验动作，无经验动作继续`
            : `经验保护（${thresholdLabel}）：${iface} 预测经验上界 ${estimate.maxExp}，距保护线 ${decision.remainingToProtectionExp ?? summarizedGuard.remainingToProtectionExp ?? "未知"}，经验空间充足`,
        };
        if (decision.blocked) {
          emitSettlementAudit(buildExperienceSettlementAudit({
            cycle: options.cycle ?? null,
            requestId: nextRequestId(),
            iface,
            settlementKind: classification.kind,
            estimate,
            evidence: parseExperienceSettlementEvidence(
              syncRef.current,
              null,
            ),
            experienceSource: "blocked-before-request",
            conflict: false,
            conflictReason: null,
          }));
          logExperienceGuardActionSkip({
            cycle: options.cycle ?? null,
            action: options.action || "reward-action",
            iface,
            experienceGuard: guard,
          });
          throw new ExperienceActionBlockedError(guard);
        }

        return requestAndMerge(iface, arg, token, classification, estimate, requestContext);
      });
    },
    getRateLimitState() {
      return rateLimitGuard.snapshot();
    },
    close() {
      return ws.close?.();
    },
  };
}
