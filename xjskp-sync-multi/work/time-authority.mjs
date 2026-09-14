const TIME_AUTHORITY_STATE_VERSION = 1;

// Official heartbeat boundary: RTT must be strictly below 1200 ms and the
// corrected sample must differ from the current business clock by at least
// 1000 ms before it replaces that clock.
export const OFFICIAL_HEART_SYNC_RTT_MAX_MS = 1_200;
export const OFFICIAL_HEART_SYNC_MIN_DELTA_MS = 1_000;

// The official bundle does not define sample expiry. The platform keeps the
// existing baseline for a bounded period and then falls back to local time.
export const DEFAULT_TIME_AUTHORITY_SAMPLE_MAX_AGE_MS = 2 * 60 * 1000;
export const TIME_AUTHORITY_STATE_KEY = "$timeAuthority";

const CLOCK_SOURCE_HARD_SYNC = "server-hard-sync";
const CLOCK_SOURCE_HEARTBEAT = "server-heartbeat-corrected";
// A low-delta heartbeat on a fresh authority proves that the local clock is
// already close enough to the server clock. It is deliberately distinct from
// an applied server-clock correction.
const CLOCK_SOURCE_HEARTBEAT_LOCAL_VALIDATED = "server-heartbeat-local-validated";
const CLOCK_SOURCE_RETAINED = "retained-server-baseline";
const CLOCK_SOURCE_LOCAL = "local-fallback";

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidServerTime(value) {
  return isFiniteNumber(value) && value > 0;
}

function resolveMaxAgeMs(value) {
  return isFiniteNumber(value) && value >= 0
    ? value
    : DEFAULT_TIME_AUTHORITY_SAMPLE_MAX_AGE_MS;
}

function normalizeSampleSource(source) {
  return source === CLOCK_SOURCE_HARD_SYNC
    ? CLOCK_SOURCE_HARD_SYNC
    : source === CLOCK_SOURCE_HEARTBEAT_LOCAL_VALIDATED
      ? CLOCK_SOURCE_HEARTBEAT_LOCAL_VALIDATED
      : CLOCK_SOURCE_HEARTBEAT;
}

function cloneAcceptedSample(sample) {
  if (!sample || typeof sample !== "object") return null;
  const fields = [
    "serverMs",
    "correctedServerMs",
    "requestStartedAtMs",
    "responseAtMs",
    "rttMs",
    "serverOffsetMs",
    "acceptedAtMs",
  ];
  if (!fields.every((field) => isFiniteNumber(sample[field]))) return null;
  if (sample.serverMs <= 0 || sample.rttMs < 0) return null;
  return {
    ...Object.fromEntries(fields.map((field) => [field, sample[field]])),
    source: normalizeSampleSource(sample.source),
    deltaMs: isFiniteNumber(sample.deltaMs) ? sample.deltaMs : null,
    // Low-delta heartbeats validate the retained official baseline without
    // applying their candidate server time as a new business-clock offset.
    lastValidatedAtMs: isFiniteNumber(sample.lastValidatedAtMs)
      ? sample.lastValidatedAtMs
      : sample.acceptedAtMs,
  };
}

function cloneLastAttempt(attempt) {
  if (!attempt || typeof attempt !== "object") return null;
  return {
    requestStartedAtMs: isFiniteNumber(attempt.requestStartedAtMs)
      ? attempt.requestStartedAtMs
      : null,
    responseAtMs: isFiniteNumber(attempt.responseAtMs) ? attempt.responseAtMs : null,
    rttMs: isFiniteNumber(attempt.rttMs) ? attempt.rttMs : null,
    serverMs: isValidServerTime(attempt.serverMs) ? attempt.serverMs : null,
    correctedServerMs: isFiniteNumber(attempt.correctedServerMs) ? attempt.correctedServerMs : null,
    referenceNowMs: isFiniteNumber(attempt.referenceNowMs) ? attempt.referenceNowMs : null,
    deltaMs: isFiniteNumber(attempt.deltaMs) ? attempt.deltaMs : null,
    source: typeof attempt.source === "string" ? attempt.source : null,
    decision: typeof attempt.decision === "string" ? attempt.decision : null,
    reason: typeof attempt.reason === "string" ? attempt.reason : null,
  };
}

