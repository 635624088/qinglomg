import {
  PROFILE_SETTINGS_CANONICAL_KEYS,
  buildProfileSettingsServiceResult,
  canonicalizeProfileSettingsPatch,
  isCanonicalProfileSettingsId,
  isProfileSettingsEpoch,
  isProfileSettingsRevision,
  isValidProfileSettingsTransactionId,
  parseProfileSettingsIfMatch,
} from "./profile-settings-protocol.mjs";

export function prepareProfileSettingsMutation(input = {}) {
  const envelope = prepareProfileSettingsMutationEnvelope(input);
  if (!envelope.ok) return envelope;
  return completeProfileSettingsMutation(envelope.envelope, input.body);
}

export function prepareProfileSettingsMutationEnvelope(input = {}) {
  const profileId = input.profileId;
  if (!isCanonicalProfileSettingsId(profileId)) {
    return {
      ok: false,
      result: buildProfileSettingsServiceResult("invalid-profile-id"),
    };
  }
  const transactionIdValid = isValidProfileSettingsTransactionId(
    input.transactionId,
  );
  const precondition = parseProfileSettingsIfMatch(input.ifMatch);
  if (!transactionIdValid || !precondition) {
    return {
      ok: false,
      result: buildProfileSettingsServiceResult("precondition", {
        transactionId: transactionIdValid ? input.transactionId : null,
      }),
    };
  }
  return {
    ok: true,
    envelope: {
      profileId,
      transactionId: input.transactionId,
      precondition,
    },
  };
}

export function completeProfileSettingsMutation(envelope, body) {
  if (
    !envelope
    || !isCanonicalProfileSettingsId(envelope.profileId)
    || !isValidProfileSettingsTransactionId(envelope.transactionId)
    || !isPreparedPrecondition(envelope.precondition)
  ) {
    throw new TypeError("A prepared profile settings mutation envelope is required");
  }
  let patch;
  try {
    patch = canonicalizeProfileSettingsPatch(body);
  } catch (error) {
    return {
      ok: false,
      result: buildProfileSettingsServiceResult("invalid-settings", {
        transactionId: envelope.transactionId,
        message: error?.message,
      }),
    };
  }
  return {
    ok: true,
    prepared: {
      ...envelope,
      patch,
    },
  };
}

