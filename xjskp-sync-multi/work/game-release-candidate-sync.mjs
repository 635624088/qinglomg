import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { AUTOMATION_GAME_CONTRACT } from "./automation-game-contract.mjs";
import { auditGameCodeCompatibility } from "./game-code-compatibility.mjs";
import { commitCompatibleGameCodeBundle, readActiveGameCodeBundle } from "./game-code-version.mjs";
import { prepareGameDataCandidate } from "./game-data-candidate-sync.mjs";
import { commitCompatibleGameDataBundle, readGameDataBundle } from "./game-data-version.mjs";
import {
  readActiveGameRelease,
  readActiveGameReleasePointerSnapshot,
  restoreActiveGameReleasePointer,
  writeActiveGameReleasePointer,
} from "./game-release-version.mjs";

export async function syncGameReleaseCandidate(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const activeBefore = readActiveGameRelease({ rootDir });
  const baselineCode = activeBefore?.code || readActiveGameCodeBundle({ rootDir }) || await registerLegacyCodeBaseline(rootDir, options);
  const pointerBefore = readActiveGameReleasePointerSnapshot({ rootDir });
  const preparedData = await (options.prepareDataCandidate || prepareGameDataCandidate)({
    ...options,
    jointActiveDataBundle: activeBefore?.data || null,
  });
  const candidate = preparedData.candidate;
  const candidateGameJsPath = path.resolve(String(candidate?.gameJsPath || path.join(candidate?.packageDir || "", "tar", "game.js")));
  const codeAudit = (options.auditCodeCandidate || auditGameCodeCompatibility)({
    baselineGameJsSource: await fsp.readFile(baselineCode.gameJsPath, "utf8"),
    candidateGameJsSource: await fsp.readFile(candidateGameJsPath, "utf8"),
    interfaces: AUTOMATION_GAME_CONTRACT.interfaces.map((entry) => entry.iface),
    requiredSchemas: AUTOMATION_GAME_CONTRACT.responseSchemaRoots,
  });
  if (preparedData.status !== "compatible" || codeAudit.status !== "compatible") {
    return {
      status: preparedData.status !== "compatible" ? preparedData.status : codeAudit.status,
      codeCompatibilityStatus: codeAudit.status,
      dataCompatibilityStatus: preparedData.status,
      activeCodeVersion: activeBefore?.code.appVersion || baselineCode.appVersion,
      activeDataVersion: preparedData.activeBefore.dataVersion,
      candidateCodeVersion: candidate.sourceCodeVersion,
      candidateDataVersion: candidate.dataVersion,
      codeReasons: codeAudit.reasons,
      reportPath: preparedData.reportPath,
    };
  }
  await options.beforeActivate?.();
  await options.onPhase?.("stage", {
    codeVersion: candidate.sourceCodeVersion,
    dataVersion: candidate.dataVersion,
  });
  const codeBundle = await commitCompatibleGameCodeBundle({
    rootDir,
    packageDir: candidate.packageDir,
    appVersion: candidate.sourceCodeVersion,
    expectedGameJsSha256: sha256File(candidateGameJsPath),
    packageEvidence: candidate.package,
    compatibilityReport: { ...codeAudit, status: "compatible" },
    fileSystem: options.fileSystem,
  });
  const dataBundle = preparedData.sameAsActive
    ? readGameDataBundle({ rootDir, dataVersion: candidate.dataVersion })
    : await commitCompatibleGameDataBundle({
      rootDir,
      dataVersion: candidate.dataVersion,
      sourceCodeVersion: candidate.sourceCodeVersion,
      configPath: candidate.configPath,
      flowerNames: preparedData.audit.flowerNames,
      compatibilityReport: preparedData.report,
      fileSystem: options.fileSystem,
    });
  if (!dataBundle) throw Object.assign(new Error("Candidate data bundle is unavailable"), { code: "GAME_RELEASE_DATA_INVALID" });
  try {
    await options.onPhase?.("pointer", {
      codeVersion: candidate.sourceCodeVersion,
      dataVersion: candidate.dataVersion,
    });
    const active = await writeActiveGameReleasePointer({
      rootDir,
      codeBundleId: codeBundle.bundleId,
      dataVersion: dataBundle.dataVersion,
      // The candidate downloader just proved that this exact static file is
      // still official for the newer code. Keep the immutable data bundle's
      // original provenance, while recording the successful revalidation on
      // the joint release pointer.
      revalidatedDataForCodeVersion: preparedData.sameAsActive
        ? candidate.sourceCodeVersion
        : null,
      fileSystem: options.fileSystem,
    });
    await options.onPhase?.("verify", {
      codeVersion: candidate.sourceCodeVersion,
      dataVersion: candidate.dataVersion,
      releaseId: active.releaseId,
    });
    const verified = await options.verifyActivation?.(active);
    if (verified === false) {
      throw Object.assign(new Error("Active game release verification failed"), {
        code: "GAME_RELEASE_VERIFY_FAILED",
      });
    }
    return {
      status: "latest",
      releaseId: active.releaseId,
      activeCodeVersion: active.code.appVersion,
      previousCodeVersion: activeBefore?.code.appVersion || baselineCode.appVersion,
      activeDataVersion: active.data.dataVersion,
      previousDataVersion: preparedData.activeBefore.dataVersion,
      candidateCodeVersion: candidate.sourceCodeVersion,
      candidateDataVersion: candidate.dataVersion,
      codeCompatibilityStatus: "compatible",
      dataCompatibilityStatus: "compatible",
      loaderCount: preparedData.audit.loaderAudit?.loaderCount || 0,
      reportPath: preparedData.reportPath,
    };
  } catch (error) {
    if (pointerBefore) await restoreActiveGameReleasePointer(pointerBefore, { rootDir, fileSystem: options.fileSystem });
    throw error;
  }
}

async function registerLegacyCodeBaseline(rootDir, options) {
  const packageDir = [
    path.join(rootDir, "work", "game-pkg-latest"),
    path.join(rootDir, "work", "game-pkg"),
  ].find((candidate) => fs.existsSync(path.join(candidate, "tar", "game.js")));
  if (!packageDir) throw Object.assign(new Error("Legacy game code baseline is unavailable"), { code: "GAME_CODE_BASELINE_INVALID" });
  const manifest = await fsp.readFile(path.join(packageDir, "Manifest.xml"), "utf8");
  const appVersion = manifest.match(/<appVersion>\s*([^<\s]+)\s*<\/appVersion>/i)?.[1];
  return commitCompatibleGameCodeBundle({
    rootDir,
    packageDir,
    appVersion,
    compatibilityReport: { status: "compatible", baseline: true },
    packageEvidence: { source: "legacy-baseline" },
    fileSystem: options.fileSystem,
  });
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
