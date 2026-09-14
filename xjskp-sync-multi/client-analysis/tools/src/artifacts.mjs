import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const ARTIFACT_ROOTS = ["generated", "generated-reports"];

export class ClientAnalysisArtifactIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClientAnalysisArtifactIntegrityError";
    this.code = "CLIENT_ANALYSIS_ARTIFACT_INTEGRITY";
  }
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosixPath(parts) {
  return parts.join("/");
}

async function collectFiles(rootDir, rootName) {
  const artifacts = [];

  async function visit(directory, relativeParts) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const entryParts = [...relativeParts, entry.name];
      if (entry.isDirectory()) {
        await visit(absolutePath, entryParts);
        continue;
      }
      if (!entry.isFile()) {
        throw new ClientAnalysisArtifactIntegrityError(`Unsupported client analysis artifact entry: ${absolutePath}`);
      }
      const content = await readFile(absolutePath);
      artifacts.push({
        path: toPosixPath([rootName, ...entryParts]),
        size: content.length,
        sha256: createHash("sha256").update(content).digest("hex")
      });
    }
  }

  await visit(rootDir, []);
  return artifacts;
}

export async function collectArtifactManifest(versionDir) {
  const artifacts = [];
  for (const rootName of ARTIFACT_ROOTS) {
    const rootDir = path.join(versionDir, rootName);
    try {
      const rootStats = await stat(rootDir);
      if (!rootStats.isDirectory()) {
        throw new ClientAnalysisArtifactIntegrityError(`Client analysis artifact root is not a directory: ${rootDir}`);
      }
      artifacts.push(...await collectFiles(rootDir, rootName));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return artifacts.sort((left, right) => compareNames(left.path, right.path));
}

export async function verifyArtifactManifest(versionDir, manifest) {
  if (!Array.isArray(manifest?.artifacts)) {
    throw new ClientAnalysisArtifactIntegrityError(`Client analysis manifest has no artifact list: ${versionDir}`);
  }
  const actual = await collectArtifactManifest(versionDir);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.artifacts)) {
    throw new ClientAnalysisArtifactIntegrityError(`Client analysis artifact list does not match disk: ${versionDir}`);
  }
  return actual;
}
