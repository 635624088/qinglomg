import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const WATERWHEEL_BUCKET_STATE_VERSION = 1;

const PROFILE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeInteger(value, fallback = null) {
  const number = finiteNumber(value, fallback);
  return Number.isSafeInteger(number) ? number : fallback;
}

function positiveInteger(value) {
  const number = safeInteger(value, null);
  return number != null && number > 0 ? number : null;
}

function positiveMilliseconds(value) {
  const seconds = finiteNumber(value, null);
  if (seconds == null || seconds <= 0) return null;
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function resolveNowMs(value) {
  const nowMs = finiteNumber(value, Date.now());
  return Number.isSafeInteger(nowMs) && nowMs >= 0 ? nowMs : Date.now();
}

function normalizeAccountUid(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

export function normalizeWaterwheelProfileId(profileId = "default") {
  const normalized = String(profileId || "default").trim();
  if (!normalized || !PROFILE_ID_PATTERN.test(normalized)) {
    throw new TypeError("Invalid waterwheel bucket profile id");
  }
  return normalized;
}

export function getWaterwheelAccountUid(sync, options = {}) {
  const accountData = sync?.$usrTot?.data
    || sync?.$usrTot?.usr
    || sync?.usrTot?.data
    || sync?.usrTot?.usr
    || {};
  return normalizeAccountUid(
    options.accountUid
      ?? options.uid
      ?? accountData.id
      ?? accountData.uid
      ?? accountData.usrId,
  );
}

export function resolveWaterwheelBucketStatePath({
  statePath,
  settingsPath,
  profileId,
} = {}) {
  if (statePath) return path.resolve(String(statePath));
  if (!settingsPath) return null;
  const normalizedProfileId = normalizeWaterwheelProfileId(profileId);
  const runtimeDir = path.dirname(path.dirname(path.resolve(String(settingsPath))));
  return path.join(
    runtimeDir,
    "system",
    "waterwheel-buckets",
    `${normalizedProfileId}.json`,
  );
}

function getStorageLimits(config = {}, claimedBucketCount = 0) {
  const storedBucketMax = positiveInteger(config.bucketExistMax);
  const maxBucketCount = positiveInteger(config.bucketGetMax);
  const claimed = Math.max(0, safeInteger(claimedBucketCount, 0));
  const dailyRemaining = maxBucketCount == null
    ? 0
    : Math.max(0, maxBucketCount - claimed);
  const storageCapacity = storedBucketMax == null
    ? 0
    : Math.min(storedBucketMax, dailyRemaining);
  return {
    storedBucketMax: storedBucketMax || 0,
    maxBucketCount: maxBucketCount || 0,
    claimedBucketCount: claimed,
    remainingDailyBucketCount: dailyRemaining,
    storageCapacity,
  };
}

function initialNextGenerationAt(nowMs, config) {
  const createCdMs = positiveMilliseconds(config?.bucketCreateCd);
  return createCdMs == null ? null : nowMs + createCdMs;
}

export function createWaterwheelBucketState({
  profileId = "default",
  accountUid = null,
  nowMs = Date.now(),
  config = {},
} = {}) {
  const normalizedProfileId = normalizeWaterwheelProfileId(profileId);
  const normalizedNowMs = resolveNowMs(nowMs);
  return {
    version: WATERWHEEL_BUCKET_STATE_VERSION,
    profileId: normalizedProfileId,
    accountUid: normalizeAccountUid(accountUid),
    storedBucketCount: 0,
    nextGenerationAtMs: initialNextGenerationAt(normalizedNowMs, config),
    lastObservedAtMs: normalizedNowMs,
    updatedAt: new Date(normalizedNowMs).toISOString(),
  };
}

function isValidUpdatedAt(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isValidWaterwheelBucketState(value, {
  profileId,
  accountUid = null,
} = {}) {
  let normalizedProfileId;
  try {
    normalizedProfileId = normalizeWaterwheelProfileId(profileId);
  } catch {
    return false;
  }
  const normalizedAccountUid = normalizeAccountUid(accountUid);
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.version === WATERWHEEL_BUCKET_STATE_VERSION
    && value.profileId === normalizedProfileId
    && normalizeAccountUid(value.accountUid) === normalizedAccountUid
    && Number.isSafeInteger(value.storedBucketCount)
    && value.storedBucketCount >= 0
    && (
      value.nextGenerationAtMs == null
      || (Number.isSafeInteger(value.nextGenerationAtMs) && value.nextGenerationAtMs >= 0)
    )
    && Number.isSafeInteger(value.lastObservedAtMs)
    && value.lastObservedAtMs >= 0
    && isValidUpdatedAt(value.updatedAt),
  );
}

function stateNeedsUpdate(before, after) {
  return [
    "profileId",
    "accountUid",
    "storedBucketCount",
    "nextGenerationAtMs",
    "lastObservedAtMs",
    "updatedAt",
  ].some((key) => before?.[key] !== after?.[key]);
}

function safeProjectionWithoutGeneration(state, {
  claimedBucketCount,
  config,
} = {}) {
  const limits = getStorageLimits(config, claimedBucketCount);
  const storedBucketCount = Math.min(
    Math.max(0, safeInteger(state?.storedBucketCount, 0)),
    limits.storageCapacity,
  );
  const createCdMs = positiveMilliseconds(config?.bucketCreateCd);
  const nextGenerationAtMs = storedBucketCount >= limits.storageCapacity || createCdMs == null
    ? null
    : state?.nextGenerationAtMs ?? null;
  const safeState = {
    ...state,
    storedBucketCount,
    nextGenerationAtMs,
  };
  return {
    state: safeState,
    storedBucketCount,
    generatedBucketCount: 0,
    changed: false,
    clockRolledBack: false,
    ...limits,
  };
}

export function advanceWaterwheelBucketState({
  state,
  profileId = "default",
  accountUid = null,
  claimedBucketCount = 0,
  config = {},
  nowMs = Date.now(),
} = {}) {
  const normalizedProfileId = normalizeWaterwheelProfileId(profileId);
  const normalizedAccountUid = normalizeAccountUid(accountUid);
  const normalizedNowMs = resolveNowMs(nowMs);
  const current = isValidWaterwheelBucketState(state, {
    profileId: normalizedProfileId,
    accountUid: normalizedAccountUid,
  })
    ? state
    : createWaterwheelBucketState({
        profileId: normalizedProfileId,
        accountUid: normalizedAccountUid,
        nowMs: normalizedNowMs,
        config,
      });
  const limits = getStorageLimits(config, claimedBucketCount);
  const createCdMs = positiveMilliseconds(config.bucketCreateCd);
  const beforeStoredBucketCount = current.storedBucketCount;
  let storedBucketCount = Math.min(beforeStoredBucketCount, limits.storageCapacity);
  let nextGenerationAtMs = current.nextGenerationAtMs;
  let generatedBucketCount = 0;
  const clockRolledBack = normalizedNowMs < current.lastObservedAtMs;

  if (storedBucketCount >= limits.storageCapacity || createCdMs == null) {
    nextGenerationAtMs = null;
  } else if (nextGenerationAtMs == null) {
    nextGenerationAtMs = normalizedNowMs + createCdMs;
  } else if (!clockRolledBack && normalizedNowMs >= nextGenerationAtMs) {
    const dueBucketCount = Math.floor((normalizedNowMs - nextGenerationAtMs) / createCdMs) + 1;
    generatedBucketCount = Math.min(
      dueBucketCount,
      Math.max(0, limits.storageCapacity - storedBucketCount),
    );
    storedBucketCount += generatedBucketCount;
    nextGenerationAtMs = storedBucketCount >= limits.storageCapacity
      ? null
      : nextGenerationAtMs + dueBucketCount * createCdMs;
  }

  const lastObservedAtMs = clockRolledBack || generatedBucketCount === 0
    ? current.lastObservedAtMs
    : Math.max(current.lastObservedAtMs, normalizedNowMs);
  const changed = stateNeedsUpdate(current, {
    ...current,
    storedBucketCount,
    nextGenerationAtMs,
    lastObservedAtMs,
  });
  const nextState = {
    ...current,
    version: WATERWHEEL_BUCKET_STATE_VERSION,
    profileId: normalizedProfileId,
    accountUid: normalizedAccountUid,
    storedBucketCount,
    nextGenerationAtMs,
    lastObservedAtMs,
    updatedAt: changed ? new Date(normalizedNowMs).toISOString() : current.updatedAt,
  };

  return {
    state: nextState,
    storedBucketCount,
    generatedBucketCount,
    changed: stateNeedsUpdate(current, nextState),
    clockRolledBack,
    ...limits,
  };
}

function atomicWriteJson(fileSystem, filePath, value, nowMs) {
  const temporaryPath = `${filePath}.${process.pid}.${nowMs}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fileSystem.writeFileSync(`${temporaryPath}`, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fileSystem.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fileSystem.rmSync(temporaryPath, { force: true });
    } catch {}
  }
}

export function saveWaterwheelBucketState({
  statePath,
  state,
  nowMs = Date.now(),
  fileSystem = fs,
} = {}) {
  if (!statePath) return false;
  atomicWriteJson(fileSystem, path.resolve(String(statePath)), state, resolveNowMs(nowMs));
  return true;
}

function loadPersistedState({
  statePath,
  profileId,
  accountUid,
  nowMs,
  config,
  fileSystem,
}) {
  const initialState = createWaterwheelBucketState({ profileId, accountUid, nowMs, config });
  if (!statePath) {
    return {
      state: initialState,
      valid: false,
      needsWrite: false,
      persistenceStatus: "unconfigured",
      invalidReason: "state-path-unconfigured",
    };
  }
  const resolvedPath = path.resolve(String(statePath));
  if (!fileSystem.existsSync(resolvedPath)) {
    return {
      state: initialState,
      valid: false,
      needsWrite: true,
      persistenceStatus: "missing",
      invalidReason: null,
    };
  }
  let value;
  try {
    value = JSON.parse(fileSystem.readFileSync(resolvedPath, "utf8"));
  } catch {
    return {
      state: initialState,
      valid: false,
      needsWrite: true,
      persistenceStatus: "invalid",
      invalidReason: "state-read-or-parse-failed",
    };
  }
  if (!isValidWaterwheelBucketState(value, { profileId, accountUid })) {
    return {
      state: initialState,
      valid: false,
      needsWrite: true,
      persistenceStatus: "invalid",
      invalidReason: "state-validation-failed",
    };
  }
  return {
    state: value,
    valid: true,
    needsWrite: false,
    persistenceStatus: "loaded",
    invalidReason: null,
  };
}

function getIdentity(sync, options) {
  const profileId = normalizeWaterwheelProfileId(
    options.profileId || process.env.PROFILE_ID || "default",
  );
  const accountUid = getWaterwheelAccountUid(sync, options);
  const statePath = resolveWaterwheelBucketStatePath({
    statePath: options.bucketStatePath
      || options.waterwheelBucketStatePath
      || process.env.WATERWHEEL_BUCKET_STATE_PATH,
    settingsPath: options.profileSettingsPath
      || options.settingsPath
      || process.env.PROFILE_SETTINGS_PATH,
    profileId,
  });
  return { profileId, accountUid, statePath };
}

function unconfiguredProjection({ profileId, accountUid, nowMs, config }) {
  const state = {
    ...createWaterwheelBucketState({ profileId, accountUid, nowMs, config }),
    nextGenerationAtMs: null,
  };
  return {
    state,
    generatedBucketCount: 0,
    changed: false,
    clockRolledBack: false,
    storedBucketCount: 0,
    storedBucketMax: 0,
    maxBucketCount: 0,
    claimedBucketCount: 0,
    remainingDailyBucketCount: 0,
    storageCapacity: 0,
    statePath: null,
    profileId,
    accountUid,
    persistenceStatus: "unconfigured",
    invalidReason: "state-path-unconfigured",
  };
}

export function readAndAdvanceWaterwheelBucketState(sync, {
  config = {},
  claimedBucketCount = sync?.waterwheel?.count ?? sync?.waterwheelTot?.waterwheel?.count ?? 0,
  nowMs = Date.now(),
  bucketState = undefined,
  fileSystem = fs,
  ...options
} = {}) {
  const normalizedNowMs = resolveNowMs(nowMs);
  const identity = getIdentity(sync, options);
  if (bucketState === undefined && !identity.statePath) {
    return unconfiguredProjection({
      ...identity,
      nowMs: normalizedNowMs,
      config,
    });
  }

  const loaded = bucketState === undefined
    ? loadPersistedState({
        ...identity,
        nowMs: normalizedNowMs,
        config,
        fileSystem,
        statePath: identity.statePath,
      })
    : {
        state: bucketState,
        valid: isValidWaterwheelBucketState(bucketState, identity),
        needsWrite: false,
        persistenceStatus: "in-memory",
        invalidReason: null,
      };
  const advanced = advanceWaterwheelBucketState({
    state: loaded.valid ? loaded.state : createWaterwheelBucketState({
      ...identity,
      nowMs: normalizedNowMs,
      config,
    }),
    ...identity,
    claimedBucketCount,
    config,
    nowMs: normalizedNowMs,
  });
  const shouldPersist = bucketState === undefined && identity.statePath && (loaded.needsWrite || advanced.changed);
  if (shouldPersist) {
    try {
      saveWaterwheelBucketState({
        statePath: identity.statePath,
        state: advanced.state,
        nowMs: normalizedNowMs,
        fileSystem,
      });
    } catch {
      const fallback = loaded.valid
        ? safeProjectionWithoutGeneration(loaded.state, { claimedBucketCount, config })
        : safeProjectionWithoutGeneration(
            createWaterwheelBucketState({
              ...identity,
              nowMs: normalizedNowMs,
              config,
            }),
            { claimedBucketCount, config },
          );
      return {
        ...fallback,
        statePath: identity.statePath,
        profileId: identity.profileId,
        accountUid: identity.accountUid,
        persistenceStatus: "write-failed",
        invalidReason: loaded.invalidReason,
        generatedBucketCount: 0,
      };
    }
  }
  return {
    ...advanced,
    statePath: identity.statePath,
    profileId: identity.profileId,
    accountUid: identity.accountUid,
    persistenceStatus: bucketState === undefined
      ? (shouldPersist ? "saved" : loaded.persistenceStatus)
      : "in-memory",
    invalidReason: loaded.invalidReason,
  };
}

export function consumeWaterwheelBucket(sync, {
  config = {},
  claimedBucketCount = sync?.waterwheel?.count ?? sync?.waterwheelTot?.waterwheel?.count ?? 0,
  nowMs = Date.now(),
  bucketState = undefined,
  fileSystem = fs,
  ...options
} = {}) {
  const projection = readAndAdvanceWaterwheelBucketState(sync, {
    config,
    claimedBucketCount,
    nowMs,
    bucketState,
    fileSystem,
    ...options,
  });
  if (projection.storedBucketCount <= 0) {
    return { ...projection, consumed: false, persisted: true };
  }

  const normalizedNowMs = resolveNowMs(nowMs);
  const createCdMs = positiveMilliseconds(config.bucketCreateCd);
  const nextStoredBucketCount = projection.storedBucketCount - 1;
  const canKeepScheduledGeneration = createCdMs != null
    && nextStoredBucketCount < projection.storageCapacity
    && Number.isSafeInteger(projection.state?.nextGenerationAtMs)
    && projection.state.nextGenerationAtMs > normalizedNowMs;
  const nextState = {
    ...projection.state,
    storedBucketCount: nextStoredBucketCount,
    nextGenerationAtMs: canKeepScheduledGeneration
      ? projection.state.nextGenerationAtMs
      : createCdMs == null || nextStoredBucketCount >= projection.storageCapacity
        ? null
        : normalizedNowMs + createCdMs,
    lastObservedAtMs: Math.max(projection.state.lastObservedAtMs, normalizedNowMs),
    updatedAt: new Date(normalizedNowMs).toISOString(),
  };
  let persisted = true;
  if (bucketState === undefined && projection.statePath) {
    try {
      saveWaterwheelBucketState({
        statePath: projection.statePath,
        state: nextState,
        nowMs: normalizedNowMs,
        fileSystem,
      });
    } catch {
      persisted = false;
    }
  }
  return {
    ...projection,
    state: nextState,
    storedBucketCount: nextStoredBucketCount,
    generatedBucketCount: 0,
    changed: true,
    persistenceStatus: persisted ? "consumed" : "write-failed",
    consumed: true,
    persisted,
  };
}


