import fsp from "node:fs/promises";
import path from "node:path";

import { sanitizeProfileId } from "./profile-store.mjs";
import {
  isCanonicalProfileSettingsId,
  isProfileSettingsEpoch,
} from "./profile-settings-protocol.mjs";

const RECOVERY_DELAYS_MS = Object.freeze([2_000, 5_000, 15_000, 30_000, 60_000]);
const RECOVERABLE_RUNTIME_REASONS = new Set([
  "pid-not-found",
  "worker-error",
  "worker-handle-not-found",
  "runtime-temporary",
  "transient-runtime",
]);

export function shouldAutoRecover(exit = {}, desired = {}) {
  if (exit.mode !== "loop" || desired.desiredState !== "running") return false;
  if (exit.reason === "session-expired" && exit.category === "login-state") {
    return Math.max(0, Math.floor(Number(desired.restartAttempt) || 0)) === 0;
  }
  if (exit.category === "network" || exit.category === "stalled") return true;
  if (exit.category === "worker" || exit.category === "process") {
    return RECOVERABLE_RUNTIME_REASONS.has(exit.reason);
  }
  return exit.category === "runtime" && RECOVERABLE_RUNTIME_REASONS.has(exit.reason);
}

export function getRecoveryDelayMs(attempt) {
  const normalizedAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  if (normalizedAttempt <= RECOVERY_DELAYS_MS.length) {
    return RECOVERY_DELAYS_MS[normalizedAttempt - 1];
  }
  const extended = 60_000 * (2 ** (normalizedAttempt - RECOVERY_DELAYS_MS.length));
  return Math.min(300_000, extended);
}

