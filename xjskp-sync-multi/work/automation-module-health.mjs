const MODULE_FAILURE_KEY = "__module__";

export function createAutomationModuleHealthRegistry({ now = Date.now } = {}) {
  const modules = new Map();

  function getModule(name) {
    const moduleName = String(name || "unknown");
    if (!modules.has(moduleName)) {
      modules.set(moduleName, {
        name: moduleName,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        consecutiveFailures: 0,
        lastError: null,
        failures: new Map(),
      });
    }
    return modules.get(moduleName);
  }

  function begin(name, { cycle = null } = {}) {
    const module = getModule(name);
    module.lastAttemptAt = toIso(now());
    module.lastCycle = cycle;
  }

  function success(name, { cycle = null, fingerprint = null } = {}) {
    const module = getModule(name);
    const at = toIso(now());
    module.lastAttemptAt = at;
    module.lastSuccessAt = at;
    module.lastCycle = cycle;
    if (fingerprint == null) module.failures.clear();
    else module.failures.delete(String(fingerprint));
    refreshFailureSummary(module);
    return serializeModule(module);
  }

  function failure(name, error, {
    cycle = null,
    fingerprint = null,
    backoffMs = 0,
  } = {}) {
    const module = getModule(name);
    const nowMs = Number(now());
    const at = toIso(nowMs);
    const key = fingerprint == null ? MODULE_FAILURE_KEY : String(fingerprint);
    const normalizedError = normalizeModuleError(error);
    const previous = module.failures.get(key);
    const entry = {
      fingerprint: fingerprint == null ? null : String(fingerprint),
      failedAt: at,
      cycle,
      consecutiveFailures: (previous?.consecutiveFailures || 0) + 1,
      nextRetryAt: Number(backoffMs) > 0 ? toIso(nowMs + Number(backoffMs)) : null,
      error: normalizedError,
    };
    module.failures.set(key, entry);
    module.lastAttemptAt = at;
    module.lastFailureAt = at;
    module.lastCycle = cycle;
    module.consecutiveFailures += 1;
    module.lastError = normalizedError;
    return serializeModule(module);
  }

  function canAttempt(name, fingerprint = null) {
    const module = modules.get(String(name || "unknown"));
    if (!module) return { allowed: true, nextRetryAt: null };
    const key = fingerprint == null ? MODULE_FAILURE_KEY : String(fingerprint);
    const failureEntry = module.failures.get(key) || module.failures.get(MODULE_FAILURE_KEY);
    if (!failureEntry?.nextRetryAt) return { allowed: true, nextRetryAt: null };
    const allowed = Number(now()) >= Date.parse(failureEntry.nextRetryAt);
    return {
      allowed,
      nextRetryAt: allowed ? null : failureEntry.nextRetryAt,
    };
  }

  function snapshot() {
    const serialized = Object.fromEntries(
      Array.from(modules.entries()).map(([name, module]) => [name, serializeModule(module)]),
    );
    const unhealthyCount = Object.values(serialized).filter((module) => module.status !== "healthy").length;
    return {
      status: unhealthyCount ? "degraded" : "healthy",
      unhealthyCount,
      modules: serialized,
    };
  }

  return { begin, success, failure, canAttempt, snapshot };
}

export function resolvePersistentCycleErrors({
  statusMode,
  currentErrors,
  previousErrors,
}) {
  if (Array.isArray(currentErrors)) return currentErrors;
  if (statusMode === "loop-refresh" && Array.isArray(previousErrors)) return previousErrors;
  return [];
}

function refreshFailureSummary(module) {
  const failures = Array.from(module.failures.values());
  if (!failures.length) {
    module.consecutiveFailures = 0;
    module.lastError = null;
    return;
  }
  const latest = failures.sort((a, b) => Date.parse(b.failedAt) - Date.parse(a.failedAt))[0];
  module.consecutiveFailures = failures.reduce((sum, item) => sum + item.consecutiveFailures, 0);
  module.lastError = latest.error;
}

function serializeModule(module) {
  const activeFailures = Array.from(module.failures.values()).map((entry) => ({ ...entry }));
  const nextRetryAt = activeFailures
    .map((entry) => entry.nextRetryAt)
    .filter(Boolean)
    .sort()[0] || null;
  return {
    name: module.name,
    status: activeFailures.length ? "degraded" : "healthy",
    lastCycle: module.lastCycle ?? null,
    lastAttemptAt: module.lastAttemptAt,
    lastSuccessAt: module.lastSuccessAt,
    lastFailureAt: module.lastFailureAt,
    consecutiveFailures: module.consecutiveFailures,
    lastError: module.lastError,
    nextRetryAt,
    activeFailures,
  };
}

function normalizeModuleError(error) {
  if (error && typeof error === "object") {
    const code = error.code == null ? null : String(error.code);
    return {
      code,
      message: String(error.message || (code ? `server-rejected:${code}` : "server-rejected")),
      ...(error.param && typeof error.param === "object" ? { param: sanitizeParams(error.param) } : {}),
    };
  }
  return {
    code: null,
    message: String(error?.message || error || "unknown-error"),
  };
}

function sanitizeParams(params) {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([, value]) => ["string", "number", "boolean"].includes(typeof value) || value == null)
      .map(([key, value]) => [key, value]),
  );
}

function toIso(value) {
  return new Date(Number(value)).toISOString();
}
