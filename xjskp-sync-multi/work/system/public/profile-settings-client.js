import { createProfileSettingsTransactionState } from "./profile-settings-transaction-state.js";

const SETTINGS_PROTOCOL_VERSION = 2;
const COLLISION_ERROR = "PROFILE_ID_CANONICAL_COLLISION";
const INVALID_STATE_ERRORS = new Set([
  "PROFILE_SETTINGS_EPOCH_INVALID",
  "PROFILE_SETTINGS_REVISION_INVALID",
]);

function noop() {}

function snapshotFrom(data, protocolVersion = data?.settingsProtocolVersion) {
  const source = data?.settings ? data : data?.profile;
  if (!source) return null;
  return {
    settingsProtocolVersion: protocolVersion,
    settings: source.settings,
    settingsEpoch: source.settingsEpoch ?? data?.settingsEpoch,
    settingsRevision: source.settingsRevision ?? data?.settingsRevision,
    settingsKeyRevisions: source.settingsKeyRevisions ?? data?.settingsKeyRevisions,
  };
}

function mutationEvent(effect, response) {
  const status = Number(response?.status || 0);
  const data = response?.data || {};
  const base = {
    profileId: effect.profileId,
    transactionId: effect.transactionId,
    at: response?.at,
  };
  const declaresTransactionSemantics = Object.hasOwn(data, "transactionId")
    || Object.hasOwn(data, "commitState");
  const requiresCorrelation = declaresTransactionSemantics
    || (status >= 200 && status < 300)
    || (status === 400 && data.error === "INVALID_PROFILE_SETTINGS")
    || status === 404
    || status === 409
    || status === 503;
  if (
    requiresCorrelation
    && (
      data.transactionId !== effect.transactionId
      || (data.profile?.id && data.profile.id !== effect.profileId)
    )
  ) {
    return { ...base, type: "protocol-incompatible", reason: "mutation-response-correlation-mismatch" };
  }
  if (status >= 200 && status < 300) {
    return {
      ...base,
      type: "success",
      snapshot: snapshotFrom(data),
      applied: data.applied,
      commitState: data.commitState,
    };
  }
  if (status === 403 && data.error === "LOCAL_SESSION_TOKEN_INVALID") {
    return { ...base, type: "session-token-invalid" };
  }
  if (status === 404 && data.error === "PROFILE_NOT_FOUND") {
    return { ...base, type: "profile-missing" };
  }
  if (status === 409 && data.error === COLLISION_ERROR) {
    return { ...base, type: "blocked-canonical-collision", reason: data.error };
  }
  if (status === 409 && data.error === "PROFILE_SETTINGS_CONFLICT") {
    return { ...base, type: "conflict", snapshot: snapshotFrom(data) };
  }
  if (status === 428) {
    return { ...base, type: "protocol-incompatible", reason: data.error || "precondition-required" };
  }
  if (status === 503 && INVALID_STATE_ERRORS.has(data.error)) {
    return { ...base, type: "blocked-settings-state-invalid", reason: data.error };
  }
  if (status === 503 && (
    data.error === "PROFILE_SETTINGS_RUNTIME_DEGRADED"
    || data.error === "PROFILE_SETTINGS_RUNTIME_PUBLISH_FAILED"
  )) {
    return {
      ...base,
      type: "runtime-degraded",
      commitState: data.commitState,
      snapshot: snapshotFrom(data),
    };
  }
  return { ...base, type: "explicit-failure", reason: data.error || `HTTP ${status || "unknown"}` };
}

function reconcileEvent(effect, response) {
  const status = Number(response?.status || 0);
  const data = response?.data || {};
  const base = {
    profileId: effect.profileId,
    transactionId: effect.transactionId,
    reconcileAttemptId: effect.reconcileAttemptId,
    at: response?.at,
  };
  if (status >= 200 && status < 300) {
    return { ...base, type: "success", snapshot: snapshotFrom(data) };
  }
  if (status === 404 && data.error === "PROFILE_NOT_FOUND") {
    return { ...base, type: "profile-missing" };
  }
  if (status === 409 && data.error === COLLISION_ERROR) {
    return { ...base, type: "blocked-canonical-collision", reason: data.error };
  }
  if (status === 503 && INVALID_STATE_ERRORS.has(data.error)) {
    return { ...base, type: "blocked-settings-state-invalid", reason: data.error };
  }
  if (status === 503 && data.error === "PROFILE_SETTINGS_RUNTIME_DEGRADED") {
    return { ...base, type: "runtime-degraded", snapshot: snapshotFrom(data) };
  }
  if (status === 428) {
    return { ...base, type: "success", snapshot: snapshotFrom(data) };
  }
  return { ...base, type: "failure" };
}

