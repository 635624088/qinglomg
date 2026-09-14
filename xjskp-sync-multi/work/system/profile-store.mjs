import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  REQUIRED_CREDENTIAL_FIELDS,
  getMissingCredentialFields,
  normalizeCredentials,
  parseCredentialInput,
} from "./credentials.mjs";
import { protectValue, unprotectValue } from "./dpapi.mjs";
import {
  isAllowedFlowerRackTargetArtId,
  normalizeFlowerRackTargetArtId,
} from "../flower-rack-state.mjs";
import {
  DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT,
  isValidExperienceGuardThresholdPercent,
  DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER,
  isValidTeamOrderGuardMultiplier,
} from "../experience-settlement.mjs";

const SENSITIVE_FIELDS = ["CTOKEN", "PC_TOKEN", "BABI_TOKEN", "OPEN_ID"];
const CREDENTIAL_FIELDS = new Set(["CTOKEN", "PC_USER_ID", "PC_TOKEN", "BABI_TOKEN", "OPEN_ID"]);
export const DEFAULT_PROFILE_SETTINGS = {
  autoReceiveWaterwheelBuckets: true,
  skipWaterwheelVideoBuckets: false,
  autoSubmitOrdinaryResidentOrdersForLevelUp: false,
  autoSubmitCyclicStoryOrders: false,
  cyclicStoryOnlyHighestExperienceOrder: false,
  autoHandleCyclicNote: false,
  autoCompleteCyclicNoteHighestRewardTask: false,
  customerOrderFlowerCurrencyRewardReleaseMask: 4,
  experienceGuardThresholdPercent: DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT,
  flowerRackTargetArtId: null,
  materialShopMidnightRefreshEnabled: false,
  materialShopRefreshWindowStart: "23:50",
  materialShopRefreshMaxCostYuanbao: 4,
  pearlHireItemReserveCount: 100,
  teamOrderTriggerProtectionEnabled: true,
  teamOrderPaidRenewProtectionEnabled: true,
  teamOrderGuardMultiplier: DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER,
};
const PROFILE_SETTINGS_CANONICAL_KEYS = Object.freeze(
  Object.keys(DEFAULT_PROFILE_SETTINGS),
);
const PROFILE_SETTINGS_EPOCH_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_SETTINGS_LEGACY_REVISION_KEYS = new Set([
  "autoSubmitOrdinaryResidentOrders",
]);
export const PROFILE_SETTING_INPUT_KEYS = Object.freeze([
  "autoReceiveWaterwheelBuckets",
  "skipWaterwheelVideoBuckets",
  "autoSubmitOrdinaryResidentOrdersForLevelUp",
  "autoSubmitOrdinaryResidentOrders",
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

export function normalizePearlHireItemReserveCount(value, fallback = 100) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function normalizeCustomerOrderFlowerCurrencyRewardReleaseMask(value, fallback = 4) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 7
    ? value
    : fallback;
}

export function normalizeMaterialShopRefreshWindowStart(value, fallback = "23:50") {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? value
    : fallback;
}

export const MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO_OPTIONS = Object.freeze([
  0, 1, 2, 4, 8, 12, 16,
]);

export function normalizeMaterialShopRefreshMaxCostYuanbao(value, fallback = 4) {
  return MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO_OPTIONS.includes(value)
    ? value
    : fallback;
}

export function createProfileStore(options = {}) {
  const accountsDir = options.accountsDir || path.join(process.cwd(), "runtime", "accounts");
  const protect = options.protect || protectValue;
  const unprotect = options.unprotect || unprotectValue;
  const now = options.now || (() => new Date());
  const fileSystem = options.fs || fs;
  const createSettingsEpoch = options.createSettingsEpoch || randomUUID;
  const profileWriteQueues = new Map();

  async function importProfile(input = {}) {
    const parsed = parseCredentialInput(input.credentialText || "");
    const credentials = normalizeCredentials({
      ...parsed,
      ...(input.credentials || {}),
    });
    const id = sanitizeProfileId(input.id || credentials.PC_USER_ID || input.label || `profile-${Date.now()}`);
    return enqueueProfileWrite(id, async () => {
      await fileSystem.mkdir(accountsDir, { recursive: true });
      const existing = await readProfileFile(id).catch(() => null);
      const hasProtocolState = hasProfileSettingsProtocolMarker(existing);
      if (hasProtocolState && Object.hasOwn(input, "settings")) {
        const error = new Error("Settings cannot be imported into a protocol profile");
        error.code = "PROFILE_SETTINGS_IMPORT_NOT_SUPPORTED";
        error.statusCode = 400;
        throw error;
      }
      const timestamp = now().toISOString();
      const record = {
        version: 1,
        id,
        label: String(input.label || existing?.label || id),
        pcUserId: credentials.PC_USER_ID || existing?.pcUserId || "",
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp,
        lastValidatedAt: existing?.lastValidatedAt || null,
        serverIdx: normalizeServerIdx(existing?.serverIdx ?? existing?.lastGsIdx),
        serverText: formatServerText(existing?.serverIdx ?? existing?.lastGsIdx),
        settings: hasProtocolState
          ? existing.settings
          : mergeProfileSettings(existing?.settings, input.settings),
        ...copyProfileSettingsProtocolMarkers(existing),
        secrets: {
          ...(existing?.secrets || {}),
        },
      };

      for (const field of SENSITIVE_FIELDS) {
        if (credentials[field]) {
          record.secrets[field] = protect(credentials[field]);
        }
      }

      await writeJsonAtomic(profilePath(id), record);
      return toProfileSummary(record, credentials);
    });
  }

  async function listProfiles() {
    await fileSystem.mkdir(accountsDir, { recursive: true });
    const entries = await fileSystem.readdir(accountsDir, { withFileTypes: true });
    const profiles = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        profiles.push(toProfileSummary(await readProfileFile(path.basename(entry.name, ".json"))));
      } catch {
        // Ignore damaged account files; the UI still loads the healthy profiles.
      }
    }
    return profiles.sort((a, b) => a.label.localeCompare(b.label, "zh-CN") || a.id.localeCompare(b.id));
  }

  async function getProfile(id) {
    return toProfileSummary(await readProfileFile(id));
  }

  async function getProfileSettings(id) {
    const record = await readProfileFile(id);
    return normalizeProfileSettings(record.settings);
  }

  async function updateProfileSettings(id, settings = {}) {
    return enqueueProfileWrite(id, async () => {
      const record = await readProfileFile(id);
      if (hasProfileSettingsProtocolMarker(record)) {
        const error = new Error("Profile settings protocol precondition is required");
        error.code = "PROFILE_SETTINGS_PRECONDITION_REQUIRED";
        error.statusCode = 428;
        throw error;
      }
      record.settings = mergeProfileSettings(record.settings, settings);
      record.updatedAt = now().toISOString();
      await writeJsonAtomic(profilePath(id), record);
      return toProfileSummary(record);
    });
  }

  async function loadProfileEnv(id) {
    const record = await readProfileFile(id);
    const credentials = {
      PC_USER_ID: record.pcUserId || "",
    };
    for (const field of SENSITIVE_FIELDS) {
      if (record.secrets?.[field]) {
        credentials[field] = unprotect(record.secrets[field]);
      }
    }
    const normalized = normalizeCredentials(credentials);
    const missing = getMissingCredentialFields(normalized);
    if (missing.length) {
      throw new Error(`Profile ${id} is missing credentials: ${missing.join(", ")}`);
    }
    return normalized;
  }

  async function readSettingsStateForProtocol(id) {
    assertCanonicalProtocolProfileId(id);
    return enqueueProfileWrite(id, async () => {
      const record = await readProfileFile(id);
      const prepared = prepareProfileSettingsProtocolState(
        record,
        id,
        createSettingsEpoch,
      );
      if (prepared.persisted) {
        await writeJsonAtomic(profilePath(id), prepared.record);
      }
      return buildProtocolStoreResult(
        prepared.record,
        prepared.snapshot,
        prepared.persisted,
      );
    });
  }

  async function compareAndWriteTentativeSettingsForProtocol(id, options = {}) {
    assertCanonicalProtocolProfileId(id);
    return enqueueProfileWrite(id, async () => {
      const record = await readProfileFile(id);
      const prepared = prepareProfileSettingsProtocolState(
        record,
        id,
        createSettingsEpoch,
      );
      assertCompleteProtocolSnapshot(options.expectedSnapshot);
      if (!protocolSnapshotsEqual(prepared.snapshot, options.expectedSnapshot)) {
        if (prepared.persisted) {
          await writeJsonAtomic(profilePath(id), prepared.record);
        }
        return {
          ...buildProtocolStoreResult(
            prepared.record,
            prepared.snapshot,
            prepared.persisted,
          ),
          matched: false,
          applied: false,
        };
      }

      const patch = options.patch;
      if (
        !isPlainRecord(patch)
        || Object.keys(patch).length === 0
        || Object.keys(patch).some((key) => !Object.hasOwn(DEFAULT_PROFILE_SETTINGS, key))
      ) {
        throw profileSettingsStoreError(
          "INVALID_PROFILE_SETTINGS",
          "Protocol patch must contain canonical profile setting keys",
        );
      }
      const merged = normalizeCanonicalSettings(
        mergeProfileSettings(prepared.snapshot.settings, patch),
      );
      const changedKeys = PROFILE_SETTINGS_CANONICAL_KEYS.filter(
        (key) => !jsonScalarEqual(merged[key], prepared.snapshot.settings[key]),
      );
      if (changedKeys.length === 0) {
        if (prepared.persisted) {
          await writeJsonAtomic(profilePath(id), prepared.record);
        }
        return {
          ...buildProtocolStoreResult(
            prepared.record,
            prepared.snapshot,
            prepared.persisted,
          ),
          matched: true,
          applied: false,
          previousSnapshot: cloneProtocolSnapshot(prepared.snapshot),
        };
      }
      if (prepared.snapshot.settingsRevision === Number.MAX_SAFE_INTEGER) {
        throw profileSettingsStoreError(
          "PROFILE_SETTINGS_REVISION_INVALID",
          "Profile settings revision cannot be incremented safely",
        );
      }

      const nextRevision = prepared.snapshot.settingsRevision + 1;
      const nextKeyRevisions = {
        ...prepared.snapshot.settingsKeyRevisions,
      };
      for (const key of changedKeys) nextKeyRevisions[key] = nextRevision;
      const nextRecord = {
        ...prepared.record,
        settings: merged,
        settingsEpoch: prepared.snapshot.settingsEpoch,
        settingsRevision: nextRevision,
        settingsKeyRevisions: nextKeyRevisions,
        updatedAt: now().toISOString(),
      };
      const nextSnapshot = buildProtocolSnapshot(nextRecord, {
        settings: merged,
        settingsEpoch: prepared.snapshot.settingsEpoch,
        settingsRevision: nextRevision,
        settingsKeyRevisions: nextKeyRevisions,
      });
      const tentativeResult = {
        ...buildProtocolStoreResult(nextRecord, nextSnapshot, true),
        matched: true,
        applied: true,
        changedKeys,
        previousSnapshot: cloneProtocolSnapshot(prepared.snapshot),
      };
      try {
        await writeJsonAtomic(profilePath(id), nextRecord);
      } catch (cause) {
        const error = new Error("Tentative profile settings write result is unknown", {
          cause,
        });
        error.code = "PROFILE_SETTINGS_TENTATIVE_WRITE_UNKNOWN";
        error.tentativeResult = tentativeResult;
        throw error;
      }
      return tentativeResult;
    });
  }

  async function conditionalRollbackSettingsForProtocol(id, options = {}) {
    assertCanonicalProtocolProfileId(id);
    return enqueueProfileWrite(id, async () => {
      assertCompleteProtocolSnapshot(options.tentativeSnapshot);
      assertCompleteProtocolSnapshot(options.previousSnapshot);
      const record = await readProfileFile(id);
      const prepared = prepareProfileSettingsProtocolState(
        record,
        id,
        createSettingsEpoch,
      );
      if (!protocolSnapshotsEqual(prepared.snapshot, options.tentativeSnapshot)) {
        return {
          ...buildProtocolStoreResult(
            prepared.record,
            prepared.snapshot,
            false,
          ),
          rolledBack: false,
        };
      }
      if (
        options.previousSnapshot.settingsEpoch
        !== options.tentativeSnapshot.settingsEpoch
      ) {
        throw profileSettingsStoreError(
          "PROFILE_SETTINGS_EPOCH_INVALID",
          "Conditional rollback cannot change the settings epoch",
        );
      }
      const rollbackRecord = {
        ...prepared.record,
        settings: { ...options.previousSnapshot.settings },
        settingsEpoch: options.previousSnapshot.settingsEpoch,
        settingsRevision: options.previousSnapshot.settingsRevision,
        settingsKeyRevisions: {
          ...options.previousSnapshot.settingsKeyRevisions,
        },
      };
      const rollbackSnapshot = buildProtocolSnapshot(
        rollbackRecord,
        options.previousSnapshot,
      );
      await writeJsonAtomic(profilePath(id), rollbackRecord);
      return {
        ...buildProtocolStoreResult(rollbackRecord, rollbackSnapshot, true),
        rolledBack: true,
      };
    });
  }

  async function loadProfileCredentialFields(id, fields = []) {
    const requested = Array.from(new Set(fields));
    for (const field of requested) {
      if (!CREDENTIAL_FIELDS.has(field)) {
        const error = new Error(`Unsupported credential field: ${field}`);
        error.code = "UNSUPPORTED_CREDENTIAL_FIELD";
        throw error;
      }
    }
    const record = await readProfileFile(id);
    return Object.fromEntries(requested.map((field) => {
      if (field === "PC_USER_ID") return [field, record.pcUserId || ""];
      return [field, record.secrets?.[field] ? unprotect(record.secrets[field]) : ""];
    }));
  }

  async function markValidated(id, date = now(), details = {}) {
    return enqueueProfileWrite(id, async () => {
      const record = await readProfileFile(id);
      record.lastValidatedAt = date.toISOString();
      record.updatedAt = date.toISOString();
      if (Object.hasOwn(details || {}, "serverIdx")) {
        record.serverIdx = normalizeServerIdx(details.serverIdx);
        record.serverText = formatServerText(record.serverIdx);
      }
      await writeJsonAtomic(profilePath(id), record);
      return toProfileSummary(record);
    });
  }

  async function resetCredentials(id) {
    return enqueueProfileWrite(id, async () => {
      const record = await readProfileFile(id);
      record.secrets = {};
      record.lastValidatedAt = null;
      record.serverIdx = null;
      record.serverText = null;
      record.updatedAt = now().toISOString();
      await writeJsonAtomic(profilePath(id), record);
      return toProfileSummary(record);
    });
  }

  async function readProfileFile(id) {
    const raw = await fileSystem.readFile(profilePath(id), "utf8");
    return JSON.parse(raw);
  }

  function profilePath(id) {
    return path.join(accountsDir, `${sanitizeProfileId(id)}.json`);
  }

  function enqueueProfileWrite(id, operation) {
    const key = sanitizeProfileId(id);
    const previous = profileWriteQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    let tracked;
    tracked = current.finally(() => {
      if (profileWriteQueues.get(key) === tracked) profileWriteQueues.delete(key);
    });
    profileWriteQueues.set(key, tracked);
    return tracked;
  }

  async function writeJsonAtomic(filePath, value) {
    await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fileSystem.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await fileSystem.rename(tmpPath, filePath);
    } finally {
      await fileSystem.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  return {
    accountsDir,
    importProfile,
    listProfiles,
    getProfile,
    getProfileSettings,
    updateProfileSettings,
    readSettingsStateForProtocol,
    compareAndWriteTentativeSettingsForProtocol,
    conditionalRollbackSettingsForProtocol,
    loadProfileCredentialFields,
    loadProfileEnv,
    markValidated,
    resetCredentials,
  };
}

