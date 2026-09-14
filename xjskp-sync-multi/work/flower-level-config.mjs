import fs from "node:fs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

const DEFAULT_STATIC_CONFIG_PATH = getDefaultStaticConfigPath();
const DEFAULT_FLOWER_CD_TIME_STEP_SECONDS = 1;
const HARVEST_INTERVAL_REDUCTION_SKILL_TYPE = 5;

let cachedPath = null;
let cachedConfig = null;

function toNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function padLevel(level) {
  return String(level).padStart(2, "0");
}

function hashText(value, modDigits = null) {
  let out = 0;
  const length = value?.length ?? 0;
  for (let i = 0; i < length; i += 1) out += value.charCodeAt(i);
  return modDigits ? out % Math.pow(10, Math.min(modDigits, 5)) : out;
}

function parseNumOrStr(value) {
  const text = String(value);
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : value;
}

function maybeDecodeJson(value, key) {
  if (value == null || !key || typeof value !== "string") return value;
  try {
    return JSON.parse(decryptCharCodes(value, key));
  } catch {
    return value;
  }
}

function decodeDataValue(value, delta, rowKey, hasFormulaFlag) {
  let normalizedDelta = delta;
  if (rowKey != null && rowKey < 0 && hasFormulaFlag && normalizedDelta && normalizedDelta < 0) {
    normalizedDelta = Math.abs(normalizedDelta);
  }
  if (!normalizedDelta) return value;
  if (value == null) return null;

  if (Array.isArray(value)) {
    return value.map((item) => decodeDataValue(item, normalizedDelta, rowKey, hasFormulaFlag));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = decodeDataValue(item, normalizedDelta, rowKey, hasFormulaFlag);
    }
    return out;
  }
  if (typeof value === "number" && value >= 10) {
    let out = value - normalizedDelta;
    if (out < 1e8 && out % 1) out = Math.round(1e4 * out) / 1e4;
    return out;
  }
  return value;
}

function makeLevelInfo(rawCd, source, timeStep = DEFAULT_FLOWER_CD_TIME_STEP_SECONDS) {
  if (rawCd == null) {
    return {
      seconds: null,
      rawCd: null,
      timeStep,
      source: "missing",
      advanceHarvestIntervalReductionSeconds: 0,
      advanceEffects: {},
      advanceSlots: [],
    };
  }
  return {
    seconds: rawCd * timeStep,
    rawCd,
    timeStep,
    source,
    advanceHarvestIntervalReductionSeconds: 0,
    advanceEffects: {},
    advanceSlots: [],
  };
}

function decryptCharCodes(value, key = "smallaitt") {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const codes = JSON.parse(raw.startsWith("[") ? raw : `[${raw}]`);
  const scrambled = codes.map((code) => String.fromCharCode(code)).join("");
  let out = "";

  for (const char of scrambled) {
    let code = char.charCodeAt(0);
    for (let i = key.length - 1; i >= 0; i -= 1) {
      code ^= key.charCodeAt(i);
    }
    out += String.fromCharCode(code);
  }

  return out;
}

function tableName(encryptedName, table) {
  return table?.a ? decryptCharCodes(encryptedName, String(table.a)) : encryptedName;
}

function findTable(config, targetName) {
  for (const [encryptedName, table] of Object.entries(config || {})) {
    if (tableName(encryptedName, table) === targetName) return table;
  }
  return null;
}

export function findConfigTable(config, targetName) {
  return findTable(config, targetName);
}

function decodeFieldMap(table) {
  if (!table?.m) return table?.colMap || {};
  return maybeDecodeJson(table.m, String(table.a)) || {};
}

function normalizeTable(tableName, table) {
  if (!table) return [];
  const key = table.a ? String(table.a) : "";
  const colMap = decodeFieldMap(table);
  const colHashByEncodedName = {};
  for (const [fieldName, encodedName] of Object.entries(colMap || {})) {
    if (fieldName !== "$") colHashByEncodedName[encodedName] = hashText(`${tableName}#${encodedName}`, 2);
  }

  return {
    ...table,
    c: maybeDecodeJson(table.c, key),
    d: maybeDecodeJson(table.d, key),
    colMap,
    colHashByEncodedName,
    list: (table.list || []).map((block) => ({
      ...block,
      d: maybeDecodeJson(block.d, key),
    })),
  };
}

