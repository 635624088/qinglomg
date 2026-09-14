import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { loadOrderCustomerNpcConfig } from "./order-state.mjs";
import {
  estimateExperienceAction,
  loadExperienceSettlementConfig,
} from "./experience-settlement.mjs";

const EXPERIENCE_ITEM_ID = 2;
const ORDER_EXPERIENCE_SKILL_TYPE = 2;
const DEFAULT_BASELINE_PATH = path.resolve("runtime/game-data/versions/6899c/g-data.6899c.text");
const DEFAULT_CANDIDATE_PATH = path.resolve("runtime/game-data/candidates/411-0-10-f0e8e/g-data.f0e8e.text");

function getArgument(args, name, fallback = null) {
  const prefix = `${name}=`;
  const inline = args.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || fallback : fallback;
}

function parseDataVersion(filePath, fallback) {
  const match = path.basename(filePath).match(/^g-data\.([0-9a-f]+)\.text$/i);
  return match?.[1] || fallback;
}

async function readFileEvidence(filePath) {
  const buffer = await fsp.readFile(filePath);
  return {
    file: path.basename(filePath),
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}

function sortedIds(map) {
  return [...(map?.keys?.() || [])]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
}

function artSignature(config, artId) {
  const art = config.flowerArts.get(artId);
  return {
    cPrice2: art?.experiencePrice ?? null,
    cPrice2Known: art?.experiencePriceKnown === true,
    flowerIds: art?.flowerIds || [],
    flowerExp: (art?.flowerIds || []).map((flowerId) => ({
      flowerId,
      exp: config.flowers.get(flowerId)?.experience ?? null,
    })),
  };
}

function summarizeArt(config, artId) {
  const art = config.flowerArts.get(artId);
  if (!art) return null;
  return {
    artId,
    cPriceItemId: EXPERIENCE_ITEM_ID,
    cPrice2: art.experiencePrice,
    cPrice2Known: art.experiencePriceKnown === true,
    flowerIds: art.flowerIds || [],
    flowers: (art.flowerIds || []).map((flowerId) => ({
      flowerId,
      exp: config.flowers.get(flowerId)?.experience ?? null,
    })),
  };
}

function customerSync(artId, quantity, nobleState) {
  const syncValue = {
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          1: { artId, num: quantity },
        },
      },
    },
  };
  if (nobleState === "known-none") syncValue.rchgTot = { cardMap: {} };
  return syncValue;
}

function estimateCustomer(config, artId, quantity, nobleState = "known-none") {
  const result = estimateExperienceAction({
    iface: "gs.orderCustomer.finishOrder",
    arg: { npcId: 1 },
    syncValue: customerSync(artId, quantity, nobleState),
    config,
  });
  return {
    known: result.known,
    minExp: result.minExp,
    maxExp: result.maxExp,
    source: result.source,
    details: result.details,
  };
}

function summarizeNoSkillNoNoble(config) {
  const values = [];
  let unknownCount = 0;
  for (const artId of sortedIds(config.flowerArts)) {
    const result = estimateCustomer(config, artId, 1, "known-none");
    if (result.known) values.push(result.maxExp);
    else unknownCount += 1;
  }
  return {
    artCount: config.flowerArts.size,
    knownCount: values.length,
    unknownCount,
    sumForQuantityOne: values.reduce((sum, value) => sum + value, 0),
    minForQuantityOne: values.length ? Math.min(...values) : null,
    maxForQuantityOne: values.length ? Math.max(...values) : null,
  };
}

function compareArts(baselineConfig, candidateConfig) {
  const ids = new Set([
    ...sortedIds(baselineConfig.flowerArts),
    ...sortedIds(candidateConfig.flowerArts),
  ]);
  const changed = [];
  for (const artId of [...ids].sort((left, right) => left - right)) {
    const before = artSignature(baselineConfig, artId);
    const after = artSignature(candidateConfig, artId);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changed.push({ artId, baseline: before, candidate: after });
    }
  }
  return {
    comparedCount: ids.size,
    changedCount: changed.length,
    changed,
  };
}