export function sanitizeProfileId(value) {
  const slug = String(value ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return slug || `profile-${Date.now()}`;
}

export function normalizeProfileSettings(settings = {}) {
  const hasNewSetting = Object.hasOwn(settings || {}, "autoSubmitOrdinaryResidentOrdersForLevelUp");
  const levelUpEnabled = hasNewSetting
    ? settings.autoSubmitOrdinaryResidentOrdersForLevelUp === true
    : settings?.autoSubmitOrdinaryResidentOrders === true;
  return {
    ...DEFAULT_PROFILE_SETTINGS,
    autoReceiveWaterwheelBuckets:
      typeof settings?.autoReceiveWaterwheelBuckets === "boolean"
        ? settings.autoReceiveWaterwheelBuckets
        : true,
    skipWaterwheelVideoBuckets:
      typeof settings?.skipWaterwheelVideoBuckets === "boolean"
        ? settings.skipWaterwheelVideoBuckets
        : false,
    autoSubmitOrdinaryResidentOrdersForLevelUp: levelUpEnabled,
    autoSubmitOrdinaryResidentOrders: levelUpEnabled,
    autoSubmitCyclicStoryOrders: settings?.autoSubmitCyclicStoryOrders === true,
    cyclicStoryOnlyHighestExperienceOrder:
      settings?.cyclicStoryOnlyHighestExperienceOrder === true,
    autoHandleCyclicNote: settings?.autoHandleCyclicNote === true,
    autoCompleteCyclicNoteHighestRewardTask:
      settings?.autoCompleteCyclicNoteHighestRewardTask === true,
    customerOrderFlowerCurrencyRewardReleaseMask:
      normalizeCustomerOrderFlowerCurrencyRewardReleaseMask(
        settings?.customerOrderFlowerCurrencyRewardReleaseMask,
      ),
    experienceGuardThresholdPercent: isValidExperienceGuardThresholdPercent(
      settings?.experienceGuardThresholdPercent,
    )
      ? settings.experienceGuardThresholdPercent
      : DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT,
    flowerRackTargetArtId: normalizeFlowerRackTargetArtId(settings?.flowerRackTargetArtId),
    materialShopMidnightRefreshEnabled:
      settings?.materialShopMidnightRefreshEnabled === true,
    materialShopRefreshWindowStart: normalizeMaterialShopRefreshWindowStart(
      settings?.materialShopRefreshWindowStart,
    ),
    materialShopRefreshMaxCostYuanbao: normalizeMaterialShopRefreshMaxCostYuanbao(
      settings?.materialShopRefreshMaxCostYuanbao,
    ),
    pearlHireItemReserveCount: normalizePearlHireItemReserveCount(settings?.pearlHireItemReserveCount),
    teamOrderTriggerProtectionEnabled:
      typeof settings?.teamOrderTriggerProtectionEnabled === "boolean"
        ? settings.teamOrderTriggerProtectionEnabled
        : true,
    teamOrderPaidRenewProtectionEnabled:
      typeof settings?.teamOrderPaidRenewProtectionEnabled === "boolean"
        ? settings.teamOrderPaidRenewProtectionEnabled
        : true,
    teamOrderGuardMultiplier: isValidTeamOrderGuardMultiplier(
      settings?.teamOrderGuardMultiplier,
    )
      ? settings.teamOrderGuardMultiplier
      : DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER,
  };
}

export function mergeProfileSettings(existing = {}, input = {}) {
  const settings = normalizeProfileSettings(existing);
  if (Object.hasOwn(input || {}, "autoReceiveWaterwheelBuckets")) {
    if (typeof input.autoReceiveWaterwheelBuckets !== "boolean") {
      const err = new Error("Invalid autoReceiveWaterwheelBuckets");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.autoReceiveWaterwheelBuckets = input.autoReceiveWaterwheelBuckets;
  }
  if (Object.hasOwn(input || {}, "skipWaterwheelVideoBuckets")) {
    if (typeof input.skipWaterwheelVideoBuckets !== "boolean") {
      const err = new Error("Invalid skipWaterwheelVideoBuckets");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.skipWaterwheelVideoBuckets = input.skipWaterwheelVideoBuckets;
  }
  if (Object.hasOwn(input || {}, "autoSubmitOrdinaryResidentOrdersForLevelUp")) {
    if (typeof input.autoSubmitOrdinaryResidentOrdersForLevelUp !== "boolean") {
      const err = new Error(
        "Invalid autoSubmitOrdinaryResidentOrdersForLevelUp",
      );
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.autoSubmitOrdinaryResidentOrdersForLevelUp =
      input.autoSubmitOrdinaryResidentOrdersForLevelUp;
  } else if (Object.hasOwn(input || {}, "autoSubmitOrdinaryResidentOrders")) {
    if (typeof input.autoSubmitOrdinaryResidentOrders !== "boolean") {
      const err = new Error("Invalid autoSubmitOrdinaryResidentOrders");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.autoSubmitOrdinaryResidentOrdersForLevelUp =
      input.autoSubmitOrdinaryResidentOrders;
  }
  if (Object.hasOwn(input || {}, "autoSubmitCyclicStoryOrders")) {
    if (typeof input.autoSubmitCyclicStoryOrders !== "boolean") {
      const err = new Error("Invalid autoSubmitCyclicStoryOrders");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.autoSubmitCyclicStoryOrders = input.autoSubmitCyclicStoryOrders;
  }
  if (Object.hasOwn(input || {}, "cyclicStoryOnlyHighestExperienceOrder")) {
    if (typeof input.cyclicStoryOnlyHighestExperienceOrder !== "boolean") {
      const err = new Error("Invalid cyclicStoryOnlyHighestExperienceOrder");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.cyclicStoryOnlyHighestExperienceOrder =
      input.cyclicStoryOnlyHighestExperienceOrder;
  }
  if (Object.hasOwn(input || {}, "autoCompleteCyclicNoteHighestRewardTask")) {
    if (typeof input.autoCompleteCyclicNoteHighestRewardTask !== "boolean") {
      const err = new Error("Invalid autoCompleteCyclicNoteHighestRewardTask");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.autoCompleteCyclicNoteHighestRewardTask =
      input.autoCompleteCyclicNoteHighestRewardTask;
  }
  if (Object.hasOwn(input || {}, "autoHandleCyclicNote")) {
    if (typeof input.autoHandleCyclicNote !== "boolean") {
      const err = new Error("Invalid autoHandleCyclicNote");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.autoHandleCyclicNote = input.autoHandleCyclicNote;
  }
  if (Object.hasOwn(input || {}, "customerOrderFlowerCurrencyRewardReleaseMask")) {
    const value = input.customerOrderFlowerCurrencyRewardReleaseMask;
    if (normalizeCustomerOrderFlowerCurrencyRewardReleaseMask(value, null) == null) {
      const err = new Error("Invalid customerOrderFlowerCurrencyRewardReleaseMask");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.customerOrderFlowerCurrencyRewardReleaseMask = value;
  }
  if (Object.hasOwn(input || {}, "experienceGuardThresholdPercent")) {
    const value = input.experienceGuardThresholdPercent;
    if (!isValidExperienceGuardThresholdPercent(value)) {
      const err = new Error("Invalid experienceGuardThresholdPercent");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.experienceGuardThresholdPercent = value;
  }
  if (Object.hasOwn(input || {}, "flowerRackTargetArtId")) {
    if (!isAllowedFlowerRackTargetArtId(input.flowerRackTargetArtId)) {
      const err = new Error("Invalid flowerRackTargetArtId");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.flowerRackTargetArtId = normalizeFlowerRackTargetArtId(input.flowerRackTargetArtId);
  }
  if (Object.hasOwn(input || {}, "pearlHireItemReserveCount")) {
    const value = input.pearlHireItemReserveCount;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      const err = new Error("Invalid pearlHireItemReserveCount");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.pearlHireItemReserveCount = value;
  }
  if (Object.hasOwn(input || {}, "teamOrderTriggerProtectionEnabled")) {
    if (typeof input.teamOrderTriggerProtectionEnabled !== "boolean") {
      const err = new Error(
        "Invalid teamOrderTriggerProtectionEnabled",
      );
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.teamOrderTriggerProtectionEnabled =
      input.teamOrderTriggerProtectionEnabled;
  }
  if (Object.hasOwn(input || {}, "materialShopMidnightRefreshEnabled")) {
    if (typeof input.materialShopMidnightRefreshEnabled !== "boolean") {
      const err = new Error("Invalid materialShopMidnightRefreshEnabled");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.materialShopMidnightRefreshEnabled =
      input.materialShopMidnightRefreshEnabled;
  }
  if (Object.hasOwn(input || {}, "materialShopRefreshWindowStart")) {
    const value = input.materialShopRefreshWindowStart;
    if (normalizeMaterialShopRefreshWindowStart(value, null) == null) {
      const err = new Error("Invalid materialShopRefreshWindowStart");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.materialShopRefreshWindowStart = value;
  }
  if (Object.hasOwn(input || {}, "materialShopRefreshMaxCostYuanbao")) {
    const value = input.materialShopRefreshMaxCostYuanbao;
    if (!MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO_OPTIONS.includes(value)) {
      const err = new Error("Invalid materialShopRefreshMaxCostYuanbao");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.materialShopRefreshMaxCostYuanbao = value;
  }
  if (Object.hasOwn(input || {}, "teamOrderPaidRenewProtectionEnabled")) {
    if (typeof input.teamOrderPaidRenewProtectionEnabled !== "boolean") {
      const err = new Error(
        "Invalid teamOrderPaidRenewProtectionEnabled",
      );
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.teamOrderPaidRenewProtectionEnabled =
      input.teamOrderPaidRenewProtectionEnabled;
  }
  if (Object.hasOwn(input || {}, "teamOrderGuardMultiplier")) {
    const value = input.teamOrderGuardMultiplier;
    if (!isValidTeamOrderGuardMultiplier(value)) {
      const err = new Error("Invalid teamOrderGuardMultiplier");
      err.code = "INVALID_PROFILE_SETTINGS";
      err.statusCode = 400;
      throw err;
    }
    settings.teamOrderGuardMultiplier = value;
  }
  settings.autoSubmitOrdinaryResidentOrders = settings.autoSubmitOrdinaryResidentOrdersForLevelUp;
  return settings;
}

function prepareProfileSettingsProtocolState(record, canonicalId, createSettingsEpoch) {
  const nextRecord = { ...record };
  let persisted = false;
  let settingsEpoch = record.settingsEpoch;
  if (!Object.hasOwn(record, "settingsEpoch")) {
    settingsEpoch = createSettingsEpoch();
    if (!isProtocolSettingsEpoch(settingsEpoch)) {
      throw profileSettingsStoreError(
        "PROFILE_SETTINGS_EPOCH_INVALID",
        "Settings epoch generator returned an invalid UUID v4",
      );
    }
    nextRecord.settingsEpoch = settingsEpoch;
    persisted = true;
  } else if (!isProtocolSettingsEpoch(settingsEpoch)) {
    throw profileSettingsStoreError(
      "PROFILE_SETTINGS_EPOCH_INVALID",
      "Profile settings epoch is invalid",
    );
  }

  const hasRevision = Object.hasOwn(record, "settingsRevision");
  const hasKeyRevisions = Object.hasOwn(record, "settingsKeyRevisions");
  let settingsRevision = 0;
  let settingsKeyRevisions = Object.fromEntries(
    PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => [key, 0]),
  );
  if (!hasRevision && hasKeyRevisions) {
    throw profileSettingsStoreError(
      "PROFILE_SETTINGS_REVISION_INVALID",
      "Profile has key revisions without a profile settings revision",
    );
  }
  if (hasRevision) {
    if (!isProtocolSettingsRevision(record.settingsRevision)) {
      throw profileSettingsStoreError(
        "PROFILE_SETTINGS_REVISION_INVALID",
        "Profile settings revision is invalid",
      );
    }
    settingsRevision = Object.is(record.settingsRevision, -0)
      ? 0
      : record.settingsRevision;
    if (!hasKeyRevisions) {
      settingsKeyRevisions = Object.fromEntries(
        PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => [key, settingsRevision]),
      );
      nextRecord.settingsKeyRevisions = settingsKeyRevisions;
      persisted = true;
    } else {
      if (!isPlainRecord(record.settingsKeyRevisions)) {
        throw profileSettingsStoreError(
          "PROFILE_SETTINGS_REVISION_INVALID",
          "Profile settings key revisions must be an object",
        );
      }
      const allowedKeys = new Set([
        ...PROFILE_SETTINGS_CANONICAL_KEYS,
        ...PROFILE_SETTINGS_LEGACY_REVISION_KEYS,
      ]);
      if (Object.keys(record.settingsKeyRevisions).some((key) => !allowedKeys.has(key))) {
        throw profileSettingsStoreError(
          "PROFILE_SETTINGS_REVISION_INVALID",
          "Profile settings key revisions contain an unknown key",
        );
      }
      settingsKeyRevisions = {};
      for (const key of PROFILE_SETTINGS_CANONICAL_KEYS) {
        const value = record.settingsKeyRevisions[key];
        if (isProtocolSettingsRevision(value) && value > settingsRevision) {
          throw profileSettingsStoreError(
            "PROFILE_SETTINGS_REVISION_INVALID",
            "A profile settings key revision exceeds the profile revision",
          );
        }
        settingsKeyRevisions[key] = isProtocolSettingsRevision(value)
          ? (Object.is(value, -0) ? 0 : value)
          : settingsRevision;
      }
      if (
        !protocolKeyRevisionsEqual(record.settingsKeyRevisions, settingsKeyRevisions)
        || Object.keys(record.settingsKeyRevisions).some(
          (key) => PROFILE_SETTINGS_LEGACY_REVISION_KEYS.has(key),
        )
      ) {
        nextRecord.settingsKeyRevisions = settingsKeyRevisions;
        persisted = true;
      }
    }
    if (Object.is(record.settingsRevision, -0)) {
      nextRecord.settingsRevision = 0;
      persisted = true;
    }
  }

  const settings = normalizeCanonicalSettings(record.settings);
  if (nextRecord.id !== canonicalId) {
    nextRecord.id = canonicalId;
    persisted = true;
  }
  return {
    record: nextRecord,
    persisted,
    snapshot: buildProtocolSnapshot(nextRecord, {
      settings,
      settingsEpoch,
      settingsRevision,
      settingsKeyRevisions,
    }),
  };
}

function hasProfileSettingsProtocolMarker(record) {
  return Boolean(
    record
    && [
      "settingsEpoch",
      "settingsRevision",
      "settingsKeyRevisions",
    ].some((key) => Object.hasOwn(record, key)),
  );
}

function copyProfileSettingsProtocolMarkers(record) {
  if (!record) return {};
  const markers = {};
  for (const key of [
    "settingsEpoch",
    "settingsRevision",
    "settingsKeyRevisions",
  ]) {
    if (Object.hasOwn(record, key)) {
      markers[key] = key === "settingsKeyRevisions" && isPlainRecord(record[key])
        ? { ...record[key] }
        : record[key];
    }
  }
  return markers;
}

function buildProtocolStoreResult(record, snapshot, persisted) {
  return {
    profile: toProfileSummary(record),
    snapshot: cloneProtocolSnapshot(snapshot),
    persisted,
  };
}

function buildProtocolSnapshot(record, snapshot) {
  return {
    settings: { ...snapshot.settings },
    settingsEpoch: snapshot.settingsEpoch,
    settingsRevision: snapshot.settingsRevision,
    settingsKeyRevisions: { ...snapshot.settingsKeyRevisions },
    profileUpdatedAt: record.updatedAt || null,
  };
}

function cloneProtocolSnapshot(snapshot) {
  return {
    settings: { ...snapshot.settings },
    settingsEpoch: snapshot.settingsEpoch,
    settingsRevision: snapshot.settingsRevision,
    settingsKeyRevisions: { ...snapshot.settingsKeyRevisions },
    profileUpdatedAt: snapshot.profileUpdatedAt || null,
  };
}

function normalizeCanonicalSettings(settings = {}) {
  const normalized = normalizeProfileSettings(settings);
  return Object.fromEntries(
    PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => [key, normalized[key]]),
  );
}

function protocolSnapshotsEqual(left, right) {
  return Boolean(
    left
    && right
    && left.settingsEpoch === right.settingsEpoch
    && left.settingsRevision === right.settingsRevision
    && PROFILE_SETTINGS_CANONICAL_KEYS.every(
      (key) => (
        jsonScalarEqual(left.settings?.[key], right.settings?.[key])
        && left.settingsKeyRevisions?.[key] === right.settingsKeyRevisions?.[key]
      ),
    )
  );
}

function protocolKeyRevisionsEqual(left, right) {
  return (
    isPlainRecord(left)
    && Object.keys(left).length === PROFILE_SETTINGS_CANONICAL_KEYS.length
    && PROFILE_SETTINGS_CANONICAL_KEYS.every(
      (key) => left[key] === right[key],
    )
  );
}

function assertCompleteProtocolSnapshot(snapshot) {
  let normalizedSettings = null;
  try {
    normalizedSettings = snapshot?.settings
      ? normalizeCanonicalSettings(snapshot.settings)
      : null;
  } catch {
    normalizedSettings = null;
  }
  const valid = Boolean(
    snapshot
    && isPlainRecord(snapshot.settings)
    && Object.keys(snapshot.settings).length === PROFILE_SETTINGS_CANONICAL_KEYS.length
    && isProtocolSettingsEpoch(snapshot.settingsEpoch)
    && isProtocolSettingsRevision(snapshot.settingsRevision)
    && isPlainRecord(snapshot.settingsKeyRevisions)
    && Object.keys(snapshot.settingsKeyRevisions).length === PROFILE_SETTINGS_CANONICAL_KEYS.length
    && PROFILE_SETTINGS_CANONICAL_KEYS.every(
      (key) => (
        Object.hasOwn(snapshot.settings, key)
        && jsonScalarEqual(snapshot.settings[key], normalizedSettings?.[key])
        && Object.hasOwn(snapshot.settingsKeyRevisions, key)
        && isProtocolSettingsRevision(snapshot.settingsKeyRevisions[key])
        && snapshot.settingsKeyRevisions[key] <= snapshot.settingsRevision
      ),
    )
  );
  if (!valid) {
    throw new TypeError("A complete settings protocol snapshot is required");
  }
}

function assertCanonicalProtocolProfileId(id) {
  if (typeof id !== "string" || !id || sanitizeProfileId(id) !== id) {
    throw profileSettingsStoreError(
      "INVALID_PROFILE_ID_CANONICAL_FORM",
      "Profile ID must already be canonical",
    );
  }
}

function isProtocolSettingsEpoch(value) {
  return typeof value === "string" && PROFILE_SETTINGS_EPOCH_PATTERN.test(value);
}

function isProtocolSettingsRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPlainRecord(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonScalarEqual(left, right) {
  return left === right || (Number.isNaN(left) && Number.isNaN(right));
}

function profileSettingsStoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = code === "INVALID_PROFILE_SETTINGS" ? 400 : 503;
  return error;
}

export function normalizeServerIdx(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function formatServerText(value) {
  const serverIdx = normalizeServerIdx(value);
  return serverIdx == null ? null : `区服 ${serverIdx}`;
}

function toProfileSummary(record, explicitCredentials = null) {
  const credentials = explicitCredentials || {
    PC_USER_ID: record.pcUserId || "",
    ...Object.fromEntries(SENSITIVE_FIELDS.map((field) => [field, record.secrets?.[field] ? "__protected__" : ""])),
  };
  const missingFields = getMissingCredentialFields(credentials);
  return {
    id: record.id,
    label: record.label || record.id,
    pcUserId: record.pcUserId || "",
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    lastValidatedAt: record.lastValidatedAt || null,
    serverIdx: normalizeServerIdx(record.serverIdx ?? record.lastGsIdx),
    serverText: record.serverText || formatServerText(record.serverIdx ?? record.lastGsIdx),
    hasCredentials: missingFields.length === 0,
    missingFields,
    settings: normalizeProfileSettings(record.settings),
  };
}
