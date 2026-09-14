import http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createLegacyCredentialMigrator } from "./legacy-credentials.mjs";
import { createGameVersionScheduler } from "./game-version-scheduler.mjs";
import { createGameVersionService } from "./game-version-service.mjs";
import { readGameCodeStatus } from "./game-code-status.mjs";
import { createGameDataOperationCoordinator } from "./game-data-operation-coordinator.mjs";
import { createGameDataSyncService } from "./game-data-sync-service.mjs";
import { createLocalRequestGuard } from "./local-request-guard.mjs";
import { createAutomationRunner, normalizeMaxParallelTasks } from "./process-manager.mjs";
import { createProfileOperationCoordinator } from "./profile-operation-coordinator.mjs";
import { createDesiredRunStore } from "./automation-recovery.mjs";
import { createAccountResetService } from "./account-reset-service.mjs";
import {
  createProfileStore,
} from "./profile-store.mjs";
import { createProfileCanonicalMigration } from "./profile-canonical-migration.mjs";
import {
  PROFILE_SETTINGS_PROTOCOL_VERSION,
  isCanonicalProfileSettingsId,
} from "./profile-settings-protocol.mjs";
import {
  completeProfileSettingsMutation,
  createProfileSettingsKernel,
  createProfileSettingsService,
  prepareProfileSettingsMutationEnvelope,
} from "./profile-settings-service.mjs";
import { createProfileStartCoordination } from "./profile-start-coordination.mjs";
import { createRuntimeSettingsStore } from "./runtime-settings-store.mjs";
import { createSystemSettingsStore } from "./system-settings-store.mjs";
import {
  isSafeTeamOrderHtmlName,
  listTeamOrderArtifacts,
  resolveRealPathWithinRoot,
} from "./team-order-artifacts.mjs";
import {
  backupServerLock,
  clearServerLock,
  readServerLock,
  serverLockPath,
  writeServerLock,
} from "./runtime-lock.mjs";
import {
  acquireServerSingletonGuard,
  resolveServerGuardIdentity,
} from "./server-singleton-guard.mjs";
import { isSafeLogName, listLogFiles, readJsonFileSafe, readLogFile } from "./status-store.mjs";
import { buildProfileStatusSummary } from "./status-summary.mjs";
import { buildProfileStatusProjection } from "./status-projection.mjs";
import {
  createExperienceGuardRearmRequest,
  createExperienceGuardSettlementRecoveryRequest,
  createPersistentExperienceLevelGuard,
} from "../experience-guard-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 43722;
const DEFAULT_STARTUP_CONFIRM_MS = 10000;
const SESSION_EXPIRED_EXIT_CODE = 42;
const VALIDATION_SESSION_EXPIRED_MESSAGE = "验证失败：会话已过期，请重新导入最新凭据。";
const VALIDATION_MISSING_SERVER_MESSAGE = "验证失败：未能确认账号区服，请重新导入最新凭据。";

