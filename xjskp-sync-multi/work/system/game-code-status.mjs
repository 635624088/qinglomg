import fs from "node:fs/promises";
import path from "node:path";
import { readActiveGameRelease } from "../game-release-version.mjs";

export async function readGameCodeStatus(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const fileSystem = options.fs || fs;
  const localVersion = cleanVersion(options.localVersion);
  const officialVersion = cleanVersion(options.officialVersion);
  let analyzedVersion = null;
  const activeRelease = (options.readActiveRelease || readActiveGameRelease)({ rootDir });
  if (activeRelease?.code?.appVersion === localVersion) {
    analyzedVersion = cleanVersion(activeRelease.code.appVersion);
  }
  try {
    const value = JSON.parse(await fileSystem.readFile(
      path.join(rootDir, "client-analysis", "latest.json"),
      "utf8",
    ));
    analyzedVersion ||= cleanVersion(value?.appVersion);
  } catch {}
  return {
    localVersion,
    officialVersion,
    comparison: options.comparison || "unknown",
    analyzedVersion,
    reviewStatus: officialVersion
      ? analyzedVersion === officialVersion ? "current" : "pending-analysis"
      : "unknown",
  };
}

function cleanVersion(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= 256 && !/[\r\n]/.test(text) ? text : null;
}
