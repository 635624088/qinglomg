import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { sanitizeProfileId } from "./profile-store.mjs";
import {
  PROFILE_SETTINGS_CANONICAL_KEYS,
  isCanonicalProfileSettingsId,
  isProfileSettingsEpoch,
  isProfileSettingsRevision,
  normalizeCanonicalProfileSettings,
} from "./profile-settings-protocol.mjs";

const COLLISION_CODE = "PROFILE_ID_CANONICAL_COLLISION";
const ACTIVE_ALIAS_CODE = "PROFILE_ID_CANONICAL_ALIAS_ACTIVE";
const RUNTIME_SOURCE_KEYS = new Set([
  ...PROFILE_SETTINGS_CANONICAL_KEYS,
  "autoSubmitOrdinaryResidentOrders",
  "_meta",
  "profileId",
]);
const DESIRED_SOURCE_KEYS = new Set([
  "version",
  "profileId",
  "mode",
  "settingsEpoch",
  "desiredState",
  "restartAttempt",
  "recoveryStatus",
  "nextRetryAt",
  "lastReason",
  "updatedAt",
]);

export function createProfileCanonicalMigration(options = {}) {
  const runtimeSettingsStore = options.runtimeSettingsStore;
  const desiredRunStore = options.desiredRunStore;
  if (typeof runtimeSettingsStore?.runCanonicalMigrationExclusive !== "function") {
    throw new TypeError("runtimeSettingsStore canonical migration support is required");
  }
  if (typeof desiredRunStore?.runCanonicalMigrationExclusive !== "function") {
    throw new TypeError("desiredRunStore canonical migration support is required");
  }

  const fs = options.fs || fsp;
  const runtimeDir = options.runtimeDir || runtimeSettingsStore.runtimeDir;
  if (!path.isAbsolute(runtimeDir || "")) {
    throw new TypeError("An absolute runtimeDir is required for canonical migration");
  }
  const backupDir = options.backupDir
    || path.join(runtimeDir, "system", "canonical-migration-backups");
  if (typeof options.isAliasActive !== "function") {
    throw new TypeError("isAliasActive authority is required for canonical migration");
  }
  const isAliasActive = options.isAliasActive;
  const beforeMigrationStep = options.beforeMigrationStep || (() => {});
  const onMigrationStep = options.onMigrationStep || (() => {});
  const now = options.now || (() => new Date());
  const createMigrationId = options.createMigrationId || randomUUID;
  const discoveryContexts = [
    {
      kind: "runtime",
      directory: path.dirname(runtimeSettingsStore.settingsPath("canonical-inventory-probe")),
    },
    {
      kind: "desired",
      directory: desiredRunStore.dir,
    },
  ];

  async function reconcile(canonicalId) {
    assertCanonicalId(canonicalId);
    return await runtimeSettingsStore.runCanonicalMigrationExclusive(
      canonicalId,
      async (runtimeContext) => await desiredRunStore.runCanonicalMigrationExclusive(
        canonicalId,
        async (desiredContext) => await reconcileLocked(
          canonicalId,
          [runtimeContext, desiredContext],
        ),
      ),
    );
  }

  async function listCanonicalIds() {
    const ids = new Set();
    for (const context of discoveryContexts) {
      let entries;
      try {
        entries = await fs.readdir(context.directory, { withFileTypes: true });
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.name.toLowerCase().endsWith(".json")) continue;
        const rawBase = entry.name.slice(0, -5);
        let sourceId = rawBase;
        try {
          sourceId = decodeURIComponent(rawBase);
        } catch {
          // The raw filename still identifies the fail-closed group.
        }
        const fileCanonicalId = canonicalizeHistoricalId(sourceId);
        if (fileCanonicalId && isCanonicalProfileSettingsId(fileCanonicalId)) {
          ids.add(fileCanonicalId);
        }
        if (context.kind !== "desired" || !entry.isFile()) continue;
        try {
          const parsed = JSON.parse(await fs.readFile(path.join(context.directory, entry.name), "utf8"));
          if (isPlainRecord(parsed) && typeof parsed.profileId === "string") {
            const ownerCanonicalId = canonicalizeHistoricalId(parsed.profileId);
            if (ownerCanonicalId && isCanonicalProfileSettingsId(ownerCanonicalId)) {
              ids.add(ownerCanonicalId);
            }
          }
        } catch {
          // Filename discovery remains authoritative for malformed records.
        }
      }
    }
    return [...ids].sort();
  }

  async function reconcileLocked(canonicalId, contexts) {
    const recovery = await recoverPreparedMigration(canonicalId, contexts);
    if (recovery?.status === "collision") return recovery;
    const recovered = recovery?.recovered === true;
    const sources = sortSources((await Promise.all(
      contexts.map((context) => inventoryContext(fs, context, canonicalId)),
    )).flat());
    const publicSources = sources.map(toPublicSource);

    const invalid = sources.find((source) => source.invalidReason);
    if (invalid) {
      return collision(canonicalId, "invalid-source", publicSources);
    }
    const ownerMismatch = sources.find((source) => (
      source.recordCanonicalId
      && source.fileCanonicalId
      && source.recordCanonicalId !== source.fileCanonicalId
    ));
    if (ownerMismatch) {
      return collision(canonicalId, "owner-mismatch", publicSources);
    }

    let activeAlias = false;
    for (const source of sources.filter((item) => isAliasSource(item, canonicalId))) {
      const aliasId = source.recordProfileId != null && source.recordProfileId !== canonicalId
        ? source.recordProfileId
        : source.sourceId;
      if (await isAliasActive(aliasId, {
        kind: source.kind,
        canonicalId,
        source: toPublicSource(source),
      })) activeAlias = true;
    }
    if (activeAlias) {
      return {
        status: "collision",
        code: ACTIVE_ALIAS_CODE,
        reason: "active-alias",
        canonicalId,
        sources: publicSources,
      };
    }

    const plans = [];
    for (const context of contexts) {
      const group = sources.filter((source) => source.kind === context.kind);
      const prepared = prepareGroupPlan(context, canonicalId, group);
      if (prepared.collision) {
        return collision(canonicalId, prepared.collision, publicSources);
      }
      if (prepared.plan) plans.push(prepared.plan);
    }

    if (plans.length === 0) {
      return {
        status: "clear",
        canonicalId,
        migrated: recovered,
        sources: publicSources,
      };
    }

    const migrationId = createMigrationId();
    const preparedPlans = [];
    let journalPrepared = false;
    try {
      for (const plan of plans) {
        preparedPlans.push(plan);
        await prepareTarget(plan, migrationId);
      }
      const backupSources = preparedPlans.flatMap((plan) => plan.backupSources);
      for (const source of backupSources) await ensureBackup(source, canonicalId);

      const journal = buildJournal({
        migrationId,
        canonicalId,
        plans: preparedPlans,
        createdAt: now().toISOString(),
        runtimeDir,
      });
      await runBefore("journal-write", { canonicalId });
      await writeJsonAtomic(fs, pendingJournalPath(backupDir, canonicalId), journal);
      journalPrepared = true;
      did("journal-prepared", { canonicalId });

      await promotePreparedPlans(preparedPlans);
      await completeJournal(journal);
    } catch (error) {
      for (const plan of preparedPlans) {
        if (plan.createdNormalTarget && !plan.targetVerified) {
          await removeExact(fs, plan.targetPath).catch(() => {});
        }
        if (plan.stagePath && !plan.targetVerified) {
          await removeExact(fs, plan.stagePath).catch(() => {});
        }
        if (plan.stagePath && !journalPrepared) {
          await removeExact(fs, plan.stagePath).catch(() => {});
        }
      }
      throw error;
    }

    return {
      status: "clear",
      canonicalId,
      migrated: true,
      sources: publicSources,
    };
  }

  async function prepareTarget(plan, migrationId) {
    if (!plan.special) {
      if (!plan.exactTarget) {
        await runBefore("target-write", { canonicalId: plan.canonicalId, kind: plan.kind });
        await writeTextAtomic(fs, plan.targetPath, plan.canonicalText);
        plan.createdNormalTarget = true;
      }
      await runBefore("target-verify", { canonicalId: plan.canonicalId, kind: plan.kind });
      await verifyTarget(plan.targetPath, plan.kind, plan.canonicalId, plan.semanticHash);
      plan.targetVerified = true;
      did("target-verified", { canonicalId: plan.canonicalId, kind: plan.kind });
      return plan;
    }

    plan.stagePath = `${plan.targetPath}.${migrationId}.stage`;
    await runBefore("case-stage-write", { canonicalId: plan.canonicalId, kind: plan.kind });
    await writeTextAtomic(fs, plan.stagePath, plan.canonicalText);
    await verifyTarget(plan.stagePath, plan.kind, plan.canonicalId, plan.semanticHash);
    plan.targetVerified = true;
    did("case-stage-verified", { canonicalId: plan.canonicalId, kind: plan.kind });
    return plan;
  }

  async function ensureBackup(source, canonicalId) {
    const backupPath = backupPathFor(backupDir, canonicalId, source);
    source.backupPath = backupPath;
    await runBefore("backup-write", { canonicalId, kind: source.kind });
    if (await existsExact(fs, backupPath)) {
      const existing = await fs.readFile(backupPath, "utf8");
      if (hashText(existing) !== source.contentHash) {
        throw migrationError(
          "PROFILE_CANONICAL_MIGRATION_BACKUP_MISMATCH",
          "Canonical migration backup does not match its source",
        );
      }
    } else {
      await writeTextAtomic(fs, backupPath, source.rawText);
    }
    const verified = await fs.readFile(backupPath, "utf8");
    if (hashText(verified) !== source.contentHash) {
      throw migrationError(
        "PROFILE_CANONICAL_MIGRATION_BACKUP_VERIFY_FAILED",
        "Canonical migration backup verification failed",
      );
    }
    did("backup-verified", { canonicalId, kind: source.kind });
  }

  async function promotePreparedPlans(plans) {
    for (const plan of plans) {
      if (plan.special) {
        await runBefore("case-promote", { canonicalId: plan.canonicalId, kind: plan.kind });
        for (const source of plan.backupSources) {
          await removeExact(fs, source.filePath);
        }
        await fs.rename(plan.stagePath, plan.targetPath);
        await verifyTarget(plan.targetPath, plan.kind, plan.canonicalId, plan.semanticHash);
        did("case-promoted", { canonicalId: plan.canonicalId, kind: plan.kind });
      } else {
        for (const source of plan.backupSources) {
          await removeExact(fs, source.filePath);
        }
      }
    }
  }

  async function recoverPreparedMigration(canonicalId, contexts) {
    const journalPath = pendingJournalPath(backupDir, canonicalId);
    if (!await existsExact(fs, journalPath)) return { recovered: false };
    const journal = await readJsonStrict(fs, journalPath, "PROFILE_CANONICAL_MIGRATION_JOURNAL_INVALID");
    if (
      !isPlainRecord(journal)
      || journal.status !== "prepared"
      || journal.canonicalId !== canonicalId
      || !Array.isArray(journal.targets)
      || !Array.isArray(journal.sources)
    ) {
      throw migrationError(
        "PROFILE_CANONICAL_MIGRATION_JOURNAL_INVALID",
        "Canonical migration journal is invalid",
      );
    }

    const currentSources = sortSources((await Promise.all(
      contexts.map((context) => inventoryContext(fs, context, canonicalId)),
    )).flat());
    const publicSources = currentSources.map(toPublicSource);
    if (currentSources.some((source) => source.invalidReason)) {
      return collision(canonicalId, "invalid-source", publicSources);
    }
    if (currentSources.some((source) => (
      source.recordCanonicalId
      && source.fileCanonicalId
      && source.recordCanonicalId !== source.fileCanonicalId
    ))) {
      return collision(canonicalId, "owner-mismatch", publicSources);
    }
    let activeAlias = false;
    const activeCandidates = [
      ...currentSources.filter((source) => isAliasSource(source, canonicalId)).map((source) => ({
        kind: source.kind,
        sourceId: source.sourceId,
        recordProfileId: source.recordProfileId,
        publicSource: toPublicSource(source),
      })),
      ...journal.sources.map((source) => ({
        kind: source.kind,
        sourceId: source.sourceId,
        recordProfileId: source.recordProfileId || null,
        publicSource: {
          kind: source.kind,
          sourceId: source.sourceId,
          fileName: path.basename(source.source),
          ...(source.recordProfileId ? { recordProfileId: source.recordProfileId } : {}),
        },
      })),
    ];
    const seenActive = new Set();
    for (const source of activeCandidates) {
      const key = `${source.kind}\0${source.sourceId}\0${source.recordProfileId || ""}`;
      if (seenActive.has(key)) continue;
      seenActive.add(key);
      const aliasId = source.recordProfileId != null && source.recordProfileId !== canonicalId
        ? source.recordProfileId
        : source.sourceId;
      if (await isAliasActive(aliasId, {
        kind: source.kind,
        canonicalId,
        source: source.publicSource,
      })) activeAlias = true;
    }
    if (activeAlias) {
      return {
        status: "collision",
        code: ACTIVE_ALIAS_CODE,
        reason: "active-alias",
        canonicalId,
        sources: publicSources,
      };
    }
    for (const target of journal.targets) {
      const hashes = new Set([
        target.semanticHash,
        ...currentSources
          .filter((source) => source.kind === target.kind)
          .map((source) => source.semanticHash),
      ]);
      if (hashes.size > 1) {
        return collision(canonicalId, "semantic-conflict", publicSources);
      }
    }

    const contextByKind = new Map(contexts.map((context) => [context.kind, context]));
    for (const target of journal.targets) {
      const context = contextByKind.get(target.kind);
      if (!context) throw migrationError("PROFILE_CANONICAL_MIGRATION_JOURNAL_INVALID", "Unknown migration target");
      const targetPath = safeResolve(runtimeDir, target.target);
      const stagePath = target.stage ? safeResolve(runtimeDir, target.stage) : null;
      let targetReady = await exactTargetMatches(targetPath, target.kind, canonicalId, target.semanticHash);
      if (!targetReady && stagePath && await existsExact(fs, stagePath)) {
        for (const source of journal.sources.filter((item) => item.kind === target.kind)) {
          await removeExact(fs, safeResolve(runtimeDir, source.source));
        }
        await fs.rename(stagePath, targetPath);
        targetReady = await exactTargetMatches(targetPath, target.kind, canonicalId, target.semanticHash);
      }
      if (!targetReady) {
        const backup = journal.sources.find((item) => item.kind === target.kind);
        if (!backup) throw migrationError("PROFILE_CANONICAL_MIGRATION_RECOVERY_FAILED", "No migration backup is available");
        const backupPath = safeResolve(runtimeDir, backup.backup);
        const backupText = await fs.readFile(backupPath, "utf8");
        if (hashText(backupText) !== backup.contentHash) {
          throw migrationError("PROFILE_CANONICAL_MIGRATION_BACKUP_MISMATCH", "Migration backup is corrupt");
        }
        const evaluatedBackup = evaluateSource(target.kind, canonicalId, backupText);
        if (evaluatedBackup.invalidReason || evaluatedBackup.semanticHash !== target.semanticHash) {
          throw migrationError("PROFILE_CANONICAL_MIGRATION_BACKUP_MISMATCH", "Migration backup is invalid");
        }
        await writeTextAtomic(
          fs,
          targetPath,
          `${JSON.stringify(evaluatedBackup.canonicalValue, null, 2)}\n`,
        );
        targetReady = await exactTargetMatches(targetPath, target.kind, canonicalId, target.semanticHash);
      }
      if (!targetReady) {
        throw migrationError("PROFILE_CANONICAL_MIGRATION_RECOVERY_FAILED", "Migration target recovery failed");
      }

      for (const source of journal.sources.filter((item) => item.kind === target.kind)) {
        const backupPath = safeResolve(runtimeDir, source.backup);
        const backupText = await fs.readFile(backupPath, "utf8");
        if (hashText(backupText) !== source.contentHash) {
          throw migrationError("PROFILE_CANONICAL_MIGRATION_BACKUP_MISMATCH", "Migration backup is corrupt");
        }
        await removeExact(fs, safeResolve(runtimeDir, source.source));
      }
    }
    await completeJournal(journal);
    return { recovered: true };
  }

  async function completeJournal(journal) {
    await runBefore("journal-complete", { canonicalId: journal.canonicalId });
    const timestamp = journal.createdAt;
    for (const source of journal.sources) {
      const sourceHash = hashText(`${source.kind}\0${source.source}`).slice(0, 16);
      const completedPath = path.join(
        backupDir,
        "records",
        encodeURIComponent(journal.canonicalId),
        `${journal.migrationId}-${sourceHash}.json`,
      );
      const completed = {
        version: 1,
        kind: source.kind,
        canonicalId: journal.canonicalId,
        sourceRelativePath: source.source,
        backupRelativePath: source.backup,
        status: "complete",
        timestamp,
      };
      if (!await existsExact(fs, completedPath)) {
        await writeJsonAtomic(fs, completedPath, completed);
      } else {
        const existing = await readJsonStrict(
          fs,
          completedPath,
          "PROFILE_CANONICAL_MIGRATION_JOURNAL_INVALID",
        );
        if (JSON.stringify(existing) !== JSON.stringify(completed)) {
          throw migrationError(
            "PROFILE_CANONICAL_MIGRATION_JOURNAL_INVALID",
            "Completed canonical migration record does not match the pending journal",
          );
        }
      }
    }
    await removeExact(fs, pendingJournalPath(backupDir, journal.canonicalId));
  }

  async function verifyTarget(filePath, kind, canonicalId, semanticHash) {
    const text = await fs.readFile(filePath, "utf8");
    const evaluated = evaluateSource(kind, canonicalId, text);
    if (
      evaluated.invalidReason
      || evaluated.semanticHash !== semanticHash
      || (kind === "desired" && evaluated.recordProfileId !== canonicalId)
      || (kind === "runtime" && evaluated.recordProfileId && evaluated.recordProfileId !== canonicalId)
    ) {
      throw migrationError(
        "PROFILE_CANONICAL_MIGRATION_TARGET_VERIFY_FAILED",
        "Canonical migration target verification failed",
      );
    }
  }

  async function exactTargetMatches(filePath, kind, canonicalId, semanticHash) {
    if (!await existsExact(fs, filePath)) return false;
    try {
      await verifyTarget(filePath, kind, canonicalId, semanticHash);
      return true;
    } catch {
      return false;
    }
  }

  async function runBefore(step, context) {
    await beforeMigrationStep(step, context);
  }

  function did(step, context) {
    onMigrationStep(step, context);
  }

  return { reconcile, listCanonicalIds };
}

