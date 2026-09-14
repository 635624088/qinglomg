import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const EXPERIENCE_GUARD_STATE_VERSION = 1;
const EXPERIENCE_GUARD_REARM_VERSION = 1;
const EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_VERSION = 1;
const SETTLEMENT_RECOVERY_MODE_FINGERPRINT = "fingerprint";
const SETTLEMENT_RECOVERY_MODE_LEGACY_UNVERIFIED = "legacy-unverified";
const MAX_SETTLEMENT_OPERATOR_REASON_LENGTH = 500;

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveLevel(value) {
  const number = finiteNumber(value, null);
  return number != null && number >= 0 ? Math.floor(number) : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value, null);
  return number != null && number >= 0 ? number : null;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function timestamp(nowFn) {
  return new Date(nowFn()).toISOString();
}

function normalizeProfileId(profileId) {
  const value = String(profileId || "default").trim();
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new TypeError("Invalid experience guard profile id");
  }
  return value;
}

function normalizeSettlementRecoveryMode(value) {
  const mode = value == null || value === ""
    ? SETTLEMENT_RECOVERY_MODE_FINGERPRINT
    : String(value).trim();
  return [
    SETTLEMENT_RECOVERY_MODE_FINGERPRINT,
    SETTLEMENT_RECOVERY_MODE_LEGACY_UNVERIFIED,
  ].includes(mode)
    ? mode
    : null;
}

function normalizeSettlementOperatorReason(value) {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  if (!reason || reason.length > MAX_SETTLEMENT_OPERATOR_REASON_LENGTH) return null;
  return reason;
}