export function createProfileSettingsKernel(options = {}) {
  const profileStore = options.profileStore;
  const runtimeSettingsStore = options.runtimeSettingsStore;
  const inspectCanonicalSources = options.inspectCanonicalSources;
  assertMethod(profileStore, "readSettingsStateForProtocol");
  assertMethod(profileStore, "compareAndWriteTentativeSettingsForProtocol");
  assertMethod(profileStore, "conditionalRollbackSettingsForProtocol");
  assertMethod(runtimeSettingsStore, "compareVersionedForProtocol");
  assertMethod(runtimeSettingsStore, "publishVersionedForProtocol");
  assertMethod(runtimeSettingsStore, "reconcileVersionedForProtocol");
  if (typeof inspectCanonicalSources !== "function") {
    throw new TypeError("inspectCanonicalSources is required");
  }

  async function readCommittedAlreadyCoordinated(profileId) {
    let loaded;
    try {
      loaded = await profileStore.readSettingsStateForProtocol(profileId);
    } catch (error) {
      return mapReadError(error);
    }
    const collision = await inspectCollision(profileId);
    if (collision) {
      return buildProfileSettingsServiceResult("collision", {
        collisionSources: collision.sources,
      });
    }
    try {
      await runtimeSettingsStore.reconcileVersionedForProtocol(
        profileId,
        loaded.snapshot,
      );
      return buildProfileSettingsServiceResult("read-synced", loaded);
    } catch {
      return buildProfileSettingsServiceResult("read-degraded", {
        ...loaded,
        exposeSnapshot: true,
      });
    }
  }

  async function mutateAlreadyCoordinated(prepared) {
    const { profileId, transactionId, precondition, patch } = prepared;
    let loaded;
    try {
      loaded = await profileStore.readSettingsStateForProtocol(profileId);
    } catch (error) {
      return mapMutationReadError(error, transactionId);
    }

    let collision;
    try {
      collision = await inspectCollision(profileId);
    } catch {
      return buildProfileSettingsServiceResult("runtime-degraded", {
        transactionId,
        commitState: "not-applied",
        exposeSnapshot: false,
      });
    }
    if (collision) {
      return buildProfileSettingsServiceResult("collision", {
        transactionId,
        collisionSources: collision.sources,
      });
    }

    try {
      await runtimeSettingsStore.reconcileVersionedForProtocol(
        profileId,
        loaded.snapshot,
      );
    } catch {
      return buildProfileSettingsServiceResult("runtime-degraded", {
        ...loaded,
        transactionId,
        commitState: "not-applied",
      });
    }

    if (precondition.settingsEpoch !== loaded.snapshot.settingsEpoch) {
      return buildProfileSettingsServiceResult("conflict", {
        ...loaded,
        transactionId,
        reason: "profile-recreated",
      });
    }
    if (precondition.settingsRevision !== loaded.snapshot.settingsRevision) {
      return buildProfileSettingsServiceResult("conflict", {
        ...loaded,
        transactionId,
      });
    }

    let tentative;
    try {
      tentative = await profileStore.compareAndWriteTentativeSettingsForProtocol(
        profileId,
        {
          expectedSnapshot: loaded.snapshot,
          patch,
        },
      );
    } catch (error) {
      if (
        error?.code === "PROFILE_SETTINGS_TENTATIVE_WRITE_UNKNOWN"
        && error?.tentativeResult
      ) {
        return settleTentativeWriteFailure({
          profileId,
          transactionId,
          tentative: error.tentativeResult,
        });
      }
      return mapMutationReadError(error, transactionId);
    }
    if (!tentative.matched) {
      try {
        await runtimeSettingsStore.reconcileVersionedForProtocol(
          profileId,
          tentative.snapshot,
        );
      } catch {
        return buildProfileSettingsServiceResult("runtime-degraded", {
          ...tentative,
          transactionId,
          commitState: "not-applied",
        });
      }
      return buildProfileSettingsServiceResult("conflict", {
        ...tentative,
        transactionId,
        ...(tentative.snapshot.settingsEpoch !== precondition.settingsEpoch
          ? { reason: "profile-recreated" }
          : {}),
      });
    }
    if (!tentative.applied) {
      return buildProfileSettingsServiceResult("no-op", {
        ...tentative,
        transactionId,
      });
    }

    try {
      await runtimeSettingsStore.publishVersionedForProtocol(
        profileId,
        tentative.snapshot,
      );
      return buildProfileSettingsServiceResult("committed", {
        ...tentative,
        transactionId,
      });
    } catch {
      return settlePublishFailure({
        profileId,
        transactionId,
        tentative,
      });
    }
  }

  async function settlePublishFailure({ profileId, transactionId, tentative }) {
    try {
      const comparison = await runtimeSettingsStore.compareVersionedForProtocol(
        profileId,
        tentative.snapshot,
      );
      if (comparison.classification === "synced") {
        return buildProfileSettingsServiceResult("committed", {
          ...tentative,
          transactionId,
        });
      }
    } catch {
      // The unique terminal decision below will use profile evidence only.
    }

    try {
      const rollback = await profileStore.conditionalRollbackSettingsForProtocol(
        profileId,
        {
          tentativeSnapshot: tentative.snapshot,
          previousSnapshot: tentative.previousSnapshot,
        },
      );
      if (rollback.rolledBack) {
        try {
          await runtimeSettingsStore.reconcileVersionedForProtocol(
            profileId,
            tentative.previousSnapshot,
          );
          return buildProfileSettingsServiceResult("rolled-back", {
            ...rollback,
            transactionId,
          });
        } catch {
          // Re-read both sides before deciding unknown below.
        }
      }
    } catch {
      // Re-read both sides before deciding committed-degraded or unknown.
    }

    let current;
    try {
      current = await profileStore.readSettingsStateForProtocol(profileId);
    } catch {
      return unknownResult(transactionId);
    }
    if (snapshotsEqual(current.snapshot, tentative.previousSnapshot)) {
      try {
        const oldRuntime = await runtimeSettingsStore.compareVersionedForProtocol(
          profileId,
          tentative.previousSnapshot,
        );
        if (oldRuntime.classification === "synced") {
          return buildProfileSettingsServiceResult("rolled-back", {
            ...current,
            transactionId,
          });
        }
      } catch {
        return unknownResult(transactionId);
      }
      return unknownResult(transactionId);
    }
    if (snapshotsEqual(current.snapshot, tentative.snapshot)) {
      return buildProfileSettingsServiceResult("runtime-degraded", {
        ...current,
        transactionId,
        commitState: "profile-committed-runtime-degraded",
      });
    }
    return unknownResult(transactionId);
  }

  async function settleTentativeWriteFailure({
    profileId,
    transactionId,
    tentative,
  }) {
    let current;
    try {
      current = await profileStore.readSettingsStateForProtocol(profileId);
    } catch {
      return unknownResult(transactionId);
    }
    if (snapshotsEqual(current.snapshot, tentative.previousSnapshot)) {
      return buildProfileSettingsServiceResult("runtime-degraded", {
        ...current,
        transactionId,
        commitState: "not-applied",
      });
    }
    if (!snapshotsEqual(current.snapshot, tentative.snapshot)) {
      return unknownResult(transactionId);
    }
    const verifiedTentative = {
      ...tentative,
      profile: current.profile,
      snapshot: current.snapshot,
    };
    try {
      await runtimeSettingsStore.publishVersionedForProtocol(
        profileId,
        verifiedTentative.snapshot,
      );
      return buildProfileSettingsServiceResult("committed", {
        ...verifiedTentative,
        transactionId,
      });
    } catch {
      return settlePublishFailure({
        profileId,
        transactionId,
        tentative: verifiedTentative,
      });
    }
  }

  async function inspectCollision(profileId) {
    const inspection = await inspectCanonicalSources(profileId);
    if (inspection?.status === "clear") return null;
    if (inspection?.status !== "collision") {
      throw new TypeError("Canonical source inspection must be clear or collision");
    }
    return {
      sources: sanitizeCollisionSources(inspection.sources),
    };
  }

  return Object.freeze({
    readCommittedAlreadyCoordinated,
    mutateAlreadyCoordinated,
  });
}