function estimatePalaceWithMissingSuit(config, flowerId) {
  if (!flowerId) return null;
  const result = estimateExperienceAction({
    iface: "gs.orderPalace.finishOrder",
    syncValue: {
      orderPalaceTot: {
        orderPalace: { flowerId, num: 1 },
      },
      rchgTot: { cardMap: {} },
    },
    config,
  });
  return {
    known: result.known,
    source: result.source,
    details: result.details,
  };
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fsp.rename(tempPath, filePath);
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const baselinePath = path.resolve(getArgument(args, "--baseline", DEFAULT_BASELINE_PATH));
  const candidatePath = path.resolve(getArgument(args, "--candidate", DEFAULT_CANDIDATE_PATH));
  const outputPath = path.resolve(getArgument(
    args,
    "--output",
    path.join(path.dirname(candidatePath), "customer-order-profit-analysis.json"),
  ));
  const baselineVersion = getArgument(args, "--baseline-version", parseDataVersion(baselinePath, "6899c"));
  const candidateVersion = getArgument(args, "--candidate-version", parseDataVersion(candidatePath, "f0e8e"));

  const [baselineEvidence, candidateEvidence] = await Promise.all([
    readFileEvidence(baselinePath),
    readFileEvidence(candidatePath),
  ]);
  const baselineConfig = loadExperienceSettlementConfig(baselinePath);
  const candidateConfig = loadExperienceSettlementConfig(candidatePath);
  if (!baselineConfig.compatible || !candidateConfig.compatible) {
    throw new Error(JSON.stringify({
      baselineReasons: baselineConfig.reasons,
      candidateReasons: candidateConfig.reasons,
    }));
  }

  const baselineNpc = loadOrderCustomerNpcConfig(baselinePath);
  const candidateNpc = loadOrderCustomerNpcConfig(candidatePath);
  const candidateArtIds = sortedIds(candidateConfig.flowerArts);
  const sampleArtId = candidateArtIds.includes(302920) ? 302920 : candidateArtIds[0] || null;
  const sampleFlowerId = sampleArtId
    ? candidateConfig.flowerArts.get(sampleArtId)?.flowerIds?.[0] || null
    : null;
  const sample = sampleArtId == null
    ? null
    : {
        art: {
          baseline: summarizeArt(baselineConfig, sampleArtId),
          candidate: summarizeArt(candidateConfig, sampleArtId),
        },
        quantityOneKnownNoNoble: estimateCustomer(candidateConfig, sampleArtId, 1, "known-none"),
        quantityThreeKnownNoNoble: estimateCustomer(candidateConfig, sampleArtId, 3, "known-none"),
        missingNobleState: estimateCustomer(candidateConfig, sampleArtId, 1, "missing"),
        palaceMissingSuitState: estimatePalaceWithMissingSuit(candidateConfig, sampleFlowerId),
      };

  const result = {
    schemaVersion: 1,
    analysisKind: "offline-customer-order-profit",
    generatedAt: new Date().toISOString(),
    inputs: {
      baseline: { dataVersion: baselineVersion, ...baselineEvidence },
      candidate: { dataVersion: candidateVersion, ...candidateEvidence },
    },
    dataFacts: {
      cOrderCustomerNpc: {
        baselineNpcMaxDay: baselineNpc.npcMaxDay,
        candidateNpcMaxDay: candidateNpc.npcMaxDay,
        candidateNpcIds: candidateNpc.npcIds,
      },
      cPriceExperienceItemId: EXPERIENCE_ITEM_ID,
      flowerExperienceField: "c_flower.exp",
      cultivationSkillType: ORDER_EXPERIENCE_SKILL_TYPE,
      configuredMonthCardExpAdd: candidateConfig.monthCardExpAdd,
      artComparison: compareArts(baselineConfig, candidateConfig),
    },
    officialFormula: {
      baseReward: "c_flowerArt.cPrice 中 itemId=2 的 amount",
      skillReward: "sum(max(round(c_flower.exp * cultivateSkill.effects[2] * 1.68 / (1 + nobleExpAdd)), 1))",
      totalReward: "round((cPrice[2] + skillReward) * quantity)",
      nobleReward: "nobleExpAdd 只进入 type 2 技能项；活跃贵族时取 c_monthCard.$expAdd / 10000",
      currentOfflineSkillInput: "未注入 cultivateTot.cultivateMap，因此 skillValue=0；非零技能结果仅可作为条件公式，不能写成真实订单收益",
    },
    results: {
      baselineNoSkillNoNoble: summarizeNoSkillNoNoble(baselineConfig),
      candidateNoSkillNoNoble: summarizeNoSkillNoNoble(candidateConfig),
      sample,
    },
    failClosed: {
      customerMissingNobleState: sample?.missingNobleState || null,
      palaceMissingSuitState: sample?.palaceMissingSuitState || null,
      realBusinessCalls: false,
      activePointerChanges: false,
    },
  };
  await writeJsonAtomic(outputPath, result);
  console.log(JSON.stringify({ outputPath, ...result }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