function atomicWriteJson(fileSystem, filePath, value, nowFn) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = `${filePath}.${process.pid}.${nowFn()}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fileSystem.writeFileSync(temporaryPath, text, "utf8");
    fileSystem.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fileSystem.rmSync(temporaryPath, { force: true });
    } catch {}
  }
  return text;
}

export function resolveExperienceGuardStatePath({
  statePath,
  settingsPath,
  profileId,
} = {}) {
  if (statePath) return path.resolve(String(statePath));
  if (!settingsPath) return null;
  const normalizedProfileId = normalizeProfileId(profileId);
  const runtimeDir = path.dirname(path.dirname(path.resolve(String(settingsPath))));
  return path.join(
    runtimeDir,
    "system",
    "experience-guards",
    `${normalizedProfileId}.json`,
  );
}

export function resolveExperienceGuardRearmPath({
  rearmPath,
  statePath,
  settingsPath,
  profileId,
} = {}) {
  if (rearmPath) return path.resolve(String(rearmPath));
  const resolvedStatePath = resolveExperienceGuardStatePath({ statePath, settingsPath, profileId });
  if (!resolvedStatePath) return null;
  return path.join(
    path.dirname(resolvedStatePath),
    `${normalizeProfileId(profileId)}.rearm.json`,
  );
}

export function resolveExperienceGuardSettlementRecoveryPath({
  recoveryPath,
  statePath,
  settingsPath,
  profileId,
} = {}) {
  if (recoveryPath) return path.resolve(String(recoveryPath));
  const resolvedStatePath = resolveExperienceGuardStatePath({ statePath, settingsPath, profileId });
  if (!resolvedStatePath) return null;
  return path.join(
    path.dirname(resolvedStatePath),
    `${normalizeProfileId(profileId)}.settlement-recovery.json`,
  );
}

function validateState(value, profileId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.version !== EXPERIENCE_GUARD_STATE_VERSION) return false;
  if (String(value.profileId) !== profileId) return false;
  if (!Number.isInteger(value.stateRevision) || value.stateRevision < 1) return false;
  if (value.armedLevel != null && positiveLevel(value.armedLevel) == null) return false;
  if (value.ceilingLevel != null && positiveLevel(value.ceilingLevel) == null) return false;
  if (typeof value.breached !== "boolean") return false;
  if (!Number.isInteger(value.rearmCount) || value.rearmCount < 0) return false;
  if (value.accountUid != null && typeof value.accountUid !== "string") return false;
  if (value.serverIdx != null && nonNegativeNumber(value.serverIdx) == null) return false;
  if (
    value.ceilingLevel != null
    && value.lastAuthoritativeLevel != null
    && Number(value.lastAuthoritativeLevel) > Number(value.ceilingLevel)
    && value.breached !== true
  ) return false;
  return true;
}

function validateRearmRequest(value, profileId) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.version === EXPERIENCE_GUARD_REARM_VERSION
    && String(value.profileId) === profileId
    && typeof value.requestId === "string"
    && value.requestId.length > 0
    && Number.isInteger(value.expectedStateRevision)
    && value.expectedStateRevision >= 1
    && Number.isInteger(value.expectedRearmCount)
    && value.expectedRearmCount >= 0
    && value.confirmed === true,
  );
}

function validateSettlementRecoveryRequest(value, profileId) {
  const recoveryMode = normalizeSettlementRecoveryMode(value?.recoveryMode);
  const operatorReason = normalizeSettlementOperatorReason(value?.operatorReason);
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.version === EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_VERSION
    && String(value.profileId) === profileId
    && typeof value.requestId === "string"
    && value.requestId.length > 0
    && typeof value.pendingRequestId === "string"
    && value.pendingRequestId.length > 0
    && Number.isInteger(value.expectedStateRevision)
    && value.expectedStateRevision >= 1
    && value.confirmed === true
    && recoveryMode != null
    && (
      recoveryMode !== SETTLEMENT_RECOVERY_MODE_LEGACY_UNVERIFIED
      || operatorReason != null
    ),
  );
}

function invalidState(profileId, reason, nowFn, previous = null) {
  const observedAt = timestamp(nowFn);
  return {
    ...(previous && typeof previous === "object" ? previous : {}),
    version: EXPERIENCE_GUARD_STATE_VERSION,
    profileId,
    stateRevision: Math.max(1, Number(previous?.stateRevision) || 1),
    armedLevel: previous?.armedLevel ?? null,
    ceilingLevel: previous?.ceilingLevel ?? null,
    breached: previous?.breached === true,
    invalid: true,
    invalidReason: reason,
    lastAuthoritativeLevel: previous?.lastAuthoritativeLevel ?? null,
    lastAuthoritativeExp: previous?.lastAuthoritativeExp ?? null,
    lastRequiredExp: previous?.lastRequiredExp ?? null,
    breachEvidence: previous?.breachEvidence ?? {
      source: "experience-guard-state",
      reason,
      observedAt,
    },
    accountUid: previous?.accountUid ?? null,
    serverIdx: previous?.serverIdx ?? null,
    rearmCount: Math.max(0, Number(previous?.rearmCount) || 0),
    updatedAt: observedAt,
  };
}

export function createExperienceGuardRearmRequest({
  profileId: rawProfileId,
  statePath,
  rearmPath,
  expectedStateRevision,
  confirmed = false,
  requestId = crypto.randomUUID(),
  nowFn = Date.now,
  fileSystem = fs,
} = {}) {
  const profileId = normalizeProfileId(rawProfileId);
  if (confirmed !== true) {
    const error = new Error("Explicit experience guard rearm confirmation is required");
    error.code = "EXPERIENCE_GUARD_REARM_CONFIRMATION_REQUIRED";
    throw error;
  }
  const resolvedStatePath = path.resolve(String(statePath));
  const resolvedRearmPath = resolveExperienceGuardRearmPath({
    rearmPath,
    statePath: resolvedStatePath,
    profileId,
  });
  const settlementPendingPath = `${resolvedStatePath}.settlement-pending.json`;
  if (fileSystem.existsSync(settlementPendingPath)) {
    const error = new Error("An unresolved protected settlement requires its dedicated recovery flow");
    error.code = "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_REQUIRED";
    throw error;
  }
  let state;
  try {
    state = JSON.parse(fileSystem.readFileSync(resolvedStatePath, "utf8"));
  } catch (error) {
    const out = new Error("Experience guard must have a valid authoritative state before rearm");
    out.code = "EXPERIENCE_GUARD_REARM_STATE_REQUIRED";
    out.cause = error;
    throw out;
  }
  if (!validateState(state, profileId) || state.invalid) {
    const error = new Error("Experience guard state is invalid and cannot be rearmed without authority");
    error.code = "EXPERIENCE_GUARD_REARM_STATE_INVALID";
    throw error;
  }
  const expectedRevision = Number(expectedStateRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== state.stateRevision) {
    const error = new Error("Experience guard state revision changed; refresh before rearming");
    error.code = "EXPERIENCE_GUARD_REARM_REVISION_CONFLICT";
    error.currentStateRevision = state.stateRevision;
    throw error;
  }
  if (fileSystem.existsSync(resolvedRearmPath)) {
    const error = new Error("An experience guard rearm request is already pending");
    error.code = "EXPERIENCE_GUARD_REARM_ALREADY_PENDING";
    throw error;
  }
  const requestedAt = timestamp(nowFn);
  const request = {
    version: EXPERIENCE_GUARD_REARM_VERSION,
    profileId,
    requestId: String(requestId),
    expectedStateRevision: expectedRevision,
    expectedRearmCount: Math.max(0, Number(state.rearmCount) || 0),
    confirmed: true,
    requestedAt,
  };
  atomicWriteJson(fileSystem, resolvedRearmPath, request, nowFn);
  return clone(request);
}

export function createExperienceGuardSettlementRecoveryRequest({
  profileId: rawProfileId,
  statePath,
  recoveryPath,
  pendingRequestId,
  expectedStateRevision,
  confirmed = false,
  legacyUnverified = false,
  operatorReason = null,
  requestId = crypto.randomUUID(),
  nowFn = Date.now,
  fileSystem = fs,
} = {}) {
  const profileId = normalizeProfileId(rawProfileId);
  if (confirmed !== true) {
    const error = new Error("Explicit protected settlement recovery confirmation is required");
    error.code = "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_CONFIRMATION_REQUIRED";
    throw error;
  }
  const recoveryMode = legacyUnverified === true
    ? SETTLEMENT_RECOVERY_MODE_LEGACY_UNVERIFIED
    : SETTLEMENT_RECOVERY_MODE_FINGERPRINT;
  const normalizedOperatorReason = normalizeSettlementOperatorReason(operatorReason);
  if (recoveryMode === SETTLEMENT_RECOVERY_MODE_LEGACY_UNVERIFIED && !normalizedOperatorReason) {
    const error = new Error("Legacy settlement recovery requires an explicit operator reason");
    error.code = "EXPERIENCE_GUARD_SETTLEMENT_LEGACY_OPERATOR_REASON_REQUIRED";
    throw error;
  }
  const resolvedStatePath = path.resolve(String(statePath));
  const resolvedRecoveryPath = resolveExperienceGuardSettlementRecoveryPath({
    recoveryPath,
    statePath: resolvedStatePath,
    profileId,
  });
  const settlementPendingPath = `${resolvedStatePath}.settlement-pending.json`;
  let state;
  try {
    state = JSON.parse(fileSystem.readFileSync(resolvedStatePath, "utf8"));
  } catch (error) {
    const out = new Error("Experience guard must have a valid state before settlement recovery");
    out.code = "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_STATE_REQUIRED";
    out.cause = error;
    throw out;
  }
  if (
    !validateState(state, profileId)
    || (
      state.invalid === true
      && state.invalidReason !== "experience-guard-settlement-unresolved"
    )
  ) {
    const error = new Error("Experience guard state is not recoverable as a protected settlement");
    error.code = "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_STATE_INVALID";
    throw error;
  }
  let pending;
  try {
    pending = JSON.parse(fileSystem.readFileSync(settlementPendingPath, "utf8"));
  } catch (error) {
    const out = new Error("A matching unresolved protected settlement is required");
    out.code = "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_PENDING_REQUIRED";
    out.cause = error;
    throw out;
  }
  const normalizedPendingRequestId = String(pendingRequestId || "").trim();
  if (
    !pending
    || typeof pending !== "object"
    || Array.isArray(pending)
    || String(pending.profileId) !== profileId
    || typeof pending.requestId !== "string"
    || pending.requestId !== normalizedPendingRequestId
  ) {
    const error = new Error("Settlement recovery must name the current account settlement");
    error.code = "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_PENDING_MISMATCH";
    throw error;
  }
  const expectedRevision = Number(expectedStateRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== state.stateRevision) {
    const error = new Error("Experience guard state revision changed; refresh before settlement recovery");
    error.code = "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_REVISION_CONFLICT";
    error.currentStateRevision = state.stateRevision;
    throw error;
  }
  if (fileSystem.existsSync(resolvedRecoveryPath)) {
    const error = new Error("A settlement recovery request is already pending");
    error.code = "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_ALREADY_PENDING";
    throw error;
  }
  const requestedAt = timestamp(nowFn);
  const request = {
    version: EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_VERSION,
    profileId,
    requestId: String(requestId),
    pendingRequestId: normalizedPendingRequestId,
    expectedStateRevision: expectedRevision,
    confirmed: true,
    recoveryMode,
    operatorReason: recoveryMode === SETTLEMENT_RECOVERY_MODE_LEGACY_UNVERIFIED
      ? normalizedOperatorReason
      : null,
    requestedAt,
  };
  atomicWriteJson(fileSystem, resolvedRecoveryPath, request, nowFn);
  return clone(request);
}

export function createPersistentExperienceLevelGuard({
  profileId: rawProfileId = "default",
  statePath = null,
  rearmPath = null,
  requireIdentity = false,
  nowFn = Date.now,
  fileSystem = fs,
} = {}) {
  const profileId = normalizeProfileId(rawProfileId);
  const resolvedStatePath = statePath ? path.resolve(String(statePath)) : null;
  const resolvedRearmPath = resolvedStatePath
    ? resolveExperienceGuardRearmPath({ rearmPath, statePath: resolvedStatePath, profileId })
    : null;
  const initializedPath = resolvedStatePath
    ? `${resolvedStatePath}.initialized.json`
    : null;
  const settlementPendingPath = resolvedStatePath
    ? `${resolvedStatePath}.settlement-pending.json`
    : null;
  const settlementRecoveryPath = resolvedStatePath
    ? resolveExperienceGuardSettlementRecoveryPath({
        statePath: resolvedStatePath,
        profileId,
      })
    : null;
  let state = null;
  let lastDiskText = null;
  let hadPersistedState = false;
  let writeFailure = null;
  let ownedSettlementRequestId = null;

  const readPendingSettlement = () => {
    if (!settlementPendingPath) return null;
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(settlementPendingPath, "utf8"));
      if (
        !parsed
        || typeof parsed !== "object"
        || Array.isArray(parsed)
        || String(parsed.profileId) !== profileId
        || typeof parsed.requestId !== "string"
        || !parsed.requestId
      ) {
        return {
          invalid: true,
          profileId,
          reason: "experience-guard-settlement-pending-invalid",
        };
      }
      return {
        ...parsed,
        status: parsed.status || "in-flight",
        actionArgs: parsed.actionArgs ?? null,
        actionEvidence: parsed.actionEvidence ?? null,
      };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      return {
        invalid: true,
        profileId,
        reason: `experience-guard-settlement-pending-read-failed:${error?.code || error?.message || "unknown"}`,
      };
    }
  };

  const readPendingSettlementRecovery = () => {
    if (!settlementRecoveryPath) return null;
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(settlementRecoveryPath, "utf8"));
      return validateSettlementRecoveryRequest(parsed, profileId)
        ? parsed
        : { invalid: true, reason: "experience-guard-settlement-recovery-invalid" };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      return {
        invalid: true,
        reason: `experience-guard-settlement-recovery-read-failed:${error?.code || error?.message || "unknown"}`,
      };
    }
  };

  const writePendingSettlement = (pending) => {
    if (!settlementPendingPath) return null;
    const text = atomicWriteJson(fileSystem, settlementPendingPath, pending, nowFn);
    const verified = JSON.parse(fileSystem.readFileSync(settlementPendingPath, "utf8"));
    if (
      !verified
      || verified.profileId !== profileId
      || verified.requestId !== pending.requestId
    ) {
      throw new Error("Experience guard settlement verification failed");
    }
    return { ...verified, actionArgs: verified.actionArgs ?? null };
  };

  const applyPendingSettlement = (pending = readPendingSettlement()) => {
    if (!pending) return null;
    if (!pending.invalid && pending.requestId === ownedSettlementRequestId) return pending;
    if (
      state?.invalid
      && state.invalidReason
      && state.invalidReason !== "experience-guard-settlement-unresolved"
      && !String(state.invalidReason).startsWith("experience-guard-settlement-pending-")
    ) {
      return pending;
    }
    state = invalidState(
      profileId,
      pending.invalid
        ? pending.reason
        : "experience-guard-settlement-unresolved",
      nowFn,
      state,
    );
    return pending;
  };

  const readDisk = () => {
    if (writeFailure) return state;
    if (!resolvedStatePath) return state;
    const pendingBeforeRead = readPendingSettlement();
    let text;
    try {
      text = fileSystem.readFileSync(resolvedStatePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (hadPersistedState || (initializedPath && fileSystem.existsSync(initializedPath))) {
          state = invalidState(profileId, "experience-guard-state-missing", nowFn, state);
        }
        lastDiskText = null;
        applyPendingSettlement(pendingBeforeRead);
        return state;
      }
      state = invalidState(
        profileId,
        `experience-guard-state-read-failed:${error?.code || error?.message || "unknown"}`,
        nowFn,
        state,
      );
      applyPendingSettlement(pendingBeforeRead);
      return state;
    }
    hadPersistedState = true;
    if (text !== lastDiskText) {
      lastDiskText = text;
      try {
        const parsed = JSON.parse(text);
        state = validateState(parsed, profileId)
          ? parsed
          : invalidState(profileId, "experience-guard-state-invalid", nowFn, state);
      } catch {
        state = invalidState(profileId, "experience-guard-state-invalid-json", nowFn, state);
      }
    }
    applyPendingSettlement(pendingBeforeRead);
    return state;
  };

  const writeState = (next) => {
    state = next;
    if (!resolvedStatePath) return state;
    try {
      const text = atomicWriteJson(fileSystem, resolvedStatePath, next, nowFn);
      const verified = JSON.parse(fileSystem.readFileSync(resolvedStatePath, "utf8"));
      if (!validateState(verified, profileId) || verified.stateRevision !== next.stateRevision) {
        throw new Error("Experience guard state verification failed");
      }
      if (initializedPath && !fileSystem.existsSync(initializedPath)) {
        atomicWriteJson(fileSystem, initializedPath, {
          version: 1,
          profileId,
          initializedAt: next.updatedAt || timestamp(nowFn),
        }, nowFn);
      }
      lastDiskText = text;
      hadPersistedState = true;
      writeFailure = null;
    } catch (error) {
      writeFailure = error;
      state = invalidState(
        profileId,
        `experience-guard-state-write-failed:${error?.code || error?.message || "unknown"}`,
        nowFn,
        next,
      );
    }
    return state;
  };

  const readPendingRearm = () => {
    if (!resolvedRearmPath) return null;
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(resolvedRearmPath, "utf8"));
      return validateRearmRequest(parsed, profileId)
        ? parsed
        : { invalid: true, reason: "experience-guard-rearm-invalid" };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      return {
        invalid: true,
        reason: `experience-guard-rearm-read-failed:${error?.code || error?.message || "unknown"}`,
      };
    }
  };

  const removeAppliedRearm = () => {
    if (!resolvedRearmPath) return;
    fileSystem.rmSync(resolvedRearmPath, { force: true });
  };

  const observeAuthoritative = ({
    level,
    currentExp = null,
    requiredExp = null,
    accountUid = null,
    serverIdx = null,
    enabled = true,
    source = "authority-sync",
    evidence = null,
    eligibleRearmRequestId = null,
  } = {}) => {
    readDisk();
    const observedLevel = positiveLevel(level);
    if (observedLevel == null) return clone(state);
    const normalizedAccountUid = accountUid == null || accountUid === ""
      ? null
      : String(accountUid);
    const normalizedServerIdx = nonNegativeNumber(serverIdx);
    if (
      requireIdentity
      && !hadPersistedState
      && (!normalizedAccountUid || normalizedServerIdx == null)
    ) {
      state = invalidState(
        profileId,
        "experience-guard-authority-identity-required",
        nowFn,
        state,
      );
      return clone(state);
    }
    if (
      requireIdentity
      && !hadPersistedState
      && state?.invalidReason === "experience-guard-authority-identity-required"
    ) {
      state = null;
    }
    const observedAt = timestamp(nowFn);
    const previous = state && !state.invalid
      ? state
      : state?.invalid
        ? state
        : {
            version: EXPERIENCE_GUARD_STATE_VERSION,
            profileId,
            stateRevision: 0,
            armedLevel: null,
            ceilingLevel: null,
            breached: false,
            invalid: false,
            invalidReason: null,
            breachEvidence: null,
            rearmCount: 0,
          };
    const pending = readPendingRearm();
    const settlementPending = readPendingSettlement();
    if (previous.invalid) {
      const recoverableInvalidState = String(previous.invalidReason || "").startsWith(
        "experience-guard-settlement-",
      ) || String(previous.invalidReason || "").startsWith(
        "experience-guard-state-write-failed:",
      ) || String(previous.invalidReason || "").startsWith(
        "experience-guard-rearm-clear-failed:",
      );
      const recoveryIdentityReason = !previous.accountUid
        || !normalizedAccountUid
        || previous.serverIdx == null
        || normalizedServerIdx == null
        ? "experience-guard-recovery-identity-required"
        : previous.accountUid !== normalizedAccountUid
          ? "experience-guard-account-identity-mismatch"
          : Number(previous.serverIdx) !== normalizedServerIdx
            ? "experience-guard-server-identity-mismatch"
            : null;
      if (settlementPending && recoveryIdentityReason) {
        state = invalidState(profileId, recoveryIdentityReason, nowFn, previous);
        return clone(state);
      }
      const alreadyCommittedRecovery = Boolean(
        recoverableInvalidState
        && !settlementPending
        && pending
        && !pending.invalid
        && pending.requestId === eligibleRearmRequestId
        && pending.requestId === previous.lastAppliedRearmRequestId
        && Math.max(0, Number(previous.rearmCount) || 0) === pending.expectedRearmCount + 1
      );
      if (alreadyCommittedRecovery) {
        if (recoveryIdentityReason) {
          state = invalidState(profileId, recoveryIdentityReason, nowFn, previous);
          return clone(state);
        }
        try {
          fileSystem.rmSync(settlementPendingPath, { force: true });
          removeAppliedRearm();
          state = {
            ...previous,
            invalid: false,
            invalidReason: null,
          };
        } catch (error) {
          state = invalidState(
            profileId,
            `experience-guard-rearm-clear-failed:${error?.code || error?.message || "unknown"}`,
            nowFn,
            previous,
          );
        }
        return clone(state);
      }
      if (
        recoverableInvalidState
        && !settlementPending
        && pending
        && !pending.invalid
        && pending.requestId === eligibleRearmRequestId
        && pending.expectedStateRevision <= previous.stateRevision
        && pending.expectedRearmCount === Math.max(0, Number(previous.rearmCount) || 0)
      ) {
        if (recoveryIdentityReason) {
          state = invalidState(profileId, recoveryIdentityReason, nowFn, previous);
          return clone(state);
        }
        const recoveredAt = timestamp(nowFn);
        writeFailure = null;
        writeState({
          ...previous,
          stateRevision: previous.stateRevision + 1,
          armedLevel: observedLevel,
          ceilingLevel: observedLevel,
          breached: false,
          invalid: false,
          invalidReason: null,
          lastAuthoritativeLevel: observedLevel,
          lastAuthoritativeExp: nonNegativeNumber(currentExp),
          lastRequiredExp: nonNegativeNumber(requiredExp),
          lastAuthoritySource: String(source || "authority-sync"),
          lastAuthorityEvidence: evidence ? clone(evidence) : null,
          lastObservedAt: recoveredAt,
          breachEvidence: null,
          rearmCount: Math.max(0, Number(previous.rearmCount) || 0) + 1,
          lastAppliedRearmRequestId: pending.requestId,
          lastRearmSource: "user-control-plane-recovery",
          rearmedAt: recoveredAt,
          armedAt: recoveredAt,
          armedBy: "explicit-user-rearm",
          updatedAt: recoveredAt,
        });
        if (!state?.invalid) {
          try {
            fileSystem.rmSync(settlementPendingPath, { force: true });
            removeAppliedRearm();
          } catch (error) {
            state = invalidState(
              profileId,
              `experience-guard-rearm-clear-failed:${error?.code || error?.message || "unknown"}`,
              nowFn,
              state,
            );
          }
        }
      }
      return clone(state);
    }

    if (
      previous.accountUid
      && (
        !normalizedAccountUid
        || previous.accountUid !== normalizedAccountUid
      )
    ) {
      state = invalidState(
        profileId,
        "experience-guard-account-identity-mismatch",
        nowFn,
        previous,
      );
      return clone(state);
    }
    if (
      previous.serverIdx != null
      && (
        normalizedServerIdx == null
        || Number(previous.serverIdx) !== normalizedServerIdx
      )
    ) {
      state = invalidState(
        profileId,
        "experience-guard-server-identity-mismatch",
        nowFn,
        previous,
      );
      return clone(state);
    }

    const previousAuthorityLevel = positiveLevel(previous.lastAuthoritativeLevel);
    const authorityRegressed = previousAuthorityLevel != null
      && observedLevel < previousAuthorityLevel;

    const next = {
      ...previous,
      stateRevision: previous.stateRevision + 1,
      accountUid: previous.accountUid || normalizedAccountUid,
      serverIdx: previous.serverIdx ?? normalizedServerIdx,
      lastAuthoritativeLevel: Math.max(
        observedLevel,
        previousAuthorityLevel ?? observedLevel,
      ),
      lastAuthoritativeExp:
        authorityRegressed
          ? previous.lastAuthoritativeExp ?? null
          : previousAuthorityLevel === observedLevel
          ? Math.max(
              nonNegativeNumber(currentExp) ?? 0,
              nonNegativeNumber(previous.lastAuthoritativeExp) ?? 0,
            )
          : nonNegativeNumber(currentExp),
      lastRequiredExp: authorityRegressed
        ? previous.lastRequiredExp ?? null
        : nonNegativeNumber(requiredExp),
      lastAuthoritySource: String(source || "authority-sync"),
      lastAuthorityEvidence: evidence ? clone(evidence) : null,
      lastObservedAt: observedAt,
      updatedAt: observedAt,
      authorityRegression: authorityRegressed
        ? {
            previousLevel: previousAuthorityLevel,
            observedLevel,
            source: String(source || "authority-sync"),
            observedAt,
          }
        : null,
    };
    if (next.armedLevel == null && enabled) {
      next.armedLevel = observedLevel;
      next.ceilingLevel = observedLevel;
      next.armedAt = observedAt;
      next.armedBy = "initial-authoritative";
    }
    if (
      next.ceilingLevel != null
      && observedLevel > Number(next.ceilingLevel)
    ) {
      next.breached = true;
      next.breachEvidence ||= {
        source: String(source || "authority-sync"),
        observedLevel,
        observedExp: nonNegativeNumber(currentExp),
        requiredExp: nonNegativeNumber(requiredExp),
        ceilingLevel: next.ceilingLevel,
        observedAt,
        evidence: evidence ? clone(evidence) : null,
      };
    }

    if (pending?.invalid) {
      return clone(writeState(invalidState(profileId, pending.reason, nowFn, next)));
    }
    if (pending && pending.requestId === previous.lastAppliedRearmRequestId) {
      removeAppliedRearm();
    } else if (
      pending
      && !authorityRegressed
      && pending.expectedStateRevision <= previous.stateRevision
      && pending.expectedRearmCount === Math.max(0, Number(previous.rearmCount) || 0)
      && pending.requestId === eligibleRearmRequestId
    ) {
      next.armedLevel = observedLevel;
      next.ceilingLevel = observedLevel;
      next.breached = false;
      next.breachEvidence = null;
      next.rearmCount = Math.max(0, Number(previous.rearmCount) || 0) + 1;
      next.lastAppliedRearmRequestId = pending.requestId;
      next.lastRearmSource = "user-control-plane";
      next.rearmedAt = observedAt;
      next.armedAt = observedAt;
      next.armedBy = "explicit-user-rearm";
    }
    writeState(next);
    if (pending && state?.lastAppliedRearmRequestId === pending.requestId && !state.invalid) {
      removeAppliedRearm();
    }
    return clone(state);
  };

  const getDecision = ({ enabled = true } = {}) => {
    readDisk();
    if (!enabled) {
      return {
        blocked: false,
        reason: "experience-level-guard-disabled",
        state: clone(state),
      };
    }
    if (state?.invalid) {
      return {
        blocked: true,
        reason: state.invalidReason || "experience-guard-state-invalid",
        state: clone(state),
      };
    }
    if (state?.breached) {
      return {
        blocked: true,
        reason: "experience-level-ceiling-breached",
        state: clone(state),
      };
    }
    return {
      blocked: false,
      reason: state?.ceilingLevel == null
        ? "experience-level-ceiling-unarmed"
        : "experience-level-ceiling-ok",
      state: clone(state),
    };
  };

  const beginProtectedAction = ({
    requestId,
    iface = null,
    actionArgs = null,
    actionEvidence = null,
  } = {}) => {
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedRequestId) {
      throw new TypeError("Protected action requestId is required");
    }
    readDisk();
    if (state?.invalid) {
      const error = new Error(state.invalidReason || "Experience guard state is invalid");
      error.code = state.invalidReason || "EXPERIENCE_GUARD_STATE_INVALID";
      error.experienceGuardState = clone(state);
      throw error;
    }
    if (!settlementPendingPath) return null;
    if (fileSystem.existsSync(settlementPendingPath)) {
      state = invalidState(
        profileId,
        "experience-guard-settlement-unresolved",
        nowFn,
        state,
      );
      const error = new Error("A protected action settlement is already unresolved");
      error.code = "EXPERIENCE_GUARD_SETTLEMENT_UNRESOLVED";
      error.experienceGuardState = clone(state);
      throw error;
    }
    try {
      atomicWriteJson(fileSystem, settlementPendingPath, {
        version: 1,
        profileId,
        requestId: normalizedRequestId,
        iface: iface == null ? null : String(iface),
        actionArgs: actionArgs == null ? null : clone(actionArgs),
        actionEvidence: actionEvidence == null ? null : clone(actionEvidence),
        status: "in-flight",
        stateRevision: state?.stateRevision ?? null,
        startedAt: timestamp(nowFn),
      }, nowFn);
      ownedSettlementRequestId = normalizedRequestId;
      return normalizedRequestId;
    } catch (error) {
      state = invalidState(
        profileId,
        `experience-guard-settlement-intent-write-failed:${error?.code || error?.message || "unknown"}`,
        nowFn,
        state,
      );
      const out = new Error("Cannot persist protected action settlement intent");
      out.code = "EXPERIENCE_GUARD_SETTLEMENT_INTENT_WRITE_FAILED";
      out.cause = error;
      out.experienceGuardState = clone(state);
      throw out;
    }
  };

  const completeProtectedAction = ({ requestId } = {}) => {
    if (!settlementPendingPath) return;
    const normalizedRequestId = String(requestId || "").trim();
    if (ownedSettlementRequestId !== normalizedRequestId) {
      const error = new Error("Protected action settlement ownership changed");
      error.code = "EXPERIENCE_GUARD_SETTLEMENT_OWNERSHIP_MISMATCH";
      throw error;
    }
    if (state?.invalid) {
      ownedSettlementRequestId = null;
      const error = new Error(state.invalidReason || "Experience guard state is invalid");
      error.code = state.invalidReason || "EXPERIENCE_GUARD_STATE_INVALID";
      error.experienceGuardState = clone(state);
      throw error;
    }
    try {
      fileSystem.rmSync(settlementPendingPath, { force: true });
      ownedSettlementRequestId = null;
    } catch (error) {
      ownedSettlementRequestId = null;
      state = invalidState(
        profileId,
        `experience-guard-settlement-intent-clear-failed:${error?.code || error?.message || "unknown"}`,
        nowFn,
        state,
      );
      const out = new Error("Cannot clear protected action settlement intent");
      out.code = "EXPERIENCE_GUARD_SETTLEMENT_INTENT_CLEAR_FAILED";
      out.cause = error;
      out.experienceGuardState = clone(state);
      throw out;
    }
  };

  const cancelProtectedActionBeforeSend = ({
    requestId,
    reason = "user-stopped-before-send",
    message = "用户停止",
  } = {}) => {
    if (!settlementPendingPath) return null;
    const normalizedRequestId = String(requestId || "").trim();
    const pending = readPendingSettlement();
    if (
      !pending
      || pending.invalid
      || pending.requestId !== normalizedRequestId
      || pending.status !== "in-flight"
    ) {
      const error = new Error("Only an in-flight protected action can be cancelled before send");
      error.code = "EXPERIENCE_GUARD_SETTLEMENT_CANCEL_BEFORE_SEND_MISMATCH";
      throw error;
    }
    readDisk();
    const cancelledAt = timestamp(nowFn);
    const next = {
      ...(state || {}),
      version: EXPERIENCE_GUARD_STATE_VERSION,
      profileId,
      stateRevision: Math.max(1, Number(state?.stateRevision) || 1) + 1,
      invalid: false,
      invalidReason: null,
      settlementResolution: {
        requestId: normalizedRequestId,
        outcome: "cancelled-before-send",
        source: "operator-stop-before-send",
        reason: String(reason || "user-stopped-before-send"),
        message: String(message || "用户停止"),
        resolvedAt: cancelledAt,
      },
      updatedAt: cancelledAt,
    };
    writeFailure = null;
    writeState(next);
    if (state?.invalid) {
      const error = new Error("Cannot persist protected action pre-send cancellation");
      error.code = "EXPERIENCE_GUARD_SETTLEMENT_CANCEL_WRITE_FAILED";
      error.experienceGuardState = clone(state);
      throw error;
    }
    try {
      fileSystem.rmSync(settlementPendingPath, { force: true });
      ownedSettlementRequestId = null;
    } catch (error) {
      state = invalidState(
        profileId,
        `experience-guard-settlement-intent-clear-failed:${error?.code || error?.message || "unknown"}`,
        nowFn,
        state,
      );
      const out = new Error("Cannot clear protected action after pre-send cancellation");
      out.code = "EXPERIENCE_GUARD_SETTLEMENT_CANCEL_CLEAR_FAILED";
      out.cause = error;
      out.experienceGuardState = clone(state);
      throw out;
    }
    return clone(state);
  };

  const markProtectedActionUncertain = ({
    requestId,
    category = "settlement-unknown",
    reason = "settlement-unknown",
    message = null,
    phase = "request-in-flight",
  } = {}) => {
    if (!settlementPendingPath) return null;
    const normalizedRequestId = String(requestId || "").trim();
    const pending = readPendingSettlement();
    if (!pending || pending.invalid || pending.requestId !== normalizedRequestId) {
      state = invalidState(
        profileId,
        "experience-guard-settlement-unresolved",
        nowFn,
        state,
      );
      return null;
    }
    const nextPending = {
      ...pending,
      status: "unknown",
      failureCategory: String(category || "settlement-unknown"),
      failureReason: String(reason || "settlement-unknown"),
      failureMessage: message == null ? null : String(message),
      failurePhase: String(phase || "request-in-flight"),
      uncertainAt: timestamp(nowFn),
    };
    try {
      writePendingSettlement(nextPending);
      if (ownedSettlementRequestId === normalizedRequestId) {
        ownedSettlementRequestId = null;
      }
    } catch (error) {
      state = invalidState(
        profileId,
        `experience-guard-settlement-uncertain-write-failed:${error?.code || error?.message || "unknown"}`,
        nowFn,
        state,
      );
      const out = new Error("Cannot persist protected action uncertainty");
      out.code = "EXPERIENCE_GUARD_SETTLEMENT_UNCERTAIN_WRITE_FAILED";
      out.cause = error;
      out.experienceGuardState = clone(state);
      throw out;
    }
    state = invalidState(
      profileId,
      "experience-guard-settlement-unresolved",
      nowFn,
      state,
    );
    return clone(nextPending);
  };

  const recordProtectedActionCheck = ({
    requestId,
    source = "authority-check",
    reason = null,
  } = {}) => {
    if (!settlementPendingPath) return null;
    const pending = readPendingSettlement();
    const normalizedRequestId = String(requestId || "").trim();
    if (!pending || pending.invalid || pending.requestId !== normalizedRequestId) return null;
    const nextPending = {
      ...pending,
      lastCheckedAt: timestamp(nowFn),
      lastCheckSource: String(source || "authority-check"),
      lastCheckReason: reason == null ? null : String(reason),
      checkCount: Math.max(0, Number(pending.checkCount) || 0) + 1,
    };
    try {
      writePendingSettlement(nextPending);
    } catch (error) {
      state = invalidState(
        profileId,
        `experience-guard-settlement-check-write-failed:${error?.code || error?.message || "unknown"}`,
        nowFn,
        state,
      );
      throw error;
    }
    state = invalidState(profileId, "experience-guard-settlement-unresolved", nowFn, state);
    return clone(nextPending);
  };

  const resolveProtectedAction = ({
    requestId,
    outcome,
    source = "explicit-authority",
    reason = null,
    recoveryRequestId = null,
  } = {}) => {
    if (!settlementPendingPath) return null;
    if (!(["confirmed", "rejected"].includes(String(outcome)))) {
      const error = new Error("An explicit settlement outcome is required before clearing a protected action");
      error.code = "EXPERIENCE_GUARD_SETTLEMENT_OUTCOME_REQUIRED";
      throw error;
    }
    const normalizedRequestId = String(requestId || "").trim();
    const pending = readPendingSettlement();
    if (!pending || pending.invalid || pending.requestId !== normalizedRequestId) {
      const error = new Error("Protected action settlement resolution ownership mismatch");
      error.code = "EXPERIENCE_GUARD_SETTLEMENT_RESOLUTION_MISMATCH";
      throw error;
    }
    const normalizedOutcome = String(outcome);
    let recovery = null;
    if (normalizedOutcome === "rejected") {
      recovery = readPendingSettlementRecovery();
      if (
        !recovery
        || recovery.invalid
        || recovery.requestId !== String(recoveryRequestId || "").trim()
        || recovery.pendingRequestId !== normalizedRequestId
      ) {
        const error = new Error("A confirmed settlement recovery request is required to reject an unresolved action");
        error.code = "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_REQUIRED";
        throw error;
      }
    }
    const recoveryMode = normalizedOutcome === "rejected"
      ? normalizeSettlementRecoveryMode(recovery?.recoveryMode)
      : null;
    const operatorReason = recoveryMode === SETTLEMENT_RECOVERY_MODE_LEGACY_UNVERIFIED
      ? normalizeSettlementOperatorReason(recovery?.operatorReason)
      : null;
    readDisk();
    const resolvedAt = timestamp(nowFn);
    const next = {
      ...(state || {}),
      version: EXPERIENCE_GUARD_STATE_VERSION,
      profileId,
      stateRevision: Math.max(1, Number(state?.stateRevision) || 1) + 1,
      invalid: false,
      invalidReason: null,
      settlementResolution: {
        requestId: normalizedRequestId,
        outcome: normalizedOutcome,
        source: String(source || "explicit-authority"),
        reason: reason == null ? null : String(reason),
        recoveryMode,
        operatorReason,
        resolvedAt,
      },
      updatedAt: resolvedAt,
    };
    writeFailure = null;
    writeState(next);
    if (state?.invalid) {
      const error = new Error("Cannot persist protected action settlement resolution");
      error.code = "EXPERIENCE_GUARD_SETTLEMENT_RESOLUTION_WRITE_FAILED";
      error.experienceGuardState = clone(state);
      throw error;
    }
    let settlementPendingCleared = false;
    try {
      fileSystem.rmSync(settlementPendingPath, { force: true });
      settlementPendingCleared = true;
      if (settlementRecoveryPath) {
        fileSystem.rmSync(settlementRecoveryPath, { force: true });
      }
      ownedSettlementRequestId = null;
    } catch (error) {
      if (settlementPendingCleared && !fileSystem.existsSync(settlementPendingPath)) {
        try {
          writePendingSettlement(pending);
        } catch {
          // Keep the invalid state below as the fail-closed fallback if restoration also fails.
        }
      }
      state = invalidState(
        profileId,
        `experience-guard-settlement-intent-clear-failed:${error?.code || error?.message || "unknown"}`,
        nowFn,
        state,
      );
      const out = new Error("Cannot clear protected action settlement after authority resolution");
      out.code = "EXPERIENCE_GUARD_SETTLEMENT_INTENT_CLEAR_FAILED";
      out.cause = error;
      out.experienceGuardState = clone(state);
      throw out;
    }
    return clone(state);
  };

  readDisk();
  return Object.freeze({
    profileId,
    statePath: resolvedStatePath,
    rearmPath: resolvedRearmPath,
    settlementPendingPath,
    settlementRecoveryPath,
    observeAuthoritative,
    getDecision,
    beginProtectedAction,
    completeProtectedAction,
    cancelProtectedActionBeforeSend,
    markProtectedActionUncertain,
    getPendingSettlement() {
      return clone(readPendingSettlement());
    },
    getPendingSettlementRecovery() {
      return clone(readPendingSettlementRecovery());
    },
    recordProtectedActionCheck,
    resolveProtectedAction,
    getPendingRearm() {
      return clone(readPendingRearm());
    },
    getState() {
      readDisk();
      return clone(state);
    },
  });
}