async function inventoryContext(fs, context, canonicalId) {
  let entries;
  try {
    entries = await fs.readdir(context.directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const targetName = path.basename(context.targetPath);
  const sources = [];
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith(".json")) continue;
    const filePath = path.join(context.directory, entry.name);
    const rawBase = entry.name.slice(0, -5);
    let sourceId = rawBase;
    let decodeInvalid = false;
    try {
      sourceId = decodeURIComponent(rawBase);
    } catch {
      decodeInvalid = true;
    }
    const fileCanonicalId = canonicalizeHistoricalId(sourceId);
    if (!entry.isFile()) {
      if (fileCanonicalId === canonicalId) {
        sources.push({
          kind: context.kind,
          sourceId,
          fileName: entry.name,
          filePath,
          targetPath: context.targetPath,
          targetName,
          fileCanonicalId,
          recordProfileId: null,
          recordCanonicalId: null,
          rawText: "",
          contentHash: hashText(""),
          invalidReason: "unsupported-directory-entry",
          semanticHash: null,
          canonicalValue: null,
        });
      }
      continue;
    }
    let rawText;
    let parsed;
    let parseInvalid = false;
    try {
      rawText = await fs.readFile(filePath, "utf8");
      parsed = JSON.parse(rawText);
    } catch {
      parseInvalid = true;
      rawText = rawText ?? "";
    }
    const recordProfileId = isPlainRecord(parsed) && Object.hasOwn(parsed, "profileId")
      ? String(parsed.profileId ?? "")
      : null;
    const recordCanonicalId = recordProfileId
      ? canonicalizeHistoricalId(recordProfileId)
      : null;
    if (fileCanonicalId !== canonicalId && recordCanonicalId !== canonicalId) continue;

    const evaluated = parseInvalid
      ? { invalidReason: "invalid-json" }
      : evaluateParsedSource(context.kind, canonicalId, parsed);
    sources.push({
      kind: context.kind,
      sourceId,
      fileName: entry.name,
      filePath,
      targetPath: context.targetPath,
      targetName,
      fileCanonicalId,
      recordProfileId,
      recordCanonicalId,
      rawText,
      contentHash: hashText(rawText),
      invalidReason: decodeInvalid ? "invalid-filename" : evaluated.invalidReason,
      semanticHash: evaluated.semanticHash,
      canonicalValue: evaluated.canonicalValue,
    });
  }
  return sources;
}

