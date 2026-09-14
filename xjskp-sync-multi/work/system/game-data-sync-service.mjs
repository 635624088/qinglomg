import fs from "node:fs/promises";
import path from "node:path";

import { syncGameReleaseCandidate } from "../game-release-candidate-sync.mjs";
import { readActiveGameRelease } from "../game-release-version.mjs";
import {
  getDefaultFlowerNamePaths,
  readActiveGameDataBundle,
} from "../game-data-version.mjs";
import { findLatestStaticConfigPath } from "../static-config-path.mjs";
import { readAppVersionFromManifestPath } from "../sync-latest-static-config.mjs";
import {
  acquireGameDataSyncLock,
  recoverStaleGameDataSyncLock,
} from "./game-data-sync-lock.mjs";
import {
  OFFICIAL_GAME_APP_ID,
  OFFICIAL_QUERY_CREDENTIAL_FIELDS,
  queryOfficialGameMetadata,
} from "../official-game-info.mjs";

export const DEFAULT_GAME_DATA_RESOURCE_ORIGINS = Object.freeze([
  "https://hygncdn.babigame.cn/",
  "https://hyhmcl.babigame.cn/",
]);

const STATUS_SCHEMA_VERSION = 1;
const TRANSIENT_SYNC_STATUSES = new Set(["downloading", "validating", "activating"]);
const SAFE_MESSAGES = new Map([
  ["PROFILE_NOT_FOUND", "账号不存在"],
  ["INVALID_PROFILE_ID", "账号 ID 非法"],
  ["GAME_DATA_SYNC_IN_PROGRESS", "已有版本检查或数据同步正在进行"],
  ["GAME_DATA_SYNC_RUNTIME_ACTIVE", "请先停止全部账号任务并等待运行状态收敛"],
  ["GAME_DATA_SYNC_CREDENTIALS_REQUIRED", "账号缺少数据同步所需凭据"],
  ["GAME_DATA_MANUAL_REVIEW_REQUIRED", "候选数据需要人工复核，未启用"],
  ["GAME_DATA_INCOMPATIBLE", "候选数据与当前代码不兼容，未启用"],
  ["GAME_DATA_DISCOVERY_FAILED", "官方游戏数据发现失败"],
  ["GAME_DATA_DOWNLOAD_FAILED", "候选游戏数据下载失败"],
  ["GAME_DATA_ACTIVATION_FAILED", "候选数据启用失败，当前数据版本未变"],
  ["GAME_DATA_ROLLBACK_FAILED", "数据启用与回滚均失败，请立即检查活跃数据状态"],
  ["GAME_DATA_SYNC_STATUS_WRITE_FAILED", "数据同步状态保存失败"],
  ["GAME_DATA_SYNC_INTERRUPTED", "上次数据同步因服务中断而未完成"],
]);

