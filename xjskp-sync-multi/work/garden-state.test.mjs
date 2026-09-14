import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  getCultivatedFlowerInventory,
  getBag,
  getDoubleGoldStatus,
  getFlowerInventory,
  getGardenResourceStatus,
  getWaterDropCount,
  getWaterDropStatus,
  ITEM_IDS,
  mergeExperienceSync,
  mergeGameSync,
  parseExperienceSettlementEvidence,
  removeCustomerOrder,
  summarizeLand,
  summarizePlantCandidates,
} from "./garden-state.mjs";
import { createFlowerLevelConfig } from "./flower-level-config.mjs";
import { summarizeOrderPalaceStatus } from "./order-state.mjs";

test("mergeGameSync applies harvested itemAddChg into the user bag", () => {  const base = {
    $usrTot: {
      data: {
        bag: {
          23001: 0,
          23002: 5,
        },
      },
    },
    usrLandTot: {
      usrLand: {
        landMap: {
          1001: { state: 3, flowerId: 23001 },
        },
      },
    },
  };
  const update = {
    $usrTot: {
      itemAddChg: {
        itemMap: {
          23001: 52,
        },
      },
    },
    usrLandTot: {
      chgLandMap: {
        1001: {},
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[23001], 52);
  assert.equal(getBag(merged)[23002], 5);
  assert.deepEqual(merged.usrLandTot.usrLand.landMap[1001], {});
});

test("mergeGameSync also applies itemAddChg itemAddRcdList item maps", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          23001: 2,
          23002: 3,
        },
      },
    },
  };
  const update = {
    $usrTot: {
      itemAddChg: {
        itemAddRcdList: [
          { itemMap: { 23001: 4 } },
          { itemMap: { 23002: -1, 23003: 6 } },
        ],
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[23001], 6);
  assert.equal(getBag(merged)[23002], 2);
  assert.equal(getBag(merged)[23003], 6);
});

test("mergeGameSync does not double apply the same item from itemAddChg itemMap and itemAddRcdList", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          300703: 0,
        },
      },
    },
  };
  const update = {
    $usrTot: {
      itemAddChg: {
        itemMap: {
          300703: 1,
        },
        itemAddRcdList: [
          { itemMap: { 300703: 1 } },
        ],
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[300703], 1);
});

test("mergeGameSync does not double add an item when itemAddChg and oi.bi both report it", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          300808: 0,
        },
      },
    },
  };
  const update = {
    $usrTot: {
      itemAddChg: {
        itemAddRcdList: [
          { itemMap: { 300808: 1 } },
        ],
      },
      oi: {
        bi: {
          300808: 1,
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[300808], 1);
});

test("mergeGameSync does not double deduct an item when itemAddChg and oi.bo both report it", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          300808: 2,
        },
      },
    },
  };
  const update = {
    $usrTot: {
      itemAddChg: {
        itemMap: {
          300808: -1,
        },
      },
      oi: {
        bo: {
          300808: -1,
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[300808], 1);
});

test("mergeGameSync applies a root itemAddChg deduction down to zero", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          23015: 1,
        },
      },
    },
  };
  const update = {
    itemAddChg: {
      itemMap: {
        23015: -1,
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[23015], 0);
});

test("mergeGameSync applies a root oi deduction to the current flower count", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          23015: 5,
        },
      },
    },
  };
  const update = {
    oi: {
      bo: {
        23015: -2,
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[23015], 3);
});

test("mergeGameSync applies duplicate root and $usrTot item changes only once", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          23015: 2,
          23016: 4,
        },
      },
    },
  };
  const update = {
    itemAddChg: {
      itemMap: {
        23015: -1,
        23016: -2,
      },
    },
    $usrTot: {
      oi: {
        bo: {
          23015: -1,
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[23015], 1);
  assert.equal(getBag(merged)[23016], 2);
});

test("mergeGameSync does not apply water itemAddChg when an update bag still contains the old count", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          [ITEM_IDS.WATER_DROP]: 1,
          23001: 2,
        },
      },
    },
  };
  const update = {
    $usrTot: {
      data: {
        bag: {
          [ITEM_IDS.WATER_DROP]: 1,
          23001: 2,
        },
      },
      itemAddChg: {
        itemAddRcdList: [
          { itemMap: { [ITEM_IDS.WATER_DROP]: 5 } },
        ],
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[ITEM_IDS.WATER_DROP], 1);
  assert.equal(getBag(merged)[23001], 2);
});

test("mergeGameSync does not double apply itemAddChg when an update bag already has the new count", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          [ITEM_IDS.WATER_DROP]: 1,
        },
      },
    },
  };
  const update = {
    $usrTot: {
      data: {
        bag: {
          [ITEM_IDS.WATER_DROP]: 6,
        },
      },
      itemAddChg: {
        itemAddRcdList: [
          { itemMap: { [ITEM_IDS.WATER_DROP]: 5 } },
        ],
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[ITEM_IDS.WATER_DROP], 6);
});

test("mergeGameSync applies oi.bd water as an absolute bag count", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          [ITEM_IDS.WATER_DROP]: 9,
        },
      },
    },
  };
  const update = {
    $usrTot: {
      oi: {
        bd: {
          [ITEM_IDS.WATER_DROP]: 10,
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[ITEM_IDS.WATER_DROP], 10);
});

test("mergeGameSync follows the current client and does not apply display-only experience deltas", () => {
  const base = {
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 9800000,
        bag: {
          [ITEM_IDS.WATER_DROP]: 1,
        },
      },
    },
  };

  const fromItemAddChg = mergeGameSync(base, {
    $usrTot: {
      itemAddChg: {
        itemMap: {
          [ITEM_IDS.EXPERIENCE]: 50000,
        },
      },
    },
  });
  assert.equal(fromItemAddChg.$usrTot.data.lvlExp, 9800000);
  assert.equal(getBag(fromItemAddChg)[ITEM_IDS.EXPERIENCE], undefined);

  const fromOutInDelta = mergeGameSync(fromItemAddChg, {
    $usrTot: {
      oi: {
        bi: {
          [ITEM_IDS.EXPERIENCE]: 40000,
        },
      },
    },
  });
  assert.equal(fromOutInDelta.$usrTot.data.lvlExp, 9800000);

  const fromOutInSet = mergeGameSync(fromOutInDelta, {
    $usrTot: {
      oi: {
        bd: {
          [ITEM_IDS.EXPERIENCE]: 9900000,
        },
      },
    },
  });
  assert.equal(fromOutInSet.$usrTot.data.lvlExp, 9900000);
});

test("experience evidence treats data as state and deduplicates client display containers", () => {
  const base = {
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 100,
      },
    },
  };
  const response = {
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 110,
      },
      itemAddChg: {
        itemMap: {
          [ITEM_IDS.EXPERIENCE]: 10,
        },
        itemAddRcdList: [
          {
            itemMap: {
              [ITEM_IDS.EXPERIENCE]: 10,
            },
          },
        ],
      },
      oi: {
        bi: {
          [ITEM_IDS.EXPERIENCE]: 10,
        },
      },
    },
  };

  const evidence = parseExperienceSettlementEvidence(base, response);

  assert.deepEqual(evidence.absoluteCandidates, [
    { source: "$usrTot.data.lvlExp", value: 110 },
  ]);
  assert.deepEqual(evidence.deltaCandidates, [
    { source: "$usrTot.itemAddChg.itemMap[2]", value: 10 },
    { source: "$usrTot.itemAddChg.itemAddRcdList[0].itemMap[2]", value: 10 },
    { source: "$usrTot.oi.bi[2]", value: 10 },
  ]);
  assert.equal(evidence.deduplicatedDelta, 10);
  assert.equal(evidence.resolvedLevel, 40);
  assert.equal(evidence.resolvedExp, 110);
  assert.equal(evidence.actualExpDelta, 10);
  assert.equal(evidence.resolution, "authoritative-absolute");
  assert.equal(evidence.conflict, false);
  assert.equal(mergeGameSync(base, response).$usrTot.data.lvlExp, 110);
});