function evaluateSource(kind, canonicalId, rawText) {
  try {
    return evaluateParsedSource(kind, canonicalId, JSON.parse(rawText));
  } catch {
    return { invalidReason: "invalid-json" };
  }
}

function evaluateParsedSource(kind, canonicalId, parsed) {
  if (!isPlainRecord(parsed)) return { invalidReason: "not-an-object" };
  return kind === "runtime"
    ? evaluateRuntimeSource(parsed)
    : evaluateDesiredSource(parsed, canonicalId);
}

function evaluateRuntimeSource(parsed) {
  if (Object.keys(parsed).some((key) => !RUNTIME_SOURCE_KEYS.has(key))) {
    return { invalidReason: "unknown-runtime-field" };
  }
  if (Object.hasOwn(parsed, "profileId") && typeof parsed.profileId !== "string") {
    return { invalidReason: "invalid-runtime-owner" };
  }
  let settings;
  try {
    settings = normalizeCanonicalProfileSettings(parsed);
  } catch {
    return { invalidReason: "invalid-runtime-settings" };
  }
  const metadata = parsed._meta;
  let settingsEpoch;
  let settingsRevision;
  if (metadata !== undefined) {
    if (!isPlainRecord(metadata)) return { invalidReason: "invalid-runtime-metadata" };
    if (Object.keys(metadata).some((key) => !["settingsEpoch", "settingsRevision"].includes(key))) {
      return { invalidReason: "unknown-runtime-metadata-field" };
    }
    const hasEpoch = Object.hasOwn(metadata, "settingsEpoch");
    const hasRevision = Object.hasOwn(metadata, "settingsRevision");
    if (hasEpoch !== hasRevision) return { invalidReason: "partial-runtime-metadata" };
    if (hasEpoch) {
      if (!isProfileSettingsEpoch(metadata.settingsEpoch)) {
        return { invalidReason: "invalid-runtime-epoch" };
      }
      if (!isProfileSettingsRevision(metadata.settingsRevision)) {
        return { invalidReason: "invalid-runtime-revision" };
      }
      settingsEpoch = metadata.settingsEpoch;
      settingsRevision = metadata.settingsRevision;
    }
  }
  const signature = [
    PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => settings[key]),
    settingsEpoch ?? null,
    settingsRevision ?? null,
  ];
  return {
    semanticHash: hashText(JSON.stringify(signature)),
    recordProfileId: Object.hasOwn(parsed, "profileId") ? parsed.profileId : null,
    canonicalValue: {
      ...settings,
      ...(settingsEpoch
        ? { _meta: { settingsEpoch, settingsRevision } }
        : {}),
    },
  };
}

