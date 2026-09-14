import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = 1;
const COMPATIBLE_STATUS = "compatible";
const APP_VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+)*$/;
const BUNDLE_ID_PATTERN = /^[0-9]+(?:\.[0-9]+)*-[0-9a-f]{12}$/i;
const DEFAULT_RENAME_RETRY_DELAYS_MS = Object.freeze([0, 25, 100, 250]);

export function readActiveGameCodeBundle(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const fsModule = options.fsModule || fs;
  try {
    const pointerPath = activePointerPath(rootDir);
    if (!isContainedRealPath(rootDir, pointerPath, fsModule)) return null;
    const pointer = readJson(pointerPath, fsModule);
    if (pointer?.schemaVersion !== SCHEMA_VERSION) return null;
    const bundle = resolveBundle({ rootDir, bundleId: pointer.activeCodeBundleId, fsModule });
    if (!bundle) return null;
    if (pointer.activeCodeVersion !== bundle.appVersion || pointer.activeGameJsSha256 !== bundle.gameJsSha256) return null;
    return bundle;
  } catch {
    return null;
  }
}

export function readGameCodeBundle(options = {}) {
  return resolveBundle({
    rootDir: path.resolve(options.rootDir || process.cwd()),
    bundleId: options.bundleId,
    fsModule: options.fsModule || fs,
  });
}

export function readActiveGameCodePointerSnapshot(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const fsModule = options.fsModule || fs;
  try {
    const pointerPath = activePointerPath(rootDir);
    if (!isContainedRealPath(rootDir, pointerPath, fsModule)) return null;
    const value = readJson(pointerPath, fsModule);
    return value?.schemaVersion === SCHEMA_VERSION ? value : null;
  } catch {
    return null;
  }
}

export async function writeActiveGameCodePointer(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const bundle = resolveBundle({ rootDir, bundleId: options.bundleId, fsModule: options.fsModule || fs });
  if (!bundle) throw gameCodeError("GAME_CODE_BUNDLE_INVALID", `Invalid game code bundle: ${options.bundleId}`);
  const pointer = {
    schemaVersion: SCHEMA_VERSION,
    activeCodeBundleId: bundle.bundleId,
    activeCodeVersion: bundle.appVersion,
    activeGameJsSha256: bundle.gameJsSha256,
    activatedAt: normalizeDate(options.now?.() || new Date()),
  };
  await writeJsonAtomic(activePointerPath(rootDir), pointer, { ...options, allowedRoot: rootDir });
  return readActiveGameCodeBundle({ rootDir, fsModule: options.fsModule || fs });
}

export async function restoreActiveGameCodePointer(snapshot, options = {}) {
  if (!snapshot || snapshot.schemaVersion !== SCHEMA_VERSION) {
    throw gameCodeError("GAME_CODE_POINTER_SNAPSHOT_INVALID", "Active code pointer snapshot is invalid");
  }
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const bundle = resolveBundle({ rootDir, bundleId: snapshot.activeCodeBundleId, fsModule: options.fsModule || fs });
  if (!bundle || snapshot.activeCodeVersion !== bundle.appVersion || snapshot.activeGameJsSha256 !== bundle.gameJsSha256) {
    throw gameCodeError("GAME_CODE_POINTER_SNAPSHOT_INVALID", "Snapshot code bundle is unavailable");
  }
  await writeJsonAtomic(activePointerPath(rootDir), snapshot, { ...options, allowedRoot: rootDir });
  return readActiveGameCodeBundle({ rootDir, fsModule: options.fsModule || fs });
}

