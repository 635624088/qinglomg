import fs from "node:fs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";
import {
  decodeConfigRows,
  findConfigTable,
  getFlowerAdvanceSkillExt,
} from "./flower-level-config.mjs";

const EXPERIENCE_ITEM_ID = 2;
const ORDER_EXPERIENCE_SKILL_TYPE = 2;
const configCache = new Map();

export const NOBLE_SESSION_STATE_FIELD = "$nobleState";
export const NOBLE_SESSION_STATES = Object.freeze({
  UNKNOWN: "unknown",
  KNOWN_NONE: "known-none",
  KNOWN_CARD_MAP: "known-card-map",
});
const NOBLE_SESSION_STATE_VALUES = new Set(Object.values(NOBLE_SESSION_STATES));

export const DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT = 0.5;
export const MIN_EXPERIENCE_GUARD_THRESHOLD_PERCENT = 0;
export const EXPERIENCE_GUARD_REMAINING_RATE =
  DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT / 100;

export const DEFAULT_TEAM_ORDER_GUARD_MULTIPLIER = 2;
export const MIN_TEAM_ORDER_GUARD_MULTIPLIER = 0;
export const MAX_TEAM_ORDER_GUARD_MULTIPLIER = 10;

export function isValidTeamOrderGuardMultiplier(value) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < MIN_TEAM_ORDER_GUARD_MULTIPLIER
    || value > MAX_TEAM_ORDER_GUARD_MULTIPLIER
  ) {
    return false;
  }
  const scaled = value * 100;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  return Number.isFinite(scaled)
    && Math.abs(scaled - Math.round(scaled)) <= tolerance;
}

export function isValidExperienceGuardThresholdPercent(value) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < MIN_EXPERIENCE_GUARD_THRESHOLD_PERCENT
  ) {
    return false;
  }
  const scaled = value * 100;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  return Number.isFinite(scaled)
    && Math.abs(scaled - Math.round(scaled)) <= tolerance;
}

function assertExperienceGuardThresholdPercent(value) {
  if (isValidExperienceGuardThresholdPercent(value)) return;
  const error = new RangeError("Invalid experience guard threshold percent");
  error.code = "INVALID_EXPERIENCE_GUARD_THRESHOLD_PERCENT";
  throw error;
}

export function calculateExperienceGuardThreshold(
  requiredExp,
  thresholdPercent = DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT,
) {
  assertExperienceGuardThresholdPercent(thresholdPercent);
  const required = Number(requiredExp);
  if (!Number.isFinite(required) || required <= 0) {
    return {
      thresholdPercent,
      thresholdRemainingExp: null,
      protectionLimitExp: null,
    };
  }
  const thresholdRemainingExp = Math.ceil(
    required * (thresholdPercent / 100),
  );
  return {
    thresholdPercent,
    thresholdRemainingExp,
    protectionLimitExp: required - thresholdRemainingExp,
  };
}

export const DIRECT_EXPERIENCE_IFACES = new Set([
  "gs.usrLand.harvest",
  "gs.usrLand.harvestOneKey",
  "gs.orderFlower.finishOrder",
  "gs.orderFlower.finishSatinOrder",
  "gs.orderFlower.finishDecorateOrder",
  "gs.orderCustomer.finishOrder",
  "gs.orderPalace.finishOrder",
  "gs.orderTeam.recvRwd",
]);

export const CONDITIONAL_EXPERIENCE_IFACES = new Set([
  "gs.taskMain.recv",
  "gs.actCyclicNote.recvTaskRwd",
  "gs.actCyclicStory.recvOrderRwd",
]);

// Kept as a compatibility export for callers that inspect the old contract.
// Team-order admission/submission are state-machine requests, not experience
// settlement points; only recvRwd is a direct experience reward interface.
export const PENDING_EXPERIENCE_IFACES = new Set();

export const NO_DIRECT_EXPERIENCE_IFACES = new Set([
  "gs.index.login",
  "gs.usr.lazySync",
  "gs.usr.heartTick",
  "gs.usrLand.refresh",
  "gs.usrLand.plant",
  "gs.usrLand.plantBatch",
  "gs.usrLand.water",
  "gs.usrLand.waterBatch",
  "gs.usrLand.speedUpFree",
  "gs.orderFlower.enter",
  "gs.orderCustomer.genOrder",
  "gs.orderCustomer.rejectOrder",
  "gs.flowerArt.makeFlowerArt",
  "gs.orderPalace.enter",
  "gs.orderPalace.refreshOrder",
  "gs.orderTeam.takeOrder",
  "gs.orderTeam.takeStoredOrder",
  "gs.orderTeam.refreshOrder",
  "gs.orderTeam.storeOrder",
  "gs.orderTeam.submitOrder",
  "gs.flowerRack.sell",
  "gs.flowerRack.sellOneKey",
  "gs.flowerRack.recvSellMoney",
  "gs.flowerRack.recvOneKey",
  "gs.fml.enter",
  "gs.fmlLand.harvest",
  "gs.fmlLand.harvestAll",
  "gs.freeWater.recv",
  "gs.shopCultivate.enter",
  "gs.shopCultivate.refresh",
  "gs.shopCultivate.buy",
  "gs.shopCultivate.buyOneKey",
  "gs.cultivate.upgrade",
  "gs.pearl.recvDailyFree",
  "gs.pearl.getRecommendList",
  "gs.pearl.getHireStateByUids",
  "gs.pearl.refresh",
  "gs.pearlPlace.hire",
  "gs.pearlPlace.recv",
  "gs.pearlPlace.recvOneKey",
  "gs.waterwheel.enter",
  "gs.waterwheel.recv",
  "gs.actCyclicNote.enter",
  "gs.actCyclicStory.enter",
]);

