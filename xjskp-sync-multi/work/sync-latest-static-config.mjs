import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { loadAccountLevelConfig } from "./account-level-config.mjs";
import { loadCyclicNoteConfig } from "./cyclic-note-state.mjs";
import { loadCyclicStoryConfig } from "./cyclic-story-state.mjs";
import { loadExperienceSettlementConfig } from "./experience-settlement.mjs";
import { decodeConfigRows, findConfigTable } from "./flower-level-config.mjs";
import { loadFlowerLevelConfig } from "./flower-level-config.mjs";
import { loadFlowerSourceConfig } from "./flower-source-state.mjs";
import { loadFmlLandLevelConfig } from "./fml-land-state.mjs";
import { loadFreeWaterConfig } from "./free-water-state.mjs";
import { loadMainTaskConfig } from "./main-task-state.mjs";
import { loadMaterialShopConfig } from "./material-shop-state.mjs";
import {
  loadFlowerArtConfig,
  loadItemNameMap,
  loadOrderCustomerNpcConfig,
  loadOrderFlowerConfig,
} from "./order-state.mjs";
import { loadPearlConfig } from "./pearl-state.mjs";
import { fetchOfficialGameInfo } from "./official-game-info.mjs";
import { createProfileStore } from "./system/profile-store.mjs";
import { loadTeamOrderConfig } from "./team-order-state.mjs";
import { loadWaterwheelConfig } from "./waterwheel-state.mjs";

const GAME_ID = "xjskp";
const APP_ID = "2021004163668677";
const PACKAGE_NAME = "cn.hysj.zfb.minigame";
const DEFAULT_APP_VERSION = "351.0.2";
const DEFAULT_PACKAGE_ID = 520;
const MDCL = 538;
const MDGID = 163;
const SERVER_IDX = 730;
const CRYPTO_KEY = "smallaitt";
const SPLIT = "$#|#$";
const GAME_INFO_SERVICE = "com.alipay.gamecenterhome.common.facade.service.GameCenterPcGameFacade";
const WEBGW_STATION = "uprodhatchstation66500008";
const RESOURCE_CONFIG_DIR = "work";
const STATIC_CONFIG_OUT_DIR = "work";
const SYNC_EVIDENCE_PATH = "outputs/latest-static-config-sync.json";
const LATEST_PACKAGE_PATH = path.join("work", `game-pkg-${APP_ID}-latest.bin`);
const LATEST_PACKAGE_EXTRACT_DIR = path.join("work", "game-pkg-latest");
const BASE64_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const UUID_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 17, 19, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35];
const HEX = "0123456789abcdef";
const cfg = {
  ctoken: process.env.CTOKEN,
  pcUserId: process.env.PC_USER_ID,
  pcToken: process.env.PC_TOKEN,
  babiToken: process.env.BABI_TOKEN,
  openId: process.env.OPEN_ID,
  gwHost: process.env.GW_HOST || "https://hygnhmzfb.babigame.cn:443/gw",
};

let schemas = null;

export function selectSyncProfile(profiles = [], requestedId = null) {
  const complete = profiles.filter((profile) => profile?.hasCredentials === true);
  if (requestedId) {
    const selected = complete.find((profile) => profile.id === requestedId);
    if (selected) return selected;
    throw new Error(`Sync profile ${requestedId} was not found or incomplete`);
  }
  if (complete.length === 1) return complete[0];
  if (complete.length === 0) {
    throw new Error("No complete profile is available for static config sync");
  }
  throw new Error("Multiple complete profiles are available; set XJSKP_SYNC_PROFILE_ID explicitly");
}

async function hydrateConfigFromProfileStore() {
  if (cfg.ctoken && cfg.pcUserId && cfg.pcToken && cfg.babiToken && cfg.openId) return;
  const profileStore = createProfileStore();
  const selected = selectSyncProfile(
    await profileStore.listProfiles(),
    process.env.XJSKP_SYNC_PROFILE_ID || null,
  );
  const credentials = await profileStore.loadProfileEnv(selected.id);
  cfg.ctoken = credentials.CTOKEN;
  cfg.pcUserId = credentials.PC_USER_ID;
  cfg.pcToken = credentials.PC_TOKEN;
  cfg.babiToken = credentials.BABI_TOKEN;
  cfg.openId = credentials.OPEN_ID;
}

function validateConfig() {
  for (const [key, value] of Object.entries(cfg)) {
    if (key === "gwHost") continue;
    if (!value) throw new Error(`Missing env ${key}`);
  }
}

function xorAll(code, key = CRYPTO_KEY) {
  for (let i = 0; i < key.length; i += 1) code ^= key.charCodeAt(i);
  return code;
}

function xorRev(code, key = CRYPTO_KEY) {
  for (let i = key.length - 1; i >= 0; i -= 1) code ^= key.charCodeAt(i);
  return code;
}

function en(text, key = CRYPTO_KEY) {
  return JSON.stringify(Array.from(text, (ch) => xorAll(ch.charCodeAt(0), key)));
}

function de(text, key = CRYPTO_KEY) {
  return JSON.parse(text).map((n) => String.fromCharCode(xorRev(n, key))).join("");
}

function md5(text) {
  return crypto.createHash("md5").update(text).digest("hex");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safeExtractPath(rootDir, entryName) {
  const normalized = String(entryName || "").replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`Unsafe archive path: ${entryName}`);
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts.includes("..")) throw new Error(`Unsafe archive path: ${entryName}`);
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...parts);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Unsafe archive path: ${entryName}`);
  return target;
}

function findZipEndOfCentralDirectory(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("Cannot find ZIP end of central directory");
}

function readZipEntries(buffer) {
  const eocd = findZipEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralDirSize = buffer.readUInt32LE(eocd + 12);
  const centralDirOffset = buffer.readUInt32LE(eocd + 16);
  if (centralDirOffset + centralDirSize > buffer.length) throw new Error("ZIP central directory is outside package");
  const entries = [];
  let pos = centralDirOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error(`Invalid ZIP central directory header at ${pos}`);
    const method = buffer.readUInt16LE(pos + 10);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localHeaderOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.slice(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith("/")) continue;
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local header for ${name}`);
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`ZIP entry data outside package: ${name}`);
    const compressed = buffer.slice(dataStart, dataEnd);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    if (uncompressedSize !== 0xffffffff && data.length !== uncompressedSize) {
      throw new Error(`ZIP entry size mismatch for ${name}: ${data.length} != ${uncompressedSize}`);
    }
    entries.push({ name, data });
  }
  return entries;
}

function extractZipBuffer(buffer, destDir) {
  const entries = readZipEntries(buffer);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    const target = safeExtractPath(destDir, entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }
  return entries.map((entry) => entry.name);
}

function readTarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const actualEnd = end >= start && end < start + length ? end : start + length;
  return buffer.slice(start, actualEnd).toString("utf8").trim();
}

