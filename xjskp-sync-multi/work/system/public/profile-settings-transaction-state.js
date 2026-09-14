export const PROFILE_SETTINGS_CANONICAL_KEYS = Object.freeze([
  "autoReceiveWaterwheelBuckets",
  "skipWaterwheelVideoBuckets",
  "autoSubmitOrdinaryResidentOrdersForLevelUp",
  "autoSubmitCyclicStoryOrders",
  "cyclicStoryOnlyHighestExperienceOrder",
  "autoHandleCyclicNote",
  "autoCompleteCyclicNoteHighestRewardTask",
  "customerOrderFlowerCurrencyRewardReleaseMask",
  "experienceGuardThresholdPercent",
  "flowerRackTargetArtId",
  "materialShopMidnightRefreshEnabled",
  "materialShopRefreshWindowStart",
  "materialShopRefreshMaxCostYuanbao",
  "pearlHireItemReserveCount",
  "teamOrderTriggerProtectionEnabled",
  "teamOrderPaidRenewProtectionEnabled",
  "teamOrderGuardMultiplier",
]);

const PROTOCOL_VERSION = 2;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const RECONCILE_DELAYS_MS = Object.freeze([5_000, 15_000, 60_000]);
const RECONCILE_TIMEOUT_MS = 10_000;
const MANUAL_RECONCILE_DEBOUNCE_MS = 30_000;
const MAX_AUTOMATIC_RECONCILE_ATTEMPTS = 4;
const MAX_CAS_REBASE_COUNT = 3;
const RECONCILABLE_STATUSES = new Set([
  "confirming",
  "blocked-runtime-degraded",
  "profile-committed-runtime-degraded",
]);
const REPAIRABLE_BLOCK_STATES = new Set([
  "blocked-canonical-collision",
  "blocked-settings-state-invalid",
]);
const BLOCK_STATES = new Set([
  ...REPAIRABLE_BLOCK_STATES,
  "blocked-runtime-degraded",
  "protocol-incompatible",
  "profile-missing",
]);

function clone(value) {
  if (value == null) return value;
  return globalThis.structuredClone(value);
}

function isPlainObject(value) {
  return value != null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertProfileId(profileId) {
  if (typeof profileId !== "string" || profileId.length === 0) {
    throw new TypeError("profileId must be a non-empty string");
  }
}

export function createDefaultTransactionId({
  cryptoProvider = globalThis.crypto,
  now = () => Date.now(),
  random = () => Math.random(),
} = {}) {
  const randomUUID = cryptoProvider?.randomUUID;
  if (typeof randomUUID === "function") return randomUUID.call(cryptoProvider);
  // Transaction IDs are correlation values, not credentials. Older embedded
  // Chromium runtimes can lack crypto.randomUUID(), so keep settings writes
  // available with time plus independent local entropy.
  const timePart = Math.max(0, Number(now()) || 0).toString(36);
  const randomPart = Math.abs(Number(random()) || 0).toString(36).slice(2).padEnd(12, "0");
  return `tx-${timePart}-${randomPart}`;
}

function normalizePatch(patch) {
  if (!isPlainObject(patch) || Object.keys(patch).length === 0) {
    throw new TypeError("profile settings patch must be a non-empty object");
  }
  const normalized = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!PROFILE_SETTINGS_CANONICAL_KEYS.includes(key)) {
      throw new TypeError(`profile settings patch contains a non-canonical key: ${key}`);
    }
    normalized[key] = clone(value);
  }
  return normalized;
}

function validateSnapshot(input) {
  if (!isPlainObject(input) || input.settingsProtocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, error: "settings protocol version is missing or incompatible" };
  }
  if (!isPlainObject(input.settings)) {
    return { ok: false, error: "settings snapshot is missing settings" };
  }
  if (!UUID_V4_PATTERN.test(input.settingsEpoch || "")) {
    return { ok: false, error: "settings snapshot has an invalid epoch" };
  }
  if (!Number.isSafeInteger(input.settingsRevision) || input.settingsRevision < 0) {
    return { ok: false, error: "settings snapshot has an invalid revision" };
  }
  if (!isPlainObject(input.settingsKeyRevisions)) {
    return { ok: false, error: "settings snapshot is missing key revisions" };
  }

  const settings = {};
  const settingsKeyRevisions = {};
  for (const key of PROFILE_SETTINGS_CANONICAL_KEYS) {
    if (!Object.hasOwn(input.settings, key)) {
      return { ok: false, error: `settings snapshot is missing canonical key: ${key}` };
    }
    const keyRevision = input.settingsKeyRevisions[key];
    if (!Number.isSafeInteger(keyRevision) || keyRevision < 0 || keyRevision > input.settingsRevision) {
      return { ok: false, error: `settings snapshot has an invalid key revision: ${key}` };
    }
    settings[key] = clone(input.settings[key]);
    settingsKeyRevisions[key] = keyRevision;
  }

  return {
    ok: true,
    snapshot: {
      settingsProtocolVersion: PROTOCOL_VERSION,
      settings,
      settingsEpoch: input.settingsEpoch,
      settingsRevision: input.settingsRevision,
      settingsKeyRevisions,
    },
  };
}

function snapshotsEqual(profile, snapshot) {
  for (const key of PROFILE_SETTINGS_CANONICAL_KEYS) {
    if (!Object.is(profile.confirmedSettings[key], snapshot.settings[key])) return false;
    if (profile.settingsKeyRevisions[key] !== snapshot.settingsKeyRevisions[key]) return false;
  }
  return true;
}

function desiredIsSatisfied(settings, patch) {
  return Object.entries(patch).every(([key, desired]) => Object.is(settings[key], desired));
}

function isInconsistentSnapshot(result) {
  return result.classification === "same-revision-mismatch"
    || result.classification === "key-revision-mismatch";
}

function createProfile(profileId) {
  return {
    profileId,
    confirmedSettings: null,
    settingsEpoch: null,
    settingsRevision: null,
    settingsKeyRevisions: null,
    authority: "unavailable",
    readState: "unavailable",
    blockState: null,
    blockReason: null,
    inflightTransaction: null,
    queuedTransactions: [],
    reconcileState: null,
    reconcileAttemptSequence: 0,
    localKeyRevisionOwners: new Map(),
  };
}