function evaluateDesiredSource(parsed, canonicalId) {
  if (Object.keys(parsed).some((key) => !DESIRED_SOURCE_KEYS.has(key))) {
    return { invalidReason: "unknown-desired-field" };
  }
  if (parsed.version !== undefined && parsed.version !== 1) {
    return { invalidReason: "invalid-desired-version" };
  }
  const rawProfileId = typeof parsed.profileId === "string" ? parsed.profileId : "";
  const profileId = rawProfileId.trim();
  if (!profileId) return { invalidReason: "invalid-desired-owner" };
  if (parsed.mode !== undefined && parsed.mode !== "loop") return { invalidReason: "invalid-desired-mode" };
  if (!['running', 'stopped'].includes(parsed.desiredState)) {
    return { invalidReason: "invalid-desired-state" };
  }
  if (!Number.isSafeInteger(parsed.restartAttempt) || parsed.restartAttempt < 0) {
    return { invalidReason: "invalid-restart-attempt" };
  }
  for (const key of ["recoveryStatus", "nextRetryAt", "lastReason", "updatedAt"]) {
    if (parsed[key] !== undefined && parsed[key] !== null && typeof parsed[key] !== "string") {
      return { invalidReason: `invalid-${key}` };
    }
  }
  if (Object.hasOwn(parsed, "settingsEpoch") && !isProfileSettingsEpoch(parsed.settingsEpoch)) {
    return { invalidReason: "invalid-desired-epoch" };
  }
  const semantic = [
    Object.hasOwn(parsed, "settingsEpoch") ? parsed.settingsEpoch : null,
    parsed.desiredState,
    "loop",
    parsed.restartAttempt,
    normalizeDesiredNullable(parsed.recoveryStatus),
    normalizeDesiredNullable(parsed.nextRetryAt),
    normalizeDesiredNullable(parsed.lastReason),
  ];
  return {
    semanticHash: hashText(JSON.stringify(semantic)),
    recordProfileId: rawProfileId,
    canonicalValue: {
      version: 1,
      profileId: canonicalId,
      mode: "loop",
      desiredState: parsed.desiredState,
      restartAttempt: parsed.restartAttempt,
      recoveryStatus: normalizeDesiredNullable(parsed.recoveryStatus),
      nextRetryAt: normalizeDesiredNullable(parsed.nextRetryAt),
      lastReason: normalizeDesiredNullable(parsed.lastReason),
      updatedAt: normalizeDesiredNullable(parsed.updatedAt),
      ...(Object.hasOwn(parsed, "settingsEpoch")
        ? { settingsEpoch: parsed.settingsEpoch }
        : {}),
    },
  };
}