function readTarOctal(buffer, start, length) {
  const text = buffer.slice(start, start + length).toString("ascii").replace(/\0/g, "").trim();
  if (!text) return 0;
  return Number.parseInt(text, 8) || 0;
}

function extractTarBuffer(buffer, destDir) {
  const files = [];
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  for (let pos = 0; pos + 512 <= buffer.length;) {
    const header = buffer.slice(pos, pos + 512);
    if (header.every((value) => value === 0)) break;
    const name = readTarString(buffer, pos, 100);
    const prefix = readTarString(buffer, pos + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = readTarOctal(buffer, pos + 124, 12);
    const typeFlag = String.fromCharCode(buffer[pos + 156] || 0);
    const dataStart = pos + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) throw new Error(`TAR entry data outside package: ${fullName}`);
    if (fullName && typeFlag !== "5") {
      const target = safeExtractPath(destDir, fullName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer.slice(dataStart, dataEnd));
      files.push(fullName);
    } else if (fullName) {
      fs.mkdirSync(safeExtractPath(destDir, fullName), { recursive: true });
    }
    pos = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

export function readAppVersionFromManifestPath(manifestPath, fallback = null) {
  try {
    const xml = fs.readFileSync(manifestPath, "utf8");
    return xml.match(/<appVersion>\s*([^<\s]+)\s*<\/appVersion>/i)?.[1]?.trim() || fallback;
  } catch {
    return fallback;
  }
}

async function fetchBuffer(url, fetchImpl = fetch) {
  if (!url) throw new Error("Missing packageUrl");
  const rsp = await fetchImpl(url);
  const statusText = rsp?.status ? `${rsp.status} ${url}` : url;
  if (rsp && "ok" in rsp && !rsp.ok) {
    const body = typeof rsp.text === "function" ? await rsp.text() : "";
    throw new Error(`${statusText}: ${body.slice(0, 300)}`);
  }
  if (typeof rsp?.arrayBuffer !== "function") throw new Error(`Package response has no arrayBuffer(): ${url}`);
  return Buffer.from(await rsp.arrayBuffer());
}

function replaceDirectoryWithBackup(sourceDir, targetDir) {
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const backupDir = `${targetDir}.backup-${process.pid}-${Date.now()}`;
  let hasBackup = false;
  if (fs.existsSync(targetDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    fs.renameSync(targetDir, backupDir);
    hasBackup = true;
  }
  try {
    fs.renameSync(sourceDir, targetDir);
    if (hasBackup) fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (err) {
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    if (hasBackup && fs.existsSync(backupDir)) fs.renameSync(backupDir, targetDir);
    throw err;
  }
}

export async function downloadAndExtractLatestGamePackage({
  appId = APP_ID,
  packageUrl,
  packagePath = LATEST_PACKAGE_PATH,
  extractDir = LATEST_PACKAGE_EXTRACT_DIR,
  fetchImpl = fetch,
} = {}) {
  const packageBuffer = await fetchBuffer(packageUrl, fetchImpl);
  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  fs.writeFileSync(packagePath, packageBuffer);

  const tempDir = `${extractDir}.tmp-${process.pid}-${Date.now()}`;
  fs.rmSync(tempDir, { recursive: true, force: true });
  let zipEntries = [];
  let tarEntries = [];
  try {
    zipEntries = extractZipBuffer(packageBuffer, tempDir);
    const preferredTarPath = path.join(tempDir, `${appId}.tar`);
    const tarPath = fs.existsSync(preferredTarPath)
      ? preferredTarPath
      : zipEntries
        .map((entry) => path.join(tempDir, ...entry.replace(/\\/g, "/").split("/")))
        .find((file) => /\.tar$/i.test(file) && fs.existsSync(file));
    if (!tarPath) throw new Error(`Cannot find ${appId}.tar in latest game package`);
    const tarDir = path.join(tempDir, "tar");
    tarEntries = extractTarBuffer(fs.readFileSync(tarPath), tarDir);
    const gameJsPath = path.join(tarDir, "game.js");
    if (!fs.existsSync(gameJsPath)) throw new Error("Cannot find tar/game.js in latest game package");
    replaceDirectoryWithBackup(tempDir, extractDir);
    const finalManifestPath = path.join(extractDir, "Manifest.xml");
    const finalGameJsPath = path.join(extractDir, "tar", "game.js");
    return {
      packageUrl,
      packagePath,
      packageBytes: packageBuffer.length,
      packageSha256: sha256(packageBuffer),
      extractDir,
      zipEntryCount: zipEntries.length,
      tarEntryCount: tarEntries.length,
      manifestPath: finalManifestPath,
      manifestAppVersion: readAppVersionFromManifestPath(finalManifestPath),
      gameJsPath: finalGameJsPath,
      gameJsSha256: sha256(fs.readFileSync(finalGameJsPath)),
    };
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

function expectedInterfaceAudit(src) {
  const interfaces = [
    "gs.usrLand.refresh",
    "gs.usrLand.plant",
    "gs.usrLand.plantBatch",
    "gs.usrLand.water",
    "gs.usrLand.waterBatch",
    "gs.waterwheel.enter",
    "gs.waterwheel.recv",
    "gs.freeWater.recv",
  ];
  return Object.fromEntries(interfaces.map((iface) => [iface, src.includes(iface)]));
}

const AUTOMATION_SCAN_EXCLUDED_DIRECTORIES = new Set([
  "game-pkg",
  "game-pkg-latest",
  "node_modules",
  "outputs",
  "runtime",
]);

const AUTOMATION_INTERFACE_LITERAL_PATTERN = /(["'`])(gs\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\1/g;

export function collectAutomationInterfaceReferences({ sourceDir = "work" } = {}) {
  const interfaces = new Set();

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!AUTOMATION_SCAN_EXCLUDED_DIRECTORIES.has(entry.name)) {
          visit(path.join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || !/\.(?:mjs|js)$/i.test(entry.name)) continue;
      if (/\.test\.(?:mjs|js)$/i.test(entry.name)) continue;
      if (entry.name === "sync-latest-static-config.mjs") continue;
      const source = fs.readFileSync(path.join(directory, entry.name), "utf8");
      for (const match of source.matchAll(AUTOMATION_INTERFACE_LITERAL_PATTERN)) {
        interfaces.add(match[2]);
      }
    }
  }

  visit(sourceDir);
  return [...interfaces].sort();
}

export function compareAutomationInterfaceCompatibility({
  interfaces = [],
  baselineGameJsSource = "",
  latestGameJsSource = "",
} = {}) {
  const result = {
    referencedCount: interfaces.length,
    preservedInLatest: [],
    removedFromLatest: [],
    addedInLatest: [],
    unverified: [],
  };
  for (const iface of interfaces) {
    const inBaseline = baselineGameJsSource.includes(iface);
    const inLatest = latestGameJsSource.includes(iface);
    if (inBaseline && inLatest) result.preservedInLatest.push(iface);
    else if (inBaseline) result.removedFromLatest.push(iface);
    else if (inLatest) result.addedInLatest.push(iface);
    else result.unverified.push(iface);
  }
  return {
    ...result,
    compatible: result.removedFromLatest.length === 0,
  };
}

function mapHasRows(value, key) {
  return value?.[key] instanceof Map && value[key].size > 0;
}

function objectHasRows(value, key) {
  return value?.[key] && typeof value[key] === "object" && Object.keys(value[key]).length > 0;
}

const DEFAULT_BUSINESS_CONFIG_LOADERS = Object.freeze([
  {
    name: "accountLevel",
    load: loadAccountLevelConfig,
    validate: (value) => mapHasRows(value, "levels") ? [] : ["account-level-table-empty"],
  },
  {
    name: "flowerLevel",
    load: loadFlowerLevelConfig,
    validate: (value) => mapHasRows(value, "flowerLvlById") && mapHasRows(value, "flowerLvlCfgByLvl")
      ? [] : ["flower-level-tables-empty"],
  },
  {
    name: "flowerSource",
    load: loadFlowerSourceConfig,
    validate: (value) => mapHasRows(value, "flowerById") && mapHasRows(value, "itemById")
      ? [] : ["flower-source-tables-empty"],
  },
  { name: "experienceSettlement", load: loadExperienceSettlementConfig },
  {
    name: "freeWater",
    load: loadFreeWaterConfig,
    validate: (value) => Array.isArray(value?.timePeriods) && value.timePeriods.length > 0 && Number(value?.itemId) > 0
      ? [] : ["free-water-contract-invalid"],
  },
  {
    name: "waterwheel",
    load: loadWaterwheelConfig,
    validate: (value) => Number(value?.bucketGetMax) > 0 && Number(value?.bucketWaterMax) >= Number(value?.bucketWaterMin)
      ? [] : ["waterwheel-contract-invalid"],
  },
  {
    name: "familyLand",
    load: loadFmlLandLevelConfig,
    validate: (value) => mapHasRows(value, "fmlLandLvlById") ? [] : ["family-land-levels-empty"],
  },
  {
    name: "pearl",
    load: loadPearlConfig,
    validate: (value) => Number(value?.pearlItemId) > 0 && objectHasRows(value, "places")
      ? [] : ["pearl-contract-invalid"],
  },
  {
    name: "materialShop",
    load: loadMaterialShopConfig,
    validate: (value) => Array.isArray(value?.rows) && value.rows.length > 0 && Number(value?.autoRefreshSeconds) > 0
      ? [] : ["material-shop-contract-invalid"],
  },
  {
    name: "mainTask",
    load: loadMainTaskConfig,
    validate: (value) => mapHasRows(value, "tasks") ? [] : ["main-task-table-empty"],
  },
  {
    name: "cyclicNote",
    load: loadCyclicNoteConfig,
    validate: (value) => mapHasRows(value, "actCyclicNote") && mapHasRows(value, "taskType")
      ? [] : ["cyclic-note-tables-empty"],
  },
  {
    name: "cyclicStory",
    load: loadCyclicStoryConfig,
    validate: (value) => mapHasRows(value, "orders")
      && Number(value?.globals?.expOrderMax) > 0
      && Number(value?.globals?.expValue) >= 0
      && mapHasRows(value, "flowers")
      && objectHasRows(value, "itemNames")
      ? [] : ["cyclic-story-contract-invalid"],
  },
  {
    name: "flowerArt",
    load: loadFlowerArtConfig,
    validate: (value) => objectHasRows(value, "arts") ? [] : ["flower-art-table-empty"],
  },
  {
    name: "itemNames",
    load: loadItemNameMap,
    validate: (value) => value && Object.keys(value).length > 0 ? [] : ["item-name-table-empty"],
  },
  {
    name: "residentOrderNpc",
    load: loadOrderCustomerNpcConfig,
    validate: (value) => Array.isArray(value?.npcIds)
      && value.npcIds.length > 0
      && (value.npcMaxDay == null || (Number.isInteger(value.npcMaxDay) && value.npcMaxDay > 0))
      ? [] : ["resident-order-npc-table-empty"],
  },
  {
    name: "residentOrder",
    load: loadOrderFlowerConfig,
    validate: (value) => Number(value?.orderMax) > 0 && Number(value?.dailyMax) > 0
      ? [] : ["resident-order-contract-invalid"],
  },
  {
    name: "teamOrder",
    load: loadTeamOrderConfig,
    validate: (value) => mapHasRows(value, "orders") && Number(value?.maxOrderNum) > 0 && Array.isArray(value?.rewardBase)
      ? [] : ["team-order-contract-invalid"],
  },
]);

export function auditBusinessConfigLoaders(configPath, loaders = DEFAULT_BUSINESS_CONFIG_LOADERS) {
  const results = loaders.map(({ name, load, validate }) => {
    try {
      const loaded = load(configPath);
      const reasons = [
        ...(loaded?.compatible === false
          ? (Array.isArray(loaded.reasons) && loaded.reasons.length > 0
            ? loaded.reasons.map(String)
            : ["loader-reported-incompatible"])
          : []),
        ...(typeof validate === "function" ? (validate(loaded) || []).map(String) : []),
      ];
      return { name, compatible: reasons.length === 0, reasons };
    } catch (error) {
      return {
        name,
        compatible: false,
        reasons: [error?.message || String(error)],
      };
    }
  });
  return {
    compatible: results.every((result) => result.compatible),
    loaderCount: results.length,
    results,
  };
}

export function assertSyncCompatibility({ automationInterfaces, businessConfig } = {}) {
  const problems = [];
  if (automationInterfaces?.compatible !== true) {
    const removed = automationInterfaces?.removedFromLatest || [];
    problems.push(`removed interfaces: ${removed.join(", ") || "unknown"}`);
  }
  if (businessConfig?.compatible !== true) {
    const failed = (businessConfig?.results || [])
      .filter((result) => !result.compatible)
      .map((result) => `${result.name} (${(result.reasons || []).join(", ")})`);
    problems.push(`business config: ${failed.join("; ") || "unknown"}`);
  }
  if (problems.length === 0) return;
  const error = new Error(`Game version compatibility check failed: ${problems.join(" | ")}`);
  error.code = "SYNC_COMPATIBILITY_FAILED";
  throw error;
}

function buildStaticConfigAudit(configPath) {
  const audit = {
    configPath,
    waterDropItemId: 7,
    tables: {},
  };
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const waterwheelTable = findConfigTable(config, "c_waterwheel");
    const waterwheelRows = waterwheelTable ? decodeConfigRows(waterwheelTable, "c_waterwheel") : [];
    const waterwheel = waterwheelRows[0] || {};
    audit.tables.c_waterwheel = {
      present: Boolean(waterwheelTable),
      rowCount: waterwheelRows.length,
      hasBucketGetMax: waterwheel.$bucketGetMax != null,
      bucketGetMax: waterwheel.$bucketGetMax ?? null,
      hasBucketWaterNum: Array.isArray(waterwheel.$bucketWaterNum),
      bucketWaterNumRangeCount: Array.isArray(waterwheel.$bucketWaterNum) ? waterwheel.$bucketWaterNum.length : 0,
      hasBucketAdvRate: waterwheel.$bucketAdvRate != null,
    };

    const gameCfgTable = findConfigTable(config, "c_gameCfg");
    const gameCfgRows = gameCfgTable ? decodeConfigRows(gameCfgTable, "c_gameCfg") : [];
    const gameCfg = gameCfgRows[0] || {};
    audit.tables.c_gameCfg = {
      present: Boolean(gameCfgTable),
      rowCount: gameCfgRows.length,
      hasInitWaterMax: gameCfg.$initWaterMax != null,
      initWaterMax: gameCfg.$initWaterMax ?? null,
      hasPlantWaterCost: gameCfg.$plantWaterCost != null,
      plantWaterCost: gameCfg.$plantWaterCost ?? null,
      hasFreeWaterNum: Array.isArray(gameCfg.$freeWaterNum),
      freeWaterNum: gameCfg.$freeWaterNum ?? null,
      hasFreeWaterTime: Array.isArray(gameCfg.$freeWaterTime),
      freeWaterSlotCount: Array.isArray(gameCfg.$freeWaterTime) ? gameCfg.$freeWaterTime.length : 0,
    };
  } catch (err) {
    audit.error = err.message;
  }
  return audit;
}

const STATIC_TABLE_COUNT_NAMES = ["c_flower", "c_flowerArt", "c_flowerVase", "c_item"];

export function summarizeStaticConfigTables(config, tableNames = STATIC_TABLE_COUNT_NAMES) {
  const out = {};
  for (const tableName of tableNames) {
    const table = findConfigTable(config, tableName);
    const rows = table ? decodeConfigRows(table, tableName) : [];
    out[tableName] = {
      present: Boolean(table),
      rowCount: rows.length,
      effectiveRowCount: rows.filter((row) => {
        const id = Number(row?.id);
        return !Number.isFinite(id) || id >= 0;
      }).length,
    };
  }
  return out;
}

function summarizeStaticConfigTableFile(configPath) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return summarizeStaticConfigTables(config);
  } catch (err) {
    return { error: err.message };
  }
}

export function diffStaticConfigTableCounts(previous, current) {
  if (!previous || previous.error || !current || current.error) return null;
  const out = {};
  for (const tableName of new Set([...Object.keys(previous), ...Object.keys(current)])) {
    const before = previous[tableName] || {};
    const after = current[tableName] || {};
    out[tableName] = {
      rowCountDelta: (after.rowCount ?? 0) - (before.rowCount ?? 0),
      effectiveRowCountDelta: (after.effectiveRowCount ?? 0) - (before.effectiveRowCount ?? 0),
    };
  }
  return out;
}

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function buildGameInterfaceAudit({ gameJsPath, staticConfigPath }) {
  const src = fs.readFileSync(gameJsPath, "utf8");
  const expectedInterfaces = expectedInterfaceAudit(src);
  return {
    gameJsPath,
    gameJsSha256: sha256(Buffer.from(src, "utf8")),
    expectedInterfaces,
    allExpectedInterfacesPresent: Object.values(expectedInterfaces).every(Boolean),
    staticConfig: buildStaticConfigAudit(staticConfigPath),
    syncAssumptions: {
      waterDropItemId: 7,
      waterwheelStateFields: ["advList", "count"],
      freeWaterStateFields: ["recvIdx", "rTime"],
      videoBucketPolicy: "do-not-call-gs.waterwheel.skip; keep video buckets unclaimed",
    },
  };
}

function gameParam(iface, arg, token = null) {
  const action = iface.slice(iface.indexOf(".") + 1);
  const a = en(JSON.stringify([action, arg || {}, token]));
  return { sign: md5(a + CRYPTO_KEY), a };
}

function findExistingFile(candidates) {
  return candidates.find((file) => fs.existsSync(file));
}

function readPackageAppVersionFromManifest(fallback = DEFAULT_APP_VERSION) {
  const manifestPath = findExistingFile([
    "work/game-pkg-latest/Manifest.xml",
    "work/game-pkg/Manifest.xml",
  ]);
  if (!manifestPath) return fallback;
  try {
    const xml = fs.readFileSync(manifestPath, "utf8");
    return xml.match(/<appVersion>\s*([^<\s]+)\s*<\/appVersion>/i)?.[1]?.trim() || fallback;
  } catch {
    return fallback;
  }
}

function getLoginPackageInfo(up = {}) {
  const manifestAppVersion = readPackageAppVersionFromManifest(null);
  const appVersion = manifestAppVersion || up?.appVersion || DEFAULT_APP_VERSION;
  return {
    appVersion,
    appVersionSource: manifestAppVersion ? "local-manifest" : up?.appVersion ? "pack-userParams" : "default",
    manifestAppVersion,
    packageId: Number(up?.packageId || DEFAULT_PACKAGE_ID),
    zoneCode: up?.zoneCode || "my",
  };
}

function getGameJsPath() {
  const gameJsPath = findExistingFile([
    "work/game-pkg-latest/tar/game.js",
    "work/game-pkg/tar/game.js",
  ]);
  if (!gameJsPath) throw new Error("Cannot find latest game.js under work/game-pkg-latest or work/game-pkg");
  return gameJsPath;
}

function extractSchemas() {
  const src = fs.readFileSync(getGameJsPath(), "utf8");
  const out = {};
  let pos = 0;
  const needle = 'mo.DS.setSingle("';
  while ((pos = src.indexOf(needle, pos)) >= 0) {
    const nameStart = pos + needle.length;
    const nameEnd = src.indexOf('"', nameStart);
    const name = src.slice(nameStart, nameEnd);
    const objStart = src.indexOf("{", nameEnd);
    if (objStart < 0) {
      pos = nameEnd + 1;
      continue;
    }
    let depth = 0;
    let quote = null;
    let escaped = false;
    let objEnd = -1;
    for (let i = objStart; i < src.length; i += 1) {
      const ch = src[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          objEnd = i;
          break;
        }
      }
    }
    if (objEnd > objStart) {
      const literal = src.slice(objStart, objEnd + 1);
      try {
        out[name] = Function(`"use strict"; return (${literal});`)();
      } catch {
        // Ignore schema literals that are not standalone.
      }
    }
    pos = objEnd > 0 ? objEnd + 1 : nameEnd + 1;
  }
  return out;
}

function getSchemas() {
  if (!schemas) schemas = extractSchemas();
  return schemas;
}

function resolveType(type, ns = "G") {
  if (!type || ["number", "string", "boolean", "any"].includes(type)) return type;
  if (type === "Date" || type === "INumMap") return type;
  if (type.startsWith("{") && type.endsWith("}")) return type;
  if (type.endsWith("[]")) return `${resolveType(type.slice(0, -2), ns)}[]`;
  if (type.includes(".")) return type;
  return `${ns}.${type}`;
}

function parseField(spec, ns = "G") {
  if (typeof spec === "number") return { miniKey: String(spec), type: null };
  if (typeof spec !== "string") return { miniKey: String(spec), type: null };
  const idx = spec.indexOf(":");
  if (idx < 0) return { miniKey: spec, type: null };
  return { miniKey: spec.slice(0, idx), type: resolveType(spec.slice(idx + 1).trim(), ns) };
}

function decodeValue(value, type, ns = "G") {
  if (value == null || !type) return value;
  if (type === "Date") return typeof value === "number" ? new Date(value).toISOString() : value;
  if (type === "INumMap") return value;
  if (type.endsWith("[]")) {
    const inner = type.slice(0, -2);
    return Array.isArray(value) ? value.map((item) => decodeValue(item, inner, ns)) : value;
  }
  const mapMatch = type.match(/^\{\[[^\]]+\]:(.+)\}$/);
  if (mapMatch) {
    const innerRaw = mapMatch[1].trim();
    if (innerRaw.startsWith("{")) return value;
    const inner = resolveType(innerRaw, ns);
    if (typeof value !== "object") return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeValue(v, inner, ns);
    return out;
  }
  const schema = getSchemas()[type];
  if (!schema || typeof value !== "object") return value;
  const out = {};
  const nextNs = type.includes(".") ? type.slice(0, type.lastIndexOf(".")) : ns;
  for (const [field, spec] of Object.entries(schema)) {
    const { miniKey, type: fieldType } = parseField(spec, nextNs);
    if (Object.prototype.hasOwnProperty.call(value, miniKey)) {
      out[field] = decodeValue(value[miniKey], fieldType, nextNs);
    }
  }
  return out;
}

function washResponse(raw) {
  if (!raw || typeof raw !== "object") return { value: raw, dsName: null, errMsg: null };
  let value = raw.v;
  let dsName = null;
  if (raw.d && value != null) {
    dsName = de(raw.d);
    value = decodeValue(value, dsName);
  }
  return { value, dsName, errMsg: raw.m || null, receivedMs: raw.r, rspMs: raw.t };
}

async function postJson(url, body, headers = {}) {
  const rsp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await rsp.text();
  if (!rsp.ok) throw new Error(`${rsp.status} ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function postForm(url, form, headers = {}) {
  const rsp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form),
  });
  const text = await rsp.text();
  if (!rsp.ok) throw new Error(`${rsp.status} ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function webgw(service, action, station, body) {
  return postJson(
    `https://webgwmobiler.alipay.com/gamecenterhome/${service}/${action}/${station}?ctoken=${encodeURIComponent(cfg.ctoken)}`,
    body,
    {
      "x-game-token-pcweb": cfg.pcToken,
      "x-game-uid-pcweb": cfg.pcUserId,
      "x-webgw-appId": "180020010001270314",
      "x-webgw-version": "2.0",
      origin: "https://www.wanyiwan.top",
      referer: "https://www.wanyiwan.top/game/xjskp",
    },
  );
}

async function gwRequest(iface, arg, token = null) {
  const rsp = await fetch(cfg.gwHost, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(gameParam(iface, arg, token)),
  });
  const text = await rsp.text();
  if (!rsp.ok) throw new Error(`${rsp.status} GW: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

class GameWs {
  constructor(url) {
    this.url = url;
    this.seq = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener("message", (event) => {
      this.onMessage(event.data).catch((err) => console.error(JSON.stringify({ step: "wsMessage", warn: err.message })));
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WS connect timeout ${this.url}`)), 15000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`WS error ${this.url}: ${event.message || "unknown"}`));
      }, { once: true });
    });
  }

  async onMessage(data) {
    let text;
    if (typeof data === "string") text = data;
    else if (data instanceof Blob) text = await data.text();
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
    else text = Buffer.from(data).toString("utf8");
    const chunks = text.startsWith(SPLIT) ? text.slice(SPLIT.length).split(SPLIT) : text.split(SPLIT);
    for (const chunk of chunks) {
      if (!chunk) continue;
      let msg;
      try {
        msg = JSON.parse(chunk);
      } catch {
        continue;
      }
      if (msg.e === "response" && msg.d && this.pending.has(msg.d.k)) {
        const { resolve } = this.pending.get(msg.d.k);
        this.pending.delete(msg.d.k);
        resolve(msg.d);
      }
    }
  }

  request(iface, arg, token = null) {
    const k = String(this.seq++);
    const d = {
      r: iface.slice(0, iface.indexOf(".")),
      p: gameParam(iface, arg, token),
      k,
    };
    this.ws.send(SPLIT + JSON.stringify({ e: "request", d }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(k);
        reject(new Error(`WS request timeout ${iface}`));
      }, 20000);
      this.pending.set(k, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  }

  close() {
    this.ws?.close();
  }
}

