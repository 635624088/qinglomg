function finiteTime(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeInterval(value, fallback = 0) {
  return Math.max(0, finiteTime(value, fallback));
}

function isoTime(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function createModuleState(name, nowMs, intervalMs) {
  return {
    name,
    intervalMs: nonNegativeInterval(intervalMs),
    nextRunAtMs: nowMs,
    lastRunAtMs: null,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    lastOutcome: "pending",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
  };
}

export function createAccountScheduler({ accountId = null, nowFn = Date.now } = {}) {
  if (typeof nowFn !== "function") {
    throw new TypeError("AccountScheduler requires nowFn");
  }
  const modules = new Map();
  let authorityValue = null;
  let authorityRefreshedAtMs = null;
  let authorityRefreshCount = 0;
  let authorityInFlight = null;

  const readNow = (value) => finiteTime(value, finiteTime(nowFn(), Date.now()));
  const ensureModule = (name, intervalMs = 0, nowMs = readNow()) => {
    const key = String(name || "").trim();
    if (!key) throw new TypeError("AccountScheduler module name is required");
    let state = modules.get(key);
    if (!state) {
      state = createModuleState(key, nowMs, intervalMs);
      modules.set(key, state);
    } else if (intervalMs != null) {
      state.intervalMs = nonNegativeInterval(intervalMs, state.intervalMs);
    }
    return state;
  };

  const markRun = (name, {
    atMs = readNow(),
    intervalMs = null,
    nextRunAtMs = null,
    outcome = "success",
  } = {}) => {
    const runAtMs = readNow(atMs);
    const state = ensureModule(name, intervalMs, runAtMs);
    const nextIntervalMs = intervalMs == null
      ? state.intervalMs
      : nonNegativeInterval(intervalMs, state.intervalMs);
    state.intervalMs = nextIntervalMs;
    state.lastRunAtMs = runAtMs;
    state.runCount += 1;
    state.lastOutcome = outcome === "failure" ? "failure" : "success";
    if (state.lastOutcome === "failure") {
      state.failureCount += 1;
      state.lastFailureAtMs = runAtMs;
    } else {
      state.successCount += 1;
      state.lastSuccessAtMs = runAtMs;
    }
    state.nextRunAtMs = nextRunAtMs == null
      ? runAtMs + nextIntervalMs
      : Math.max(runAtMs, readNow(nextRunAtMs));
    return state;
  };

  const scheduler = {
    hasModule(name) {
      return modules.has(String(name || "").trim());
    },

    ensureModule(name, { intervalMs = 0, nowMs } = {}) {
      return ensureModule(name, intervalMs, readNow(nowMs));
    },

    isDue(name, { intervalMs = 0, nowMs } = {}) {
      const atMs = readNow(nowMs);
      return atMs >= ensureModule(name, intervalMs, atMs).nextRunAtMs;
    },

    dueInMs(name, { intervalMs = 0, nowMs } = {}) {
      const atMs = readNow(nowMs);
      return Math.max(0, ensureModule(name, intervalMs, atMs).nextRunAtMs - atMs);
    },

    markRun,

    defer(name, delayMs, { nowMs, intervalMs = null } = {}) {
      const atMs = readNow(nowMs);
      const state = ensureModule(name, intervalMs, atMs);
      state.nextRunAtMs = atMs + nonNegativeInterval(delayMs);
      return state.nextRunAtMs;
    },

    async runDue(name, {
      intervalMs = 0,
      retryIntervalMs = intervalMs,
      nowMs,
      force = false,
      task,
    } = {}) {
      if (typeof task !== "function") {
        throw new TypeError(`AccountScheduler module ${name} requires task`);
      }
      const atMs = readNow(nowMs);
      const state = ensureModule(name, intervalMs, atMs);
      if (!force && atMs < state.nextRunAtMs) {
        return {
          ran: false,
          value: undefined,
          nextRunAtMs: state.nextRunAtMs,
        };
      }
      try {
        const value = await task();
        markRun(name, { atMs, intervalMs, outcome: "success" });
        return {
          ran: true,
          value,
          nextRunAtMs: state.nextRunAtMs,
        };
      } catch (error) {
        markRun(name, {
          atMs,
          intervalMs,
          nextRunAtMs: atMs + nonNegativeInterval(retryIntervalMs, intervalMs),
          outcome: "failure",
        });
        throw error;
      }
    },

    observeAuthoritativeSnapshot(value) {
      if (value != null) authorityValue = value;
      return authorityValue;
    },

    async getAuthoritativeSnapshot({
      currentValue = null,
      intervalMs = 30_000,
      retryIntervalMs = Math.min(5000, intervalMs),
      nowMs,
      force = false,
      refresher,
    } = {}) {
      if (typeof refresher !== "function") {
        throw new TypeError("AccountScheduler authoritative snapshot requires refresher");
      }
      scheduler.observeAuthoritativeSnapshot(currentValue);
      if (authorityInFlight) return authorityInFlight;
      const atMs = readNow(nowMs);
      const state = ensureModule("authoritativeSnapshot", intervalMs, atMs);
      if (!force && atMs < state.nextRunAtMs) return authorityValue;

      authorityInFlight = (async () => {
        try {
          const nextValue = await refresher(authorityValue);
          scheduler.observeAuthoritativeSnapshot(nextValue);
          authorityRefreshedAtMs = atMs;
          authorityRefreshCount += 1;
          markRun("authoritativeSnapshot", {
            atMs,
            intervalMs,
            outcome: "success",
          });
          return authorityValue;
        } catch (error) {
          markRun("authoritativeSnapshot", {
            atMs,
            intervalMs,
            nextRunAtMs: atMs + nonNegativeInterval(retryIntervalMs, intervalMs),
            outcome: "failure",
          });
          throw error;
        } finally {
          authorityInFlight = null;
        }
      })();
      return authorityInFlight;
    },

    snapshot() {
      const moduleSnapshot = {};
      for (const [name, state] of Array.from(modules.entries()).sort(([a], [b]) => a.localeCompare(b))) {
        moduleSnapshot[name] = {
          intervalMs: state.intervalMs,
          nextRunAtMs: state.nextRunAtMs,
          nextRunAt: isoTime(state.nextRunAtMs),
          lastRunAtMs: state.lastRunAtMs,
          lastRunAt: isoTime(state.lastRunAtMs),
          lastSuccessAt: isoTime(state.lastSuccessAtMs),
          lastFailureAt: isoTime(state.lastFailureAtMs),
          lastOutcome: state.lastOutcome,
          runCount: state.runCount,
          successCount: state.successCount,
          failureCount: state.failureCount,
        };
      }
      return {
        accountId,
        modules: moduleSnapshot,
        authority: {
          refreshInFlight: authorityInFlight != null,
          refreshCount: authorityRefreshCount,
          lastRefreshedAtMs: authorityRefreshedAtMs,
          lastRefreshedAt: isoTime(authorityRefreshedAtMs),
        },
      };
    },
  };

  return Object.freeze(scheduler);
}