export function createProfileSettingsTransactionState({
  createTransactionId = createDefaultTransactionId,
  now = () => Date.now(),
  settingsProtocolVersion,
} = {}) {
  if (typeof createTransactionId !== "function") {
    throw new TypeError("createTransactionId must be a function");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const profiles = new Map();
  const transactions = new Map();
  const usedTransactionIds = new Set();
  let createdSequence = 0;
  let sessionProtocolVersion = settingsProtocolVersion ?? null;

  function ensureProfile(profileId) {
    assertProfileId(profileId);
    if (!profiles.has(profileId)) profiles.set(profileId, createProfile(profileId));
    return profiles.get(profileId);
  }

  function getEffectiveSettingsInternal(profile) {
    if (!profile.confirmedSettings) return null;
    const effective = { ...profile.confirmedSettings };
    if (profile.inflightTransaction && !profile.inflightTransaction.isTerminal) {
      Object.assign(effective, profile.inflightTransaction.patch);
    }
    for (const transaction of [...profile.queuedTransactions]
      .sort((left, right) => left.createdSequence - right.createdSequence)) {
      if (!transaction.isTerminal) Object.assign(effective, transaction.patch);
    }
    return effective;
  }

  function resetReconcile(profile, transactionId) {
    if (profile.reconcileState?.transactionId === transactionId) {
      profile.reconcileState = null;
    }
  }

  function finishTransaction(profile, transaction, status, reason = null, endedAt = now()) {
    if (!transaction || transaction.isTerminal) return transaction;
    transaction.status = status;
    transaction.reason = reason;
    transaction.isTerminal = true;
    transaction.terminalResult = status;
    transaction.endedAt = endedAt;
    if (profile.inflightTransaction?.transactionId === transaction.transactionId) {
      profile.inflightTransaction = null;
    }
    profile.queuedTransactions = profile.queuedTransactions.filter(
      (candidate) => candidate.transactionId !== transaction.transactionId,
    );
    resetReconcile(profile, transaction.transactionId);
    return transaction;
  }

  function terminateProfileTransactions(profile, status, reason = null, endedAt = now()) {
    const active = [profile.inflightTransaction, ...profile.queuedTransactions].filter(Boolean);
    for (const transaction of active) {
      finishTransaction(profile, transaction, status, reason, endedAt);
    }
  }

  function setBlock(profile, blockState, { transaction = null, reason = blockState } = {}) {
    if (!BLOCK_STATES.has(blockState)) throw new TypeError(`unsupported block state: ${blockState}`);
    profile.blockState = blockState;
    profile.blockReason = reason;
    profile.readState = blockState;
    profile.authority = profile.confirmedSettings ? "stale" : "unavailable";
    if (transaction && !transaction.isTerminal) {
      if (transaction.status !== blockState) {
        transaction.statusBeforeBlock = transaction.status;
        transaction.reasonBeforeBlock = transaction.reason;
      }
      transaction.status = blockState;
      transaction.reason = reason;
    }
  }

  function clearRepairableBlock(profile) {
    if (
      REPAIRABLE_BLOCK_STATES.has(profile.blockState)
      || (profile.blockState === "protocol-incompatible" && sessionProtocolVersion === PROTOCOL_VERSION)
    ) {
      profile.blockState = null;
      profile.blockReason = null;
    }
    if (profile.blockState) {
      profile.readState = profile.blockState;
      profile.authority = profile.confirmedSettings ? "stale" : "unavailable";
      return;
    }
    profile.readState = "ready";
    profile.authority = "authoritative";
  }

  function switchEpoch(profile, nextSnapshot, reason = "authoritative-new-epoch") {
    terminateProfileTransactions(profile, "profile-recreated", reason);
    profile.confirmedSettings = { ...nextSnapshot.settings };
    profile.settingsEpoch = nextSnapshot.settingsEpoch;
    profile.settingsRevision = nextSnapshot.settingsRevision;
    profile.settingsKeyRevisions = { ...nextSnapshot.settingsKeyRevisions };
    profile.localKeyRevisionOwners.clear();
    profile.blockState = null;
    profile.blockReason = null;
    profile.readState = "ready";
    profile.authority = "authoritative";
  }

  function applySnapshot(profile, input, { canUnblock = false } = {}) {
    const validated = validateSnapshot(input);
    if (!validated.ok) {
      return { applied: false, classification: "protocol-incompatible", error: validated.error };
    }
    const nextSnapshot = validated.snapshot;
    if (!profile.confirmedSettings) {
      profile.confirmedSettings = { ...nextSnapshot.settings };
      profile.settingsEpoch = nextSnapshot.settingsEpoch;
      profile.settingsRevision = nextSnapshot.settingsRevision;
      profile.settingsKeyRevisions = { ...nextSnapshot.settingsKeyRevisions };
      profile.authority = "authoritative";
      profile.readState = "ready";
      if (canUnblock) clearRepairableBlock(profile);
      return { applied: true, classification: "initialized", snapshot: nextSnapshot };
    }

    if (nextSnapshot.settingsEpoch !== profile.settingsEpoch) {
      switchEpoch(profile, nextSnapshot);
      return { applied: true, classification: "profile-recreated", snapshot: nextSnapshot };
    }
    if (nextSnapshot.settingsRevision < profile.settingsRevision) {
      return { applied: false, classification: "older", snapshot: nextSnapshot };
    }
    if (nextSnapshot.settingsRevision === profile.settingsRevision) {
      if (!snapshotsEqual(profile, nextSnapshot)) {
        profile.readState = "degraded";
        return { applied: false, classification: "same-revision-mismatch", snapshot: nextSnapshot };
      }
      if (canUnblock) clearRepairableBlock(profile);
      return { applied: false, classification: "idempotent", snapshot: nextSnapshot };
    }

    for (const key of PROFILE_SETTINGS_CANONICAL_KEYS) {
      const previousKeyRevision = profile.settingsKeyRevisions[key];
      const nextKeyRevision = nextSnapshot.settingsKeyRevisions[key];
      if (
        nextKeyRevision < previousKeyRevision
        || (!Object.is(profile.confirmedSettings[key], nextSnapshot.settings[key])
          && nextKeyRevision <= previousKeyRevision)
      ) {
        profile.readState = "degraded";
        return { applied: false, classification: "key-revision-mismatch", snapshot: nextSnapshot };
      }
    }

    profile.confirmedSettings = { ...nextSnapshot.settings };
    profile.settingsRevision = nextSnapshot.settingsRevision;
    profile.settingsKeyRevisions = { ...nextSnapshot.settingsKeyRevisions };
    profile.authority = "authoritative";
    profile.readState = "ready";
    if (canUnblock) clearRepairableBlock(profile);
    return { applied: true, classification: "advanced", snapshot: nextSnapshot };
  }

  function recordLocalOwners(profile, transaction, responseSnapshot, applied) {
    if (!applied || responseSnapshot.settingsEpoch !== transaction.expectedEpoch) return;
    for (const [key, desired] of Object.entries(transaction.patch)) {
      const responseKeyRevision = responseSnapshot.settingsKeyRevisions[key];
      const sendKeyRevision = transaction.sendBaseKeyRevisions?.[key];
      if (
        Object.is(responseSnapshot.settings[key], desired)
        && Number.isSafeInteger(sendKeyRevision)
        && responseKeyRevision > sendKeyRevision
      ) {
        if (!profile.localKeyRevisionOwners.has(key)) {
          profile.localKeyRevisionOwners.set(key, new Map());
        }
        profile.localKeyRevisionOwners.get(key).set(responseKeyRevision, transaction.transactionId);
      }
    }
  }

  function isRevisionCausallySafe(profile, transaction, key) {
    const currentRevision = profile.settingsKeyRevisions[key];
    if (currentRevision === transaction.intentBaseKeyRevisions[key]) return true;
    const owner = profile.localKeyRevisionOwners.get(key)?.get(currentRevision);
    return Boolean(owner && transaction.predecessorTransactionIds.includes(owner));
  }

  function prepareQueuedTransaction(profile, transaction) {
    if (profile.settingsEpoch !== transaction.createdBaseEpoch) {
      finishTransaction(profile, transaction, "profile-recreated", "created-epoch-is-stale");
      return "finished";
    }

    const residual = {};
    for (const [key, desired] of Object.entries(transaction.patch)) {
      if (Object.is(profile.confirmedSettings[key], desired)) continue;
      if (!isRevisionCausallySafe(profile, transaction, key)) {
        transaction.status = "conflict";
        transaction.reason = "external-change";
        return "blocked";
      }
      residual[key] = desired;
    }

    if (Object.keys(residual).length === 0) {
      finishTransaction(profile, transaction, "satisfied", "already-satisfied");
      return "finished";
    }

    transaction.patch = residual;
    transaction.expectedEpoch = profile.settingsEpoch;
    transaction.expectedRevision = profile.settingsRevision;
    transaction.sendBaseValues = Object.fromEntries(
      Object.keys(residual).map((key) => [key, clone(profile.confirmedSettings[key])]),
    );
    transaction.sendBaseKeyRevisions = Object.fromEntries(
      Object.keys(residual).map((key) => [key, profile.settingsKeyRevisions[key]]),
    );
    transaction.status = "ready";
    transaction.reason = null;
    return "ready";
  }

  function makeMutationEffect(transaction) {
    return {
      type: "mutation",
      profileId: transaction.profileId,
      transactionId: transaction.transactionId,
      patch: clone(transaction.patch),
      settingsEpoch: transaction.expectedEpoch,
      settingsRevision: transaction.expectedRevision,
      ifMatch: `"${transaction.expectedEpoch}:${transaction.expectedRevision}"`,
      sendBaseValues: clone(transaction.sendBaseValues),
      sendBaseKeyRevisions: clone(transaction.sendBaseKeyRevisions),
      timeoutMs: null,
    };
  }

  function ensureReconcileState(profile, transaction, at) {
    if (profile.reconcileState?.transactionId !== transaction.transactionId) {
      profile.reconcileState = {
        transactionId: transaction.transactionId,
        active: false,
        activeAttempt: null,
        activeAttemptId: null,
        activeManual: false,
        lastManualStartedAt: transaction.lastManualReconcileStartedAt,
      };
    }
    if (transaction.nextReconcileAt == null && transaction.automaticReconcileAttemptCount === 0) {
      transaction.nextReconcileAt = at;
    }
    return profile.reconcileState;
  }

  function scheduleReconcileAfterSettle(transaction, settledAt) {
    const completed = transaction.automaticReconcileAttemptCount;
    transaction.nextReconcileAt = completed < MAX_AUTOMATIC_RECONCILE_ATTEMPTS
      ? settledAt + RECONCILE_DELAYS_MS[completed - 1]
      : null;
  }

  function takeReconcileEffect(profile, at, manual) {
    const transaction = profile.inflightTransaction;
    if (!transaction || transaction.isTerminal || !RECONCILABLE_STATUSES.has(transaction.status)) return null;
    if (profile.blockState && profile.blockState !== "blocked-runtime-degraded") return null;
    const reconcile = ensureReconcileState(profile, transaction, at);
    if (reconcile.active) return null;

    if (manual) {
      if (
        transaction.lastManualReconcileStartedAt != null
        && at - transaction.lastManualReconcileStartedAt < MANUAL_RECONCILE_DEBOUNCE_MS
      ) {
        return null;
      }
      reconcile.active = true;
      reconcile.activeManual = true;
      reconcile.activeAttempt = null;
      reconcile.activeAttemptId = ++profile.reconcileAttemptSequence;
      reconcile.lastManualStartedAt = at;
      transaction.lastManualReconcileStartedAt = at;
      return {
        type: "reconcile",
        profileId: profile.profileId,
        transactionId: transaction.transactionId,
        attempt: null,
        reconcileAttemptId: reconcile.activeAttemptId,
        manual: true,
        timeoutMs: RECONCILE_TIMEOUT_MS,
      };
    }

    if (
      transaction.automaticReconcileAttemptCount >= MAX_AUTOMATIC_RECONCILE_ATTEMPTS
      || transaction.nextReconcileAt == null
      || at < transaction.nextReconcileAt
    ) {
      return null;
    }
    transaction.automaticReconcileAttemptCount += 1;
    transaction.nextReconcileAt = null;
    reconcile.active = true;
    reconcile.activeManual = false;
    reconcile.activeAttempt = transaction.automaticReconcileAttemptCount;
    reconcile.activeAttemptId = ++profile.reconcileAttemptSequence;
    return {
      type: "reconcile",
      profileId: profile.profileId,
      transactionId: transaction.transactionId,
      attempt: transaction.automaticReconcileAttemptCount,
      reconcileAttemptId: reconcile.activeAttemptId,
      manual: false,
      timeoutMs: RECONCILE_TIMEOUT_MS,
    };
  }

  function findCurrentTransaction(profileId, transactionId) {
    const profile = profiles.get(profileId);
    if (!profile) return { profile: null, transaction: null };
    const transaction = profile.inflightTransaction;
    if (
      !transaction
      || transaction.transactionId !== transactionId
      || transaction.profileId !== profileId
      || transaction.isTerminal
    ) {
      return { profile, transaction: null };
    }
    return { profile, transaction };
  }

  function markProtocolIncompatible(profile, transaction, error) {
    setBlock(profile, "protocol-incompatible", {
      transaction,
      reason: error || "protocol-incompatible",
    });
  }

  function conflictAgainstCurrent(profile, transaction, { fromUnknown = false } = {}) {
    const residual = {};
    let changed = false;
    for (const [key, desired] of Object.entries(transaction.patch)) {
      if (Object.is(profile.confirmedSettings[key], desired)) continue;
      residual[key] = desired;
      if (
        !Object.is(profile.confirmedSettings[key], transaction.sendBaseValues?.[key])
        || profile.settingsKeyRevisions[key] !== transaction.sendBaseKeyRevisions?.[key]
      ) {
        changed = true;
      }
    }

    if (Object.keys(residual).length === 0) {
      finishTransaction(profile, transaction, "satisfied", "already-satisfied");
      return { applied: true, classification: "satisfied" };
    }
    if (changed || (fromUnknown && transaction.networkUnknownReplayUsed)) {
      transaction.status = "conflict";
      transaction.reason = changed ? "external-change" : "unknown-replay-conflict";
      resetReconcile(profile, transaction.transactionId);
      return { applied: true, classification: "conflict" };
    }
    if (transaction.casRebaseCount >= MAX_CAS_REBASE_COUNT) {
      transaction.status = "conflict";
      transaction.reason = "contention";
      resetReconcile(profile, transaction.transactionId);
      return { applied: true, classification: "contention" };
    }

    transaction.patch = residual;
    transaction.expectedEpoch = profile.settingsEpoch;
    transaction.expectedRevision = profile.settingsRevision;
    transaction.sendBaseValues = Object.fromEntries(
      Object.keys(residual).map((key) => [key, clone(profile.confirmedSettings[key])]),
    );
    transaction.sendBaseKeyRevisions = Object.fromEntries(
      Object.keys(residual).map((key) => [key, profile.settingsKeyRevisions[key]]),
    );
    transaction.casRebaseCount += 1;
    transaction.status = "ready";
    transaction.reason = "cas-rebase";
    resetReconcile(profile, transaction.transactionId);
    return { applied: true, classification: "safe-rebase" };
  }

  function resumeKnownNotApplied(profile, transaction, reason) {
    const residual = {};
    let changed = false;
    for (const [key, desired] of Object.entries(transaction.patch)) {
      if (Object.is(profile.confirmedSettings[key], desired)) continue;
      residual[key] = desired;
      if (
        !Object.is(profile.confirmedSettings[key], transaction.sendBaseValues?.[key])
        || profile.settingsKeyRevisions[key] !== transaction.sendBaseKeyRevisions?.[key]
      ) {
        changed = true;
      }
    }
    if (Object.keys(residual).length === 0) {
      finishTransaction(profile, transaction, "satisfied", `${reason}-already-satisfied`);
      return { applied: true, classification: "satisfied" };
    }
    if (changed) {
      transaction.status = "conflict";
      transaction.reason = "external-change";
      resetReconcile(profile, transaction.transactionId);
      return { applied: true, classification: "conflict" };
    }
    transaction.patch = residual;
    transaction.expectedEpoch = profile.settingsEpoch;
    transaction.expectedRevision = profile.settingsRevision;
    transaction.sendBaseValues = Object.fromEntries(
      Object.keys(residual).map((key) => [key, clone(profile.confirmedSettings[key])]),
    );
    transaction.sendBaseKeyRevisions = Object.fromEntries(
      Object.keys(residual).map((key) => [key, profile.settingsKeyRevisions[key]]),
    );
    transaction.status = "ready";
    transaction.reason = `${reason}-safe-rebase`;
    transaction.reconcileMode = null;
    resetReconcile(profile, transaction.transactionId);
    return { applied: true, classification: "safe-rebase" };
  }

  function classifySuccess(profile, transaction, responseSnapshot, snapshotResult) {
    if (isInconsistentSnapshot(snapshotResult)) {
      transaction.status = "confirming";
      transaction.reason = snapshotResult.classification;
      transaction.reconcileMode = "degraded-confirmation";
      ensureReconcileState(profile, transaction, now());
      return { applied: true, classification: "degraded" };
    }

    const latestSatisfies = desiredIsSatisfied(profile.confirmedSettings, transaction.originalPatch);
    if (snapshotResult.classification === "older") {
      if (latestSatisfies) {
        finishTransaction(profile, transaction, "committed", "older-success-target-retained");
        return { applied: true, classification: "committed" };
      }
      let overwritten = false;
      let unexplained = false;
      for (const [key, desired] of Object.entries(transaction.originalPatch)) {
        if (Object.is(profile.confirmedSettings[key], desired)) continue;
        const responseKeyRevision = responseSnapshot.settingsKeyRevisions[key];
        if (
          Object.is(responseSnapshot.settings[key], desired)
          && profile.settingsKeyRevisions[key] > responseKeyRevision
        ) {
          overwritten = true;
        } else {
          unexplained = true;
        }
      }
      if (overwritten && !unexplained) {
        finishTransaction(profile, transaction, "committed-superseded", "newer-key-revision-overwrote-target");
        return { applied: true, classification: "committed-superseded" };
      }
      transaction.status = "confirming";
      transaction.reason = "older-success-unexplained";
      transaction.reconcileMode = "degraded-confirmation";
      ensureReconcileState(profile, transaction, now());
      return { applied: true, classification: "degraded" };
    }

    if (latestSatisfies) {
      finishTransaction(profile, transaction, "committed", null);
      return { applied: true, classification: "committed" };
    }
    transaction.status = "confirming";
    transaction.reason = "success-target-mismatch";
    transaction.reconcileMode = "degraded-confirmation";
    ensureReconcileState(profile, transaction, now());
    return { applied: true, classification: "degraded" };
  }

  function acceptCommittedSnapshot(profile, input) {
    const validated = validateSnapshot(input);
    if (
      profile.blockState === "profile-missing"
      && validated.ok
      && validated.snapshot.settingsEpoch === profile.settingsEpoch
    ) {
      return { applied: false, classification: "profile-missing-stale-incarnation" };
    }

    const previousBlock = profile.blockState;
    const result = applySnapshot(profile, validated.ok ? validated.snapshot : input, { canUnblock: true });
    if (result.classification === "protocol-incompatible") {
      markProtocolIncompatible(profile, profile.inflightTransaction, result.error);
      return result;
    }
    if (sessionProtocolVersion !== PROTOCOL_VERSION) {
      setBlock(profile, "protocol-incompatible", {
        transaction: profile.inflightTransaction,
        reason: "session-protocol-not-confirmed",
      });
      return result;
    }
    if (result.classification === "profile-recreated") return result;

    const transaction = profile.inflightTransaction;
    if (previousBlock === "profile-missing" && result.classification === "initialized") {
      profile.blockState = null;
      profile.blockReason = null;
      profile.readState = "ready";
      profile.authority = "authoritative";
      result.transactionClassification = "profile-imported-first-incarnation";
    }
    if (
      previousBlock === "blocked-runtime-degraded"
      && !transaction
      && !isInconsistentSnapshot(result)
    ) {
      profile.blockState = null;
      profile.blockReason = null;
      profile.readState = "ready";
      profile.authority = "authoritative";
      result.transactionClassification = "runtime-synced-without-inflight";
    }
    if (
      REPAIRABLE_BLOCK_STATES.has(previousBlock)
      && profile.blockState == null
      && transaction?.status === previousBlock
      && !isInconsistentSnapshot(result)
    ) {
      if (transaction.reconcileMode === "known-not-applied") {
        result.transactionClassification = resumeKnownNotApplied(
          profile,
          transaction,
          "repair-snapshot",
        ).classification;
      } else {
        const blockedStatus = transaction.statusBeforeBlock;
        transaction.status = blockedStatus === "sending" ? "confirming" : (blockedStatus || "confirming");
        transaction.reason = blockedStatus === "sending"
          ? "network-unknown"
          : (transaction.reasonBeforeBlock || "blocked-state-repaired");
        if (blockedStatus === "sending") transaction.reconcileMode = "network-unknown";
        transaction.statusBeforeBlock = null;
        transaction.reasonBeforeBlock = null;
        if (RECONCILABLE_STATUSES.has(transaction.status)) {
          transaction.nextReconcileAt = now();
          ensureReconcileState(profile, transaction, now());
        }
        result.transactionClassification = "reconcile-required";
      }
    } else if (
      previousBlock === "protocol-incompatible"
      && profile.blockState == null
      && transaction?.status === "protocol-incompatible"
    ) {
      if (transaction.reconcileMode === "known-not-applied") {
        result.transactionClassification = resumeKnownNotApplied(
          profile,
          transaction,
          "protocol-repaired",
        ).classification;
      } else {
        transaction.status = "confirming";
        transaction.reason = "protocol-restored-reconcile-required";
        transaction.reconcileMode = "network-unknown";
        transaction.nextReconcileAt = now();
        ensureReconcileState(profile, transaction, now());
      }
    }
    return result;
  }

  function seedConfirmed(profileId, input) {
    const profile = ensureProfile(profileId);
    return acceptCommittedSnapshot(profile, input);
  }

  function generateNewTransactionId() {
    const transactionId = createTransactionId();
    if (typeof transactionId !== "string" || !TRANSACTION_ID_PATTERN.test(transactionId)) {
      throw new Error("transaction ID generator returned an invalid transaction ID");
    }
    if (usedTransactionIds.has(transactionId)) {
      throw new Error(`transaction ID has already been used: ${transactionId}`);
    }
    return transactionId;
  }

  function enqueueInternal(profileId, patch, preallocatedTransactionId = null) {
    const profile = ensureProfile(profileId);
    if (sessionProtocolVersion !== PROTOCOL_VERSION) {
      throw new Error("protocol-incompatible: settings protocol version 2 has not been confirmed");
    }
    if (profile.blockState || profile.readState === "degraded") {
      throw new Error(`profile settings are blocked: ${profile.blockState || profile.readState}`);
    }
    if (!profile.confirmedSettings || profile.authority !== "authoritative") {
      throw new Error("an authoritative settings snapshot is required before mutation");
    }

    const normalizedPatch = normalizePatch(patch);
    const transactionId = preallocatedTransactionId ?? generateNewTransactionId();
    if (usedTransactionIds.has(transactionId)) {
      throw new Error(`transaction ID has already been used: ${transactionId}`);
    }
    usedTransactionIds.add(transactionId);

    const effective = getEffectiveSettingsInternal(profile);
    const predecessorTransactionIds = [profile.inflightTransaction, ...profile.queuedTransactions]
      .filter((candidate) => candidate && !candidate.isTerminal)
      .map((candidate) => candidate.transactionId);
    const transaction = {
      transactionId,
      profileId,
      originalPatch: clone(normalizedPatch),
      patch: clone(normalizedPatch),
      intentBaseValues: Object.fromEntries(
        Object.keys(normalizedPatch).map((key) => [key, clone(effective[key])]),
      ),
      intentBaseKeyRevisions: Object.fromEntries(
        Object.keys(normalizedPatch).map((key) => [key, profile.settingsKeyRevisions[key]]),
      ),
      predecessorTransactionIds,
      createdBaseEpoch: profile.settingsEpoch,
      createdBaseRevision: profile.settingsRevision,
      expectedEpoch: null,
      expectedRevision: null,
      sendBaseValues: null,
      sendBaseKeyRevisions: null,
      createdSequence: ++createdSequence,
      casRebaseCount: 0,
      networkUnknownReplayUsed: false,
      sessionTokenRetryUsed: false,
      automaticReconcileAttemptCount: 0,
      nextReconcileAt: null,
      lastManualReconcileStartedAt: null,
      status: "queued",
      reason: null,
      isTerminal: false,
      terminalResult: null,
      endedAt: null,
      committedRevision: null,
      committedKeyRevisions: null,
      reconcileMode: null,
      lastReconcileOutcome: null,
      statusBeforeBlock: null,
      reasonBeforeBlock: null,
    };
    transactions.set(transactionId, transaction);
    profile.queuedTransactions.push(transaction);
    return clone(transaction);
  }

  function enqueue(profileId, patch) {
    return enqueueInternal(profileId, patch);
  }

  function takeNextEffect(profileId, { at = now(), manualReconcile = false } = {}) {
    const profile = ensureProfile(profileId);
    const reconcile = takeReconcileEffect(profile, at, manualReconcile);
    if (reconcile) return reconcile;
    if (manualReconcile) return null;
    if (profile.blockState || profile.readState === "degraded") return null;

    while (!profile.inflightTransaction && profile.queuedTransactions.length > 0) {
      const transaction = profile.queuedTransactions.shift();
      profile.inflightTransaction = transaction;
      const prepared = prepareQueuedTransaction(profile, transaction);
      if (prepared === "blocked") return null;
      if (prepared === "finished") continue;
    }

    const transaction = profile.inflightTransaction;
    if (!transaction || transaction.status !== "ready") return null;
    transaction.status = "sending";
    transaction.reason = null;
    return makeMutationEffect(transaction);
  }

  function applyRefresh(profileId, input) {
    const profile = ensureProfile(profileId);
    return acceptCommittedSnapshot(profile, input);
  }

  function markNetworkUnknown(profileId, transactionId, { at = now(), reason } = {}) {
    const { profile, transaction } = findCurrentTransaction(profileId, transactionId);
    if (!transaction) return { applied: false, classification: "ignored" };
    transaction.status = "confirming";
    transaction.reason = reason
      || (transaction.networkUnknownReplayUsed ? "replay-result-unknown" : "network-unknown");
    transaction.reconcileMode = "network-unknown";
    if (transaction.automaticReconcileAttemptCount < MAX_AUTOMATIC_RECONCILE_ATTEMPTS) {
      transaction.nextReconcileAt = at;
    }
    ensureReconcileState(profile, transaction, at);
    return { applied: true, classification: transaction.reason };
  }

  function settleReconcileAttempt(profileId, transactionId, {
    at = now(),
    outcome = "failure",
    reconcileAttemptId,
  } = {}) {
    const { profile, transaction } = findCurrentTransaction(profileId, transactionId);
    if (!transaction || profile.reconcileState?.transactionId !== transactionId) {
      return { applied: false, classification: "ignored" };
    }
    const reconcile = profile.reconcileState;
    if (!reconcile.active || reconcile.activeAttemptId !== reconcileAttemptId) {
      return { applied: false, classification: "ignored" };
    }
    const wasManual = reconcile.activeManual;
    reconcile.active = false;
    reconcile.activeAttempt = null;
    reconcile.activeAttemptId = null;
    reconcile.activeManual = false;
    if (!wasManual) scheduleReconcileAfterSettle(transaction, at);
    return { applied: true, classification: outcome };
  }

  function applyMutationResult(event) {
    if (!isPlainObject(event)) return { applied: false, classification: "ignored" };
    const { profile, transaction } = findCurrentTransaction(event.profileId, event.transactionId);
    if (!transaction) return { applied: false, classification: "ignored" };

    if (event.type === "session-token-invalid") {
      if (transaction.sessionTokenRetryUsed) {
        finishTransaction(profile, transaction, "explicit-failed", "session-token-retry-exhausted", event.at);
        return { applied: true, classification: "explicit-failed" };
      }
      transaction.sessionTokenRetryUsed = true;
      transaction.status = "ready";
      transaction.reason = "session-token-retry";
      return { applied: true, classification: "session-token-retry" };
    }

    if (event.type === "explicit-failure") {
      if (event.snapshot) {
        const snapshotResult = applySnapshot(profile, event.snapshot);
        if (snapshotResult.classification === "profile-recreated") {
          return { applied: true, classification: "profile-recreated" };
        }
        if (snapshotResult.classification === "protocol-incompatible") {
          markProtocolIncompatible(profile, transaction, snapshotResult.error);
          return snapshotResult;
        }
      }
      finishTransaction(profile, transaction, "explicit-failed", event.reason || null, event.at);
      return { applied: true, classification: "explicit-failed" };
    }

    if (event.type === "profile-missing") {
      terminateProfileTransactions(profile, "profile-missing", "authoritative-404", event.at);
      setBlock(profile, "profile-missing");
      return { applied: true, classification: "profile-missing" };
    }

    if (event.type === "blocked-canonical-collision" || event.type === "blocked-settings-state-invalid") {
      transaction.reconcileMode = "known-not-applied";
      setBlock(profile, event.type, { transaction, reason: event.reason || event.type });
      return { applied: true, classification: event.type };
    }

    if (event.type === "protocol-incompatible") {
      markProtocolIncompatible(profile, transaction, event.reason);
      return { applied: true, classification: "protocol-incompatible" };
    }

    if (event.type === "runtime-degraded") {
      if (event.commitState === "unknown") {
        return markNetworkUnknown(event.profileId, event.transactionId, {
          at: event.at,
          reason: "network-unknown",
        });
      }
      if (event.commitState === "rolled-back") {
        if (!event.snapshot) {
          return markNetworkUnknown(event.profileId, event.transactionId, {
            at: event.at,
            reason: "network-unknown",
          });
        }
        const snapshotResult = applySnapshot(profile, event.snapshot);
        if (snapshotResult.classification === "profile-recreated") return snapshotResult;
        if (snapshotResult.classification === "protocol-incompatible") {
          markProtocolIncompatible(profile, transaction, snapshotResult.error);
          return snapshotResult;
        }
        if (isInconsistentSnapshot(snapshotResult)) {
          transaction.status = "confirming";
          transaction.reason = snapshotResult.classification;
          transaction.reconcileMode = "degraded-confirmation";
          transaction.nextReconcileAt = event.at ?? now();
          ensureReconcileState(profile, transaction, event.at ?? now());
          return { applied: true, classification: "degraded" };
        }
        finishTransaction(profile, transaction, "explicit-failed", "runtime-publish-rolled-back", event.at);
        return { applied: true, classification: "explicit-failed" };
      }

      let snapshotResult = null;
      if (event.snapshot) {
        snapshotResult = applySnapshot(profile, event.snapshot);
        if (snapshotResult.classification === "profile-recreated") return snapshotResult;
        if (snapshotResult.classification === "protocol-incompatible") {
          markProtocolIncompatible(profile, transaction, snapshotResult.error);
          return snapshotResult;
        }
      }
      if (event.commitState === "profile-committed-runtime-degraded") {
        if (!snapshotResult?.snapshot) {
          return markNetworkUnknown(event.profileId, event.transactionId, {
            at: event.at,
            reason: "network-unknown",
          });
        }
        if (isInconsistentSnapshot(snapshotResult)) {
          transaction.status = "confirming";
          transaction.reason = snapshotResult.classification;
          transaction.reconcileMode = "degraded-confirmation";
          profile.blockState = "blocked-runtime-degraded";
          profile.blockReason = "runtime-degraded";
          profile.readState = "blocked-runtime-degraded";
          profile.authority = profile.confirmedSettings ? "stale" : "unavailable";
          transaction.nextReconcileAt = event.at ?? now();
          ensureReconcileState(profile, transaction, event.at ?? now());
          return { applied: true, classification: "degraded" };
        }
        recordLocalOwners(profile, transaction, snapshotResult.snapshot, true);
        transaction.status = "profile-committed-runtime-degraded";
        transaction.reason = "runtime-degraded";
        transaction.committedRevision = snapshotResult.snapshot.settingsRevision;
        transaction.committedKeyRevisions = Object.fromEntries(
          Object.keys(transaction.originalPatch).map((key) => [
            key,
            snapshotResult.snapshot.settingsKeyRevisions[key],
          ]),
        );
        transaction.reconcileMode = "committed-degraded";
      } else {
        transaction.status = "blocked-runtime-degraded";
        transaction.reason = "runtime-degraded";
        transaction.reconcileMode = "known-not-applied";
      }
      profile.blockState = "blocked-runtime-degraded";
      profile.blockReason = "runtime-degraded";
      profile.readState = "blocked-runtime-degraded";
      profile.authority = profile.confirmedSettings ? "stale" : "unavailable";
      transaction.nextReconcileAt = event.at ?? now();
      ensureReconcileState(profile, transaction, event.at ?? now());
      return { applied: true, classification: transaction.status };
    }

    if (event.type !== "success" && event.type !== "conflict") {
      return { applied: false, classification: "ignored" };
    }
    const validated = validateSnapshot(event.snapshot);
    if (!validated.ok) {
      markProtocolIncompatible(profile, transaction, validated.error);
      return { applied: true, classification: "protocol-incompatible", error: validated.error };
    }
    const responseSnapshot = validated.snapshot;
    const snapshotResult = applySnapshot(profile, responseSnapshot);
    if (snapshotResult.classification === "profile-recreated") {
      return { applied: true, classification: "profile-recreated" };
    }
    if (event.type === "conflict") {
      if (isInconsistentSnapshot(snapshotResult)) {
        transaction.status = "confirming";
        transaction.reason = snapshotResult.classification;
        transaction.reconcileMode = "cas-conflict";
        transaction.nextReconcileAt = event.at ?? now();
        ensureReconcileState(profile, transaction, event.at ?? now());
        return { applied: true, classification: "degraded" };
      }
      return conflictAgainstCurrent(profile, transaction, {
        fromUnknown: transaction.networkUnknownReplayUsed,
      });
    }

    if (!isInconsistentSnapshot(snapshotResult)) {
      recordLocalOwners(profile, transaction, responseSnapshot, event.applied !== false);
    }
    if (
      event.commitState === "not-applied"
      && !isInconsistentSnapshot(snapshotResult)
      && desiredIsSatisfied(profile.confirmedSettings, transaction.originalPatch)
    ) {
      finishTransaction(profile, transaction, "satisfied", "server-no-op", event.at);
      return { applied: true, classification: "satisfied" };
    }
    return classifySuccess(profile, transaction, responseSnapshot, snapshotResult);
  }

  function applyReconcileResult(event) {
    if (!isPlainObject(event)) return { applied: false, classification: "ignored" };
    const { profile, transaction } = findCurrentTransaction(event.profileId, event.transactionId);
    if (!transaction || !RECONCILABLE_STATUSES.has(transaction.status)) {
      return { applied: false, classification: "ignored" };
    }
    const reconcile = profile.reconcileState;
    if (
      !reconcile?.active
      || reconcile.transactionId !== event.transactionId
      || reconcile.activeAttemptId !== event.reconcileAttemptId
    ) {
      return { applied: false, classification: "ignored" };
    }
    if (event.type === "failure" || event.type === "timeout") {
      return settleReconcileAttempt(event.profileId, event.transactionId, {
        at: event.at,
        outcome: event.type,
        reconcileAttemptId: event.reconcileAttemptId,
      });
    }
    if (![
      "success",
      "runtime-degraded",
      "profile-missing",
      "blocked-canonical-collision",
      "blocked-settings-state-invalid",
    ].includes(event.type)) {
      return { applied: false, classification: "ignored" };
    }

    const previousStatus = transaction.status;
    const previousReason = transaction.reason;
    const previousMode = transaction.reconcileMode;
    const confirmedRevisionBefore = profile.settingsRevision;
    const wasManual = reconcile.activeManual === true;
    reconcile.active = false;
    reconcile.activeAttempt = null;
    reconcile.activeAttemptId = null;
    reconcile.activeManual = false;

    if (event.type === "profile-missing") {
      terminateProfileTransactions(profile, "profile-missing", "authoritative-404", event.at);
      setBlock(profile, "profile-missing");
      return { applied: true, classification: "profile-missing" };
    }
    if (event.type === "blocked-canonical-collision" || event.type === "blocked-settings-state-invalid") {
      setBlock(profile, event.type, { transaction, reason: event.reason || event.type });
      return { applied: true, classification: event.type };
    }
    if (event.type === "runtime-degraded" && !event.snapshot) {
      profile.blockState = "blocked-runtime-degraded";
      profile.blockReason = "runtime-degraded";
      profile.readState = "blocked-runtime-degraded";
      profile.authority = profile.confirmedSettings ? "stale" : "unavailable";
      if (!wasManual) scheduleReconcileAfterSettle(transaction, event.at ?? now());
      return { applied: true, classification: "runtime-degraded" };
    }

    const snapshotResult = applySnapshot(profile, event.snapshot);
    if (snapshotResult.classification === "protocol-incompatible") {
      markProtocolIncompatible(profile, transaction, snapshotResult.error);
      return snapshotResult;
    }
    if (snapshotResult.classification === "profile-recreated") return snapshotResult;
    if (isInconsistentSnapshot(snapshotResult)) {
      transaction.status = "confirming";
      transaction.reason = snapshotResult.classification;
      if (event.type === "runtime-degraded" || profile.blockState === "blocked-runtime-degraded") {
        profile.blockState = "blocked-runtime-degraded";
        profile.blockReason = "runtime-degraded";
        profile.readState = "blocked-runtime-degraded";
        profile.authority = profile.confirmedSettings ? "stale" : "unavailable";
      }
      if (!wasManual) scheduleReconcileAfterSettle(transaction, event.at ?? now());
      return { applied: true, classification: "degraded" };
    }
    if (snapshotResult.snapshot.settingsRevision < confirmedRevisionBefore) {
      transaction.status = previousStatus;
      transaction.reason = previousReason;
      transaction.lastReconcileOutcome = "stale-snapshot";
      if (profile.blockState === "blocked-runtime-degraded") {
        profile.readState = "blocked-runtime-degraded";
        profile.authority = profile.confirmedSettings ? "stale" : "unavailable";
      }
      if (!wasManual) scheduleReconcileAfterSettle(transaction, event.at ?? now());
      return { applied: true, classification: "degraded" };
    }
    if (event.type === "runtime-degraded") {
      profile.blockState = "blocked-runtime-degraded";
      profile.blockReason = "runtime-degraded";
      profile.readState = "blocked-runtime-degraded";
      profile.authority = profile.confirmedSettings ? "stale" : "unavailable";
      if (!wasManual) scheduleReconcileAfterSettle(transaction, event.at ?? now());
      return { applied: true, classification: "runtime-degraded" };
    }

    if (previousMode === "committed-degraded") {
      if (snapshotResult.snapshot.settingsRevision < transaction.committedRevision) {
        transaction.reason = "reconcile-below-committed-revision";
        if (!wasManual) scheduleReconcileAfterSettle(transaction, event.at ?? now());
        return { applied: true, classification: "degraded" };
      }
      profile.blockState = null;
      profile.blockReason = null;
      profile.readState = "ready";
      profile.authority = "authoritative";
      if (desiredIsSatisfied(profile.confirmedSettings, transaction.originalPatch)) {
        finishTransaction(profile, transaction, "committed", "runtime-synced", event.at);
        return { applied: true, classification: "committed" };
      }
      const superseded = Object.entries(transaction.originalPatch).every(([key, desired]) => (
        Object.is(profile.confirmedSettings[key], desired)
        || profile.settingsKeyRevisions[key] > (transaction.committedKeyRevisions?.[key] ?? -1)
      ));
      if (superseded && profile.settingsRevision >= transaction.committedRevision) {
        finishTransaction(profile, transaction, "committed-superseded", "runtime-synced-target-superseded", event.at);
        return { applied: true, classification: "committed-superseded" };
      }
      transaction.status = "confirming";
      transaction.reason = "committed-degraded-unexplained";
      if (!wasManual) scheduleReconcileAfterSettle(transaction, event.at ?? now());
      return { applied: true, classification: "degraded" };
    }

    profile.blockState = null;
    profile.blockReason = null;
    profile.readState = "ready";
    profile.authority = "authoritative";
    if (previousMode === "cas-conflict") {
      return conflictAgainstCurrent(profile, transaction, { fromUnknown: false });
    }
    if (previousMode === "known-not-applied") {
      return resumeKnownNotApplied(profile, transaction, "runtime-repaired");
    }

    const unknownMode = previousMode === "network-unknown";
    if (!unknownMode) {
      if (desiredIsSatisfied(profile.confirmedSettings, transaction.originalPatch)) {
        finishTransaction(profile, transaction, "committed", "degraded-reconcile-target-satisfied", event.at);
        return { applied: true, classification: "committed" };
      }
      transaction.status = "confirming";
      transaction.reason = "degraded-reconcile-unresolved";
      if (!wasManual) scheduleReconcileAfterSettle(transaction, event.at ?? now());
      return { applied: true, classification: "degraded" };
    }

    const residual = {};
    let changed = false;
    for (const [key, desired] of Object.entries(transaction.patch)) {
      if (Object.is(profile.confirmedSettings[key], desired)) continue;
      residual[key] = desired;
      if (
        !Object.is(profile.confirmedSettings[key], transaction.sendBaseValues?.[key])
        || profile.settingsKeyRevisions[key] !== transaction.sendBaseKeyRevisions?.[key]
      ) {
        changed = true;
      }
    }
    if (Object.keys(residual).length === 0) {
      finishTransaction(profile, transaction, "satisfied", "reconcile-target-satisfied", event.at);
      return { applied: true, classification: "satisfied" };
    }
    if (changed) {
      transaction.status = "conflict";
      transaction.reason = "external-change";
      resetReconcile(profile, transaction.transactionId);
      return { applied: true, classification: "conflict" };
    }
    if (!transaction.networkUnknownReplayUsed) {
      transaction.patch = residual;
      transaction.networkUnknownReplayUsed = true;
      transaction.expectedEpoch = profile.settingsEpoch;
      transaction.expectedRevision = profile.settingsRevision;
      transaction.sendBaseValues = Object.fromEntries(
        Object.keys(residual).map((key) => [key, clone(profile.confirmedSettings[key])]),
      );
      transaction.sendBaseKeyRevisions = Object.fromEntries(
        Object.keys(residual).map((key) => [key, profile.settingsKeyRevisions[key]]),
      );
      transaction.status = "ready";
      transaction.reason = "network-unknown-safe-replay";
      resetReconcile(profile, transaction.transactionId);
      return { applied: true, classification: "safe-replay" };
    }

    transaction.status = "confirming";
    transaction.reason = "replay-result-unknown";
    if (!wasManual) scheduleReconcileAfterSettle(transaction, event.at ?? now());
    return { applied: true, classification: "replay-result-unknown" };
  }

  function blockProfile(profileId, blockState) {
    const profile = ensureProfile(profileId);
    if (blockState === "profile-missing") {
      terminateProfileTransactions(profile, "profile-missing", "authoritative-404");
      setBlock(profile, "profile-missing");
      return { applied: true, classification: "profile-missing" };
    }
    if (profile.inflightTransaction?.status === "sending") {
      profile.inflightTransaction.reconcileMode = "network-unknown";
    } else if (profile.inflightTransaction?.status === "ready") {
      profile.inflightTransaction.reconcileMode = "known-not-applied";
    }
    setBlock(profile, blockState, { transaction: profile.inflightTransaction });
    return { applied: true, classification: blockState };
  }

  function setProtocolVersion(version) {
    sessionProtocolVersion = version;
    if (version !== PROTOCOL_VERSION) {
      for (const profile of profiles.values()) {
        setBlock(profile, "protocol-incompatible", { transaction: profile.inflightTransaction });
      }
      return false;
    }
    for (const profile of profiles.values()) {
      if (
        profile.blockState === "protocol-incompatible"
        && profile.blockReason === "session-protocol-not-confirmed"
        && !profile.inflightTransaction
      ) {
        profile.blockState = null;
        profile.blockReason = null;
        profile.readState = profile.confirmedSettings ? "ready" : "unavailable";
        profile.authority = profile.confirmedSettings ? "authoritative" : "unavailable";
      }
    }
    return true;
  }

  function resolve(profileId, transactionId, decision, { businessConfirmed = false } = {}) {
    const { profile, transaction } = findCurrentTransaction(profileId, transactionId);
    if (!transaction) throw new Error("transaction is not current");
    const mayResolveConflict = transaction.status === "conflict";
    const mayReapplyUnknown = transaction.status === "confirming"
      && transaction.reason === "replay-result-unknown";
    if (!mayResolveConflict && !mayReapplyUnknown) {
      throw new Error("transaction is not awaiting a manual decision");
    }
    if (decision === "adopt-current") {
      if (!mayResolveConflict) throw new Error("adopt-current is not safe for a result-unknown transaction");
      finishTransaction(profile, transaction, "terminated", "adopt-current");
      return null;
    }
    if (decision === "reapply") {
      if (!businessConfirmed) throw new Error("business confirmation is required before reapply");
      const desiredPatch = clone(transaction.originalPatch);
      const transactionIdForReapply = generateNewTransactionId();
      finishTransaction(profile, transaction, "terminated", "reapply");
      return enqueueInternal(profileId, desiredPatch, transactionIdForReapply);
    }
    throw new TypeError(`unsupported conflict decision: ${decision}`);
  }

  function getProfileState(profileId) {
    const profile = ensureProfile(profileId);
    return {
      profileId: profile.profileId,
      confirmedSettings: clone(profile.confirmedSettings),
      settingsEpoch: profile.settingsEpoch,
      settingsRevision: profile.settingsRevision,
      settingsKeyRevisions: clone(profile.settingsKeyRevisions),
      authority: profile.authority,
      readState: profile.readState,
      blockState: profile.blockState,
      inflightTransaction: clone(profile.inflightTransaction),
      queuedTransactions: clone(profile.queuedTransactions),
      reconcileState: clone(profile.reconcileState),
      busy: Boolean(profile.inflightTransaction || profile.queuedTransactions.length > 0),
    };
  }

  function getEffectiveSettings(profileId) {
    return clone(getEffectiveSettingsInternal(ensureProfile(profileId)));
  }

  function getTransaction(transactionId) {
    return clone(transactions.get(transactionId) || null);
  }

  return Object.freeze({
    applyMutationResult,
    applyReconcileResult,
    applyRefresh,
    blockProfile,
    enqueue,
    getEffectiveSettings,
    getProfileState,
    getTransaction,
    markNetworkUnknown,
    resolve,
    seedConfirmed,
    setProtocolVersion,
    settleReconcileAttempt,
    takeNextEffect,
  });
}
