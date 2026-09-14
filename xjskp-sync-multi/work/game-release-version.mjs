import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { readGameCodeBundle } from "./game-code-version.mjs";
import { readGameDataBundle } from "./game-data-version.mjs";

const SCHEMA_VERSION = 1;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([0, 25, 100, 250]);
const activeReleaseCache = new Map();

function activeReleasePointerKey(pointer) {
  return JSON.stringify({
    schemaVersion: pointer?.schemaVersion ?? null,
    releaseId: pointer?.releaseId ?? null,
    codeBundleId: pointer?.codeBundleId ?? null,
    codeVersion: pointer?.codeVersion ?? null,
    gameJsSha256: pointer?.gameJsSha256 ?? null,
    dataVersion: pointer?.dataVersion ?? null,
    dataSourceCodeVersion: pointer?.dataSourceCodeVersion ?? null,
    dataRevalidatedForCodeVersion: pointer?.dataRevalidatedForCodeVersion ?? null,
  });
}

function readActiveGameReleasePointerValue(rootDir, fsModule) {
  const pointerPath = path.join(rootDir, "runtime", "status", "game-release-active.json");
  const value = JSON.parse(fsModule.readFileSync(pointerPath, "utf8"));
  return value?.schemaVersion === SCHEMA_VERSION ? value : null;
}