export function parseResourceVersionToken(value) {
  if (value == null || value === "") return null;
  const text = String(value);
  const base = /[a-f]/i.test(text) ? 16 : 10;
  const parsed = Number.parseInt(text, base);
  return Number.isFinite(parsed) ? parsed : null;
}

export function decodeCocosUuid(value) {
  const text = String(value ?? "");
  if (text.length !== 22) return text;
  const base64Value = {};
  for (let i = 0; i < BASE64_KEYS.length; i += 1) base64Value[BASE64_KEYS[i]] = i;
  const out = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".split("");
  out[0] = text[0];
  out[1] = text[1];
  let j = 2;
  for (let i = 2; i < text.length; i += 2) {
    const lhs = base64Value[text[i]];
    const rhs = base64Value[text[i + 1]];
    if (lhs == null || rhs == null) return text;
    out[UUID_INDICES[j++]] = HEX[lhs >> 2];
    out[UUID_INDICES[j++]] = HEX[((lhs & 3) << 2) | (rhs >> 4)];
    out[UUID_INDICES[j++]] = HEX[rhs & 15];
  }
  return out.join("");
}

function findVersion(versions, id) {
  if (!Array.isArray(versions)) return null;
  const idx = versions.findIndex((value) => Number(value) === Number(id));
  return idx >= 0 ? versions[idx + 1] : null;
}