test("experience evidence reports an absolute and display delta mismatch", () => {
  const evidence = parseExperienceSettlementEvidence(
    {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 100,
        },
      },
    },
    {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 110,
        },
        oi: {
          bi: {
            [ITEM_IDS.EXPERIENCE]: 20,
          },
        },
      },
    },
  );

  assert.equal(evidence.resolvedExp, 110);
  assert.equal(evidence.actualExpDelta, 10);
  assert.equal(evidence.conflict, true);
  assert.equal(evidence.conflictReason, "absolute-delta-mismatch");
});

test("experience snapshot reconciliation does not reapply a response merged by wrapper and caller", () => {
  const base = {
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 100,
      },
    },
  };
  const response = {
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 110,
      },
      oi: {
        bi: {
          [ITEM_IDS.EXPERIENCE]: 10,
        },
      },
    },
  };

  const wrapperSnapshot = mergeGameSync(base, response);
  const callerSnapshot = mergeGameSync(base, response);
  const reconciled = mergeExperienceSync(callerSnapshot, wrapperSnapshot);

  assert.equal(wrapperSnapshot.$usrTot.data.lvlExp, 110);
  assert.equal(callerSnapshot.$usrTot.data.lvlExp, 110);
  assert.equal(reconciled.$usrTot.data.lvlExp, 110);
});

test("experience evidence fails closed on same-level regression and preserves the upper snapshot", () => {
  const base = {
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 100,
      },
    },
  };
  const response = {
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 90,
      },
    },
  };

  const evidence = parseExperienceSettlementEvidence(base, response);
  const merged = mergeGameSync(base, response);

  assert.equal(evidence.regression, true);
  assert.equal(evidence.conflict, true);
  assert.equal(evidence.conflictReason, "same-level-experience-regression");
  assert.equal(evidence.resolvedLevel, 40);
  assert.equal(evidence.resolvedExp, 100);
  assert.equal(merged.$usrTot.data.lvlExp, 100);
});

test("experience evidence accepts an explicit level-up with an absolute reset", () => {
  const evidence = parseExperienceSettlementEvidence(
    {
      $usrTot: {
        data: {
          lvl: 49,
          lvlExp: 990,
        },
      },
    },
    {
      $usrTot: {
        data: {
          lvl: 50,
          lvlExp: 10,
        },
        oi: {
          bi: {
            [ITEM_IDS.EXPERIENCE]: 20,
          },
        },
      },
    },
  );

  assert.equal(evidence.responseLevel, 50);
  assert.equal(evidence.resolvedLevel, 50);
  assert.equal(evidence.resolvedExp, 10);
  assert.equal(evidence.actualExpDelta, 20);
  assert.equal(evidence.resolution, "authoritative-level-up");
  assert.equal(evidence.conflict, false);
});

test("experience evidence preserves the snapshot when a response has no experience fields", () => {
  const evidence = parseExperienceSettlementEvidence(
    {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 100,
        },
      },
    },
    {
      usrLandTot: {
        usrLand: {
          landMap: {},
        },
      },
    },
  );

  assert.equal(evidence.resolvedLevel, 40);
  assert.equal(evidence.resolvedExp, 100);
  assert.equal(evidence.actualExpDelta, 0);
  assert.equal(evidence.resolution, "no-experience-evidence");
  assert.equal(evidence.conflict, false);
});

test("mergeExperienceSync refreshes experience without overwriting stale bag snapshots", () => {
  const base = {
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 9800000,
        bag: {
          [ITEM_IDS.WATER_DROP]: 25,
          23001: 7,
        },
      },
    },
  };

  const update = {
    $usrTot: {
      data: {
        lvl: 40,
        bag: {
          [ITEM_IDS.WATER_DROP]: 1,
          23001: 0,
        },
      },
      oi: {
        bd: {
          [ITEM_IDS.EXPERIENCE]: 9900000,
        },
      },
    },
  };

  const merged = mergeExperienceSync(base, update);

  assert.equal(merged.$usrTot.data.lvlExp, 9900000);
  assert.equal(merged.$usrTot.data.lvl, 40);
  assert.equal(getBag(merged)[ITEM_IDS.WATER_DROP], 25);
  assert.equal(getBag(merged)[23001], 7);
});

test("mergeGameSync preserves main task state when sparse taskTot update omits main", () => {
  const base = {
    taskTot: {
      main: {
        curTaskId: 3440001,
        curValue: 72,
        recvMap: {},
      },
    },
  };
  const update = {
    taskTot: {
      dly: {
        score: 10,
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.taskTot.main, base.taskTot.main);
  assert.equal(merged.taskTot.dly.score, 10);
});

test("mergeGameSync merges sparse main task updates without dropping current task id", () => {
  const base = {
    taskTot: {
      main: {
        curTaskId: 3440001,
        curValue: 72,
        recvMap: { 3430001: 1 },
      },
    },
  };
  const update = {
    taskTot: {
      main: {
        curValue: 80,
        uTime: "2026-06-22T06:39:13.674Z",
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.taskTot.main, {
    curTaskId: 3440001,
    curValue: 80,
    recvMap: { 3430001: 1 },
    uTime: "2026-06-22T06:39:13.674Z",
  });
});

test("mergeGameSync merges sparse palace order updates without dropping order detail", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          23070: 197,
        },
      },
    },
    videoDouble: {
      eTime: "2026-06-22T08:00:00.000Z",
    },
    orderPalaceTot: {
      orderPalace: {
        flowerId: 23070,
        num: 500,
        isFinish: false,
        cTime: "2026-05-21T23:58:32.444Z",
      },
    },
  };
  const update = {
    orderPalaceTot: {
      orderPalace: {
        isFinish: 1,
        uTime: "2026-06-22T06:04:46.854Z",
      },
    },
  };

  const merged = mergeGameSync(base, update);
  const status = summarizeOrderPalaceStatus(merged, {
    nowMs: Date.parse("2026-06-22T07:00:00.000Z"),
    nameMap: { 23070: "浅橘乒乓菊" },
  });

  assert.equal(merged.orderPalaceTot.orderPalace.flowerId, 23070);
  assert.equal(merged.orderPalaceTot.orderPalace.num, 500);
  assert.equal(status.status, "completed");
  assert.equal(status.flowerLabel, "浅橘乒乓菊 (23070)");
  assert.equal(status.need, 500);
  assert.equal(status.have, 197);
});

test("mergeGameSync replaces flower rack rows and applies rack item deltas", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          305101: 72,
        },
      },
    },
    flowerRackTot: {
      flowerRackMap: {
        1: {
          rackId: 1,
          iid: 300101,
          num: 12,
          sellStartTime: "2026-06-16T00:00:00.000Z",
        },
        2: {
          rackId: 2,
          iid: 300102,
          num: 12,
          sellStartTime: "2026-06-16T00:00:00.000Z",
        },
        3: {
          rackId: 3,
          iid: 300103,
          num: 12,
          sellStartTime: "2026-06-16T01:00:00.000Z",
        },
      },
    },
  };
  const update = {
    $usrTot: {
      itemAddChg: {
        itemMap: {
          305101: -12,
        },
      },
    },
    flowerRackTot: {
      flowerRackMap: {
        1: {
          rackId: 1,
        },
        2: {
          rackId: 2,
          iid: 305101,
          num: 12,
          sellStartTime: "2026-06-16T02:00:00.000Z",
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.flowerRackTot.flowerRackMap[1], { rackId: 1 });
  assert.deepEqual(merged.flowerRackTot.flowerRackMap[2], {
    rackId: 2,
    iid: 305101,
    num: 12,
    sellStartTime: "2026-06-16T02:00:00.000Z",
  });
  assert.deepEqual(merged.flowerRackTot.flowerRackMap[3], {
    rackId: 3,
    iid: 300103,
    num: 12,
    sellStartTime: "2026-06-16T01:00:00.000Z",
  });
  assert.equal(getBag(merged)[305101], 60);
});

test("mergeGameSync merges guild land rows without dropping unchanged guild lands", () => {
  const base = {
    fmlTot: {
      fmlLand: {
        landMap: {
          501: { flwId: 23001, lvl: 2, matureFlwCnt: 2 },
          502: { flwId: 23002, lvl: 2, matureFlwCnt: 0 },
        },
      },
    },
  };
  const update = {
    fmlTot: {
      fmlLand: {
        landMap: {
          501: { flwId: 23001, lvl: 2, matureFlwCnt: 0 },
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.fmlTot.fmlLand.landMap[501], { flwId: 23001, lvl: 2, matureFlwCnt: 0 });
  assert.deepEqual(merged.fmlTot.fmlLand.landMap[502], { flwId: 23002, lvl: 2, matureFlwCnt: 0 });
});

test("getWaterDropCount reads water drops from item id 7 in the user bag", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          7: 1234,
        },
      },
    },
  };

  assert.equal(getWaterDropCount(sync), 1234);
});

