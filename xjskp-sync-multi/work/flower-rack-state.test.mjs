import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FLOWER_RACK_IFACES,
  TARGET_FLOWER_RACK_ART_ID,
  attachFlowerRackRecommendations,
  summarizeFlowerRackRecommendations,
  summarizeFlowerRackStatus,
} from "./flower-rack-state.mjs";

const EXPECTED_DEFAULT_RACK_ART_ID = 301722;

function makeSync({
  nowMs = Date.parse("2026-06-16T02:00:00.000Z"),
  doubleGoldRemainingMs = 10 * 60 * 1000,
  targetArtCount = 72,
  rackMap = {},
} = {}) {
  return {
    videoDouble: {
      eTime: new Date(nowMs + doubleGoldRemainingMs).toISOString(),
    },
    $usrTot: {
      data: {
        bag: {
          [EXPECTED_DEFAULT_RACK_ART_ID]: targetArtCount,
        },
      },
    },
    flowerRackTot: {
      flowerRackMap: rackMap,
    },
  };
}

function matureRackMap(nowMs, count = 6) {
  const start = new Date(nowMs - (12 * 240 + 60) * 1000).toISOString();
  return Object.fromEntries(Array.from({ length: count }, (_, idx) => {
    const rackId = idx + 1;
    return [rackId, {
      rackId,
      iid: 300101,
      num: 12,
      sellStartTime: start,
    }];
  }));
}

function recommendationFixture() {
  const flowerArtConfig = {
    arts: {
      301000: { id: 301000, vaseId: 5001, flowerIds: [23099], sPrice: [11, 1000] },
      301001: { id: 301001, vaseId: 5001, flowerIds: [23001], sPrice: [2, 999] },
      301002: { id: 301002, vaseId: 5001, flowerIds: [23001, 23003], sPrice: [11, 700] },
      301003: { id: 301003, vaseId: 5001, flowerIds: [23003, 23001], sPrice: [11, 700] },
      301004: { id: 301004, vaseId: 5001, flowerIds: [23002, 23004], sPrice: [11, 600] },
      301005: { id: 301005, vaseId: 5001, flowerIds: [23001, 23002], sPrice: [11, 500] },
      301006: { id: 301006, vaseId: 5001, flowerIds: [23001, 23001, 23002], sPrice: [11, 800] },
      301007: { id: 301007, vaseId: 5001, flowerIds: [23002, 23003], sPrice: [11, 400] },
    },
  };
  const itemNameMap = { 5001: "天青瓶" };
  const nameMap = {
    23001: "红玫瑰",
    23002: "黄百合",
    23003: "蓝星花",
    23004: "紫罗兰",
    23099: "未培育花",
  };
  const sync = {
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 2 },
        23002: { flowerId: 23002, lvl: 3 },
        23003: { flowerId: 23003, lvl: 2 },
        23004: { flowerId: 23004, lvl: 4 },
        23099: { flowerId: 23099, lvl: 1 },
      },
    },
  };
  return { flowerArtConfig, itemNameMap, nameMap, sync };
}

test("summarizeFlowerRackRecommendations returns per-account top five gold arts with stable labels", () => {
  const fixture = recommendationFixture();
  const recommendations = summarizeFlowerRackRecommendations(fixture.sync, fixture);

  assert.deepEqual(
    recommendations.map((item) => item.artId),
    [301006, 301002, 301003, 301004, 301005],
  );
  assert.equal(recommendations[0].salePrice, 800);
  assert.equal(recommendations[0].rackGold, 19200);
  assert.equal(
    recommendations[0].label,
    "301006【双倍每架1万9200金币】(天青瓶+红玫瑰x2+黄百合)",
  );
  assert.deepEqual(recommendations[0].flowers, [
    { flowerId: 23001, flowerName: "红玫瑰", need: 2 },
    { flowerId: 23002, flowerName: "黄百合", need: 1 },
  ]);

  const otherAccount = {
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 2 },
        23002: { flowerId: 23002, lvl: 2 },
      },
    },
  };
  assert.deepEqual(
    summarizeFlowerRackRecommendations(otherAccount, fixture).map((item) => item.artId),
    [301006, 301005],
  );
});