export function createProfileSettingsService(options = {}) {
  const kernel = options.kernel;
  const runCoordinated = options.runCoordinated;
  assertMethod(kernel, "readCommittedAlreadyCoordinated");
  assertMethod(kernel, "mutateAlreadyCoordinated");
  if (typeof runCoordinated !== "function") {
    throw new TypeError("runCoordinated is required");
  }
  const committedFlights = new Map();

  async function mutate(input) {
    const prepared = prepareProfileSettingsMutation(input);
    if (!prepared.ok) return prepared.result;
    return mutatePrepared(prepared.prepared);
  }

  async function mutatePrepared(prepared) {
    if (
      !prepared
      || !isCanonicalProfileSettingsId(prepared.profileId)
      || !isValidProfileSettingsTransactionId(prepared.transactionId)
      || !isPreparedPrecondition(prepared.precondition)
      || !isPreparedPatch(prepared.patch)
    ) {
      throw new TypeError("A completed profile settings mutation is required");
    }
    try {
      return await runCoordinated(
        prepared.profileId,
        () => kernel.mutateAlreadyCoordinated(prepared),
      );
    } catch {
      return unknownResult(prepared.transactionId);
    }
  }

  function readCommitted(profileId) {
    if (!isCanonicalProfileSettingsId(profileId)) {
      return Promise.resolve(
        buildProfileSettingsServiceResult("invalid-profile-id"),
      );
    }
    const active = committedFlights.get(profileId);
    if (active) return active;
    const promise = Promise.resolve()
      .then(() => runCoordinated(
        profileId,
        () => kernel.readCommittedAlreadyCoordinated(profileId),
      ))
      .catch(() => buildProfileSettingsServiceResult("read-degraded"));
    const tracked = promise.finally(() => {
      if (committedFlights.get(profileId) === tracked) {
        committedFlights.delete(profileId);
      }
    });
    committedFlights.set(profileId, tracked);
    return tracked;
  }

  return Object.freeze({
    mutate,
    mutatePrepared,
    readCommitted,
  });
}

