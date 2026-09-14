import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const ACTIVE_POINTER_SCHEMA_VERSION = 1;
const BUNDLE_SCHEMA_VERSION = 1;
const DATA_VERSION_PATTERN = /^[0-9a-f]+$/i;
const COMPATIBLE_STATUS = "compatible";
const DEFAULT_RENAME_RETRY_DELAYS_MS = Object.freeze([0, 25, 100, 250]);

export function readActiveGameDataBundle(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const fsModule = options.fsModule || fs;
  const pointerPath = activePointerPath(rootDir);
  let pointer;
  try {
    if (!isContainedRealPath(rootDir, pointerPath, fsModule)) return null;
    pointer = readJson(pointerPath, fsModule);
  } catch {
    return null;
  }
  if (pointer?.schemaVersion !== ACTIVE_POINTER_SCHEMA_VERSION) return null;
  return resolveBundle({ rootDir, dataVersion: pointer?.activeDataVersion, fsModule });
}

export function getDefaultFlowerNamePaths(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const active = readActiveGameDataBundle({ ...options, rootDir });
  if (active) return [active.flowerNamesPath];
  return [
    path.join(rootDir, "work", "flower-names.json"),
    path.join(rootDir, "outputs", "flower-names.json"),
  ];
}

export function readGameDataBundle(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  return resolveBundle({
    rootDir,
    dataVersion: options.dataVersion,
    fsModule: options.fsModule || fs,
  });
}

export function readActiveGameDataPointerSnapshot(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  try {
    if (!isContainedRealPath(rootDir, activePointerPath(rootDir), options.fsModule || fs)) return null;
    const snapshot = readJson(activePointerPath(rootDir), options.fsModule || fs);
    return snapshot?.schemaVersion === ACTIVE_POINTER_SCHEMA_VERSION ? snapshot : null;
  } catch {
    return null;
  }
}

export async function writeActiveGameDataPointer(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const dataVersion = normalizeDataVersion(options.dataVersion);
  const bundle = resolveBundle({ rootDir, dataVersion, fsModule: options.fsModule || fs });
  if (!bundle) throw gameDataError("GAME_DATA_BUNDLE_INVALID", `Invalid game data bundle: ${dataVersion}`);
  const value = {
    schemaVersion: ACTIVE_POINTER_SCHEMA_VERSION,
    activeDataVersion: bundle.dataVersion,
    activeDataSourceCodeVersion: bundle.sourceCodeVersion,
    activatedAt: normalizeDate(options.now?.() || new Date()),
  };
  await writeJsonAtomic(activePointerPath(rootDir), value, { ...options, allowedRoot: rootDir });
  return readActiveGameDataBundle({ rootDir, fsModule: options.fsModule || fs });
}

export async function restoreActiveGameDataPointer(snapshot, options = {}) {
  if (!snapshot || snapshot.schemaVersion !== ACTIVE_POINTER_SCHEMA_VERSION) {
    throw gameDataError("GAME_DATA_POINTER_SNAPSHOT_INVALID", "Active data pointer snapshot is invalid");
  }
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const bundle = resolveBundle({
    rootDir,
    dataVersion: snapshot.activeDataVersion,
    fsModule: options.fsModule || fs,
  });
  if (!bundle) throw gameDataError("GAME_DATA_POINTER_SNAPSHOT_INVALID", "Snapshot bundle is unavailable");
  await writeJsonAtomic(activePointerPath(rootDir), snapshot, { ...options, allowedRoot: rootDir });
  return readActiveGameDataBundle({ rootDir, fsModule: options.fsModule || fs });
}