test("flower rack gold labels use Chinese four-digit units without duplicated zeroes", () => {
  const recommendations = summarizeFlowerRackRecommendations({
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, cultivated: true },
      },
    },
  }, {
    flowerArtConfig: {
      arts: {
        301100: { id: 301100, vaseId: 5001, flowerIds: [23001], sPrice: [11, 100000001] },
      },
    },
    flowerLevelConfig: { flowerById: new Map(), flowerAdvanceSkillById: new Map() },
    itemNameMap: { 5001: "天青瓶" },
    nameMap: { 23001: "红玫瑰" },
    groupSize: 1,
    recommendationGoldAddRate: 0,
  });

  assert.equal(
    recommendations[0].label,
    "301100【双倍每架1亿零1金币】(天青瓶+红玫瑰)",
  );
});

test("summarizeFlowerRackRecommendations matches the client account-specific flower rack gold formula", () => {
  const flowerArtConfig = {
    arts: {
      301201: { id: 301201, vaseId: 5001, flowerIds: [23001], sPrice: [11, 100] },
      301202: { id: 301202, vaseId: 5001, flowerIds: [23002], sPrice: [11, 200] },
      301203: { id: 301203, vaseId: 5001, flowerIds: [23003], sPrice: null },
    },
  };
  const flowerLevelConfig = {
    flowerById: new Map([
      ["23001", { id: 23001, gld: 100 }],
      ["23002", { id: 23002, gld: 100 }],
      ["23003", { id: 23003, gld: 50 }],
    ]),
    flowerAdvanceSkillById: new Map([
      ["9101", { id: 9101, skillType: 1, valueType: 2, value1: 20000 }],
    ]),
    videoGoldAddRate: 1,
  };
  const common = {
    flowerArtConfig,
    flowerLevelConfig,
    itemNameMap: { 5001: "天青瓶" },
    nameMap: { 23001: "红玫瑰", 23002: "黄百合", 23003: "蓝星花" },
  };
  const skilledAccount = {
    cultivateTot: {
      cultivateMap: {
        23001: {
          flowerId: 23001,
          lvl: 2,
          advanceSlotMap: { 1: { slotId: 1, skillId: 9101 } },
        },
        23002: { flowerId: 23002, lvl: 2 },
        23003: { flowerId: 23003, lvl: 2 },
      },
    },
  };

  const recommendations = summarizeFlowerRackRecommendations(skilledAccount, common);
  assert.deepEqual(recommendations.map((item) => item.artId), [301201, 301202, 301203]);
  assert.equal(recommendations[0].baseSalePrice, 100);
  assert.equal(recommendations[0].skillBonus, 230);
  assert.equal(recommendations[0].salePrice, 330);
  assert.equal(recommendations[0].rackGold, 7920);
  assert.equal(recommendations[0].label, "301201【双倍每架7920金币】(天青瓶+红玫瑰)");
  assert.equal(recommendations[2].baseSalePrice, 115);
  assert.equal(recommendations[2].salePrice, 115);
  assert.equal(recommendations[2].rackGold, 2760);

  const doubleGoldAccount = structuredClone(skilledAccount);
  doubleGoldAccount.videoDouble = { eTime: "2026-06-16T02:10:00.000Z" };
  const duringDoubleGold = summarizeFlowerRackRecommendations(doubleGoldAccount, {
    ...common,
    nowMs: Date.parse("2026-06-16T02:00:00.000Z"),
  });
  assert.equal(duringDoubleGold.find((item) => item.artId === 301201).skillBonus, 230);
  assert.equal(duringDoubleGold.find((item) => item.artId === 301201).rackGold, 7920);

  const unskilledAccount = structuredClone(skilledAccount);
  unskilledAccount.cultivateTot.cultivateMap[23001].advanceSlotMap = {};
  assert.deepEqual(
    summarizeFlowerRackRecommendations(unskilledAccount, common).map((item) => item.artId),
    [301202, 301203, 301201],
  );
});

