import {
  DEFAULT_PROFILE_SETTINGS,
  PROFILE_SETTING_INPUT_KEYS,
  mergeProfileSettings,
  sanitizeProfileId,
} from "./profile-store.mjs";

export const PROFILE_SETTINGS_PROTOCOL_VERSION = 2;
export const PROFILE_SETTINGS_CANONICAL_KEYS = Object.freeze(
  Object.keys(DEFAULT_PROFILE_SETTINGS),
);

const LEGACY_SETTING_ALIASES = Object.freeze({
  autoSubmitOrdinaryResidentOrders: "autoSubmitOrdinaryResidentOrdersForLevelUp",
});
const INPUT_KEYS = new Set(PROFILE_SETTING_INPUT_KEYS);
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const IF_MATCH_PATTERN = /^"([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(0|[1-9][0-9]*)"$/i;

export function isProfileSettingsEpoch(value) {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

export function isProfileSettingsRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isValidProfileSettingsTransactionId(value) {
  return typeof value === "string" && TRANSACTION_ID_PATTERN.test(value);
}

export function isCanonicalProfileSettingsId(value) {
  return typeof value === "string" && value.length > 0 && sanitizeProfileId(value) === value;
}

export function parseProfileSettingsIfMatch(value) {
  if (typeof value !== "string") return null;
  const match = IF_MATCH_PATTERN.exec(value);
  if (!match) return null;
  const settingsRevision = Number(match[2]);
  if (!isProfileSettingsRevision(settingsRevision)) return null;
  return {
    settingsEpoch: match[1],
    settingsRevision,
  };
}

export function normalizeCanonicalProfileSettings(settings = {}) {
  const merged = mergeProfileSettings(DEFAULT_PROFILE_SETTINGS, settings || {});
  return Object.fromEntries(
    PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => [key, merged[key]]),
  );
}

export function canonicalizeProfileSettingsPatch(input) {
  if (!isPlainObject(input) || Object.keys(input).length === 0) {
    throw invalidSettingsError("Profile settings patch must be a non-empty object");
  }
  const keys = Object.keys(input);
  if (keys.some((key) => !INPUT_KEYS.has(key))) {
    throw invalidSettingsError("Profile settings patch contains an unsupported key");
  }

  let merged;
  try {
    merged = mergeProfileSettings(DEFAULT_PROFILE_SETTINGS, input);
  } catch (error) {
    if (error?.code === "INVALID_PROFILE_SETTINGS") throw error;
    throw invalidSettingsError(error?.message || "Invalid profile settings patch");
  }

  const canonicalPatch = {};
  for (const inputKey of keys) {
    const canonicalKey = LEGACY_SETTING_ALIASES[inputKey] || inputKey;
    if (
      inputKey in LEGACY_SETTING_ALIASES
      && Object.hasOwn(input, canonicalKey)
    ) {
      continue;
    }
    canonicalPatch[canonicalKey] = merged[canonicalKey];
  }
  return canonicalPatch;
}

export function buildProfileSettingsServiceResult(kind, options = {}) {
  const transactionId = isValidProfileSettingsTransactionId(options.transactionId)
    ? options.transactionId
    : null;
  if (
    [
      "committed",
      "no-op",
      "invalid-settings",
      "missing",
      "conflict",
      "rolled-back",
      "runtime-degraded",
    ].includes(kind)
    && !transactionId
  ) {
    throw new TypeError(`A valid transaction ID is required for ${kind}`);
  }
  switch (kind) {
    case "committed":
      return {
        statusCode: 200,
        body: {
          ...snapshotBody(options.snapshot, options.profile),
          ...(transactionId ? { transactionId } : {}),
          applied: true,
          commitState: "committed",
          runtimeSyncStatus: "synced",
        },
      };
    case "no-op":
      return {
        statusCode: 200,
        body: {
          ...snapshotBody(options.snapshot, options.profile),
          ...(transactionId ? { transactionId } : {}),
          applied: false,
          commitState: "not-applied",
          runtimeSyncStatus: "synced",
        },
      };
    case "read-synced":
      return {
        statusCode: 200,
        body: {
          ...snapshotBody(options.snapshot, options.profile),
          runtimeSyncStatus: "synced",
        },
      };
    case "invalid-profile-id":
      return {
        statusCode: 400,
        body: {
          error: "INVALID_PROFILE_ID_CANONICAL_FORM",
          message: "Profile ID must already be in canonical form",
        },
      };
    case "invalid-settings":
      return {
        statusCode: 400,
        body: {
          error: "INVALID_PROFILE_SETTINGS",
          ...(transactionId ? { transactionId } : {}),
          commitState: "not-applied",
          ...(options.message ? { message: options.message } : {}),
        },
      };
    case "missing":
      return {
        statusCode: 404,
        body: {
          error: "PROFILE_NOT_FOUND",
          ...(transactionId ? { transactionId } : {}),
          commitState: "not-applied",
        },
      };
    case "read-missing":
      return {
        statusCode: 404,
        body: {
          error: "PROFILE_NOT_FOUND",
        },
      };
    case "precondition":
      return {
        statusCode: 428,
        body: {
          error: "PROFILE_SETTINGS_PRECONDITION_REQUIRED",
          settingsProtocolVersion: PROFILE_SETTINGS_PROTOCOL_VERSION,
          ...(transactionId ? { transactionId } : {}),
          commitState: "not-applied",
          requiredPrecondition: "If-Match + X-XJSKP-Settings-Transaction-Id",
          message: "Refresh the page and use a matching settings protocol version",
        },
      };
    case "conflict":
      return {
        statusCode: 409,
        body: {
          error: "PROFILE_SETTINGS_CONFLICT",
          ...snapshotBody(options.snapshot, options.profile),
          ...(transactionId ? { transactionId } : {}),
          commitState: "not-applied",
          runtimeSyncStatus: "synced",
          ...(options.reason ? { reason: options.reason } : {}),
        },
      };
    case "collision":
      return {
        statusCode: 409,
        body: {
          error: "PROFILE_ID_CANONICAL_COLLISION",
          ...(transactionId ? { transactionId } : {}),
          ...(transactionId ? { commitState: "not-applied" } : {}),
          runtimeSyncStatus: "degraded",
          collisionSources: Array.isArray(options.collisionSources)
            ? [...options.collisionSources]
            : [],
        },
      };
    case "rolled-back":
      return {
        statusCode: 503,
        body: {
          error: "PROFILE_SETTINGS_RUNTIME_PUBLISH_FAILED",
          ...snapshotBody(options.snapshot, options.profile),
          ...(transactionId ? { transactionId } : {}),
          commitState: "rolled-back",
          runtimeSyncStatus: "synced",
        },
      };
    case "runtime-degraded": {
      const commitState = [
        "not-applied",
        "profile-committed-runtime-degraded",
        "unknown",
      ].includes(options.commitState)
        ? options.commitState
        : "unknown";
      const mayExposeSnapshot =
        commitState !== "unknown"
        && options.snapshot
        && options.exposeSnapshot !== false;
      return {
        statusCode: 503,
        body: {
          error: "PROFILE_SETTINGS_RUNTIME_DEGRADED",
          ...(mayExposeSnapshot ? snapshotBody(options.snapshot, options.profile) : {}),
          ...(transactionId ? { transactionId } : {}),
          commitState,
          runtimeSyncStatus: "degraded",
        },
      };
    }
    case "read-degraded":
      return {
        statusCode: 503,
        body: {
          error: "PROFILE_SETTINGS_RUNTIME_DEGRADED",
          ...(options.snapshot && options.exposeSnapshot !== false
            ? snapshotBody(options.snapshot, options.profile)
            : {}),
          runtimeSyncStatus: "degraded",
        },
      };
    case "state-invalid":
      return {
        statusCode: 503,
        body: {
          error: options.error === "PROFILE_SETTINGS_EPOCH_INVALID"
            ? "PROFILE_SETTINGS_EPOCH_INVALID"
            : "PROFILE_SETTINGS_REVISION_INVALID",
          ...(transactionId ? { transactionId } : {}),
          ...(transactionId ? { commitState: "not-applied" } : {}),
          runtimeSyncStatus: "degraded",
        },
      };
    default:
      throw new TypeError(`Unsupported profile settings service result: ${kind}`);
  }
}