export function classifyExperienceInterface(iface) {
  const key = String(iface || "");
  if (DIRECT_EXPERIENCE_IFACES.has(key)) return { kind: "direct", iface: key };
  if (PENDING_EXPERIENCE_IFACES.has(key)) return { kind: "pending", iface: key };
  if (CONDITIONAL_EXPERIENCE_IFACES.has(key)) return { kind: "conditional", iface: key };
  if (NO_DIRECT_EXPERIENCE_IFACES.has(key)) return { kind: "none", iface: key };
  return { kind: "unknown", iface: key };
}

function toFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toPositiveInteger(value, fallback = null) {
  const number = toFiniteNumber(value, fallback);
  return number != null && number > 0 ? Math.floor(number) : fallback;
}

function itemAmount(source, itemId = EXPERIENCE_ITEM_ID) {
  if (Array.isArray(source)) {
    if (
      source.length >= 2
      && !Array.isArray(source[0])
      && (typeof source[0] !== "object" || source[0] == null)
    ) {
      return Number(source[0]) === Number(itemId)
        ? toFiniteNumber(source[1], 0)
        : 0;
    }
    return source.reduce((total, entry) => total + itemAmount(entry, itemId), 0);
  }
  if (!source || typeof source !== "object") return 0;
  return toFiniteNumber(source[itemId] ?? source[String(itemId)], 0);
}

function hasItemAmount(source, itemId = EXPERIENCE_ITEM_ID) {
  if (Array.isArray(source)) {
    if (
      source.length >= 2
      && !Array.isArray(source[0])
      && (typeof source[0] !== "object" || source[0] == null)
    ) {
      return Number(source[0]) === Number(itemId);
    }
    return source.some((entry) => hasItemAmount(entry, itemId));
  }
  if (!source || typeof source !== "object") return false;
  return Object.hasOwn(source, itemId) || Object.hasOwn(source, String(itemId));
}

function requiredTable(raw, name, reasons) {
  const table = findConfigTable(raw, name);
  if (!table) {
    reasons.push(`missing-table:${name}`);
    return [];
  }
  try {
    const rows = decodeConfigRows(table, name);
    if (!rows.length) reasons.push(`empty-table:${name}`);
    return rows;
  } catch (error) {
    reasons.push(`decode-failed:${name}:${error?.message || String(error)}`);
    return [];
  }
}

function mapByNumericId(rows, mapper) {
  return new Map(
    rows
      .map((row) => {
        const id = toFiniteNumber(row?.id, null);
        return id == null ? null : [id, mapper(row, id)];
      })
      .filter(Boolean),
  );
}