test("summarizeFlowerRackRecommendations accepts explicit cultivated flags", () => {
  const recommendations = summarizeFlowerRackRecommendations({
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, cultivated: true, lvl: 1 },
      },
    },
  }, {
    flowerArtConfig: {
      arts: {
        301100: { id: 301100, vaseId: 5001, flowerIds: [23001], sPrice: [11, 321] },
      },
    },
    itemNameMap: { 5001: "天青瓶" },
    nameMap: { 23001: "红玫瑰" },
  });

  assert.deepEqual(recommendations.map((item) => item.artId), [301100]);
});

test("flower rack startup recommendations are reused and exposed by status", () => {
  const fixture = recommendationFixture();
  const attached = attachFlowerRackRecommendations(fixture.sync, fixture);
  const cached = attached.$flowerRackRecommendations;
  const reused = attachFlowerRackRecommendations({
    cultivateTot: { cultivateMap: {} },
    $flowerRackRecommendations: cached,
  }, {
    ...fixture,
    flowerArtConfig: { arts: {} },
  });

  assert.strictEqual(reused.$flowerRackRecommendations, cached);
  assert.deepEqual(
    summarizeFlowerRackStatus(reused, { recommendedArts: cached }).recommendedArts,
    cached,
  );
});

test("summarizeFlowerRackStatus collects mature rack gold and shelves six groups of selected Danqing porcelain vase art", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const sync = makeSync({
    nowMs,
    targetArtCount: 72,
    rackMap: matureRackMap(nowMs, 6),
  });

  const status = summarizeFlowerRackStatus(sync, { nowMs, targetArtId: EXPECTED_DEFAULT_RACK_ART_ID });

  assert.equal(status.doubleGoldGate.ready, true);
  assert.equal(TARGET_FLOWER_RACK_ART_ID, EXPECTED_DEFAULT_RACK_ART_ID);
  assert.equal(status.targetArt.artId, EXPECTED_DEFAULT_RACK_ART_ID);
  assert.equal(status.targetArt.name, "丹青瓷瓶：轻紫大花葱 + 蓝叶苏铁 + 粉鹤芋");
  assert.equal(status.targetArt.have, 72);
  assert.equal(status.collectableCount, 6);
  assert.equal(status.sellPlanCount, 6);
  // 6 个空位由单个 sellOneKey 动作一次上架（旧行为是逐槽位 sell）
  const sellActions = status.actions.filter((action) => action.type === "sell");
  assert.equal(sellActions.length, 1);
  assert.equal(sellActions[0].iface, FLOWER_RACK_IFACES.sellOneKey);
  assert.deepEqual(Object.keys(sellActions[0].args.sellMap).map(Number), [1, 2, 3, 4, 5, 6]);
  assert.equal(sellActions[0].num, 72);
});

test("summarizeFlowerRackStatus shelves all six racks with a single sellOneKey action", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const sync = makeSync({
    nowMs,
    targetArtCount: 72,
    rackMap: matureRackMap(nowMs, 6),
  });

  const status = summarizeFlowerRackStatus(sync, { nowMs, targetArtId: EXPECTED_DEFAULT_RACK_ART_ID });

  assert.equal(status.doubleGoldGate.ready, true);
  assert.equal(status.sellPlanCount, 6);
  // 6 个空位应由一个 sellOneKey 动作一次上架（sellMap 含全部 6 槽位）
  const sellActions = status.actions.filter((action) => action.type === "sell");
  assert.equal(sellActions.length, 1);
  assert.equal(sellActions[0].iface, FLOWER_RACK_IFACES.sellOneKey);
  assert.deepEqual(sellActions[0].args, {
    sellMap: {
      1: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
      2: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
      3: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
      4: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
      5: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
      6: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
    },
  });
  assert.equal(sellActions[0].rackId, null);
  assert.equal(sellActions[0].num, 72);
});