export function createProfileSettingsClient({
  createTransactionId,
  now = () => Date.now(),
  sendMutation,
  sendReconcile,
  refreshSession = async () => {},
  setTimeoutFn = globalThis.setTimeout.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
  scheduleWakeFn = globalThis.setTimeout.bind(globalThis),
  clearWakeFn = globalThis.clearTimeout.bind(globalThis),
  createAbortController = () => new AbortController(),
  onChange = noop,
  onNotice = noop,
} = {}) {
  if (typeof sendMutation !== "function") throw new TypeError("sendMutation is required");
  if (typeof sendReconcile !== "function") throw new TypeError("sendReconcile is required");
  const transactionState = createProfileSettingsTransactionState({
    createTransactionId,
    now,
  });
  const pumps = new Map();
  const wakeTimers = new Map();
  const activeReconcileWaits = new Set();
  const contexts = new Map();
  const noticedTerminalTransactions = new Set();
  let sessionProtocolVersion = null;
  let disposed = false;

  function emitChange(profileId, changedKeys = []) {
    if (disposed) return;
    onChange({
      profileId,
      changedKeys: [...new Set(changedKeys)],
      state: transactionState.getProfileState(profileId),
    });
  }

  function transactionKeys(transactionId) {
    return Object.keys(transactionState.getTransaction(transactionId)?.patch || {});
  }

  function clearWake(profileId) {
    const timer = wakeTimers.get(profileId);
    if (!timer) return;
    wakeTimers.delete(profileId);
    clearWakeFn(timer.handle);
  }

  function scheduleWake(profileId) {
    clearWake(profileId);
    if (disposed || pumps.has(profileId)) return;
    const transaction = transactionState.getProfileState(profileId).inflightTransaction;
    if (!transaction || transaction.isTerminal || transaction.nextReconcileAt == null) return;
    const delay = Math.max(0, transaction.nextReconcileAt - now());
    const timer = { handle: null };
    timer.handle = scheduleWakeFn(() => {
      if (wakeTimers.get(profileId) !== timer) return;
      wakeTimers.delete(profileId);
      if (!disposed) return schedulePump(profileId);
    }, delay);
    timer.handle?.unref?.();
    wakeTimers.set(profileId, timer);
  }

  function noticeIfTerminal(transactionId) {
    const transaction = transactionState.getTransaction(transactionId);
    if (!transaction?.isTerminal || noticedTerminalTransactions.has(transactionId)) return;
    noticedTerminalTransactions.add(transactionId);
    const context = contexts.get(transactionId) || {};
    onNotice({ profileId: transaction.profileId, transaction, context });
    contexts.delete(transactionId);
  }

  function setSessionProtocolVersion(version) {
    sessionProtocolVersion = version;
    const compatible = transactionState.setProtocolVersion(version);
    return compatible;
  }

  function applyProfilesResponse(response = {}) {
    const protocolVersion = response.settingsProtocolVersion;
    const projected = [];
    for (const item of Array.isArray(response.profiles) ? response.profiles : []) {
      if (!item?.id) continue;
      const profileId = item.id;
      if (protocolVersion !== SETTINGS_PROTOCOL_VERSION) {
        transactionState.blockProfile(profileId, "protocol-incompatible");
      } else if (item.settingsStateError === COLLISION_ERROR) {
        transactionState.blockProfile(profileId, "blocked-canonical-collision");
      } else if (INVALID_STATE_ERRORS.has(item.settingsStateError)) {
        transactionState.blockProfile(profileId, "blocked-settings-state-invalid");
      } else {
        transactionState.applyRefresh(profileId, snapshotFrom(item, protocolVersion));
        if (item.runtimeSyncStatus === "degraded") {
          transactionState.blockProfile(profileId, "blocked-runtime-degraded");
        }
      }
      const effectiveSettings = transactionState.getEffectiveSettings(profileId);
      projected.push({
        ...item,
        ...(effectiveSettings ? { settings: effectiveSettings } : { settings: null }),
      });
      emitChange(profileId);
      scheduleWake(profileId);
      for (const transactionId of contexts.keys()) noticeIfTerminal(transactionId);
    }
    return projected;
  }

  function enqueue(profileId, patch, context = {}) {
    const transaction = transactionState.enqueue(profileId, patch);
    contexts.set(transaction.transactionId, { ...context });
    emitChange(profileId, Object.keys(transaction.patch));
    schedulePump(profileId);
    return transaction;
  }

  async function runMutation(effect) {
    let response;
    try {
      response = await sendMutation(effect);
    } catch (error) {
      transactionState.markNetworkUnknown(effect.profileId, effect.transactionId, {
        at: now(),
        reason: "network-unknown",
      });
      emitChange(effect.profileId, Object.keys(effect.patch || {}));
      return;
    }
    const event = mutationEvent(effect, response);
    const result = transactionState.applyMutationResult(event);
    emitChange(effect.profileId, Object.keys(effect.patch || {}));
    if (result.classification === "session-token-retry") {
      try {
        await refreshSession();
      } catch {
        transactionState.applyMutationResult({
          type: "explicit-failure",
          profileId: effect.profileId,
          transactionId: effect.transactionId,
          reason: "session-refresh-failed",
          at: now(),
        });
        emitChange(effect.profileId, Object.keys(effect.patch || {}));
      }
    }
    noticeIfTerminal(effect.transactionId);
  }

  async function waitForReconcile(effect) {
    const abortController = createAbortController();
    const activeWait = { abortController, timer: null };
    const timeout = new Promise((resolve) => {
      activeWait.timer = setTimeoutFn(() => {
        abortController.abort();
        resolve({ timeout: true });
      }, effect.timeoutMs);
    });
    activeReconcileWaits.add(activeWait);
    try {
      return await Promise.race([
        Promise.resolve(sendReconcile(effect, { signal: abortController.signal }))
          .then((response) => ({ response }), (error) => ({ error })),
        timeout,
      ]);
    } finally {
      activeReconcileWaits.delete(activeWait);
      if (activeWait.timer !== null) clearTimeoutFn(activeWait.timer);
    }
  }

  async function runReconcile(effect) {
    const changedKeys = transactionKeys(effect.transactionId);
    const outcome = await waitForReconcile(effect);
    if (outcome.timeout) {
      transactionState.applyReconcileResult({
        type: "timeout",
        profileId: effect.profileId,
        transactionId: effect.transactionId,
        reconcileAttemptId: effect.reconcileAttemptId,
        at: now(),
      });
    } else if (outcome.error) {
      transactionState.applyReconcileResult({
        type: "failure",
        profileId: effect.profileId,
        transactionId: effect.transactionId,
        reconcileAttemptId: effect.reconcileAttemptId,
        at: now(),
      });
    } else {
      transactionState.applyReconcileResult(reconcileEvent(effect, outcome.response));
    }
    emitChange(effect.profileId, changedKeys);
    noticeIfTerminal(effect.transactionId);
  }

  async function runPump(profileId, options = {}) {
    let manualReconcile = options.manualReconcile === true;
    for (;;) {
      const effect = transactionState.takeNextEffect(profileId, {
        at: now(),
        manualReconcile,
      });
      manualReconcile = false;
      if (!effect) return;
      emitChange(
        profileId,
        effect.type === "mutation" ? Object.keys(effect.patch || {}) : transactionKeys(effect.transactionId),
      );
      if (effect.type === "mutation") await runMutation(effect);
      else await runReconcile(effect);
    }
  }

  function schedulePump(profileId, options = {}) {
    if (disposed) return Promise.resolve();
    if (pumps.has(profileId)) return pumps.get(profileId);
    clearWake(profileId);
    const promise = runPump(profileId, options)
      .finally(() => {
        pumps.delete(profileId);
        scheduleWake(profileId);
      });
    pumps.set(profileId, promise);
    return promise;
  }

  function pump(profileId) {
    return schedulePump(profileId);
  }

  function pumpDue(profileIds) {
    return Promise.all((profileIds || []).map((profileId) => schedulePump(profileId)));
  }

  function manualReconcile(profileId) {
    return schedulePump(profileId, { manualReconcile: true });
  }

  async function resolve(profileId, transactionId, decision) {
    const context = contexts.get(transactionId) || {};
    if (decision === "reapply") {
      const confirmed = typeof context.reconfirm === "function"
        ? await context.reconfirm()
        : true;
      if (!confirmed) return null;
      const replacement = transactionState.resolve(profileId, transactionId, "reapply", {
        businessConfirmed: true,
      });
      contexts.delete(transactionId);
      noticedTerminalTransactions.add(transactionId);
      contexts.set(replacement.transactionId, context);
      emitChange(profileId, Object.keys(replacement.patch || {}));
      schedulePump(profileId);
      return replacement;
    }
    const result = transactionState.resolve(profileId, transactionId, decision);
    noticeIfTerminal(transactionId);
    emitChange(profileId, transactionKeys(transactionId));
    schedulePump(profileId);
    return result;
  }

  function getProfileState(profileId) {
    return transactionState.getProfileState(profileId);
  }

  function getEffectiveSettings(profileId) {
    return transactionState.getEffectiveSettings(profileId);
  }

  function getTransaction(transactionId) {
    return transactionState.getTransaction(transactionId);
  }

  function isProtocolCompatible() {
    return sessionProtocolVersion === SETTINGS_PROTOCOL_VERSION;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const profileId of [...wakeTimers.keys()]) clearWake(profileId);
    for (const activeWait of activeReconcileWaits) {
      if (activeWait.timer !== null) clearTimeoutFn(activeWait.timer);
      activeWait.abortController.abort();
    }
    activeReconcileWaits.clear();
  }

  return Object.freeze({
    applyProfilesResponse,
    dispose,
    enqueue,
    getEffectiveSettings,
    getProfileState,
    getTransaction,
    isProtocolCompatible,
    manualReconcile,
    pump,
    pumpDue,
    resolve,
    setSessionProtocolVersion,
  });
}