function normalizeState(state, maxAgeMs) {
  const lastAcceptedSample = cloneAcceptedSample(state?.lastAcceptedSample);
  const serverOffsetMs = lastAcceptedSample?.serverOffsetMs ?? null;
  const rttMs = lastAcceptedSample?.rttMs ?? null;
  return {
    version: TIME_AUTHORITY_STATE_VERSION,
    lastAcceptedSample,
    lastAttempt: cloneLastAttempt(state?.lastAttempt),
    rttMs,
    serverOffsetMs,
    correctedNowMs: null,
    trusted: false,
    clockSource: CLOCK_SOURCE_LOCAL,
    rejectionReason: typeof state?.rejectionReason === "string"
      ? state.rejectionReason
      : (lastAcceptedSample ? null : "no-sample"),
    sampleAgeMs: null,
    sampleExpiresAtMs: null,
    sampleMaxAgeMs: maxAgeMs,
  };
}

function getActiveClockSource(state) {
  const source = normalizeSampleSource(state.lastAcceptedSample?.source);
  if (source === CLOCK_SOURCE_HEARTBEAT_LOCAL_VALIDATED) {
    return CLOCK_SOURCE_HEARTBEAT_LOCAL_VALIDATED;
  }
  const decision = state.lastAttempt?.decision;
  if (decision && decision !== "accepted" && decision !== "hard-sync-accepted") {
    return CLOCK_SOURCE_RETAINED;
  }
  return source;
}

function snapshotState(state, nowMs, maxAgeMs) {
  const sample = state.lastAcceptedSample;
  const hasValidNow = isFiniteNumber(nowMs);
  const validatedAtMs = sample?.lastValidatedAtMs ?? sample?.acceptedAtMs;
  const sampleAgeMs = sample && hasValidNow ? nowMs - validatedAtMs : null;
  const clockBeforeSample = sampleAgeMs != null && sampleAgeMs < 0;
  const expired = Boolean(
    sample
    && maxAgeMs != null
    && isFiniteNumber(sampleAgeMs)
    && sampleAgeMs >= maxAgeMs,
  );
  const trusted = Boolean(sample && hasValidNow && !clockBeforeSample && !expired);
  let rejectionReason = state.rejectionReason;
  if (!sample && !rejectionReason) rejectionReason = "no-sample";
  if (clockBeforeSample || !hasValidNow) rejectionReason = "invalid-clock";
  else if (expired) rejectionReason = "sample-expired";

  return {
    ...state,
    correctedNowMs: trusted ? nowMs + state.serverOffsetMs : null,
    trusted,
    clockSource: trusted ? getActiveClockSource(state) : CLOCK_SOURCE_LOCAL,
    rejectionReason,
    sampleAgeMs,
    sampleExpiresAtMs: sample && maxAgeMs != null
      ? validatedAtMs + maxAgeMs
      : null,
    sampleMaxAgeMs: maxAgeMs,
  };
}

function safeErrorReason(error) {
  return "heartbeat-failed";
}

function createAttempt({
  attempt,
  responseAtMs,
  serverMs = null,
  correctedServerMs = null,
  referenceNowMs = null,
  deltaMs = null,
  source = null,
  decision,
  reason,
}) {
  return {
    requestStartedAtMs: attempt?.requestStartedAtMs ?? null,
    responseAtMs: isFiniteNumber(responseAtMs) ? responseAtMs : null,
    rttMs: attempt && isFiniteNumber(responseAtMs)
      ? responseAtMs - attempt.requestStartedAtMs
      : null,
    serverMs: isValidServerTime(serverMs) ? serverMs : null,
    correctedServerMs: isFiniteNumber(correctedServerMs) ? correctedServerMs : null,
    referenceNowMs: isFiniteNumber(referenceNowMs) ? referenceNowMs : null,
    deltaMs: isFiniteNumber(deltaMs) ? deltaMs : null,
    source,
    decision,
    reason,
  };
}