test("getGardenResourceStatus reads top garden currencies from the user bag", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          [ITEM_IDS.PEARL]: 12,
          [ITEM_IDS.FLOWER_SHOP_COIN]: 34,
          [ITEM_IDS.SATIN_SILK]: 45,
          [ITEM_IDS.BUILDING_MATERIAL]: 67,
          [ITEM_IDS.YUANBAO]: 56,
          [ITEM_IDS.GOLD]: 7890,
        },
      },
    },
  };

  const status = getGardenResourceStatus(sync);

  assert.deepEqual(
    Object.fromEntries(Object.entries(status).map(([key, value]) => [key, value.count])),
    {
      pearl: 12,
      flowerShopCoin: 34,
      satinSilk: 45,
      buildingMaterial: 67,
      yuanbao: 56,
      gold: 7890,
    },
  );
  assert.equal(status.pearl.label, "珍珠");
  assert.equal(status.flowerShopCoin.label, "花坊币");
  assert.equal(status.satinSilk.label, "丝绸/绸缎");
  assert.equal(status.satinSilk.itemId, 1106);
  assert.equal(status.buildingMaterial.label, "建材");
  assert.equal(status.buildingMaterial.itemId, 1340);
  assert.equal(status.yuanbao.itemId, 1);
  assert.equal(status.gold.itemId, 11);
});

test("getGardenResourceStatus reads resource-backed currencies from user properties", () => {
  const sync = {
    $usrTot: {
      data: {
        dmd: 98,
        gld: 12345,
        bag: {
          [ITEM_IDS.PEARL]: 12,
          [ITEM_IDS.FLOWER_SHOP_COIN]: 34,
          [ITEM_IDS.SATIN_SILK]: 45,
          [ITEM_IDS.BUILDING_MATERIAL]: 67,
          [ITEM_IDS.YUANBAO]: 1,
          [ITEM_IDS.GOLD]: 2,
        },
      },
    },
  };

  const status = getGardenResourceStatus(sync);

  assert.equal(status.yuanbao.count, 98);
  assert.equal(status.yuanbao.sourcePath, "$usrTot.data.dmd");
  assert.equal(status.gold.count, 12345);
  assert.equal(status.gold.sourcePath, "$usrTot.data.gld");
  assert.equal(status.pearl.count, 12);
  assert.equal(status.flowerShopCoin.count, 34);
  assert.equal(status.satinSilk.count, 45);
  assert.equal(status.buildingMaterial.count, 67);
});

test("getGardenResourceStatus keeps bag-backed resources bag-backed", () => {
  const sync = {
    $usrTot: {
      data: {
        pearl: 999,
        flowerShopCoin: 888,
        satinSilk: 777,
        buildingMaterial: 666,
        bag: {
          [ITEM_IDS.PEARL]: 12,
          [ITEM_IDS.FLOWER_SHOP_COIN]: 34,
          [ITEM_IDS.SATIN_SILK]: 45,
          [ITEM_IDS.BUILDING_MATERIAL]: 67,
        },
      },
    },
  };

  const status = getGardenResourceStatus(sync);

  assert.equal(status.pearl.count, 12);
  assert.equal(status.pearl.sourcePath, "$usrTot.data.bag[1006]");
  assert.equal(status.flowerShopCoin.count, 34);
  assert.equal(status.flowerShopCoin.sourcePath, "$usrTot.data.bag[1002]");
  assert.equal(status.satinSilk.count, 45);
  assert.equal(status.satinSilk.sourcePath, "$usrTot.data.bag[1106]");
  assert.equal(status.buildingMaterial.count, 67);
  assert.equal(status.buildingMaterial.sourcePath, "$usrTot.data.bag[1340]");
});

test("getWaterDropStatus includes naturally restored top water drops", () => {
  const nowMs = Date.parse("2026-06-16T10:05:00.000Z");
  const sync = {
    $usrTot: {
      data: {
        cTime: "2026-06-16T09:00:00.000Z",
        bag: {
          7: 33,
        },
        itemExtMap: {
          7: {
            lems: Date.parse("2026-06-16T10:00:00.000Z"),
            cd: 120000,
            resetNum: 65,
          },
        },
      },
    },
  };

  const status = getWaterDropStatus(sync, nowMs);

  assert.equal(status.baseCount, 33);
  assert.equal(status.count, 35);
  assert.equal(status.restoredCount, 2);
  assert.equal(status.displayLimit, 65);
  assert.equal(status.nextRestoreInSeconds, 60);
  assert.equal(getWaterDropCount(sync, nowMs), 35);
});

test("getWaterDropStatus caps natural restoration at the top water limit", () => {
  const nowMs = Date.parse("2026-06-16T10:10:00.000Z");
  const sync = {
    $usrTot: {
      data: {
        cTime: "2026-06-16T09:00:00.000Z",
        bag: {
          7: 64,
        },
        itemExtMap: {
          7: {
            lems: Date.parse("2026-06-16T10:00:00.000Z"),
            cd: 120000,
            resetNum: 65,
          },
        },
      },
    },
  };

  const status = getWaterDropStatus(sync, nowMs);

  assert.equal(status.count, 65);
  assert.equal(status.restoredCount, 1);
});

test("getWaterDropStatus does not naturally grow water at or above the restore limit", () => {
  const nowMs = Date.parse("2026-06-16T10:10:00.000Z");
  const sync = {
    $usrTot: {
      data: {
        cTime: "2026-06-16T09:00:00.000Z",
        bag: {
          7: 122,
        },
        itemExtMap: {
          7: {
            lems: Date.parse("2026-06-16T10:00:00.000Z"),
            cd: 120000,
            resetNum: 65,
          },
        },
      },
    },
  };

  const status = getWaterDropStatus(sync, nowMs);

  assert.equal(status.count, 122);
  assert.equal(status.restoredCount, 0);
  assert.equal(status.nextRestoreInSeconds, null);
});

test("getDoubleGoldStatus reads active double gold end time", () => {
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const sync = {
    videoDouble: {
      videoCnt: 2,
      eTime: "2026-06-16T02:30:00.000Z",
    },
  };

  const status = getDoubleGoldStatus(sync, nowMs);

  assert.equal(status.sourcePath, "videoDouble.eTime");
  assert.equal(status.exists, true);
  assert.equal(status.active, true);
  assert.equal(status.videoCnt, 2);
  assert.equal(status.eTime, "2026-06-16T02:30:00.000Z");
  assert.equal(status.remainingMs, 30 * 60 * 1000);
});

test("getDoubleGoldStatus reports inactive when missing or expired", () => {
  const nowMs = Date.parse("2026-06-16T03:00:00.000Z");

  assert.deepEqual(getDoubleGoldStatus({}, nowMs), {
    sourcePath: "videoDouble.eTime",
    exists: false,
    active: false,
    videoCnt: null,
    eTime: null,
    eTimeMs: null,
    remainingMs: 0,
  });

  assert.equal(getDoubleGoldStatus({ videoDouble: { eTime: "2026-06-16T02:30:00.000Z" } }, nowMs).active, false);
});