function decodeRows(table, tableName) {
  if (!table) return [];
  const normalized = normalizeTable(tableName, table);
  const fieldMap = normalized.colMap || {};
  const rows = [];

  for (const block of normalized.list || []) {
    for (const [id, row] of Object.entries(block.v || {})) {
      const decoded = {};
      const idNumber = toNumber(id);
      const rowKey = parseNumOrStr(id);
      const rowDelta = idNumber == null ? 0 : parseInt(String(id), 10) % 100;

      for (const [fieldName, encodedName] of Object.entries(fieldMap)) {
        if (fieldName === "$") continue;

        let value = row?.[encodedName];
        const colHash = normalized.colHashByEncodedName[encodedName] || 0;
        if (normalized.a) {
          value = decodeDataValue(value, (rowDelta + colHash) % 100, idNumber, Boolean(normalized.f));
        }

        const colType = normalized.c?.[encodedName];
        if (value == null) value = block.d?.[encodedName];
        else if (colType) {
          if (colType === 1 && typeof value === "number") value -= hashText(colHash, 2);
          else if (colType === 3 && normalized.a && typeof value === "string") {
            value = decryptCharCodes(value, String(normalized.a));
          } else if (colType === 4 && normalized.a && typeof value === "string") {
            value = maybeDecodeJson(value, String(normalized.a));
          }
        }

        if (value != null) decoded[fieldName] = value;
      }

      const idField = fieldMap.$;
      if (idField && decoded[idField] == null) decoded[idField] = rowKey;
      else if (decoded.id == null) decoded.id = rowKey;
      rows.push(decoded);
    }
  }

  return rows;
}

export function decodeConfigRows(table, tableName) {
  return decodeRows(table, tableName);
}

export function createFlowerLevelConfig({
  flowerLvlRows = [],
  flowerLvlCfgRows = [],
  flowerAdvanceSkillRows = [],
  flowerRows = [],
  gameCfgRows = [],
} = {}) {
  const metaRow = flowerLvlRows.find((row) => row.$lvlMax != null) || {};
  const gameCfg = gameCfgRows.find((row) => row.$videoGldAdd != null) || {};
  return {
    flowerLvlById: new Map(flowerLvlRows.map((row) => [String(row.id), row])),
    flowerLvlCfgByLvl: new Map(flowerLvlCfgRows.map((row) => [String(row.id), row])),
    flowerAdvanceSkillById: new Map(flowerAdvanceSkillRows.map((row) => [String(row.id), row])),
    flowerById: new Map(flowerRows.map((row) => [String(row.id), row])),
    maxLvl: toNumber(metaRow.$lvlMax, 20),
    videoGoldAddRate: toNumber(gameCfg.$videoGldAdd, 0) / 10000,
  };
}

