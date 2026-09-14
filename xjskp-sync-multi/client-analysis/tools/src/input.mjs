import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export class ClientAnalysisInputError extends Error {
  constructor({ code, message, path: inputPath, cause }) {
    super(message, cause ? { cause } : undefined);
    this.name = "ClientAnalysisInputError";
    this.code = code;
    this.path = inputPath;
  }
}

async function readRequiredFile(filePath, encoding) {
  try {
    return await readFile(filePath, encoding);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ClientAnalysisInputError({
        code: "CLIENT_ANALYSIS_INPUT_MISSING",
        message: `Client analysis input is missing: ${filePath}`,
        path: filePath,
        cause: error
      });
    }
    throw error;
  }
}

export async function readClientInput({ rootDir }) {
  const versionPath = path.join(rootDir, "work", "latest-game-info.json");
  const sourcePath = path.join(rootDir, "work", "game-pkg-latest", "tar", "game.js");
  const versionText = await readRequiredFile(versionPath, "utf8");
  const versionInfo = JSON.parse(versionText);
  const appVersion = versionInfo?.data?.appVersion;

  if (typeof appVersion !== "string" || appVersion.trim().length === 0) {
    throw new ClientAnalysisInputError({
      code: "CLIENT_ANALYSIS_INPUT_INVALID",
      message: `Client analysis version is invalid: ${versionPath}`,
      path: versionPath
    });
  }

  const sourceBuffer = await readRequiredFile(sourcePath);
  if (sourceBuffer.length === 0) {
    throw new ClientAnalysisInputError({
      code: "CLIENT_ANALYSIS_INPUT_INVALID",
      message: `Client analysis source is empty: ${sourcePath}`,
      path: sourcePath
    });
  }

  return {
    appVersion,
    sourcePath,
    sourceSize: sourceBuffer.length,
    sourceSha256: createHash("sha256").update(sourceBuffer).digest("hex"),
    sourceText: sourceBuffer.toString("utf8")
  };
}