function snapshotBody(snapshot, profile = null) {
  assertSnapshot(snapshot);
  return {
    settingsProtocolVersion: PROFILE_SETTINGS_PROTOCOL_VERSION,
    ...(profile ? { profile: safeProfile(profile, snapshot) } : {}),
    settings: { ...snapshot.settings },
    settingsEpoch: snapshot.settingsEpoch,
    settingsRevision: snapshot.settingsRevision,
    settingsKeyRevisions: { ...snapshot.settingsKeyRevisions },
  };
}

function safeProfile(profile, snapshot) {
  const safe = {};
  for (const key of [
    "id",
    "label",
    "pcUserId",
    "createdAt",
    "updatedAt",
    "lastValidatedAt",
    "serverIdx",
    "serverText",
    "hasCredentials",
    "missingFields",
  ]) {
    if (Object.hasOwn(profile, key)) {
      safe[key] = Array.isArray(profile[key]) ? [...profile[key]] : profile[key];
    }
  }
  return {
    ...safe,
    settings: { ...snapshot.settings },
    settingsEpoch: snapshot.settingsEpoch,
    settingsRevision: snapshot.settingsRevision,
    settingsKeyRevisions: { ...snapshot.settingsKeyRevisions },
  };
}

function assertSnapshot(snapshot) {
  let normalizedSettings = null;
  try {
    normalizedSettings = snapshot?.settings
      ? normalizeCanonicalProfileSettings(snapshot.settings)
      : null;
  } catch {
    normalizedSettings = null;
  }
  const valid = Boolean(
    snapshot
    && isProfileSettingsEpoch(snapshot.settingsEpoch)
    && isProfileSettingsRevision(snapshot.settingsRevision)
    && isPlainObject(snapshot.settings)
    && Object.keys(snapshot.settings).length === PROFILE_SETTINGS_CANONICAL_KEYS.length
    && PROFILE_SETTINGS_CANONICAL_KEYS.every(
      (key) => (
        Object.hasOwn(snapshot.settings, key)
        && jsonScalarEqual(snapshot.settings[key], normalizedSettings?.[key])
      ),
    )
    && isPlainObject(snapshot.settingsKeyRevisions)
    && Object.keys(snapshot.settingsKeyRevisions).length === PROFILE_SETTINGS_CANONICAL_KEYS.length
    && PROFILE_SETTINGS_CANONICAL_KEYS.every(
      (key) => (
        Object.hasOwn(snapshot.settingsKeyRevisions, key)
        && isProfileSettingsRevision(snapshot.settingsKeyRevisions[key])
        && snapshot.settingsKeyRevisions[key] <= snapshot.settingsRevision
      ),
    )
  );
  if (!valid) {
    throw new TypeError("A complete profile settings snapshot is required");
  }
}

function invalidSettingsError(message) {
  const error = new Error(message);
  error.code = "INVALID_PROFILE_SETTINGS";
  error.statusCode = 400;
  return error;
}

function isPlainObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonScalarEqual(left, right) {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}