test("summarizeFlowerRackStatus keeps shelves that have one occupied rack to five groups via sellOneKey", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  // 6 个花架：5 个可收（空出可上架），1 个仍在售卖（无空位）
  const start = new Date(nowMs - (12 * 240 + 60) * 1000).toISOString();
  const selling = new Date(nowMs - 30 * 1000).toISOString();
  const rackMap = {
    1: { rackId: 1, iid: 300101, num: 12, sellStartTime: start },
    2: { rackId: 2, iid: 300101, num: 12, sellStartTime: start },
    3: { rackId: 3, iid: 300101, num: 12, sellStartTime: start },
    4: { rackId: 4, iid: 300101, num: 12, sellStartTime: start },
    5: { rackId: 5, iid: 300101, num: 12, sellStartTime: start },
    6: { rackId: 6, iid: 300101, num: 12, sellStartTime: selling },
  };
  const sync = makeSync({
    nowMs,
    targetArtCount: 72,
    rackMap,
  });

  const status = summarizeFlowerRackStatus(sync, { nowMs, targetArtId: EXPECTED_DEFAULT_RACK_ART_ID });

  // 5 个空位可上架：sellOneKey 覆盖 5 槽位（不因第 6 个售卖而降组到 0）
  assert.equal(status.collectableCount, 5);
  assert.equal(status.sellPlanCount, 5);
  const sellActions = status.actions.filter((action) => action.type === "sell");
  assert.equal(sellActions.length, 1);
  assert.equal(sellActions[0].iface, FLOWER_RACK_IFACES.sellOneKey);
  assert.deepEqual(Object.keys(sellActions[0].args.sellMap).map(Number), [1, 2, 3, 4, 5]);
});

test("summarizeFlowerRackStatus only collects mature rack gold when no target art is configured", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const sync = makeSync({
    nowMs,
    targetArtCount: 72,
    rackMap: matureRackMap(nowMs, 3),
  });

  const status = summarizeFlowerRackStatus(sync, { nowMs });

  assert.equal(status.targetArt.enabled, false);
  assert.equal(status.targetArt.artId, null);
  assert.equal(status.collectableCount, 3);
  assert.equal(status.sellPlanCount, 0);
  assert.deepEqual(status.actions.map((action) => action.type), [
    "recvSellMoney",
    "recvSellMoney",
    "recvSellMoney",
  ]);
});

test("summarizeFlowerRackStatus shelves the selected preset flower rack art", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  for (const artId of [305101, 301722, 302003]) {
    const sync = {
      videoDouble: {
        eTime: new Date(nowMs + 10 * 60 * 1000).toISOString(),
      },
      $usrTot: {
        data: {
          bag: {
            [artId]: 72,
          },
        },
      },
      flowerRackTot: {
        flowerRackMap: matureRackMap(nowMs, 1),
      },
    };

    const status = summarizeFlowerRackStatus(sync, { nowMs, targetArtId: artId });

    assert.equal(status.targetArt.artId, artId);
    assert.equal(status.sellPlanCount, 1);
    const sell = status.actions.find((action) => action.type === "sell");
    assert.equal(sell.iface, FLOWER_RACK_IFACES.sellOneKey);
    assert.equal(sell.args.sellMap[1][0], artId);
  }
});

