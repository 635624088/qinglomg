import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { auditGameDataCompatibility } from "./game-data-compatibility.mjs";
import {
  commitCompatibleGameDataBundle,
  readActiveGameDataBundle,
  readActiveGameDataPointerSnapshot,
  registerCurrentGameDataBaseline,
  restoreActiveGameDataPointer,
  writeActiveGameDataPointer,
} from "./game-data-version.mjs";
import {
  downloadAndExtractLatestGamePackage,
  downloadPackageResourceConfigFromModules,
  downloadStaticConfigResource,
} from "./sync-latest-static-config.mjs";

const DATA_VERSION_PATTERN = /^[0-9a-f]+$/i;

export async function discoverGameDataCandidate(options = {}) {
  const candidateDir = path.resolve(String(options.candidateDir || ""));
  if (!options.packageUrl) throw syncError("GAME_DATA_DISCOVERY_FAILED", "Official package URL is required");
  const baseUrls = normalizeBaseUrls(options.baseUrls || []);
  await fsp.mkdir(candidateDir, { recursive: true });
  const packagePath = path.join(candidateDir, "official-package.bin");
  const extractDir = path.join(candidateDir, "official-package");
  const packageEvidence = await (options.downloadPackage || downloadAndExtractLatestGamePackage)({
    appId: options.appId,
    packageUrl: options.packageUrl,
    packagePath,
    extractDir,
    fetchImpl: options.fetchImpl,
  });
  const resourceConfig = await (options.downloadResourceConfig || downloadPackageResourceConfigFromModules)({
    modulesPath: path.join(extractDir, "tar", "modules.json"),
    baseUrls,
    outDir: path.join(candidateDir, "resource-config"),
    fetchImpl: options.fetchImpl,
  });
  const dataVersion = String(resourceConfig?.resource?.version || "");
  if (!DATA_VERSION_PATTERN.test(dataVersion)) {
    throw syncError("GAME_DATA_DISCOVERY_FAILED", "Candidate data version is invalid");
  }
  const configPath = path.join(candidateDir, `g-data.${dataVersion}.text`);
  const configEvidence = await (options.downloadStaticConfig || downloadStaticConfigResource)({
    resource: resourceConfig.resource,
    baseUrls,
    outputPath: configPath,
    fetchImpl: options.fetchImpl,
  });
  assertContained(candidateDir, [
    packagePath,
    extractDir,
    resourceConfig.resourceConfigPath,
    configEvidence.configPath,
  ]);
  return {
    dataVersion,
    sourceCodeVersion: String(
      options.sourceCodeVersion
      || packageEvidence?.manifestAppVersion
      || "",
    ) || null,
    configPath: configEvidence.configPath,
    packageDir: extractDir,
    packageManifestPath: path.join(extractDir, "Manifest.xml"),
    gameJsPath: path.join(extractDir, "tar", "game.js"),
    modulesPath: path.join(extractDir, "tar", "modules.json"),
    bytes: configEvidence.bytes,
    sha256: configEvidence.sha256,
    package: {
      bytes: packageEvidence?.packageBytes ?? null,
      sha256: packageEvidence?.packageSha256 ?? null,
    },
    resourceConfig: {
      token: resourceConfig.resourceConfigVersionToken,
      bytes: resourceConfig.resourceConfigBytes,
      sha256: resourceConfig.resourceConfigSha256,
    },
    calls: ["official-package", "package-resource-config", "static-config"],
  };
}