test("land, water, and double-gold decisions accept a trusted corrected clock", () => {
  const serverNowMs = Date.parse("2026-06-16T10:00:00.000Z");
  const slowLocalNowMs = serverNowMs - 60_000;
  const fastLocalNowMs = serverNowMs + 60_000;
  const trustedClock = (localNowMs) => ({
    nowMs: localNowMs,
    timeAuthority: {
      trusted: true,
      correctedNowMs: serverNowMs,
    },
  });

  const slowLand = summarizeLand({
    usrLandTot: {
      usrLand: {
        landMap: {
          1001: {
            state: 2,
            flowerId: 23001,
            nextTime: new Date(serverNowMs - 30_000).toISOString(),
          },
        },
      },
    },
  }, trustedClock(slowLocalNowMs));
  assert.deepEqual(slowLand.mature.map((item) => item.landId), [1001]);
  assert.deepEqual(
    summarizeLand({
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: {
              state: 2,
              flowerId: 23001,
              nextTime: new Date(serverNowMs - 30_000).toISOString(),
            },
          },
        },
      },
    }, slowLocalNowMs).mature,
    [],
  );

  const slowWater = getWaterDropStatus({
    $usrTot: {
      data: {
        cTime: new Date(serverNowMs - 3_600_000).toISOString(),
        bag: { 7: 10 },
        itemExtMap: {
          7: {
            lems: serverNowMs - 90_000,
            cd: 60_000,
            resetNum: 65,
          },
        },
      },
    },
  }, trustedClock(slowLocalNowMs));
  assert.equal(slowWater.count, 11);
  assert.equal(getWaterDropStatus({
    $usrTot: {
      data: {
        cTime: new Date(serverNowMs - 3_600_000).toISOString(),
        bag: { 7: 10 },
        itemExtMap: {
          7: { lems: serverNowMs - 90_000, cd: 60_000, resetNum: 65 },
        },
      },
    },
  }, slowLocalNowMs).count, 10);

  const slowDoubleGold = getDoubleGoldStatus({
    videoDouble: { eTime: new Date(serverNowMs - 30_000).toISOString() },
  }, trustedClock(slowLocalNowMs));
  assert.equal(slowDoubleGold.active, false);
  assert.equal(slowDoubleGold.remainingMs, 0);
  assert.equal(getDoubleGoldStatus({
    videoDouble: { eTime: new Date(serverNowMs - 30_000).toISOString() },
  }, slowLocalNowMs).active, true);

  const fastLandSync = {
    usrLandTot: {
      usrLand: {
        landMap: {
          1001: {
            state: 2,
            flowerId: 23001,
            nextTime: new Date(serverNowMs + 30_000).toISOString(),
          },
        },
      },
    },
  };
  assert.deepEqual(summarizeLand(fastLandSync, trustedClock(fastLocalNowMs)).growing.map((item) => item.landId), [1001]);
  assert.deepEqual(summarizeLand(fastLandSync, fastLocalNowMs).mature.map((item) => item.landId), [1001]);

  const fastWaterSync = {
    $usrTot: {
      data: {
        cTime: new Date(serverNowMs - 3_600_000).toISOString(),
        bag: { 7: 10 },
        itemExtMap: {
          7: { lems: serverNowMs + 30_000, cd: 20_000, resetNum: 65 },
        },
      },
    },
  };
  assert.equal(getWaterDropStatus(fastWaterSync, trustedClock(fastLocalNowMs)).count, 10);
  assert.equal(getWaterDropStatus(fastWaterSync, fastLocalNowMs).count, 11);

  const fastDoubleGoldSync = {
    videoDouble: { eTime: new Date(serverNowMs + 30_000).toISOString() },
  };
  assert.equal(getDoubleGoldStatus(fastDoubleGoldSync, trustedClock(fastLocalNowMs)).active, true);
  assert.equal(getDoubleGoldStatus(fastDoubleGoldSync, trustedClock(fastLocalNowMs)).remainingMs, 30_000);
  assert.equal(getDoubleGoldStatus(fastDoubleGoldSync, fastLocalNowMs).active, false);
});

test("missing or untrusted time authority keeps the explicit local clock", () => {
  const localNowMs = Date.parse("2026-06-16T10:00:00.000Z");
  const futureMs = localNowMs + 30_000;
  const sync = {
    usrLandTot: {
      usrLand: {
        landMap: {
          1001: { state: 2, nextTime: new Date(futureMs).toISOString() },
        },
      },
    },
    $usrTot: {
      data: {
        bag: { 7: 10 },
        itemExtMap: { 7: { lems: futureMs, cd: 60_000, resetNum: 65 } },
      },
    },
    videoDouble: { eTime: new Date(futureMs).toISOString() },
  };
  const localInput = {
    nowMs: localNowMs,
    timeAuthority: { trusted: false, correctedNowMs: localNowMs + 60_000 },
  };

  assert.deepEqual(summarizeLand(sync, localInput).growing.map((item) => item.landId), [1001]);
  assert.equal(getWaterDropStatus(sync, localInput).count, 10);
  assert.equal(getDoubleGoldStatus(sync, localInput).active, true);

  const expiredInput = {
    nowMs: localNowMs,
    timeAuthority: {
      trusted: true,
      correctedNowMs: localNowMs + 60_000,
      serverOffsetMs: 60_000,
      sampleMaxAgeMs: 1_000,
      lastAcceptedSample: {
        serverMs: localNowMs + 57_800,
        correctedServerMs: localNowMs + 58_000,
        requestStartedAtMs: localNowMs - 2_400,
        responseAtMs: localNowMs - 2_000,
        rttMs: 400,
        serverOffsetMs: 60_000,
        acceptedAtMs: localNowMs - 2_000,
      },
    },
  };
  assert.deepEqual(summarizeLand(sync, expiredInput).growing.map((item) => item.landId), [1001]);
  assert.equal(getWaterDropStatus(sync, expiredInput).count, 10);
  assert.equal(getDoubleGoldStatus(sync, expiredInput).active, true);
});

test("summarizePlantCandidates chooses flowers by owned inventory count first", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          23001: 52,
          23002: 1,
          23003: 0,
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 11, cTime: "2026-01-01T00:00:00.000Z" },
        23002: { flowerId: 23002, lvl: 12, cTime: "2026-01-02T00:00:00.000Z" },
        23003: { flowerId: 23003, lvl: 12, cTime: "2026-01-03T00:00:00.000Z" },
      },
    },
  };

  assert.deepEqual(
    summarizePlantCandidates(sync).map((item) => item.flowerId),
    [23003, 23002, 23001],
  );
});

test("summarizePlantCandidates prioritizes palace order flower shortages", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          23001: 0,
          23002: 20,
          23003: 5,
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 11, cTime: "2026-01-01T00:00:00.000Z" },
        23002: { flowerId: 23002, lvl: 12, cTime: "2026-01-02T00:00:00.000Z" },
        23003: { flowerId: 23003, lvl: 12, cTime: "2026-01-03T00:00:00.000Z" },
      },
    },
    orderPalaceTot: {
      orderPalace: {
        orderMap: {
          1: { flowerId: 23002, num: 40, isFinish: false },
          2: { flowerId: 23003, num: 3, isFinish: false },
        },
      },
    },
  };

  const candidates = summarizePlantCandidates(sync);

  assert.deepEqual(
    candidates.map((item) => item.flowerId),
    [23002, 23001, 23003],
  );
  assert.equal(candidates[0].palaceOrderNeed, 40);
  assert.equal(candidates[0].palaceOrderHave, 20);
  assert.equal(candidates[0].palaceOrderMissing, 20);
  assert.equal(candidates[0].plantPriorityReason, "palace-order-shortage");
  assert.equal(candidates[1].plantPriorityReason, "inventory-low");
});

