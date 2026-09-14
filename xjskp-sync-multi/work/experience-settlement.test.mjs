import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateExperienceGuardThreshold,
  classifyExperienceInterface,
  EXPERIENCE_GUARD_REMAINING_RATE,
  estimateExperienceAction,
  evaluateExperienceAction,
  loadExperienceSettlementConfig,
} from "./experience-settlement.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

const CONFIG_PATH = getDefaultStaticConfigPath();

function syncWithAccount({
  currentExp = 100,
  requiredExp = 1_000,
  noble = false,
} = {}) {
  return {
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: currentExp,
        nextExp: requiredExp,
      },
    },
    rchgTot: {
      cardMap: noble
        ? {
            1: {
              isMain: true,
            },
          }
        : {},
    },
  };
}

test("estimateExperienceAction keeps the exact 345 satin calculation", () => {
  const estimate = estimateExperienceAction({
    iface: "gs.orderFlower.finishSatinOrder",
    arg: {},
    syncValue: {
      ...syncWithAccount(),
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23003, 2], [23122, 3], [23002, 1]],
            finishCnt: 12,
            isVideo: 0,
            cTime: "2026-09-01T14:00:00.000Z",
            cdTime: "2026-09-01T14:00:00.000Z",
          },
        },
      },
    },
    config: loadExperienceSettlementConfig(CONFIG_PATH),
  });

  assert.equal(estimate.known, true);
  assert.equal(estimate.maxExp, 345);
});

test("classifyExperienceInterface matches the current client settlement points", () => {
  for (const iface of [
    "gs.usrLand.harvest",
    "gs.usrLand.harvestOneKey",
    "gs.orderFlower.finishOrder",
    "gs.orderFlower.finishSatinOrder",
    "gs.orderFlower.finishDecorateOrder",
    "gs.orderCustomer.finishOrder",
    "gs.orderPalace.finishOrder",
    "gs.orderTeam.recvRwd",
  ]) {
    assert.equal(classifyExperienceInterface(iface).kind, "direct");
  }

  for (const iface of [
    "gs.taskMain.recv",
    "gs.actCyclicNote.recvTaskRwd",
    "gs.actCyclicStory.recvOrderRwd",
  ]) {
    assert.equal(classifyExperienceInterface(iface).kind, "conditional");
  }

  for (const iface of [
    "gs.usrLand.plant",
    "gs.usrLand.water",
    "gs.orderCustomer.genOrder",
    "gs.flowerArt.makeFlowerArt",
    "gs.flowerRack.recvSellMoney",
    "gs.fmlLand.harvest",
    "gs.freeWater.recv",
    "gs.pearlPlace.recv",
    "gs.shopCultivate.buy",
    "gs.cultivate.upgrade",
    "gs.waterwheel.recv",
    "gs.usr.lazySync",
    "gs.orderTeam.takeOrder",
    "gs.orderTeam.takeStoredOrder",
    "gs.orderTeam.refreshOrder",
    "gs.orderTeam.storeOrder",
    "gs.orderTeam.submitOrder",
    "gs.actCyclicStory.enter",
  ]) {
    assert.equal(classifyExperienceInterface(iface).kind, "none");
  }

  assert.equal(classifyExperienceInterface("gs.pearl.draw").kind, "unknown");
  assert.equal(classifyExperienceInterface("gs.future.newReward").kind, "unknown");
});

