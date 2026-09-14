import fs from "node:fs";
import path from "node:path";
import { readActiveGameDataBundle } from "./game-data-version.mjs";
import { readActiveGameRelease } from "./game-release-version.mjs";

export const STATIC_CONFIG_DIR = "work";
export const STATIC_CONFIG_BASENAME = "g-data.69b61.text";

const STATIC_CONFIG_PATTERN = /^g-data\.([0-9a-f]+)\.text$/i;
const RESOURCES_MODULE_PATTERN = /assets\/resources\/index\.([0-9a-f]+)\.js$/i;
const STATIC_CONFIG_RESOURCE_PATH = "mo/zh/data/g-data";

export function parseStaticConfigVersion(filePath) {
  const match = STATIC_CONFIG_PATTERN.exec(path.basename(String(filePath ?? "")));
  if (!match) return null;
  const raw = match[1];
  const base = /[a-f]/i.test(raw) ? 16 : 10;
  const version = Number.parseInt(raw, base);
  return Number.isFinite(version) ? version : null;
}

export function findLatestStaticConfigFile(dir = STATIC_CONFIG_DIR, fsModule = fs) {
  const packageReferenced = findPackageReferencedStaticConfigFile(dir, fsModule);
  if (packageReferenced) return packageReferenced;

  let best = null;

  try {
    for (const name of fsModule.readdirSync(dir)) {
      const version = parseStaticConfigVersion(name);
      if (version == null) continue;
      if (!best || version > best.version) best = { name, version };
    }
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  return best?.name || STATIC_CONFIG_BASENAME;
}

function readJsonFile(filePath, fsModule) {
  return JSON.parse(fsModule.readFileSync(filePath, "utf8"));
}

function collectStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function findCurrentResourcesHash(dir, fsModule) {
  const modulesPath = path.join(dir, "game-pkg-latest", "tar", "modules.json");
  let modules;
  try {
    modules = readJsonFile(modulesPath, fsModule);
  } catch (err) {
    if (err?.code !== "ENOENT") return null;
    return null;
  }

  for (const entry of collectStrings(modules)) {
    const match = RESOURCES_MODULE_PATTERN.exec(entry.replaceAll("\\", "/"));
    if (match) return match[1];
  }
  return null;
}

function findResourcePathId(resourcesConfig, resourcePath) {
  for (const [id, value] of Object.entries(resourcesConfig?.paths || {})) {
    const pathValue = Array.isArray(value) ? value[0] : value;
    if (pathValue === resourcePath) return Number(id);
  }
  return null;
}

function findNativeResourceVersion(resourcesConfig, resourceId) {
  const nativeVersions = resourcesConfig?.versions?.native;
  if (!Array.isArray(nativeVersions) || resourceId == null) return null;

  for (let index = 0; index < nativeVersions.length - 1; index += 2) {
    if (Number(nativeVersions[index]) === resourceId) {
      const version = String(nativeVersions[index + 1] || "");
      return version || null;
    }
  }
  return null;
}

function findPackageReferencedStaticConfigFile(dir, fsModule) {
  const resourcesHash = findCurrentResourcesHash(dir, fsModule);
  if (!resourcesHash) return null;

  let resourcesConfig;
  try {
    resourcesConfig = readJsonFile(path.join(dir, `resources-config-${resourcesHash}.json`), fsModule);
  } catch {
    return null;
  }

  const resourceId = findResourcePathId(resourcesConfig, STATIC_CONFIG_RESOURCE_PATH);
  const version = findNativeResourceVersion(resourcesConfig, resourceId);
  if (!version) return null;

  const fileName = `g-data.${version}.text`;
  try {
    return fsModule.existsSync(path.join(dir, fileName)) ? fileName : null;
  } catch {
    return null;
  }
}

export function findLatestStaticConfigPath(options = {}) {
  const dir = options.dir || STATIC_CONFIG_DIR;
  const fsModule = options.fsModule || fs;
  const rootDir = path.resolve(options.rootDir || process.cwd());
  const shouldReadActive = options.rootDir || path.resolve(dir) === path.join(rootDir, STATIC_CONFIG_DIR);
  const release = shouldReadActive ? readActiveGameRelease({ rootDir, fsModule }) : null;
  if (release) return release.data.staticConfigPath;
  const active = shouldReadActive ? readActiveGameDataBundle({ rootDir, fsModule }) : null;
  if (active) return active.staticConfigPath;
  return path.join(dir, findLatestStaticConfigFile(dir, fsModule));
}

export function getDefaultStaticConfigPath() {
  return findLatestStaticConfigPath({ rootDir: process.cwd() });
}
