import fs from "node:fs/promises";
import path from "node:path";

import {
  normalizeProfileSettings,
  sanitizeProfileId,
} from "./profile-store.mjs";
import {
  PROFILE_SETTINGS_CANONICAL_KEYS,
  isProfileSettingsEpoch,
  isProfileSettingsRevision,
  normalizeCanonicalProfileSettings,
} from "./profile-settings-protocol.mjs";

export function createRuntimeSettingsStore(options = {}) {
  const runtimeDir = options.runtimeDir || path.join(process.cwd(), "runtime");
  const fileSystem = options.fs || fs;
  const onWriteQueued = options.onWriteQueued || (() => {});
  const writeQueues = new Map();
  const versionedReconcileFlights = new Map();

  function settingsPath(profileId) {
    return path.join(runtimeDir, "settings", `${profileId}.json`);
  }

  function write(profileId, settings = {}) {
    const current = enqueueRuntimeOperation(profileId, async () => {
      await writeJsonAtomic(
        settingsPath(profileId),
        normalizeProfileSettings(settings),
      );
    });
    onWriteQueued(profileId);
    return current;
  }

  function enqueueRuntimeOperation(profileId, operation) {
    const queueKey = canonicalQueueKey(profileId);
    const previous = writeQueues.get(queueKey) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    let tracked;
    tracked = current.finally(() => {
      if (writeQueues.get(queueKey) === tracked) writeQueues.delete(queueKey);
    });
    writeQueues.set(queueKey, tracked);
    return tracked;
  }

  async function writeJsonAtomic(filePath, value) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fileSystem.writeFile(
        tmpPath,
        `${JSON.stringify(value, null, 2)}\n`,
        "utf8",
      );
      await fileSystem.rename(tmpPath, filePath);
    } finally {
      await fileSystem.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  function readVersionedForProtocol(profileId) {
    assertCanonicalProtocolProfileId(profileId);
    return enqueueRuntimeOperation(profileId, () => readRuntimeFile(profileId));
  }

  function compareVersionedForProtocol(profileId, expectedSnapshot) {
    assertCanonicalProtocolProfileId(profileId);
    assertVersionedSnapshot(expectedSnapshot);
    return enqueueRuntimeOperation(profileId, async () => {
      const raw = await readRuntimeFile(profileId);
      return {
        classification: classifyVersionedRuntime(raw, expectedSnapshot),
        raw,
      };
    });
  }

  function publishVersionedForProtocol(profileId, expectedSnapshot) {
    assertCanonicalProtocolProfileId(profileId);
    assertVersionedSnapshot(expectedSnapshot);
    return enqueueRuntimeOperation(profileId, () => writeJsonAtomic(
      settingsPath(profileId),
      serializeVersionedSnapshot(expectedSnapshot),
    ));
  }

  function reconcileVersionedForProtocol(profileId, expectedSnapshot) {
    assertCanonicalProtocolProfileId(profileId);
    assertVersionedSnapshot(expectedSnapshot);
    const signature = versionedSnapshotSignature(expectedSnapshot);
    const active = versionedReconcileFlights.get(profileId);
    if (active) {
      if (active.signature === signature) return active.promise;
      return active.promise.then(
        () => reconcileVersionedForProtocol(profileId, expectedSnapshot),
        () => reconcileVersionedForProtocol(profileId, expectedSnapshot),
      );
    }
    const promise = enqueueRuntimeOperation(profileId, async () => {
      let previousClassification;
      try {
        const raw = await readRuntimeFile(profileId);
        previousClassification = classifyVersionedRuntime(
          raw,
          expectedSnapshot,
        );
      } catch (error) {
        if (error?.code !== "PROFILE_SETTINGS_RUNTIME_INVALID") throw error;
        previousClassification = "content-mismatch";
      }
      if (previousClassification === "synced") {
        return { repaired: false, previousClassification };
      }
      await writeJsonAtomic(
        settingsPath(profileId),
        serializeVersionedSnapshot(expectedSnapshot),
      );
      const verified = await readRuntimeFile(profileId);
      if (classifyVersionedRuntime(verified, expectedSnapshot) !== "synced") {
        const error = new Error("Versioned runtime settings verification failed");
        error.code = "PROFILE_SETTINGS_RUNTIME_DEGRADED";
        throw error;
      }
      return { repaired: true, previousClassification };
    });
    const tracked = promise.finally(() => {
      if (versionedReconcileFlights.get(profileId)?.promise === tracked) {
        versionedReconcileFlights.delete(profileId);
      }
    });
    versionedReconcileFlights.set(profileId, { signature, promise: tracked });
    return tracked;
  }

  async function readRuntimeFile(profileId) {
    try {
      const raw = await fileSystem.readFile(settingsPath(profileId), "utf8");
      const parsed = JSON.parse(raw);
      if (!isPlainRecord(parsed)) {
        const error = new Error("Runtime settings snapshot must be an object");
        error.code = "PROFILE_SETTINGS_RUNTIME_INVALID";
        throw error;
      }
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        error.code = "PROFILE_SETTINGS_RUNTIME_INVALID";
      }
      throw error;
    }
  }

  async function drain(profileId) {
    await (writeQueues.get(canonicalQueueKey(profileId)) || Promise.resolve());
  }

  function runCanonicalMigrationExclusive(profileId, operation) {
    assertCanonicalProtocolProfileId(profileId);
    if (typeof operation !== "function") {
      throw new TypeError("A canonical migration operation is required");
    }
    return enqueueRuntimeOperation(profileId, () => operation({
      kind: "runtime",
      directory: path.join(runtimeDir, "settings"),
      targetPath: settingsPath(profileId),
    }));
  }

  return {
    runtimeDir,
    settingsPath,
    write,
    drain,
    readVersionedForProtocol,
    compareVersionedForProtocol,
    publishVersionedForProtocol,
    reconcileVersionedForProtocol,
    runCanonicalMigrationExclusive,
  };
}