test("loadExperienceSettlementConfig decodes the current experience contract", () => {
  const config = loadExperienceSettlementConfig(CONFIG_PATH);

  assert.match(CONFIG_PATH, /g-data\.[0-9a-f]+\.text$/i);
  assert.equal(config.compatible, true);
  assert.equal(config.flowers.size > 500, true);
  assert.equal(config.flowers.has(23_603), true);
  assert.equal(config.flowerArts.size, 1_446);
  assert.equal(config.monthCardExpAdd, 0.25);
  assert.equal(config.flowerLevelCfg.get(1).harvestExp, 20);
  assert.equal(config.flowerLevelExact.get("2310801").harvestExp, 20);
  assert.equal(config.flowerArts.get(302920).experiencePrice, 361);
  assert.equal(config.mainTasks.get(310001).experienceReward, 200);
  assert.equal(config.mainTasks.get(400001).experienceReward, 400);
  assert.equal(
    [...config.cyclicNotes.values()].some((row) => row.experienceReward > 0),
    false,
  );
  assert.equal(config.cyclicStories.get(1).cost, 80);
  assert.equal(config.cyclicStory.expOrderMax, 400);
  assert.equal(config.cyclicStory.expValue, 1.25);
  assert.equal(config.teamOrder.rewardBaseExperience, 8_000);
  assert.deepEqual(config.fashionSuits.get(10040), {
    id: 10040,
    unitIds: [
      11050040,
      12150040,
      12250040,
      13050040,
      14050040,
      15050040,
    ],
    triggerAttributeId: 114,
    triggerLimit: 1,
    experienceAdd: 0.5,
  });
});