test("summarizeFlowerRackStatus reads selected flower rack art from runtime settings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-flower-rack-"));
  try {
    const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
    const settingsPath = path.join(dir, "profile.json");
    await writeFile(settingsPath, JSON.stringify({ flowerRackTargetArtId: 302003 }), "utf8");
    const sync = {
      videoDouble: {
        eTime: new Date(nowMs + 10 * 60 * 1000).toISOString(),
      },
      $usrTot: {
        data: {
          bag: {
            302003: 72,
          },
        },
      },
      flowerRackTot: {
        flowerRackMap: matureRackMap(nowMs, 1),
      },
    };

    const status = summarizeFlowerRackStatus(sync, { nowMs, settingsPath });

    assert.equal(status.targetArt.artId, 302003);
    const sell = status.actions.find((action) => action.type === "sell");
    assert.equal(sell.iface, FLOWER_RACK_IFACES.sellOneKey);
    assert.equal(sell.args.sellMap[1][0], 302003);
  }
  finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("summarizeFlowerRackStatus does nothing when double gold has one minute or less", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const sync = makeSync({
    nowMs,
    doubleGoldRemainingMs: 60 * 1000,
    targetArtCount: 72,
    rackMap: matureRackMap(nowMs, 6),
  });

  const status = summarizeFlowerRackStatus(sync, { nowMs, targetArtId: EXPECTED_DEFAULT_RACK_ART_ID });

  assert.equal(status.doubleGoldGate.ready, false);
  assert.equal(status.actionCount, 0);
  assert.match(status.reasonText, /双倍金币/);
});

test("summarizeFlowerRackStatus still collects mature rack gold when default target stock is below 72", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const sync = makeSync({
    nowMs,
    targetArtCount: 71,
    rackMap: matureRackMap(nowMs, 2),
  });

  const status = summarizeFlowerRackStatus(sync, { nowMs, targetArtId: EXPECTED_DEFAULT_RACK_ART_ID });

  assert.equal(status.targetArt.have, 71);
  assert.equal(status.collectableCount, 2);
  assert.equal(status.sellPlanCount, 0);
  assert.deepEqual(status.actions.map((action) => action.iface), [
    FLOWER_RACK_IFACES.recvSellMoney,
    FLOWER_RACK_IFACES.recvSellMoney,
  ]);
  assert.match(status.reasonText, /库存\+可制作不足/);
});

test("summarizeFlowerRackStatus plans dynamic target flower art crafting before shelving", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const sync = {
    videoDouble: {
      eTime: new Date(nowMs + 10 * 60 * 1000).toISOString(),
    },
    $usrTot: {
      data: {
        bag: {
          300101: 60,
          3001: 12,
          23001: 12,
          23002: 12,
          23003: 12,
        },
      },
    },
    flowerRackTot: {
      flowerRackMap: matureRackMap(nowMs, 6),
    },
  };

  const status = summarizeFlowerRackStatus(sync, { nowMs, targetArtId: 300101 });

  assert.equal(status.targetArt.artId, 300101);
  assert.equal(status.targetArt.have, 60);
  assert.equal(status.targetArt.craftableCount, 12);
  assert.equal(status.targetArt.makeNeededCount, 12);
  assert.equal(status.sellPlanCount, 6);
  assert.deepEqual(status.actions.map((action) => action.type), [
    "recvSellMoney",
    "recvSellMoney",
    "recvSellMoney",
    "recvSellMoney",
    "recvSellMoney",
    "recvSellMoney",
    "makeFlowerArt",
    "sell",
  ]);
  assert.deepEqual(status.actions[6].args, {
    vaseId: 3001,
    flowersIds: [23001, 23002, 23003],
    num: 12,
  });
  const sellAction = status.actions[7];
  assert.equal(sellAction.iface, FLOWER_RACK_IFACES.sellOneKey);
  assert.deepEqual(Object.keys(sellAction.args.sellMap).map(Number), [1, 2, 3, 4, 5, 6]);
  assert.equal(sellAction.args.sellMap[1][0], 300101);
});