function serializeVersionedSnapshot(snapshot) {
  return {
    ...normalizeCanonicalProfileSettings(snapshot.settings),
    _meta: {
      settingsEpoch: snapshot.settingsEpoch,
      settingsRevision: snapshot.settingsRevision,
    },
  };
}

function classifyVersionedRuntime(raw, expectedSnapshot) {
  if (raw == null) return "missing";
  if (
    !isPlainRecord(raw._meta)
    || !isProfileSettingsEpoch(raw._meta.settingsEpoch)
    || !isProfileSettingsRevision(raw._meta.settingsRevision)
  ) {
    return "legacy";
  }
  if (raw._meta.settingsEpoch !== expectedSnapshot.settingsEpoch) {
    return "epoch-mismatch";
  }
  if (raw._meta.settingsRevision !== expectedSnapshot.settingsRevision) {
    return "revision-mismatch";
  }
  if (!PROFILE_SETTINGS_CANONICAL_KEYS.every((key) => Object.hasOwn(raw, key))) {
    return "content-mismatch";
  }
  let normalized;
  try {
    normalized = normalizeCanonicalProfileSettings(raw);
  } catch {
    return "content-mismatch";
  }
  if (PROFILE_SETTINGS_CANONICAL_KEYS.some(
    (key) => !jsonScalarEqual(raw[key], normalized[key]),
  )) {
    return "content-mismatch";
  }
  return PROFILE_SETTINGS_CANONICAL_KEYS.every(
    (key) => jsonScalarEqual(normalized[key], expectedSnapshot.settings[key]),
  )
    ? "synced"
    : "content-mismatch";
}

function versionedSnapshotSignature(snapshot) {
  return JSON.stringify([
    snapshot.settingsEpoch,
    snapshot.settingsRevision,
    PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => snapshot.settings[key]),
  ]);
}

function assertVersionedSnapshot(snapshot) {
  let normalizedSettings = null;
  try {
    normalizedSettings = snapshot?.settings
      ? normalizeCanonicalProfileSettings(snapshot.settings)
      : null;
  } catch {
    normalizedSettings = null;
  }
  if (
    !snapshot
    || !isProfileSettingsEpoch(snapshot.settingsEpoch)
    || !isProfileSettingsRevision(snapshot.settingsRevision)
    || !isPlainRecord(snapshot.settings)
    || Object.keys(snapshot.settings).length !== PROFILE_SETTINGS_CANONICAL_KEYS.length
    || !PROFILE_SETTINGS_CANONICAL_KEYS.every(
      (key) => (
        Object.hasOwn(snapshot.settings, key)
        && jsonScalarEqual(snapshot.settings[key], normalizedSettings?.[key])
      ),
    )
  ) {
    throw new TypeError("A complete versioned runtime settings snapshot is required");
  }
}

function assertCanonicalProtocolProfileId(profileId) {
  if (
    typeof profileId !== "string"
    || !profileId
    || sanitizeProfileId(profileId) !== profileId
  ) {
    const error = new Error("Profile ID must already be canonical");
    error.code = "INVALID_PROFILE_ID_CANONICAL_FORM";
    throw error;
  }
}

function canonicalQueueKey(profileId) {
  const id = String(profileId ?? "").trim();
  return id ? sanitizeProfileId(id) : id;
}

function isPlainRecord(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonScalarEqual(left, right) {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}
