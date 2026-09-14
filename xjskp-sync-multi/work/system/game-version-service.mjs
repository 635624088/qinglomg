import fs from "node:fs/promises";
import path from "node:path";
import { readActiveGameRelease } from "../game-release-version.mjs";

import {
  OFFICIAL_QUERY_CREDENTIAL_FIELDS,
  fetchOfficialGameInfo,
  normalizeOfficialGameInfo,
} from "../official-game-info.mjs";

const SAFE_ERROR_MESSAGES = new Map([
  ["PROFILE_NOT_FOUND", "账号不存在"],
  ["VERSION_CHECK_CREDENTIALS_REQUIRED", "账号缺少版本检查所需凭据"],
  ["VERSION_CHECK_TIMEOUT", "官方版本检查超时"],
  ["VERSION_CHECK_INVALID_RESPONSE", "官方版本响应无效"],
  ["VERSION_CHECK_UPSTREAM_ERROR", "官方版本服务暂不可用"],
  ["VERSION_CHECK_FAILED", "官方版本检查失败"],
  ["VERSION_CHECK_CACHE_WRITE_FAILED", "版本检查状态保存失败"],
]);
let processCheckInProgress = false;

export function compareGameVersions(localVersion, remoteVersion) {
  if (!localVersion || !remoteVersion) return "unknown";
  if (localVersion === remoteVersion) return "same";
  const local = parseNumericVersion(localVersion);
  const remote = parseNumericVersion(remoteVersion);
  if (!local || !remote) return "different";
  const length = Math.max(local.length, remote.length);
  for (let index = 0; index < length; index += 1) {
    const left = local[index] ?? 0n;
    const right = remote[index] ?? 0n;
    if (right > left) return "newer";
    if (right < left) return "older";
  }
  return "different";
}

export async function queryLatestOfficialGameVersion({ credentials, signal } = {}) {
  let response;
  try {
    response = await fetchOfficialGameInfo({ credentials, signal });
  } catch {
    throw safeQueryError("VERSION_CHECK_UPSTREAM_ERROR", "官方版本服务暂不可用");
  }
  try {
    return normalizeOfficialGameInfo(response).appVersion;
  } catch {
    throw safeQueryError("VERSION_CHECK_INVALID_RESPONSE", "官方版本响应无效");
  }
}

