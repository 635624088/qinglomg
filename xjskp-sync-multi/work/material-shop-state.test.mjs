import assert from "node:assert/strict";
import test from "node:test";

import {
  MATERIAL_SHOP_IFACES,
  calculateMaterialShopRefreshCost,
  getMaterialShopMidnightRefreshPlan,
  summarizeMaterialShopStatus,
  verifyMaterialShopRefreshOutcome,
} from "./material-shop-state.mjs";

function makeConfig() {
  return {
    sourcePath: "test-config",
    byShopId: {
      10001: {
        shopId: 10001,
        itemId: 1401,
        itemNum: 1,
        priceItemId: 11,
        basePriceNum: 3200,
        limitNum: 1,
        unlockLevel: 1,
        sort: 1,
      },
      10002: {
        shopId: 10002,
        itemId: 1402,
        itemNum: 1,
        priceItemId: 11,
        basePriceNum: 4200,
        limitNum: 1,
        unlockLevel: 1,
        sort: 2,
      },
      10003: {
        shopId: 10003,
        itemId: 1403,
        itemNum: 1,
        priceItemId: 1,
        basePriceNum: 5,
        limitNum: 1,
        unlockLevel: 5,
        sort: 3,
      },
    },
    autoRefreshSeconds: 9000,
    freeRefreshTimes: 3,
  };
}

const itemNameMap = {
  1: "元宝",
  11: "金币",
  1401: "杀虫剂",
  1402: "抑菌剂",
  1403: "除螨液",
};

test("material shop refresh cost follows the official mrCount formula", () => {
  assert.deepEqual(
    Array.from({ length: 11 }, (_, mrCount) => calculateMaterialShopRefreshCost(mrCount)),
    [0, 0, 0, 1, 2, 4, 8, 12, 16, 20, 20],
  );
});

test("material shop midnight refresh plan enforces the local window and inclusive cost threshold", () => {
  const makeSync = (mrCount, dmd = 100) => ({
    $usrTot: { data: { dmd, gld: 999999, bag: {} } },
    shopCultivate: { mrCount, infoMap: {}, bRecord: {} },
  });
  const baseOptions = {
    enabled: true,
    materialShopConfig: makeConfig(),
    windowStart: "23:50",
    windowEnd: "24:00",
    maxCostYuanbao: 4,
  };

  assert.equal(getMaterialShopMidnightRefreshPlan(makeSync(0), {
    ...baseOptions,
    now: new Date(2026, 7, 3, 23, 49, 59),
  }).shouldRefresh, false);

  const free = getMaterialShopMidnightRefreshPlan(makeSync(0), {
    ...baseOptions,
    now: new Date(2026, 7, 3, 23, 50, 0),
  });
  assert.equal(free.shouldRefresh, true);
  assert.equal(free.refreshKind, "free");
  assert.equal(free.remainingFreeRefreshTimes, 3);
  assert.equal(free.nextRefreshCostYuanbao, 0);

  const paid = getMaterialShopMidnightRefreshPlan(makeSync(5), {
    ...baseOptions,
    now: new Date(2026, 7, 3, 23, 55, 0),
  });
  assert.equal(paid.shouldRefresh, true);
  assert.equal(paid.refreshKind, "paid");
  assert.equal(paid.nextRefreshCostYuanbao, 4);

  const capped = getMaterialShopMidnightRefreshPlan(makeSync(6), {
    ...baseOptions,
    now: new Date(2026, 7, 3, 23, 55, 0),
  });
  assert.equal(capped.shouldRefresh, false);
  assert.equal(capped.nextRefreshCostYuanbao, 8);
  assert.equal(capped.reason, "refresh-cost-limit-reached");

  const inclusiveEight = getMaterialShopMidnightRefreshPlan(makeSync(6), {
    ...baseOptions,
    maxCostYuanbao: 8,
    now: new Date(2026, 7, 3, 23, 55, 0),
  });
  assert.equal(inclusiveEight.shouldRefresh, true);
  assert.equal(inclusiveEight.maxCostYuanbao, 8);

  const inclusiveSixteen = getMaterialShopMidnightRefreshPlan(makeSync(8), {
    ...baseOptions,
    maxCostYuanbao: 16,
    now: new Date(2026, 7, 3, 23, 55, 0),
  });
  assert.equal(inclusiveSixteen.shouldRefresh, true);
  assert.equal(inclusiveSixteen.nextRefreshCostYuanbao, 16);

  const hardCapped = getMaterialShopMidnightRefreshPlan(makeSync(9), {
    ...baseOptions,
    maxCostYuanbao: 100,
    now: new Date(2026, 7, 3, 23, 55, 0),
  });
  assert.equal(hardCapped.shouldRefresh, false);
  assert.equal(hardCapped.maxCostYuanbao, 16);
  assert.equal(hardCapped.reason, "refresh-cost-limit-reached");

  const freeOnly = getMaterialShopMidnightRefreshPlan(makeSync(3), {
    ...baseOptions,
    maxCostYuanbao: 0,
    now: new Date(2026, 7, 3, 23, 55, 0),
  });
  assert.equal(freeOnly.shouldRefresh, false);
  assert.equal(freeOnly.maxCostYuanbao, 0);
  assert.equal(freeOnly.reason, "refresh-cost-limit-reached");

  const insufficient = getMaterialShopMidnightRefreshPlan(makeSync(5, 3), {
    ...baseOptions,
    now: new Date(2026, 7, 3, 23, 55, 0),
  });
  assert.equal(insufficient.shouldRefresh, false);
  assert.equal(insufficient.reason, "yuanbao-insufficient");
});