test("summarizePlantCandidates tie-breaks by flowerId, not cultivate time", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          23001: 10,
          23002: 10,
          23003: 10,
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23003: { flowerId: 23003, lvl: 12, cTime: "2026-01-01T00:00:00.000Z" },
        23001: { flowerId: 23001, lvl: 12, cTime: "2026-01-03T00:00:00.000Z" },
        23002: { flowerId: 23002, lvl: 12, cTime: "2026-01-02T00:00:00.000Z" },
      },
    },
  };

  assert.deepEqual(
    summarizePlantCandidates(sync).map((item) => item.flowerId),
    [23001, 23002, 23003],
  );
});

test("bag-only and level-one flowers are visible in inventory but not plant candidates", () => {
  const flowerLevelConfig = createFlowerLevelConfig({
    flowerLvlRows: [
      { id: 23002, cd: 840 },
      { id: 2300303, cd: 333 },
    ],
    flowerLvlCfgRows: [
      { id: 1, cd: 84 },
      { id: 2, cd: 85 },
      { id: 3, cd: 100 },
    ],
  });
  const sync = {
    $usrTot: {
      data: {
        bag: {
          23001: 0,
          23002: 1,
          23003: 2,
          23333: 0,
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 1, cTime: "2026-01-01T00:00:00.000Z" },
        23002: { flowerId: 23002, lvl: 2, cTime: "2026-01-02T00:00:00.000Z" },
        23003: { flowerId: 23003, lvl: 3, cTime: "2026-01-03T00:00:00.000Z" },
      },
    },
  };

  assert.deepEqual(
    getFlowerInventory(sync, flowerLevelConfig).slice(0, 4).map((item) => [item.flowerId, item.count, item.lvl]),
    [
      [23001, 0, 1],
      [23333, 0, ""],
      [23002, 1, 2],
      [23003, 2, 3],
    ],
  );
  assert.deepEqual(
    getCultivatedFlowerInventory(sync, flowerLevelConfig).map((item) => [item.flowerId, item.count, item.lvl]),
    [
      [23002, 1, 2],
      [23003, 2, 3],
    ],
  );
  assert.deepEqual(
    getCultivatedFlowerInventory(sync, flowerLevelConfig).map((item) => [
      item.flowerId,
      item.maturitySeconds,
      item.maturityRawCd,
      item.maturityTimeStep,
      item.maturitySource,
    ]),
    [
      [23002, 850, 850, 1, "formula"],
      [23003, 333, 333, 1, "exact"],
    ],
  );
  assert.deepEqual(
    getFlowerInventory(sync, flowerLevelConfig)
      .filter((item) => item.flowerId === 23333)
      .map((item) => [item.maturitySeconds, item.maturityRawCd, item.maturityTimeStep, item.maturitySource]),
    [[null, null, null, "missing"]],
  );
  assert.deepEqual(
    summarizePlantCandidates(sync).map((item) => item.flowerId),
    [23002, 23003],
  );
});

test("getFlowerInventory subtracts harvest interval reduction from advance slots", () => {
  const flowerLevelConfig = createFlowerLevelConfig({
    flowerLvlRows: [
      { id: 2300111, cd: 104 },
    ],
    flowerAdvanceSkillRows: [
      { id: 5001, skillType: 5, valueType: 1, value1: 63, value2: 64, value3: 65 },
    ],
  });
  const sync = {
    $usrTot: {
      data: {
        bag: {
          23001: 10,
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: {
          flowerId: 23001,
          lvl: 11,
          cTime: "2026-01-01T00:00:00.000Z",
          advanceSlotMap: {
            1: { slotId: 1, skillId: 5001 },
          },
        },
      },
    },
  };

  const [item] = getCultivatedFlowerInventory(sync, flowerLevelConfig);

  assert.equal(item.maturitySeconds, 41);
  assert.equal(item.maturityRawCd, 104);
  assert.equal(item.advanceHarvestIntervalReductionSeconds, 63);
  assert.equal(item.advanceEffects[5], 63);
  assert.deepEqual(item.advanceSlots.map((slot) => [slot.slotId, slot.skillId, slot.skillType, slot.effectValue]), [
    [1, 5001, 5, 63],
  ]);
});

test("mergeGameSync uses lazySync bag values before choosing candidates", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          23001: 100,
          23002: 1,
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 12 },
        23002: { flowerId: 23002, lvl: 12 },
      },
    },
  };
  const afterLazySync = mergeGameSync(base, {
    $usrTot: {
      data: {
        bag: {
          23001: 0,
          23002: 50,
        },
      },
    },
  });

  assert.equal(summarizePlantCandidates(afterLazySync)[0].flowerId, 23001);
});

test("mergeGameSync preserves cultivated flowers when sparse sync sends an empty cultivate map", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          23001: 5,
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 12, cTime: "2026-06-24T01:00:00.000Z" },
      },
    },
  };
  const afterSparseSync = mergeGameSync(base, {
    cultivateTot: {
      cultivateMap: {},
    },
  });

  assert.deepEqual(
    getCultivatedFlowerInventory(afterSparseSync).map((item) => [item.flowerId, item.count, item.lvl]),
    [[23001, 5, 12]],
  );
  assert.equal(summarizePlantCandidates(afterSparseSync)[0].flowerId, 23001);
});

test("mergeGameSync preserves omitted order fields and replaces explicitly empty order fields", () => {
  const base = {
    orderFlowerTot: {
      orderFlower: {
        orderSatin: {
          flowers: [[23001, 1]],
          finishCnt: 10,
          isVideo: 0,
          cTime: "2026-06-16T02:00:00.000Z",
          cdTime: "2026-06-16T02:00:00.000Z",
        },
        orderDecorate: {
          flowers: [[23002, 2]],
          finishCnt: 11,
          isVideo: 1,
          cTime: "2026-06-16T02:35:44.621Z",
          cdTime: "2026-06-16T02:35:44.621Z",
        },
      },
    },
  };
  const update = {
    orderFlowerTot: {
      orderFlower: {
        orderSatin: {
          flowers: [[23003, 3]],
          finishCnt: 11,
          isVideo: 1,
          cTime: "2026-06-16T02:35:44.621Z",
          cdTime: "2026-06-16T02:35:44.621Z",
        },
        orderDecorate: {},
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.orderFlowerTot.orderFlower.orderSatin.flowers, [[23003, 3]]);
  assert.equal(merged.orderFlowerTot.orderFlower.orderSatin.finishCnt, 11);
  assert.deepEqual(merged.orderFlowerTot.orderFlower.orderDecorate, {});
});

test("mergeGameSync projects explicit OrderFlowerCtrl fields and preserves only fields absent from the response", () => {
  const completedSatin = {
    flowers: [[23031, 3]],
    finishCnt: 53,
    isVideo: 0,
    cTime: "2026-09-01T18:53:00.000+08:00",
    cdTime: "2026-09-01T18:54:00.000+08:00",
  };
  const completedDecorate = {
    flowers: [[23041, 2]],
    finishCnt: 52,
    isVideo: 0,
    cTime: "2026-09-01T18:53:00.000+08:00",
    cdTime: "2026-09-01T18:54:00.000+08:00",
  };
  const previous = {
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { ...completedSatin, finishCnt: 52, flowers: [[23030, 1]] },
        orderDecorate: { ...completedDecorate, finishCnt: 51, flowers: [[23040, 1]] },
        orderMap: {
          1: { boxId: 1, npcId: 101, finishCnt: 4 },
        },
      },
    },
  };

  const afterFinish = mergeGameSync(previous, {
    orderFlowerTot: {
      orderFlower: {
        orderSatin: completedSatin,
        orderDecorate: completedDecorate,
      },
    },
  });
  const afterUnrelatedResponse = mergeGameSync(afterFinish, {
    $usrTot: { data: { bag: { 23031: 0 } } },
  });
  assert.equal(afterUnrelatedResponse.orderFlowerTot.orderFlower.orderSatin.finishCnt, 53);
  assert.equal(afterUnrelatedResponse.orderFlowerTot.orderFlower.orderDecorate.finishCnt, 52);
  assert.deepEqual(afterUnrelatedResponse.orderFlowerTot.orderFlower.orderMap, {
    1: { boxId: 1, npcId: 101, finishCnt: 4 },
  });

  const afterExplicitSnapshot = mergeGameSync(afterUnrelatedResponse, {
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { ...completedSatin, finishCnt: 54, flowers: [[23032, 2]] },
        orderDecorate: null,
        orderMap: {},
      },
    },
  });
  assert.deepEqual(afterExplicitSnapshot.orderFlowerTot.orderFlower.orderSatin, {
    ...completedSatin, finishCnt: 54, flowers: [[23032, 2]],
  });
  assert.equal(afterExplicitSnapshot.orderFlowerTot.orderFlower.orderDecorate, null);
  assert.deepEqual(afterExplicitSnapshot.orderFlowerTot.orderFlower.orderMap, {});
});