export function createGameVersionService(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const runtimeDir = options.runtimeDir || path.join(rootDir, "runtime");
  const profileStore = options.profileStore;
  const queryLatestVersion = options.queryLatestVersion || queryLatestOfficialGameVersion;
  const timeoutMs = options.timeoutMs ?? 10000;
  const now = options.now || (() => new Date());
  const fileSystem = options.fs || fs;
  const operationCoordinator = options.operationCoordinator || null;
  const cachePath = path.join(runtimeDir, "status", "game-version-status.json");

  async function getStatus() {
    const [localVersion, cache] = await Promise.all([readLocalVersion(), readCache()]);
    return publicStatus(localVersion, cache, processCheckInProgress);
  }

  async function checkScheduled() {
    const cache = await readCache();
    const profiles = (await profileStore.listProfiles())
      .filter((profile) => profile?.hasCredentials === true);
    const selected = profiles.find((profile) => profile.id === cache.sourceProfileId)
      || profiles[0]
      || null;
    if (!selected) {
      throw serviceError(422, "VERSION_CHECK_CREDENTIALS_REQUIRED", "账号缺少版本检查所需凭据");
    }
    return check(selected.id);
  }

  async function check(profileId) {
    if (operationCoordinator?.runVersionCheck) {
      return operationCoordinator.runVersionCheck(() => checkInternal(profileId));
    }
    return checkInternal(profileId);
  }

  async function checkInternal(profileId) {
    if (processCheckInProgress) {
      throw serviceError(409, "VERSION_CHECK_IN_PROGRESS", "已有版本检查正在进行");
    }
    processCheckInProgress = true;
    const lastAttemptAt = now().toISOString();
    const previous = await readCache();
    let timeoutHandle;
    let timeoutTriggered = false;
    try {
      const localVersion = await readLocalVersion();
      const credentials = await loadCredentials(profileId);
      const controller = new AbortController();
      const timeout = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          timeoutTriggered = true;
          controller.abort();
          reject(serviceError(504, "VERSION_CHECK_TIMEOUT", "官方版本检查超时"));
        }, timeoutMs);
      });
      const remoteVersion = await Promise.race([
        queryLatestVersion({ credentials, signal: controller.signal }),
        timeout,
      ]);
      if (typeof remoteVersion !== "string" || !remoteVersion.trim()) {
        throw serviceError(502, "VERSION_CHECK_INVALID_RESPONSE", "官方版本响应无效");
      }
      const record = {
        localVersion,
        remoteVersion: remoteVersion.trim(),
        comparison: compareGameVersions(localVersion, remoteVersion.trim()),
        lastSuccessfulCheckAt: lastAttemptAt,
        lastAttemptAt,
        lastError: null,
        sourceProfileId: profileId,
      };
      await writeCache(record);
      return publicStatus(localVersion, record, false);
    } catch (cause) {
      const error = timeoutTriggered
        ? serviceError(504, "VERSION_CHECK_TIMEOUT", "官方版本检查超时")
        : normalizeError(cause);
      const localVersion = await readLocalVersion();
      await writeCache({
        ...previous,
        localVersion,
        lastAttemptAt,
        lastError: { code: error.code, message: error.message },
      });
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
      processCheckInProgress = false;
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
      if (error?.code === "ENOENT") {
        throw serviceError(404, "PROFILE_NOT_FOUND", "账号不存在");
      }
      throw error;
    }
    const missing = OFFICIAL_QUERY_CREDENTIAL_FIELDS.filter((field) => !credentials?.[field]);
    if (missing.length) {
      throw serviceError(422, "VERSION_CHECK_CREDENTIALS_REQUIRED", "账号缺少版本检查所需凭据");
    }
    return credentials;
  }

  async function readLocalVersion() {
    const activeRelease = readActiveGameRelease({ rootDir });
    if (activeRelease?.code?.appVersion) return activeRelease.code.appVersion;
    for (const manifestPath of [
      path.join(rootDir, "work", "game-pkg-latest", "Manifest.xml"),
      path.join(rootDir, "work", "game-pkg", "Manifest.xml"),
    ]) {
      try {
        const xml = await fileSystem.readFile(manifestPath, "utf8");
        const version = xml.match(/<appVersion>\s*([^<\s]+)\s*<\/appVersion>/i)?.[1]?.trim();
        if (version) return version;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return null;
  }

  async function readCache() {
    try {
      return normalizeCache(JSON.parse(await fileSystem.readFile(cachePath, "utf8")));
    } catch {
      return normalizeCache(null);
    }
  }

  async function writeCache(value) {
    const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fileSystem.mkdir(path.dirname(cachePath), { recursive: true });
      await fileSystem.writeFile(tmpPath, `${JSON.stringify(normalizeCache(value), null, 2)}\n`, "utf8");
      await fileSystem.rename(tmpPath, cachePath);
    } catch {
      throw serviceError(500, "VERSION_CHECK_CACHE_WRITE_FAILED", "版本检查状态保存失败");
    } finally {
      await fileSystem.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  return { getStatus, check, checkScheduled };
}

function parseNumericVersion(value) {
  const text = String(value || "");
  if (!/^\d+(?:\.\d+)*$/.test(text)) return null;
  return text.split(".").map((part) => BigInt(part));
}

function normalizeCache(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const localVersion = normalizeCacheText(source.localVersion);
  const remoteVersion = normalizeCacheText(source.remoteVersion);
  return {
    localVersion,
    remoteVersion,
    comparison: compareGameVersions(localVersion, remoteVersion),
    lastSuccessfulCheckAt: normalizeCacheText(source.lastSuccessfulCheckAt),
    lastAttemptAt: normalizeCacheText(source.lastAttemptAt),
    lastError: normalizeCacheError(source.lastError),
    sourceProfileId: normalizeCacheText(source.sourceProfileId),
  };
}

function normalizeCacheText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 256 || /[\r\n]/.test(text)) return null;
  return text;
}

function normalizeCacheError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = SAFE_ERROR_MESSAGES.get(value.code);
  return message ? { code: value.code, message } : null;
}

function publicStatus(localVersion, cache, checking) {
  return {
    localVersion,
    remoteVersion: cache.remoteVersion || null,
    comparison: compareGameVersions(localVersion, cache.remoteVersion),
    lastSuccessfulCheckAt: cache.lastSuccessfulCheckAt || null,
    lastAttemptAt: cache.lastAttemptAt || null,
    lastError: cache.lastError || null,
    sourceProfileId: cache.sourceProfileId || null,
    checking,
  };
}

function normalizeError(error) {
  if (error?.statusCode && error?.code) return error;
  if (error?.code === "VERSION_CHECK_INVALID_RESPONSE") {
    return serviceError(502, error.code, "官方版本响应无效");
  }
  if (error?.code === "VERSION_CHECK_UPSTREAM_ERROR") {
    return serviceError(502, error.code, "官方版本服务暂不可用");
  }
  return serviceError(502, "VERSION_CHECK_FAILED", "官方版本检查失败");
}

function safeQueryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serviceError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