test("summarizeFlowerRackStatus makes rack flower art when flowers are enough even if vase stock is not visible", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const sync = {
    videoDouble: {
      eTime: new Date(nowMs + 10 * 60 * 1000).toISOString(),
    },
    $usrTot: {
      data: {
        bag: {
          300101: 27,
          3001: 0,
          23001: 45,
          23002: 45,
          23003: 45,
        },
      },
    },
    flowerRackTot: {
      flowerRackMap: Object.fromEntries(Array.from({ length: 6 }, (_, idx) => [idx + 1, { rackId: idx + 1 }])),
    },
  };

  const status = summarizeFlowerRackStatus(sync, {
    nowMs,
    targetArtId: 300101,
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3001, flowerIds: [23001, 23002, 23003], sPrice: [11, 321] },
      },
    },
  });

  assert.equal(status.targetArt.have, 27);
  assert.equal(status.targetArt.salePrice, 321);
  assert.equal(status.targetArt.rackGold, 7704);
  assert.equal(status.targetArt.craftableCount, 45);
  assert.equal(status.targetArt.makeNeededCount, 45);
  assert.equal(status.targetArt.availableAfterMake, 72);
  assert.equal(status.sellPlanCount, 6);
  assert.deepEqual(status.actions.map((action) => action.type), [
    "makeFlowerArt",
    "sell",
  ]);
  assert.deepEqual(status.actions[0].args, {
    vaseId: 3001,
    flowersIds: [23001, 23002, 23003],
    num: 45,
  });
  assert.equal(status.actions[1].iface, FLOWER_RACK_IFACES.sellOneKey);
  assert.deepEqual(Object.keys(status.actions[1].args.sellMap).map(Number), [1, 2, 3, 4, 5, 6]);
});

test("summarizeFlowerRackStatus does not shelf when stock plus craftable count is below target", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const sync = {
    videoDouble: {
      eTime: new Date(nowMs + 10 * 60 * 1000).toISOString(),
    },
    $usrTot: {
      data: {
        bag: {
          300101: 60,
          3001: 0,
          23001: 12,
          23002: 12,
          23003: 11,
        },
      },
    },
    flowerRackTot: {
      flowerRackMap: matureRackMap(nowMs, 2),
    },
  };

  const status = summarizeFlowerRackStatus(sync, { nowMs, targetArtId: 300101 });

  assert.equal(status.targetArt.craftableCount, 11);
  assert.equal(status.targetArt.makeNeededCount, 0);
  assert.equal(status.sellPlanCount, 0);
  assert.deepEqual(status.actions.map((action) => action.type), ["recvSellMoney", "recvSellMoney"]);
  assert.match(status.reasonText, /库存\+可制作不足/);
});

test("summarizeFlowerRackStatus shelves only empty or collected rack slots without cancelling active racks", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const rackMap = {
    ...matureRackMap(nowMs, 2),
    3: {
      rackId: 3,
      iid: 300101,
      num: 12,
      sellStartTime: new Date(nowMs - 5 * 60 * 1000).toISOString(),
    },
    4: {},
  };
  const sync = makeSync({
    nowMs,
    targetArtCount: 72,
    rackMap,
  });

  const status = summarizeFlowerRackStatus(sync, { nowMs, targetArtId: EXPECTED_DEFAULT_RACK_ART_ID });

  assert.equal(status.collectableCount, 2);
  assert.equal(status.sellPlanCount, 3);
  // recv 1,2 + 单个 sellOneKey（sellMap 覆盖空位 1,2,4；售卖中的 3 不参与）
  assert.deepEqual(status.actions.filter((a) => a.type === "recvSellMoney").map((a) => a.args.rackId), [1, 2]);
  const sell = status.actions.find((a) => a.type === "sell");
  assert.equal(sell.iface, FLOWER_RACK_IFACES.sellOneKey);
  assert.deepEqual(Object.keys(sell.args.sellMap).map(Number), [1, 2, 4]);
});