function buildConfig(filePath, raw) {
  const reasons = [];
  const flowerRows = requiredTable(raw, "c_flower", reasons);
  const flowerLevelRows = requiredTable(raw, "c_flowerLvl", reasons);
  const flowerLevelCfgRows = requiredTable(raw, "c_flowerLvlCfg", reasons);
  const flowerArtRows = requiredTable(raw, "c_flowerArt", reasons);
  const monthCardRows = requiredTable(raw, "c_monthCard", reasons);
  const teamOrderRows = requiredTable(raw, "c_orderTeam", reasons);
  const mainTaskRows = requiredTable(raw, "c_task_main", reasons);
  const cyclicNoteRows = requiredTable(raw, "c_actCyclicNote", reasons);
  const cyclicStoryRows = requiredTable(raw, "c_actCyclicStory", reasons);
  const advanceSkillRows = requiredTable(raw, "c_flowerAdvanceSkill", reasons);
  const fashionSuitRows = requiredTable(raw, "c_fashionSuit", reasons);

  const monthCardGlobals = monthCardRows.find((row) => Number(row.id) === -1) || null;
  const teamOrderGlobals = teamOrderRows.find((row) => Number(row.id) === -1) || null;
  if (!monthCardGlobals || toFiniteNumber(monthCardGlobals.$expAdd, null) == null) {
    reasons.push("missing-field:c_monthCard.$expAdd");
  }
  if (!teamOrderGlobals || itemAmount(teamOrderGlobals.$orderRwdBase) <= 0) {
    reasons.push("missing-field:c_orderTeam.$orderRwdBase[2]");
  }

  const flowers = mapByNumericId(flowerRows, (row, id) => ({
    id,
    experience: toFiniteNumber(row.exp, null),
  }));
  const flowerLevelExact = new Map(
    flowerLevelRows
      .map((row) => {
        const id = String(row?.id ?? "");
        return id
          ? [id, {
              id,
              harvestExp: toFiniteNumber(row.harvestExp, null),
            }]
          : null;
      })
      .filter(Boolean),
  );
  const flowerLevelCfg = mapByNumericId(flowerLevelCfgRows, (row, id) => ({
    id,
    harvestExp: toFiniteNumber(row.harvestExp, null),
  }));
  const flowerArts = mapByNumericId(flowerArtRows, (row, id) => ({
    id,
    experiencePrice: itemAmount(row.cPrice),
    experiencePriceKnown: hasItemAmount(row.cPrice),
    flowerIds: Array.isArray(row.flowers)
      ? row.flowers.map((value) => toPositiveInteger(value)).filter(Boolean)
      : [],
  }));
  const mainTasks = mapByNumericId(mainTaskRows, (row, id) => ({
    id,
    experienceReward: itemAmount(row.rewards),
  }));
  const cyclicNotes = mapByNumericId(cyclicNoteRows, (row, id) => ({
    id,
    experienceReward: itemAmount(row.reward),
  }));
  const cyclicStoryGlobals = cyclicStoryRows.find((row) => Number(row.id) === -1) || null;
  const cyclicStories = mapByNumericId(
    cyclicStoryRows.filter((row) => Number(row.id) > 0),
    (row, id) => ({
      id,
      cost: toFiniteNumber(row.cost, null),
    }),
  );
  const cyclicStoryExpOrderMax = toFiniteNumber(cyclicStoryGlobals?.$expValueMax, null);
  const cyclicStoryExpValueRaw = toFiniteNumber(cyclicStoryGlobals?.$expValue, null);
  if (cyclicStoryExpOrderMax == null || cyclicStoryExpValueRaw == null) {
    reasons.push("missing-field:c_actCyclicStory.$expValueMax/$expValue");
  }
  const teamOrders = mapByNumericId(
    teamOrderRows.filter((row) => Number(row.id) > 0),
    (row, id) => ({
      id,
      magnification: toFiniteNumber(row.magnification, null),
    }),
  );
  const flowerAdvanceSkillById = new Map(
    advanceSkillRows
      .map((row) => [String(row.id), row]),
  );
  const fashionSuits = mapByNumericId(fashionSuitRows, (row, id) => ({
    id,
    unitIds: Array.isArray(row.unitId)
      ? row.unitId.map((value) => toPositiveInteger(value)).filter(Boolean)
      : [],
    triggerAttributeId: toPositiveInteger(row.attrExt?.[0]?.[0]),
    triggerLimit: toPositiveInteger(row.attrExt?.[0]?.[1]),
    experienceAdd: toFiniteNumber(row.specialValue?.[0], null) == null
      ? null
      : toFiniteNumber(row.specialValue[0], 0) / 10_000,
  }));

  for (const [name, map, field] of [
    ["c_flower", flowers, "experience"],
    ["c_flowerLvlCfg", flowerLevelCfg, "harvestExp"],
    ["c_flowerArt", flowerArts, "experiencePrice"],
  ]) {
    if (![...map.values()].some((row) => toFiniteNumber(row[field], null) != null)) {
      reasons.push(`missing-experience-field:${name}.${field}`);
    }
  }

  return {
    compatible: reasons.length === 0,
    reasons,
    sourcePath: filePath,
    monthCardExpAdd: toFiniteNumber(monthCardGlobals?.$expAdd, 0) / 10_000,
    flowers,
    flowerLevelExact,
    flowerLevelCfg,
    flowerArts,
    mainTasks,
    cyclicNotes,
    cyclicStories,
    cyclicStory: {
      expOrderMax: cyclicStoryExpOrderMax,
      expValue: cyclicStoryExpValueRaw == null ? null : cyclicStoryExpValueRaw / 10_000,
    },
    flowerAdvanceSkillById,
    fashionSuits,
    teamOrder: {
      rewardBaseExperience: itemAmount(teamOrderGlobals?.$orderRwdBase),
      orders: teamOrders,
    },
  };
}

export function loadExperienceSettlementConfig(filePath = getDefaultStaticConfigPath()) {
  const cacheKey = String(filePath);
  if (configCache.has(cacheKey)) return configCache.get(cacheKey);
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const config = buildConfig(filePath, raw);
    configCache.set(cacheKey, config);
    return config;
  } catch (error) {
    const config = {
      compatible: false,
      reasons: [`config-read-failed:${error?.message || String(error)}`],
      sourcePath: filePath,
      monthCardExpAdd: 0,
      flowers: new Map(),
      flowerLevelExact: new Map(),
      flowerLevelCfg: new Map(),
      flowerArts: new Map(),
      mainTasks: new Map(),
      cyclicNotes: new Map(),
      cyclicStories: new Map(),
      cyclicStory: {
        expOrderMax: null,
        expValue: null,
      },
      flowerAdvanceSkillById: new Map(),
      fashionSuits: new Map(),
      teamOrder: {
        rewardBaseExperience: null,
        orders: new Map(),
      },
    };
    configCache.set(cacheKey, config);
    return config;
  }
}

function unknown(source, details = {}, extra = {}) {
  return {
    known: false,
    minExp: null,
    maxExp: null,
    source,
    details,
    ...extra,
  };
}

function known(value, source, details = {}) {
  const amount = Math.max(0, Math.round(Number(value) || 0));
  return {
    known: true,
    minExp: amount,
    maxExp: amount,
    source,
    details,
  };
}

function isObjectRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nobleStateFromCardMap(cardMap) {
  if (!isObjectRecord(cardMap)) return NOBLE_SESSION_STATES.UNKNOWN;
  return Object.keys(cardMap).length > 0
    ? NOBLE_SESSION_STATES.KNOWN_CARD_MAP
    : NOBLE_SESSION_STATES.KNOWN_NONE;
}