export async function commitCompatibleGameDataBundle(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const dataVersion = normalizeDataVersion(options.dataVersion);
  if (options.compatibilityReport?.status !== COMPATIBLE_STATUS) {
    throw gameDataError("GAME_DATA_COMPATIBILITY_REQUIRED", "Only compatible candidates can be committed");
  }
  const sourceConfigPath = path.resolve(String(options.configPath || ""));
  const fileSystem = options.fileSystem || fsp;
  const [realRootDir, realSourceConfigPath] = await Promise.all([
    fileSystem.realpath(rootDir),
    fileSystem.realpath(sourceConfigPath),
  ]);
  if (!isContainedPath(realRootDir, realSourceConfigPath)) {
    throw gameDataError("GAME_DATA_CANDIDATE_PATH_OUTSIDE_ROOT", "Candidate config must stay inside the application root");
  }
  const flowerNames = normalizeFlowerNames(options.flowerNames);
  const versionsRoot = path.join(rootDir, "runtime", "game-data", "versions");
  const versionDir = path.join(versionsRoot, dataVersion);
  const stageDir = path.join(
    versionsRoot,
    `.stage-${dataVersion}-${process.pid}-${Date.now()}-${crypto.randomUUID()}`,
  );
  let promoted = false;
  try {
    await fileSystem.mkdir(versionsRoot, { recursive: true });
    await assertRealPathWithinRoot(rootDir, versionsRoot, fileSystem);
    await fileSystem.mkdir(stageDir, { recursive: true });
    const configFile = `g-data.${dataVersion}.text`;
    const flowerNamesFile = "flower-names.json";
    const compatibilityReportFile = "compatibility-report.json";
    await fileSystem.copyFile(sourceConfigPath, path.join(stageDir, configFile));
    await fileSystem.writeFile(
      path.join(stageDir, flowerNamesFile),
      `${JSON.stringify(flowerNames, null, 2)}\n`,
      "utf8",
    );
    const report = {
      ...options.compatibilityReport,
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      dataVersion,
      status: COMPATIBLE_STATUS,
    };
    await fileSystem.writeFile(
      path.join(stageDir, compatibilityReportFile),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    const evidenceEntries = await Promise.all(
      [configFile, flowerNamesFile, compatibilityReportFile].map(async (name) => [
        name,
        fileEvidence(await fileSystem.readFile(path.join(stageDir, name))),
      ]),
    );
    const manifest = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      dataVersion,
      sourceCodeVersion: normalizeOptionalText(options.sourceCodeVersion),
      configFile,
      flowerNamesFile,
      compatibilityReportFile,
      compatibilityStatus: COMPATIBLE_STATUS,
      registeredAt: normalizeDate(options.now?.() || new Date()),
      files: Object.fromEntries(evidenceEntries),
    };
    await fileSystem.writeFile(
      path.join(stageDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    if (!validateStagedBundle(rootDir, stageDir, dataVersion, options.fsModule || fs)) {
      throw gameDataError("GAME_DATA_BUNDLE_STAGE_INVALID", "Candidate stage failed verification");
    }
    try {
      await fileSystem.rename(stageDir, versionDir);
      promoted = true;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      const existing = resolveBundle({ rootDir, dataVersion, fsModule: options.fsModule || fs });
      if (!existing || !sameFileEvidence(existing.manifestPath, manifest, options.fsModule || fs)) {
        throw gameDataError("GAME_DATA_VERSION_COLLISION", `Different bundle already exists: ${dataVersion}`);
      }
      return existing;
    }
    const committed = resolveBundle({ rootDir, dataVersion, fsModule: options.fsModule || fs });
    if (!committed) throw gameDataError("GAME_DATA_BUNDLE_COMMIT_INVALID", "Committed bundle failed verification");
    return committed;
  } finally {
    if (!promoted) await fileSystem.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function registerCurrentGameDataBaseline(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const existing = readActiveGameDataBundle({ rootDir, fsModule: options.fsModule || fs });
  if (existing) return existing;

  const staticConfigPath = path.resolve(String(options.staticConfigPath || ""));
  const flowerNamesPath = path.resolve(String(options.flowerNamesPath || ""));
  const dataVersion = dataVersionFromConfigPath(staticConfigPath);
  if (!dataVersion) {
    throw gameDataError("GAME_DATA_BASELINE_INVALID", "Baseline static config filename is invalid");
  }
  const fileSystem = options.fileSystem || fsp;
  await Promise.all([fileSystem.access(staticConfigPath), fileSystem.access(flowerNamesPath)]);
  const [realRootDir, realStaticConfigPath, realFlowerNamesPath] = await Promise.all([
    fileSystem.realpath(rootDir),
    fileSystem.realpath(staticConfigPath),
    fileSystem.realpath(flowerNamesPath),
  ]);
  if (
    !isContainedPath(realRootDir, realStaticConfigPath)
    || !isContainedPath(realRootDir, realFlowerNamesPath)
  ) {
    throw gameDataError(
      "GAME_DATA_BASELINE_PATH_OUTSIDE_ROOT",
      "Baseline files must stay inside the application root",
    );
  }

  const versionsRoot = path.join(rootDir, "runtime", "game-data", "versions");
  const versionDir = path.join(versionsRoot, dataVersion);
  const stageDir = path.join(
    versionsRoot,
    `.stage-${dataVersion}-${process.pid}-${Date.now()}-${crypto.randomUUID()}`,
  );
  const registeredAt = normalizeDate(options.now?.() || new Date());
  let promoted = false;
  try {
    await fileSystem.mkdir(versionsRoot, { recursive: true });
    await assertRealPathWithinRoot(rootDir, versionsRoot, fileSystem);
    await fileSystem.mkdir(stageDir, { recursive: true });
    const configFile = `g-data.${dataVersion}.text`;
    const flowerNamesFile = "flower-names.json";
    const compatibilityReportFile = "compatibility-report.json";
    await fileSystem.copyFile(staticConfigPath, path.join(stageDir, configFile));
    await fileSystem.copyFile(flowerNamesPath, path.join(stageDir, flowerNamesFile));
    const [configBuffer, flowerNamesBuffer] = await Promise.all([
      fileSystem.readFile(path.join(stageDir, configFile)),
      fileSystem.readFile(path.join(stageDir, flowerNamesFile)),
    ]);
    const report = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      dataVersion,
      status: COMPATIBLE_STATUS,
      basis: "registered-current-baseline",
      registeredAt,
    };
    await fileSystem.writeFile(
      path.join(stageDir, compatibilityReportFile),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    const reportBuffer = await fileSystem.readFile(path.join(stageDir, compatibilityReportFile));
    const manifest = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      dataVersion,
      sourceCodeVersion: normalizeOptionalText(options.sourceCodeVersion),
      configFile,
      flowerNamesFile,
      compatibilityReportFile,
      compatibilityStatus: COMPATIBLE_STATUS,
      registeredAt,
      files: {
        [configFile]: fileEvidence(configBuffer),
        [flowerNamesFile]: fileEvidence(flowerNamesBuffer),
        [compatibilityReportFile]: fileEvidence(reportBuffer),
      },
    };
    await fileSystem.writeFile(
      path.join(stageDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    if (!validateStagedBundle(rootDir, stageDir, dataVersion, options.fsModule || fs)) {
      throw gameDataError("GAME_DATA_BUNDLE_STAGE_INVALID", "Baseline stage failed verification");
    }

    try {
      await fileSystem.rename(stageDir, versionDir);
      promoted = true;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error?.code)) throw error;
      const existingBundle = resolveBundle({ rootDir, dataVersion, fsModule: options.fsModule || fs });
      if (!existingBundle) throw gameDataError("GAME_DATA_BASELINE_COLLISION", `Bundle already exists: ${dataVersion}`);
    }
    return await writeActiveGameDataPointer({ ...options, rootDir, dataVersion });
  } finally {
    if (!promoted) await fileSystem.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveBundle({ rootDir, dataVersion, fsModule }) {
  const token = normalizeDataVersion(dataVersion, false);
  if (!token) return null;
  const gameDataRoot = path.join(rootDir, "runtime", "game-data");
  const versionsRoot = path.join(gameDataRoot, "versions");
  const versionDir = path.join(versionsRoot, token);
  const manifestPath = path.join(versionDir, "manifest.json");
  const compatibilityReportPath = path.join(versionDir, "compatibility-report.json");
  let manifest;
  let report;
  try {
    if (!isContainedRealPath(rootDir, gameDataRoot, fsModule)) return null;
    if (!isContainedRealPath(gameDataRoot, versionDir, fsModule)) return null;
    manifest = readJson(manifestPath, fsModule);
    report = readJson(compatibilityReportPath, fsModule);
  } catch {
    return null;
  }
  if (
    manifest?.schemaVersion !== BUNDLE_SCHEMA_VERSION
    || manifest?.dataVersion !== token
    || manifest?.compatibilityStatus !== COMPATIBLE_STATUS
    || report?.schemaVersion !== BUNDLE_SCHEMA_VERSION
    || report?.dataVersion !== token
    || report?.status !== COMPATIBLE_STATUS
  ) return null;

  const expected = {
    configFile: `g-data.${token}.text`,
    flowerNamesFile: "flower-names.json",
    compatibilityReportFile: "compatibility-report.json",
  };
  if (Object.entries(expected).some(([key, value]) => manifest[key] !== value)) return null;
  const staticConfigPath = path.join(versionDir, expected.configFile);
  const flowerNamesPath = path.join(versionDir, expected.flowerNamesFile);
  try {
    for (const filePath of [manifestPath, compatibilityReportPath, staticConfigPath, flowerNamesPath]) {
      if (!isContainedRealPath(gameDataRoot, filePath, fsModule)) return null;
      if (!fsModule.statSync(filePath).isFile()) return null;
    }
    if (!matchesFileEvidence(staticConfigPath, manifest.files?.[expected.configFile], fsModule)) return null;
    if (!matchesFileEvidence(flowerNamesPath, manifest.files?.[expected.flowerNamesFile], fsModule)) return null;
    if (!matchesFileEvidence(
      compatibilityReportPath,
      manifest.files?.[expected.compatibilityReportFile],
      fsModule,
    )) return null;
  } catch {
    return null;
  }
  return {
    dataVersion: token,
    sourceCodeVersion: normalizeOptionalText(manifest.sourceCodeVersion),
    versionDir,
    staticConfigPath,
    flowerNamesPath,
    manifestPath,
    compatibilityReportPath,
  };
}

function matchesFileEvidence(filePath, evidence, fsModule) {
  if (
    !evidence
    || !Number.isInteger(evidence.bytes)
    || evidence.bytes <= 0
    || !/^[0-9a-f]{64}$/i.test(evidence.sha256 || "")
  ) return false;
  const buffer = fsModule.readFileSync(filePath);
  return buffer.length === evidence.bytes
    && crypto.createHash("sha256").update(buffer).digest("hex") === evidence.sha256.toLowerCase();
}

function validateStagedBundle(rootDir, stageDir, dataVersion, fsModule) {
  try {
    if (!isContainedRealPath(rootDir, stageDir, fsModule)) return false;
    const manifestPath = path.join(stageDir, "manifest.json");
    const reportPath = path.join(stageDir, "compatibility-report.json");
    const manifest = readJson(manifestPath, fsModule);
    const report = readJson(reportPath, fsModule);
    if (
      manifest?.schemaVersion !== BUNDLE_SCHEMA_VERSION
      || manifest?.dataVersion !== dataVersion
      || manifest?.compatibilityStatus !== COMPATIBLE_STATUS
      || report?.schemaVersion !== BUNDLE_SCHEMA_VERSION
      || report?.dataVersion !== dataVersion
      || report?.status !== COMPATIBLE_STATUS
    ) return false;
    const names = [
      `g-data.${dataVersion}.text`,
      "flower-names.json",
      "compatibility-report.json",
    ];
    for (const name of names) {
      const filePath = path.join(stageDir, name);
      if (!isContainedRealPath(rootDir, filePath, fsModule)) return false;
      if (!matchesFileEvidence(filePath, manifest.files?.[name], fsModule)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isContainedRealPath(rootPath, targetPath, fsModule) {
  const realRoot = fsModule.realpathSync(rootPath);
  const realTarget = fsModule.realpathSync(targetPath);
  return isContainedPath(realRoot, realTarget);
}

function isContainedPath(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function writeJsonAtomic(filePath, value, options) {
  const fileSystem = options.fileSystem || fsp;
  const retryDelaysMs = options.retryDelaysMs || DEFAULT_RENAME_RETRY_DELAYS_MS;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  let renamed = false;
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
  if (options.allowedRoot) {
    await assertRealPathWithinRoot(options.allowedRoot, path.dirname(filePath), fileSystem);
  }
  try {
    await fileSystem.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    for (let index = 0; index < retryDelaysMs.length; index += 1) {
      if (index > 0 && retryDelaysMs[index] > 0) await wait(retryDelaysMs[index]);
      try {
        await fileSystem.rename(tempPath, filePath);
        renamed = true;
        return;
      } catch (error) {
        if (!isRetryableRenameError(error) || index === retryDelaysMs.length - 1) throw error;
      }
    }
  } finally {
    if (!renamed) await fileSystem.rm(tempPath, { force: true }).catch(() => {});
  }
}

function activePointerPath(rootDir) {
  return path.join(rootDir, "runtime", "status", "game-data-active.json");
}

function readJson(filePath, fsModule) {
  return JSON.parse(fsModule.readFileSync(filePath, "utf8"));
}

function normalizeDataVersion(value, shouldThrow = true) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text && DATA_VERSION_PATTERN.test(text)) return text.toLowerCase();
  if (!shouldThrow) return null;
  throw gameDataError("GAME_DATA_VERSION_INVALID", "Game data version is invalid");
}

function dataVersionFromConfigPath(filePath) {
  return /^g-data\.([0-9a-f]+)\.text$/i.exec(path.basename(filePath))?.[1]?.toLowerCase() || null;
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw gameDataError("GAME_DATA_DATE_INVALID", "Game data date is invalid");
  return date.toISOString();
}

function normalizeOptionalText(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 256 && !/[\r\n]/.test(text) ? text : null;
}

function fileEvidence(buffer) {
  return {
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

async function assertRealPathWithinRoot(rootPath, targetPath, fileSystem) {
  const [realRoot, realTarget] = await Promise.all([
    fileSystem.realpath(rootPath),
    fileSystem.realpath(targetPath),
  ]);
  if (!isContainedPath(realRoot, realTarget)) {
    throw gameDataError("GAME_DATA_PATH_OUTSIDE_ROOT", "Game data path escapes the application root");
  }
}

function normalizeFlowerNames(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw gameDataError("GAME_DATA_FLOWER_NAMES_INVALID", "Flower names must be an object");
  }
  const entries = Object.entries(value)
    .map(([id, name]) => [String(id), String(name ?? "").trim()])
    .filter(([id, name]) => /^\d+$/.test(id) && Number(id) > 0 && name && name !== "0")
    .sort(([left], [right]) => Number(left) - Number(right));
  if (entries.length === 0) throw gameDataError("GAME_DATA_FLOWER_NAMES_INVALID", "Flower names are empty");
  return Object.fromEntries(entries);
}

function sameFileEvidence(manifestPath, expectedManifest, fsModule) {
  try {
    const actual = readJson(manifestPath, fsModule);
    return JSON.stringify(actual?.files || {}) === JSON.stringify(expectedManifest.files || {});
  } catch {
    return false;
  }
}

function isRetryableRenameError(error) {
  return ["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(error?.code);
}

function gameDataError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