test("mergeGameSync replaces a special order when its field is explicitly present", () => {
  const oldSatin = {
    flowers: [[23006, 3], [23016, 3]],
    finishCnt: 11,
    isVideo: 0,
    cTime: "2026-09-01T18:50:49.000+08:00",
    cdTime: "2026-09-01T18:51:49.000+08:00",
  };
  const currentSatin = {
    flowers: [[23003, 2], [23122, 3], [23002, 1]],
    finishCnt: 12,
    isVideo: 0,
    cTime: "2026-09-01T18:51:52.000+08:00",
    cdTime: "2026-09-01T18:52:52.000+08:00",
  };
  const mergedCurrent = mergeGameSync(
    { orderFlowerTot: { orderFlower: { orderSatin: oldSatin } } },
    { orderFlowerTot: { orderFlower: { orderSatin: currentSatin } } },
  );
  const afterStaleResponse = mergeGameSync(mergedCurrent, {
    orderFlowerTot: { orderFlower: { orderSatin: oldSatin } },
  });

  assert.deepEqual(afterStaleResponse.orderFlowerTot.orderFlower.orderSatin, oldSatin);
});

test("mergeGameSync projects an explicit special-order snapshot without local time heuristics", () => {
  const base = {
    flowers: [[23001, 1]], finishCnt: 12, isVideo: 0,
    cTime: "2026-09-01T18:51:52.000+08:00",
    cdTime: "2026-09-01T18:52:52.000+08:00",
  };
  const merged = mergeGameSync(
    { orderFlowerTot: { orderFlower: { orderSatin: base } } },
    { orderFlowerTot: { orderFlower: { orderSatin: {
      ...base, finishCnt: 13, cdTime: "not-a-time",
    } } } },
  );
  const satin = merged.orderFlowerTot.orderFlower.orderSatin;
  assert.equal(satin.cdTime, "not-a-time");
  assert.equal(satin.finishCnt, 13);
});

test("mergeGameSync accepts a later-day special order reset and same-task video state", () => {
  const base = {
    flowers: [[23001, 1]],
    finishCnt: 63,
    isVideo: 0,
    cTime: "2026-09-01T23:59:00.000+08:00",
    cdTime: "2026-09-01T23:59:30.000+08:00",
  };
  const dailyReset = {
    flowers: [[23002, 1]],
    finishCnt: 0,
    isVideo: 1,
    cTime: "2026-09-02T00:01:00.000+08:00",
    cdTime: "2026-09-02T00:01:00.000+08:00",
  };
  const afterReset = mergeGameSync(
    { orderFlowerTot: { orderFlower: { orderSatin: base } } },
    { orderFlowerTot: { orderFlower: { orderSatin: dailyReset } } },
  );
  const afterVideoState = mergeGameSync(afterReset, {
    orderFlowerTot: { orderFlower: { orderSatin: { ...dailyReset, isVideo: 0 } } },
  });

  assert.deepEqual(afterReset.orderFlowerTot.orderFlower.orderSatin, dailyReset);
  assert.equal(afterVideoState.orderFlowerTot.orderFlower.orderSatin.isVideo, 0);
  assert.deepEqual(afterVideoState.orderFlowerTot.orderFlower.orderSatin.flowers, [[23002, 1]]);
});

test("mergeGameSync keeps Shanghai business-day special-order resets timezone independent", () => {
  const moduleUrl = new URL("./garden-state.mjs", import.meta.url).href;
  const script = `
    import { mergeGameSync } from ${JSON.stringify(moduleUrl)};
    const base = { orderFlowerTot: { orderFlower: { orderSatin: {
      flowers: [[23001, 1]], finishCnt: 63, isVideo: 0,
      cTime: "2026-09-01T23:59:00.000+08:00", cdTime: "2026-09-01T23:59:30.000+08:00"
    } } } };
    const update = { orderFlowerTot: { orderFlower: { orderSatin: {
      flowers: [[23002, 1]], finishCnt: 0, isVideo: 0,
      cTime: "2026-09-02T00:01:00.000+08:00", cdTime: "2026-09-02T00:01:00.000+08:00"
    } } } };
    process.stdout.write(JSON.stringify(mergeGameSync(base, update).orderFlowerTot.orderFlower.orderSatin));
  `;
  const run = (TZ) => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, TZ },
  });
  const utc = run("UTC");
  const shanghai = run("Asia/Shanghai");
  assert.equal(utc, shanghai);
  assert.equal(JSON.parse(utc).finishCnt, 0);
});

test("mergeGameSync preserves sparse team order fields and replaces explicit stored orders", () => {
  const base = {
    orderTeamTot: {
      orderTeam: {
        status: 2,
        startTime: 1_000,
        activeTime: 900,
        orderNum: 7,
        flowerId: 23001,
        rwd: { 2: 100 },
        highCntMap: { 4: 2 },
        storedOrders: [{ npcId: 2, expireTime: 9_000 }],
      },
    },
  };
  const update = {
    orderTeamTot: {
      orderTeam: {
        orderNum: 8,
        rwd: { 11: 200 },
        highCntMap: { 5: 3 },
        storedOrders: [],
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(merged.orderTeamTot.orderTeam.startTime, 1_000);
  assert.equal(merged.orderTeamTot.orderTeam.flowerId, 23001);
  assert.deepEqual(merged.orderTeamTot.orderTeam.rwd, { 2: 100, 11: 200 });
  assert.deepEqual(merged.orderTeamTot.orderTeam.highCntMap, { 4: 2, 5: 3 });
  assert.deepEqual(merged.orderTeamTot.orderTeam.storedOrders, []);
});

test("mergeGameSync preserves stored team orders when update explicitly sends null", () => {
  const base = {
    orderTeamTot: {
      orderTeam: {
        storedOrders: [{ npcId: 2, expireTime: 9_000 }],
      },
    },
  };
  const update = {
    orderTeamTot: {
      orderTeam: {
        storedOrders: null,
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.orderTeamTot.orderTeam.storedOrders, [{ npcId: 2, expireTime: 9_000 }]);
});

test("mergeGameSync applies team order itemAddChg only once", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          300808: 2,
        },
      },
    },
    orderTeamTot: {
      orderTeam: {
        status: 2,
        rwd: { 2: 100 },
      },
    },
  };
  const update = {
    $usrTot: {
      itemAddChg: {
        itemMap: {
          300808: -1,
        },
      },
    },
    orderTeamTot: {
      orderTeam: {
        rwd: { 11: 200 },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[300808], 1);
  assert.deepEqual(merged.orderTeamTot.orderTeam.rwd, { 2: 100, 11: 200 });
});

test("mergeGameSync applies positive team order itemAddChg only once", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          300808: 2,
        },
      },
    },
    orderTeamTot: {
      orderTeam: {
        rwd: { 2: 100 },
      },
    },
  };
  const update = {
    $usrTot: {
      itemAddChg: {
        itemMap: {
          300808: 1,
        },
      },
    },
    orderTeamTot: {
      orderTeam: {
        rwd: { 11: 200 },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(getBag(merged)[300808], 3);
  assert.deepEqual(merged.orderTeamTot.orderTeam.rwd, { 2: 100, 11: 200 });
});

test("mergeGameSync preserves higher same-day user counts when later order sync omits or resets them", () => {
  const base = {
    $usrTot: {
      cntMap: {
        109: { type: 109, tdyCnt: 40, totCnt: 3025, rTime: "2026-06-16T05:19:34.280Z" },
        116: { type: 116, tdyCnt: 39, totCnt: 1902, rTime: "2026-06-16T05:19:35.133Z" },
      },
    },
  };

  const omitted = mergeGameSync(base, {
    $usrTot: {
      cntMap: {
        116: { type: 116, tdyCnt: 40, totCnt: 1903, rTime: "2026-06-16T05:24:00.821Z" },
      },
    },
  });

  assert.equal(omitted.$usrTot.cntMap[109].tdyCnt, 40);
  assert.equal(omitted.$usrTot.cntMap[116].tdyCnt, 40);

  const reset = mergeGameSync(omitted, {
    $usrTot: {
      cntMap: {
        109: { type: 109, tdyCnt: 0, totCnt: 3025, rTime: "2026-06-16T05:24:00.770Z" },
      },
    },
  });

  assert.equal(reset.$usrTot.cntMap[109].tdyCnt, 40);
  assert.equal(reset.$usrTot.cntMap[109].totCnt, 3025);
});

test("mergeGameSync merges customer order maps independently from resident orders", () => {
  const base = {
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1 },
        },
      },
    },
  };
  const update = {
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          9: { artId: 300102, num: 2 },
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.orderCustomerTot.orderCustomer.orderMap, {
    8: { artId: 300101, num: 1 },
    9: { artId: 300102, num: 2 },
  });
});

