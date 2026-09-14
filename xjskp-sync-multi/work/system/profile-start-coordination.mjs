import { canonicalizeProfileOperationKey } from "./profile-operation-coordinator.mjs";
import { getRecoveryDelayMs } from "./automation-recovery.mjs";

export function createProfileStartCoordination(options = {}) {
  const runCanonical = options.runCanonical;
  const profileStore = options.profileStore;
  const runtimeSettingsStore = options.runtimeSettingsStore;
  const desiredRunStore = options.desiredRunStore;
  const canonicalMigration = options.canonicalMigration;
  const loadExecutableProfile = options.loadExecutableProfile;
  const runner = options.runner;
  const now = options.now || (() => new Date());

  assertFunction(runCanonical, "runCanonical");
  assertMethod(profileStore, "readSettingsStateForProtocol");
  assertMethod(runtimeSettingsStore, "reconcileVersionedForProtocol");
  assertMethod(desiredRunStore, "readForProtocol");
  assertMethod(desiredRunStore, "writeForProtocol");
  assertMethod(desiredRunStore, "conditionalWriteForProtocol");
  assertMethod(canonicalMigration, "reconcile");
  assertFunction(loadExecutableProfile, "loadExecutableProfile");
  assertMethod(runner, "beginAutomationAlreadyCoordinated");

  async function beginManualLoop(profileId) {
    return runForProfile(profileId, async (canonicalId) => {
      await requireCanonicalArtifacts(canonicalId);
      const loaded = await profileStore.readSettingsStateForProtocol(canonicalId);
      const intent = await desiredRunStore.writeForProtocol(canonicalId, {
        desiredState: "running",
        restartAttempt: 0,
        recoveryStatus: "starting",
        nextRetryAt: null,
        lastReason: null,
        settingsEpoch: loaded.snapshot.settingsEpoch,
      });
      try {
        await runtimeSettingsStore.reconcileVersionedForProtocol(
          canonicalId,
          loaded.snapshot,
        );
        const profile = await buildExecutableProfile(canonicalId, loaded);
        const ticket = await runner.beginAutomationAlreadyCoordinated(
          profile,
          "loop",
          { coordinationToken: toCoordinationToken(intent) },
        );
        return wrapLoopTicket(canonicalId, loaded.snapshot.settingsEpoch, intent, ticket);
      } catch (error) {
        await settleIntent(canonicalId, intent, {
          desiredState: "stopped",
          recoveryStatus: "blocked",
          nextRetryAt: null,
          lastReason: errorReason(error),
        });
        throw error;
      }
    });
  }

  async function startManualLoop(profileId) {
    const ticket = await beginManualLoop(profileId);
    return ticket.confirmStartup();
  }

  async function beginManualRun(profileId, mode) {
    if (!new Set(["once", "orders"]).has(mode)) {
      throw new TypeError("Manual one-shot mode must be once or orders");
    }
    return runForProfile(profileId, async (canonicalId) => {
      await requireCanonicalArtifacts(canonicalId);
      const loaded = await profileStore.readSettingsStateForProtocol(canonicalId);
      await runtimeSettingsStore.reconcileVersionedForProtocol(
        canonicalId,
        loaded.snapshot,
      );
      const profile = await buildExecutableProfile(canonicalId, loaded);
      return runner.beginAutomationAlreadyCoordinated(profile, mode);
    });
  }

  async function runManualOnce(profileId, mode) {
    const ticket = await beginManualRun(profileId, mode);
    return ticket.waitForExit();
  }

  async function beginRecovery(input = {}) {
    if (!input.coordinationToken) return missingCoordinationToken(input.profileId);
    return runForProfile(input.profileId, async (canonicalId) => {
      let expectedDesired = null;
      try {
        await requireCanonicalArtifacts(canonicalId);
        const loaded = await profileStore.readSettingsStateForProtocol(canonicalId);
        const desired = await desiredRunStore.readForProtocol(canonicalId);
        if (desired?.desiredState !== "running") {
          return { status: "skipped", reason: "desired-state-not-running", profileId: canonicalId };
        }
        if (input.coordinationToken && !matchesCoordinationToken(desired, input.coordinationToken)) {
          return { status: "skipped", reason: "desired-intent-changed", profileId: canonicalId };
        }
        expectedDesired = desired;
        if (!desired.settingsEpoch) {
          return blockRecovery(canonicalId, desired, "settings-epoch-confirmation-required");
        }
        if (desired.settingsEpoch !== loaded.snapshot.settingsEpoch) {
          return blockRecovery(canonicalId, desired, "profile-recreated");
        }

        await runtimeSettingsStore.reconcileVersionedForProtocol(
          canonicalId,
          loaded.snapshot,
        );
        const starting = await settleIntent(canonicalId, desired, {
          desiredState: "running",
          recoveryStatus: "starting",
          nextRetryAt: null,
          lastReason: input.cause?.reason || input.cause?.category || "recovery",
        });
        if (!starting.matched) {
          return { status: "skipped", reason: "desired-state-changed", profileId: canonicalId };
        }
        expectedDesired = starting.record;
        const profile = await buildExecutableProfile(canonicalId, loaded);
        const ticket = await runner.beginAutomationAlreadyCoordinated(
          profile,
          "loop",
          { coordinationToken: toCoordinationToken(starting.record) },
        );
        return wrapLoopTicket(
          canonicalId,
          loaded.snapshot.settingsEpoch,
          starting.record,
          ticket,
          { recovery: true },
        );
      } catch (error) {
        if (isRetryableRecoveryError(error)) {
          return retryRecovery(
            canonicalId,
            error,
            expectedDesired,
            input.coordinationToken,
          );
        }
        if (expectedDesired) {
          await settleIntent(canonicalId, expectedDesired, {
            desiredState: "stopped",
            recoveryStatus: "blocked",
            nextRetryAt: null,
            lastReason: errorReason(error),
          });
        }
        return failedRecovery(canonicalId, error);
      }
    });
  }

  async function recover(input = {}) {
    const result = await beginRecovery(input);
    if (
      !result
      || result.status === "blocked"
      || result.status === "skipped"
      || result.status === "failed"
      || result.status === "retry"
    ) {
      return result;
    }
    try {
      return await result.confirmStartup();
    } catch (error) {
      if (isRetryableRecoveryError(error)) {
        return retryRecovery(
          result.profileId,
          error,
          null,
          result.coordinationToken,
        );
      }
      return failedRecovery(result.profileId, error);
    }
  }

  async function handleRecoveryEvent(input = {}) {
    if (input.phase === "attempt") {
      if (!input.coordinationToken) return missingCoordinationToken(input.profileId);
      return recover(input);
    }
    if (input.phase === "schedule") {
      return runForProfile(input.profileId, async (canonicalId) => {
        const desired = await desiredRunStore.readForProtocol(canonicalId);
        if (desired?.desiredState !== "running") {
          return { status: "skipped", reason: "desired-state-not-running", profileId: canonicalId };
        }
        if (!input.coordinationToken) return missingCoordinationToken(canonicalId);
        if (!matchesCoordinationToken(desired, input.coordinationToken)) {
          return { status: "skipped", reason: "desired-intent-changed", profileId: canonicalId };
        }
        const previousAttempt = input.resetAttempt ? 0 : input.coordinationToken.restartAttempt;
        if (!Number.isSafeInteger(previousAttempt) || previousAttempt < 0 || previousAttempt >= Number.MAX_SAFE_INTEGER) {
          const blocked = await settleIntent(canonicalId, input.coordinationToken, {
            desiredState: "stopped",
            recoveryStatus: "blocked",
            nextRetryAt: null,
            lastReason: "recovery-attempt-limit",
          });
          return blocked.matched
            ? { status: "blocked", profileId: canonicalId, reason: "recovery-attempt-limit" }
            : { status: "skipped", profileId: canonicalId, reason: "desired-intent-changed" };
        }
        const attempt = Math.max(1, Number(previousAttempt || 0) + 1);
        const delayMs = input.delayMs ?? getRecoveryDelayMs(attempt);
        const nextRetryAt = new Date(now().getTime() + delayMs).toISOString();
        const scheduled = await settleIntent(canonicalId, desired, {
          desiredState: "running",
          restartAttempt: attempt,
          recoveryStatus: "scheduled",
          nextRetryAt,
          lastReason: input.cause?.reason || input.cause?.category || "recovery",
        });
        return scheduled.matched
          ? {
            status: "scheduled",
            profileId: canonicalId,
            attempt,
            delayMs,
            nextRetryAt,
            coordinationToken: toCoordinationToken(scheduled.record),
          }
          : { status: "skipped", reason: "desired-state-changed", profileId: canonicalId };
      });
    }
    if (input.phase === "terminal") {
      return runForProfile(input.profileId, async (canonicalId) => {
        const desired = await desiredRunStore.readForProtocol(canonicalId);
        if (desired?.desiredState !== "running") {
          return { status: "skipped", reason: "desired-state-not-running", profileId: canonicalId };
        }
        if (!input.coordinationToken) return missingCoordinationToken(canonicalId);
        if (!matchesCoordinationToken(desired, input.coordinationToken)) {
          return { status: "skipped", reason: "desired-intent-changed", profileId: canonicalId };
        }
        const reason = input.cause?.reason || input.cause?.category || "not-recoverable";
        const stopped = await settleIntent(canonicalId, desired, {
          desiredState: "stopped",
          recoveryStatus: input.cause?.category === "operator" ? "stopped" : "blocked",
          nextRetryAt: null,
          lastReason: reason,
        });
        return stopped.matched
          ? { status: "blocked", profileId: canonicalId, reason }
          : { status: "skipped", reason: "desired-state-changed", profileId: canonicalId };
      });
    }
    if (input.phase === "healthy-reset") {
      return runForProfile(input.profileId, async (canonicalId) => {
        const desired = await desiredRunStore.readForProtocol(canonicalId);
        if (desired?.desiredState !== "running" || desired.restartAttempt === 0) {
          return { status: "skipped", reason: "reset-not-required", profileId: canonicalId };
        }
        if (!input.coordinationToken) return missingCoordinationToken(canonicalId);
        if (!matchesCoordinationToken(desired, input.coordinationToken)) {
          return { status: "skipped", reason: "desired-intent-changed", profileId: canonicalId };
        }
        const reset = await settleIntent(canonicalId, desired, {
          desiredState: "running",
          restartAttempt: 0,
          recoveryStatus: "running",
          nextRetryAt: null,
          lastReason: null,
        });
        return reset.matched
          ? {
            status: "reset",
            profileId: canonicalId,
            coordinationToken: toCoordinationToken(reset.record),
          }
          : { status: "skipped", reason: "desired-state-changed", profileId: canonicalId };
      });
    }
    if (input.phase === "stop") {
      if (input.preserveDesiredState) {
        return { status: "skipped", reason: "desired-state-preserved", profileId: input.profileId };
      }
      return runForProfile(input.profileId, async (canonicalId) => {
        const desired = await desiredRunStore.readForProtocol(canonicalId);
        if (!desired) return { status: "skipped", reason: "desired-state-missing", profileId: canonicalId };
        const stopped = await settleIntent(canonicalId, desired, {
          desiredState: "stopped",
          recoveryStatus: "stopped",
          nextRetryAt: null,
          lastReason: "user-stopped",
        });
        return stopped.matched
          ? { status: "stopped", profileId: canonicalId }
          : { status: "skipped", reason: "desired-state-changed", profileId: canonicalId };
      });
    }
    if (input.phase === "restore-inspect") {
      if (input.profileId == null) {
        assertMethod(canonicalMigration, "listCanonicalIds");
        const records = [];
        const blocked = [];
        const profileIds = await canonicalMigration.listCanonicalIds();
        for (const profileId of profileIds) {
          try {
            const inspected = await handleRecoveryEvent({
              phase: "restore-inspect",
              profileId,
            });
            if (inspected.status === "eligible" && inspected.record) {
              records.push(inspected.record);
            } else if (inspected.status === "blocked" || inspected.status === "failed") {
              blocked.push({ profileId, reason: inspected.reason });
            }
          } catch (error) {
            blocked.push({ profileId, reason: errorReason(error) });
          }
        }
        return { status: "inspected", records, blocked };
      }
      return runForProfile(input.profileId, async (canonicalId) => {
        await requireCanonicalArtifacts(canonicalId);
        const loaded = await profileStore.readSettingsStateForProtocol(canonicalId);
        const desired = await desiredRunStore.readForProtocol(canonicalId);
        if (desired?.desiredState !== "running") {
          return { status: "skipped", reason: "desired-state-not-running", profileId: canonicalId };
        }
        if (!desired.settingsEpoch) {
          return blockRecovery(canonicalId, desired, "settings-epoch-confirmation-required");
        }
        if (desired.settingsEpoch !== loaded.snapshot.settingsEpoch) {
          return blockRecovery(canonicalId, desired, "profile-recreated");
        }
        return {
          status: "eligible",
          profileId: canonicalId,
          record: {
            ...desired,
            coordinationToken: toCoordinationToken(desired),
          },
        };
      });
    }
    throw new TypeError("Unknown recovery coordination phase");
  }

  async function requireCanonicalArtifacts(canonicalId) {
    const result = await canonicalMigration.reconcile(canonicalId);
    if (result?.status === "clear") return result;
    const error = new Error(
      result?.reason === "active-alias"
        ? "A canonical alias is still active"
        : "Canonical profile artifacts cannot be reconciled",
    );
    error.code = result?.code || "PROFILE_ID_CANONICAL_COLLISION";
    error.reason = result?.reason || "canonical-collision";
    error.sources = result?.sources || [];
    throw error;
  }

  async function buildExecutableProfile(canonicalId, loaded) {
    const executable = await loadExecutableProfile(canonicalId);
    return {
      ...loaded.profile,
      ...executable,
      id: canonicalId,
      settings: { ...loaded.snapshot.settings },
      settingsEpoch: loaded.snapshot.settingsEpoch,
      settingsRevision: loaded.snapshot.settingsRevision,
      settingsKeyRevisions: { ...loaded.snapshot.settingsKeyRevisions },
    };
  }

  function wrapLoopTicket(canonicalId, settingsEpoch, intent, ticket, ticketOptions = {}) {
    return {
      status: "started",
      profileId: canonicalId,
      settingsEpoch,
      coordinationToken: toCoordinationToken(intent),
      active: ticket.active,
      async confirmStartup() {
        let confirmed;
        try {
          confirmed = await ticket.confirmStartup();
        } catch (error) {
          if (ticketOptions.recovery && isRetryableRecoveryError(error)) throw error;
          await runCanonical(canonicalId, () => settleIntent(canonicalId, intent, {
            desiredState: "stopped",
            recoveryStatus: "blocked",
            nextRetryAt: null,
            lastReason: errorReason(error),
          }));
          throw error;
        }
        await runCanonical(canonicalId, async () => {
          const settled = await settleIntent(canonicalId, intent, {
            desiredState: "running",
            recoveryStatus: "running",
            nextRetryAt: null,
            lastReason: null,
          });
          if (settled.matched && typeof ticket.updateCoordinationToken === "function") {
            await ticket.updateCoordinationToken(toCoordinationToken(settled.record));
          }
          return settled;
        });
        if (typeof ticket.flushDeferredRecovery === "function") {
          await ticket.flushDeferredRecovery();
        }
        return confirmed;
      },
      waitForExit: () => ticket.waitForExit(),
    };
  }

  async function blockRecovery(canonicalId, desired, reason) {
    const settled = await settleIntent(canonicalId, desired, {
      desiredState: "stopped",
      recoveryStatus: "blocked",
      nextRetryAt: null,
      lastReason: reason,
    });
    return {
      status: "blocked",
      profileId: canonicalId,
      reason,
      desired: settled.record,
    };
  }

  function settleIntent(canonicalId, expected, patch) {
    return desiredRunStore.conditionalWriteForProtocol(canonicalId, {
      expectedUpdatedAt: expected.updatedAt,
      expectedSettingsEpoch: expected.settingsEpoch,
      expectedDesiredState: expected.desiredState,
      expectedRecoveryStatus: expected.recoveryStatus,
      expectedRestartAttempt: expected.restartAttempt,
      expectedNextRetryAt: expected.nextRetryAt,
      patch,
    });
  }

  function runForProfile(profileId, operation) {
    const canonicalId = canonicalizeProfileOperationKey(profileId);
    if (!canonicalId) {
      const error = new Error("Profile ID cannot produce a canonical operation key");
      error.code = "INVALID_PROFILE_ID_CANONICAL_FORM";
      throw error;
    }
    return runCanonical(canonicalId, operation);
  }

  return Object.freeze({
    beginManualLoop,
    startManualLoop,
    beginManualRun,
    runManualOnce,
    beginRecovery,
    recover,
    handleRecoveryEvent,
  });
}