function mapMutationReadError(error, transactionId) {
  if (error?.code === "ENOENT" || error?.code === "PROFILE_NOT_FOUND") {
    return buildProfileSettingsServiceResult("missing", { transactionId });
  }
  if (
    error?.code === "PROFILE_SETTINGS_EPOCH_INVALID"
    || error?.code === "PROFILE_SETTINGS_REVISION_INVALID"
  ) {
    return buildProfileSettingsServiceResult("state-invalid", {
      transactionId,
      error: error.code,
    });
  }
  if (error?.code === "INVALID_PROFILE_SETTINGS") {
    return buildProfileSettingsServiceResult("invalid-settings", {
      transactionId,
      message: error?.message,
    });
  }
  return buildProfileSettingsServiceResult("runtime-degraded", {
    transactionId,
    commitState: "not-applied",
    exposeSnapshot: false,
  });
}

function mapReadError(error) {
  if (error?.code === "ENOENT" || error?.code === "PROFILE_NOT_FOUND") {
    return buildProfileSettingsServiceResult("read-missing");
  }
  if (
    error?.code === "PROFILE_SETTINGS_EPOCH_INVALID"
    || error?.code === "PROFILE_SETTINGS_REVISION_INVALID"
  ) {
    return buildProfileSettingsServiceResult("state-invalid", {
      error: error.code,
    });
  }
  return buildProfileSettingsServiceResult("read-degraded");
}

function unknownResult(transactionId) {
  return buildProfileSettingsServiceResult("runtime-degraded", {
    transactionId,
    commitState: "unknown",
    exposeSnapshot: false,
  });
}

function snapshotsEqual(left, right) {
  return Boolean(
    left
    && right
    && left.settingsEpoch === right.settingsEpoch
    && left.settingsRevision === right.settingsRevision
    && PROFILE_SETTINGS_CANONICAL_KEYS.every(
      (key) => (
        left.settings?.[key] === right.settings?.[key]
        && left.settingsKeyRevisions?.[key] === right.settingsKeyRevisions?.[key]
      ),
    )
  );
}

function sanitizeCollisionSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources.map((source) => ({
    kind: typeof source?.kind === "string" ? source.kind : "unknown",
    profileId: typeof source?.profileId === "string" ? source.profileId : null,
    active: source?.active === true,
  }));
}

function isPreparedPrecondition(value) {
  return Boolean(
    value
    && isProfileSettingsEpoch(value.settingsEpoch)
    && isProfileSettingsRevision(value.settingsRevision)
  );
}

function isPreparedPatch(value) {
  try {
    const canonical = canonicalizeProfileSettingsPatch(value);
    const keys = Object.keys(value);
    return keys.length === Object.keys(canonical).length
      && keys.every(
        (key) => PROFILE_SETTINGS_CANONICAL_KEYS.includes(key)
          && Object.is(value[key], canonical[key]),
      );
  } catch {
    return false;
  }
}

function assertMethod(value, method) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`${method} is required`);
  }
}