export async function syncGameDataCandidate(options = {}) {
  const prepared = await prepareGameDataCandidate(options);
  const {
    rootDir,
    activeBefore,
    pointerBefore,
    candidate,
    dataVersion,
    audit,
    reportPath,
    sameAsActive,
  } = prepared;
  if (audit.status !== "compatible") {
    return {
      status: audit.status,
      activeDataVersion: activeBefore.dataVersion,
      candidateDataVersion: dataVersion,
      reportPath,
    };
  }
  if (sameAsActive) {
    return {
      status: "latest",
      activeDataVersion: activeBefore.dataVersion,
      previousDataVersion: activeBefore.dataVersion,
      candidateDataVersion: dataVersion,
      sourceCodeVersion: candidate.sourceCodeVersion || options.sourceCodeVersion || null,
      loaderCount: audit.loaderAudit?.loaderCount ?? 0,
      reportPath,
      revalidated: true,
    };
  }

  await options.beforeActivate?.();
  await enterPhase(options, "stage", {
    dataVersion,
    sourceCodeVersion: candidate.sourceCodeVersion || options.sourceCodeVersion || null,
  });
  await commitCompatibleGameDataBundle({
    rootDir,
    dataVersion,
    sourceCodeVersion: candidate.sourceCodeVersion || options.sourceCodeVersion || null,
    configPath: candidate.configPath,
    flowerNames: audit.flowerNames,
    compatibilityReport: prepared.report,
    fileSystem: options.fileSystem,
  });
  await enterPhase(options, "pointer");
  await writeActiveGameDataPointer({
    rootDir,
    dataVersion,
    fileSystem: options.fileSystem,
  });
  try {
    await enterPhase(options, "verify");
    const activeAfter = (options.verifyActivation || readActiveGameDataBundle)({ rootDir });
    if (
      !activeAfter
      || activeAfter.dataVersion !== dataVersion
      || path.dirname(activeAfter.staticConfigPath) !== path.dirname(activeAfter.flowerNamesPath)
    ) {
      throw syncError("GAME_DATA_ACTIVATION_FAILED", "Activated bundle verification failed");
    }
    return {
      status: "latest",
      activeDataVersion: dataVersion,
      previousDataVersion: activeBefore.dataVersion,
      candidateDataVersion: dataVersion,
      sourceCodeVersion: candidate.sourceCodeVersion || options.sourceCodeVersion || null,
      loaderCount: audit.loaderAudit?.loaderCount ?? 0,
      reportPath,
    };
  } catch (error) {
    try {
      await restoreActiveGameDataPointer(pointerBefore, {
        rootDir,
        fileSystem: options.fileSystem,
      });
    } catch (restoreError) {
      throw syncError(
        "GAME_DATA_ROLLBACK_FAILED",
        `Activation failed and pointer rollback failed: ${safeMessage(restoreError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export async function prepareGameDataCandidate(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  let activeBefore = options.jointActiveDataBundle || readActiveGameDataBundle({ rootDir });
  if (!activeBefore) {
    activeBefore = await registerCurrentGameDataBaseline({
      rootDir,
      staticConfigPath: options.currentStaticConfigPath,
      flowerNamesPath: options.currentFlowerNamesPath,
      sourceCodeVersion: options.currentSourceCodeVersion || null,
      fileSystem: options.fileSystem,
    });
  }
  const pointerBefore = readActiveGameDataPointerSnapshot({ rootDir });
  if (!pointerBefore) throw syncError("GAME_DATA_BASELINE_INVALID", "Active baseline pointer is unavailable");
  const jobId = createJobId(options.jobId);
  const candidateDir = path.join(rootDir, "runtime", "game-data", "candidates", jobId);
  await fsp.mkdir(candidateDir, { recursive: true });
  let candidate;
  try {
    await enterPhase(options, "download");
    candidate = await (options.discoverCandidate || discoverGameDataCandidate)({
      ...options,
      candidateDir,
    });
  } catch (error) {
    await writeCandidateReport(candidateDir, {
      schemaVersion: 1,
      status: "incompatible",
      phase: "download",
      reasons: [`discovery-failed:${safeMessage(error)}`],
      activeDataVersion: activeBefore.dataVersion,
    });
    throw error;
  }
  const dataVersion = String(candidate?.dataVersion || "");
  if (!DATA_VERSION_PATTERN.test(dataVersion)) {
    throw syncError("GAME_DATA_DISCOVERY_FAILED", "Discovered data version is invalid");
  }
  assertContained(candidateDir, [candidate.configPath]);
  await enterPhase(options, "validate", {
    dataVersion,
    sourceCodeVersion: candidate.sourceCodeVersion || options.sourceCodeVersion || null,
  });
  const auditBaselinePath = path.resolve(
    String(options.auditBaselinePath || activeBefore.staticConfigPath),
  );
  assertContained(rootDir, [auditBaselinePath]);
  let audit;
  try {
    audit = (options.auditCandidate || auditGameDataCompatibility)({
      baselinePath: auditBaselinePath,
      candidatePath: candidate.configPath,
      dataVersion,
      expectedBytes: candidate.bytes,
      expectedSha256: candidate.sha256,
    });
  } catch (error) {
    audit = {
      status: "incompatible",
      reasons: [`audit-failed:${safeMessage(error)}`],
      flowerNames: {},
      loaderAudit: { compatible: false, loaderCount: 0, results: [] },
      diff: null,
    };
  }
  let sameAsActive = false;
  if (dataVersion === activeBefore.dataVersion) {
    sameAsActive = await filesEqual(candidate.configPath, activeBefore.staticConfigPath);
    if (!sameAsActive) {
      audit = {
        ...audit,
        status: "incompatible",
        reasons: [...new Set([...(audit.reasons || []), `version-content-collision:${dataVersion}`])],
      };
    }
  }
  const report = buildCandidateReport({
    candidate,
    audit,
    activeBefore,
    auditBaselinePath,
    auditBaselineDataVersion: options.auditBaselineDataVersion,
    sourceCodeVersion: options.sourceCodeVersion,
  });
  const flowerNamesPath = await writeCandidateJson(candidateDir, "flower-names.json", audit.flowerNames || {});
  const reportPath = await writeCandidateReport(candidateDir, report);
  return {
    status: audit.status,
    rootDir,
    activeBefore,
    pointerBefore,
    candidateDir,
    candidate,
    dataVersion,
    audit,
    auditBaselinePath,
    report,
    reportPath,
    flowerNamesPath,
    sameAsActive,
  };
}

function buildCandidateReport({
  candidate,
  audit,
  activeBefore,
  auditBaselinePath,
  auditBaselineDataVersion,
  sourceCodeVersion,
}) {
  return {
    schemaVersion: 1,
    dataVersion: candidate.dataVersion,
    sourceCodeVersion: candidate.sourceCodeVersion || sourceCodeVersion || null,
    status: audit.status,
    reasons: (audit.reasons || []).map(safeText),
    activeDataVersionBefore: activeBefore.dataVersion,
    auditBaseline: {
      dataVersion: auditBaselineDataVersion || activeBefore.dataVersion,
      file: path.basename(auditBaselinePath),
    },
    flowerNamesFile: "flower-names.json",
    file: audit.file || {
      bytes: candidate.bytes ?? null,
      sha256: candidate.sha256 ?? null,
    },
    loaderAudit: audit.loaderAudit || null,
    diff: audit.diff || null,
    calledOperations: sanitizeCalls(candidate.calls),
  };
}

async function writeCandidateReport(candidateDir, value) {
  return writeCandidateJson(candidateDir, "compatibility-report.json", value);
}

async function writeCandidateJson(candidateDir, fileName, value) {
  const reportPath = path.join(candidateDir, fileName);
  const tempPath = `${reportPath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await fsp.mkdir(candidateDir, { recursive: true });
  try {
    await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fsp.rename(tempPath, reportPath);
    return reportPath;
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

function normalizeBaseUrls(values) {
  return [...new Set(values.map((value) => {
    const url = new URL(value);
    if (url.protocol !== "https:") throw syncError("GAME_DATA_DISCOVERY_FAILED", "Only HTTPS resource origins are allowed");
    return `${url.origin}/`;
  }))];
}

function assertContained(rootPath, targetPaths) {
  const root = path.resolve(rootPath);
  for (const targetPath of targetPaths) {
    const target = path.resolve(String(targetPath || ""));
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw syncError("GAME_DATA_CANDIDATE_PATH_OUTSIDE_ROOT", "Candidate path escapes its job directory");
    }
    if (fs.existsSync(target)) {
      const realRoot = fs.realpathSync(root);
      const realTarget = fs.realpathSync(target);
      const realRelative = path.relative(realRoot, realTarget);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        throw syncError("GAME_DATA_CANDIDATE_PATH_OUTSIDE_ROOT", "Candidate real path escapes its job directory");
      }
    }
  }
}

function createJobId(value) {
  if (value != null) {
    const text = String(value);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(text)) throw syncError("GAME_DATA_JOB_ID_INVALID", "Invalid candidate job id");
    return text;
  }
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function sanitizeCalls(values) {
  const allowed = new Set(["official-package", "package-resource-config", "static-config", "static-file"]);
  return [...new Set((values || []).map(String).filter((value) => allowed.has(value)))];
}

async function filesEqual(leftPath, rightPath) {
  const [left, right] = await Promise.all([fsp.readFile(leftPath), fsp.readFile(rightPath)]);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function enterPhase(options, phase, details = null) {
  if (options.failPhase === phase) throw new Error(`${phase} failed`);
  await options.onPhase?.(phase, details);
}

function safeText(value) {
  return String(value ?? "").replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 500);
}

function safeMessage(error) {
  return safeText(error?.message || error || "unknown");
}

function syncError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}