test("mergeGameSync clears customer orders when server sends an empty customer order map", () => {
  const base = {
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          6: { artId: 301603, num: 2 },
        },
      },
    },
  };
  const update = {
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {},
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.orderCustomerTot.orderCustomer.orderMap, {});
});

test("removeCustomerOrder drops a handled customer order from local sync state", () => {
  const sync = {
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          3: { artId: 300622, num: 3 },
          5: { artId: 302923, num: 3 },
        },
      },
    },
  };

  const next = removeCustomerOrder(sync, 3);

  assert.deepEqual(next.orderCustomerTot.orderCustomer.orderMap, {
    5: { artId: 302923, num: 3 },
  });
  assert.deepEqual(sync.orderCustomerTot.orderCustomer.orderMap, {
    3: { artId: 300622, num: 3 },
    5: { artId: 302923, num: 3 },
  });
});

test("mergeGameSync merges activity map batches and nested cyclic story fields", () => {
  const base = {
    actTot: {
      map: {
        90001: {
          batchId: 90001,
          tmpType: 4003,
          score: 1,
          ext: { cyclicStory: { expOrderNum: 1 } },
        },
        80001: { batchId: 80001, tmpType: 4002 },
      },
    },
  };
  const update = {
    actTot: {
      map: {
        90001: {
          batchId: 90001,
          tmpType: 4003,
          ext: {
            cyclicStory: {
              orderInfo: {
                0: { orderId: 1, flowerId: 23001 },
              },
            },
          },
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(merged.actTot.map[80001].tmpType, 4002);
  assert.equal(merged.actTot.map[90001].score, 1);
  assert.equal(merged.actTot.map[90001].ext.cyclicStory.expOrderNum, 1);
  assert.equal(merged.actTot.map[90001].ext.cyclicStory.orderInfo[0].flowerId, 23001);
});

test("mergeGameSync sparsely merges activity taskRcdMap records by key and field", () => {
  const base = {
    actTot: {
      taskRcdMap: {
        "329|0": { batchId: 329, idx: 0, progress: { 1001: 1, 1002: 2 }, recvMap: {} },
        "401|0": { batchId: 401, idx: 0, progress: { 2001: 2 }, recvMap: { 2001: 1 } },
      },
    },
  };
  const recvOnlyUpdate = {
    actTot: {
      taskRcdMap: {
        "329|0": { recvMap: { 1001: 1 } },
      },
    },
  };

  const mergedAfterRecv = mergeGameSync(base, recvOnlyUpdate);
  const merged = mergeGameSync(mergedAfterRecv, {
    actTot: {
      taskRcdMap: {
        "329|0": { progress: { 1001: 80 } },
      },
    },
  });

  assert.deepEqual(merged.actTot.taskRcdMap["401|0"], base.actTot.taskRcdMap["401|0"]);
  assert.deepEqual(
    mergedAfterRecv.actTot.taskRcdMap["329|0"].progress,
    base.actTot.taskRcdMap["329|0"].progress,
  );
  assert.deepEqual(mergedAfterRecv.actTot.taskRcdMap["329|0"].recvMap, { 1001: 1 });
  assert.equal(merged.actTot.taskRcdMap["329|0"].batchId, 329);
  assert.equal(merged.actTot.taskRcdMap["329|0"].idx, 0);
  assert.deepEqual(merged.actTot.taskRcdMap["329|0"].progress, { 1001: 80 });
  assert.deepEqual(merged.actTot.taskRcdMap["329|0"].recvMap, { 1001: 1 });
});

test("mergeGameSync replaces cyclic note taskList with explicit list from update", () => {
  const base = {
    actTot: {
      map: {
        90001: {
          batchId: 90001,
          tmpType: 4003,
          ext: {
            cyclicNote: {
              taskList: [1001, 1002, 1003],
              phase: "waiting",
            },
          },
        },
      },
    },
  };
  const update = {
    actTot: {
      map: {
        90001: {
          batchId: 90001,
          tmpType: 4003,
          ext: {
            cyclicNote: {
              taskList: [2001, 2002, 2003],
              phase: "ready",
            },
          },
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.actTot.map[90001].ext.cyclicNote.taskList, [2001, 2002, 2003]);
});

test("mergeGameSync clears cyclic note taskList when update sends an empty list", () => {
  const base = {
    actTot: {
      map: {
        90001: {
          batchId: 90001,
          tmpType: 4003,
          ext: {
            cyclicNote: {
              taskList: [1001, 1002, 1003],
              phase: "waiting",
            },
          },
        },
      },
    },
  };
  const update = {
    actTot: {
      map: {
        90001: {
          batchId: 90001,
          tmpType: 4003,
          ext: {
            cyclicNote: {
              taskList: [],
            },
          },
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.actTot.map[90001].ext.cyclicNote.taskList, []);
});

test("mergeGameSync preserves cyclic note taskList when update omits it and merges other cyclic note fields", () => {
  const base = {
    actTot: {
      map: {
        90001: {
          batchId: 90001,
          tmpType: 4003,
          ext: {
            cyclicNote: {
              taskList: [1001, 1002, 1003],
              phase: "waiting",
              lastUpdated: "old",
            },
          },
        },
      },
    },
  };
  const update = {
    actTot: {
      map: {
        90001: {
          batchId: 90001,
          tmpType: 4003,
          ext: {
            cyclicNote: {
              phase: "ready",
              cycleCount: 2,
            },
          },
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.actTot.map[90001].ext.cyclicNote.taskList, [1001, 1002, 1003]);
  assert.equal(merged.actTot.map[90001].ext.cyclicNote.phase, "ready");
  assert.equal(merged.actTot.map[90001].ext.cyclicNote.cycleCount, 2);
});

test("mergeGameSync clears cyclic story orders when update explicitly sends empty orderInfo", () => {
  const base = {
    actTot: {
      map: {
        90001: {
          batchId: 90001,
          tmpType: 4003,
          ext: {
            cyclicStory: {
              expOrderNum: 1,
              orderInfo: {
                0: { orderId: 1, flowerId: 23001 },
              },
            },
          },
        },
      },
    },
  };
  const update = {
    actTot: {
      map: {
        90001: {
          batchId: 90001,
          tmpType: 4003,
          ext: {
            cyclicStory: {
              orderInfo: {},
            },
          },
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.actTot.map[90001].ext.cyclicStory.orderInfo, {});
  assert.equal(merged.actTot.map[90001].ext.cyclicStory.expOrderNum, 1);
});

test("mergeGameSync merges pearl place and recommendation maps without dropping existing places", () => {
  const base = {
    pearlTot: {
      pearl: {
        recvDailyDate: "2026-06-15T00:00:00.000Z",
      },
      placeMap: {
        1: {
          placeId: 1,
          laborUid: 7001,
          laborEndTime: "2026-06-16T03:00:00.000Z",
        },
      },
      otherHireMap: {
        7002: "2026-06-16T02:00:00.000Z",
      },
      recommendUserMap: {
        7001: { nickName: "小花匠" },
      },
      recommendList: [7001, 7002],
    },
  };
  const update = {
    pearlTot: {
      placeMap: {
        2: {
          placeId: 2,
        },
      },
      otherHireMap: {
        7003: "2026-06-16T04:00:00.000Z",
      },
      recommendUserMap: {
        7003: { nickName: "采珠人" },
      },
      recommendList: [7003],
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(Object.keys(merged.pearlTot.placeMap).sort(), ["1", "2"]);
  assert.equal(merged.pearlTot.pearl.recvDailyDate, "2026-06-15T00:00:00.000Z");
  assert.deepEqual(merged.pearlTot.otherHireMap, {
    7002: "2026-06-16T02:00:00.000Z",
    7003: "2026-06-16T04:00:00.000Z",
  });
  assert.deepEqual(merged.pearlTot.recommendUserMap, {
    7001: { nickName: "小花匠" },
    7003: { nickName: "采珠人" },
  });
  assert.deepEqual(merged.pearlTot.recommendList, [7003]);
});

test("mergeGameSync keeps active pearl labor fields when sparse place sync arrives", () => {
  const base = {
    pearlTot: {
      placeMap: {
        3: {
          placeId: 3,
          laborUid: 7003,
          laborEndTime: "2026-06-17T06:06:54.568Z",
          everyMakeNum: 3,
          recvCnt: 0,
          surplusRecvNum: 0,
        },
      },
    },
  };
  const update = {
    pearlTot: {
      placeMap: {
        3: {
          placeId: 3,
          laborUid: 0,
          laborEndTime: null,
          recvCnt: 4,
          surplusRecvNum: 12,
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(merged.pearlTot.placeMap[3].laborUid, 7003);
  assert.equal(merged.pearlTot.placeMap[3].laborEndTime, "2026-06-17T06:06:54.568Z");
  assert.equal(merged.pearlTot.placeMap[3].everyMakeNum, 3);
  assert.equal(merged.pearlTot.placeMap[3].recvCnt, 4);
  assert.equal(merged.pearlTot.placeMap[3].surplusRecvNum, 12);
});

test("mergeGameSync clears pearl labor fields when sync marks a completed place empty", () => {
  const base = {
    pearlTot: {
      placeMap: {
        1: {
          placeId: 1,
          laborUid: 7001,
          laborEndTime: "2026-06-17T06:06:54.568Z",
          everyMakeNum: 5,
          recvCnt: 38,
          surplusRecvNum: 0,
          eventId: 2,
        },
      },
    },
  };
  const update = {
    pearlTot: {
      placeMap: {
        1: {
          placeId: 1,
          laborUid: 0,
          laborEndTime: null,
          everyMakeNum: 0,
          recvCnt: 0,
          surplusRecvNum: 0,
          eventId: 0,
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.equal(merged.pearlTot.placeMap[1].laborUid, 0);
  assert.equal(merged.pearlTot.placeMap[1].laborEndTime, null);
  assert.equal(merged.pearlTot.placeMap[1].everyMakeNum, 0);
  assert.equal(merged.pearlTot.placeMap[1].eventId, 0);
});

test("mergeGameSync replaces visible material shop rows and purchase records from shopCultivate sync", () => {
  const base = {
    shopCultivate: {
      infoMap: {
        10001: [11, 3200],
        10002: [11, 4200],
      },
      bRecord: {
        10001: 1,
      },
      larTime: "2026-06-17T00:00:00.000Z",
    },
  };
  const refresh = mergeGameSync(base, {
    shopCultivate: {
      infoMap: {
        10003: [11, 5000],
      },
      bRecord: {},
      larTime: "2026-06-17T01:00:00.000Z",
    },
  });

  assert.deepEqual(refresh.shopCultivate.infoMap, {
    10003: [11, 5000],
  });
  assert.deepEqual(refresh.shopCultivate.bRecord, {});
  assert.equal(refresh.shopCultivate.larTime, "2026-06-17T01:00:00.000Z");
});

test("summarizeLand separates empty, mature, and growing land", () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 100000).toISOString();
  const land = summarizeLand({
    usrLandTot: {
      usrLand: {
        landMap: {
          1001: {},
          1002: { state: 2, flowerId: 23001, nextTime: past },
          1003: { state: 2, flowerId: 23002, nextTime: future },
          1004: { state: 3, flowerId: 23003 },
        },
      },
    },
  });

  assert.deepEqual(land.empty, [1001]);
  assert.deepEqual(land.mature.map((item) => item.landId), [1002, 1004]);
  assert.deepEqual(land.growing.map((item) => item.landId), [1003]);
});

test("harvested flower is not repeatedly selected after its inventory increases", () => {
  const base = {
    $usrTot: {
      data: {
        bag: {
          23001: 0,
          23002: 0,
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 11, cTime: "2026-01-01T00:00:00.000Z" },
        23002: { flowerId: 23002, lvl: 12, cTime: "2026-01-02T00:00:00.000Z" },
      },
    },
  };
  const afterHarvest = mergeGameSync(base, {
    $usrTot: {
      itemAddChg: {
        itemMap: {
          23001: 52,
        },
      },
    },
  });

  assert.equal(summarizePlantCandidates(afterHarvest)[0].flowerId, 23002);
});

test("mergeGameSync replaces orderMap when the server explicitly supplies it", () => {
  // Official OrderFlowerCtrl.setData receives orderMap as one controller field.
  // An explicit map is therefore a replacement snapshot, not a per-box patch.
  const base = {
    orderFlowerTot: {
      orderFlower: {
        orderMap: {
          1: { npcId: 8, isVideo: 1, cdTime: "2026-08-19T08:16:34.755Z" },
          2: { npcId: 3, flowers: [{ iid: 23001, num: 5 }], __refillPending: true, refillSource: "ordinary-resident-order-submitted", refillCooldownSeconds: 42 },
          3: { npcId: 8, isVideo: 1, cdTime: "2026-08-19T08:39:55.316Z" },
        },
      },
    },
  };
  // 服务端快照只含 1、3，boxId 2 已不在该次快照。
  const update = {
    orderFlowerTot: {
      orderFlower: {
        orderMap: {
          1: { npcId: 8, isVideo: 1, cdTime: "2026-08-19T08:16:34.755Z" },
          3: { npcId: 8, isVideo: 1, cdTime: "2026-08-19T08:39:55.316Z" },
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  const orderMap = merged.orderFlowerTot.orderFlower.orderMap;
  assert.equal(orderMap[2], undefined, "显式服务器快照不得残留旧 boxId 2");
  assert.equal(orderMap[1].npcId, 8);
  assert.equal(orderMap[3].npcId, 8);
});

test("mergeGameSync lets the server order override a local refill marker on the same boxId", () => {
  // 服务端在 boxId 1 下发了新订单：服务端数据覆盖本地（含清除本地残留标记）。
  const base = {
    orderFlowerTot: {
      orderFlower: {
        orderMap: {
          1: { npcId: 1, isVideo: 0, __refillPending: true },
        },
      },
    },
  };
  const update = {
    orderFlowerTot: {
      orderFlower: {
        orderMap: {
          1: { npcId: 9, isVideo: 0 },
        },
      },
    },
  };

  const merged = mergeGameSync(base, update);

  assert.deepEqual(merged.orderFlowerTot.orderFlower.orderMap, {
    1: { npcId: 9, isVideo: 0 },
  });
});