export function createDesiredRunStore(options = {}) {
  const runtimeDir = options.runtimeDir || path.join(process.cwd(), "runtime");
  const fs = options.fs || fsp;
  const now = options.now || (() => new Date());
  const dir = options.dir || path.join(runtimeDir, "system", "desired-runs");
  const retryDelayMs = Math.max(0, Math.floor(Number(options.retryDelayMs ?? 50)));
  const maxWriteAttempts = Math.max(1, Math.floor(Number(options.maxWriteAttempts ?? 8)));
  const waitFn = options.waitFn || delay;
  const writeQueues = new Map();

  function filePath(profileId) {
    const id = normalizeProfileId(profileId);
    return path.join(dir, `${encodeURIComponent(id)}.json`);
  }

  async function read(profileId) {
    return await readUnlocked(profileId);
  }

  async function readUnlocked(profileId) {
    try {
      return normalizeRecord(JSON.parse(await fs.readFile(filePath(profileId), "utf8")));
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  async function list() {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.toLowerCase().endsWith(".json"))
        .map(async (name) => {
          try {
            return normalizeRecord(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
          } catch {
            return null;
          }
        }),
    );
    return records.filter(Boolean).sort((a, b) => a.profileId.localeCompare(b.profileId));
  }

  async function write(profileId, patch = {}) {
    const id = normalizeProfileId(profileId);
    return await enqueueDesiredOperation(id, () => writeUnlocked(id, patch));
  }

  async function writeUnlocked(id, patch, options = {}) {
    const previous = options.previous === undefined
      ? await readUnlocked(id)
      : options.previous;
    const record = normalizeRecord({
      ...(previous || {}),
      ...patch,
      version: 1,
      profileId: id,
      mode: "loop",
      updatedAt: options.updatedAt || now().toISOString(),
    });
    await fs.mkdir(dir, { recursive: true });
    const target = filePath(id);
    const temp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    try {
      for (let attempt = 1; attempt <= maxWriteAttempts; attempt++) {
        try {
          await fs.rename(temp, target);
          return record;
        } catch (err) {
          if (!isRetryableWindowsRenameError(err) || attempt >= maxWriteAttempts) throw err;
          await waitFn(retryDelayMs * attempt);
        }
      }
      return record;
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  function enqueueDesiredOperation(profileId, operation) {
    const queueKey = canonicalQueueKey(profileId);
    const previousWrite = writeQueues.get(queueKey) || Promise.resolve();
    let tracked;
    const current = previousWrite.catch(() => {}).then(operation);
    tracked = current.finally(() => {
      if (writeQueues.get(queueKey) === tracked) writeQueues.delete(queueKey);
    });
    writeQueues.set(queueKey, tracked);
    return tracked;
  }

  function readForProtocol(profileId) {
    assertCanonicalProtocolProfileId(profileId);
    return enqueueDesiredOperation(profileId, () => readProtocolUnlocked(profileId));
  }

  function writeForProtocol(profileId, patch = {}) {
    assertCanonicalProtocolProfileId(profileId);
    assertProtocolPatch(patch);
    return enqueueDesiredOperation(profileId, async () => {
      const previous = await readProtocolUnlocked(profileId);
      const updatedAt = nextProtocolUpdatedAt(previous, now);
      const candidate = buildCandidateRecord(profileId, previous, patch, updatedAt);
      assertProtocolCandidate(previous, candidate);
      return await writeUnlocked(profileId, patch, { previous, updatedAt });
    });
  }

  function conditionalWriteForProtocol(profileId, options = {}) {
    assertCanonicalProtocolProfileId(profileId);
    const patch = options.patch || {};
    assertProtocolPatch(patch);
    return enqueueDesiredOperation(profileId, async () => {
      const previous = await readProtocolUnlocked(profileId);
      if (!matchesProtocolExpectation(previous, options)) {
        return { matched: false, record: previous };
      }
      const updatedAt = nextProtocolUpdatedAt(previous, now);
      const candidate = buildCandidateRecord(profileId, previous, patch, updatedAt);
      assertProtocolCandidate(previous, candidate);
      const record = await writeUnlocked(profileId, patch, { previous, updatedAt });
      return { matched: true, record };
    });
  }

  async function readProtocolUnlocked(profileId) {
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(filePath(profileId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        error.code = "DESIRED_RUN_STATE_INVALID";
      }
      throw error;
    }
    assertProtocolRawRecord(parsed, profileId);
    return normalizeRecord(parsed);
  }

  function runCanonicalMigrationExclusive(profileId, operation) {
    assertCanonicalProtocolProfileId(profileId);
    if (typeof operation !== "function") {
      throw new TypeError("A canonical migration operation is required");
    }
    return enqueueDesiredOperation(profileId, () => operation({
      kind: "desired",
      directory: dir,
      targetPath: filePath(profileId),
    }));
  }

  return {
    runtimeDir,
    dir,
    filePath,
    read,
    list,
    write,
    readForProtocol,
    writeForProtocol,
    conditionalWriteForProtocol,
    runCanonicalMigrationExclusive,
  };
}

function isRetryableWindowsRenameError(error) {
  return ["EPERM", "EBUSY", "EACCES"].includes(error?.code);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeRecord(value) {
  if (!value || typeof value !== "object") return null;
  const profileId = String(value.profileId || "").trim();
  if (!profileId) return null;
  const desiredState = value.desiredState === "running" ? "running" : "stopped";
  const restartAttempt = Math.max(0, Math.floor(Number(value.restartAttempt) || 0));
  return {
    version: 1,
    profileId,
    mode: "loop",
    desiredState,
    restartAttempt,
    recoveryStatus: normalizeNullableText(value.recoveryStatus),
    nextRetryAt: normalizeNullableText(value.nextRetryAt),
    lastReason: normalizeNullableText(value.lastReason),
    updatedAt: normalizeNullableText(value.updatedAt),
    ...(Object.hasOwn(value, "settingsEpoch")
      ? { settingsEpoch: normalizeNullableText(value.settingsEpoch) }
      : {}),
  };
}

function normalizeProfileId(value) {
  const id = String(value || "").trim();
  if (!id) throw new Error("profileId is required");
  return id;
}

function canonicalQueueKey(value) {
  const id = normalizeProfileId(value);
  return sanitizeProfileId(id);
}

function assertCanonicalProtocolProfileId(profileId) {
  if (!isCanonicalProfileSettingsId(profileId)) {
    const error = new Error("Profile ID must already be canonical");
    error.code = "INVALID_PROFILE_ID_CANONICAL_FORM";
    throw error;
  }
}

const PROTOCOL_PATCH_KEYS = new Set([
  "desiredState",
  "restartAttempt",
  "recoveryStatus",
  "nextRetryAt",
  "lastReason",
  "settingsEpoch",
]);
const PROTOCOL_RECORD_KEYS = new Set([
  "version",
  "profileId",
  "mode",
  ...PROTOCOL_PATCH_KEYS,
  "updatedAt",
]);
const PROTOCOL_RECOVERY_STATUSES = new Set([
  null,
  "starting",
  "running",
  "scheduled",
  "blocked",
  "stopped",
]);

function assertProtocolPatch(patch) {
  if (!isPlainRecord(patch) || Object.keys(patch).some((key) => !PROTOCOL_PATCH_KEYS.has(key))) {
    const error = new TypeError("Desired-run protocol patch contains an unsupported field");
    error.code = "INVALID_DESIRED_RUN_PATCH";
    throw error;
  }
}

function buildCandidateRecord(profileId, previous, patch, updatedAt) {
  const merged = {
    ...(previous || {}),
    ...patch,
  };
  return {
    version: 1,
    profileId,
    mode: "loop",
    desiredState: ownValueOrDefault(merged, "desiredState", "stopped"),
    restartAttempt: ownValueOrDefault(merged, "restartAttempt", 0),
    recoveryStatus: ownValueOrDefault(merged, "recoveryStatus", null),
    nextRetryAt: ownValueOrDefault(merged, "nextRetryAt", null),
    lastReason: ownValueOrDefault(merged, "lastReason", null),
    updatedAt,
    ...(Object.hasOwn(merged, "settingsEpoch")
      ? { settingsEpoch: merged.settingsEpoch }
      : {}),
  };
}

function nextProtocolUpdatedAt(previous, now) {
  const current = now();
  const currentMilliseconds = current instanceof Date ? current.getTime() : Number.NaN;
  if (!Number.isFinite(currentMilliseconds)) {
    throw new TypeError("Desired-run protocol clock must return a valid Date");
  }
  const previousMilliseconds = typeof previous?.updatedAt === "string"
    ? Date.parse(previous.updatedAt)
    : Number.NaN;
  const nextMilliseconds = Number.isFinite(previousMilliseconds)
    ? Math.max(currentMilliseconds, previousMilliseconds + 1)
    : currentMilliseconds;
  return new Date(nextMilliseconds).toISOString();
}

function assertProtocolRawRecord(record, profileId) {
  const validNullableText = (value) => (
    value === undefined || value === null || typeof value === "string"
  );
  const valid = Boolean(
    isPlainRecord(record)
    && Object.keys(record).every((key) => PROTOCOL_RECORD_KEYS.has(key))
    && (record.version === undefined || record.version === 1)
    && record.profileId === profileId
    && (record.mode === undefined || record.mode === "loop")
    && ["running", "stopped"].includes(record.desiredState)
    && Number.isSafeInteger(record.restartAttempt)
    && record.restartAttempt >= 0
    && validNullableText(record.recoveryStatus)
    && validNullableText(record.nextRetryAt)
    && validNullableText(record.lastReason)
    && validNullableText(record.updatedAt)
    && (
      !Object.hasOwn(record, "settingsEpoch")
      || isProfileSettingsEpoch(record.settingsEpoch)
    )
  );
  if (valid) return;
  const error = new Error("Desired-run protocol state is invalid or not canonically owned");
  error.code = record?.profileId !== profileId
    ? "PROFILE_ID_CANONICAL_COLLISION"
    : "DESIRED_RUN_STATE_INVALID";
  throw error;
}

function assertProtocolCandidate(previous, candidate) {
  const validShape = Boolean(
    isPlainRecord(candidate)
    && Object.keys(candidate).every((key) => PROTOCOL_RECORD_KEYS.has(key))
    && candidate.version === 1
    && isCanonicalProfileSettingsId(candidate.profileId)
    && candidate.mode === "loop"
    && ["running", "stopped"].includes(candidate.desiredState)
    && Number.isSafeInteger(candidate.restartAttempt)
    && candidate.restartAttempt >= 0
    && PROTOCOL_RECOVERY_STATUSES.has(candidate.recoveryStatus)
    && isNullableText(candidate.nextRetryAt)
    && isNullableText(candidate.lastReason)
    && isNullableText(candidate.updatedAt)
  );
  if (!validShape) {
    const error = new Error("Desired-run protocol candidate is invalid");
    error.code = "DESIRED_RUN_STATE_INVALID";
    throw error;
  }
  if (isProfileSettingsEpoch(candidate?.settingsEpoch)) return;
  const mayKeepMissingLegacy = Boolean(
    previous
    && !Object.hasOwn(previous, "settingsEpoch")
    && !Object.hasOwn(candidate || {}, "settingsEpoch")
    && candidate.desiredState === "stopped",
  );
  if (mayKeepMissingLegacy) return;
  const error = new Error("A valid settings epoch is required for desired-run protocol writes");
  error.code = "PROFILE_SETTINGS_EPOCH_INVALID";
  throw error;
}

function ownValueOrDefault(record, key, fallback) {
  return Object.hasOwn(record, key) ? record[key] : fallback;
}

function isNullableText(value) {
  return value === null || typeof value === "string";
}

function matchesProtocolExpectation(record, options) {
  if (!record) return false;
  return [
    ["expectedUpdatedAt", "updatedAt"],
    ["expectedSettingsEpoch", "settingsEpoch"],
    ["expectedDesiredState", "desiredState"],
    ["expectedRecoveryStatus", "recoveryStatus"],
    ["expectedRestartAttempt", "restartAttempt"],
    ["expectedNextRetryAt", "nextRetryAt"],
  ].every(([expectedKey, recordKey]) => (
    !Object.hasOwn(options, expectedKey)
    || Object.is(options[expectedKey], record[recordKey])
  ));
}

function isPlainRecord(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeNullableText(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}