export function resolveStaticConfigResource(resourceConfig, sourcePath = null) {
  for (const [idText, entry] of Object.entries(resourceConfig.paths || {})) {
    const resourcePath = Array.isArray(entry) ? entry[0] : entry;
    if (resourcePath !== "mo/zh/data/g-data") continue;
    const id = Number(idText);
    const compressedUuid = resourceConfig.uuids?.[id];
    const uuid = decodeCocosUuid(compressedUuid);
    const version = findVersion(resourceConfig.versions?.native, id);
    if (!uuid || !version) throw new Error(`Cannot resolve native path for ${sourcePath || "resource config"}`);
    const nativePath = `assets/resources/${resourceConfig.nativeBase || "native"}/${uuid.slice(0, 2)}/${uuid}.${version}.text`;
    return {
      id,
      resourcePath,
      compressedUuid,
      uuid,
      version: String(version),
      versionSort: parseResourceVersionToken(version),
      nativePath,
      sourcePath,
    };
  }
  throw new Error(`Cannot find mo/zh/data/g-data in ${sourcePath || "resource config"}`);
}

function readLocalResourceConfigCandidates(dir = RESOURCE_CONFIG_DIR) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^resources-config-[0-9a-f]+\.json$/i.test(name)) continue;
    const file = path.join(dir, name);
    const resourceConfig = JSON.parse(fs.readFileSync(file, "utf8"));
    out.push(resolveStaticConfigResource(resourceConfig, file));
  }
  return out.sort((a, b) => (b.versionSort ?? -1) - (a.versionSort ?? -1));
}