function normalizeDesiredNullable(value) {
  return value === undefined || value === null || value === "" ? null : value;
}

function prepareGroupPlan(context, canonicalId, sources) {
  if (sources.length === 0) return { plan: null };
  const hashes = new Set(sources.map((source) => source.semanticHash));
  if (hashes.size !== 1) return { collision: "semantic-conflict" };

  const exactTarget = sources.find((source) => source.fileName === path.basename(context.targetPath));
  const selected = exactTarget || [...sources].sort(compareSourceNames)[0];
  const selectedNeedsRewrite = Boolean(
    exactTarget
    && exactTarget.recordProfileId != null
    && exactTarget.recordProfileId !== canonicalId
  );
  const aliases = sources.filter((source) => source !== exactTarget || selectedNeedsRewrite);
  if (aliases.length === 0) return { plan: null };

  const hasCaseOnlySource = !exactTarget && aliases.some((source) => (
    source.filePath.toLowerCase() === context.targetPath.toLowerCase()
    && source.filePath !== context.targetPath
  ));
  return {
    plan: {
      kind: context.kind,
      canonicalId,
      targetPath: context.targetPath,
      exactTarget,
      selected,
      canonicalText: `${JSON.stringify(selected.canonicalValue, null, 2)}\n`,
      semanticHash: selected.semanticHash,
      backupSources: aliases,
      special: selectedNeedsRewrite || hasCaseOnlySource,
      stagePath: null,
      targetVerified: false,
      createdNormalTarget: false,
    },
  };
}