export function loadFlowerLevelConfig(configPath = DEFAULT_STATIC_CONFIG_PATH) {
  if (cachedConfig && cachedPath === configPath) return cachedConfig;
  if (!fs.existsSync(configPath)) {
    cachedPath = configPath;
    cachedConfig = createFlowerLevelConfig();
    return cachedConfig;
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(raw);
  const flowerLvlRows = decodeRows(findTable(config, "c_flowerLvl"), "c_flowerLvl");
  const flowerLvlCfgRows = decodeRows(findTable(config, "c_flowerLvlCfg"), "c_flowerLvlCfg");
  const flowerAdvanceSkillRows = decodeRows(findTable(config, "c_flowerAdvanceSkill"), "c_flowerAdvanceSkill");
  const flowerRows = decodeRows(findTable(config, "c_flower"), "c_flower");
  const gameCfgRows = decodeRows(findTable(config, "c_gameCfg"), "c_gameCfg");
  cachedPath = configPath;
  cachedConfig = createFlowerLevelConfig({
    flowerLvlRows,
    flowerLvlCfgRows,
    flowerAdvanceSkillRows,
    flowerRows,
    gameCfgRows,
  });
  return cachedConfig;
}

function getAdvanceSkillValueBySlot(slotId, cfg) {
  if (!cfg) return 0;
  if (Number(slotId) === 1) return toNumber(cfg.value1);
  if (Number(slotId) === 2) return toNumber(cfg.value2);
  return toNumber(cfg.value3);
}

export function getFlowerAdvanceSkillExt(cultivate = {}, config = loadFlowerLevelConfig()) {
  const slotMap = cultivate?.advanceSlotMap || {};
  const effectTotals = {};
  const slots = [];

  for (const [slotIdText, slot] of Object.entries(slotMap || {})) {
    const skillId = slot?.skillId;
    if (!skillId) continue;

    const cfg = config?.flowerAdvanceSkillById?.get(String(skillId));
    if (!cfg?.skillType) continue;

    const slotId = toNumber(slot?.slotId ?? slotIdText);
    const skillType = toNumber(cfg.skillType);
    const valueType = toNumber(cfg.valueType, 1);
    const rawValue = getAdvanceSkillValueBySlot(slotId, cfg) ?? 0;
    const effectValue = valueType === 2 ? rawValue / 10000 : rawValue;

    effectTotals[skillType] = (effectTotals[skillType] || 0) + effectValue;
    slots.push({
      slotId,
      skillId: toNumber(skillId),
      skillType,
      valueType,
      rawValue,
      effectValue,
      pendingSkillId: slot?.pendingSkillId ?? null,
    });
  }

  return { effects: effectTotals, slots };
}

function withAdvanceEffects(levelInfo, cultivate, config) {
  const advance = getFlowerAdvanceSkillExt(cultivate, config);
  const reduction = Number(advance.effects[HARVEST_INTERVAL_REDUCTION_SKILL_TYPE] || 0);
  return {
    ...levelInfo,
    seconds: levelInfo.seconds == null ? null : Math.max(0, levelInfo.seconds - reduction),
    advanceHarvestIntervalReductionSeconds: reduction,
    advanceEffects: advance.effects,
    advanceSlots: advance.slots,
  };
}

export function getFlowerLevelInfo(flowerId, lvl = 1, config = loadFlowerLevelConfig(), cultivate = {}) {
  const id = toNumber(flowerId);
  const level = toNumber(lvl, 1);
  if (!id || !level || !config) return { seconds: null, source: "missing" };

  const exact = config.flowerLvlById?.get(`${id}${padLevel(level)}`);
  const exactCd = toNumber(exact?.cd);
  if (exactCd != null) return withAdvanceEffects(makeLevelInfo(Math.round(exactCd), "exact"), cultivate, config);

  const base = config.flowerLvlById?.get(String(id));
  const levelCfg = config.flowerLvlCfgByLvl?.get(String(level));
  const level1Cfg = config.flowerLvlCfgByLvl?.get("1");
  const baseCd = toNumber(base?.cd);
  const levelCd = toNumber(levelCfg?.cd);
  const level1Cd = toNumber(level1Cfg?.cd);
  if (baseCd != null && levelCd != null && level1Cd) {
    return withAdvanceEffects(makeLevelInfo(Math.round((levelCd / level1Cd) * baseCd), "formula"), cultivate, config);
  }

  if (levelCd != null) return withAdvanceEffects(makeLevelInfo(Math.round(levelCd), "levelCfg"), cultivate, config);
  return withAdvanceEffects(makeLevelInfo(null, "missing"), cultivate, config);
}

export function getFlowerUpgradeRequirement(flowerId, lvl = 1, config = loadFlowerLevelConfig()) {
  const id = toNumber(flowerId);
  const level = toNumber(lvl, 1);
  const maxLvl = toNumber(config?.maxLvl, 20);
  const flower = config?.flowerById?.get(String(id)) || {};
  const genericLevelCfg = level != null && level < maxLvl
    ? config?.flowerLvlCfgByLvl?.get(String(level))
    : null;
  const exactLevelCfg = id && level != null && level < maxLvl
    ? config?.flowerLvlById?.get(`${id}${padLevel(level)}`)
    : null;
  const exactEliteCost = Array.isArray(exactLevelCfg?.lvlUpCost)
    ? exactLevelCfg.lvlUpCost
    : null;
  const eliteId = toNumber(exactEliteCost?.[0] ?? flower.eliteId);
  const eliteCost = toNumber(exactEliteCost?.[1] ?? exactLevelCfg?.lvlUpCost ?? genericLevelCfg?.lvlUpCost);
  const gldCost = resolveFlowerUpgradeGoldCost({
    id,
    exactLevelCfg,
    genericLevelCfg,
    config,
  });
  const upgradable =
    Boolean(id && level != null && level < maxLvl && eliteId != null && gldCost != null && eliteCost != null);
  return { flowerId: id, lvl: level, maxLvl, eliteId, eliteCost, gldCost, upgradable };
}

function resolveFlowerUpgradeGoldCost({ id, exactLevelCfg, genericLevelCfg, config }) {
  const exactCost = toNumber(exactLevelCfg?.gldCost);
  if (exactCost != null) return exactCost;

  const baseCost = toNumber(config?.flowerLvlById?.get(String(id))?.gldCost);
  const levelCost = toNumber(genericLevelCfg?.gldCost);
  const levelOneCost = toNumber(config?.flowerLvlCfgByLvl?.get("1")?.gldCost);
  if (baseCost == null || levelCost == null || !levelOneCost) return null;
  return Math.round((levelCost / levelOneCost) * baseCost);
}

export function getFlowerMaturitySeconds(flowerId, lvl = 1, config = loadFlowerLevelConfig()) {
  return getFlowerLevelInfo(flowerId, lvl, config).seconds;
}