export function getNobleSessionState(syncValue) {
  const stored = syncValue?.[NOBLE_SESSION_STATE_FIELD];
  if (NOBLE_SESSION_STATE_VALUES.has(stored)) return stored;
  return nobleStateFromCardMap(syncValue?.rchgTot?.cardMap);
}

export function markNobleSessionState(syncValue, { authoritativeComplete = false } = {}) {
  if (!isObjectRecord(syncValue)) return syncValue;
  const cardMap = syncValue?.rchgTot?.cardMap;
  const state = isObjectRecord(cardMap)
    ? nobleStateFromCardMap(cardMap)
    : authoritativeComplete
      ? NOBLE_SESSION_STATES.KNOWN_NONE
      : NOBLE_SESSION_STATES.UNKNOWN;
  return {
    ...syncValue,
    [NOBLE_SESSION_STATE_FIELD]: state,
  };
}

export function mergeNobleSessionState(base, update, { authoritativeComplete = false } = {}) {
  const explicit = update?.[NOBLE_SESSION_STATE_FIELD];
  if (explicit && explicit !== NOBLE_SESSION_STATES.UNKNOWN && NOBLE_SESSION_STATE_VALUES.has(explicit)) {
    return explicit;
  }
  const updateCardMap = update?.rchgTot?.cardMap;
  if (isObjectRecord(updateCardMap)) return nobleStateFromCardMap(updateCardMap);
  if (authoritativeComplete) return NOBLE_SESSION_STATES.KNOWN_NONE;
  return getNobleSessionState(base);
}

export function mergeNobleSessionFields(base, update, target = { ...(base || {}) }) {
  const out = target;
  if (base?.rchgTot || update?.rchgTot) {
    const baseRecharge = base?.rchgTot && typeof base.rchgTot === "object"
      ? base.rchgTot
      : {};
    const updateRecharge = update?.rchgTot && typeof update.rchgTot === "object"
      ? update.rchgTot
      : {};
    const mergedRecharge = { ...baseRecharge, ...updateRecharge };
    if (!Object.hasOwn(updateRecharge, "cardMap") && Object.hasOwn(baseRecharge, "cardMap")) {
      if (
        update?.[NOBLE_SESSION_STATE_FIELD] === NOBLE_SESSION_STATES.KNOWN_NONE
        || getNobleSessionState(base) === NOBLE_SESSION_STATES.KNOWN_NONE
      ) {
        delete mergedRecharge.cardMap;
      } else {
        mergedRecharge.cardMap = baseRecharge.cardMap;
      }
    }
    out.rchgTot = mergedRecharge;
  }
  const nobleState = mergeNobleSessionState(base, update);
  if (
    nobleState !== NOBLE_SESSION_STATES.UNKNOWN
    || Object.hasOwn(base || {}, NOBLE_SESSION_STATE_FIELD)
    || Object.hasOwn(update || {}, NOBLE_SESSION_STATE_FIELD)
  ) {
    out[NOBLE_SESSION_STATE_FIELD] = nobleState;
  }
  return out;
}

function getNobleExperienceAdd(syncValue, config, nowMs = Date.now()) {
  const state = getNobleSessionState(syncValue);
  if (state === NOBLE_SESSION_STATES.KNOWN_NONE) return 0;
  const cardMap = syncValue?.rchgTot?.cardMap;
  const card = cardMap?.[1]
    ?? cardMap?.["1"]
    ?? null;
  if (!card) return 0;
  const invalidTime = card.invalidTime;
  let invalidTimeMs = null;
  if (typeof invalidTime === "number" && Number.isFinite(invalidTime)) {
    invalidTimeMs = Math.abs(invalidTime) >= 1_000_000_000 && Math.abs(invalidTime) < 100_000_000_000
      ? invalidTime * 1000
      : invalidTime;
  } else if (invalidTime != null) {
    const parsed = Date.parse(invalidTime);
    invalidTimeMs = Number.isFinite(parsed) ? parsed : null;
  }
  const active = card.isMain === true
    || card.isMain === 1
    || (invalidTimeMs != null && invalidTimeMs > nowMs);
  return active ? toFiniteNumber(config?.monthCardExpAdd, 0) : 0;
}

function hasKnownNobleState(syncValue) {
  const state = getNobleSessionState(syncValue);
  if (state === NOBLE_SESSION_STATES.KNOWN_NONE) return true;
  return state === NOBLE_SESSION_STATES.KNOWN_CARD_MAP
    && isObjectRecord(syncValue?.rchgTot?.cardMap);
}

function getCultivate(syncValue, flowerId) {
  return syncValue?.cultivateTot?.cultivateMap?.[flowerId]
    ?? syncValue?.cultivateTot?.cultivateMap?.[String(flowerId)]
    ?? null;
}

function getFlowerSkillValue(syncValue, flowerId, config) {
  const cultivate = getCultivate(syncValue, flowerId);
  if (!cultivate) return 0;
  const skill = getFlowerAdvanceSkillExt(cultivate, {
    flowerAdvanceSkillById: config.flowerAdvanceSkillById,
  });
  return Math.max(0, toFiniteNumber(skill.effects?.[ORDER_EXPERIENCE_SKILL_TYPE], 0));
}