function fileStamp(filePath, fsModule) {
  try {
    const stat = fsModule.statSync(filePath);
    if (!stat.isFile()) return null;
    return [stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  } catch {
    return null;
  }
}

function releaseFileStamps(release, fsModule) {
  const paths = [
    release.code.manifestPath,
    release.code.packageManifestPath,
    release.code.gameJsPath,
    release.code.modulesPath,
    release.code.packageEvidencePath,
    release.code.compatibilityReportPath,
    release.data.manifestPath,
    release.data.staticConfigPath,
    release.data.flowerNamesPath,
    release.data.compatibilityReportPath,
  ];
  return paths.map((filePath) => [filePath, fileStamp(filePath, fsModule)]);
}

function sameReleaseFileStamps(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every(([filePath, stamp], index) => (
    right[index]?.[0] === filePath && right[index]?.[1] === stamp
  ));
}

export function clearActiveGameReleaseCache(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  activeReleaseCache.delete(rootDir);
}

export function readActiveGameRelease(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const fsModule = options.fsModule || fs;
  if (options.fsModule) {
    try {
      const pointer = readActiveGameReleasePointerValue(rootDir, fsModule);
      return pointer ? resolveRelease(rootDir, pointer, fsModule) : null;
    } catch {
      return null;
    }
  }
  try {
    const pointer = readActiveGameReleasePointerValue(rootDir, fsModule);
    if (!pointer) {
      activeReleaseCache.delete(rootDir);
      return null;
    }
    const pointerKey = activeReleasePointerKey(pointer);
    const cached = activeReleaseCache.get(rootDir);
    if (cached?.pointerKey === pointerKey) {
      const currentStamps = releaseFileStamps(cached.release, fsModule);
      if (sameReleaseFileStamps(cached.fileStamps, currentStamps)) return cached.release;
    }
    const release = resolveRelease(rootDir, pointer, fsModule);
    if (!release) {
      activeReleaseCache.delete(rootDir);
      return null;
    }
    activeReleaseCache.set(rootDir, {
      pointerKey,
      release,
      fileStamps: releaseFileStamps(release, fsModule),
    });
    return release;
  } catch {
    activeReleaseCache.delete(rootDir);
    return null;
  }
}

export function readActiveGameReleasePointerSnapshot(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const fsModule = options.fsModule || fs;
  try {
    const value = readActiveGameReleasePointerValue(rootDir, fsModule);
    if (!value) return null;
    return resolveRelease(rootDir, value, fsModule) ? value : null;
  } catch {
    return null;
  }
}

export async function writeActiveGameReleasePointer(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const code = readGameCodeBundle({ rootDir, bundleId: options.codeBundleId, fsModule: options.fsModule });
  const data = readGameDataBundle({ rootDir, dataVersion: options.dataVersion, fsModule: options.fsModule });
  if (!code || !data) throw releaseError("GAME_RELEASE_BUNDLE_INVALID", "Code or data bundle is invalid");
  const dataRevalidatedForCodeVersion = data.sourceCodeVersion && data.sourceCodeVersion !== code.appVersion
    && options.revalidatedDataForCodeVersion === code.appVersion
    ? code.appVersion
    : null;
  if (data.sourceCodeVersion && data.sourceCodeVersion !== code.appVersion && !dataRevalidatedForCodeVersion) {
    throw releaseError("GAME_RELEASE_SOURCE_MISMATCH", "Code and data source versions do not match");
  }
  const pointer = {
    schemaVersion: SCHEMA_VERSION,
    releaseId: `${code.bundleId}--${data.dataVersion}`,
    codeBundleId: code.bundleId,
    codeVersion: code.appVersion,
    gameJsSha256: code.gameJsSha256,
    dataVersion: data.dataVersion,
    dataSourceCodeVersion: data.sourceCodeVersion,
    dataRevalidatedForCodeVersion,
    activatedAt: (options.now?.() || new Date()).toISOString(),
  };
  await writeJsonAtomic(rootDir, pointer, options);
  clearActiveGameReleaseCache({ rootDir });
  const active = readActiveGameRelease({ rootDir, fsModule: options.fsModule });
  if (!active) throw releaseError("GAME_RELEASE_ACTIVATION_FAILED", "Active release verification failed");
  return active;
}

export async function restoreActiveGameReleasePointer(snapshot, options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  if (!snapshot || snapshot.schemaVersion !== SCHEMA_VERSION || !resolveRelease(rootDir, snapshot, options.fsModule || fs)) {
    throw releaseError("GAME_RELEASE_POINTER_SNAPSHOT_INVALID", "Release pointer snapshot is invalid");
  }
  await writeJsonAtomic(rootDir, snapshot, options);
  clearActiveGameReleaseCache({ rootDir });
  return readActiveGameRelease({ rootDir, fsModule: options.fsModule });
}

function resolveRelease(rootDir, pointer, fsModule) {
  const code = readGameCodeBundle({ rootDir, bundleId: pointer.codeBundleId, fsModule });
  const data = readGameDataBundle({ rootDir, dataVersion: pointer.dataVersion, fsModule });
  if (!code || !data) return null;
  if (pointer.codeVersion !== code.appVersion || pointer.gameJsSha256 !== code.gameJsSha256) return null;
  if (pointer.dataSourceCodeVersion !== data.sourceCodeVersion) return null;
  if (
    data.sourceCodeVersion
    && data.sourceCodeVersion !== code.appVersion
    && pointer.dataRevalidatedForCodeVersion !== code.appVersion
  ) return null;
  if (pointer.releaseId !== `${code.bundleId}--${data.dataVersion}`) return null;
  return { releaseId: pointer.releaseId, code, data, activatedAt: pointer.activatedAt };
}

async function writeJsonAtomic(rootDir, value, options) {
  const fileSystem = options.fileSystem || fsp;
  const statusDir = path.join(rootDir, "runtime", "status");
  const target = path.join(statusDir, "game-release-active.json");
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fileSystem.mkdir(statusDir, { recursive: true });
  try {
    await fileSystem.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    const delays = options.renameRetryDelaysMs || DEFAULT_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fileSystem.rename(temporary, target);
        return;
      } catch (error) {
        if (!["EPERM", "EACCES"].includes(error?.code) || attempt >= delays.length) throw error;
        if (delays[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }
    }
  } finally {
    await fileSystem.rm(temporary, { force: true }).catch(() => {});
  }
}

function releaseError(code, message) {
  return Object.assign(new Error(message), { code });
}