export function createTimeAuthority({
  state = null,
  nowFn = Date.now,
  maxAgeMs: configuredMaxAgeMs = DEFAULT_TIME_AUTHORITY_SAMPLE_MAX_AGE_MS,
} = {}) {
  if (typeof nowFn !== "function") throw new TypeError("TimeAuthority requires nowFn");
  const maxAgeMs = resolveMaxAgeMs(configuredMaxAgeMs);
  const readNow = () => nowFn();
  let current = normalizeState(state, maxAgeMs);
  let pendingRequest = null;

  const rejectAttempt = (
    attempt,
    responseAtMs,
    decision,
    reason = decision,
    serverMs = null,
    extra = {},
  ) => {
    current = {
      ...current,
      lastAttempt: createAttempt({
        attempt,
        responseAtMs,
        serverMs,
        decision,
        reason,
        ...extra,
      }),
      rejectionReason: reason,
    };
    return snapshotState(current, responseAtMs, maxAgeMs);
  };

  return {
    beginHeartbeat(requestStartedAtMs = readNow()) {
      pendingRequest = isFiniteNumber(requestStartedAtMs)
        ? { requestStartedAtMs }
        : null;
      if (!pendingRequest) {
        current = {
          ...current,
          lastAttempt: createAttempt({
            attempt: null,
            responseAtMs: null,
            decision: "heartbeat-failed",
            reason: "invalid-request-time",
          }),
          rejectionReason: "invalid-request-time",
        };
      }
      return pendingRequest ? { ...pendingRequest } : null;
    },

    recordHeartbeat({ serverMs, responseAtMs = readNow() } = {}) {
      const attempt = pendingRequest;
      pendingRequest = null;
      if (!attempt) return rejectAttempt(null, responseAtMs, "heartbeat-failed", "no-pending-request", serverMs);
      if (!isFiniteNumber(responseAtMs)) {
        return rejectAttempt(attempt, responseAtMs, "heartbeat-failed", "invalid-response-time", serverMs);
      }

      const rttMs = responseAtMs - attempt.requestStartedAtMs;
      if (!isFiniteNumber(rttMs) || rttMs < 0) {
        return rejectAttempt(attempt, responseAtMs, "heartbeat-failed", "invalid-rtt", serverMs);
      }
      if (serverMs == null || serverMs === "") {
        return rejectAttempt(attempt, responseAtMs, "missing-server-time", "missing-server-time");
      }
      if (!isValidServerTime(serverMs)) {
        return rejectAttempt(attempt, responseAtMs, "heartbeat-failed", "invalid-server-time", serverMs);
      }
      if (rttMs >= OFFICIAL_HEART_SYNC_RTT_MAX_MS) {
        return rejectAttempt(attempt, responseAtMs, "rtt-too-high", "rtt-too-high", serverMs);
      }

      const correctedServerMs = serverMs + (rttMs / 2);
      const previousSnapshot = snapshotState(current, responseAtMs, maxAgeMs);
      const referenceNowMs = previousSnapshot.trusted
        ? previousSnapshot.correctedNowMs
        : responseAtMs;
      const deltaMs = Math.abs(correctedServerMs - referenceNowMs);
      if (!isFiniteNumber(correctedServerMs) || !isFiniteNumber(deltaMs)) {
        return rejectAttempt(attempt, responseAtMs, "heartbeat-failed", "invalid-server-time", serverMs, {
          correctedServerMs,
          referenceNowMs,
          deltaMs,
        });
      }
      if (deltaMs < OFFICIAL_HEART_SYNC_MIN_DELTA_MS) {
        const revalidateTrustedBaseline = previousSnapshot.trusted && current.lastAcceptedSample;
        const refreshFromExpiredBaseline = !revalidateTrustedBaseline && current.lastAcceptedSample;
        // The official client leaves its current clock untouched for a small
        // delta. With no historical sample, that same verified observation
        // establishes an auditable local-clock baseline with a zero offset.
        const serverOffsetMs = refreshFromExpiredBaseline
          ? correctedServerMs - responseAtMs
          : 0;
        const sampleSource = refreshFromExpiredBaseline
          ? CLOCK_SOURCE_HEARTBEAT
          : CLOCK_SOURCE_HEARTBEAT_LOCAL_VALIDATED;
        const attemptSource = revalidateTrustedBaseline
          ? CLOCK_SOURCE_HEARTBEAT
          : sampleSource;
        current = {
          ...current,
          // A small difference only means an already trusted clock needs no
          // correction. Once that baseline has expired, it cannot revive an
          // arbitrary historical offset: anchor a fresh sample to the current
          // server observation instead.
          lastAcceptedSample: revalidateTrustedBaseline
            ? {
              ...current.lastAcceptedSample,
              lastValidatedAtMs: responseAtMs,
            }
            : refreshFromExpiredBaseline
              ? {
              serverMs,
              correctedServerMs,
              requestStartedAtMs: attempt.requestStartedAtMs,
              responseAtMs,
              rttMs,
              serverOffsetMs,
              acceptedAtMs: responseAtMs,
              lastValidatedAtMs: responseAtMs,
              source: sampleSource,
              deltaMs,
              }
              : {
                serverMs,
                correctedServerMs,
                requestStartedAtMs: attempt.requestStartedAtMs,
                responseAtMs,
                rttMs,
                serverOffsetMs,
                acceptedAtMs: responseAtMs,
                lastValidatedAtMs: responseAtMs,
                source: sampleSource,
                deltaMs,
              },
          lastAttempt: createAttempt({
            attempt,
            responseAtMs,
            serverMs,
            correctedServerMs,
            referenceNowMs,
            deltaMs,
            source: attemptSource,
            decision: "no-correction-needed",
            reason: "no-correction-needed",
          }),
          rttMs,
          serverOffsetMs: revalidateTrustedBaseline
            ? current.serverOffsetMs
            : serverOffsetMs,
          rejectionReason: "no-correction-needed",
        };
        return snapshotState(current, responseAtMs, maxAgeMs);
      }

      const serverOffsetMs = correctedServerMs - responseAtMs;
      current = {
        ...current,
        lastAcceptedSample: {
          serverMs,
          correctedServerMs,
          requestStartedAtMs: attempt.requestStartedAtMs,
          responseAtMs,
          rttMs,
          serverOffsetMs,
          acceptedAtMs: responseAtMs,
          lastValidatedAtMs: responseAtMs,
          source: CLOCK_SOURCE_HEARTBEAT,
          deltaMs,
        },
        lastAttempt: createAttempt({
          attempt,
          responseAtMs,
          serverMs,
          correctedServerMs,
          referenceNowMs,
          deltaMs,
          source: CLOCK_SOURCE_HEARTBEAT,
          decision: "accepted",
          reason: null,
        }),
        rttMs,
        serverOffsetMs,
        rejectionReason: null,
      };
      return snapshotState(current, responseAtMs, maxAgeMs);
    },

    hardSync({ serverMs, requestStartedAtMs = readNow(), responseAtMs = readNow() } = {}) {
      if (!isFiniteNumber(responseAtMs)) {
        return rejectAttempt(
          isFiniteNumber(requestStartedAtMs) ? { requestStartedAtMs } : null,
          responseAtMs,
          "hard-sync-failed",
          "invalid-response-time",
          serverMs,
        );
      }
      if (!isValidServerTime(serverMs)) {
        return rejectAttempt(
          isFiniteNumber(requestStartedAtMs) ? { requestStartedAtMs } : null,
          responseAtMs,
          "hard-sync-failed",
          "invalid-server-time",
          serverMs,
        );
      }
      const startedAtMs = isFiniteNumber(requestStartedAtMs) ? requestStartedAtMs : responseAtMs;
      const rttMs = responseAtMs - startedAtMs;
      if (!isFiniteNumber(rttMs) || rttMs < 0) {
        return rejectAttempt(
          { requestStartedAtMs: startedAtMs },
          responseAtMs,
          "hard-sync-failed",
          "invalid-rtt",
          serverMs,
        );
      }
      const serverOffsetMs = serverMs - responseAtMs;
      current = {
        ...current,
        lastAcceptedSample: {
          serverMs,
          correctedServerMs: serverMs,
          requestStartedAtMs: startedAtMs,
          responseAtMs,
          rttMs,
          serverOffsetMs,
          acceptedAtMs: responseAtMs,
          lastValidatedAtMs: responseAtMs,
          source: CLOCK_SOURCE_HARD_SYNC,
          deltaMs: null,
        },
        lastAttempt: createAttempt({
          attempt: { requestStartedAtMs: startedAtMs },
          responseAtMs,
          serverMs,
          correctedServerMs: serverMs,
          source: CLOCK_SOURCE_HARD_SYNC,
          decision: "hard-sync-accepted",
          reason: null,
        }),
        rttMs,
        serverOffsetMs,
        rejectionReason: null,
      };
      return snapshotState(current, responseAtMs, maxAgeMs);
    },

    failHeartbeat(error = null, responseAtMs = readNow()) {
      const attempt = pendingRequest;
      pendingRequest = null;
      const reason = safeErrorReason(error);
      current = {
        ...current,
        lastAttempt: createAttempt({
          attempt,
          responseAtMs,
          decision: "heartbeat-failed",
          reason,
        }),
        rejectionReason: reason,
      };
      return snapshotState(current, responseAtMs, maxAgeMs);
    },

    snapshot(nowMs = readNow()) {
      return snapshotState(current, nowMs, maxAgeMs);
    },

    getState() {
      return snapshotState(current, readNow(), maxAgeMs);
    },
  };
}