test("estimateExperienceAction predicts one land harvest from exact flower level config", () => {
  const config = loadExperienceSettlementConfig(CONFIG_PATH);
  const syncValue = {
    ...syncWithAccount({ noble: true }),
    usrLandTot: {
      usrLand: {
        landMap: {
          1001: { flowerId: 23108, state: 3 },
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23108: { flowerId: 23108, lvl: 1 },
      },
    },
  };

  assert.deepEqual(
    estimateExperienceAction({
      iface: "gs.usrLand.harvest",
      arg: { landId: 1001 },
      syncValue,
      config,
    }),
    {
      known: true,
      minExp: 20,
      maxExp: 25,
      source: "flower-level-harvest-exp",
      details: {
        landId: 1001,
        flowerId: 23108,
        flowerLevel: 1,
        baseExp: 20,
        flowerSkillExpAdd: 0,
        globalExpAdd: 0.25,
        configSource: "exact",
      },
    },
  );
});

test("estimateExperienceAction includes flower advance experience skill in one land harvest", () => {
  const config = loadExperienceSettlementConfig(CONFIG_PATH);
  const syncValue = {
    ...syncWithAccount(),
    usrLandTot: {
      usrLand: {
        landMap: {
          1002: { flowerId: 23105, state: 3 },
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23105: {
          flowerId: 23105,
          lvl: 18,
          advanceSlotMap: {
            1: { slotId: 1, skillId: 2009 },
          },
        },
      },
    },
  };

  assert.deepEqual(
    estimateExperienceAction({
      iface: "gs.usrLand.harvest",
      arg: { landId: 1002 },
      syncValue,
      config,
    }),
    {
      known: true,
      minExp: 22,
      maxExp: 22,
      source: "flower-level-harvest-exp",
      details: {
        landId: 1002,
        flowerId: 23105,
        flowerLevel: 18,
        baseExp: 20,
        flowerSkillExpAdd: 0.09,
        globalExpAdd: 0,
        configSource: "exact",
      },
    },
  );
});

test("estimateExperienceAction refuses one-key harvest without per-land expansion", () => {
  const estimate = estimateExperienceAction({
    iface: "gs.usrLand.harvestOneKey",
    arg: {},
    syncValue: syncWithAccount(),
    config: loadExperienceSettlementConfig(CONFIG_PATH),
  });

  assert.equal(estimate.known, false);
  assert.equal(estimate.requiresPerLand, true);
  assert.equal(estimate.source, "harvest-one-key-requires-per-land");
});

test("estimateExperienceAction predicts ordinary resident order with flower skill", () => {
  const config = loadExperienceSettlementConfig(CONFIG_PATH);
  const syncValue = {
    ...syncWithAccount(),
    orderFlowerTot: {
      orderFlower: {
        orderMap: {
          8: {
            boxId: 8,
            flowers: [[23001, 2]],
          },
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: {
          flowerId: 23001,
          lvl: 1,
          advanceSlotMap: {
            1: { slotId: 1, skillId: 2001 },
          },
        },
      },
    },
  };

  const estimate = estimateExperienceAction({
    iface: "gs.orderFlower.finishOrder",
    arg: { boxId: 8 },
    syncValue,
    config,
  });

  assert.equal(estimate.known, true);
  assert.equal(estimate.maxExp, 52);
  assert.equal(estimate.source, "resident-order-config");
  assert.equal(estimate.details.iface, "gs.orderFlower.finishOrder");
  assert.equal(estimate.details.nobleAdd, 0);
  assert.equal(estimate.details.flowerSkillApplied, true);
  assert.deepEqual(
    estimate.details.rows.map(({ flowerId, count }) => ({ flowerId, count })),
    [{ flowerId: 23001, count: 2 }],
  );
});

test("estimateExperienceAction applies cultivation experience skill to satin and decorate orders", () => {
  const config = loadExperienceSettlementConfig(CONFIG_PATH);
  const syncValue = {
    ...syncWithAccount(),
    orderFlowerTot: {
      orderFlower: {
        orderSatin: {
          flowers: [[23001, 2]],
        },
        orderDecorate: {
          flowers: [[23001, 2]],
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: {
          flowerId: 23001,
          lvl: 1,
          advanceSlotMap: {
            1: { slotId: 1, skillId: 2001 },
          },
        },
      },
    },
  };

  for (const iface of [
    "gs.orderFlower.finishSatinOrder",
    "gs.orderFlower.finishDecorateOrder",
  ]) {
    const estimate = estimateExperienceAction({
      iface,
      arg: {},
      syncValue,
      config,
    });

    assert.equal(estimate.known, true, iface);
    assert.equal(estimate.maxExp, 52, iface);
    assert.equal(estimate.source, "resident-order-config", iface);
    assert.equal(estimate.details.iface, iface);
    assert.equal(estimate.details.nobleAdd, 0);
    assert.equal(estimate.details.flowerSkillApplied, true, iface);
    assert.deepEqual(
      estimate.details.rows.map(({
        flowerId,
        count,
        skillValue,
        skillExp,
      }) => ({
        flowerId,
        count,
        hasCultivationExperienceSkill: skillValue > 0,
        skillExp,
      })),
      [{
        flowerId: 23001,
        count: 2,
        hasCultivationExperienceSkill: true,
        skillExp: 1,
      }],
      iface,
    );
  }
});

test("estimateExperienceAction preserves official per-component rounding across noble additions", () => {
  const baseConfig = loadExperienceSettlementConfig(CONFIG_PATH);
  for (const [nobleAdd, expectedMaxExp] of [[0, 52], [0.25, 65], [0.5, 78]]) {
    const estimate = estimateExperienceAction({
      iface: "gs.orderFlower.finishSatinOrder",
      arg: {},
      config: { ...baseConfig, monthCardExpAdd: nobleAdd },
      syncValue: {
        ...syncWithAccount({ noble: nobleAdd > 0 }),
        orderFlowerTot: { orderFlower: { orderSatin: { flowers: [[23001, 2]] } } },
        cultivateTot: { cultivateMap: {
          23001: {
            flowerId: 23001,
            lvl: 1,
            advanceSlotMap: { 1: { slotId: 1, skillId: 2001 } },
          },
        } },
      },
    });
    assert.equal(estimate.known, true);
    assert.equal(estimate.details.nobleAdd, nobleAdd);
    assert.equal(estimate.maxExp, expectedMaxExp);
  }
});

test("estimateExperienceAction matches calibrated satin and decorate server samples", () => {
  const config = loadExperienceSettlementConfig(CONFIG_PATH);
  const syncValue = {
    ...syncWithAccount(),
    orderFlowerTot: {
      orderFlower: {
        orderSatin: {
          flowers: [[23043, 4], [23017, 1], [23126, 1]],
        },
        orderDecorate: {
          flowers: [[23281, 4], [23009, 2]],
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23126: {
          flowerId: 23126,
          lvl: 17,
          advanceSlotMap: {
            1: { slotId: 1, skillId: 2010 },
          },
        },
        23281: {
          flowerId: 23281,
          lvl: 17,
          advanceSlotMap: {
            1: { slotId: 1, skillId: 2009 },
            2: { slotId: 2, skillId: 4008 },
            3: { slotId: 3, skillId: 2019 },
          },
        },
      },
    },
  };

  for (const [iface, expectedExp, expectedSkillValue, expectedSkillExp] of [
    ["gs.orderFlower.finishSatinOrder", 704, 0.1, 19],
    ["gs.orderFlower.finishDecorateOrder", 828, 0.31, 180],
  ]) {
    const estimate = estimateExperienceAction({
      iface,
      arg: {},
      syncValue,
      config,
    });

    assert.equal(estimate.known, true, iface);
    assert.equal(estimate.maxExp, expectedExp, iface);
    assert.equal(estimate.details.flowerSkillApplied, true, iface);
    assert.equal(
      estimate.details.rows.reduce((sum, row) => sum + row.skillValue, 0),
      expectedSkillValue,
      iface,
    );
    assert.equal(
      estimate.details.rows.reduce(
        (sum, row) => sum + row.skillExp * row.count,
        0,
      ),
      expectedSkillExp,
      iface,
    );
  }
});

test("estimateExperienceAction keeps customer base cPrice[2] separate from noble skill bonus", () => {
  const config = loadExperienceSettlementConfig(CONFIG_PATH);
  const syncValue = {
    ...syncWithAccount({ noble: true }),
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          7: {
            npcId: 7,
            artId: 302920,
            num: 1,
          },
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23229: { flowerId: 23229, lvl: 1 },
        23238: { flowerId: 23238, lvl: 1 },
        23135: { flowerId: 23135, lvl: 1 },
      },
    },
  };

  const estimate = estimateExperienceAction({
    iface: "gs.orderCustomer.finishOrder",
    arg: { npcId: 7 },
    syncValue,
    config,
  });

  assert.equal(estimate.known, true);
  assert.equal(estimate.maxExp, 361);
  assert.equal(estimate.source, "customer-order-config");
  assert.equal(estimate.details.baseExp, 361);
  assert.equal(estimate.details.skillExp, 0);
  assert.equal(estimate.details.quantity, 1);
  assert.equal(estimate.details.nobleAdd, 0.25);
});

test("estimateExperienceAction fails closed for customer order when noble state is absent", () => {
  const estimate = estimateExperienceAction({
    iface: "gs.orderCustomer.finishOrder",
    arg: { npcId: 7 },
    syncValue: {
      orderCustomerTot: {
        orderCustomer: {
          orderMap: { 7: { artId: 9001, num: 1 } },
        },
      },
    },
    config: {
      compatible: true,
      monthCardExpAdd: 0.25,
      flowers: new Map([[101, { id: 101, experience: 10 }]]),
      flowerArts: new Map([[9001, {
        id: 9001,
        experiencePrice: 100,
        experiencePriceKnown: true,
        flowerIds: [101],
      }]]),
      flowerAdvanceSkillById: new Map(),
    },
  });

  assert.equal(estimate.known, false);
  assert.equal(estimate.source, "customer-order-noble-state-unknown");
});

test("estimateExperienceAction calculates customer skill experience per component flower", () => {
  const config = {
    compatible: true,
    monthCardExpAdd: 0.25,
    flowers: new Map([
      [101, { id: 101, experience: 10 }],
      [102, { id: 102, experience: 100 }],
    ]),
    flowerArts: new Map([
      [9001, {
        id: 9001,
        experiencePrice: 300,
        flowerIds: [101, 102],
      }],
    ]),
    flowerAdvanceSkillById: new Map([
      ["7001", {
        id: 7001,
        skillType: 2,
        valueType: 2,
        value1: 1_000,
      }],
      ["7002", {
        id: 7002,
        skillType: 2,
        valueType: 2,
        value1: 2_000,
      }],
    ]),
  };
  const syncValue = {
    ...syncWithAccount({ noble: true }),
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          7: {
            npcId: 7,
            artId: 9001,
            num: 2,
          },
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        101: {
          flowerId: 101,
          advanceSlotMap: {
            1: { slotId: 1, skillId: 7001 },
          },
        },
        102: {
          flowerId: 102,
          advanceSlotMap: {
            1: { slotId: 1, skillId: 7002 },
          },
        },
      },
    },
  };

  const estimate = estimateExperienceAction({
    iface: "gs.orderCustomer.finishOrder",
    arg: { npcId: 7 },
    syncValue,
    config,
  });

  assert.equal(estimate.known, true);
  assert.equal(estimate.maxExp, 656);
  assert.deepEqual(
    estimate.details.skillRows.map((row) => ({
      flowerId: row.flowerId,
      baseExp: row.baseExp,
      skillValue: row.skillValue,
      skillExp: row.skillExp,
    })),
    [
      { flowerId: 101, baseExp: 10, skillValue: 0.1, skillExp: 1 },
      { flowerId: 102, baseExp: 100, skillValue: 0.2, skillExp: 27 },
    ],
  );
});

test("estimateExperienceAction fails closed for palace order when suit state is absent", () => {
  const estimate = estimateExperienceAction({
    iface: "gs.orderPalace.finishOrder",
    syncValue: {
      orderPalaceTot: {
        orderPalace: { flowerId: 101, num: 1 },
      },
      rchgTot: { cardMap: {} },
    },
    config: {
      compatible: true,
      monthCardExpAdd: 0,
      flowers: new Map([[101, { id: 101, experience: 100 }]]),
      flowerArts: new Map(),
      flowerAdvanceSkillById: new Map(),
      fashionSuits: new Map([[10040, {
        id: 10040,
        unitIds: [11050040],
        triggerAttributeId: 114,
        triggerLimit: 1,
        experienceAdd: 0.5,
      }]]),
    },
  });

  assert.equal(estimate.known, false);
  assert.equal(estimate.source, "palace-order-state-unknown");
});

test("estimateExperienceAction uses additive palace bonuses and real fashion sync state", () => {
  const nowMs = Date.parse("2026-07-29T08:00:00.000Z");
  const unitIds = [11050040, 12150040];
  const config = {
    compatible: true,
    monthCardExpAdd: 0.25,
    flowers: new Map([
      [101, { id: 101, experience: 100 }],
    ]),
    flowerArts: new Map(),
    flowerAdvanceSkillById: new Map([
      ["7002", {
        id: 7002,
        skillType: 2,
        valueType: 2,
        value1: 2_000,
      }],
    ]),
    fashionSuits: new Map([
      [10040, {
        id: 10040,
        unitIds,
        triggerAttributeId: 114,
        triggerLimit: 1,
        experienceAdd: 0.5,
      }],
    ]),
  };
  const syncValue = {
    ...syncWithAccount({ noble: true }),
    orderPalaceTot: {
      orderPalace: {
        flowerId: 101,
        num: 2,
      },
    },
    cultivateTot: {
      cultivateMap: {
        101: {
          flowerId: 101,
          advanceSlotMap: {
            1: { slotId: 1, skillId: 7002 },
          },
        },
      },
    },
    fashionTot: {
      fashionMap: {
        10040: {
          fashionId: 10040,
          triggerRcd: {
            114: {
              count: 0,
              ltTime: "2026-07-29T07:00:00.000Z",
            },
          },
        },
      },
      fashionUnitMap: Object.fromEntries(
        unitIds.map((unitId) => [unitId, {
          tempId: unitId,
          cTime: "2026-07-01T00:00:00.000Z",
        }]),
      ),
    },
  };

  const estimate = estimateExperienceAction({
    iface: "gs.orderPalace.finishOrder",
    syncValue,
    config,
    nowMs,
  });

  assert.equal(estimate.known, true);
  assert.equal(estimate.maxExp, 390);
  assert.equal(estimate.details.baseTotalExp, 200);
  assert.equal(estimate.details.skillValue, 0.2);
  assert.equal(estimate.details.nobleAdd, 0.25);
  assert.equal(estimate.details.suitExpAdd, 0.5);
});

test("estimateExperienceAction predicts team reward and configured task rewards", () => {
  const config = loadExperienceSettlementConfig(CONFIG_PATH);
  const team = estimateExperienceAction({
    iface: "gs.orderTeam.recvRwd",
    arg: {},
    syncValue: {
      ...syncWithAccount(),
      orderTeamTot: {
        orderTeam: {
          orderNum: 1,
          rwd: { 2: 200 },
        },
      },
    },
    config,
  });
  const mainTask = estimateExperienceAction({
    iface: "gs.taskMain.recv",
    arg: { taskId: 310001 },
    syncValue: syncWithAccount(),
    config,
  });
  const cyclic = estimateExperienceAction({
    iface: "gs.actCyclicNote.recvTaskRwd",
    arg: { taskId: 1001 },
    syncValue: syncWithAccount(),
    config,
  });

  assert.equal(team.maxExp, 8_200);
  assert.equal(mainTask.maxExp, 200);
  assert.equal(cyclic.maxExp, 0);
});

test("estimateExperienceAction predicts cyclic story order experience from official config", () => {
  const config = loadExperienceSettlementConfig(CONFIG_PATH);
  const makeStorySync = (expOrderNum) => ({
    ...syncWithAccount(),
    actTot: {
      map: {
        99001: {
          batchId: 99001,
          tmpType: 4003,
          phase: 2,
          ext: {
            cyclicStory: {
              expOrderNum,
              orderInfo: {
                0: { orderId: 1, flowerId: 23001, validTime: Date.now() - 1 },
              },
            },
          },
        },
      },
    },
  });

  const earning = estimateExperienceAction({
    iface: "gs.actCyclicStory.recvOrderRwd",
    arg: { batchId: 99001, orderIdx: 0 },
    syncValue: makeStorySync(399),
    config,
  });
  const exhausted = estimateExperienceAction({
    iface: "gs.actCyclicStory.recvOrderRwd",
    arg: { batchId: 99001, orderIdx: 0 },
    syncValue: makeStorySync(400),
    config,
  });

  assert.equal(earning.known, true);
  assert.equal(earning.maxExp, 2_500);
  assert.equal(earning.source, "cyclic-story-order-config");
  assert.deepEqual(earning.details, {
    batchId: 99001,
    orderIdx: 0,
    orderId: 1,
    flowerId: 23001,
    flowerExperience: 25,
    cost: 80,
    expOrderNum: 399,
    expOrderMax: 400,
    expValue: 1.25,
  });
  assert.equal(exhausted.known, true);
  assert.equal(exhausted.maxExp, 0);
});

test("calculateExperienceGuardThreshold reserves 0.5 percent of the level requirement", () => {
  assert.equal(EXPERIENCE_GUARD_REMAINING_RATE, 0.005);
  assert.deepEqual(calculateExperienceGuardThreshold(100_000), {
    thresholdPercent: 0.5,
    thresholdRemainingExp: 500,
    protectionLimitExp: 99_500,
  });
  assert.deepEqual(calculateExperienceGuardThreshold(1_001), {
    thresholdPercent: 0.5,
    thresholdRemainingExp: 6,
    protectionLimitExp: 995,
  });
});

test("calculateExperienceGuardThreshold accepts a user percentage with two decimal precision", () => {
  assert.deepEqual(calculateExperienceGuardThreshold(100_000, 0), {
    thresholdPercent: 0,
    thresholdRemainingExp: 0,
    protectionLimitExp: 100_000,
  });
  assert.deepEqual(calculateExperienceGuardThreshold(100_000, 0.01), {
    thresholdPercent: 0.01,
    thresholdRemainingExp: 10,
    protectionLimitExp: 99_990,
  });
  assert.deepEqual(calculateExperienceGuardThreshold(1_001, 1.25), {
    thresholdPercent: 1.25,
    thresholdRemainingExp: 13,
    protectionLimitExp: 988,
  });
  assert.deepEqual(calculateExperienceGuardThreshold(1_000, 100.01), {
    thresholdPercent: 100.01,
    thresholdRemainingExp: 1_001,
    protectionLimitExp: -1,
  });
});

test("calculateExperienceGuardThreshold rejects invalid user percentages", () => {
  for (const thresholdPercent of [0.001, 0.009, 0.011, -1, NaN, Infinity, "0.5"]) {
    assert.throws(
      () => calculateExperienceGuardThreshold(100_000, thresholdPercent),
      (error) => error?.code === "INVALID_EXPERIENCE_GUARD_THRESHOLD_PERCENT",
    );
  }
});

test("evaluateExperienceAction uses a strict 0.5 percent protection boundary", () => {
  assert.equal(evaluateExperienceAction({
    account: { known: true, currentExp: 900, requiredExp: 1_000 },
    estimate: { known: true, maxExp: 94 },
  }).blocked, false);

  const equality = evaluateExperienceAction({
    account: { known: true, currentExp: 900, requiredExp: 1_000 },
    estimate: { known: true, maxExp: 95 },
  });
  assert.equal(equality.blocked, true);
  assert.equal(equality.reason, "experience-protection-boundary");
  assert.equal(equality.thresholdPercent, 0.5);
  assert.equal(equality.thresholdRemainingExp, 5);
  assert.equal(equality.protectionLimitExp, 995);

  assert.equal(evaluateExperienceAction({
    account: { known: true, currentExp: 900, requiredExp: 1_000 },
    estimate: { known: false, maxExp: null },
  }).blocked, true);
});

test("evaluateExperienceAction disables the boundary entirely at 0 percent", () => {
  const crossing = evaluateExperienceAction({
    account: { known: true, currentExp: 999_000, requiredExp: 1_000_000 },
    estimate: { known: true, maxExp: 2_000 },
    thresholdPercent: 0,
  });
  assert.equal(crossing.blocked, false);
  assert.equal(crossing.reason, "experience-space-available");
  assert.equal(crossing.thresholdRemainingExp, 0);
  assert.equal(crossing.protectionLimitExp, 1_000_000);

  assert.equal(evaluateExperienceAction({
    account: { known: true, currentExp: 900, requiredExp: 1_000 },
    estimate: { known: true, maxExp: 200 },
    thresholdPercent: 0,
  }).blocked, false);

  assert.equal(evaluateExperienceAction({
    account: { known: false, currentExp: null, requiredExp: 1_000 },
    estimate: { known: true, maxExp: 10 },
    thresholdPercent: 0,
  }).blocked, true);

  assert.equal(evaluateExperienceAction({
    account: { known: true, currentExp: 900, requiredExp: 1_000 },
    estimate: { known: false, maxExp: null },
    thresholdPercent: 0,
  }).blocked, true);
});

test("evaluateExperienceAction applies the configured percentage at the strict boundary", () => {
  assert.equal(evaluateExperienceAction({
    account: { known: true, currentExp: 900, requiredExp: 1_000 },
    estimate: { known: true, maxExp: 86 },
    thresholdPercent: 1.25,
  }).blocked, false);

  const equality = evaluateExperienceAction({
    account: { known: true, currentExp: 900, requiredExp: 1_000 },
    estimate: { known: true, maxExp: 87 },
    thresholdPercent: 1.25,
  });
  assert.equal(equality.blocked, true);
  assert.equal(equality.thresholdPercent, 1.25);
  assert.equal(equality.thresholdRemainingExp, 13);
  assert.equal(equality.protectionLimitExp, 987);
  assert.equal(equality.remainingToProtectionExp, 87);
});

test("evaluateExperienceAction allows a known zero-experience action at the protection line", () => {
  const decision = evaluateExperienceAction({
    account: { known: true, currentExp: 995, requiredExp: 1_000 },
    estimate: { known: true, maxExp: 0 },
  });

  assert.equal(decision.blocked, false);
  assert.equal(decision.reason, "experience-space-available");
  assert.equal(decision.projectedExp, 995);
  assert.equal(decision.protectionLimitExp, 995);
});