function buildJournal({ migrationId, canonicalId, plans, createdAt, runtimeDir }) {
  return {
    version: 1,
    migrationId,
    canonicalId,
    status: "prepared",
    createdAt,
    targets: plans.map((plan) => ({
      kind: plan.kind,
      target: relativeSafe(plan.targetPath, runtimeDir),
      stage: plan.stagePath
        ? relativeSafe(plan.stagePath, runtimeDir)
        : null,
      semanticHash: plan.semanticHash,
      special: plan.special,
    })),
    sources: plans.flatMap((plan) => plan.backupSources.map((source) => ({
      kind: source.kind,
      sourceId: source.sourceId,
      ...(source.recordProfileId ? { recordProfileId: source.recordProfileId } : {}),
      source: relativeSafe(source.filePath, runtimeDir),
      backup: relativeSafe(source.backupPath, runtimeDir),
      contentHash: source.contentHash,
    }))),
  };
}

function pendingJournalPath(backupDir, canonicalId) {
  return path.join(backupDir, "journals", `${encodeURIComponent(canonicalId)}.pending.json`);
}

function backupPathFor(backupDir, canonicalId, source) {
  const nameHash = hashText(`${source.kind}\0${source.fileName}`).slice(0, 16);
  return path.join(
    backupDir,
    source.kind,
    encodeURIComponent(canonicalId),
    `${nameHash}-${encodeURIComponent(source.fileName)}`,
  );
}