export function createSystemServer(options = {}) {
  const rootDir = options.rootDir || path.resolve(__dirname, "..", "..");
  const runtimeDir = options.runtimeDir || path.join(rootDir, "runtime");
  const publicDir = options.publicDir || path.join(__dirname, "public");
  const listenHost = options.listenHost || "::";
  const profileStore = options.profileStore || createProfileStore({
    accountsDir: path.join(runtimeDir, "accounts"),
  });
  const accountResetService = options.accountResetService || createAccountResetService({
    runtimeDir,
    profileStore,
  });
  const gameDataOperationCoordinator = options.gameDataOperationCoordinator
    || createGameDataOperationCoordinator();
  const gameVersionService = options.gameVersionService || createGameVersionService({
    rootDir,
    runtimeDir,
    profileStore,
    queryLatestVersion: options.queryLatestGameVersion,
    timeoutMs: options.gameVersionTimeoutMs,
    fs: options.gameVersionFs,
    now: options.gameVersionNow,
    operationCoordinator: gameDataOperationCoordinator,
  });
  const gameVersionScheduler = options.gameVersionScheduler || createGameVersionScheduler({
    check: () => gameVersionService.checkScheduled(),
    now: options.gameVersionScheduleNow,
    setTimeoutFn: options.gameVersionSetTimeout,
    clearTimeoutFn: options.gameVersionClearTimeout,
    onError: ({ code }) => {
      console.warn(JSON.stringify({ step: "scheduledGameVersionCheckFailed", code }));
    },
  });
  const runtimeSettingsStore = options.runtimeSettingsStore || createRuntimeSettingsStore({
    runtimeDir,
    fs: options.runtimeSettingsFs || fs,
    onWriteQueued: options.onRuntimeSettingsWriteQueued,
  });
  const systemSettingsStore = options.systemSettingsStore || createSystemSettingsStore({
    runtimeDir,
    fs: options.systemSettingsFs || fs,
    onWriteQueued: options.onSystemSettingsWriteQueued,
  });
  const profileOperationCoordinator = options.profileOperationCoordinator || createProfileOperationCoordinator();
  const desiredRunStore = options.desiredRunStore || createDesiredRunStore({
    runtimeDir,
    fs: options.desiredRunFs || fs,
    now: options.desiredRunNow,
  });
  let profileStartCoordination = options.profileStartCoordination || null;
  const runner = options.runner || createAutomationRunner({
    rootDir,
    runtimeDir,
    startupConfirmMs: options.startupConfirmMs ?? process.env.XJSKP_STARTUP_CONFIRM_MS ?? DEFAULT_STARTUP_CONFIRM_MS,
    runtimeSettingsStore,
    desiredRunStore,
    systemOperationCoordinator: gameDataOperationCoordinator,
    profileLoader: (profileId) => loadExecutableProfile(profileId, { requireServer: true }),
    recoveryCoordinator: (request) => {
      if (!profileStartCoordination) {
        const error = new Error("Profile start coordination is not ready");
        error.code = "PROFILE_START_COORDINATION_NOT_READY";
        throw error;
      }
      return profileStartCoordination.handleRecoveryEvent(request);
    },
    ...(options.runnerOptions || {}),
  });
  const gameDataSyncService = options.gameDataSyncService || createGameDataSyncService({
    rootDir,
    runtimeDir,
    profileStore,
    runner,
    operationCoordinator: gameDataOperationCoordinator,
    queryOfficialMetadata: options.queryOfficialGameMetadata,
    syncCandidate: options.syncGameDataCandidate,
    fs: options.gameDataStatusFs,
    now: options.gameDataNow,
  });
  const canonicalMigration = options.canonicalMigration || createProfileCanonicalMigration({
    runtimeDir,
    runtimeSettingsStore,
    desiredRunStore,
    fs: options.canonicalMigrationFs || fs,
    isAliasActive: async (profileId) => isRunnerProfileActive(runner, profileId),
  });
  const profileSettingsKernel = options.profileSettingsKernel || createProfileSettingsKernel({
    profileStore,
    runtimeSettingsStore,
    inspectCanonicalSources: (profileId) => canonicalMigration.reconcile(profileId),
  });
  const profileSettingsService = options.profileSettingsService || createProfileSettingsService({
    kernel: profileSettingsKernel,
    runCoordinated: (profileId, operation) => profileOperationCoordinator.runCanonical(
      profileId,
      async (canonicalId) => {
        await accountResetService.assertProfileReady(canonicalId);
        return operation();
      },
    ),
  });
  if (!profileStartCoordination) {
    profileStartCoordination = createProfileStartCoordination({
      runCanonical: profileOperationCoordinator.runCanonical,
      profileStore,
      runtimeSettingsStore,
      desiredRunStore,
      canonicalMigration,
      loadExecutableProfile,
      runner: options.coordinatedRunner || runner,
      now: options.profileStartNow,
    });
  }
  const legacyMigrator = options.legacyMigrator || createLegacyCredentialMigrator({
    rootDir,
    profileStore,
    legacySecretPath: options.legacySecretPath,
    unprotect: options.legacyUnprotect,
  });
  const requestGuard = createLocalRequestGuard({
    token: options.localRequestToken,
    maxBodyBytes: options.maxBodyBytes,
    allowedHosts: options.allowedHosts,
  });
  const singletonGuardFactory = options.singletonGuardFactory || acquireServerSingletonGuard;
  const singletonIdentityResolver = options.singletonIdentityResolver || resolveServerGuardIdentity;
  const singletonGuardOptions = options.singletonGuardOptions || {};
  const singletonHealthTimeoutMs = Math.max(50, Number(options.singletonHealthTimeoutMs) || 750);
  let httpServer = null;
  let host = null;
  let port = null;
  let closing = false;
  let closePromise = null;
  let shutdownRunnerStopped = false;
  let singletonGuard = null;
  let serverIdentity = null;
  let discoveryLifecycle = null;
  let discoveryStartedAt = null;
  let discoveryWritten = false;

  async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      requestGuard.assertLocalHost(req, port);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (url.pathname.startsWith("/artifacts/")) {
        await serveArtifact(req, res, url);
        return;
      }
      await serveStatic(req, res, url);
    } catch (err) {
      sendJson(res, err.statusCode || 500, {
        error: err.code || "SERVER_ERROR",
        message: err.message,
        reason: err.reason || undefined,
        category: err.category || undefined,
        exitCode: err.exitCode ?? undefined,
        lastExit: err.lastExit || undefined,
        legacyProcesses: err.legacyProcesses || undefined,
        active: err.active || undefined,
        recovery: err.recovery || undefined,
        desiredState: err.desiredState || undefined,
        operationId: err.operationId || undefined,
        completedSteps: err.completedSteps || undefined,
        activeDataVersion: err.activeDataVersion ?? undefined,
        candidateDataVersion: err.candidateDataVersion ?? undefined,
        phase: err.phase || undefined,
        reportPath: err.reportPath || undefined,
      });
    }
  }

  async function handleApi(req, res, url) {
    requestGuard.assertLocalHost(req, port);
    if (req.method === "GET" && url.pathname === "/api/session") {
      sendJson(res, 200, {
        token: requestGuard.token,
        settingsProtocolVersion: PROFILE_SETTINGS_PROTOCOL_VERSION,
      });
      return;
    }
    if (req.method === "POST") requestGuard.assertMutation(req, port);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        version: serverIdentity ? 2 : 1,
        instanceId: serverIdentity?.instanceId || null,
        rootDir,
        runtimeDir,
        canonicalRuntimeDir: serverIdentity?.canonicalRuntimeDir || null,
        guardName: serverIdentity?.guardName || null,
        lifecycle: discoveryLifecycle,
        port,
        pid: process.pid,
        lockPath: serverLockPath(runtimeDir),
      });
      return;
    }

    if (closing && req.method === "POST") {
      const error = new Error("The system server is stopping");
      error.statusCode = 503;
      error.code = "SYSTEM_SERVER_STOPPING";
      throw error;
    }

    if (req.method === "GET" && url.pathname === "/api/runtime") {
      sendJson(res, 200, {
        rootDir,
        runtimeDir,
        port,
        server: {
          pid: process.pid,
          port,
          lockPath: serverLockPath(runtimeDir),
          lock: await readServerLock(runtimeDir),
        },
        ...(await (runner.snapshot ? runner.snapshot() : runner.runtime())),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/system/game-version") {
      sendJson(res, 200, await getGameVersionStatus());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/system/game-version/check") {
      const body = await requestGuard.readJsonBody(req);
      const profileId = String(body?.profileId || "");
      if (!/^[A-Za-z0-9_-]+$/.test(profileId)) {
        const error = new Error("请选择用于检查游戏官方版本的账号");
        error.statusCode = 400;
        error.code = "INVALID_PROFILE_ID";
        throw error;
      }
      sendJson(res, 200, {
        ...await gameVersionService.check(profileId),
        schedule: gameVersionScheduler.getStatus?.() || null,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/system/game-data/sync") {
      const body = await requestGuard.readJsonBody(req);
      const profileId = String(body?.profileId || "");
      if (!/^[A-Za-z0-9_-]+$/.test(profileId)) {
        const error = new Error("请选择用于同步游戏代码和数据的账号");
        error.statusCode = 400;
        error.code = "INVALID_PROFILE_ID";
        throw error;
      }
      const result = await gameDataSyncService.sync(profileId);
      sendJson(res, 200, {
        data: {
          ...await gameDataSyncService.getStatus(),
          previousVersion: result.previousDataVersion || null,
          previousCodeVersion: result.previousCodeVersion || null,
          activeCodeVersion: result.activeCodeVersion || null,
          codeCompatibilityStatus: result.codeCompatibilityStatus || null,
          loaderCount: result.loaderCount ?? null,
        },
        codeUpdated: Boolean(
          result.activeCodeVersion
          && result.activeCodeVersion !== result.previousCodeVersion
        ),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/system/settings") {
      sendJson(res, 200, await systemSettingsStore.read());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/system/settings") {
      const body = await requestGuard.readJsonBody(req);
      const settings = validateSystemSettingsInput(body);
      await systemSettingsStore.write(settings);
      requestGuard.setAllowedHosts(settings.allowedHosts);
      sendJson(res, 200, settings);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/system/stop") {
      const body = await requestGuard.readJsonBody(req);
      if (body.instanceId && body.instanceId !== serverIdentity?.instanceId) {
        const error = new Error("The requested server instance is no longer the current owner");
        error.statusCode = 409;
        error.code = "SYSTEM_SERVER_INSTANCE_MISMATCH";
        throw error;
      }
      const result = await runner.stop(null);
      shutdownRunnerStopped = true;
      sendJson(res, 200, result);
      setTimeout(() => close({ stopRunner: false }).catch(() => {}), 50);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/system/stop-legacy") {
      const result = runner.stopLegacy
        ? await runner.stopLegacy()
        : { stopped: false, reason: "unsupported" };
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/migration/legacy-credentials") {
      sendJson(res, 200, await legacyMigrator.inspect());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/migration/legacy-credentials") {
      const migration = await legacyMigrator.migrate();
      if (!migration?.profile?.id) {
        sendJson(res, 200, migration);
        return;
      }
      const committed = await profileSettingsService.readCommitted(migration.profile.id);
      if (committed.statusCode !== 200) {
        sendProfileSettingsResult(res, committed);
        return;
      }
      sendJson(res, 200, {
        ...migration,
        settingsProtocolVersion: PROFILE_SETTINGS_PROTOCOL_VERSION,
        profile: committed.body.profile,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/profiles") {
      sendJson(res, 200, await listProfilesWithLegacyMigration());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/profiles/import") {
      const body = await requestGuard.readJsonBody(req);
      if (body && Object.hasOwn(body, "settings")) {
        sendJson(res, 400, {
          error: "PROFILE_SETTINGS_IMPORT_NOT_SUPPORTED",
          message: "Profile settings cannot be imported through the credentials route",
        });
        return;
      }
      const profile = await profileStore.importProfile(body);
      const committed = await profileSettingsService.readCommitted(profile.id);
      if (committed.statusCode !== 200) {
        sendProfileSettingsResult(res, committed);
        return;
      }
      sendJson(res, 200, {
        settingsProtocolVersion: PROFILE_SETTINGS_PROTOCOL_VERSION,
        profile: committed.body.profile,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/profiles/bulk/start") {
      const body = await requestGuard.readJsonBody(req);
      const result = await bulkStartProfiles(body?.profileIds);
      sendJson(res, result.error ? 409 : 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/profiles/bulk/stop") {
      const body = await requestGuard.readJsonBody(req);
      sendJson(res, 200, await bulkStopProfiles(body?.profileIds));
      return;
    }

    const legacySettlementResolutionRoute = url.pathname.match(/^\/api\/profiles\/([^/]+)\/experience-guard\/resolve-legacy-settlement\/?$/);
    if (legacySettlementResolutionRoute && req.method === "POST") {
      const profileId = decodeCanonicalProfileId(legacySettlementResolutionRoute[1]);
      await accountResetService.assertProfileReady(profileId);
      await profileStore.getProfile(profileId);
      const body = await requestGuard.readJsonBody(req);
      try {
        if (body?.legacyUnverified !== true) {
          const error = new Error("Legacy settlement resolution requires explicit unverified confirmation");
          error.code = "EXPERIENCE_GUARD_SETTLEMENT_LEGACY_CONFIRMATION_REQUIRED";
          throw error;
        }
        const resolved = await profileOperationCoordinator.runCanonical(profileId, async () => {
          if (await isRunnerProfileActive(runner, profileId)) {
            const error = new Error("Stop the account before resolving a settlement without an execution fingerprint");
            error.code = "EXPERIENCE_GUARD_SETTLEMENT_LEGACY_ACCOUNT_RUNNING";
            throw error;
          }
          const statePath = resolveWithinRoot(
            runtimeDir,
            "system",
            "experience-guards",
            `${profileId}.json`,
          );
          const request = createExperienceGuardSettlementRecoveryRequest({
            profileId,
            statePath,
            pendingRequestId: body?.pendingRequestId,
            expectedStateRevision: body?.expectedStateRevision,
            confirmed: body?.confirm === true,
            legacyUnverified: true,
            operatorReason: body?.operatorReason,
          });
          const guard = createPersistentExperienceLevelGuard({ profileId, statePath });
          const state = guard.resolveProtectedAction({
            requestId: request.pendingRequestId,
            outcome: "rejected",
            recoveryRequestId: request.requestId,
            source: "operator-confirmed-legacy-recovery",
            reason: request.operatorReason,
          });
          return { request, state };
        });
        sendJson(res, 200, {
          profileId,
          resolutionState: "resolved-operator-confirmed-legacy-recovery",
          request: resolved.request,
          state: resolved.state,
        });
      } catch (error) {
        const statusCode = [
          "EXPERIENCE_GUARD_SETTLEMENT_LEGACY_CONFIRMATION_REQUIRED",
          "EXPERIENCE_GUARD_SETTLEMENT_CONFIRMATION_REQUIRED",
          "EXPERIENCE_GUARD_SETTLEMENT_LEGACY_OPERATOR_REASON_REQUIRED",
        ].includes(error?.code)
          ? 400
          : 409;
        sendJson(res, statusCode, {
          error: error?.code || "EXPERIENCE_GUARD_SETTLEMENT_LEGACY_RESOLUTION_FAILED",
          message: error?.message || String(error),
          currentStateRevision: error?.currentStateRevision ?? null,
        });
      }
      return;
    }

    const settlementRecoveryRoute = url.pathname.match(/^\/api\/profiles\/([^/]+)\/experience-guard\/recover-settlement\/?$/);
    if (settlementRecoveryRoute && req.method === "POST") {
      const profileId = decodeCanonicalProfileId(settlementRecoveryRoute[1]);
      await accountResetService.assertProfileReady(profileId);
      await profileStore.getProfile(profileId);
      const body = await requestGuard.readJsonBody(req);
      const statePath = resolveWithinRoot(
        runtimeDir,
        "system",
        "experience-guards",
        `${profileId}.json`,
      );
      try {
        const request = createExperienceGuardSettlementRecoveryRequest({
          profileId,
          statePath,
          pendingRequestId: body?.pendingRequestId,
          expectedStateRevision: body?.expectedStateRevision,
          confirmed: body?.confirm === true,
        });
        sendJson(res, 202, {
          profileId,
          recoveryState: "pending-authoritative-settlement-confirmation",
          request,
        });
      } catch (error) {
        const statusCode = error?.code === "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_CONFIRMATION_REQUIRED"
          ? 400
          : 409;
        sendJson(res, statusCode, {
          error: error?.code || "EXPERIENCE_GUARD_SETTLEMENT_RECOVERY_FAILED",
          message: error?.message || String(error),
          currentStateRevision: error?.currentStateRevision ?? null,
        });
      }
      return;
    }

    const profileRoute = url.pathname.match(/^\/api\/profiles\/([^/]+)\/(start|stop|once|orders|status|logs|reset|validate|settings|team-orders|experience-guard)\/?$/);
    if (!profileRoute) {
      sendJson(res, 404, { error: "NOT_FOUND", message: "Unknown API route" });
      return;
    }

    const profileId = decodeCanonicalProfileId(profileRoute[1]);
    const action = profileRoute[2];

    if (action === "experience-guard" && req.method === "GET") {
      await accountResetService.assertProfileReady(profileId);
      await profileStore.getProfile(profileId);
      const statePath = resolveWithinRoot(
        runtimeDir,
        "system",
        "experience-guards",
        `${profileId}.json`,
      );
      const guard = createPersistentExperienceLevelGuard({ profileId, statePath });
      sendJson(res, 200, {
        profileId,
        state: guard.getState(),
        pendingRearm: guard.getPendingRearm(),
        pendingSettlement: guard.getPendingSettlement(),
        pendingSettlementRecovery: guard.getPendingSettlementRecovery(),
      });
      return;
    }

    if (action === "experience-guard" && req.method === "POST") {
      await accountResetService.assertProfileReady(profileId);
      await profileStore.getProfile(profileId);
      const body = await requestGuard.readJsonBody(req);
      const statePath = resolveWithinRoot(
        runtimeDir,
        "system",
        "experience-guards",
        `${profileId}.json`,
      );
      try {
        const request = createExperienceGuardRearmRequest({
          profileId,
          statePath,
          expectedStateRevision: body?.expectedStateRevision,
          confirmed: body?.confirm === true,
        });
        sendJson(res, 202, {
          profileId,
          rearmState: "pending-authoritative-confirmation",
          request,
        });
      } catch (error) {
        const statusCode = error?.code === "EXPERIENCE_GUARD_REARM_CONFIRMATION_REQUIRED"
          ? 400
          : 409;
        sendJson(res, statusCode, {
          error: error?.code || "EXPERIENCE_GUARD_REARM_FAILED",
          message: error?.message || String(error),
          currentStateRevision: error?.currentStateRevision ?? null,
        });
      }
      return;
    }

    if (req.method === "GET" && action === "settings") {
      await accountResetService.assertProfileReady(profileId);
      sendProfileSettingsResult(
        res,
        await profileSettingsService.readCommitted(profileId),
      );
      return;
    }

    if (req.method === "POST" && action === "settings") {
      const envelope = prepareProfileSettingsMutationEnvelope({
        profileId,
        ifMatch: req.headers["if-match"],
        transactionId: req.headers["x-xjskp-settings-transaction-id"],
      });
      if (!envelope.ok) {
        sendProfileSettingsResult(res, envelope.result);
        return;
      }
      const body = await requestGuard.readJsonBody(req);
      const completed = completeProfileSettingsMutation(envelope.envelope, body);
      if (!completed.ok) {
        sendProfileSettingsResult(res, completed.result);
        return;
      }
      sendProfileSettingsResult(
        res,
        await profileSettingsService.mutatePrepared(completed.prepared),
      );
      return;
    }

    if (req.method === "POST" && action === "start") {
      sendJson(res, 200, await runProfileAutomation(profileId, "loop"));
      return;
    }

    if (req.method === "POST" && action === "stop") {
      sendJson(res, 200, await runner.stop(profileId));
      return;
    }

    if (req.method === "POST" && action === "once") {
      sendJson(res, 200, await runProfileAutomation(profileId, "once"));
      return;
    }

    if (req.method === "POST" && action === "orders") {
      sendJson(res, 200, await runProfileAutomation(profileId, "orders"));
      return;
    }

    if (req.method === "POST" && action === "validate") {
      const result = await runProfileAutomation(profileId, "orders", {
        requireServer: false,
        assertRunnableSession: false,
      });
      const failure = await buildValidationFailure(profileId, result);
      if (failure) {
        const committed = await profileSettingsService.readCommitted(profileId);
        if (committed.statusCode !== 200) {
          sendProfileSettingsResult(res, committed);
          return;
        }
        sendJson(res, failure.statusCode, {
          valid: false,
          settingsProtocolVersion: PROFILE_SETTINGS_PROTOCOL_VERSION,
          profile: committed.body.profile,
          result,
          ...failure.body,
        });
        return;
      }
      const serverInfo = await readValidatedServerInfo(profileId);
      const valid = serverInfo?.serverIdx != null;
      const updatedProfile = valid && profileStore.markValidated
        ? await profileStore.markValidated(profileId, undefined, serverInfo)
        : await profileStore.getProfile(profileId);
      const committed = await profileSettingsService.readCommitted(updatedProfile.id);
      if (committed.statusCode !== 200) {
        sendProfileSettingsResult(res, committed);
        return;
      }
      sendJson(res, valid ? 200 : 422, {
        valid,
        settingsProtocolVersion: PROFILE_SETTINGS_PROTOCOL_VERSION,
        profile: committed.body.profile,
        result,
        ...(valid ? {} : { error: "MISSING_ACCOUNT_SERVER", message: VALIDATION_MISSING_SERVER_MESSAGE }),
      });
      return;
    }

    if (req.method === "POST" && action === "reset") {
      if (!profileStore.resetCredentials || !accountResetService) {
        sendJson(res, 501, { error: "NOT_SUPPORTED", message: "Profile reset is not supported by this store" });
        return;
      }
      const result = await profileOperationCoordinator.runCanonical(profileId, async () => {
        try {
          await profileStore.getProfile(profileId);
        } catch (error) {
          if (error?.code === "ENOENT") {
            error.statusCode = 404;
            error.code = "PROFILE_NOT_FOUND";
          }
          throw error;
        }
        const resetPlan = await accountResetService.plan([profileId]);
        return await accountResetService.execute(resetPlan, {
          validateQuiescent: async (plan) => assertProfileResetQuiescent(profileId, plan),
        });
      });
      const committed = await profileSettingsService.readCommitted(profileId);
      if (committed.statusCode !== 200) {
        sendProfileSettingsResult(res, committed);
        return;
      }
      sendJson(res, 200, {
        resetState: "credentials-cleared",
        operationId: result.operationId,
        artifactActions: result.targets,
        settingsProtocolVersion: PROFILE_SETTINGS_PROTOCOL_VERSION,
        profile: committed.body.profile,
      });
      return;
    }

    if (req.method === "GET" && action === "team-orders") {
      sendJson(res, 200, await listProfileTeamOrderArtifacts(profileId, {
        page: url.searchParams.get("page"),
        pageSize: url.searchParams.get("pageSize"),
      }));
      return;
    }

    if (req.method === "GET" && action === "status") {
      const statusDir = resolveWithinRoot(runtimeDir, "status", profileId);
      const logDir = resolveWithinRoot(runtimeDir, "logs", profileId);
      const gardenStatusPath = path.join(statusDir, "garden-status.json");
      const orderStatusPath = path.join(statusDir, "order-status.json");
      const full = url.searchParams.get("full") === "1";
      if (!full) {
        const revision = await buildProfileStatusRevision({
          profileId,
          gardenStatusPath,
          orderStatusPath,
        });
        const etag = `"${revision}"`;
        if (requestEtagMatches(req.headers["if-none-match"], etag)) {
          sendNotModified(res, etag);
          return;
        }
        const [gardenStatus, orderStatus] = await Promise.all([
          readJsonFileSafe(gardenStatusPath),
          readJsonFileSafe(orderStatusPath),
        ]);
        const summary = buildProfileStatusSummary({
          profileId,
          statusDir,
          logDir,
          gardenStatus,
          orderStatus,
          logs: [],
        });
        const projection = buildProfileStatusProjection({ gardenStatus, orderStatus });
        sendJson(res, 200, { summary, projection, revision }, { etag });
        return;
      }
      const [gardenStatus, orderStatus] = await Promise.all([
        readJsonFileSafe(gardenStatusPath),
        readJsonFileSafe(orderStatusPath),
      ]);
      const logs = await listLogFiles(logDir, { limit: 8 });
      const summary = buildProfileStatusSummary({
        profileId,
        statusDir,
        logDir,
        gardenStatus,
        orderStatus,
        logs,
      });
      const projection = buildProfileStatusProjection({ gardenStatus, orderStatus });
      const revision = await buildProfileStatusRevision({
        profileId,
        gardenStatusPath,
        orderStatusPath,
      });
      sendJson(res, 200, {
        summary,
        projection,
        revision,
        gardenStatus,
        orderStatus,
        logs,
        readMeta: {
          full: true,
          trigger: url.searchParams.get("trigger") || "unknown",
          generation: url.searchParams.get("generation") || null,
          source: "local-runtime-artifacts",
        },
      });
      return;
    }

    if (req.method === "GET" && action === "logs") {
      const logDir = resolveWithinRoot(runtimeDir, "logs", profileId);
      const name = url.searchParams.get("name");
      if (name) {
        sendJson(res, 200, { log: await readLogFile(logDir, name) });
      } else {
        sendJson(res, 200, { logs: await listLogFiles(logDir) });
      }
      return;
    }

    sendJson(res, 405, { error: "METHOD_NOT_ALLOWED", message: "Unsupported method" });
  }

  async function loadExecutableProfile(profileId, options = {}) {
    await accountResetService.assertProfileReady(profileId);
    const [profile, env] = await Promise.all([
      profileStore.getProfile(profileId),
      profileStore.loadProfileEnv(profileId),
    ]);
    if (options.requireServer && !profile.serverIdx) {
      const err = new Error("账号信息缺少区服，请先验证账号。");
      err.code = "MISSING_ACCOUNT_SERVER";
      err.statusCode = 422;
      throw err;
    }
    return { ...profile, env };
  }

  async function assertRunnableSession(profileId) {
    const runtime = await runner.runtime();
    if (runtime.activeByProfile?.[profileId]) return;
    const lastExit = runtime.lastTaskExits?.[profileId]
      || (runtime.lastExit?.profileId === profileId ? runtime.lastExit : null);
    if (lastExit?.reason !== "session-expired") return;
    const err = new Error("账号会话失效，请先验证账号。");
    err.code = "SESSION_EXPIRED";
    err.statusCode = 422;
    err.profileId = profileId;
    err.reason = "session-expired";
    err.category = lastExit.category || "login-state";
    err.exitCode = lastExit.exitCode ?? 42;
    err.lastExit = lastExit;
    throw err;
  }

  async function runProfileAutomation(profileId, mode, options = {}) {
    const requireServer = options.requireServer !== false;
    const shouldAssertRunnableSession = options.assertRunnableSession !== false;
    if (shouldAssertRunnableSession) await assertRunnableSession(profileId);
    await loadExecutableProfile(profileId, { requireServer });
    if (mode === "loop") {
      return await profileStartCoordination.startManualLoop(profileId);
    }
    return await profileStartCoordination.runManualOnce(profileId, mode);
  }

  async function bulkStartProfiles(profileIds = []) {
    const ids = uniqueProfileIds(profileIds);
    const runtimeBefore = await runner.runtime();
    const activeByProfile = runtimeBefore.activeByProfile || {};
    const lastTaskExits = runtimeBefore.lastTaskExits || {};
    const skipped = [];
    const candidates = [];

    for (const profileId of ids) {
      if (activeByProfile[profileId]) {
        skipped.push({ profileId, reason: "already-running", message: "账号已在运行中" });
        continue;
      }
      if (lastTaskExits[profileId]?.reason === "session-expired") {
        skipped.push({ profileId, reason: "session-expired", message: "账号会话失效，请先验证账号" });
        continue;
      }
      let profile = null;
      try {
        profile = await profileStore.getProfile(profileId);
      } catch {
        skipped.push({ profileId, reason: "not-found", message: "账号不存在" });
        continue;
      }
      if (!profile.hasCredentials) {
        skipped.push({ profileId, reason: "missing-credentials", message: "账号凭据缺失" });
        continue;
      }
      if (!profile.serverIdx) {
        skipped.push({ profileId, reason: "missing-account-server", message: "账号未验证区服" });
        continue;
      }
      try {
        await profileStore.loadProfileEnv(profileId);
        candidates.push(profileId);
      } catch (err) {
        skipped.push({ profileId, reason: "missing-credentials", message: err.message || "账号凭据缺失" });
      }
    }

    const runningCount = Number(runtimeBefore.runningCount ?? Object.keys(activeByProfile).length);
    const maxParallelTasks = normalizeMaxParallelTasks(runtimeBefore.maxParallelTasks);
    if (maxParallelTasks !== null && runningCount + candidates.length > maxParallelTasks) {
      return {
        error: "MAX_PARALLEL_TASKS_REACHED",
        message: `最多只能同时运行 ${maxParallelTasks} 个账号`,
        started: [],
        skipped,
        runningCount,
        maxParallelTasks,
      };
    }

    const startResults = await Promise.all(candidates.map(async (profileId) => {
      try {
        return { profileId, task: await runProfileAutomation(profileId, "loop") };
      } catch (err) {
        return {
          profileId,
          error: {
            reason: err.code || "start-failed",
            message: err.message || "启动失败",
          },
        };
      }
    }));
    const started = [];
    for (const result of startResults) {
      if (result.task) {
        started.push(result.task);
      } else {
        skipped.push({ profileId: result.profileId, ...result.error });
      }
    }
    const runtimeAfter = await runner.runtime();
    return {
      started,
      skipped,
      runningCount: runtimeAfter.runningCount ?? started.length,
      maxParallelTasks: runtimeAfter.maxParallelTasks ?? maxParallelTasks,
    };
  }

  async function bulkStopProfiles(profileIds = null) {
    const runtimeBefore = await runner.runtime();
    const ids = Array.isArray(profileIds) ? uniqueProfileIds(profileIds) : [];
    if (!Array.isArray(profileIds)) {
      const activeTasks = runtimeBefore.activeTasks || [];
      const result = await runner.stop(null);
      const runtimeAfter = await runner.runtime();
      return {
        stopped: result.stoppedTasks || (result.stopped ? activeTasks : []),
        skipped: [],
        runningCount: runtimeAfter.runningCount ?? 0,
        maxParallelTasks: runtimeAfter.maxParallelTasks ?? runtimeBefore.maxParallelTasks ?? null,
      };
    }

    const stopped = [];
    const skipped = [];
    for (const profileId of ids) {
      const result = await runner.stop(profileId);
      if (result.stopped) {
        stopped.push(result);
      } else {
        skipped.push({ profileId, reason: result.reason || "not-running", message: "账号未运行" });
      }
    }
    const runtimeAfter = await runner.runtime();
    return {
      stopped,
      skipped,
      runningCount: runtimeAfter.runningCount ?? 0,
      maxParallelTasks: runtimeAfter.maxParallelTasks ?? runtimeBefore.maxParallelTasks ?? null,
    };
  }

  async function readValidatedServerInfo(profileId) {
    const status = await readJsonFileSafe(resolveWithinRoot(runtimeDir, "status", profileId, "garden-status.json"));
    const accountLevel = status.ok
      ? (status.data?.summary?.accountLevel || status.data?.accountLevel || null)
      : null;
    const serverIdx = Number(accountLevel?.serverIdx ?? accountLevel?.lastGsIdx);
    if (!Number.isFinite(serverIdx) || serverIdx <= 0) return null;
    return { serverIdx };
  }

  async function buildValidationFailure(profileId, result = {}) {
    if (Number(result?.exitCode ?? 0) === 0) return null;
    const runtime = await runner.runtime().catch(() => null);
    const runtimeExit = runtime?.lastTaskExits?.[profileId]
      || (runtime?.lastExit?.profileId === profileId ? runtime.lastExit : null)
      || null;
    const lastExit = result?.lastExit || runtimeExit || null;
    const exitCode = result?.exitCode ?? lastExit?.exitCode ?? null;
    const reason = result?.reason
      || result?.lastExit?.reason
      || lastExit?.reason
      || (Number(exitCode) === SESSION_EXPIRED_EXIT_CODE ? "session-expired" : null);

    if (reason === "session-expired") {
      return {
        statusCode: 422,
        body: {
          error: "SESSION_EXPIRED",
          message: VALIDATION_SESSION_EXPIRED_MESSAGE,
          reason,
          category: lastExit?.category || result?.category || "login-state",
          exitCode: exitCode ?? SESSION_EXPIRED_EXIT_CODE,
          lastExit,
        },
      };
    }

    return {
      statusCode: 422,
      body: {
        error: "VALIDATION_FAILED",
        message: result?.message || lastExit?.message || `验证失败：退出码 ${exitCode ?? "-"}`,
        ...(reason ? { reason } : {}),
        ...(lastExit?.category || result?.category ? { category: lastExit?.category || result?.category } : {}),
        ...(exitCode != null ? { exitCode } : {}),
        ...(lastExit ? { lastExit } : {}),
      },
    };
  }

  async function listProfilesWithLegacyMigration() {
    const profiles = await profileStore.listProfiles();
    const committedProfiles = await Promise.all(
      profiles.map((profile) => buildCommittedProfileListItem(profile)),
    );
    if (profiles.some((profile) => profile.hasCredentials)) {
      return {
        settingsProtocolVersion: PROFILE_SETTINGS_PROTOCOL_VERSION,
        profiles: committedProfiles,
        legacyMigration: { attempted: false, migrated: false },
      };
    }

    const status = await legacyMigrator.inspect();
    if (!status.complete) {
      return {
        settingsProtocolVersion: PROFILE_SETTINGS_PROTOCOL_VERSION,
        profiles: committedProfiles,
        legacyMigration: { attempted: false, migrated: false, status },
      };
    }

    return {
      settingsProtocolVersion: PROFILE_SETTINGS_PROTOCOL_VERSION,
      profiles: committedProfiles,
      legacyMigration: { attempted: false, migrated: false, status },
    };
  }

  async function buildCommittedProfileListItem(profile) {
    const committed = await profileSettingsService.readCommitted(profile.id);
    if (committed.body?.profile) {
      return {
        ...committed.body.profile,
        runtimeSyncStatus: committed.body.runtimeSyncStatus,
        ...(committed.body.error
          ? { settingsStateError: committed.body.error }
          : {}),
      };
    }
    return {
      ...withoutProfileSettingsState(profile),
      runtimeSyncStatus: committed.body?.runtimeSyncStatus || "degraded",
      settingsStateError: committed.body?.error || "PROFILE_SETTINGS_RUNTIME_DEGRADED",
      ...(committed.body?.collisionSources
        ? { collisionSources: committed.body.collisionSources }
        : {}),
    };
  }

  async function assertProfileResetQuiescent(profileId, resetPlan) {
    const runtime = await (runner.snapshot ? runner.snapshot() : runner.runtime());
    const target = resetPlan?.targets?.find((candidate) => candidate.profileId === profileId);
    const unresolvedActiveArtifact = target?.artifacts?.find((artifact) => artifact.kind === "active-task") || null;
    const desiredArtifact = target?.artifacts?.find((artifact) => artifact.kind === "desired-run") || null;
    let persistedDesired = null;
    if (desiredArtifact) {
      try {
        persistedDesired = JSON.parse(await fs.readFile(desiredArtifact.path, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") persistedDesired = { desiredState: "unresolved" };
      }
    }
    const active = runtime.activeByProfile?.[profileId]
      || runtime.activeTasks?.find((task) => task.profileId === profileId)
      || (runtime.active?.profileId === profileId ? runtime.active : null)
      || (runtime.activeTask?.task?.profileId === profileId ? runtime.activeTask : null);
    const recovery = runtime.recoveryByProfile?.[profileId]
      || runtime.desiredRuns?.find((record) => record.profileId === profileId)
      || null;
    const desiredState = recovery?.desiredState || persistedDesired?.desiredState || null;
    const recoveryStatus = String(recovery?.recoveryStatus || "").toLowerCase();
    const recoveryBlocking = recovery?.recoveryPending === true
      || ["scheduled", "starting", "running"].includes(recoveryStatus);
    if (!active && !unresolvedActiveArtifact && desiredState !== "running" && desiredState !== "unresolved" && !recoveryBlocking) return;
    const error = new Error("请先停止账号任务，并等待自动恢复和 active-task 状态完全收敛后再重置凭据");
    error.statusCode = 409;
    error.code = "PROFILE_RESET_REQUIRES_STOP";
    error.active = active || undefined;
    error.recovery = recovery || undefined;
    error.desiredState = desiredState || undefined;
    throw error;
  }

  async function getGameVersionStatus() {
    const [version, data] = await Promise.all([
      gameVersionService.getStatus(),
      gameDataSyncService.getStatus(),
    ]);
    return {
      ...version,
      schedule: gameVersionScheduler.getStatus?.() || null,
      code: await readGameCodeStatus({
        rootDir,
        localVersion: version.localVersion,
        officialVersion: version.remoteVersion,
        comparison: version.comparison,
        fs: options.gameCodeStatusFs,
      }),
      data,
    };
  }

  async function listen(preferredPort = DEFAULT_PORT) {
    if (httpServer || singletonGuard) return;
    if (closing) {
      const error = new Error("The system server is stopping");
      error.code = "SYSTEM_SERVER_STOPPING";
      throw error;
    }
    shutdownRunnerStopped = false;
    let restoreAttempted = false;
    let schedulerStarted = false;
    try {
      serverIdentity = await singletonIdentityResolver(runtimeDir, singletonGuardOptions);
      const inspectOwner = () => inspectDiscoveryOwner({
        runtimeDir,
        rootDir,
        identity: serverIdentity,
        timeoutMs: singletonHealthTimeoutMs,
      });
      const preflightOwner = await inspectOwner();
      throwIfLegacyOwner(preflightOwner);

      singletonGuard = await singletonGuardFactory({
        ...singletonGuardOptions,
        runtimeDir,
        identity: serverIdentity,
        inspectOwner,
      });
      serverIdentity = {
        ...serverIdentity,
        instanceId: singletonGuard.instanceId || serverIdentity.instanceId,
        canonicalRuntimeDir: singletonGuard.canonicalRuntimeDir || serverIdentity.canonicalRuntimeDir,
        guardName: singletonGuard.guardName || serverIdentity.guardName,
      };

      const postAcquireOwner = await inspectOwner();
      throwIfVerifiedOwner(postAcquireOwner);
      await backupServerLock(runtimeDir, { instanceId: serverIdentity.instanceId });

      await gameDataSyncService.initialize?.();

      if (await systemSettingsStore.exists()) {
        requestGuard.setAllowedHosts((await systemSettingsStore.read()).allowedHosts);
      }
      httpServer = http.createServer(handle);
      port = await listenWithFallback(httpServer, preferredPort, listenHost);
      host = httpServer.address()?.address || "0.0.0.0";
      discoveryStartedAt = new Date().toISOString();
      await writeDiscovery("starting");
      discoveryWritten = true;

      restoreAttempted = true;
      await runner.restoreDesiredLoops?.();
      gameVersionScheduler.start?.();
      schedulerStarted = true;
      await writeDiscovery("ready");
    } catch (error) {
      await rollbackStartup({ restoreAttempted, schedulerStarted });
      throw error;
    }
  }

  async function close(options = {}) {
    if (closePromise) return closePromise;
    closePromise = closeInternal(options).finally(() => {
      closePromise = null;
    });
    return closePromise;
  }

  async function closeInternal(options = {}) {
    if (!httpServer && !singletonGuard && !discoveryWritten) return;
    closing = true;
    let firstError = null;
    const cleanup = async (operation) => {
      try {
        await operation();
      } catch (error) {
        firstError ||= error;
      }
    };
    try {
      if (discoveryWritten) await cleanup(() => writeDiscovery("stopping"));
      await cleanup(async () => gameVersionScheduler.stop?.());
      if (options.stopRunner !== false && !shutdownRunnerStopped && runner?.stop) {
        await cleanup(async () => {
          if (runner.shutdown) await runner.shutdown();
          else await runner.stop(null);
          shutdownRunnerStopped = true;
        });
      }
      await cleanup(closeHttpServer);
      if (discoveryWritten && serverIdentity?.instanceId) {
        await cleanup(() => clearServerLock(runtimeDir, { instanceId: serverIdentity.instanceId }));
      }
      if (singletonGuard) await cleanup(() => singletonGuard.release());
    } finally {
      resetServerLifecycleState();
      closing = false;
    }
    if (firstError) throw firstError;
  }

  async function writeDiscovery(lifecycle) {
    discoveryLifecycle = lifecycle;
    await writeServerLock({
      runtimeDir,
      rootDir,
      port,
      instanceId: serverIdentity.instanceId,
      canonicalRuntimeDir: serverIdentity.canonicalRuntimeDir,
      guardName: serverIdentity.guardName,
      lifecycle,
      startedAt: discoveryStartedAt,
    });
  }

  async function rollbackStartup({ restoreAttempted, schedulerStarted }) {
    if (schedulerStarted) {
      try {
        await gameVersionScheduler.stop?.();
      } catch {}
    }
    if (restoreAttempted && runner?.stop) {
      try {
        if (runner.shutdown) await runner.shutdown();
        else await runner.stop(null);
        shutdownRunnerStopped = true;
      } catch {}
    }
    try {
      await closeHttpServer();
    } catch {}
    if (discoveryWritten && serverIdentity?.instanceId) {
      try {
        await clearServerLock(runtimeDir, { instanceId: serverIdentity.instanceId });
      } catch {}
    }
    if (singletonGuard) {
      try {
        await singletonGuard.release();
      } catch {}
    }
    resetServerLifecycleState();
  }

  async function closeHttpServer() {
    const current = httpServer;
    httpServer = null;
    if (!current?.listening) return;
    await new Promise((resolve, reject) => {
      current.close((error) => (error ? reject(error) : resolve()));
    });
  }

  function resetServerLifecycleState() {
    httpServer = null;
    host = null;
    port = null;
    singletonGuard = null;
    serverIdentity = null;
    discoveryLifecycle = null;
    discoveryStartedAt = null;
    discoveryWritten = false;
  }

  return {
    listen,
    close,
    get host() {
      return host;
    },
    get port() {
      return port;
    },
  };

  async function serveStatic(req, res, url) {
    if (req.method !== "GET") {
      sendText(res, 405, "Method not allowed", "text/plain; charset=utf-8");
      return;
    }
    const rel = url.pathname === "/" ? "index.html" : decodePathComponent(url.pathname.slice(1), "Invalid static path encoding");
    const filePath = resolveWithinRoot(publicDir, rel);
    try {
      const content = await fs.readFile(filePath);
      sendBuffer(res, 200, content, contentType(filePath));
    } catch (err) {
      if (err.code === "ENOENT") {
        sendText(res, 404, "Not found", "text/plain; charset=utf-8");
      } else {
        throw err;
      }
    }
  }

  async function serveArtifact(req, res, url) {
    if (req.method !== "GET") {
      sendText(res, 405, "Method not allowed", "text/plain; charset=utf-8");
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodePathComponent(part, "Invalid artifact path encoding"));
    const [, profileId, kind, name] = parts;
    const safeProfileId = validateCanonicalProfileId(profileId);
    let filePath = null;
    let teamOrderArtifact = false;
    if (kind === "garden-status.html") filePath = resolveWithinRoot(runtimeDir, "status", safeProfileId, "garden-status.html");
    if (kind === "garden-status.json") filePath = resolveWithinRoot(runtimeDir, "status", safeProfileId, "garden-status.json");
    if (kind === "order-status.json") filePath = resolveWithinRoot(runtimeDir, "status", safeProfileId, "order-status.json");
    if (kind === "logs") {
      if (!isSafeLogName(name)) throw invalidPathParameter("Invalid log file name");
      filePath = resolveWithinRoot(runtimeDir, "logs", safeProfileId, name);
    }
    if (kind === "team-orders") {
      if (parts.length !== 4 || !isSafeTeamOrderHtmlName(name)) {
        throw invalidPathParameter("Invalid team order artifact file name");
      }
      filePath = resolveWithinRoot(runtimeDir, "status", safeProfileId, "team-orders", name);
      teamOrderArtifact = true;
    }
    if (!filePath) {
      sendText(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    try {
      if (teamOrderArtifact) {
        const realProfileStatusDir = await resolveProfileStatusRealDir(safeProfileId);
        filePath = await resolveRealPathWithinRoot(realProfileStatusDir, filePath);
      }
      const content = await fs.readFile(filePath);
      sendBuffer(res, 200, content, contentType(filePath));
    } catch (err) {
      if (err.code === "ENOENT") {
        sendText(res, 404, "Not found", "text/plain; charset=utf-8");
      } else {
        throw err;
      }
    }
  }

  async function listProfileTeamOrderArtifacts(profileId, options) {
    const teamOrderDir = resolveWithinRoot(runtimeDir, "status", profileId, "team-orders");
    try {
      const realProfileStatusDir = await resolveProfileStatusRealDir(profileId);
      const realTeamOrderDir = await resolveRealPathWithinRoot(realProfileStatusDir, teamOrderDir);
      return await listTeamOrderArtifacts(realTeamOrderDir, {
        ...options,
        containmentRoot: realProfileStatusDir,
      });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return await listTeamOrderArtifacts(teamOrderDir, options);
      }
      throw error;
    }
  }

  async function resolveProfileStatusRealDir(profileId) {
    const statusRoot = resolveWithinRoot(runtimeDir, "status");
    const profileStatusDir = resolveWithinRoot(statusRoot, profileId);
    const realStatusRoot = await fs.realpath(statusRoot);
    const realProfileStatusDir = await resolveRealPathWithinRoot(realStatusRoot, profileStatusDir);
    const expectedProfileStatusDir = path.resolve(realStatusRoot, profileId);
    if (path.relative(expectedProfileStatusDir, realProfileStatusDir) !== "") {
      const error = new Error("Profile status path resolves to another profile");
      error.code = "INVALID_PATH";
      error.statusCode = 400;
      throw error;
    }
    return realProfileStatusDir;
  }
}

function sendJson(res, statusCode, data, headers = {}) {
  sendText(res, statusCode, JSON.stringify(data), "application/json; charset=utf-8", headers);
}

function sendProfileSettingsResult(res, result) {
  if (!result || !Number.isInteger(result.statusCode) || !result.body) {
    throw new TypeError("A profile settings service result is required");
  }
  sendJson(res, result.statusCode, result.body);
}

function withoutProfileSettingsState(profile = {}) {
  const {
    settings,
    settingsEpoch,
    settingsRevision,
    settingsKeyRevisions,
    ...metadata
  } = profile;
  return metadata;
}

async function isRunnerProfileActive(runner, profileId) {
  const snapshot = await (runner.snapshot ? runner.snapshot() : runner.runtime());
  if (snapshot?.activeByProfile && Object.hasOwn(snapshot.activeByProfile, profileId)) {
    return true;
  }
  return (snapshot?.activeTasks || []).some((task) => task?.profileId === profileId);
}

function validateSystemSettingsInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidSystemSettings("请求体必须是 JSON 对象");
  }
  if (!Array.isArray(body.allowedHosts)) {
    throw invalidSystemSettings("allowedHosts 必须是数组");
  }
  const allowedHosts = [];
  for (const raw of body.allowedHosts) {
    const value = String(raw ?? "").trim().toLowerCase();
    if (!value) throw invalidSystemSettings("白名单条目不能为空");
    if (value.length > 255) throw invalidSystemSettings("白名单条目过长");
    if (/[\/?#\s]/.test(value) || value.includes("://")) {
      throw invalidSystemSettings("白名单条目格式无法解析");
    }
    const colon = value.lastIndexOf(":");
    let hostName = value;
    if (colon > 0 && /^\d+$/.test(value.slice(colon + 1))) {
      const port = Number(value.slice(colon + 1));
      if (port < 1 || port > 65535) throw invalidSystemSettings("端口超出范围");
      hostName = value.slice(0, colon);
    }
    const ipv4 = hostName.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4 && ipv4.slice(1).some((part) => Number(part) > 255)) {
      throw invalidSystemSettings("IP 地址超出范围");
    }
    allowedHosts.push(value);
  }
  return { allowedHosts };
}

function invalidSystemSettings(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = "INVALID_SYSTEM_SETTINGS";
  return err;
}

function sendText(res, statusCode, text, type, headers = {}) {
  res.writeHead(statusCode, {
    "content-type": type,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

function sendNotModified(res, etag) {
  res.writeHead(304, {
    "cache-control": "no-store",
    etag,
  });
  res.end();
}

async function buildProfileStatusRevision({ profileId, gardenStatusPath, orderStatusPath }) {
  const [garden, order] = await Promise.all([
    statusFileSignature(gardenStatusPath),
    statusFileSignature(orderStatusPath),
  ]);
  return createHash("sha256")
    .update(JSON.stringify({ profileId, garden, order }))
    .digest("hex");
}

async function statusFileSignature(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true };
    return { error: error?.code || "STAT_FAILED" };
  }
}

function requestEtagMatches(header, etag) {
  return String(header || "")
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === etag || value === `W/${etag}` || value === "*");
}

function sendBuffer(res, statusCode, content, type) {
  res.writeHead(statusCode, {
    "content-type": type,
    "cache-control": "no-store",
  });
  res.end(content);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".log")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function uniqueProfileIds(profileIds = []) {
  if (!Array.isArray(profileIds)) return [];
  return Array.from(new Set(profileIds.map((id) => validateCanonicalProfileId(id))));
}

function decodeCanonicalProfileId(value) {
  return validateCanonicalProfileId(
    decodePathComponent(value, "Invalid profile id encoding"),
  );
}

function validateCanonicalProfileId(value) {
  const profileId = String(value || "");
  if (!isCanonicalProfileSettingsId(profileId)) {
    const error = invalidPathParameter("Profile ID must already be in canonical form");
    error.code = "INVALID_PROFILE_ID_CANONICAL_FORM";
    throw error;
  }
  return profileId;
}

function decodePathComponent(value, message) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidPathParameter(message);
  }
}

function resolveWithinRoot(rootDir, ...segments) {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(root, ...segments);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw invalidPathParameter("Resolved path escapes its configured root");
  }
  return candidate;
}

function invalidPathParameter(message) {
  const err = new Error(message);
  err.statusCode = 400;
  err.code = "INVALID_PATH_PARAMETER";
  return err;
}

function listenWithFallback(server, preferredPort, listenHost = "::") {
  return new Promise((resolve, reject) => {
    let candidate = Number(preferredPort);
    if (!Number.isInteger(candidate) || candidate < 0) candidate = DEFAULT_PORT;
    const maxPort = candidate + 30;
    const tryListen = () => {
      server.once("error", onError);
      // 双栈监听（:: + ipv6Only=false）：同时接受 IPv4 与 IPv6 回环/局域网连接。
      // 解决 cloudflared 把 localhost 解析为 ::1（IPv6）时连不上仅监听 0.0.0.0 的服务。
      server.listen(candidate, listenHost, () => {
        server.off("error", onError);
        resolve(server.address().port);
      });
    };
    const onError = (err) => {
      server.off("error", onError);
      if (err.code === "EADDRINUSE" && candidate > 0 && candidate < maxPort) {
        candidate += 1;
        tryListen();
        return;
      }
      reject(err);
    };
    tryListen();
  });
}

async function inspectDiscoveryOwner({ runtimeDir, rootDir, identity, timeoutMs }) {
  const lock = await readServerLock(runtimeDir);
  const discoveryPort = Number(lock?.port);
  if (!lock || !Number.isInteger(discoveryPort) || discoveryPort < 1 || discoveryPort > 65535) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${discoveryPort}/api/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const health = await response.json();
    if (Number(health?.pid) !== Number(lock.pid) || Number(health?.port) !== discoveryPort) {
      return null;
    }

    if (Number(lock.version) === 1) {
      if (!sameConfiguredPath(lock.rootDir, rootDir)) return null;
      if (health.runtimeDir && !sameConfiguredPath(health.runtimeDir, runtimeDir)) return null;
      return {
        status: "legacy",
        healthy: true,
        version: 1,
        pid: Number(lock.pid),
        port: discoveryPort,
        rootDir: lock.rootDir,
      };
    }

    if (Number(lock.version) !== 2 || Number(health?.version) !== 2) return null;
    if (!lock.instanceId || lock.instanceId !== health.instanceId) return null;
    if (lock.canonicalRuntimeDir !== identity.canonicalRuntimeDir) return null;
    if (health.canonicalRuntimeDir !== identity.canonicalRuntimeDir) return null;
    if (lock.guardName !== identity.guardName || health.guardName !== identity.guardName) return null;
    if (lock.lifecycle !== health.lifecycle) return null;
    return {
      status: lock.lifecycle === "ready" ? "ready" : lock.lifecycle,
      healthy: true,
      version: 2,
      instanceId: lock.instanceId,
      pid: Number(lock.pid),
      port: discoveryPort,
      lifecycle: lock.lifecycle,
      canonicalRuntimeDir: lock.canonicalRuntimeDir,
      guardName: lock.guardName,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function throwIfLegacyOwner(owner) {
  if (owner?.status !== "legacy") return;
  const error = new Error("A legacy server is still running for this runtimeDir; stop it before starting v2");
  error.code = "SYSTEM_SERVER_LEGACY_OWNER_RUNNING";
  error.owner = owner;
  throw error;
}

function throwIfVerifiedOwner(owner) {
  throwIfLegacyOwner(owner);
  if (owner?.status === "ready" && Number(owner.version) === 2) {
    const error = new Error("A server already owns this runtimeDir");
    error.code = "SYSTEM_SERVER_ALREADY_RUNNING";
    error.owner = owner;
    throw error;
  }
  if (owner?.healthy) {
    const error = new Error("Another server is active but its singleton ownership is unresolved");
    error.code = "SYSTEM_SERVER_SINGLETON_UNRESOLVED";
    error.owner = owner;
    throw error;
  }
}

function sameConfiguredPath(left, right) {
  if (!left || !right) return false;
  if (process.platform === "win32") {
    return path.win32.normalize(String(left).replaceAll("/", "\\")).toLowerCase()
      === path.win32.normalize(String(right).replaceAll("/", "\\")).toLowerCase();
  }
  return path.resolve(String(left)) === path.resolve(String(right));
}

function lanAccessUrls(port) {
  const urls = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos || []) {
      if (info.family === "IPv4" && !info.internal) {
        urls.push(`http://${info.address}:${port}/`);
      }
    }
  }
  return urls;
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const open = process.argv.includes("--open");
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const preferredPort = portArg ? Number(portArg.slice("--port=".length)) : Number(process.env.XJSKP_SYSTEM_PORT || DEFAULT_PORT);
  const server = createSystemServer();
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } catch (err) {
      console.error(err?.message || err);
      process.exitCode = 1;
    } finally {
      if (signal) process.exit(process.exitCode || 0);
    }
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
    process.once(signal, () => {
      shutdown(signal).catch((err) => {
        console.error(err?.message || err);
        process.exit(1);
      });
    });
  }
  try {
    await server.listen(preferredPort);
    const url = `http://127.0.0.1:${server.port}/`;
    console.log(`xjskp automation system: ${url}`);
    for (const lanUrl of lanAccessUrls(server.port)) {
      console.log(`LAN access: ${lanUrl}`);
    }
    if (open) openBrowser(url);
  } catch (error) {
    if (error?.code === "SYSTEM_SERVER_ALREADY_RUNNING" && error.owner?.port) {
      const url = `http://127.0.0.1:${error.owner.port}/`;
      console.log(`Existing xjskp automation system: ${url}`);
      if (open) openBrowser(url);
    } else {
      console.error(JSON.stringify({
        error: error?.code || "SYSTEM_SERVER_START_FAILED",
        message: error?.message || String(error),
        owner: error?.owner || undefined,
      }));
      process.exitCode = 1;
    }
  }
}
