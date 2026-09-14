import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectArtifactManifest, verifyArtifactManifest } from "./artifacts.mjs";

export class ClientAnalysisVersionConflictError extends Error {
  constructor({ appVersion, expectedSha256, actualSha256 }) {
    super(`Client analysis version ${appVersion} already has a different source SHA256`);
    this.name = "ClientAnalysisVersionConflictError";
    this.code = "CLIENT_ANALYSIS_VERSION_CONFLICT";
    this.appVersion = appVersion;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function createTempPath(parentDir, label) {
  return path.join(parentDir, `.${label}.tmp-${process.pid}-${randomUUID()}`);
}

async function requireGeneratedDirectory(tempDir) {
  const generatedPath = path.join(tempDir, "generated");
  const generatedStats = await stat(generatedPath);
  if (!generatedStats.isDirectory()) {
    throw new Error(`Client analysis build did not create generated directory: ${generatedPath}`);
  }
}

async function fingerprintTree(rootDir, excludedRootNames = new Set()) {
  const fingerprint = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (relativeDirectory === "" && excludedRootNames.has(entry.name)) continue;
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        fingerprint.push(`directory:${relativePath}`);
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Client analysis fallback copy contains unsupported entry: ${absolutePath}`);
      }
      const content = await readFile(absolutePath);
      const hash = createHash("sha256").update(content).digest("hex");
      fingerprint.push(`file:${relativePath}:${content.length}:${hash}`);
    }
  }
  await visit(rootDir);
  return fingerprint;
}

async function requireCompleteCopy(tempDir, versionDir) {
  const [sourceFingerprint, copiedFingerprint] = await Promise.all([
    fingerprintTree(tempDir, new Set(["manifest.json"])),
    fingerprintTree(versionDir)
  ]);
  const matches = sourceFingerprint.length === copiedFingerprint.length
    && sourceFingerprint.every((entry, index) => entry === copiedFingerprint[index]);
  if (!matches) {
    throw new Error(`Client analysis fallback copy is incomplete: expected ${sourceFingerprint.length} entries, copied ${copiedFingerprint.length}`);
  }
}

async function copyCompletedVersion({ tempDir, versionDir, manifestContent, copyPath }) {
  let versionDirCreated = false;
  try {
    await mkdir(versionDir);
    versionDirCreated = true;
    const entries = await readdir(tempDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "manifest.json") continue;
      await copyPath(path.join(tempDir, entry.name), path.join(versionDir, entry.name), {
        recursive: entry.isDirectory(),
        force: false,
        errorOnExist: true
      });
    }
    await requireGeneratedDirectory(versionDir);
    await requireCompleteCopy(tempDir, versionDir);
    await rm(tempDir, { recursive: true, force: true });
    await writeFile(path.join(versionDir, "manifest.json"), manifestContent, { flag: "wx" });
  } catch (error) {
    if (versionDirCreated) await rm(versionDir, { recursive: true, force: true });
    throw error;
  }
}

function buildLatest(input) {
  return {
    appVersion: input.appVersion,
    sourceSha256: input.sourceSha256,
    sourceSize: input.sourceSize,
    versionDir: `versions/${input.appVersion}`
  };
}

async function writeLatestTemp(analysisRoot, latest) {
  const latestTempPath = createTempPath(analysisRoot, "latest.json");
  await writeFile(latestTempPath, `${JSON.stringify(latest, null, 2)}\n`);
  return latestTempPath;
}

async function requirePublishedVersion(versionDir, expectedManifest) {
  const storedManifest = await readJsonIfExists(path.join(versionDir, "manifest.json"));
  if (!storedManifest || JSON.stringify(storedManifest) !== JSON.stringify(expectedManifest)) {
    throw new Error(`Client analysis published manifest does not match candidate: ${versionDir}`);
  }
  await verifyArtifactManifest(versionDir, storedManifest);
}

async function rebuildPublishedVersion({
  analysisRoot,
  input,
  tempDir,
  versionDir,
  manifest,
  renamePath
}) {
  const backupsRoot = path.join(analysisRoot, "backups", input.appVersion);
  const backupDir = path.join(backupsRoot, `${input.sourceSha256.slice(0, 12)}-${randomUUID()}`);
  const latestPath = path.join(analysisRoot, "latest.json");
  const latest = buildLatest(input);
  await mkdir(backupsRoot, { recursive: true });
  const latestTempPath = await writeLatestTemp(analysisRoot, latest);
  let archived = false;
  let promoted = false;

  try {
    await renamePath(versionDir, backupDir);
    archived = true;
    try {
      await renamePath(tempDir, versionDir);
      promoted = true;
      await requirePublishedVersion(versionDir, manifest);
      await renamePath(latestTempPath, latestPath);
    } catch (error) {
      if (promoted) {
        try {
          await renamePath(versionDir, tempDir);
        } catch {
          await rm(versionDir, { recursive: true, force: true });
        }
      }
      await renamePath(backupDir, versionDir);
      archived = false;
      throw error;
    }
  } finally {
    await rm(latestTempPath, { force: true });
  }

  if (!archived) {
    throw new Error(`Client analysis rebuild did not retain backup: ${backupDir}`);
  }
  return { status: "rebuilt", versionDir, backupDir, manifest, latest };
}

export async function publishClientVersion({
  analysisRoot,
  input,
  toolVersion,
  build,
  rebuildExisting = false,
  fileOps = {}
}) {
  const renamePath = fileOps.rename ?? rename;
  const copyPath = fileOps.cp ?? cp;
  const versionsRoot = path.join(analysisRoot, "versions");
  const versionDir = path.join(versionsRoot, input.appVersion);
  const manifestPath = path.join(versionDir, "manifest.json");
  const existingManifest = await readJsonIfExists(manifestPath);

  if (existingManifest) {
    if (existingManifest.sourceSha256 !== input.sourceSha256) {
      throw new ClientAnalysisVersionConflictError({
        appVersion: input.appVersion,
        expectedSha256: existingManifest.sourceSha256,
        actualSha256: input.sourceSha256
      });
    }
    if (!rebuildExisting) {
      await verifyArtifactManifest(versionDir, existingManifest);
      return {
        status: "existing",
        versionDir,
        manifest: existingManifest,
        latest: await readJsonIfExists(path.join(analysisRoot, "latest.json"))
      };
    }
  } else if (rebuildExisting) {
    throw new Error(`Client analysis rebuild target does not exist: ${versionDir}`);
  }

  await mkdir(versionsRoot, { recursive: true });
  const tempDir = createTempPath(versionsRoot, input.appVersion);
  const latestPath = path.join(analysisRoot, "latest.json");

  try {
    await mkdir(tempDir);
    const buildResult = await build({ tempDir, input });
    await requireGeneratedDirectory(tempDir);

    const buildManifest = buildResult?.manifest ?? {};
    const manifest = {
      appVersion: input.appVersion,
      sourceSha256: input.sourceSha256,
      sourceSize: input.sourceSize,
      toolVersion,
      generatedAtUtc: new Date().toISOString(),
      ...(buildManifest.performance === undefined ? {} : { performance: buildManifest.performance }),
      ...(buildManifest.discoveries === undefined ? {} : { discoveries: buildManifest.discoveries }),
      artifacts: await collectArtifactManifest(tempDir)
    };
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(path.join(tempDir, "manifest.json"), manifestContent);
    await verifyArtifactManifest(tempDir, manifest);

    if (existingManifest) {
      return await rebuildPublishedVersion({
        analysisRoot,
        input,
        tempDir,
        versionDir,
        manifest,
        renamePath
      });
    }

    try {
      await renamePath(tempDir, versionDir);
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
      await copyCompletedVersion({ tempDir, versionDir, manifestContent, copyPath });
    }
    await requirePublishedVersion(versionDir, manifest);

    const latest = buildLatest(input);
    const latestTempPath = await writeLatestTemp(analysisRoot, latest);
    await renamePath(latestTempPath, latestPath);

    return { status: "published", versionDir, manifest, latest };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}