function errorReason(error) {
  return error?.reason || error?.code || "start-failed";
}

function failedRecovery(profileId, error) {
  return {
    status: "failed",
    profileId,
    reason: errorReason(error),
    ...(error?.code ? { code: error.code } : {}),
  };
}

function retryRecovery(profileId, error, expectedDesired, fallbackToken) {
  return {
    status: "retry",
    profileId,
    reason: errorReason(error),
    category: error?.category || "runtime",
    ...(error?.code ? { code: error.code } : {}),
    ...((expectedDesired || fallbackToken)
      ? {
        coordinationToken: expectedDesired
          ? toCoordinationToken(expectedDesired)
          : fallbackToken,
      }
      : {}),
  };
}

function missingCoordinationToken(profileId) {
  return {
    status: "failed",
    profileId,
    reason: "recovery-coordination-token-required",
    code: "RECOVERY_COORDINATION_TOKEN_REQUIRED",
  };
}

function toCoordinationToken(record) {
  return Object.freeze({
    profileId: record.profileId,
    settingsEpoch: record.settingsEpoch,
    updatedAt: record.updatedAt,
    desiredState: record.desiredState,
    recoveryStatus: record.recoveryStatus,
    restartAttempt: record.restartAttempt,
    nextRetryAt: record.nextRetryAt,
  });
}

function matchesCoordinationToken(record, token) {
  return [
    "profileId",
    "settingsEpoch",
    "updatedAt",
    "desiredState",
    "recoveryStatus",
    "restartAttempt",
    "nextRetryAt",
  ].every((key) => Object.is(record?.[key], token?.[key]));
}

function isRetryableRecoveryError(error) {
  return error?.code === "MAX_PARALLEL_TASKS_REACHED"
    || error?.code === "GAME_DATA_SYNC_IN_PROGRESS"
    || ["EBUSY", "EMFILE", "ENFILE"].includes(error?.code)
    || error?.category === "network"
    || error?.category === "stalled";
}

function assertFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
}

function assertMethod(value, name) {
  if (!value || typeof value[name] !== "function") {
    throw new TypeError(`${name} is required`);
  }
}