function normalizeFlowerRequirements(flowers) {
  if (!Array.isArray(flowers)) return [];
  return flowers
    .map((entry) => {
      if (Array.isArray(entry)) {
        return {
          flowerId: toPositiveInteger(entry[0]),
          count: toPositiveInteger(entry[1]),
        };
      }
      if (entry && typeof entry === "object") {
        return {
          flowerId: toPositiveInteger(entry.flowerId ?? entry.itemId ?? entry.id),
          count: toPositiveInteger(entry.num ?? entry.count ?? entry.need),
        };
      }
      return null;
    })
    .filter((entry) => entry?.flowerId && entry?.count);
}

function getOrderFlowerRoot(syncValue) {
  return syncValue?.orderFlowerTot?.orderFlower
    ?? syncValue?.orderFlower
    ?? null;
}

function findOrdinaryResidentOrder(syncValue, boxId) {
  const orderMap = getOrderFlowerRoot(syncValue)?.orderMap;
  if (!orderMap || boxId == null) return null;
  if (Array.isArray(orderMap)) {
    return orderMap.find((row, index) => (
      Number(row?.boxId ?? row?.box ?? row?.id ?? index) === Number(boxId)
    )) || null;
  }
  return orderMap[boxId] ?? orderMap[String(boxId)] ?? null;
}

function calOrderExp(base, skill, noble) {
  return Math.max(Math.round(base * skill * 1.68 / (1 + noble)), 1);
}

function calOrderFlowerExp(base, skill, noble) {
  return Math.max(Math.round(base * skill / (1 + noble)), 1);
}

function estimateResidentOrder(iface, arg, syncValue, config, nowMs) {
  const orderRoot = getOrderFlowerRoot(syncValue);
  const flowerSkillApplied = true;
  const order = iface === "gs.orderFlower.finishOrder"
    ? findOrdinaryResidentOrder(syncValue, arg?.boxId)
    : iface === "gs.orderFlower.finishSatinOrder"
      ? orderRoot?.orderSatin
      : orderRoot?.orderDecorate;
  const requirements = normalizeFlowerRequirements(order?.flowers);
  if (!order || !requirements.length) {
    return unknown("resident-order-missing", { iface, boxId: arg?.boxId ?? null });
  }
  const nobleAdd = getNobleExperienceAdd(syncValue, config, nowMs);
  let subtotal = 0;
  const rows = [];
  for (const requirement of requirements) {
    const flower = config.flowers.get(requirement.flowerId);
    const baseExp = toFiniteNumber(flower?.experience, null);
    if (baseExp == null) {
      return unknown("resident-order-flower-config-missing", {
        iface,
        flowerId: requirement.flowerId,
      });
    }
    const skillValue = getFlowerSkillValue(syncValue, requirement.flowerId, config);
    const skillExp = flowerSkillApplied && skillValue > 0
      ? calOrderFlowerExp(baseExp, skillValue, nobleAdd)
      : 0;
    subtotal += (baseExp + skillExp) * requirement.count;
    rows.push({
      flowerId: requirement.flowerId,
      count: requirement.count,
      baseExp,
      skillValue,
      skillExp,
    });
  }
  const total = Math.round(subtotal * (1 + nobleAdd));
  return known(total, "resident-order-config", {
    iface,
    nobleAdd,
    flowerSkillApplied,
    rows,
  });
}

function findCustomerOrder(syncValue, npcId) {
  const orderMap = syncValue?.orderCustomerTot?.orderCustomer?.orderMap
    ?? syncValue?.orderCustomer?.orderMap
    ?? null;
  if (!orderMap) return null;
  if (Array.isArray(orderMap)) {
    return orderMap.find((row, index) => (
      Number(row?.npcId ?? row?.id ?? index) === Number(npcId)
    )) || null;
  }
  return orderMap[npcId] ?? orderMap[String(npcId)] ?? null;
}

function estimateCustomerOrder(arg, syncValue, config, nowMs) {
  const order = findCustomerOrder(syncValue, arg?.npcId);
  const artId = toPositiveInteger(order?.artId);
  const quantity = toPositiveInteger(order?.num, 1);
  const art = config.flowerArts.get(artId);
  const baseExp = toFiniteNumber(art?.experiencePrice, null);
  const priceKnown = art?.experiencePriceKnown ?? baseExp != null;
  if (!order || !artId || baseExp == null || !quantity || priceKnown !== true) {
    return unknown("customer-order-config-missing", {
      npcId: arg?.npcId ?? null,
      artId: artId ?? null,
    });
  }
  if (!hasKnownNobleState(syncValue)) {
    return unknown("customer-order-noble-state-unknown", {
      npcId: arg?.npcId ?? null,
      artId,
    });
  }
  const nobleAdd = getNobleExperienceAdd(syncValue, config, nowMs);
  let skillValue = 0;
  let skillExp = 0;
  const skillRows = [];
  for (const flowerId of art.flowerIds || []) {
    const flower = config.flowers.get(flowerId);
    const flowerBaseExp = toFiniteNumber(flower?.experience, null);
    if (flowerBaseExp == null) {
      return unknown("customer-order-flower-config-missing", {
        npcId: arg?.npcId ?? null,
        artId,
        flowerId,
      });
    }
    const flowerSkillValue = getFlowerSkillValue(syncValue, flowerId, config);
    const flowerSkillExp = flowerSkillValue > 0
      ? calOrderExp(flowerBaseExp, flowerSkillValue, nobleAdd)
      : 0;
    skillValue += flowerSkillValue;
    skillExp += flowerSkillExp;
    skillRows.push({
      flowerId,
      baseExp: flowerBaseExp,
      skillValue: flowerSkillValue,
      skillType: ORDER_EXPERIENCE_SKILL_TYPE,
      skillExp: flowerSkillExp,
    });
  }
  const total = Math.round((baseExp + skillExp) * quantity);
  return known(total, "customer-order-config", {
    npcId: arg?.npcId ?? null,
    artId,
    quantity,
    cPriceItemId: EXPERIENCE_ITEM_ID,
    baseExp,
    skillValue,
    skillExp,
    skillRows,
    nobleAdd,
  });
}