export function createGameDataSyncService(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const runtimeDir = path.resolve(options.runtimeDir || path.join(rootDir, "runtime"));
  const statusPath = path.join(runtimeDir, "status", "game-data-status.json");
  const profileStore = options.profileStore;
  const runner = options.runner;
  const operationCoordinator = options.operationCoordinator;
  const queryMetadata = options.queryOfficialMetadata || queryOfficialGameMetadata;
  const syncCandidate = options.syncCandidate || syncGameReleaseCandidate;
  const readActive = options.readActiveDataBundle || ((args) => readActiveGameDataBundle(args));
  const readActiveRelease = options.readActiveRelease || ((args) => readActiveGameRelease(args));
  const fileSystem = options.fs || fs;
  const now = options.now || (() => new Date());
  const resourceOrigins = [...(options.resourceOrigins || DEFAULT_GAME_DATA_RESOURCE_ORIGINS)];
  const acquirePersistentLock = options.acquirePersistentLock || acquireGameDataSyncLock;
  const recoverPersistentLock = options.recoverPersistentLock || recoverStaleGameDataSyncLock;

  if (!operationCoordinator?.runGameDataSync) {
    throw new TypeError("Game data sync service requires an operation coordinator");
  }

  async function getStatus() {
    const active = readCurrentActive();
    const persisted = await readStatus();
    const liveSync = operationCoordinator.getStatus?.().officialOperation?.kind === "game-data-sync";
    const state = TRANSIENT_SYNC_STATUSES.has(persisted.syncStatus) && !liveSync
      ? {
        ...persisted,
        syncStatus: "failed",
        lastError: safeError("GAME_DATA_SYNC_INTERRUPTED"),
      }
      : persisted;
    return publicStatus(active, state);
  }

  async function sync(profileId) {
    const id = String(profileId || "");
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw serviceError(400, "INVALID_PROFILE_ID", SAFE_MESSAGES.get("INVALID_PROFILE_ID"), {
        activeDataVersion: readCurrentActive()?.dataVersion || null,
        phase: "preflight",
      });
    }
    try {
      return await operationCoordinator.runGameDataSync(async () => {
        const persistentLock = await acquirePersistentLock({ runtimeDir, now, fs: fileSystem });
        try {
          await assertRuntimeQuiescent();
          const credentials = await loadCredentials(id);
        const attemptAt = now().toISOString();
        const previous = await readStatus();
        let currentPhase = "discovery";
        let metadata = null;
        await writeStatus({
          ...previous,
          syncStatus: "downloading",
          phase: currentPhase,
          lastAttemptAt: attemptAt,
          lastError: null,
          sourceProfileId: id,
        });
          try {
          metadata = validateMetadata(await queryMetadata({ credentials }));
          const result = await syncCandidate({
            rootDir,
            appId: metadata.appId || OFFICIAL_GAME_APP_ID,
            packageUrl: metadata.packageUrl,
            sourceCodeVersion: metadata.appVersion,
            baseUrls: resourceOrigins,
            ...await resolveLegacyBaseline(),
            onPhase: async (phase, progress = null) => {
              currentPhase = normalizePhase(phase);
              await writeStatus({
                ...await readStatus(),
                syncStatus: statusForPhase(currentPhase),
                phase: currentPhase,
                candidateVersion: cleanToken(progress?.dataVersion),
                candidateSourceCodeVersion: metadata.appVersion,
                lastAttemptAt: attemptAt,
                lastError: null,
                sourceProfileId: id,
              });
            },
            beforeActivate: assertRuntimeQuiescent,
          });
          return await finishResult(result, { previous, attemptAt, profileId: id, metadata });
          } catch (error) {
          const normalized = normalizeSyncError(error, currentPhase);
          const active = readCurrentActive();
          const latestState = await readStatus();
          await writeStatus({
            ...previous,
            ...latestState,
            syncStatus: normalized.code === "GAME_DATA_SYNC_RUNTIME_ACTIVE" ? "blocked" : "failed",
            phase: normalized.phase,
            candidateSourceCodeVersion: metadata?.appVersion || latestState.candidateSourceCodeVersion,
            lastAttemptAt: attemptAt,
            lastError: safeError(normalized.code),
            sourceProfileId: id,
          });
          normalized.activeDataVersion = active?.dataVersion || null;
          normalized.candidateDataVersion = latestState.candidateVersion || null;
          normalized.reportPath = latestState.reportPath || null;
            throw normalized;
          }
        } finally {
          await persistentLock.release();
        }
      });
    } catch (error) {
      const normalized = normalizeSyncError(error, "preflight");
      normalized.activeDataVersion ??= readCurrentActive()?.dataVersion || null;
      if ([
        "PROFILE_NOT_FOUND",
        "GAME_DATA_SYNC_RUNTIME_ACTIVE",
        "GAME_DATA_SYNC_CREDENTIALS_REQUIRED",
      ].includes(normalized.code)) {
        const previous = await readStatus();
        await writeStatus({
          ...previous,
          syncStatus: "blocked",
          phase: normalized.phase,
          lastAttemptAt: now().toISOString(),
          lastError: safeError(normalized.code),
          sourceProfileId: id,
        });
      }
      throw normalized;
    }
  }

  async function finishResult(result, context) {
    const active = readCurrentActive();
    const reportPath = safeRelativePath(rootDir, result?.reportPath);
    const candidateVersion = cleanToken(result?.candidateDataVersion);
    const common = {
      ...context.previous,
      phase: "complete",
      candidateVersion,
      candidateSourceCodeVersion: context.metadata.appVersion,
      lastAttemptAt: context.attemptAt,
      sourceProfileId: context.profileId,
      reportPath,
    };
    if (result?.status === "manual-review" || result?.status === "incompatible") {
      const manual = result.status === "manual-review";
      const code = manual ? "GAME_DATA_MANUAL_REVIEW_REQUIRED" : "GAME_DATA_INCOMPATIBLE";
      await writeStatus({
        ...common,
        syncStatus: "blocked",
        compatibilityStatus: result.status,
        lastError: safeError(code),
      });
      throw serviceError(422, code, SAFE_MESSAGES.get(code), {
        phase: "validation",
        activeDataVersion: active?.dataVersion || result.activeDataVersion || null,
        reportPath,
      });
    }
    await writeStatus({
      ...common,
      syncStatus: "latest",
      compatibilityStatus: "compatible",
      lastSuccessfulSyncAt: context.attemptAt,
      lastError: null,
    });
    return {
      ...result,
      activeDataVersion: active?.dataVersion || result?.activeDataVersion || null,
      reportPath,
    };
  }

  async function assertRuntimeQuiescent() {
    const runtime = await runner.runtime();
    if (hasRuntimeActivity(runtime)) {
      throw serviceError(409, "GAME_DATA_SYNC_RUNTIME_ACTIVE", SAFE_MESSAGES.get("GAME_DATA_SYNC_RUNTIME_ACTIVE"), {
        phase: "preflight",
      });
    }
  }

  async function loadCredentials(profileId) {
    let credentials;
    try {
      credentials = await profileStore.loadProfileCredentialFields(
        profileId,
        OFFICIAL_QUERY_CREDENTIAL_FIELDS,
      );
    } catch (error) {
      if (["ENOENT", "PROFILE_NOT_FOUND"].includes(error?.code)) {
        throw serviceError(404, "PROFILE_NOT_FOUND", SAFE_MESSAGES.get("PROFILE_NOT_FOUND"), { phase: "credentials" });
      }
      throw error;
    }
    const missing = OFFICIAL_QUERY_CREDENTIAL_FIELDS.filter((field) => !credentials?.[field]);
    if (missing.length) {
      throw serviceError(422, "GAME_DATA_SYNC_CREDENTIALS_REQUIRED", SAFE_MESSAGES.get("GAME_DATA_SYNC_CREDENTIALS_REQUIRED"), {
        phase: "credentials",
      });
    }
    return credentials;
  }

  async function readStatus() {
    try {
      return normalizeStatus(JSON.parse(await fileSystem.readFile(statusPath, "utf8")));
    } catch {
      return normalizeStatus(null);
    }
  }

  async function writeStatus(value) {
    const tmpPath = `${statusPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fileSystem.mkdir(path.dirname(statusPath), { recursive: true });
      await fileSystem.writeFile(tmpPath, `${JSON.stringify(normalizeStatus(value), null, 2)}\n`, "utf8");
      await fileSystem.rename(tmpPath, statusPath);
    } catch {
      throw serviceError(500, "GAME_DATA_SYNC_STATUS_WRITE_FAILED", SAFE_MESSAGES.get("GAME_DATA_SYNC_STATUS_WRITE_FAILED"), {
        phase: "status",
      });
    } finally {
      await fileSystem.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  async function initialize() {
    await recoverPersistentLock({ runtimeDir, fs: fileSystem });
    const current = await readStatus();
    if (!TRANSIENT_SYNC_STATUSES.has(current.syncStatus)) return publicStatus(readCurrentActive(), current);
    const recovered = {
      ...current,
      syncStatus: "failed",
      lastError: safeError("GAME_DATA_SYNC_INTERRUPTED"),
    };
    await writeStatus(recovered);
    return publicStatus(readCurrentActive(), recovered);
  }

  function readCurrentActive() {
    const release = readActiveRelease({ rootDir });
    if (release?.data) return release.data;
    const active = readActive({ rootDir });
    if (active) return active;
    try {
      const configPath = findLatestStaticConfigPath({
        rootDir,
        dir: path.join(rootDir, "work"),
      });
      const dataVersion = path.basename(configPath).match(/^g-data\.([0-9a-f]+)\.text$/i)?.[1] || null;
      return dataVersion ? { dataVersion, sourceCodeVersion: null } : null;
    } catch {
      return null;
    }
  }

  async function resolveLegacyBaseline() {
    if (readActiveRelease({ rootDir })?.data || readActive({ rootDir })) return {};
    const currentStaticConfigPath = findLatestStaticConfigPath({
      rootDir,
      dir: path.join(rootDir, "work"),
    });
    const flowerNamePaths = getDefaultFlowerNamePaths({ rootDir });
    let currentFlowerNamesPath = flowerNamePaths[0] || null;
    for (const candidatePath of flowerNamePaths) {
      try {
        await fileSystem.access(candidatePath);
        currentFlowerNamesPath = candidatePath;
        break;
      } catch {}
    }
    const currentSourceCodeVersion = [
      path.join(rootDir, "work", "game-pkg-latest", "Manifest.xml"),
      path.join(rootDir, "work", "game-pkg", "Manifest.xml"),
    ].map((manifestPath) => readAppVersionFromManifestPath(manifestPath, null)).find(Boolean) || null;
    return {
      currentStaticConfigPath,
      currentFlowerNamesPath,
      currentSourceCodeVersion,
    };
  }

  return Object.freeze({ getStatus, sync, initialize });
}

function hasRuntimeActivity(runtime = {}) {
  if (Number(runtime.runningCount || 0) > 0) return true;
  if ((runtime.activeTasks || []).length > 0) return true;
  if ((runtime.legacyProcesses || []).length > 0) return true;
  if ((runtime.desiredRuns || []).some((entry) => ["running", "unresolved"].includes(entry?.desiredState))) return true;
  return Object.values(runtime.recoveryByProfile || {}).some((entry) => (
    entry?.recoveryPending === true
    || ["scheduled", "starting", "running"].includes(entry?.recoveryStatus)
  ));
}

function validateMetadata(value) {
  const packageUrl = new URL(String(value?.packageUrl || ""));
  if (packageUrl.protocol !== "https:" || !/(^|\.)alipayobjects\.com$/i.test(packageUrl.hostname)) {
    throw serviceError(502, "GAME_DATA_DISCOVERY_FAILED", SAFE_MESSAGES.get("GAME_DATA_DISCOVERY_FAILED"), { phase: "discovery" });
  }
  const appVersion = cleanText(value?.appVersion);
  if (!appVersion) {
    throw serviceError(502, "GAME_DATA_DISCOVERY_FAILED", SAFE_MESSAGES.get("GAME_DATA_DISCOVERY_FAILED"), { phase: "discovery" });
  }
  return {
    appId: cleanText(value?.appId) || OFFICIAL_GAME_APP_ID,
    appVersion,
    packageUrl: packageUrl.toString(),
  };
}

function normalizeSyncError(error, phase) {
  if (error?.statusCode && SAFE_MESSAGES.has(error.code)) return error;
  const code = SAFE_MESSAGES.has(error?.code)
    ? error.code
    : phase === "download"
      ? "GAME_DATA_DOWNLOAD_FAILED"
    : phase === "activation" || ["stage", "pointer", "verify"].includes(phase)
      ? "GAME_DATA_ACTIVATION_FAILED"
      : "GAME_DATA_DISCOVERY_FAILED";
  const statusCode = code === "INVALID_PROFILE_ID"
    ? 400
    : code === "GAME_DATA_SYNC_RUNTIME_ACTIVE" || code === "GAME_DATA_SYNC_IN_PROGRESS"
    ? 409
    : code === "PROFILE_NOT_FOUND"
      ? 404
      : ["GAME_DATA_MANUAL_REVIEW_REQUIRED", "GAME_DATA_INCOMPATIBLE", "GAME_DATA_SYNC_CREDENTIALS_REQUIRED"].includes(code)
        ? 422
        : code === "GAME_DATA_ACTIVATION_FAILED" || code === "GAME_DATA_ROLLBACK_FAILED" || code === "GAME_DATA_SYNC_STATUS_WRITE_FAILED"
          ? 500
          : 502;
  return serviceError(statusCode, code, SAFE_MESSAGES.get(code), { phase: normalizePhase(error?.phase || phase) });
}

function normalizeStatus(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    syncStatus: ["idle", "downloading", "validating", "activating", "latest", "failed", "blocked"].includes(source.syncStatus)
      ? source.syncStatus
      : "idle",
    phase: cleanText(source.phase),
    candidateVersion: cleanToken(source.candidateVersion),
    candidateSourceCodeVersion: cleanText(source.candidateSourceCodeVersion),
    compatibilityStatus: ["unknown", "checking", "compatible", "manual-review", "incompatible"].includes(source.compatibilityStatus)
      ? source.compatibilityStatus
      : "unknown",
    lastSuccessfulSyncAt: cleanText(source.lastSuccessfulSyncAt),
    lastAttemptAt: cleanText(source.lastAttemptAt),
    lastError: normalizeStoredError(source.lastError),
    reportPath: safeStoredPath(source.reportPath),
    sourceProfileId: cleanText(source.sourceProfileId),
  };
}

function publicStatus(active, state) {
  return {
    activeVersion: active?.dataVersion || null,
    activeSourceCodeVersion: active?.sourceCodeVersion || null,
    candidateVersion: state.candidateVersion,
    candidateSourceCodeVersion: state.candidateSourceCodeVersion,
    compatibilityStatus: state.compatibilityStatus,
    syncStatus: state.syncStatus,
    phase: state.phase,
    lastSuccessfulSyncAt: state.lastSuccessfulSyncAt,
    lastAttemptAt: state.lastAttemptAt,
    lastError: state.lastError,
    reportPath: state.reportPath,
    sourceProfileId: state.sourceProfileId,
  };
}

function safeError(code) {
  return SAFE_MESSAGES.has(code) ? { code, message: SAFE_MESSAGES.get(code) } : null;
}

function normalizeStoredError(value) {
  return value && SAFE_MESSAGES.has(value.code) ? safeError(value.code) : null;
}

function normalizePhase(value) {
  const phase = cleanText(value) || "unknown";
  if (phase === "download") return "download";
  if (phase === "validate") return "validation";
  if (["stage", "pointer", "verify"].includes(phase)) return "activation";
  return phase;
}

function statusForPhase(phase) {
  if (phase === "validation") return "validating";
  if (phase === "activation") return "activating";
  return "downloading";
}

function cleanToken(value) {
  const text = cleanText(value);
  return text && /^[0-9a-f]+$/i.test(text) ? text : null;
}

function cleanText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 256 && !/[\r\n]/.test(text) ? text : null;
}

function safeStoredPath(value) {
  const text = cleanText(value);
  return text && !path.isAbsolute(text) && !text.split(/[\\/]+/).includes("..") ? text.replace(/\\/g, "/") : null;
}

function safeRelativePath(rootDir, value) {
  if (!value) return null;
  const relative = path.relative(rootDir, path.resolve(String(value)));
  return !relative || relative.startsWith("..") || path.isAbsolute(relative) ? null : relative.replace(/\\/g, "/");
}

function serviceError(statusCode, code, message, extra = {}) {
  return Object.assign(new Error(message || "数据同步失败"), { statusCode, code, ...extra });
}