function collectStringValues(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStringValues(item, out);
  }
  return out;
}

export function resolvePackageResourceConfigModule(modulesConfig, sourcePath = null) {
  for (const value of collectStringValues(modulesConfig)) {
    const normalized = value.replace(/\\/g, "/");
    const match = normalized.match(/(^|\/)(assets\/resources\/index\.([0-9a-f]+)\.js)(?:[?#].*)?$/i);
    if (!match) continue;
    const resourceBundleIndexPath = match[2];
    const resourceConfigVersionToken = match[3];
    return {
      sourcePath,
      resourceBundleIndexPath,
      resourceConfigPath: resourceBundleIndexPath.replace(
        /index\.[0-9a-f]+\.js$/i,
        `config.${resourceConfigVersionToken}.json`,
      ),
      resourceConfigVersionToken,
    };
  }
  throw new Error(`Cannot find assets/resources/index.<hash>.js in ${sourcePath || "modules config"}`);
}

async function downloadFirstText(urls, fetchImpl = fetch, label = "static config") {
  const errors = [];
  for (const url of urls) {
    try {
      const rsp = await fetchImpl(url);
      const text = await rsp.text();
      if (!rsp.ok) {
        errors.push(`${rsp.status} ${url}`);
        continue;
      }
      return { url, text };
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  throw new Error(`Unable to download ${label}: ${errors.join("; ")}`);
}

export async function downloadStaticConfigResource({
  resource,
  baseUrls = [],
  outputPath,
  fetchImpl = fetch,
} = {}) {
  if (!resource?.nativePath || !/^[0-9a-f]+$/i.test(String(resource?.version || ""))) {
    throw new Error("Static config resource descriptor is invalid");
  }
  if (!outputPath) throw new Error("Static config output path is required");
  const urls = baseUrls.map((base) => new URL(resource.nativePath, base).href);
  if (!urls.length) throw new Error("No base URLs available for static config");
  const downloaded = await downloadFirstText(urls, fetchImpl, "static config");
  const buffer = Buffer.from(downloaded.text, "utf8");
  if (buffer.length === 0) throw new Error("Downloaded static config is empty");
  JSON.parse(downloaded.text);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return {
    configPath: outputPath,
    bytes: buffer.length,
    sha256: sha256(buffer),
    downloadUrl: downloaded.url,
  };
}

export async function downloadPackageResourceConfigFromModules({
  modulesPath = path.join(LATEST_PACKAGE_EXTRACT_DIR, "tar", "modules.json"),
  baseUrls = [],
  outDir = RESOURCE_CONFIG_DIR,
  fetchImpl = fetch,
} = {}) {
  const modulesConfig = JSON.parse(fs.readFileSync(modulesPath, "utf8"));
  const descriptor = resolvePackageResourceConfigModule(modulesConfig, modulesPath);
  const urls = baseUrls.map((base) => new URL(descriptor.resourceConfigPath, base).href);
  if (!urls.length) throw new Error("No base URLs available for package resources config");
  const downloaded = await downloadFirstText(urls, fetchImpl, "package resources config");
  const bytes = Buffer.byteLength(downloaded.text, "utf8");
  const resourceConfigSha256 = sha256(Buffer.from(downloaded.text, "utf8"));
  const resourceConfigFile = path.join(outDir, `resources-config-${descriptor.resourceConfigVersionToken}.json`);
  const resourceConfig = JSON.parse(downloaded.text);
  const resource = resolveStaticConfigResource(resourceConfig, resourceConfigFile);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(resourceConfigFile, downloaded.text, "utf8");
  return {
    resourceConfigSource: "package-modules",
    modulesPath,
    resourceBundleIndexPath: descriptor.resourceBundleIndexPath,
    resourceConfigRelativePath: descriptor.resourceConfigPath,
    resourceConfigVersionToken: descriptor.resourceConfigVersionToken,
    resourceConfigUrl: downloaded.url,
    resourceConfigPath: resourceConfigFile,
    resourceConfigBytes: bytes,
    resourceConfigSha256,
    resource,
  };
}

function baseUrlCandidates(packUserParams = {}) {
  const candidates = [];
  const push = (value) => {
    if (!value) return;
    try {
      const url = new URL(value);
      candidates.push(`${url.origin}/`);
    } catch {
      if (/^https?:\/\//i.test(value)) candidates.push(value.endsWith("/") ? value : `${value}/`);
    }
  };
  push(packUserParams.gameUrl);
  candidates.push("https://hygncdn.babigame.cn/");
  candidates.push("https://hyhmcl.babigame.cn/");
  return [...new Set(candidates)];
}

function buildOpenData() {
  return JSON.stringify({
    query: {
      gameId: GAME_ID,
      chInfo: "pc_default",
      mBizScenario: "",
      mPageState: "",
      fullURL: "https://www.wanyiwan.top/game/xjskp",
      ref: "https://www.wanyiwan.top/game/xjskp",
    },
    scene: "other",
  });
}

function buildSystemInfo() {
  return JSON.stringify({
    model: "Windows PC",
    brand: "",
    platform: "windows",
    system: "Windows 10",
    screenHeight: 1280,
    screenWidth: 2048,
    language: "zh-CN",
  });
}

async function getReadOnlySessionEvidence(openData, systemInfo, latestAppVersion) {
  const auth = await webgw(GAME_INFO_SERVICE, "queryPcGameAuthInfo", WEBGW_STATION, { appId: APP_ID });
  const authCode = auth?.data?.authCode;
  if (!authCode) throw new Error(`No authCode: ${JSON.stringify(auth).slice(0, 300)}`);

  const pack = await postJson(`https://apizfbfast.babigame.cn/pack/init/packageName/${PACKAGE_NAME}`, {
    open_data: openData,
    system_info: systemInfo,
    version: "2.2.209",
    userParams: 1,
  });
  const packData = pack.data || pack;
  const up = typeof packData.userParams === "string" ? JSON.parse(packData.userParams) : packData.userParams || {};
  if (!up.appVersion && latestAppVersion) up.appVersion = latestAppVersion;
  const loginPackageInfo = getLoginPackageInfo(up);

  const yxt = await postForm("https://h5sdk.hnycgames.cn/Channel/login/yxtGame/wdhysj/yxtChannel/myxyx/yxtSubChannel/myxyx", {
    authCode,
    scene: "other",
  });
  if (yxt.errorCode !== 0) throw new Error(`YXT login failed: ${JSON.stringify(yxt).slice(0, 300)}`);
  const yd = yxt.data;

  const gameLogin = await postJson(`https://apizfbfast.babigame.cn/game/login/mdcl/c${MDCL}/mdgid/${MDGID}/env/prod`, {
    open_data: openData,
    system_info: systemInfo,
    yxtGame: yd.yxtGame,
    yxtChannel: yd.yxtChannel,
    yxtUserId: yd.yxtUserId,
    yxtLoginTime: yd.yxtLoginTime,
    yxtSign: yd.yxtSign,
    yxtChannelUserId: yd.yxtChannelUserId,
  });
  const content = gameLogin?.data?.content;
  if (!content) throw new Error(`No game login content: ${JSON.stringify(gameLogin).slice(0, 300)}`);

  const now = Date.now();
  const gwLoginRaw = await gwRequest("gw.index.login", {
    sdkId: 10000,
    chnId: MDCL,
    params: {
      token: cfg.babiToken,
      open_id: cfg.openId,
      content,
      zoneCode: loginPackageInfo.zoneCode,
      appVersion: loginPackageInfo.appVersion,
      packageId: loginPackageInfo.packageId,
      $ms: now,
    },
    msBeforeLogin: now - 1000,
    msAfterLogin: now,
    osType: 0,
    deviceId: "pc-web",
    isSimulator: 0,
  });
  const gwLogin = washResponse(gwLoginRaw).value;
  const gwToken = gwLogin?.$other?.token;
  if (!gwToken) throw new Error(`No GW token: ${JSON.stringify(gwLoginRaw).slice(0, 500)}`);

  const gsListRaw = await gwRequest("gw.index.getGsInfoList", { aid: gwLogin.acc.id, idx: SERVER_IDX, chnId: MDCL }, gwToken);
  const gsSync = washResponse(gsListRaw).value;
  const gsInfo = (gsSync?.$gsTot?.gsInfoList || [])
    .map((item) => ({ ...item, idx: item.idx || SERVER_IDX }))
    .find((item) => item.idx === SERVER_IDX);
  if (!gsInfo) throw new Error(`No GS info for ${SERVER_IDX}: ${JSON.stringify(gsSync?.$gsTot || {}).slice(0, 1000)}`);

  const ws = new GameWs(`wss://${gsInfo.host}:${gsInfo.port_ssl}`);
  await ws.connect();
  try {
    const gsLoginArg = {
      aid: gwLogin.acc.id,
      gsIdx: SERVER_IDX,
      token: gwToken,
      osType: 0,
      isNative: false,
      deviceId: "pc-web",
      isSimulator: 0,
      deviceInfo: {
        osType: "Windows",
        deviceId: "pc-web",
        isEmulator: 0,
        osVersion: "Windows 10",
        brand: "",
        model: "Windows PC",
        networkType: "4g",
        sysLanguage: "zh-CN",
        screenWidthPx: 2048,
        screenHeightPx: 1280,
        deviceType: "PC",
        appVersion: loginPackageInfo.appVersion,
      },
    };
    const gsLoginRaw = await ws.request("gs.index.login", gsLoginArg, null);
    const gsLoginRsp = washResponse(gsLoginRaw);
    if (gsLoginRsp.errMsg) throw new Error(`GS login err: ${JSON.stringify(gsLoginRsp.errMsg)}`);
    const gsToken = gsLoginRsp.value?.$other?.token || gsLoginArg.token;

    const lazyRaw = await ws.request("gs.usr.lazySync", {}, gsToken);
    const lazyRsp = washResponse(lazyRaw);
    if (lazyRsp.errMsg) throw new Error(`lazySync err: ${JSON.stringify(lazyRsp.errMsg)}`);

    return {
      packStatus: pack.status || packData.status || "ok",
      packAppVersion: up?.appVersion || null,
      packGameVersion: up?.gameVersion || null,
      packMdcver: up?.mdcver || null,
      packGameUrl: up?.gameUrl || null,
      loginAppVersion: loginPackageInfo.appVersion,
      loginAppVersionSource: loginPackageInfo.appVersionSource,
      loginManifestAppVersion: loginPackageInfo.manifestAppVersion,
      loginPackageId: loginPackageInfo.packageId,
      gwAccId: gwLogin?.acc?.id || null,
      lastGsIdx: gwLogin?.acc?.lastGsIdx || null,
      gsInfo: {
        idx: gsInfo.idx,
        host: gsInfo.host,
        port_ssl: gsInfo.port_ssl,
        status: gsInfo.status,
      },
      gsLoginDsName: gsLoginRsp.dsName,
      lazySyncDsName: lazyRsp.dsName,
      lazySyncOtherVer: lazyRsp.value?.$other?.ver || null,
      tokenLengths: {
        authCode: String(authCode).length,
        gwToken: String(gwToken).length,
        gsToken: String(gsToken).length,
      },
      packUserParams: up,
    };
  } finally {
    ws.close();
  }
}

async function main() {
  await hydrateConfigFromProfileStore();
  validateConfig();
  fs.mkdirSync("outputs", { recursive: true });
  const baselineGameJsPath = getGameJsPath();
  const baselineGameJsSource = fs.readFileSync(baselineGameJsPath, "utf8");
  const previousEvidence = readJsonIfExists(SYNC_EVIDENCE_PATH);
  const previousTableCounts = previousEvidence?.configPath
    ? summarizeStaticConfigTableFile(previousEvidence.configPath)
    : null;

  const gameInfo = await fetchOfficialGameInfo({
    credentials: {
      CTOKEN: cfg.ctoken,
      PC_USER_ID: cfg.pcUserId,
      PC_TOKEN: cfg.pcToken,
    },
  });
  fs.writeFileSync("work/latest-game-info.json", JSON.stringify(gameInfo), "utf8");
  const latestAppVersion = gameInfo?.data?.appVersion || DEFAULT_APP_VERSION;
  const packageUrl = gameInfo?.data?.pkgUrl?.pkgUrl || null;
  const latestPackage = packageUrl
    ? await downloadAndExtractLatestGamePackage({ appId: APP_ID, packageUrl })
    : null;

  const openData = buildOpenData();
  const systemInfo = buildSystemInfo();
  const session = await getReadOnlySessionEvidence(openData, systemInfo, latestAppVersion);

  const bases = baseUrlCandidates(session.packUserParams);
  const localResourceCandidates = readLocalResourceConfigCandidates();
  const packageResourceConfig = await downloadPackageResourceConfigFromModules({
    modulesPath: path.join(latestPackage?.extractDir || LATEST_PACKAGE_EXTRACT_DIR, "tar", "modules.json"),
    baseUrls: bases,
  });
  const packageResourceConfigFileName = path.basename(packageResourceConfig.resourceConfigPath).toLowerCase();
  const legacyLocalResource = localResourceCandidates.find((candidate) => (
    path.basename(candidate.sourcePath || "").toLowerCase() !== packageResourceConfigFileName
  )) || null;
  const legacyStaticConfigPath = legacyLocalResource
    ? path.join(STATIC_CONFIG_OUT_DIR, `g-data.${legacyLocalResource.version}.text`)
    : null;
  const legacyStaticConfigTableCounts = legacyStaticConfigPath && fs.existsSync(legacyStaticConfigPath)
    ? summarizeStaticConfigTableFile(legacyStaticConfigPath)
    : null;
  const resource = packageResourceConfig.resource;
  const outPath = path.join(STATIC_CONFIG_OUT_DIR, `g-data.${resource.version}.text`);
  const downloaded = await downloadStaticConfigResource({
    resource,
    baseUrls: bases,
    outputPath: outPath,
    fetchImpl: fetch,
  });
  const bytes = downloaded.bytes;
  const hash = downloaded.sha256;
  const staticConfigTableCounts = summarizeStaticConfigTableFile(outPath);
  const staticConfigTableCountDiff = diffStaticConfigTableCounts(previousTableCounts, staticConfigTableCounts);
  const legacyStaticConfigTableCountDiff = diffStaticConfigTableCounts(legacyStaticConfigTableCounts, staticConfigTableCounts);
  const localGameJsPath = latestPackage?.gameJsPath || getGameJsPath();
  const interfaceAudit = buildGameInterfaceAudit({ gameJsPath: localGameJsPath, staticConfigPath: outPath });
  const automationInterfaces = compareAutomationInterfaceCompatibility({
    interfaces: collectAutomationInterfaceReferences(),
    baselineGameJsSource,
    latestGameJsSource: fs.readFileSync(localGameJsPath, "utf8"),
  });
  const businessConfig = auditBusinessConfigLoaders(outPath);
  const compatibility = {
    compatible: automationInterfaces.compatible && businessConfig.compatible,
    automationInterfaces,
    businessConfig,
  };
  const resourceFreshnessNote = `Latest package resource config ${packageResourceConfig.resourceConfigVersionToken} resolves g-data.${resource.version}${
    previousEvidence?.resourceVersion === resource.version ? "; g-data version unchanged from previous evidence" : ""
  }`;

  const evidence = {
    generatedAt: new Date().toISOString(),
    gameId: GAME_ID,
    appId: APP_ID,
    latestAppVersion,
    packageUrl,
    packageAppVersion: latestPackage?.manifestAppVersion || readPackageAppVersionFromManifest(latestAppVersion),
    latestGamePackage: latestPackage,
    localGameJsPath,
    localGameJsSha256: interfaceAudit.gameJsSha256,
    resourceConfigSource: packageResourceConfig.resourceConfigSource,
    resourceBundleIndexPath: packageResourceConfig.resourceBundleIndexPath,
    resourceConfigRelativePath: packageResourceConfig.resourceConfigRelativePath,
    resourceConfigVersionToken: packageResourceConfig.resourceConfigVersionToken,
    resourceConfigUrl: packageResourceConfig.resourceConfigUrl,
    resourceConfigPath: packageResourceConfig.resourceConfigPath,
    resourceConfigBytes: packageResourceConfig.resourceConfigBytes,
    resourceConfigSha256: packageResourceConfig.resourceConfigSha256,
    previousLocalResourceConfigPath: localResourceCandidates[0]?.sourcePath || null,
    legacyLocalResourceConfigPath: legacyLocalResource?.sourcePath || null,
    legacyResourceVersion: legacyLocalResource?.version || null,
    legacyConfigPath: legacyStaticConfigPath,
    resourcePath: resource.resourcePath,
    resourceVersion: resource.version,
    resourceUuid: resource.uuid,
    nativePath: resource.nativePath,
    downloadUrl: downloaded.downloadUrl,
    configPath: outPath,
    bytes,
    sha256: hash,
    resourceFreshnessNote,
    staticConfigTableCounts,
    staticConfigTableCountDiff,
    legacyStaticConfigTableCounts,
    legacyStaticConfigTableCountDiff,
    readOnlySession: {
      packStatus: session.packStatus,
      packAppVersion: session.packAppVersion,
      packGameVersion: session.packGameVersion,
      packMdcver: session.packMdcver,
      packGameUrl: session.packGameUrl,
      loginAppVersion: session.loginAppVersion,
      loginAppVersionSource: session.loginAppVersionSource,
      loginManifestAppVersion: session.loginManifestAppVersion,
      loginPackageId: session.loginPackageId,
      gwAccId: session.gwAccId,
      lastGsIdx: session.lastGsIdx,
      gsInfo: session.gsInfo,
      gsLoginDsName: session.gsLoginDsName,
      lazySyncDsName: session.lazySyncDsName,
      lazySyncOtherVer: session.lazySyncOtherVer,
      tokenLengths: session.tokenLengths,
      calledInterfaces: [
        "queryPcGameInfo",
        "queryPcGameAuthInfo",
        "pack/init",
        "yxtGame login",
        "game/login",
        "gw.index.login",
        "gw.index.getGsInfoList",
        "gs.index.login",
        "gs.usr.lazySync",
      ],
    },
    interfaceAudit,
    compatibility,
  };
  fs.writeFileSync(SYNC_EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  assertSyncCompatibility(compatibility);
  console.log(JSON.stringify({
    syncedStaticConfig: true,
    latestAppVersion,
    packageAppVersion: evidence.packageAppVersion,
    packageSha256: latestPackage?.packageSha256 || null,
    gameJsSha256: evidence.localGameJsSha256,
    resourceConfigSource: evidence.resourceConfigSource,
    resourceConfigVersionToken: evidence.resourceConfigVersionToken,
    resourceVersion: resource.version,
    configPath: outPath,
    bytes,
    sha256: hash,
    automationInterfaceCount: automationInterfaces.referencedCount,
    unverifiedAutomationInterfaces: automationInterfaces.unverified,
    businessConfigLoaderCount: businessConfig.loaderCount,
    compatible: compatibility.compatible,
    evidencePath: SYNC_EVIDENCE_PATH,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(JSON.stringify({ syncedStaticConfig: false, error: err.message }));
    process.exitCode = 1;
  });
}