function collision(canonicalId, reason, sources) {
  return {
    status: "collision",
    code: COLLISION_CODE,
    reason,
    canonicalId,
    sources,
  };
}

function toPublicSource(source) {
  return {
    kind: source.kind,
    sourceId: source.sourceId,
    fileName: source.fileName,
    ...(source.recordProfileId ? { recordProfileId: source.recordProfileId } : {}),
  };
}

function isAliasSource(source, canonicalId) {
  return source.sourceId !== canonicalId
    || (source.recordProfileId != null && source.recordProfileId !== canonicalId)
    || source.fileName !== path.basename(source.targetPath);
}

function canonicalizeHistoricalId(value) {
  const id = String(value ?? "").trim();
  return id ? sanitizeProfileId(id) : null;
}

function assertCanonicalId(canonicalId) {
  if (!isCanonicalProfileSettingsId(canonicalId)) {
    const error = new Error("Profile ID must already be canonical");
    error.code = "INVALID_PROFILE_ID_CANONICAL_FORM";
    throw error;
  }
}

function sortSources(sources) {
  return [...sources].sort((left, right) => (
    left.kind.localeCompare(right.kind) || compareSourceNames(left, right)
  ));
}

function compareSourceNames(left, right) {
  return left.fileName < right.fileName ? -1 : left.fileName > right.fileName ? 1 : 0;
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJsonAtomic(fs, filePath, value) {
  await writeTextAtomic(fs, filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(fs, filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, text, "utf8");
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function readJsonStrict(fs, filePath, code) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw migrationError(code, "Canonical migration JSON is invalid");
    }
    throw error;
  }
}

async function existsExact(fs, filePath) {
  try {
    const names = await fs.readdir(path.dirname(filePath));
    return names.includes(path.basename(filePath));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function removeExact(fs, filePath) {
  if (!await existsExact(fs, filePath)) return;
  await fs.rm(filePath, { force: true });
}

function safeResolve(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw migrationError("PROFILE_CANONICAL_MIGRATION_JOURNAL_INVALID", "Migration path escapes runtimeDir");
  }
  return resolved;
}

function relativeSafe(filePath, root) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw migrationError("PROFILE_CANONICAL_MIGRATION_PATH_INVALID", "Migration path is outside runtimeDir");
  }
  return relative;
}

function migrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