test("paid material shop refresh requires an explicit balance and exact safe outcome", () => {
  const beforeSync = {
    $usrTot: { data: { dmd: 100, gld: 999999, bag: {} } },
    shopCultivate: { mrCount: 3, infoMap: {}, bRecord: {} },
  };
  const afterSync = {
    $usrTot: { data: { dmd: 99, gld: 999999, bag: {} } },
    shopCultivate: { mrCount: 4, infoMap: {}, bRecord: {} },
  };

  assert.deepEqual(
    verifyMaterialShopRefreshOutcome({
      beforeSync,
      afterSync,
      refreshValue: { $usrTot: { data: { dmd: 99 } }, shopCultivate: { mrCount: 4 } },
      enterValue: null,
      expectedCostYuanbao: 1,
    }),
    {
      confirmed: true,
      reason: "paid-refresh-confirmed",
      beforeManualRefreshCount: 3,
      afterManualRefreshCount: 4,
      beforeYuanbao: 100,
      afterYuanbao: 99,
      actualSpentYuanbao: 1,
      charged: true,
    },
  );

  const missingBalance = verifyMaterialShopRefreshOutcome({
    beforeSync,
    afterSync: { ...afterSync, $usrTot: beforeSync.$usrTot },
    refreshValue: { shopCultivate: { mrCount: 4 } },
    enterValue: { shopCultivate: { mrCount: 4 } },
    expectedCostYuanbao: 1,
  });
  assert.equal(missingBalance.confirmed, false);
  assert.equal(missingBalance.reason, "paid-balance-not-confirmed");
});

test("summarizeMaterialShopStatus lists visible material rows and buys all when gold is enough", () => {
  const sync = {
    $usrTot: {
      data: {
        gld: 7400,
        bag: {},
      },
    },
    shopCultivate: {
      infoMap: {
        10001: [11, 3200],
        10002: [11, 4200],
      },
      bRecord: {},
      larTime: "2026-06-17T00:00:00.000Z",
    },
  };

  const status = summarizeMaterialShopStatus(sync, {
    materialShopConfig: makeConfig(),
    itemNameMap,
    nowMs: Date.parse("2026-06-17T01:00:00.000Z"),
  });

  assert.equal(status.goldCount, 7400);
  assert.equal(status.totalGoldCost, 7400);
  assert.equal(status.canBuyAll, true);
  assert.equal(status.actions.length, 2);
  assert.deepEqual(status.actions.map((action) => action.iface), [
    MATERIAL_SHOP_IFACES.buy,
    MATERIAL_SHOP_IFACES.buy,
  ]);
  assert.deepEqual(status.actions.map((action) => action.args), [
    { shopId: 10001 },
    { shopId: 10002 },
  ]);
  assert.equal(status.rows[0].itemName, "杀虫剂");
  assert.equal(status.rows[0].priceText, "3200 金币");
  assert.equal(status.refresh.remainingMs, 5400 * 1000);
  assert.equal(status.refresh.remainingFreeRefreshTimes, 3);
  assert.equal(status.refresh.nextRefreshCostYuanbao, 0);
});

test("summarizeMaterialShopStatus skips purchases when gold cannot cover every visible material", () => {
  const sync = {
    $usrTot: {
      data: {
        gld: 7399,
        bag: {},
      },
    },
    shopCultivate: {
      infoMap: {
        10001: [11, 3200],
        10002: [11, 4200],
      },
      bRecord: {},
    },
  };

  const status = summarizeMaterialShopStatus(sync, {
    materialShopConfig: makeConfig(),
    itemNameMap,
  });

  assert.equal(status.totalGoldCost, 7400);
  assert.equal(status.canBuyAll, false);
  assert.equal(status.actions.length, 0);
  assert.match(status.reasonText, /金币不足/);
});

test("summarizeMaterialShopStatus does not auto-buy non-gold rows or sold-out rows", () => {
  const sync = {
    $usrTot: {
      data: {
        gld: 999999,
        bag: {},
      },
    },
    shopCultivate: {
      infoMap: {
        10001: [11, 3200],
        10002: [11, 4200],
        10003: [1, 5],
      },
      bRecord: {
        10002: 1,
      },
    },
  };

  const status = summarizeMaterialShopStatus(sync, {
    materialShopConfig: makeConfig(),
    itemNameMap,
  });

  assert.equal(status.blockedCurrencyCount, 1);
  assert.equal(status.boughtOutCount, 1);
  assert.equal(status.canBuyAll, false);
  assert.equal(status.actions.length, 0);
  assert.deepEqual(status.rows.map((row) => [row.shopId, row.statusText]), [
    [10001, "可购买"],
    [10002, "已售罄"],
    [10003, "非金币"],
  ]);
});
