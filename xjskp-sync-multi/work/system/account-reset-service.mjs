import crypto from "node:crypto";
import * as defaultFs from "node:fs/promises";
import path from "node:path";

import { inventoryAccountRuntimeTargets } from "./account-runtime-artifacts.mjs";

const OPERATION_VERSION = 1;
const STEP_ORDER = Object.freeze([
  "desired-stopped",
  "control-cleared",
  "status-archived",
  "logs-archived",
  "credentials-cleared",
  "verified",
]);

export function createAccountResetService(options = {}) {
  const runtimeDir = path.resolve(options.runtimeDir || path.join(process.cwd(), "runtime"));
  const profileStore = options.profileStore;
  const fs = options.fs || defaultFs;
  const now = options.now || (() => new Date());
  const randomUUIDFn = options.randomUUIDFn || crypto.randomUUID;
  const afterStep = options.afterStep || (() => {});
  const memoryBarriers = new Set();
  const operationsDir = path.join(runtimeDir, "system", "account-reset", "operations");
  const archiveRoot = path.join(runtimeDir, "system", "account-reset", "archive");

  async function plan(requestedProfileIds = "all") {
    const inventory = await inventoryAccountRuntimeTargets({ runtimeDir, fs });
    if (!inventory.writable) {
      const collision = inventory.collisions[0];
      throw resetError(
        collision ? "PROFILE_ID_CANONICAL_COLLISION" : "ACCOUNT_RESET_INVENTORY_INVALID",
        collision
          ? `Canonical profile collision: ${collision.profileId}`
          : "Account runtime inventory contains unowned or invalid artifacts",
        { inventoryErrors: inventory.errors, collisions: inventory.collisions },
      );
    }

    let targets = inventory.targets;
    if (requestedProfileIds !== "all") {
      const requested = [...new Set((requestedProfileIds || []).map(canonicalizeRequestedId))];
      targets = requested.map((profileId) => {
        const target = inventory.targets.find((candidate) => candidate.profileId === profileId);
        if (!target) throw resetError("PROFILE_NOT_FOUND", `Profile/runtime target not found: ${profileId}`);
        return target;
      });
    }
    for (const target of targets) {
      if (target.profilePresent && target.rawIds.some((rawId) => rawId !== target.profileId)) {
        throw resetError(
          "PROFILE_ID_NON_CANONICAL",
          `Profile record must be canonical before credential reset: ${target.profileId}`,
        );
      }
    }
    return {
      version: 1,
      runtimeDir,
      targets: targets.map(cloneTarget),
      inventoryErrors: [],
    };
  }

  async function execute(resetPlan, executeOptions = {}) {
    assertPlan(resetPlan, runtimeDir);
    const operationId = normalizeOperationId(executeOptions.operationId || randomUUIDFn());
    const releaseBarrier = beginProfileResetBarrier(resetPlan.targets.map((target) => target.profileId));
    try {
      await validateQuiescent(executeOptions, resetPlan);
      if (await pathExists(operationPath(operationId))) {
        throw resetError("ACCOUNT_RESET_OPERATION_EXISTS", `Reset operation already exists: ${operationId}`);
      }
      const operation = createOperation(operationId, resetPlan.targets);
      await writeOperation(operation);
      return await runOperation(operation, executeOptions);
    } finally {
      releaseBarrier();
    }
  }

  async function resume(operationId, executeOptions = {}) {
    const operation = await readOperation(normalizeOperationId(operationId));
    if (operation.state === "completed") return summarizeOperation(operation);
    const releaseBarrier = beginProfileResetBarrier(operation.targets.map((target) => target.profileId));
    try {
      const resetPlan = operationToPlan(operation);
      await validateQuiescent(executeOptions, resetPlan);
      return await runOperation(operation, executeOptions);
    } finally {
      releaseBarrier();
    }
  }

  async function runOperation(operation, executeOptions) {
    operation.state = "in-progress";
    operation.updatedAt = now().toISOString();
    operation.lastError = null;
    await writeOperation(operation);
    try {
      for (const target of operation.targets) {
        for (const step of STEP_ORDER) {
          if (target.completedSteps.includes(step)) continue;
          if (step === "desired-stopped") await stopDesired(target, operation);
          if (step === "control-cleared") await clearControlArtifacts(target);
          if (step === "status-archived") await archiveKind(target, operation, "status");
          if (step === "logs-archived") await archiveKind(target, operation, "logs");
          if (step === "credentials-cleared") await clearCredentials(target, operation);
          if (step === "verified") await verifyTarget(target, operation);
          target.completedSteps.push(step);
          operation.updatedAt = now().toISOString();
          await writeOperation(operation);
          await afterStep({ operationId: operation.operationId, profileId: target.profileId, step });
          await executeOptions.afterStep?.({ operationId: operation.operationId, profileId: target.profileId, step });
        }
      }
      operation.state = "completed";
      operation.completedAt = now().toISOString();
      operation.updatedAt = operation.completedAt;
      operation.lastError = null;
      await writeOperation(operation);
      return summarizeOperation(operation);
    } catch (error) {
      operation.state = "incomplete";
      operation.updatedAt = now().toISOString();
      operation.lastError = {
        code: String(error?.code || "ACCOUNT_RESET_STEP_FAILED"),
        message: String(error?.message || error).slice(0, 500),
        at: operation.updatedAt,
      };
      await writeOperation(operation).catch(() => {});
      throw resetError(
        "PROFILE_RESET_INCOMPLETE",
        `Credential reset is incomplete; resume operation ${operation.operationId}: ${error?.message || error}`,
        {
          statusCode: 503,
          operationId: operation.operationId,
          completedSteps: operation.targets.map((target) => ({
            profileId: target.profileId,
            completedSteps: [...target.completedSteps],
          })),
          cause: error,
        },
      );
    }
  }

  async function validateQuiescent(executeOptions, resetPlan) {
    if (typeof executeOptions.validateQuiescent !== "function") {
      throw resetError(
        "ACCOUNT_RESET_QUIESCENCE_VALIDATOR_REQUIRED",
        "Credential reset requires an explicit quiescence validator",
      );
    }
    await executeOptions.validateQuiescent(resetPlan);
  }

  async function stopDesired(target, operation) {
    const desiredArtifacts = target.artifacts.filter((artifact) => artifact.kind === "desired-run");
    const current = desiredArtifacts.length ? await readJsonOrNull(desiredArtifacts[0].path) : null;
    if (!target.profilePresent) {
      if (desiredArtifacts.length === 0) return;
      if (!current || !Object.hasOwn(current, "settingsEpoch") || !current.settingsEpoch) {
        for (const artifact of desiredArtifacts) {
          await archiveFileArtifact(artifact.path, target, operation, "desired");
        }
        return;
      }
      await writeStoppedDesired(target, current, current.settingsEpoch);
      await removeAlternateArtifacts(desiredArtifacts, desiredPath(target.profileId));
      return;
    }

    const accountArtifact = target.artifacts.find((artifact) => artifact.kind === "profile");
    const account = await readJsonRequired(accountArtifact.path);
    const epoch = Object.hasOwn(account, "settingsEpoch") ? account.settingsEpoch : undefined;
    await writeStoppedDesired(target, current || {}, epoch);
    await removeAlternateArtifacts(desiredArtifacts, desiredPath(target.profileId));
  }

  async function writeStoppedDesired(target, _previous, settingsEpoch) {
    const record = {
      version: 1,
      profileId: target.profileId,
      mode: "loop",
      desiredState: "stopped",
      restartAttempt: 0,
      recoveryStatus: "stopped",
      nextRetryAt: null,
      lastReason: "credentials-reset",
      updatedAt: now().toISOString(),
    };
    if (settingsEpoch === undefined) delete record.settingsEpoch;
    else record.settingsEpoch = settingsEpoch;
    await writeJsonAtomic(desiredPath(target.profileId), record);
  }

  async function clearControlArtifacts(target) {
    for (const artifact of target.artifacts) {
      if (!["runtime-settings", "active-task", "last-exit", "waterwheel-bucket"].includes(artifact.kind)) continue;
      await removePath(artifact.path);
    }
  }

  async function archiveKind(target, operation, kind) {
    for (const artifact of target.artifacts.filter((candidate) => candidate.kind === kind)) {
      const destination = path.join(
        archiveRoot,
        operation.operationId,
        target.profileId,
        kind,
      );
      await movePathIdempotent(artifact.path, destination);
    }
  }

  async function archiveFileArtifact(source, target, operation, category) {
    const destination = path.join(
      archiveRoot,
      operation.operationId,
      target.profileId,
      category,
      path.basename(source),
    );
    await movePathIdempotent(source, destination);
  }

  async function clearCredentials(target, operation) {
    if (!target.profilePresent) return;
    if (!profileStore?.resetCredentials) {
      throw resetError("PROFILE_RESET_NOT_SUPPORTED", "Profile store does not support credential reset");
    }
    const accountArtifact = target.artifacts.find((artifact) => artifact.kind === "profile");
    if (!accountArtifact) throw resetError("PROFILE_NOT_FOUND", `Profile record missing: ${target.profileId}`);
    const before = await readJsonRequired(accountArtifact.path);
    if (!target.profileInvariantDigest) {
      target.profileInvariantDigest = profileInvariantDigest(before);
      operation.updatedAt = now().toISOString();
      await writeOperation(operation);
    }
    await profileStore.resetCredentials(target.profileId);
    const after = await readJsonRequired(accountArtifact.path);
    if (profileInvariantDigest(after) !== target.profileInvariantDigest) {
      throw resetError("PROFILE_RESET_INVARIANT_CHANGED", `Profile settings identity changed: ${target.profileId}`);
    }
  }

  async function verifyTarget(target, operation) {
    for (const artifact of target.artifacts) {
      if (["runtime-settings", "active-task", "last-exit", "waterwheel-bucket", "status", "logs"].includes(artifact.kind)) {
        if (await pathExists(artifact.path)) {
          throw resetError("PROFILE_RESET_VERIFY_FAILED", `Artifact remains after reset: ${artifact.relativePath}`);
        }
      }
    }
    if (target.profilePresent) {
      const accountArtifact = target.artifacts.find((artifact) => artifact.kind === "profile");
      const account = await readJsonRequired(accountArtifact.path);
      if (account.secrets && Object.keys(account.secrets).length > 0) {
        throw resetError("PROFILE_RESET_VERIFY_FAILED", `Credentials remain: ${target.profileId}`);
      }
      if (account.lastValidatedAt !== null || account.serverIdx !== null || account.serverText !== null) {
        throw resetError("PROFILE_RESET_VERIFY_FAILED", `Validation state remains: ${target.profileId}`);
      }
      if (target.profileInvariantDigest && profileInvariantDigest(account) !== target.profileInvariantDigest) {
        throw resetError("PROFILE_RESET_INVARIANT_CHANGED", `Profile invariant changed: ${target.profileId}`);
      }
    }
    const desired = await readJsonOrNull(desiredPath(target.profileId));
    if (desired?.desiredState === "running") {
      throw resetError("PROFILE_RESET_VERIFY_FAILED", `Desired state remains running: ${target.profileId}`);
    }
    return { operationId: operation.operationId, profileId: target.profileId };
  }

  async function verify(operationId) {
    const operation = await readOperation(normalizeOperationId(operationId));
    for (const target of operation.targets) await verifyTarget(target, operation);
    return summarizeOperation(operation);
  }

  function beginProfileResetBarrier(profileIds) {
    const ids = [...new Set(profileIds.map(canonicalizeRequestedId))];
    for (const profileId of ids) {
      if (memoryBarriers.has(profileId)) {
        throw resetError("PROFILE_RESET_INCOMPLETE", `Credential reset already in progress: ${profileId}`);
      }
    }
    ids.forEach((profileId) => memoryBarriers.add(profileId));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      ids.forEach((profileId) => memoryBarriers.delete(profileId));
    };
  }

  async function assertProfileReady(profileId) {
    const id = canonicalizeRequestedId(profileId);
    if (memoryBarriers.has(id) || await hasIncompleteOperation(id)) {
      const error = resetError("PROFILE_RESET_INCOMPLETE", `Credential reset is incomplete: ${id}`);
      error.statusCode = 503;
      throw error;
    }
  }

  async function hasIncompleteOperation(profileId) {
    let names;
    try {
      names = await fs.readdir(operationsDir);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    for (const name of names.filter((entry) => entry.toLowerCase().endsWith(".json"))) {
      let operation;
      try {
        operation = await readJsonOrNull(path.join(operationsDir, name));
      } catch (error) {
        const invalid = resetError(
          "PROFILE_RESET_INCOMPLETE",
          `Credential reset journal is unreadable: ${name}`,
          { cause: error },
        );
        invalid.statusCode = 503;
        throw invalid;
      }
      if (!operation || operation.state === "completed") continue;
      if (operation.targets?.some((target) => target.profileId === profileId)) return true;
    }
    return false;
  }

  function createOperation(operationId, targets) {
    const createdAt = now().toISOString();
    return {
      version: OPERATION_VERSION,
      operationId,
      state: "planned",
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
      lastError: null,
      targets: targets.map((target) => ({
        profileId: target.profileId,
        profilePresent: target.profilePresent,
        rawIds: [...target.rawIds],
        artifacts: target.artifacts.map((artifact) => ({
          kind: artifact.kind,
          path: artifact.path,
          relativePath: artifact.relativePath,
          rawProfileId: artifact.rawProfileId,
          source: artifact.source,
        })),
        completedSteps: [],
        profileInvariantDigest: null,
      })),
    };
  }

  function operationToPlan(operation) {
    return {
      version: 1,
      runtimeDir,
      targets: operation.targets.map((target) => ({
        ...target,
        artifacts: target.artifacts.map((artifact) => ({
          ...artifact,
          path: resolveRuntimeRelative(artifact.relativePath),
        })),
      })),
    };
  }

  async function readOperation(operationId) {
    const operation = await readJsonRequired(operationPath(operationId));
    if (operation.version !== OPERATION_VERSION || operation.operationId !== operationId) {
      throw resetError("ACCOUNT_RESET_JOURNAL_INVALID", `Invalid reset operation: ${operationId}`);
    }
    return operationToRuntimeOperation(operation);
  }

  function operationToRuntimeOperation(operation) {
    return {
      ...operation,
      targets: operation.targets.map((target) => ({
        ...target,
        completedSteps: [...(target.completedSteps || [])],
        artifacts: (target.artifacts || []).map((artifact) => ({
          ...artifact,
          path: resolveRuntimeRelative(artifact.relativePath),
        })),
      })),
    };
  }

  async function writeOperation(operation) {
    const serializable = {
      ...operation,
      targets: operation.targets.map((target) => ({
        profileId: target.profileId,
        profilePresent: target.profilePresent,
        rawIds: target.rawIds,
        artifacts: target.artifacts.map(({ path: _path, ...artifact }) => artifact),
        completedSteps: target.completedSteps,
        profileInvariantDigest: target.profileInvariantDigest || null,
      })),
    };
    await writeJsonAtomic(operationPath(operation.operationId), serializable);
  }

  function operationPath(operationId) {
    return path.join(operationsDir, `${operationId}.json`);
  }

  function desiredPath(profileId) {
    return path.join(runtimeDir, "system", "desired-runs", `${encodeURIComponent(profileId)}.json`);
  }

  function resolveRuntimeRelative(relativePath) {
    const candidate = path.resolve(runtimeDir, ...String(relativePath || "").split("/"));
    if (candidate !== runtimeDir && !candidate.startsWith(`${runtimeDir}${path.sep}`)) {
      throw resetError("ACCOUNT_RESET_PATH_ESCAPE", "Artifact path escapes runtimeDir");
    }
    return candidate;
  }

  async function writeJsonAtomic(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await fs.rename(tempPath, filePath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async function readJsonRequired(filePath) {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  }

  async function readJsonOrNull(filePath) {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function movePathIdempotent(source, destination) {
    const sourceExists = await pathExists(source);
    const destinationExists = await pathExists(destination);
    if (!sourceExists && destinationExists) return;
    if (!sourceExists) return;
    if (destinationExists) {
      throw resetError("ACCOUNT_RESET_ARCHIVE_COLLISION", `Archive destination already exists: ${destination}`);
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
  }

  async function removeAlternateArtifacts(artifacts, canonicalPath) {
    for (const artifact of artifacts) {
      if (path.resolve(artifact.path) === path.resolve(canonicalPath)) continue;
      await removePath(artifact.path);
    }
  }

  async function removePath(filePath) {
    await fs.rm(filePath, { recursive: true, force: true });
  }

  async function pathExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  return {
    plan,
    execute,
    resume,
    verify,
    assertProfileReady,
    beginProfileResetBarrier,
    operationsDir,
    archiveRoot,
  };
}

function profileInvariantDigest(record) {
  const invariant = {
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
    settings: record.settings,
    settingsEpoch: propertyState(record, "settingsEpoch"),
    settingsRevision: propertyState(record, "settingsRevision"),
    settingsKeyRevisions: propertyState(record, "settingsKeyRevisions"),
  };
  return crypto.createHash("sha256").update(JSON.stringify(invariant), "utf8").digest("hex");
}

function propertyState(value, key) {
  return Object.hasOwn(value, key) ? { present: true, value: value[key] } : { present: false };
}

function summarizeOperation(operation) {
  return {
    operationId: operation.operationId,
    state: operation.state,
    targets: operation.targets.map((target) => ({
      profileId: target.profileId,
      profilePresent: target.profilePresent,
      completedSteps: [...target.completedSteps],
    })),
    completedAt: operation.completedAt || null,
  };
}

function cloneTarget(target) {
  return {
    profileId: target.profileId,
    profilePresent: target.profilePresent,
    rawIds: [...target.rawIds],
    collision: target.collision,
    artifacts: target.artifacts.map((artifact) => ({ ...artifact })),
  };
}

function canonicalizeRequestedId(value) {
  const id = String(value || "").trim();
  if (!id || !/^[a-z0-9_-]+$/.test(id)) {
    throw resetError("INVALID_PROFILE_ID", `Invalid canonical profileId: ${id || "<empty>"}`);
  }
  return id;
}

function normalizeOperationId(value) {
  const operationId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
    throw resetError("INVALID_ACCOUNT_RESET_OPERATION_ID", "Invalid account reset operationId");
  }
  return operationId;
}

function assertPlan(plan, runtimeDir) {
  if (!plan || plan.version !== 1 || path.resolve(plan.runtimeDir) !== runtimeDir || !Array.isArray(plan.targets)) {
    throw resetError("ACCOUNT_RESET_PLAN_INVALID", "Invalid account reset plan");
  }
}

function resetError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}