function findPalaceOrder(syncValue, arg = {}) {
  const root = syncValue?.orderPalaceTot?.orderPalace
    ?? syncValue?.orderPalace
    ?? null;
  if (
    root
    && typeof root === "object"
    && (root.flowerId != null || root.flwId != null || root.itemId != null)
  ) {
    return root;
  }
  const orderMap = root?.orderMap ?? root;
  if (!orderMap || typeof orderMap !== "object") return null;
  const requestedId = arg.orderId ?? arg.id ?? null;
  if (requestedId != null) {
    return orderMap[requestedId] ?? orderMap[String(requestedId)] ?? null;
  }
  const rows = Array.isArray(orderMap) ? orderMap : Object.values(orderMap);
  return rows.find((row) => row && row.isFinish !== true && row.finished !== true) || null;
}

function parseTimeMs(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameLocalDay(leftMs, rightMs) {
  const left = new Date(leftMs);
  const right = new Date(rightMs);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function getPalaceSuitExperienceAdd(syncValue, config, nowMs) {
  const suit = config?.fashionSuits?.get(10040);
  if (
    !suit
    || !suit.unitIds?.length
    || !suit.triggerAttributeId
    || !suit.triggerLimit
    || suit.experienceAdd == null
  ) {
    return { known: false, value: null, reason: "palace-suit-config-missing" };
  }
  const fashionTot = syncValue?.fashionTot;
  const unitMap = fashionTot?.fashionUnitMap;
  if (!unitMap || typeof unitMap !== "object") {
    return { known: false, value: null, reason: "palace-fashion-unit-state-missing" };
  }
  const isFull = suit.unitIds.every((unitId) => {
    const unit = unitMap[unitId] ?? unitMap[String(unitId)] ?? null;
    return Boolean(
      unit
      && (
        unit.unlocked === true
        || unit.unlocked === 1
        || unit.cTime
      )
    );
  });
  if (!isFull) {
    return { known: true, value: 0, reason: "palace-suit-incomplete" };
  }

  const fashion = fashionTot?.fashionMap?.[10040]
    ?? fashionTot?.fashionMap?.["10040"]
    ?? {};
  const trigger = fashion?.triggerRcd?.[suit.triggerAttributeId]
    ?? fashion?.triggerRcd?.[String(suit.triggerAttributeId)]
    ?? {};
  let triggerCount = toFiniteNumber(trigger?.count, trigger?.count == null ? 0 : null);
  if (triggerCount == null) {
    return { known: false, value: null, reason: "palace-suit-trigger-count-invalid" };
  }
  if (trigger?.ltTime) {
    const triggerTimeMs = parseTimeMs(trigger.ltTime);
    if (triggerTimeMs == null) {
      return { known: false, value: null, reason: "palace-suit-trigger-time-invalid" };
    }
    if (!sameLocalDay(triggerTimeMs, nowMs)) triggerCount = 0;
  }
  return {
    known: true,
    value: triggerCount < suit.triggerLimit ? suit.experienceAdd : 0,
    reason: triggerCount < suit.triggerLimit
      ? "palace-suit-daily-bonus-available"
      : "palace-suit-daily-bonus-used",
  };
}

function estimatePalaceOrder(arg, syncValue, config, nowMs) {
  const order = findPalaceOrder(syncValue, arg);
  const flowerId = toPositiveInteger(order?.flowerId ?? order?.flwId ?? order?.itemId);
  const quantity = toPositiveInteger(
    order?.num ?? order?.need ?? order?.needNum ?? order?.flowerNum,
  );
  const flower = config.flowers.get(flowerId);
  const baseExp = toFiniteNumber(flower?.experience, null);
  const suit = getPalaceSuitExperienceAdd(syncValue, config, nowMs);
  if (!order || !flowerId || !quantity || baseExp == null || !suit.known) {
    return unknown("palace-order-state-unknown", {
      flowerId: flowerId ?? null,
      quantity: quantity ?? null,
      suitKnown: suit.known,
      suitReason: suit.reason,
    });
  }
  const nobleAdd = getNobleExperienceAdd(syncValue, config, nowMs);
  const skillValue = getFlowerSkillValue(syncValue, flowerId, config);
  const baseTotalExp = Math.round(baseExp * quantity);
  const total = Math.round(
    baseTotalExp * (1 + nobleAdd + skillValue + suit.value),
  );
  return known(total, "palace-order-config", {
    flowerId,
    quantity,
    baseExp,
    baseTotalExp,
    skillValue,
    nobleAdd,
    suitExpAdd: suit.value,
    suitReason: suit.reason,
  });
}

function estimateHarvest(arg, syncValue, config, nowMs) {
  const landId = toPositiveInteger(arg?.landId);
  const land = syncValue?.usrLandTot?.usrLand?.landMap?.[landId]
    ?? syncValue?.usrLandTot?.usrLand?.landMap?.[String(landId)]
    ?? null;
  const flowerId = toPositiveInteger(land?.flowerId);
  const cultivate = flowerId ? getCultivate(syncValue, flowerId) : null;
  const flowerLevel = toPositiveInteger(cultivate?.lvl ?? land?.lvl);
  if (!landId || !land || !flowerId || !flowerLevel) {
    return unknown("harvest-state-missing", {
      landId: landId ?? null,
      flowerId: flowerId ?? null,
      flowerLevel: flowerLevel ?? null,
    });
  }
  const exactKey = `${flowerId}${String(flowerLevel).padStart(2, "0")}`;
  const exact = config.flowerLevelExact.get(exactKey);
  const base = config.flowerLevelExact.get(String(flowerId));
  const levelCfg = config.flowerLevelCfg.get(flowerLevel);
  const baseExp = toFiniteNumber(
    exact?.harvestExp ?? base?.harvestExp ?? levelCfg?.harvestExp,
    null,
  );
  const configSource = exact?.harvestExp != null
    ? "exact"
    : base?.harvestExp != null
      ? "flower-base"
      : levelCfg?.harvestExp != null
        ? "level-config"
        : "missing";
  if (baseExp == null) {
    return unknown("harvest-config-missing", {
      landId,
      flowerId,
      flowerLevel,
    });
  }
  const flowerSkillExpAdd = getFlowerSkillValue(syncValue, flowerId, config);
  const flowerAdjustedExp = Math.round(baseExp * (1 + flowerSkillExpAdd));
  const globalExpAdd = getNobleExperienceAdd(syncValue, config, nowMs);
  return {
    known: true,
    minExp: Math.max(0, flowerAdjustedExp),
    maxExp: Math.max(0, Math.ceil(flowerAdjustedExp * (1 + globalExpAdd))),
    source: "flower-level-harvest-exp",
    details: {
      landId,
      flowerId,
      flowerLevel,
      baseExp,
      flowerSkillExpAdd,
      globalExpAdd,
      configSource,
    },
  };
}

function estimateTeamOrderReward(syncValue, config, nowMs) {
  const order = syncValue?.orderTeamTot?.orderTeam ?? null;
  const orderNum = toPositiveInteger(order?.orderNum);
  const orderConfig = config.teamOrder.orders.get(orderNum);
  const baseExp = toFiniteNumber(config.teamOrder.rewardBaseExperience, null);
  const magnification = toFiniteNumber(orderConfig?.magnification, null);
  if (!order || !orderNum || baseExp == null || magnification == null) {
    return unknown("team-order-reward-state-missing", {
      orderNum: orderNum ?? null,
    });
  }
  const pendingExp = itemAmount(order.rwd);
  const nobleAdd = getNobleExperienceAdd(syncValue, config, nowMs);
  const withNoble = Math.round((baseExp + pendingExp) * (1 + nobleAdd));
  const total = Math.round(withNoble * magnification / 100);
  return known(total, "team-order-reward-config", {
    orderNum,
    baseExp,
    pendingExp,
    nobleAdd,
    magnification,
  });
}

function currentMainTaskId(syncValue, arg) {
  return toPositiveInteger(
    arg?.taskId
      ?? arg?.id
      ?? syncValue?.taskTot?.main?.curTaskId
      ?? syncValue?.taskTot?.main?.taskId
      ?? syncValue?.taskTot?.main?.id
      ?? syncValue?.taskMainTot?.taskMain?.taskId
      ?? syncValue?.taskMainTot?.taskMain?.id
      ?? syncValue?.taskMain?.taskId
      ?? syncValue?.taskMain?.id,
  );
}

function currentCyclicNoteTaskId(syncValue, arg) {
  return toPositiveInteger(
    arg?.taskId
      ?? arg?.id
      ?? arg?.cfgId
      ?? syncValue?.actCyclicNoteTot?.actCyclicNote?.taskId
      ?? syncValue?.actCyclicNoteTot?.actCyclicNote?.cfgId,
  );
}

function findCyclicStoryActivity(syncValue, batchId) {
  const map = syncValue?.actTot?.map;
  if (!map || typeof map !== "object") return null;
  const requestedBatchId = toPositiveInteger(batchId);
  const activities = Object.values(map).filter((act) => {
    const activityType = toPositiveInteger(
      act?.tmpType ?? act?.tmpId ?? act?.d?.tmpType ?? act?.d?.tmpId,
    );
    if (activityType !== 4003) return false;
    if (!requestedBatchId) return true;
    return toPositiveInteger(act?.batchId ?? act?.d?.batchId) === requestedBatchId;
  });
  return activities.find((act) => Number(act?.phase ?? act?.d?.phase) === 2) || activities[0] || null;
}

function estimateCyclicStoryOrder(arg, syncValue, config) {
  const batchId = toPositiveInteger(arg?.batchId);
  const orderIdx = toFiniteNumber(arg?.orderIdx, null);
  const act = findCyclicStoryActivity(syncValue, batchId);
  const data = act?.ext?.cyclicStory || act?.d?.ext?.cyclicStory;
  const info = orderIdx == null
    ? null
    : data?.orderInfo?.[orderIdx] ?? data?.orderInfo?.[String(orderIdx)] ?? null;
  const orderId = toPositiveInteger(info?.orderId, 1);
  const flowerId = toPositiveInteger(info?.flowerId);
  const order = config.cyclicStories.get(orderId);
  const flower = config.flowers.get(flowerId);
  const expOrderNum = toFiniteNumber(data?.expOrderNum, null);
  const expOrderMax = toFiniteNumber(config.cyclicStory?.expOrderMax, null);
  const expValue = toFiniteNumber(config.cyclicStory?.expValue, null);
  const details = {
    batchId: batchId ?? toPositiveInteger(act?.batchId ?? act?.d?.batchId),
    orderIdx,
    orderId,
    flowerId,
    flowerExperience: toFiniteNumber(flower?.experience, null),
    cost: toFiniteNumber(order?.cost, null),
    expOrderNum,
    expOrderMax,
    expValue,
  };

  if (!act || !info || orderIdx == null || !order || !flower) {
    return unknown("cyclic-story-order-state-missing", details);
  }
  if (expOrderNum == null || expOrderMax == null || expValue == null) {
    return unknown("cyclic-story-experience-state-missing", details);
  }
  if (expOrderNum >= expOrderMax) {
    return known(0, "cyclic-story-order-config", details);
  }
  if (details.flowerExperience == null || details.cost == null) {
    return unknown("cyclic-story-experience-config-missing", details);
  }
  return known(
    Math.ceil(details.flowerExperience * details.cost * expValue),
    "cyclic-story-order-config",
    details,
  );
}

export function estimateExperienceAction({
  iface,
  arg = {},
  syncValue,
  config = loadExperienceSettlementConfig(),
  nowMs = Date.now(),
} = {}) {
  const classification = classifyExperienceInterface(iface);
  if (!config?.compatible) {
    return unknown("experience-config-incompatible", {
      reasons: config?.reasons || ["missing-config"],
    });
  }
  if (classification.kind === "none") return known(0, "no-direct-experience", { iface });
  if (classification.kind === "pending") {
    return unknown("team-order-atomic-pending", { iface }, { pending: true });
  }
  if (iface === "gs.usrLand.harvestOneKey") {
    return unknown(
      "harvest-one-key-requires-per-land",
      {},
      { requiresPerLand: true },
    );
  }
  if (iface === "gs.usrLand.harvest") {
    return estimateHarvest(arg, syncValue, config, nowMs);
  }
  if ([
    "gs.orderFlower.finishOrder",
    "gs.orderFlower.finishSatinOrder",
    "gs.orderFlower.finishDecorateOrder",
  ].includes(iface)) {
    return estimateResidentOrder(iface, arg, syncValue, config, nowMs);
  }
  if (iface === "gs.orderCustomer.finishOrder") {
    return estimateCustomerOrder(arg, syncValue, config, nowMs);
  }
  if (iface === "gs.orderPalace.finishOrder") {
    return estimatePalaceOrder(arg, syncValue, config, nowMs);
  }
  if (iface === "gs.orderTeam.recvRwd") {
    return estimateTeamOrderReward(syncValue, config, nowMs);
  }
  if (iface === "gs.taskMain.recv") {
    const taskId = currentMainTaskId(syncValue, arg);
    const task = config.mainTasks.get(taskId);
    return task
      ? known(task.experienceReward, "main-task-config", { taskId })
      : unknown("main-task-config-missing", { taskId: taskId ?? null });
  }
  if (iface === "gs.actCyclicNote.recvTaskRwd") {
    const taskId = currentCyclicNoteTaskId(syncValue, arg);
    const task = config.cyclicNotes.get(taskId);
    return task
      ? known(task.experienceReward, "cyclic-note-config", { taskId })
      : unknown("cyclic-note-config-missing", { taskId: taskId ?? null });
  }
  if (iface === "gs.actCyclicStory.recvOrderRwd") {
    return estimateCyclicStoryOrder(arg, syncValue, config);
  }
  return unknown("unsupported-experience-interface", { iface });
}

export function evaluateExperienceAction({
  account,
  estimate,
  thresholdPercent = DEFAULT_EXPERIENCE_GUARD_THRESHOLD_PERCENT,
} = {}) {
  const currentExp = toFiniteNumber(account?.currentExp, null);
  const requiredExp = toFiniteNumber(account?.requiredExp, null);
  const maxExp = toFiniteNumber(estimate?.maxExp, null);
  const accountKnown = account?.known !== false
    && currentExp != null
    && requiredExp != null
    && requiredExp > 0;
  if (!accountKnown) {
    return {
      blocked: true,
      reason: "account-experience-unknown",
      currentExp,
      requiredExp,
      maxExp,
    };
  }
  if (estimate?.known !== true || maxExp == null || maxExp < 0) {
    return {
      blocked: true,
      reason: "experience-estimate-unknown",
      currentExp,
      requiredExp,
      maxExp,
    };
  }
  const projectedExp = currentExp + maxExp;
  const threshold = calculateExperienceGuardThreshold(requiredExp, thresholdPercent);
  const blocked = thresholdPercent > 0
    && maxExp > 0
    && projectedExp >= threshold.protectionLimitExp;
  return {
    blocked,
    reason: blocked
      ? "experience-protection-boundary"
      : "experience-space-available",
    currentExp,
    requiredExp,
    remainingExp: Math.max(0, requiredExp - currentExp),
    remainingToProtectionExp: Math.max(
      0,
      threshold.protectionLimitExp - currentExp,
    ),
    ...threshold,
    maxExp,
    projectedExp,
  };
}