export async function commitCompatibleGameCodeBundle(options = {}) {
  if (options.compatibilityReport?.status !== COMPATIBLE_STATUS) {
    throw gameCodeError("GAME_CODE_COMPATIBILITY_REQUIRED", "Only compatible code candidates can be committed");
  }
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const packageDir = path.resolve(String(options.packageDir || ""));
  const fileSystem = options.fileSystem || fsp;
  const sourceFiles = {
    manifest: path.join(packageDir, "Manifest.xml"),
    gameJs: path.join(packageDir, "tar", "game.js"),
    modules: path.join(packageDir, "tar", "modules.json"),
  };
  await assertCandidatePaths(rootDir, packageDir, Object.values(sourceFiles), fileSystem);
  const [manifestBuffer, gameJsBuffer, modulesBuffer] = await Promise.all([
    fileSystem.readFile(sourceFiles.manifest),
    fileSystem.readFile(sourceFiles.gameJs),
    fileSystem.readFile(sourceFiles.modules),
  ]);
  if (gameJsBuffer.length === 0) throw gameCodeError("GAME_CODE_CANDIDATE_INVALID", "Candidate game.js is empty");
  try {
    JSON.parse(modulesBuffer.toString("utf8"));
  } catch {
    throw gameCodeError("GAME_CODE_CANDIDATE_INVALID", "Candidate modules.json is invalid");
  }
  const manifestVersion = parseManifestVersion(manifestBuffer.toString("utf8"));
  const appVersion = normalizeAppVersion(options.appVersion || manifestVersion);
  if (manifestVersion !== appVersion) {
    throw gameCodeError("GAME_CODE_VERSION_MISMATCH", `Manifest version ${manifestVersion} does not match ${appVersion}`);
  }
  const gameJsSha256 = sha256(gameJsBuffer);
  if (options.expectedGameJsSha256 && String(options.expectedGameJsSha256).toLowerCase() !== gameJsSha256) {
    throw gameCodeError("GAME_CODE_HASH_MISMATCH", "Candidate game.js hash does not match discovery evidence");
  }
  const bundleId = `${appVersion}-${gameJsSha256.slice(0, 12)}`;
  const versionsRoot = path.join(rootDir, "runtime", "game-code", "versions");
  const versionDir = path.join(versionsRoot, bundleId);
  await fileSystem.mkdir(versionsRoot, { recursive: true });
  await assertRealPathWithinRoot(rootDir, versionsRoot, fileSystem);

  const existing = resolveBundle({ rootDir, bundleId, fsModule: options.fsModule || fs });
  if (existing) return existing;
  await rejectVersionContentCollision({ versionsRoot, appVersion, gameJsSha256, fileSystem });

  const stageDir = path.join(versionsRoot, `.stage-${bundleId}-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
  let promoted = false;
  try {
    await fileSystem.mkdir(path.join(stageDir, "tar"), { recursive: true });
    await Promise.all([
      fileSystem.copyFile(sourceFiles.manifest, path.join(stageDir, "Manifest.xml")),
      fileSystem.copyFile(sourceFiles.gameJs, path.join(stageDir, "tar", "game.js")),
      fileSystem.copyFile(sourceFiles.modules, path.join(stageDir, "tar", "modules.json")),
    ]);
    const packageEvidence = normalizeJsonObject(options.packageEvidence);
    const compatibilityReport = {
      ...normalizeJsonObject(options.compatibilityReport),
      schemaVersion: SCHEMA_VERSION,
      status: COMPATIBLE_STATUS,
      appVersion,
      gameJsSha256,
    };
    await Promise.all([
      fileSystem.writeFile(path.join(stageDir, "package-evidence.json"), jsonText(packageEvidence), "utf8"),
      fileSystem.writeFile(path.join(stageDir, "compatibility-report.json"), jsonText(compatibilityReport), "utf8"),
    ]);
    const relativeFiles = [
      "Manifest.xml",
      "tar/game.js",
      "tar/modules.json",
      "package-evidence.json",
      "compatibility-report.json",
    ];
    const files = Object.fromEntries(await Promise.all(relativeFiles.map(async (name) => [
      name,
      fileEvidence(await fileSystem.readFile(path.join(stageDir, ...name.split("/")))),
    ])));
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      bundleId,
      appVersion,
      gameJsSha256,
      compatibilityStatus: COMPATIBLE_STATUS,
      registeredAt: normalizeDate(options.now?.() || new Date()),
      files,
    };
    await fileSystem.writeFile(path.join(stageDir, "manifest.json"), jsonText(manifest), "utf8");
    if (!validateBundleDirectory(rootDir, stageDir, bundleId, options.fsModule || fs)) {
      throw gameCodeError("GAME_CODE_BUNDLE_STAGE_INVALID", "Candidate code stage failed verification");
    }
    try {
      await fileSystem.rename(stageDir, versionDir);
      promoted = true;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      const raced = resolveBundle({ rootDir, bundleId, fsModule: options.fsModule || fs });
      if (!raced) throw gameCodeError("GAME_CODE_BUNDLE_COLLISION", `Different bundle already exists: ${bundleId}`);
      return raced;
    }
    const committed = resolveBundle({ rootDir, bundleId, fsModule: options.fsModule || fs });
    if (!committed) throw gameCodeError("GAME_CODE_BUNDLE_COMMIT_INVALID", "Committed code bundle failed verification");
    return committed;
  } finally {
    if (!promoted) await fileSystem.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveBundle({ rootDir, bundleId, fsModule }) {
  const token = normalizeBundleId(bundleId, false);
  if (!token) return null;
  const gameCodeRoot = path.join(rootDir, "runtime", "game-code");
  const versionDir = path.join(gameCodeRoot, "versions", token);
  if (!isContainedRealPath(gameCodeRoot, versionDir, fsModule)) return null;
  if (!validateBundleDirectory(rootDir, versionDir, token, fsModule)) return null;
  const manifestPath = path.join(versionDir, "manifest.json");
  const manifest = readJson(manifestPath, fsModule);
  return {
    bundleId: manifest.bundleId,
    appVersion: manifest.appVersion,
    gameJsSha256: manifest.gameJsSha256,
    versionDir,
    manifestPath,
    packageManifestPath: path.join(versionDir, "Manifest.xml"),
    gameJsPath: path.join(versionDir, "tar", "game.js"),
    modulesPath: path.join(versionDir, "tar", "modules.json"),
    packageEvidencePath: path.join(versionDir, "package-evidence.json"),
    compatibilityReportPath: path.join(versionDir, "compatibility-report.json"),
  };
}

function validateBundleDirectory(rootDir, versionDir, bundleId, fsModule) {
  try {
    if (!isContainedRealPath(path.join(rootDir, "runtime", "game-code"), versionDir, fsModule)) return false;
    const manifest = readJson(path.join(versionDir, "manifest.json"), fsModule);
    const report = readJson(path.join(versionDir, "compatibility-report.json"), fsModule);
    if (
      manifest?.schemaVersion !== SCHEMA_VERSION
      || manifest?.bundleId !== bundleId
      || normalizeAppVersion(manifest?.appVersion, false) !== manifest?.appVersion
      || !/^[0-9a-f]{64}$/i.test(manifest?.gameJsSha256 || "")
      || manifest?.compatibilityStatus !== COMPATIBLE_STATUS
      || report?.status !== COMPATIBLE_STATUS
      || report?.appVersion !== manifest.appVersion
      || report?.gameJsSha256 !== manifest.gameJsSha256
    ) return false;
    const requiredFiles = ["Manifest.xml", "tar/game.js", "tar/modules.json", "package-evidence.json", "compatibility-report.json"];
    for (const name of requiredFiles) {
      const filePath = path.join(versionDir, ...name.split("/"));
      if (!isContainedRealPath(versionDir, filePath, fsModule)) return false;
      if (!matchesFileEvidence(filePath, manifest.files?.[name], fsModule)) return false;
    }
    if (parseManifestVersion(fsModule.readFileSync(path.join(versionDir, "Manifest.xml"), "utf8")) !== manifest.appVersion) return false;
    if (sha256(fsModule.readFileSync(path.join(versionDir, "tar", "game.js"))) !== manifest.gameJsSha256) return false;
    JSON.parse(fsModule.readFileSync(path.join(versionDir, "tar", "modules.json"), "utf8"));
    return true;
  } catch {
    return false;
  }
}

async function rejectVersionContentCollision({ versionsRoot, appVersion, gameJsSha256, fileSystem }) {
  for (const entry of await fileSystem.readdir(versionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".stage-")) continue;
    try {
      const manifest = JSON.parse(await fileSystem.readFile(path.join(versionsRoot, entry.name, "manifest.json"), "utf8"));
      if (manifest?.appVersion === appVersion && manifest?.gameJsSha256 !== gameJsSha256) {
        throw gameCodeError("GAME_CODE_VERSION_CONTENT_COLLISION", `Version ${appVersion} already has different game.js content`);
      }
    } catch (error) {
      if (error?.code === "GAME_CODE_VERSION_CONTENT_COLLISION") throw error;
      if (error?.code !== "ENOENT" && error instanceof SyntaxError) continue;
    }
  }
}

async function assertCandidatePaths(rootDir, packageDir, filePaths, fileSystem) {
  const realRoot = await fileSystem.realpath(rootDir);
  let realPackage;
  try {
    realPackage = await fileSystem.realpath(packageDir);
  } catch {
    throw gameCodeError("GAME_CODE_CANDIDATE_INVALID", "Candidate package directory is unavailable");
  }
  if (!isContainedPath(realRoot, realPackage)) {
    throw gameCodeError("GAME_CODE_CANDIDATE_PATH_OUTSIDE_ROOT", "Candidate package must stay inside the application root");
  }
  for (const filePath of filePaths) {
    let realFile;
    try {
      realFile = await fileSystem.realpath(filePath);
    } catch {
      throw gameCodeError("GAME_CODE_CANDIDATE_INVALID", `Candidate file is unavailable: ${path.basename(filePath)}`);
    }
    if (!isContainedPath(realPackage, realFile) || !isContainedPath(realRoot, realFile)) {
      throw gameCodeError("GAME_CODE_CANDIDATE_PATH_OUTSIDE_ROOT", "Candidate files must stay inside the candidate package");
    }
  }
}

async function writeJsonAtomic(filePath, value, options) {
  const fileSystem = options.fileSystem || fsp;
  const delays = options.retryDelaysMs || DEFAULT_RENAME_RETRY_DELAYS_MS;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  let renamed = false;
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
  if (options.allowedRoot) await assertRealPathWithinRoot(options.allowedRoot, path.dirname(filePath), fileSystem);
  try {
    await fileSystem.writeFile(tempPath, jsonText(value), "utf8");
    for (let index = 0; index < delays.length; index += 1) {
      if (index > 0 && delays[index] > 0) await wait(delays[index]);
      try {
        await fileSystem.rename(tempPath, filePath);
        renamed = true;
        return;
      } catch (error) {
        if (!isRetryableRenameError(error) || index === delays.length - 1) throw error;
      }
    }
  } finally {
    if (!renamed) await fileSystem.rm(tempPath, { force: true }).catch(() => {});
  }
}

function matchesFileEvidence(filePath, evidence, fsModule) {
  if (!evidence || !Number.isSafeInteger(evidence.bytes) || !/^[0-9a-f]{64}$/i.test(evidence.sha256 || "")) return false;
  const buffer = fsModule.readFileSync(filePath);
  return buffer.length === evidence.bytes && sha256(buffer) === evidence.sha256;
}

function fileEvidence(buffer) {
  return { bytes: buffer.length, sha256: sha256(buffer) };
}

function parseManifestVersion(text) {
  const value = String(text || "").match(/<appVersion>\s*([^<\s]+)\s*<\/appVersion>/i)?.[1];
  return normalizeAppVersion(value);
}

function normalizeAppVersion(value, shouldThrow = true) {
  const text = String(value || "").trim();
  if (APP_VERSION_PATTERN.test(text)) return text;
  if (!shouldThrow) return null;
  throw gameCodeError("GAME_CODE_VERSION_INVALID", "Game code version is invalid");
}

function normalizeBundleId(value, shouldThrow = true) {
  const text = String(value || "").trim();
  if (BUNDLE_ID_PATTERN.test(text)) return text;
  if (!shouldThrow) return null;
  throw gameCodeError("GAME_CODE_BUNDLE_ID_INVALID", "Game code bundle id is invalid");
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw gameCodeError("GAME_CODE_DATE_INVALID", "Game code timestamp is invalid");
  return date.toISOString();
}

function activePointerPath(rootDir) {
  return path.join(rootDir, "runtime", "status", "game-code-active.json");
}

function readJson(filePath, fsModule) {
  return JSON.parse(fsModule.readFileSync(filePath, "utf8"));
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isContainedRealPath(rootPath, targetPath, fsModule) {
  try {
    return isContainedPath(fsModule.realpathSync(rootPath), fsModule.realpathSync(targetPath));
  } catch {
    return false;
  }
}

function isContainedPath(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function assertRealPathWithinRoot(rootPath, targetPath, fileSystem) {
  const [realRoot, realTarget] = await Promise.all([fileSystem.realpath(rootPath), fileSystem.realpath(targetPath)]);
  if (!isContainedPath(realRoot, realTarget)) throw gameCodeError("GAME_CODE_PATH_OUTSIDE_ROOT", "Game code path escapes root");
}

function isRetryableRenameError(error) {
  return ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
}

function gameCodeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