export function getTimeAuthoritySnapshot(
  state,
  {
    nowMs = Date.now(),
    maxAgeMs = state?.sampleMaxAgeMs ?? DEFAULT_TIME_AUTHORITY_SAMPLE_MAX_AGE_MS,
  } = {},
) {
  const authority = createTimeAuthority({
    state,
    nowFn: () => nowMs,
    maxAgeMs,
  });
  return authority.snapshot(nowMs);
}

export function attachTimeAuthorityState(syncValue, state) {
  if (!syncValue || typeof syncValue !== "object") return syncValue;
  return {
    ...syncValue,
    [TIME_AUTHORITY_STATE_KEY]: state,
  };
}

export function attachHardSyncState(
  syncValue,
  {
    serverMs,
    requestStartedAtMs,
    responseAtMs = Date.now(),
    maxAgeMs = syncValue?.[TIME_AUTHORITY_STATE_KEY]?.sampleMaxAgeMs
      ?? DEFAULT_TIME_AUTHORITY_SAMPLE_MAX_AGE_MS,
  } = {},
) {
  if (!syncValue || typeof syncValue !== "object") return syncValue;
  const authority = createTimeAuthority({
    state: syncValue[TIME_AUTHORITY_STATE_KEY],
    nowFn: () => responseAtMs,
    maxAgeMs,
  });
  const state = authority.hardSync({
    serverMs,
    requestStartedAtMs,
    responseAtMs,
  });
  return state.lastAcceptedSample?.source === CLOCK_SOURCE_HARD_SYNC
    ? attachTimeAuthorityState(syncValue, state)
    : syncValue;
}
