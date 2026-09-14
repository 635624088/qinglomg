import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FLOWER_CURRENCY_ITEM_ID,
  ORDER_FLOWER_IFACES,
  getAutoSubmitCustomerOrderActions,
  getAutoSubmitOrderActions,
  getAutoSubmitPalaceOrderActions,
  getCustomerOrderDailyLimitStatus,
  loadOrderCustomerNpcConfig,
  loadOrderFlowerConfig,
  markOrdinaryResidentOrderRefill,
  markSpecialOrderStockRejection,
  summarizeFlowerArtInventory,
  summarizeOrderCustomerStatus,
  summarizeOrderFlowerStatus,
  summarizeOrderPalaceStatus,
} from "./order-state.mjs";

const NOW = Date.parse("2026-06-16T02:00:00.000Z");

function customerArt(id, currencyAmount, overrides = {}) {
  return {
    id,
    vaseId: 3061,
    flowerIds: [],
    cPrice: [[FLOWER_CURRENCY_ITEM_ID, currencyAmount]],
    ...overrides,
  };
}

function historicalCustomerOrderHistory(accountId, historicalMaxReward = null) {
  return {
    available: true,
    accountId,
    minimumReward: 3,
    historicalMaxReward,
    threshold: Math.max(3, historicalMaxReward ?? 3),
    recordStatus: historicalMaxReward == null ? "missing-account" : "recorded",
    sourceStatus: "loaded",
    historyPath: "fixture:customer-order-history",
  };
}

test("loadOrderCustomerNpcConfig decodes the optional global npcMaxDay field", async (t) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-npc-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  const configPath = path.join(rootDir, "g-data.fixture.text");
  await fsp.writeFile(configPath, JSON.stringify({
    c_orderCustomerNpc: {
      colMap: {
        "$": "id",
        "$npcId": "$npcId",
        "$createCd": "$createCd",
        "$createNum": "$createNum",
        "$npcMax": "$npcMax",
        "$firstNPC": "$firstNPC",
        "$npcMaxDay": "$npcMaxDay",
      },
      list: [{
        v: {
          "-1": {
            "$npcId": [1, 2],
            "$createCd": [60, 120],
            "$createNum": [1, 2],
            "$npcMax": 2,
            "$firstNPC": 1,
            "$npcMaxDay": 350,
          },
        },
      }],
    },
  }), "utf8");

  const loaded = loadOrderCustomerNpcConfig(configPath);

  assert.equal(loaded.npcMaxDay, 350);
  assert.deepEqual(loaded.npcIds, [1, 2]);
  assert.equal(loaded.npcMax, 2);
});

test("getCustomerOrderDailyLimitStatus exposes the official client generation boundary without inventing a finish limit", () => {
  const sync = {
    $usrTot: {
      cntMap: {
        107: { tdyCnt: 349, rTime: "2026-06-16T01:00:00.000Z" },
      },
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1 },
        },
      },
    },
  };

  const status = getCustomerOrderDailyLimitStatus(sync, {
    nowMs: NOW,
    orderCustomerNpcConfig: {
      sourcePath: "fixture:c_orderCustomerNpc",
      npcMaxDay: 350,
    },
  });

  assert.equal(status.countType, 107);
  assert.equal(status.tdyCompletedCount, 349);
  assert.equal(status.pendingOrderCount, 1);
  assert.equal(status.clientGenerationLimitReached, true);
  assert.equal(status.finishSubmissionLimitKnown, false);
  assert.equal(status.behaviorBoundary, "generation-only-client-evidence");

  const readyStatus = summarizeOrderCustomerStatus({
    ...sync,
    $usrTot: {
      ...sync.$usrTot,
      data: { bag: { 300101: 1 } },
    },
  }, {
    nowMs: NOW,
    orderCustomerNpcConfig: {
      sourcePath: "fixture:c_orderCustomerNpc",
      npcMaxDay: 350,
    },
    flowerArtConfig: { arts: { 300101: customerArt(300101, 1) } },
  });
  assert.equal(readyStatus.dailyLimit.clientGenerationLimitReached, true);
  assert.equal(getAutoSubmitCustomerOrderActions(readyStatus).length, 1);
});

test("customer order reward release mask defaults to only 3 and allows exact multi-select", () => {
  const sync = {
    $usrTot: { data: { bag: { 300101: 1, 300102: 1, 300103: 1 } } },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1 },
          9: { artId: 300102, num: 1 },
          10: { artId: 300103, num: 1 },
        },
      },
    },
  };
  const arts = {
    300101: customerArt(300101, 1),
    300102: customerArt(300102, 2),
    300103: customerArt(300103, 3),
  };

  const defaultStatus = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    flowerArtConfig: { arts },
  });
  assert.equal(defaultStatus.flowerCurrencySelection.releaseMask, 4);
  assert.deepEqual(
    getAutoSubmitCustomerOrderActions(defaultStatus).map((action) => [
      action.npcId,
      action.steps[0].type,
    ]),
    [[8, "rejectCustomerOrder"], [9, "rejectCustomerOrder"], [10, "finishCustomerOrder"]],
  );

  const multiStatus = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    flowerArtConfig: { arts },
    customerOrderFlowerCurrencyRewardReleaseMask: 5,
  });
  assert.deepEqual(
    multiStatus.flowerCurrencySelection.releaseRewards,
    [1, 3],
  );
  assert.deepEqual(
    getAutoSubmitCustomerOrderActions(multiStatus).map((action) => [
      action.npcId,
      action.steps[0].type,
    ]),
    [[9, "rejectCustomerOrder"], [8, "finishCustomerOrder"], [10, "finishCustomerOrder"]],
  );

  const pausedStatus = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    flowerArtConfig: { arts },
    customerOrderFlowerCurrencyRewardReleaseMask: 0,
  });
  assert.equal(pausedStatus.flowerCurrencySelection.status, "release-disabled");
  assert.deepEqual(getAutoSubmitCustomerOrderActions(pausedStatus), []);
});

test("customer order reward selection ignores historical availability and rejects known future values", () => {
  const baseSync = {
    $usrTot: { data: { bag: { 300101: 1 } } },
    orderCustomerTot: { orderCustomer: { orderMap: { 8: { artId: 300101, num: 1 } } } },
  };
  const unavailableStatus = summarizeOrderCustomerStatus(baseSync, {
    nowMs: NOW,
    customerOrderFlowerCurrencyHistory: {
      available: false,
      accountId: "account-a",
      recordStatus: "history-unavailable",
    },
    requireCustomerOrderFlowerCurrencyHistory: true,
    flowerArtConfig: { arts: { 300101: customerArt(300101, 3) } },
    customerOrderFlowerCurrencyRewardReleaseMask: 4,
  });
  assert.equal(unavailableStatus.flowerCurrencySelection.historyAvailable, false);
  assert.equal(unavailableStatus.flowerCurrencySelection.status, "ready");
  assert.equal(getAutoSubmitCustomerOrderActions(unavailableStatus)[0].steps[0].type, "finishCustomerOrder");

  const futureStatus = summarizeOrderCustomerStatus(baseSync, {
    nowMs: NOW,
    flowerArtConfig: { arts: { 300101: customerArt(300101, 4) } },
    customerOrderFlowerCurrencyRewardReleaseMask: 4,
  });
  assert.equal(futureStatus.orders[0].flowerCurrencyReward, 4);
  assert.equal(futureStatus.orders[0].flowerCurrencyDecision, "not-selected-reward");
  assert.equal(getAutoSubmitCustomerOrderActions(futureStatus)[0].steps[0].type, "rejectCustomerOrder");
});

test("customer order daily count is unknown when the official count value is missing", () => {
  const status = getCustomerOrderDailyLimitStatus({
    $usrTot: { cntMap: { 107: { rTime: "2026-06-16T01:00:00.000Z" } } },
  }, {
    nowMs: NOW,
    orderCustomerNpcConfig: { npcMaxDay: 350 },
  });
  assert.equal(status.dailyCountKnown, false);
  assert.equal(status.tdyCompletedCount, null);
  assert.equal(status.clientGenerationLimitReached, false);
});

test("customer order daily count fails closed for malformed count records", () => {
  for (const sync of [
    { $usrTot: { cntMap: { 107: { tdyCnt: 349, rTime: "not-a-date" } } } },
    { $usrTot: { cntMap: { 107: null } } },
    { $usrTot: { cntMap: [] } },
  ]) {
    const status = getCustomerOrderDailyLimitStatus(sync, {
      nowMs: NOW,
      orderCustomerNpcConfig: { npcMaxDay: 350 },
    });
    assert.equal(status.dailyCountKnown, false);
    assert.equal(status.tdyCompletedCount, null);
    assert.equal(status.clientGenerationLimitReached, false);
  }
});

test("customer order daily count treats a missing official record as zero", () => {
  const status = getCustomerOrderDailyLimitStatus({
    $usrTot: { cntMap: {} },
  }, {
    nowMs: NOW,
    orderCustomerNpcConfig: { npcMaxDay: 350 },
  });
  assert.equal(status.userCount.countSource, "official-missing-record");
  assert.equal(status.tdyCompletedCount, 0);
  assert.equal(status.dailyCountKnown, true);
});

test("selected customer rewards still use the existing priority rejection for confirmed shortages", () => {
  const status = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300101: 0 } } },
    orderCustomerTot: { orderCustomer: { orderMap: { 8: { artId: 300101, num: 1 } } } },
    flowerArtTot: { flowerArt: { makeList: [300101] } },
  }, {
    nowMs: NOW,
    bag: { 300101: 0 },
    bagSnapshotKnown: true,
    flowerArtConfig: {
      arts: { 300101: customerArt(300101, 3, { vaseId: 3001, flowerIds: [23001] }) },
    },
    customerOrderFlowerCurrencyRewardReleaseMask: 4,
  });
  assert.equal(status.orders[0].customerOrderPriorityRejectReason, "flower-stock-insufficient");
  assert.equal(getAutoSubmitCustomerOrderActions(status)[0].steps[0].type, "rejectCustomerOrder");
});

test("customer order auto submit uses the exact release list while retaining historical audit data", () => {
  const sync = {
    $usrTot: { data: { bag: { 300101: 2, 300102: 2 } } },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1 },
          9: { artId: 300102, num: 2 },
        },
      },
    },
  };
  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a", 4),
    flowerArtConfig: {
      arts: {
        300101: customerArt(300101, 3),
        300102: customerArt(300102, 1),
      },
    },
  });

  assert.equal(status.config.flowerCurrencyItemId, FLOWER_CURRENCY_ITEM_ID);
  assert.equal(status.flowerCurrencySelection.status, "ready");
  assert.equal(status.flowerCurrencySelection.maxReward, 3);
  assert.equal(status.flowerCurrencySelection.selectedNpcId, 8);
  assert.equal(status.flowerCurrencySelection.historicalMaxReward, 4);
  assert.equal(status.orders.find((order) => order.npcId === 8).flowerCurrencyReward, 3);
  assert.equal(status.orders.find((order) => order.npcId === 9).flowerCurrencyDecision, "not-selected-reward");
  assert.equal(status.orders.find((order) => order.npcId === 9).statusText, "暂时没货");
  assert.match(status.orders.find((order) => order.npcId === 9).actionText, /按官方按钮拒绝顾客订单/);

  const actions = getAutoSubmitCustomerOrderActions(status);
  assert.deepEqual(actions.map((action) => action.npcId), [9, 8]);
  assert.equal(actions.some((action) => action.steps.some((step) => step.type === "rejectCustomerOrder")), true);
  assert.deepEqual(status.flowerCurrencySelection.releaseRewards, [3]);
});

test("customer order auto submit rejects a known reward outside the release list when history has no record", () => {
  const sync = {
    $usrTot: { data: { bag: { 300101: 1 } } },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: { 8: { artId: 300101, num: 1 } },
      },
    },
  };
  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a"),
    flowerArtConfig: { arts: { 300101: customerArt(300101, 1) } },
  });

  assert.equal(status.flowerCurrencySelection.maxReward, 1);
  assert.equal(status.flowerCurrencySelection.status, "ready");
  assert.equal(status.orders[0].status, "temporary-out-of-stock");
  assert.equal(status.orders[0].flowerCurrencyDecision, "not-selected-reward");
  assert.match(status.orders[0].actionText, /按官方按钮拒绝顾客订单/);
  assert.equal(getAutoSubmitCustomerOrderActions(status)[0].steps[0].type, "rejectCustomerOrder");
});

test("customer order auto submit fails closed when flower-shop-coin reward is unknown and allows tied eligible rewards", () => {
  const unknownStatus = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300101: 1 } } },
    orderCustomerTot: { orderCustomer: { orderMap: { 8: { artId: 300101, num: 1 } } } },
  }, {
    nowMs: NOW,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a"),
    flowerArtConfig: {
      arts: { 300101: customerArt(300101, 1, { cPrice: [[11, 1]] }) },
    },
  });
  assert.equal(unknownStatus.flowerCurrencySelection.status, "unknown");
  assert.equal(unknownStatus.orders[0].flowerCurrencyRewardKnown, false);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(unknownStatus), []);

  const tiedStatus = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300101: 1, 300102: 1 } } },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1 },
          9: { artId: 300102, num: 1 },
        },
      },
    },
  }, {
    nowMs: NOW,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a"),
    flowerArtConfig: {
      arts: {
        300101: customerArt(300101, 3),
        300102: customerArt(300102, 3),
      },
    },
  });
  assert.equal(tiedStatus.flowerCurrencySelection.status, "ready");
  assert.deepEqual(tiedStatus.flowerCurrencySelection.eligibleNpcIds, [8, 9]);
  assert.deepEqual(
    tiedStatus.orders.map((order) => [order.npcId, order.flowerCurrencyDecision]),
    [[8, "selected-reward"], [9, "selected-reward"]],
  );
  assert.deepEqual(getAutoSubmitCustomerOrderActions(tiedStatus).map((action) => action.npcId), [8, 9]);
});

test("customer order auto submit allows every selected reward and rejects lower unselected rewards", () => {
  const status = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300104: 1, 300105: 1, 300106: 1 } } },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          4: { artId: 300104, num: 1 },
          5: { artId: 300105, num: 1 },
          8: { artId: 300106, num: 1 },
        },
      },
    },
  }, {
    nowMs: NOW,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a", 3),
    flowerArtConfig: {
      arts: {
        300104: customerArt(300104, 3),
        300105: customerArt(300105, 3),
        300106: customerArt(300106, 1),
      },
    },
  });

  assert.equal(status.flowerCurrencySelection.status, "ready");
  assert.deepEqual(status.flowerCurrencySelection.eligibleNpcIds, [4, 5]);
  assert.equal(status.flowerCurrencySelection.eligibleOrderCount, 2);
  assert.deepEqual(
    status.orders.map((order) => [order.npcId, order.flowerCurrencyDecision, order.status]),
    [
      [4, "selected-reward", "ready"],
      [5, "selected-reward", "ready"],
      [8, "not-selected-reward", "temporary-out-of-stock"],
    ],
  );
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status).map((action) => action.npcId), [8, 4, 5]);
  assert.deepEqual(
    getAutoSubmitCustomerOrderActions(status)
      .filter((action) => action.npcId !== 8)
      .map((action) => action.steps[0].type),
    ["finishCustomerOrder", "finishCustomerOrder"],
  );
});

test("customer order auto submit allows the configured selected rewards when history has no maximum", () => {
  const status = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300107: 1, 300108: 1, 300109: 1 } } },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          4: { artId: 300107, num: 1 },
          5: { artId: 300108, num: 1 },
          8: { artId: 300109, num: 1 },
        },
      },
    },
  }, {
    nowMs: NOW,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a"),
    flowerArtConfig: {
      arts: {
        300107: customerArt(300107, 3),
        300108: customerArt(300108, 2),
        300109: customerArt(300109, 1),
      },
    },
    customerOrderFlowerCurrencyRewardReleaseMask: 6,
  });

  assert.equal(status.flowerCurrencySelection.historicalMaxReward, null);
  assert.equal(status.flowerCurrencySelection.threshold, undefined);
  assert.deepEqual(status.flowerCurrencySelection.eligibleNpcIds, [4, 5]);
  assert.deepEqual(status.orders.map((order) => [order.npcId, order.status]), [
    [4, "ready"],
    [5, "ready"],
    [8, "temporary-out-of-stock"],
  ]);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status).map((action) => action.npcId), [8, 4, 5]);
});

test("customer order release list rejects unselected rewards and allows selected values", () => {
  const lowStatus = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300101: 1 } } },
    orderCustomerTot: { orderCustomer: { orderMap: { 8: { artId: 300101, num: 1 } } } },
  }, {
    nowMs: NOW,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a"),
    flowerArtConfig: { arts: { 300101: customerArt(300101, 1) } },
  });
  assert.equal(lowStatus.flowerCurrencySelection.threshold, undefined);
  assert.equal(lowStatus.flowerCurrencySelection.historyEnforced, false);
  assert.equal(lowStatus.flowerCurrencySelection.status, "ready");
  assert.equal(lowStatus.orders[0].flowerCurrencyDecision, "not-selected-reward");
  assert.equal(lowStatus.orders[0].status, "temporary-out-of-stock");
  assert.match(lowStatus.orders[0].actionText, /收益 1 未在当前放行列表/);
  assert.match(lowStatus.orders[0].actionText, /按官方按钮拒绝顾客订单/);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(lowStatus), [{
    kind: "customer",
    npcId: 8,
    artId: 300101,
    reason: "customer-order-flower-currency-reward-not-selected",
    reasonText: lowStatus.orders[0].actionText,
    finalizesOrder: true,
    steps: [{
      type: "rejectCustomerOrder",
      iface: "gs.orderCustomer.rejectOrder",
      args: { npcId: 8 },
    }],
  }]);

  const equalStatus = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300101: 1 } } },
    orderCustomerTot: { orderCustomer: { orderMap: { 8: { artId: 300101, num: 1 } } } },
  }, {
    nowMs: NOW,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a", 4),
    flowerArtConfig: { arts: { 300101: customerArt(300101, 3) } },
  });
  assert.equal(equalStatus.flowerCurrencySelection.status, "ready");
  assert.equal(equalStatus.flowerCurrencySelection.historicalMaxReward, 4);
  assert.equal(equalStatus.orders[0].flowerCurrencyDecision, "selected-reward");
  assert.equal(getAutoSubmitCustomerOrderActions(equalStatus).length, 1);
  assert.equal(getAutoSubmitCustomerOrderActions(equalStatus)[0].steps[0].type, "finishCustomerOrder");
});

test("customer order history availability does not block the selected release list", () => {
  const aboveStatus = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300101: 1 } } },
    orderCustomerTot: { orderCustomer: { orderMap: { 8: { artId: 300101, num: 1 } } } },
  }, {
    nowMs: NOW,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a", 4),
    flowerArtConfig: { arts: { 300101: customerArt(300101, 3) } },
  });
  assert.equal(aboveStatus.flowerCurrencySelection.status, "ready");
  assert.equal(aboveStatus.orders[0].flowerCurrencyReward, 3);
  assert.equal(aboveStatus.orders[0].flowerCurrencyDecision, "selected-reward");
  assert.equal(getAutoSubmitCustomerOrderActions(aboveStatus).length, 1);
  assert.equal(getAutoSubmitCustomerOrderActions(aboveStatus)[0].steps[0].type, "finishCustomerOrder");

  const unavailableStatus = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300101: 1 } } },
    orderCustomerTot: { orderCustomer: { orderMap: { 8: { artId: 300101, num: 1 } } } },
  }, {
    nowMs: NOW,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: {
      available: false,
      accountId: "account-a",
      sourceStatus: "damaged",
      recordStatus: "history-unavailable",
    },
    flowerArtConfig: { arts: { 300101: customerArt(300101, 3) } },
  });
  assert.equal(unavailableStatus.flowerCurrencySelection.historyAvailable, false);
  assert.equal(unavailableStatus.flowerCurrencySelection.status, "ready");
  assert.equal(unavailableStatus.orders[0].flowerCurrencyDecision, "selected-reward");
  assert.equal(getAutoSubmitCustomerOrderActions(unavailableStatus)[0].steps[0].type, "finishCustomerOrder");
});

test("summarizeOrderPalaceStatus submits when double gold and flower stock are enough", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          23002: 45,
        },
      },
    },
    videoDouble: {
      eTime: "2026-06-16T02:05:00.000Z",
    },
    orderPalaceTot: {
      orderPalace: {
        flowerId: 23002,
        num: 40,
        isFinish: false,
        cTime: "2026-06-16T01:50:00.000Z",
      },
    },
  };

  const status = summarizeOrderPalaceStatus(sync, {
    nowMs: NOW,
    nameMap: { 23002: "Palace Flower" },
  });

  assert.equal(status.exists, true);
  assert.equal(status.status, "ready");
  assert.equal(status.canFinish, true);
  assert.equal(status.have, 45);
  assert.equal(status.need, 40);
  assert.deepEqual(getAutoSubmitPalaceOrderActions(status), [
    {
      kind: "palace",
      iface: "gs.orderPalace.finishOrder",
      args: {},
      reason: "double-gold-flower-stock-ready",
      flowerId: 23002,
      need: 40,
      have: 45,
    },
  ]);
});

test("summarizeOrderPalaceStatus waits when double gold has less than one minute", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          23002: 45,
        },
      },
    },
    videoDouble: {
      eTime: "2026-06-16T02:00:30.000Z",
    },
    orderPalaceTot: {
      orderPalace: {
        flowerId: 23002,
        num: 40,
      },
    },
  };

  const status = summarizeOrderPalaceStatus(sync, {
    nowMs: NOW,
    nameMap: { 23002: "Palace Flower" },
  });

  assert.equal(status.status, "waiting-double-gold");
  assert.equal(status.canFinish, false);
  assert.deepEqual(getAutoSubmitPalaceOrderActions(status), []);
});

test("summarizeOrderPalaceStatus waits when palace flower stock is not enough", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          23002: 15,
        },
      },
    },
    videoDouble: {
      eTime: "2026-06-16T02:05:00.000Z",
    },
    orderPalaceTot: {
      orderPalace: {
        flowerId: 23002,
        num: 40,
      },
    },
  };

  const status = summarizeOrderPalaceStatus(sync, {
    nowMs: NOW,
    nameMap: { 23002: "Palace Flower" },
  });

  assert.equal(status.status, "missing-flowers");
  assert.equal(status.canFinish, false);
  assert.equal(status.missing, 25);
  assert.deepEqual(getAutoSubmitPalaceOrderActions(status), []);
});

test("summarizeFlowerArtInventory lists owned flower art sorted by unit sell price", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 2,
          300102: 5,
          300103: 0,
          23001: 20,
          23002: 10,
          23003: 8,
          3001: 7,
        },
      },
    },
  };

  const rows = summarizeFlowerArtInventory(sync, {
    nameMap: {
      23001: "白百合",
      23002: "浅橘乒乓菊",
      23003: "明黄矮牵牛",
    },
    itemNameMap: {
      3001: "白瓷瓶",
      300101: "百合瓷韵",
      300102: "高价花艺",
    },
    flowerArtConfig: {
      arts: {
        300101: {
          id: 300101,
          vaseId: 3001,
          flowerIds: [23001, 23002, 23002],
          sPrice: [11, 131],
        },
        300102: {
          id: 300102,
          vaseId: 3001,
          flowerIds: [23001, 23003],
          sPrice: [11, 143],
        },
        300103: {
          id: 300103,
          vaseId: 3001,
          flowerIds: [23001],
          sPrice: [11, 999],
        },
      },
    },
  });

  assert.deepEqual(rows.map((row) => row.artId), [300102, 300101]);
  assert.equal(rows[0].artName, "高价花艺");
  assert.equal(rows[0].artCount, 5);
  assert.equal(rows[0].salePrice, 143);
  assert.equal(rows[0].salePriceText, "143 金币");
  assert.equal(rows[0].vaseName, "白瓷瓶");
  assert.equal(rows[0].vaseText, "白瓷瓶 (3001) x1");
  assert.equal(rows[0].flowersText, "白百合 (23001) x1；明黄矮牵牛 (23003) x1");
  assert.deepEqual(rows[1].flowers.map((item) => [item.flowerId, item.need]), [
    [23001, 1],
    [23002, 2],
  ]);
});

test("summarizeFlowerArtInventory disambiguates art names when item name matches vase name", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 2,
        },
      },
    },
  };

  const rows = summarizeFlowerArtInventory(sync, {
    nameMap: {
      23001: "白百合",
      23002: "浅橘乒乓菊",
      23003: "明黄矮牵牛",
    },
    itemNameMap: {
      3001: "百合瓷韵",
      300101: "百合瓷韵",
    },
    flowerArtConfig: {
      arts: {
        300101: {
          id: 300101,
          vaseId: 3001,
          flowerIds: [23001, 23002, 23003],
          sPrice: [11, 131],
        },
      },
    },
  });

  assert.equal(rows[0].vaseName, "百合瓷韵");
  assert.equal(rows[0].artName, "百合瓷韵：白百合 + 浅橘乒乓菊 + 明黄矮牵牛");
});

test("summarizeOrderFlowerStatus reports satin and decorate orders from orderFlowerTot", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          23001: 12,
          23002: 1,
          23003: 8,
          23004: 0,
        },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: {
          flowers: [[23001, 10], [23002, 2]],
          npcId: 101,
          dialogId: 201,
          finishCnt: 3,
          isVideo: 0,
          cdTime: "2026-06-16T01:59:00.000Z",
          cTime: "2026-06-16T01:10:00.000Z",
        },
        orderDecorate: {
          flowers: [[23003, 5]],
          npcId: 102,
          dialogId: 202,
          finishCnt: 1,
          isVideo: 0,
          cdTime: "2026-06-16T02:05:00.000Z",
          cTime: "2026-06-16T01:20:00.000Z",
        },
      },
    },
  };

  const status = summarizeOrderFlowerStatus(sync, {
    nowMs: NOW,
    nameMap: {
      23001: "白百合",
      23002: "康乃馨",
      23003: "铃兰",
    },
  });

  assert.equal(status.satin.exists, true);
  assert.equal(status.satin.status, "missing-items");
  assert.equal(status.satin.statusText, "缺少材料");
  assert.equal(status.satin.canFinish, false);
  assert.equal(status.satin.requirements[0].name, "白百合");
  assert.equal(status.satin.requirements[1].missing, 1);
  assert.equal(status.satin.completedCount, null);
  assert.equal(status.satin.completedCountSource, "panel-missing");
  assert.equal(status.satin.finishCnt, 3);

  assert.equal(status.decorate.exists, true);
  assert.equal(status.decorate.status, "cooldown");
  assert.equal(status.decorate.statusText, "冷却中");
  assert.equal(status.decorate.remainingMs, 300000);
  assert.equal(status.decorate.requirements[0].enough, true);
  assert.equal(status.decorate.completedCount, null);
  assert.equal(status.decorate.completedCountSource, "panel-missing");
  assert.equal(status.decorate.finishCnt, 1);
});

test("summarizeOrderFlowerStatus reports finishable and video orders", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: { 23001: 99 },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: {
          flowers: [[23001, 3]],
          npcId: 101,
          dialogId: 201,
          finishCnt: 0,
          isVideo: 0,
          cdTime: "2026-06-16T01:00:00.000Z",
          cTime: "2026-06-16T01:00:00.000Z",
        },
        orderDecorate: {
          flowers: [[23001, 3]],
          npcId: 102,
          dialogId: 202,
          finishCnt: 0,
          isVideo: 1,
          videoRwd: { 1001: 2 },
          cdTime: "2026-06-16T01:00:00.000Z",
          cTime: "2026-06-16T01:00:00.000Z",
        },
      },
    },
  };

  const status = summarizeOrderFlowerStatus(sync, { nowMs: NOW, nameMap: { 23001: "白百合" } });

  assert.equal(status.satin.status, "ready");
  assert.equal(status.satin.statusText, "可完成");
  assert.equal(status.satin.canFinish, true);
  assert.equal(status.decorate.status, "video");
  assert.equal(status.decorate.statusText, "视频订单");
  assert.equal(status.decorate.isVideo, true);
});

test("special order stock rejection fails closed until stock increases or the order changes", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          23001: 80,
          23002: 3,
        },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: {
          flowers: [[23001, 1]],
          finishCnt: 63,
          isVideo: 0,
          cdTime: "2026-06-16T01:00:00.000Z",
          cTime: "2026-06-16T00:30:00.000Z",
        },
      },
    },
  };
  const marked = markSpecialOrderStockRejection(sync, "satin", 23001, {
    nowMs: NOW,
    code: 301,
  });

  const blocked = summarizeOrderFlowerStatus(marked, { nowMs: NOW }).satin;
  assert.equal(blocked.status, "server-confirmed-out-of-stock");
  assert.equal(blocked.statusText, "服务端确认缺货");
  assert.equal(blocked.canFinish, false);
  assert.equal(blocked.serverConfirmedOutOfStock, true);
  assert.deepEqual(blocked.stockRejection, {
    code: 301,
    itemId: 23001,
    need: 1,
    observedHave: 80,
    currentHave: 80,
    confirmedAt: new Date(NOW).toISOString(),
    exactHaveKnown: false,
    reason: "server-confirmed-out-of-stock",
  });
  assert.deepEqual(getAutoSubmitOrderActions(summarizeOrderFlowerStatus(marked, { nowMs: NOW })), []);

  const exactShortage = summarizeOrderFlowerStatus({
    ...marked,
    $usrTot: {
      ...marked.$usrTot,
      data: {
        ...marked.$usrTot.data,
        bag: { ...marked.$usrTot.data.bag, 23001: 0 },
      },
    },
  }, { nowMs: NOW }).satin;
  assert.equal(exactShortage.status, "missing-items");
  assert.equal(exactShortage.requirements[0].have, 0);
  assert.equal(exactShortage.stockRejection.exactHaveKnown, true);

  const replenished = summarizeOrderFlowerStatus({
    ...marked,
    $usrTot: {
      ...marked.$usrTot,
      data: {
        ...marked.$usrTot.data,
        bag: { ...marked.$usrTot.data.bag, 23001: 81 },
      },
    },
  }, { nowMs: NOW }).satin;
  assert.equal(replenished.status, "ready");
  assert.equal(replenished.canFinish, true);
  assert.equal(replenished.stockRejection, null);

  const nextOrder = summarizeOrderFlowerStatus({
    ...marked,
    orderFlowerTot: {
      orderFlower: {
        orderSatin: {
          flowers: [[23002, 1]],
          finishCnt: 64,
          isVideo: 0,
          cdTime: "2026-06-16T01:00:00.000Z",
          cTime: "2026-06-16T01:30:00.000Z",
        },
      },
    },
  }, { nowMs: NOW }).satin;
  assert.equal(nextOrder.status, "ready");
  assert.equal(nextOrder.canFinish, true);
  assert.equal(nextOrder.stockRejection, null);
});

test("ordinary resident submission keeps a config-backed refill countdown placeholder", () => {
  const config = loadOrderFlowerConfig();
  const sync = {
    orderFlowerTot: {
      orderFlower: {
        orderMap: {
          1: {
            boxId: 1,
            flowers: [[23001, 2]],
            isVideo: 0,
            cdTime: "2026-06-16T01:00:00.000Z",
          },
          2: {
            boxId: 2,
            flowers: [],
            isVideo: 1,
            cdTime: "2026-06-16T01:00:00.000Z",
          },
        },
      },
    },
  };

  const marked = markOrdinaryResidentOrderRefill(sync, 1, {
    nowMs: NOW,
    cooldownSeconds: config.orderCdSeconds,
  });
  const status = summarizeOrderFlowerStatus(marked, { nowMs: NOW + 2_000 });
  const refill = status.ordinary.orders.find((order) => order.boxId === 1);

  assert.equal(config.orderCdSeconds, 42);
  assert.equal(status.ordinary.total, 2);
  assert.equal(refill.refillPending, true);
  assert.equal(refill.status, "refill-cooldown");
  assert.equal(refill.statusText, "等待服务端补位");
  assert.equal(refill.remainingMs, 40_000);
  assert.equal(refill.remainingText, "0分40秒");
  assert.equal(refill.canFinish, false);
  assert.equal(marked.orderFlowerTot.orderFlower.orderMap[2].isVideo, 1);
  assert.equal(sync.orderFlowerTot.orderFlower.orderMap[1].__refillPending, undefined);
});

test("ordinary resident refill marker expires after its countdown when the server has not refilled", () => {
  const marked = markOrdinaryResidentOrderRefill({
    orderFlower: {
      orderMap: {
        1: { boxId: 1, npcId: 3, flowers: [[23001, 2]] },
      },
    },
    $usrTot: {
      data: {
        bag: { 23001: 99 },
      },
    },
  }, 1, {
    nowMs: NOW,
    cooldownSeconds: 42,
  });

  // 冷却期（cdTime 未到）：等待服务端补位，禁止重复提交
  const during = summarizeOrderFlowerStatus(marked, { nowMs: NOW + 2_000 });
  assert.equal(during.ordinary.orders[0].status, "refill-cooldown");
  assert.equal(during.ordinary.orders[0].remainingMs, 40_000);
  assert.equal(during.ordinary.orders[0].canFinish, false);

  // 冷却结束后：补位标记失效，不再永久"等待服务端补位"；
  // 恢复为按订单数据判断（此例 npcId=3、flowers 齐备 → 可完成）
  const after = summarizeOrderFlowerStatus(marked, { nowMs: NOW + 43_000 });
  assert.equal(after.ordinary.orders[0].status, "ready");
  assert.equal(after.ordinary.orders[0].canFinish, true);
  assert.equal(after.ordinary.orders[0].refillPending, true);
});

test("summarizeOrderFlowerStatus uses home popup daily counts before order finishCnt", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: { 23001: 99 },
      },
      cntMap: {
        105: { type: 105, tdyCnt: 27, totCnt: 300, rTime: "2026-06-16T01:00:00.000Z" },
        109: { type: 109, tdyCnt: 12, totCnt: 120, rTime: "2026-06-16T01:00:00.000Z" },
        116: { type: 116, tdyCnt: 4, totCnt: 80, rTime: "2026-06-16T01:00:00.000Z" },
      },
    },
    statisticsTot: {
      statisticsMap: {
        [Date.parse("2026-06-16T00:00:00.000Z")]: {
          dayId: Date.parse("2026-06-16T00:00:00.000Z"),
          orderSatinFinishNum: 99,
          orderDecorateFinishNum: 88,
          orderFlowerFinishNum: 66,
        },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: {
          flowers: [[23001, 3]],
          finishCnt: 9,
          isVideo: 0,
          cdTime: "2026-06-16T01:00:00.000Z",
        },
        orderDecorate: {
          flowers: [[23001, 3]],
          finishCnt: 7,
          isVideo: 0,
          cdTime: "2026-06-16T01:00:00.000Z",
        },
      },
    },
  };

  const status = summarizeOrderFlowerStatus(sync, { nowMs: NOW, nameMap: { 23001: "白百合" } });

  assert.equal(status.satin.completedCount, 11);
  assert.equal(status.satin.completedCountSource, "home-popup");
  assert.equal(status.satin.homePopupCompletedCount, 11);
  assert.equal(status.satin.businessStatsCompletedCount, 99);
  assert.equal(status.satin.finishCnt, 9);

  assert.equal(status.decorate.completedCount, 3);
  assert.equal(status.decorate.completedCountSource, "home-popup");
  assert.equal(status.decorate.homePopupCompletedCount, 3);
  assert.equal(status.decorate.businessStatsCompletedCount, 88);
  assert.equal(status.decorate.finishCnt, 7);

  assert.equal(status.ordinary.completedCount, 27);
  assert.equal(status.ordinary.completedCountSource, "home-popup");
  assert.equal(status.ordinary.completedCountSourceText, "右下角弹窗");
  assert.equal(status.ordinary.homePopupCompletedCount, 27);
  assert.equal(status.ordinary.businessStatsCompletedCount, 66);
  assert.equal(status.ordinary.countType, 105);
  assert.equal(status.ordinary.statField, "orderFlowerFinishNum");
});

test("summarizeOrderFlowerStatus falls back to business statistics when daily counts are missing", () => {
  const dayId = Date.parse("2026-06-16T00:00:00.000Z");
  const sync = {
    $usrTot: {
      data: { bag: { 23001: 99 } },
    },
    statisticsTot: {
      statisticsMap: {
        [dayId]: {
          dayId,
          orderSatinFinishNum: 21,
          orderDecorateFinishNum: 34,
          orderFlowerFinishNum: 56,
        },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { flowers: [[23001, 3]], finishCnt: 9, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
        orderDecorate: { flowers: [[23001, 3]], finishCnt: 7, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
      },
    },
  };

  const status = summarizeOrderFlowerStatus(sync, { nowMs: NOW, nameMap: { 23001: "白百合" } });

  assert.equal(status.satin.completedCount, 21);
  assert.equal(status.satin.completedCountSource, "business-statistics");
  assert.equal(status.decorate.completedCount, 34);
  assert.equal(status.decorate.completedCountSource, "business-statistics");
  assert.equal(status.ordinary.completedCount, 56);
  assert.equal(status.ordinary.completedCountSource, "business-statistics");
  assert.equal(status.ordinary.completedCountSourceText, "经营状况");
  assert.equal(status.ordinary.homePopupCompletedCount, null);
  assert.equal(status.ordinary.businessStatsCompletedCount, 56);
});

test("official order-board counts reset cross-day popup records and customer count uses refresh zero", () => {
  const dayId = Date.parse("2026-06-16T00:00:00.000Z");
  const sync = {
    $usrTot: {
      cntMap: {
        105: { type: 105, tdyCnt: 27, rTime: "2026-06-15T01:00:00.000Z" },
        107: { type: 107, tdyCnt: 349, rTime: "2026-06-15T01:00:00.000Z" },
        109: { type: 109, tdyCnt: 12, rTime: "2026-06-15T01:00:00.000Z" },
        116: { type: 116, tdyCnt: 4, rTime: "2026-06-15T01:00:00.000Z" },
      },
    },
    statisticsTot: {
      statisticsMap: {
        [dayId]: {
          dayId,
          orderSatinFinishNum: 21,
          orderDecorateFinishNum: 34,
          orderFlowerFinishNum: 56,
        },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { flowers: [[23001, 3]], finishCnt: 9, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
        orderDecorate: { flowers: [[23001, 3]], finishCnt: 7, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
      },
    },
  };

  const status = summarizeOrderFlowerStatus(sync, {
    nowMs: NOW,
    nameMap: { 23001: "白百合" },
  });

  for (const kind of ["satin", "decorate"]) {
    assert.equal(status[kind].userCount.isFreshToday, false);
    assert.equal(status[kind].userCount.countKnown, true);
    assert.equal(status[kind].homePopupCompletedCount, 0);
    assert.equal(status[kind].completedCount, 0);
    assert.equal(status[kind].completedCountSource, "home-popup");
  }
  assert.equal(status.completionCounts.ordinary.userCount.isFreshToday, false);
  assert.equal(status.completionCounts.ordinary.userCount.countKnown, true);
  assert.equal(status.ordinary.homePopupCompletedCount, 0);
  assert.equal(status.ordinary.completedCount, 0);
  assert.equal(status.ordinary.completedCountSource, "home-popup");
  assert.equal(status.residentBoard.completedCount, 0);
  assert.equal(status.residentBoard.completedCountSource, "home-popup");

  const customerStatus = getCustomerOrderDailyLimitStatus(sync, {
    nowMs: NOW,
    orderCustomerNpcConfig: { npcMaxDay: 350 },
  });
  assert.equal(customerStatus.userCount.isFreshToday, false);
  assert.equal(customerStatus.userCount.tdyCnt, 0);
  assert.equal(customerStatus.tdyCompletedCount, 0);
  assert.equal(customerStatus.dailyCountKnown, true);
});

test("official order-board count treats missing 105/109/116 records as zero", () => {
  const status = summarizeOrderFlowerStatus({
    $usrTot: { cntMap: {} },
  }, { nowMs: NOW });

  assert.equal(status.residentBoard.completedCount, 0);
  assert.equal(status.residentBoard.completedCountSource, "home-popup");
  for (const kind of ["ordinary", "satin", "decorate"]) {
    const userCount = kind === "ordinary"
      ? status.completionCounts.ordinary.userCount
      : status[kind].userCount;
    assert.equal(userCount.countKnown, true);
    assert.equal(userCount.countSource, "official-missing-record");
    assert.equal(status[kind].completedCount, 0);
    assert.equal(status[kind].completedCountSource, "home-popup");
  }
});

test("official order-board count treats a missing 105 rTime as refreshed zero", () => {
  const status = summarizeOrderFlowerStatus({
    $usrTot: {
      cntMap: {
        105: { type: 105, tdyCnt: 27 },
      },
    },
  }, { nowMs: NOW });

  assert.equal(status.completionCounts.ordinary.userCount.countSource, "official-refresh-zero");
  assert.equal(status.completionCounts.ordinary.userCount.tdyCnt, 0);
  assert.equal(status.ordinary.completedCount, 0);
  assert.equal(status.residentBoard.completedCount, 0);
});

test("malformed order-board count fails closed without a statistics fallback", () => {
  const sync = {
    $usrTot: {
      data: { bag: { 23001: 99 } },
      cntMap: {
        105: { type: 105, tdyCnt: Number.NaN, rTime: "2026-06-16T01:00:00.000Z" },
        109: { type: 109, tdyCnt: 2, rTime: "2026-06-16T01:00:00.000Z" },
        116: { type: 116, tdyCnt: 2, rTime: "2026-06-16T01:00:00.000Z" },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { flowers: [[23001, 3]], finishCnt: 9, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
        orderDecorate: { flowers: [[23001, 3]], finishCnt: 7, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
      },
    },
  };

  const status = summarizeOrderFlowerStatus(sync, { nowMs: NOW });

  assert.equal(status.residentBoard.completedCount, null);
  assert.deepEqual(getAutoSubmitOrderActions(status), []);
});

test("cross-day resident-board count still reaches the experience decision before 99", () => {
  const decisions = [];
  const capability = {
    ready: true,
    realValidated: false,
    teamOrderTriggerProtectionEnabled: false,
    requiresExperienceTriggerDecision: true,
    evaluateTrigger(action) {
      decisions.push(action);
      return {
        blocked: true,
        forceTriggerProtectionEnabled: true,
        reason: "insufficient-experience-space",
      };
    },
  };
  const sync = {
    $usrTot: {
      data: { bag: { 23001: 99 } },
      cntMap: {
        105: { type: 105, tdyCnt: 27, rTime: "2026-06-15T01:00:00.000Z" },
        109: { type: 109, tdyCnt: 51, rTime: "2026-06-16T01:00:00.000Z" },
        116: { type: 116, tdyCnt: 50, rTime: "2026-06-16T01:00:00.000Z" },
      },
    },
    videoDouble: {
      eTime: new Date(NOW + 180_001).toISOString(),
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { flowers: [[23001, 3]], finishCnt: 9, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
        orderDecorate: { flowers: [[23001, 3]], finishCnt: 7, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
      },
    },
  };

  const status = summarizeOrderFlowerStatus(sync, {
    nowMs: NOW,
    nameMap: { 23001: "Flower" },
    teamOrderCapability: capability,
  });
  const actions = getAutoSubmitOrderActions(status, {
    teamOrderCapability: capability,
  });

  assert.equal(status.residentBoard.completedCount, 99);
  assert.equal(status.satin.canFinish, true);
  assert.equal(status.decorate.canFinish, true);
  assert.equal(decisions.length, 2);
  assert.deepEqual(actions, []);
});

test("summarizeOrderFlowerStatus blocks satin and decorate orders at the daily limit", () => {
  const dayId = Date.parse("2026-06-16T00:00:00.000Z");
  const sync = {
    $usrTot: {
      data: { bag: { 23001: 99 } },
      cntMap: {
        109: { type: 109, tdyCnt: 121, totCnt: 220, rTime: "2026-06-16T01:00:00.000Z" },
        116: { type: 116, tdyCnt: 121, totCnt: 220, rTime: "2026-06-16T01:00:00.000Z" },
      },
    },
    statisticsTot: {
      statisticsMap: {
        [dayId]: {
          dayId,
          orderDecorateFinishNum: 120,
        },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { flowers: [[23001, 3]], finishCnt: 9, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
        orderDecorate: { flowers: [[23001, 3]], finishCnt: 7, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
      },
    },
  };

  const status = summarizeOrderFlowerStatus(sync, { nowMs: NOW, nameMap: { 23001: "白百合" } });

  assert.equal(status.satin.completedCount, 120);
  assert.equal(status.satin.dailyLimit, 120);
  assert.equal(status.satin.status, "daily-limit");
  assert.equal(status.satin.statusText, "已达上限");
  assert.equal(status.satin.canFinish, false);

  assert.equal(status.decorate.completedCount, 120);
  assert.equal(status.decorate.dailyLimit, 120);
  assert.equal(status.decorate.status, "daily-limit");
  assert.equal(status.decorate.statusText, "已达上限");
  assert.equal(status.decorate.canFinish, false);

  assert.deepEqual(getAutoSubmitOrderActions(status), []);
});

test("summarizeOrderFlowerStatus pauses satin and decorate at resident board trigger totals", () => {
  for (const total of [49, 99]) {
    const sync = {
      $usrTot: {
        data: { bag: { 23001: 99 } },
        cntMap: {
          105: { type: 105, tdyCnt: total - 7, totCnt: 300, rTime: "2026-06-16T01:00:00.000Z" },
          109: { type: 109, tdyCnt: 4, totCnt: 120, rTime: "2026-06-16T01:00:00.000Z" },
          116: { type: 116, tdyCnt: 5, totCnt: 80, rTime: "2026-06-16T01:00:00.000Z" },
        },
      },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: { flowers: [[23001, 3]], finishCnt: 9, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
          orderDecorate: { flowers: [[23001, 3]], finishCnt: 7, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
        },
      },
    };

    const status = summarizeOrderFlowerStatus(sync, { nowMs: NOW, nameMap: { 23001: "Flower" } });

    assert.equal(status.residentBoard.completedCount, total);
    assert.equal(status.residentBoard.pauseSpecialOrders, true);
    assert.equal(status.satin.status, "resident-board-stop");
    assert.equal(status.satin.canFinish, false);
    assert.equal(status.decorate.status, "resident-board-stop");
    assert.equal(status.decorate.canFinish, false);
    assert.deepEqual(getAutoSubmitOrderActions(status), []);
  }
});

test("summarizeOrderFlowerStatus reports video orders before resident board stop reasons", () => {
  const sync = {
    $usrTot: {
      data: { bag: { 23001: 99 } },
      cntMap: {
        105: { type: 105, tdyCnt: 42, rTime: "2026-06-16T01:00:00.000Z" },
        109: { type: 109, tdyCnt: 4, rTime: "2026-06-16T01:00:00.000Z" },
        116: { type: 116, tdyCnt: 5, rTime: "2026-06-16T01:00:00.000Z" },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: {
          flowers: [[23001, 3]],
          finishCnt: 0,
          isVideo: 1,
          cTime: "2026-06-16T01:00:00.000Z",
          cdTime: "2026-06-16T01:00:00.000Z",
        },
        orderDecorate: {
          flowers: [[23001, 3]],
          finishCnt: 0,
          isVideo: 1,
          cTime: "2026-06-16T01:00:00.000Z",
          cdTime: "2026-06-16T01:00:00.000Z",
        },
      },
    },
  };

  const status = summarizeOrderFlowerStatus(sync, { nowMs: NOW });

  assert.equal(status.residentBoard.completedCount, 49);
  assert.equal(status.residentBoard.pauseSpecialOrders, true);
  assert.equal(status.satin.status, "video");
  assert.equal(status.satin.statusText, "视频订单");
  assert.equal(status.decorate.status, "video");
  assert.equal(status.decorate.statusText, "视频订单");
});

function syncAtResidentTotal(total, doubleGoldRemainingMs = null) {
  const sync = {
    $usrTot: {
      data: { bag: { 23001: 99 } },
      cntMap: {
        105: { type: 105, tdyCnt: total - 7, rTime: "2026-06-16T01:00:00.000Z" },
        109: { type: 109, tdyCnt: 4, rTime: "2026-06-16T01:00:00.000Z" },
        116: { type: 116, tdyCnt: 5, rTime: "2026-06-16T01:00:00.000Z" },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { flowers: [[23001, 3]], finishCnt: 9, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
        orderDecorate: { flowers: [[23001, 3]], finishCnt: 7, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
      },
    },
  };
  if (doubleGoldRemainingMs != null) {
    sync.videoDouble = {
      eTime: new Date(NOW + doubleGoldRemainingMs).toISOString(),
    };
  }
  return sync;
}

test("default trigger protection keeps the 49 and 99 stops", () => {
  for (const total of [49, 99]) {
    const status = summarizeOrderFlowerStatus(syncAtResidentTotal(total), {
      nowMs: NOW,
      teamOrderCapability: { ready: true },
    });

    assert.equal(status.residentBoard.completedCount, total);
    assert.equal(status.residentBoard.teamOrderReady, false);
    assert.equal(status.residentBoard.teamOrderTriggerProtectionEnabled, true);
    assert.equal(status.residentBoard.pauseSpecialOrders, true);
    assert.deepEqual(getAutoSubmitOrderActions(status), []);
  }
});

test("user-disabled trigger protection removes the 49 and 99 stops only above three double-gold minutes", () => {
  for (const total of [49, 99]) {
    const capability = {
      ready: true,
      realValidated: false,
      teamOrderTriggerProtectionEnabled: false,
    };
    const status = summarizeOrderFlowerStatus(syncAtResidentTotal(total, 180_001), {
      nowMs: NOW,
      teamOrderCapability: capability,
    });

    assert.equal(status.residentBoard.completedCount, total);
    assert.equal(status.residentBoard.teamOrderDoubleGoldReady, true);
    assert.equal(status.residentBoard.teamOrderEffectiveProtectionEnabled, false);
    assert.equal(status.residentBoard.teamOrderReady, true);
    assert.equal(status.residentBoard.pauseSpecialOrders, false);
    assert.equal(getAutoSubmitOrderActions(status, {
      teamOrderCapability: capability,
    }).length, 2);
  }
});

test("three double-gold minutes or less forces the 49 and 99 stops even when protection is disabled", () => {
  for (const total of [49, 99]) {
    for (const remainingMs of [null, 179_999, 180_000]) {
      const capability = {
        ready: true,
        realValidated: false,
        teamOrderTriggerProtectionEnabled: false,
      };
      const status = summarizeOrderFlowerStatus(
        syncAtResidentTotal(total, remainingMs),
        {
          nowMs: NOW,
          teamOrderCapability: capability,
        },
      );

      assert.equal(status.residentBoard.completedCount, total);
      assert.equal(status.residentBoard.teamOrderDoubleGoldReady, false);
      assert.equal(status.residentBoard.teamOrderEffectiveProtectionEnabled, true);
      assert.equal(status.residentBoard.teamOrderReady, false);
      assert.equal(status.residentBoard.pauseSpecialOrders, true);
      assert.match(status.residentBoard.pauseReasonText, /必须超过3分钟/);
      assert.deepEqual(getAutoSubmitOrderActions(status, {
        teamOrderCapability: capability,
      }), []);
    }
  }
});

test("unrelated version and config notices cannot change the user protection setting", () => {
  for (const protectionEnabled of [false, true]) {
    const capability = {
      ready: true,
      realValidated: false,
      teamOrderTriggerProtectionEnabled: protectionEnabled,
    };
    const status = summarizeOrderFlowerStatus(syncAtResidentTotal(49, 180_001), {
      nowMs: NOW,
      teamOrderCapability: capability,
      gameVersionNotice: { updateAvailable: true },
      staticConfigNotice: { updatedTables: ["c_flower"] },
    });

    assert.equal(status.residentBoard.teamOrderReady, !protectionEnabled);
    assert.equal(status.residentBoard.pauseSpecialOrders, protectionEnabled);
    assert.equal(getAutoSubmitOrderActions(status, {
      teamOrderCapability: capability,
      gameVersionNotice: { updateAvailable: true },
      staticConfigNotice: { updatedTables: ["c_flower"] },
    }).length, protectionEnabled ? 0 : 2);
  }
});

test("failed team capability keeps the 49 and 99 stop even when the user disables protection", () => {
  for (const total of [49, 99]) {
    const status = summarizeOrderFlowerStatus(syncAtResidentTotal(total), {
      nowMs: NOW,
      teamOrderCapability: {
        ready: false,
        teamOrderTriggerProtectionEnabled: false,
      },
    });

    assert.equal(status.residentBoard.completedCount, total);
    assert.equal(status.residentBoard.pauseSpecialOrders, true);
    assert.deepEqual(getAutoSubmitOrderActions(status, { teamOrderReady: false }), []);
  }
});

test("resident board exposes team-order guard fields from capability", () => {
  const capability = {
    ready: true,
    teamOrderTriggerProtectionEnabled: false,
    teamOrderGuardMultiplier: 3,
    teamOrderGuardExp: 15_000,
    accountHistoricalMaxTeamExp: 5_000,
  };
  const status = summarizeOrderFlowerStatus(syncAtResidentTotal(1), {
    teamOrderCapability: capability,
  });

  assert.equal(status.residentBoard.teamOrderGuardMultiplier, 3);
  assert.equal(status.residentBoard.teamOrderGuardExp, 15_000);
  assert.equal(status.residentBoard.accountHistoricalMaxTeamExp, 5_000);

  // 无 capability 时回退 null
  const plain = summarizeOrderFlowerStatus(syncAtResidentTotal(1), {});
  assert.equal(plain.residentBoard.teamOrderGuardMultiplier, null);
  assert.equal(plain.residentBoard.teamOrderGuardExp, null);
  assert.equal(plain.residentBoard.accountHistoricalMaxTeamExp, null);
});

test("getAutoSubmitOrderActions caps special orders before team-order trigger totals", () => {
  for (const total of [48, 98]) {
    const sync = {
      $usrTot: {
        data: { bag: { 23001: 99 } },
        cntMap: {
          105: { type: 105, tdyCnt: total - 7, totCnt: 300, rTime: "2026-06-16T01:00:00.000Z" },
          109: { type: 109, tdyCnt: 4, totCnt: 120, rTime: "2026-06-16T01:00:00.000Z" },
          116: { type: 116, tdyCnt: 5, totCnt: 80, rTime: "2026-06-16T01:00:00.000Z" },
        },
      },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: { flowers: [[23001, 3]], finishCnt: 9, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
          orderDecorate: { flowers: [[23001, 3]], finishCnt: 7, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
        },
      },
    };

    const status = summarizeOrderFlowerStatus(sync, { nowMs: NOW, nameMap: { 23001: "Flower" } });
    const actions = getAutoSubmitOrderActions(status);

    assert.equal(status.residentBoard.completedCount, total);
    assert.deepEqual(actions.map((action) => action.kind), ["satin"]);
    assert.equal(actions[0].residentBoardTotalBefore, total);
    assert.equal(actions[0].residentBoardTotalAfter, total + 1);
    assert.equal(actions[0].teamTriggerAvoided, true);
  }
});

test("summarizeOrderFlowerStatus uses business statistics for resident board stop when popup counts are missing", () => {
  const dayId = Date.parse("2026-06-16T00:00:00.000Z");
  const sync = {
    $usrTot: {
      data: { bag: { 23001: 99 } },
    },
    statisticsTot: {
      statisticsMap: {
        [dayId]: {
          dayId,
          orderFlowerFinishNum: 30,
          orderSatinFinishNum: 10,
          orderDecorateFinishNum: 9,
        },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { flowers: [[23001, 3]], finishCnt: 9, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
        orderDecorate: { flowers: [[23001, 3]], finishCnt: 7, isVideo: 0, cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z" },
      },
    },
  };

  const status = summarizeOrderFlowerStatus(sync, { nowMs: NOW, nameMap: { 23001: "Flower" } });

  assert.equal(status.residentBoard.completedCount, 49);
  assert.equal(status.residentBoard.completedCountSource, "business-statistics");
  assert.equal(status.residentBoard.pauseSpecialOrders, true);
  assert.equal(status.satin.status, "resident-board-stop");
  assert.equal(status.decorate.status, "resident-board-stop");
  assert.deepEqual(getAutoSubmitOrderActions(status), []);
});

test("summarizeOrderFlowerStatus handles missing orders", () => {
  const status = summarizeOrderFlowerStatus({ orderFlowerTot: { orderFlower: {} } }, { nowMs: NOW });

  assert.equal(status.satin.exists, false);
  assert.equal(status.satin.statusText, "未生成/未开启");
  assert.equal(status.decorate.exists, false);
  assert.equal(status.decorate.statusText, "未生成/未开启");
});

test("getAutoSubmitOrderActions submits only ready non-video special orders", () => {
  const actions = getAutoSubmitOrderActions({
    residentBoard: { completedCount: 0 },
    satin: {
      kind: "satin",
      status: "ready",
      canFinish: true,
      isVideo: false,
    },
    decorate: {
      kind: "decorate",
      status: "video",
      canFinish: false,
      isVideo: true,
    },
  });

  assert.deepEqual(actions, [
    {
      kind: "satin",
      iface: "gs.orderFlower.finishSatinOrder",
      reason: "ready-non-video",
      residentBoardTotalBefore: 0,
      residentBoardTotalAfter: 1,
      residentBoardNextTeamTriggerCount: 50,
      teamTriggerAvoided: false,
    },
  ]);
});

test("summarizeOrderFlowerStatus fails closed for incomplete special-order authority fields", () => {
  const base = {
    $usrTot: { data: { bag: { 23001: 3 } } },
    orderFlowerTot: { orderFlower: { orderSatin: {
      flowers: [[23001, 3]], finishCnt: 1, isVideo: 0,
      cTime: "2026-06-16T01:00:00.000Z", cdTime: "2026-06-16T01:00:00.000Z",
    } } },
  };
  for (const [field, value] of [
    ["finishCnt", null], ["isVideo", " "], ["cTime", "invalid"], ["cdTime", Number.NaN],
  ]) {
    const status = summarizeOrderFlowerStatus({
      ...base,
      orderFlowerTot: { orderFlower: { orderSatin: {
        ...base.orderFlowerTot.orderFlower.orderSatin,
        [field]: value,
      } } },
    }, { nowMs: NOW });
    assert.equal(status.satin.status, "invalid");
    assert.equal(status.satin.canFinish, false);
  }
});

test("summarizeOrderFlowerStatus parses ordinary resident orderMap entries", () => {
  const status = summarizeOrderFlowerStatus({
    $usrTot: {
      data: {
        bag: {
          23001: 4,
          23002: 1,
        },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderMap: {
          101: {
            boxId: 101,
            flowers: [[23001, 3]],
            isVideo: 0,
            cdTime: "2026-06-16T01:00:00.000Z",
          },
          102: {
            boxId: 102,
            flowers: [[23001, 1]],
            isVideo: 1,
            cdTime: "2026-06-16T01:00:00.000Z",
          },
          103: {
            boxId: 103,
            flowers: [[23001, 1]],
            isVideo: 0,
            cdTime: "2026-06-16T03:00:00.000Z",
          },
          104: {
            boxId: 104,
            flowers: [[23002, 2]],
            isVideo: 0,
            cdTime: "2026-06-16T01:00:00.000Z",
          },
        },
      },
    },
  }, { nowMs: NOW, nameMap: { 23001: "白百合", 23002: "粉玫瑰" } });

  assert.equal(status.ordinary.total, 4);
  assert.deepEqual(status.ordinary.orders.map((order) => [order.boxId, order.status, order.canFinish]), [
    [101, "ready", true],
    [102, "video", false],
    [103, "cooldown", false],
    [104, "missing-items", false],
  ]);
  assert.deepEqual(status.ordinary.orders[0].requirements, [
    {
      itemId: 23001,
      name: "白百合",
      label: "白百合 (23001)",
      need: 3,
      have: 4,
      missing: 0,
      enough: true,
    },
  ]);
});

test("getAutoSubmitOrderActions keeps ordinary resident order protections without a main-task gate", () => {
  const status = summarizeOrderFlowerStatus({
    $usrTot: {
      data: {
        bag: {
          23001: 10,
        },
      },
      cntMap: {
        109: { type: 109, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
        116: { type: 116, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderMap: {
          201: { boxId: 201, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
          202: { boxId: 202, flowers: [[23001, 1]], isVideo: 1, cdTime: "2026-06-16T01:00:00.000Z" },
          203: { boxId: 203, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T03:00:00.000Z" },
          204: { boxId: 204, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
          205: { boxId: 205, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
        },
      },
    },
  }, { nowMs: NOW, nameMap: { 23001: "白百合" } });

  const mainTaskStatus = {
    taskId: 12,
    taskType: 1009,
    isResidentOrderMainTask: true,
    canProgressResidentOrderMainTask: true,
    curValue: 70,
    targetValue: 72,
    remainingValue: 2,
    received: false,
  };

  assert.equal(status.satin.dailyLimitReached, true);
  assert.equal(status.decorate.dailyLimitReached, true);

  assert.deepEqual(
    getAutoSubmitOrderActions(status, { mainTaskStatus, autoSubmitEnabled: true })
      .map((action) => [action.boxId, action.reason]),
    [
      [201, "ordinary-resident-order-ready-non-video"],
      [204, "ordinary-resident-order-ready-non-video"],
      [205, "ordinary-resident-order-ready-non-video"],
    ],
  );

  assert.deepEqual(getAutoSubmitOrderActions({
    ...status,
    decorate: {
      ...status.decorate,
      dailyLimitReached: false,
    },
  }, { mainTaskStatus, autoSubmitEnabled: true }), []);

  assert.deepEqual(
    getAutoSubmitOrderActions(status, {
      mainTaskStatus: {
        ...mainTaskStatus,
        canProgressResidentOrderMainTask: false,
      },
      autoSubmitEnabled: true,
    }).map((action) => action.boxId),
    [201, 204, 205],
  );

  const protectedStatus = {
    ...status,
    residentBoard: {
      ...status.residentBoard,
      completedCount: 49,
      teamOrderReady: false,
    },
  };
  assert.deepEqual(getAutoSubmitOrderActions(protectedStatus, {
    mainTaskStatus,
    autoSubmitEnabled: true,
    teamOrderCapability: {
      ready: true,
      teamOrderTriggerProtectionEnabled: true,
    },
  }), []);
  assert.equal(getAutoSubmitOrderActions(protectedStatus, {
    mainTaskStatus,
    autoSubmitEnabled: true,
    teamOrderCapability: {
      ready: true,
      teamOrderTriggerProtectionEnabled: false,
    },
  }).filter((action) => action.kind === "ordinary").length, 0);
  assert.equal(getAutoSubmitOrderActions({
    ...protectedStatus,
    residentBoard: {
      ...protectedStatus.residentBoard,
      teamOrderReady: true,
    },
  }, {
    mainTaskStatus,
    autoSubmitEnabled: true,
    teamOrderCapability: {
      ready: true,
      teamOrderTriggerProtectionEnabled: false,
    },
  }).filter((action) => action.kind === "ordinary").length, 3);
});

test("historical team experience decision can allow exactly one 49/99 crossing action", () => {
  const orderStatus = {
    residentBoard: {
      completedCount: 49,
      teamOrderReady: false,
      teamOrderTriggerDecisionReady: true,
    },
    satin: {
      canFinish: true,
      isVideo: false,
    },
    decorate: {
      canFinish: true,
      isVideo: false,
    },
    ordinary: {
      orders: [],
    },
  };
  const decisions = [];
  const actions = getAutoSubmitOrderActions(orderStatus, {
    teamOrderCapability: {
      requiresExperienceTriggerDecision: true,
      evaluateTrigger(action) {
        const decision = {
          blocked: false,
          teamOrderGuardExp: 10_000,
          requiredExperienceSpace: 10_500,
          reason: "historical-experience-space-available",
        };
        decisions.push({ action, decision });
        return decision;
      },
    },
  });

  assert.equal(actions.length, 1);
  assert.equal(actions[0].kind, "satin");
  assert.equal(actions[0].residentBoardTotalBefore, 49);
  assert.equal(actions[0].residentBoardTotalAfter, 50);
  assert.equal(actions[0].teamTriggerDecision.blocked, false);
  assert.equal(decisions.length, 1);
});

test("historical team experience decision receives finishable orders from the real status summary", () => {
  for (const total of [49, 99]) {
    const decisions = [];
    const capability = {
      ready: true,
      realValidated: false,
      teamOrderTriggerProtectionEnabled: false,
      requiresExperienceTriggerDecision: true,
      evaluateTrigger(action) {
        decisions.push(action);
        return {
          blocked: false,
          coldStartBypass: false,
          teamOrderGuardExp: 10_000,
          requiredExperienceSpace: 10_500,
          reason: "historical-experience-space-available",
        };
      },
    };
    const status = summarizeOrderFlowerStatus(
      syncAtResidentTotal(total, 180_001),
      {
        nowMs: NOW,
        nameMap: { 23001: "Flower" },
        teamOrderCapability: capability,
      },
    );
    const actions = getAutoSubmitOrderActions(status, {
      teamOrderCapability: capability,
    });

    assert.equal(status.residentBoard.completedCount, total);
    assert.equal(status.residentBoard.teamOrderReady, false);
    assert.equal(status.residentBoard.pauseSpecialOrders, false);
    assert.equal(status.satin.canFinish, true);
    assert.equal(status.decorate.canFinish, true);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].residentBoardTotalBefore, total);
    assert.equal(actions[0].residentBoardTotalAfter, total + 1);
    assert.equal(actions[0].teamTriggerDecision.blocked, false);
    assert.equal(decisions.length, 1);
  }
});

test("no-history cold start receives an exact trigger decision from the real status summary", () => {
  const decisions = [];
  const capability = {
    ready: true,
    realValidated: false,
    teamOrderTriggerProtectionEnabled: false,
    requiresExperienceTriggerDecision: false,
    evaluateTrigger(action) {
      decisions.push(action);
      return {
        blocked: false,
        coldStartBypass: true,
        reason: "cold-start-user-authorized",
        teamOrderReservationId: "team-exp-cold-start",
      };
    },
  };
  const status = summarizeOrderFlowerStatus(
    syncAtResidentTotal(49, 180_001),
    {
      nowMs: NOW,
      nameMap: { 23001: "Flower" },
      teamOrderCapability: capability,
    },
  );
  const actions = getAutoSubmitOrderActions(status, {
    teamOrderCapability: capability,
  });

  assert.equal(status.residentBoard.teamOrderReady, true);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].residentBoardTotalBefore, 49);
  assert.equal(actions[0].residentBoardTotalAfter, 50);
  assert.equal(actions[0].teamTriggerDecision.coldStartBypass, true);
  assert.equal(
    actions[0].teamTriggerDecision.teamOrderReservationId,
    "team-exp-cold-start",
  );
  assert.equal(decisions.length, 1);
});

test("historical team experience decision can dynamically keep the real status summary at 49/99", () => {
  let decisionCount = 0;
  const capability = {
    ready: true,
    realValidated: false,
    teamOrderTriggerProtectionEnabled: false,
    requiresExperienceTriggerDecision: true,
    evaluateTrigger() {
      decisionCount += 1;
      return {
        blocked: true,
        forceTriggerProtectionEnabled: true,
        reason: "insufficient-experience-space",
      };
    },
  };
  const status = summarizeOrderFlowerStatus(
    syncAtResidentTotal(99, 180_001),
    {
      nowMs: NOW,
      nameMap: { 23001: "Flower" },
      teamOrderCapability: capability,
    },
  );

  assert.equal(status.residentBoard.pauseSpecialOrders, false);
  assert.equal(status.satin.canFinish, true);
  assert.deepEqual(getAutoSubmitOrderActions(status, {
    teamOrderCapability: capability,
  }), []);
  assert.equal(decisionCount, 2);
});

test("historical team experience decision cannot bypass the three-minute double-gold gate", () => {
  for (const remainingMs of [null, 180_000]) {
    let decisionCount = 0;
    const capability = {
      ready: true,
      realValidated: false,
      teamOrderTriggerProtectionEnabled: false,
      requiresExperienceTriggerDecision: true,
      evaluateTrigger() {
        decisionCount += 1;
        return {
          blocked: false,
          reason: "historical-experience-space-available",
        };
      },
    };
    const status = summarizeOrderFlowerStatus(
      syncAtResidentTotal(99, remainingMs),
      {
        nowMs: NOW,
        nameMap: { 23001: "Flower" },
        teamOrderCapability: capability,
      },
    );

    assert.equal(status.residentBoard.teamOrderDoubleGoldReady, false);
    assert.equal(status.residentBoard.pauseSpecialOrders, true);
    assert.equal(status.satin.canFinish, false);
    assert.deepEqual(getAutoSubmitOrderActions(status, {
      teamOrderCapability: capability,
    }), []);
    assert.equal(decisionCount, 0);
  }
});

test("historical team experience decision forces the 49/99 stop when space is insufficient", () => {
  const orderStatus = {
    residentBoard: {
      completedCount: 99,
      teamOrderReady: false,
      teamOrderTriggerDecisionReady: true,
    },
    satin: {
      canFinish: true,
      isVideo: false,
    },
    decorate: {
      canFinish: false,
      isVideo: false,
    },
    ordinary: {
      orders: [],
    },
  };

  assert.deepEqual(getAutoSubmitOrderActions(orderStatus, {
    teamOrderCapability: {
      requiresExperienceTriggerDecision: true,
      evaluateTrigger: () => ({
        blocked: true,
        forceTriggerProtectionEnabled: true,
        reason: "insufficient-experience-space",
      }),
    },
  }), []);
});

test("getAutoSubmitOrderActions submits ordinary resident orders only when the total switch is enabled", () => {
  const status = summarizeOrderFlowerStatus({
    $usrTot: {
      data: {
        bag: {
          23001: 10,
        },
      },
      cntMap: {
        109: { type: 109, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
        116: { type: 116, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderMap: {
          201: { boxId: 201, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
          202: { boxId: 202, flowers: [[23001, 1]], isVideo: 1, cdTime: "2026-06-16T01:00:00.000Z" },
          203: { boxId: 203, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T03:00:00.000Z" },
          204: { boxId: 204, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
          205: { boxId: 205, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
        },
      },
    },
  }, { nowMs: NOW, nameMap: { 23001: "白百合" } });

  const mainTaskStatus = {
    taskId: 15,
    taskType: 2,
    isResidentOrderMainTask: false,
    canProgressResidentOrderMainTask: false,
    isLevelUpMainTask: true,
    canProgressLevelUpMainTask: true,
    canSubmitOrdinaryResidentOrderForMainTask: true,
    ordinaryResidentOrderGateReason: "level-up-main-task",
    curValue: 9,
    targetValue: 10,
    remainingValue: 1,
    received: false,
  };

  assert.deepEqual(getAutoSubmitOrderActions(status, { mainTaskStatus }), []);

  assert.deepEqual(getAutoSubmitOrderActions(status, {
    mainTaskStatus,
    autoSubmitEnabled: true,
  }), [
    {
      kind: "ordinary",
      kindText: "普通居民订单",
      iface: ORDER_FLOWER_IFACES.finishOrder,
      args: { boxId: 201 },
       reason: "ordinary-resident-order-ready-non-video",
       boxId: 201,
    },
    {
      kind: "ordinary",
      kindText: "普通居民订单",
      iface: ORDER_FLOWER_IFACES.finishOrder,
      args: { boxId: 204 },
       reason: "ordinary-resident-order-ready-non-video",
       boxId: 204,
    },
    {
      kind: "ordinary",
      kindText: "普通居民订单",
      iface: ORDER_FLOWER_IFACES.finishOrder,
      args: { boxId: 205 },
       reason: "ordinary-resident-order-ready-non-video",
       boxId: 205,
    },
  ]);

  assert.deepEqual(getAutoSubmitOrderActions({
    ...status,
    satin: {
      ...status.satin,
      dailyLimitReached: false,
    },
  }, { mainTaskStatus }), []);

  assert.deepEqual(getAutoSubmitOrderActions({
    ...status,
    satin: {
      ...status.satin,
      dailyLimitReached: false,
    },
    decorate: {
      ...status.decorate,
      dailyLimitReached: false,
    },
  }, {
    mainTaskStatus,
    autoSubmitEnabled: true,
    bypassSpecialOrderDailyLimit: true,
  }).map((action) => action.boxId), [201, 204, 205]);

  assert.deepEqual(getAutoSubmitOrderActions(status, {
    mainTaskStatus: {
      ...mainTaskStatus,
      canProgressLevelUpMainTask: false,
      canSubmitOrdinaryResidentOrderForMainTask: false,
      ordinaryResidentOrderGateReason: null,
    },
    autoSubmitEnabled: false,
  }), []);
});

test("ordinary resident auto-submit uses its total switch independently of main-task status", () => {
  const orderStatus = {
    residentBoard: { completedCount: 0 },
    satin: { dailyLimitReached: true },
    decorate: { dailyLimitReached: true },
    ordinary: {
      orders: [
        { boxId: 901, canFinish: true, isVideo: false },
        { boxId: 902, canFinish: true, isVideo: true },
        { boxId: 903, canFinish: false, isVideo: false },
      ],
    },
  };
  const mainTaskStatuses = [
    undefined,
    { exists: false, status: "no-current-task" },
    { exists: true, taskType: 1, status: "in-progress" },
    { exists: true, taskType: 2, status: "received" },
  ];

  for (const mainTaskStatus of mainTaskStatuses) {
    assert.deepEqual(
      getAutoSubmitOrderActions(orderStatus, {
        mainTaskStatus,
        autoSubmitEnabled: true,
      }).map((action) => action.boxId),
      [901],
    );
  }
  assert.deepEqual(
    getAutoSubmitOrderActions(orderStatus, { autoSubmitEnabled: false }),
    [],
  );
});

test("ordinary resident total switch preserves stock, video, cooldown, refill, and daily-limit gates", () => {
  const orderStatus = {
    residentBoard: { completedCount: 0 },
    satin: { dailyLimitReached: true },
    decorate: { dailyLimitReached: true },
    ordinary: {
      orders: [
        { boxId: 911, canFinish: false, isVideo: false, status: "out-of-stock" },
        { boxId: 912, canFinish: true, isVideo: true, status: "video" },
        { boxId: 913, canFinish: false, isVideo: false, status: "cooldown" },
        { boxId: 914, canFinish: false, isVideo: false, refillPending: true, status: "refill-pending" },
        { boxId: 915, canFinish: true, isVideo: false, status: "ready" },
      ],
    },
  };

  assert.deepEqual(
    getAutoSubmitOrderActions(orderStatus, { autoSubmitEnabled: true })
      .map((action) => action.boxId),
    [915],
  );
  assert.deepEqual(
    getAutoSubmitOrderActions({
      ...orderStatus,
      satin: { dailyLimitReached: false },
    }, { autoSubmitEnabled: true }),
    [],
  );
  assert.deepEqual(
    getAutoSubmitOrderActions({
      ...orderStatus,
      decorate: { dailyLimitReached: false },
    }, { autoSubmitEnabled: true }),
    [],
  );
});

test("summarizeOrderCustomerStatus submits stocked customer art without double gold gate", () => {
  const sync = {
    $usrTot: {
      data: { bag: { 300101: 1 } },
    },
    videoDouble: {
      eTime: "2026-06-16T02:00:59.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1, cTime: "2026-06-16T01:50:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 1,
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.doubleGoldGate.ready, false);
  assert.equal(status.orders[0].status, "ready");
  assert.equal(status.orders[0].statusText, "可提交");
  assert.equal(status.orders[0].actionText, "会提交");
  assert.equal(status.orders[0].canFinish, true);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status), [
    {
      kind: "customer",
      npcId: 8,
      artId: 300101,
      reason: "customer-art-stock-ready",
      steps: [
        {
          type: "finishCustomerOrder",
          iface: "gs.orderCustomer.finishOrder",
          args: { npcId: 8 },
        },
      ],
    },
  ]);
});

test("summarizeOrderCustomerStatus makes customer art without double gold gate when flowers are enough", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 0,
          3061: 2,
          23057: 2,
          23058: 2,
          23059: 2,
        },
      },
    },
    videoDouble: {
      eTime: "2026-06-16T01:59:00.000Z",
    },
    flowerArtTot: {
      flowerArt: {
        makeList: [300101],
      },
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 2, cTime: "2026-06-16T01:50:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 2,
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.doubleGoldGate.ready, false);
  assert.equal(status.inactiveArtCount, 0);
  assert.equal(status.orders[0].status, "make-art-ready");
  assert.equal(status.orders[0].statusText, "可制作并提交");
  assert.equal(status.orders[0].actionText, "会先制作花艺再完成订单");
  assert.equal(status.orders[0].canFinish, true);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status), [
    {
      kind: "customer",
      npcId: 8,
      artId: 300101,
      reason: "customer-flowers-ready-make-art",
      finalizesOrder: false,
      steps: [
        {
          type: "makeFlowerArt",
          iface: "gs.flowerArt.makeFlowerArt",
          args: { vaseId: 3061, flowersIds: [23057, 23058, 23059], num: 2 },
        },
      ],
    },
  ]);
});

test("getAutoSubmitCustomerOrderActions rejects inactive customer art when recipe flower stock is zero", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 0,
          3061: 2,
          23057: 2,
          23058: 0,
          23059: 2,
        },
      },
    },
    flowerArtTot: {
      flowerArt: {
        makeList: [300102],
      },
    },
    videoDouble: {
      eTime: "2026-06-16T01:59:00.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 2, cTime: "2026-06-16T01:50:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 2,
    nameMap: { 23058: "明黄矮牵牛" },
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.doubleGoldGate.ready, false);
  assert.equal(status.orders[0].status, "temporary-out-of-stock");
  assert.equal(status.orders[0].statusText, "暂时没货");
  assert.match(status.orders[0].actionText, /花艺未激活且制作所需花朵库存不足/);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status).map((action) => [action.npcId, action.steps[0].type]), [
    [8, "rejectCustomerOrder"],
  ]);
});

test("getAutoSubmitCustomerOrderActions directly submits customer order when art stock is enough", () => {
  const sync = {
    $usrTot: {
      data: { bag: { 300101: 2 } },
    },
    videoDouble: {
      eTime: "2026-06-16T02:05:00.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1, cTime: "2026-06-16T01:50:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 1,
    nameMap: { 23057: "风梨花" },
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.doubleGoldGate.ready, true);
  assert.equal(status.orders[0].status, "ready");
  assert.equal(status.orders[0].statusText, "可提交");
  assert.equal(status.orders[0].canFinish, true);
  assert.equal(status.orders[0].actionText, "会提交");
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status), [
    {
      kind: "customer",
      npcId: 8,
      artId: 300101,
      reason: "customer-art-stock-ready",
      steps: [
        {
          type: "finishCustomerOrder",
          iface: "gs.orderCustomer.finishOrder",
          args: { npcId: 8 },
        },
      ],
    },
  ]);
});

test("getAutoSubmitCustomerOrderActions submits customer order when double gold has exactly one minute left", () => {
  const sync = {
    $usrTot: {
      data: { bag: { 300101: 2 } },
    },
    videoDouble: {
      eTime: "2026-06-16T02:01:00.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1, cTime: "2026-06-16T01:50:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 1,
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.doubleGoldGate.remainingMs, 60000);
  assert.equal(status.doubleGoldGate.ready, true);
  assert.equal(status.orders[0].status, "ready");
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status), [
    {
      kind: "customer",
      npcId: 8,
      artId: 300101,
      reason: "customer-art-stock-ready",
      steps: [
        {
          type: "finishCustomerOrder",
          iface: "gs.orderCustomer.finishOrder",
          args: { npcId: 8 },
        },
      ],
    },
  ]);
});

test("getAutoSubmitCustomerOrderActions only makes flower art and waits before customer submit when flowers are enough", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 0,
          3061: 2,
          23057: 2,
          23058: 2,
          23059: 2,
        },
      },
    },
    videoDouble: {
      eTime: "2026-06-16T02:05:00.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 2, cTime: "2026-06-16T01:50:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 2,
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.orders[0].status, "make-art-ready");
  assert.equal(status.orders[0].missingArt, 2);
  assert.equal(status.orders[0].canMakeArt, true);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status), [
    {
      kind: "customer",
      npcId: 8,
      artId: 300101,
      reason: "customer-flowers-ready-make-art",
      finalizesOrder: false,
      steps: [
        {
          type: "makeFlowerArt",
          iface: "gs.flowerArt.makeFlowerArt",
          args: { vaseId: 3061, flowersIds: [23057, 23058, 23059], num: 2 },
        },
      ],
    },
  ]);
});

test("getAutoSubmitCustomerOrderActions waits for confirmed customer art sync after local make marker", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 0,
          3061: 2,
          23057: 2,
          23058: 2,
          23059: 2,
        },
      },
    },
    videoDouble: {
      eTime: "2026-06-16T02:05:00.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: {
            artId: 300101,
            num: 2,
            cTime: "2026-06-16T01:50:00.000Z",
            automationPendingArtSync: {
              artId: 300101,
              reason: "make-flower-art-unconfirmed",
            },
          },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 2,
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.orders[0].status, "waiting-art-sync");
  assert.equal(status.orders[0].statusText, "等待花艺库存同步");
  assert.equal(status.orders[0].actionText, "跳过：等待花艺库存同步");
  assert.equal(status.orders[0].canFinish, false);
  assert.equal(status.pendingWaitCount, 1);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status), []);

  const confirmedStatus = summarizeOrderCustomerStatus({
    ...sync,
    $usrTot: {
      data: {
        bag: {
          ...sync.$usrTot.data.bag,
          300101: 2,
        },
      },
    },
  }, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 2,
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(confirmedStatus.orders[0].status, "ready");
  assert.deepEqual(getAutoSubmitCustomerOrderActions(confirmedStatus), [
    {
      kind: "customer",
      npcId: 8,
      artId: 300101,
      reason: "customer-art-stock-ready",
      steps: [
        {
          type: "finishCustomerOrder",
          iface: "gs.orderCustomer.finishOrder",
          args: { npcId: 8 },
        },
      ],
    },
  ]);
});

test("getAutoSubmitCustomerOrderActions makes flower art when flowers are enough even if vase stock is not visible", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 0,
          3061: 0,
          23057: 2,
          23058: 2,
          23059: 2,
        },
      },
    },
    videoDouble: {
      eTime: "2026-06-16T02:05:00.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 2, cTime: "2026-06-16T01:50:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 2,
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.orders[0].status, "make-art-ready");
  assert.equal(status.orders[0].statusText, "可制作并提交");
  assert.equal(status.orders[0].hasEnoughFlowers, true);
  assert.equal(status.orders[0].hasEnoughVase, false);
  assert.equal(status.orders[0].missingVase, 2);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status), [
    {
      kind: "customer",
      npcId: 8,
      artId: 300101,
      reason: "customer-flowers-ready-make-art",
      finalizesOrder: false,
      steps: [
        {
          type: "makeFlowerArt",
          iface: "gs.flowerArt.makeFlowerArt",
          args: { vaseId: 3061, flowersIds: [23057, 23058, 23059], num: 2 },
        },
      ],
    },
  ]);
});

test("getAutoSubmitCustomerOrderActions rejects inactive customer art even when flowers are enough", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 0,
          3061: 2,
          23057: 2,
          23058: 2,
          23059: 2,
        },
      },
    },
    flowerArtTot: {
      flowerArt: {
        makeList: [300102],
      },
    },
    videoDouble: {
      eTime: "2026-06-16T02:05:00.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 2, cTime: "2026-06-16T01:50:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 2,
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.orders[0].status, "temporary-out-of-stock");
  assert.equal(status.orders[0].statusText, "暂时没货");
  assert.match(status.orders[0].actionText, /花艺未激活/);
  assert.equal(status.orders[0].artActivated, false);
  assert.equal(status.orders[0].canMakeArt, false);
  assert.equal(status.orders[0].canFinish, false);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status).map((action) => [action.npcId, action.steps[0].type]), [
    [8, "rejectCustomerOrder"],
  ]);
});

test("getAutoSubmitCustomerOrderActions rejects inactive customer art when stock is short", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 0,
          23057: 2,
          23058: 1,
          23059: 2,
        },
      },
    },
    flowerArtTot: {
      flowerArt: {
        makeList: [],
      },
    },
    videoDouble: {
      eTime: "2026-06-16T02:05:00.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 2, cTime: "2026-06-16T01:50:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 2,
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.orders[0].status, "temporary-out-of-stock");
  assert.equal(status.orders[0].statusText, "暂时没货");
  assert.match(status.orders[0].actionText, /花艺未激活且制作所需花朵库存不足/);
  assert.equal(status.orders[0].artActivated, false);
  assert.equal(status.temporaryOutOfStockCount, 1);
  assert.equal(status.pendingWaitCount, 0);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status).map((action) => [action.npcId, action.steps[0].type]), [
    [8, "rejectCustomerOrder"],
  ]);
});

test("summarizeOrderCustomerStatus counts only script-waiting customer orders as pending wait", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 1,
          300102: 0,
          300103: 0,
          23057: 2,
          23058: 2,
        },
      },
    },
    flowerArtTot: {
      flowerArt: {
        makeList: [300101, 300103],
      },
    },
    cultivateTot: {
      cultivateMap: {
        23057: { flowerId: 23057, lvl: 2 },
        23058: { flowerId: 23058, lvl: 2 },
      },
    },
    videoDouble: {
      eTime: "2026-06-16T02:00:30.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1, cTime: "2026-06-16T01:50:00.000Z" },
          9: { artId: 300102, num: 1, cTime: "2026-06-16T01:51:00.000Z" },
          10: { artId: 300103, num: 3, cTime: "2026-06-16T01:52:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057], cPrice: [[1002, 1]] },
        300102: { id: 300102, vaseId: 3061, flowerIds: [23057], cPrice: [[1002, 1]] },
        300103: { id: 300103, vaseId: 3061, flowerIds: [23058], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.total, 3);
  assert.equal(status.readyCount, 0);
  assert.equal(status.temporaryOutOfStockCount, 3);
  assert.equal(status.inactiveArtCount, 0);
  assert.equal(status.pendingWaitCount, 0);
  assert.deepEqual(
    status.orders.map((order) => [order.npcId, order.status]),
    [
      [8, "temporary-out-of-stock"],
      [9, "temporary-out-of-stock"],
      [10, "temporary-out-of-stock"],
    ],
  );
  assert.equal(status.flowerCurrencySelection.maxReward, 3);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status).map((action) => [action.npcId, action.steps[0].type]), [
    [8, "rejectCustomerOrder"],
    [9, "rejectCustomerOrder"],
    [10, "rejectCustomerOrder"],
  ]);
});

test("getAutoSubmitCustomerOrderActions rejects customer order when required flowers are missing from plantable list", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 0,
          23057: 2,
          23058: 0,
          23059: 2,
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23057: { flowerId: 23057, lvl: 2 },
        23058: { flowerId: 23058, lvl: 1 },
      },
    },
    flowerArtTot: {
      flowerArt: {
        makeList: [300101],
      },
    },
    videoDouble: {
      eTime: "2026-06-16T02:05:00.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 2, cTime: "2026-06-16T01:50:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    nameMap: { 23058: "明黄矮牵牛", 23059: "未培育花" },
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.orders[0].status, "temporary-out-of-stock");
  assert.equal(status.orders[0].statusText, "暂时没货");
  assert.equal(status.orders[0].cultivateKnown, true);
  assert.equal(status.orders[0].uncultivatedFlowerCount, 1);
  assert.deepEqual(status.orders[0].uncultivatedFlowers.map((item) => item.flowerId), [23058]);
  assert.deepEqual(status.orders[0].uncultivatedFlowers.map((item) => item.have), [0]);
  assert.deepEqual(status.orders[0].uncultivatedFlowers.map((item) => item.plantable), [false]);
  assert.equal(status.temporaryOutOfStockCount, 1);
  assert.equal(status.inactiveArtCount, 0);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status).map((action) => [action.npcId, action.steps[0].type]), [
    [8, "rejectCustomerOrder"],
  ]);
});

test("getAutoSubmitCustomerOrderActions rejects temporary out-of-stock customer order", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          300101: 0,
          23057: 2,
          23058: 1,
          23059: 2,
        },
      },
    },
    videoDouble: {
      eTime: "2026-06-16T02:05:00.000Z",
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 2, cTime: "2026-06-16T01:50:00.000Z" },
        },
      },
    },
  };

  const status = summarizeOrderCustomerStatus(sync, {
    nowMs: NOW,
    nameMap: { 23058: "明黄矮牵牛" },
    flowerArtConfig: {
      arts: {
        300101: { id: 300101, vaseId: 3061, flowerIds: [23057, 23058, 23059], cPrice: [[1002, 1]] },
      },
    },
  });

  assert.equal(status.orders[0].status, "temporary-out-of-stock");
  assert.equal(status.orders[0].statusText, "暂时没货");
  assert.equal(status.orders[0].canFinish, false);
  assert.equal(status.orders[0].flowerRequirements[1].name, "明黄矮牵牛");
  assert.equal(status.orders[0].flowerRequirements[1].missing, 1);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(status).map((action) => [action.npcId, action.steps[0].type]), [
    [8, "rejectCustomerOrder"],
  ]);
});

test("customer order priority rejects a non-highest order with confirmed flower shortage", () => {
  const status = summarizeOrderCustomerStatus({
    $usrTot: {
      data: {
        bag: {
          3001: 2,
          300101: 0,
          300102: 1,
          23001: 0,
        },
      },
    },
    flowerArtTot: { flowerArt: { makeList: [300101, 300102] } },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1 },
          9: { artId: 300102, num: 1 },
        },
      },
    },
  }, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 6,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a", 3),
    flowerArtConfig: {
      arts: {
        300101: customerArt(300101, 3, { vaseId: 3001, flowerIds: [23001] }),
        300102: customerArt(300102, 2, { vaseId: 3001, flowerIds: [23001] }),
      },
    },
  });

  const shortage = status.orders.find((order) => order.npcId === 8);
  assert.equal(shortage.flowerCurrencyReward, 3);
  assert.equal(shortage.flowerStockShortageConfirmed, true);
  assert.equal(shortage.customerOrderPriorityReject, true);
  assert.equal(shortage.flowerCurrencyDecision, "temporary-out-of-stock");
  assert.match(shortage.actionText, /制作所需花朵库存不足/);
  assert.deepEqual(
    getAutoSubmitCustomerOrderActions(status).map((action) => [action.npcId, action.steps[0].type]),
    [[8, "rejectCustomerOrder"], [9, "finishCustomerOrder"]],
  );
});

test("customer order priority rejects a non-highest inactive art before making or submitting", () => {
  const status = summarizeOrderCustomerStatus({
    $usrTot: {
      data: {
        bag: {
          3001: 2,
          300101: 0,
          300102: 1,
          23001: 2,
        },
      },
    },
    flowerArtTot: { flowerArt: { makeList: [300102] } },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1 },
          9: { artId: 300102, num: 1 },
        },
      },
    },
  }, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 6,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a", 3),
    flowerArtConfig: {
      arts: {
        300101: customerArt(300101, 3, { vaseId: 3001, flowerIds: [23001] }),
        300102: customerArt(300102, 2, { vaseId: 3001, flowerIds: [23001] }),
      },
    },
  });

  const inactive = status.orders.find((order) => order.npcId === 8);
  assert.equal(inactive.artActivated, false);
  assert.equal(inactive.inactiveArtConfirmed, true);
  assert.equal(inactive.customerOrderPriorityReject, true);
  assert.equal(inactive.status, "temporary-out-of-stock");
  assert.match(inactive.actionText, /花艺未激活/);
  assert.deepEqual(
    getAutoSubmitCustomerOrderActions(status).map((action) => [action.npcId, action.steps[0].type]),
    [[8, "rejectCustomerOrder"], [9, "finishCustomerOrder"]],
  );
});

test("customer order priority preserves selected actions and fails closed for unknown data", () => {
  const readyStatus = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300101: 2, 300102: 1 } } },
    flowerArtTot: { flowerArt: { makeList: [300101, 300102] } },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1 },
          9: { artId: 300102, num: 1 },
        },
      },
    },
  }, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 6,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a", 3),
    flowerArtConfig: {
      arts: {
        300101: customerArt(300101, 3, { vaseId: 3001, flowerIds: [23001] }),
        300102: customerArt(300102, 2, { vaseId: 3001, flowerIds: [23001] }),
      },
    },
  });
  assert.deepEqual(
    getAutoSubmitCustomerOrderActions(readyStatus).map((action) => [action.npcId, action.steps[0].type]),
    [[8, "finishCustomerOrder"], [9, "finishCustomerOrder"]],
  );
  assert.equal(getAutoSubmitCustomerOrderActions(readyStatus).some((action) => action.steps[0].type === "rejectCustomerOrder"), false);

  const unknownRecipeStatus = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300101: 0 } } },
    flowerArtTot: { flowerArt: { makeList: [300101] } },
    orderCustomerTot: { orderCustomer: { orderMap: { 8: { artId: 300101, num: 2 } } } },
  }, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 6,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a", 3),
    flowerArtConfig: { arts: { 300101: customerArt(300101, 3, { vaseId: null, flowerIds: [] }) } },
  });
  assert.equal(unknownRecipeStatus.orders[0].customerOrderPriorityReject, false);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(unknownRecipeStatus), []);

  const unknownRewardStatus = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300101: 0, 23001: 0 } } },
    flowerArtTot: { flowerArt: { makeList: [300101] } },
    orderCustomerTot: { orderCustomer: { orderMap: { 8: { artId: 300101, num: 2 } } } },
  }, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 6,
    requireCustomerOrderFlowerCurrencyHistory: true,
    customerOrderFlowerCurrencyHistory: historicalCustomerOrderHistory("account-a", 3),
    flowerArtConfig: {
      arts: { 300101: customerArt(300101, 3, { vaseId: 3001, flowerIds: [23001], cPrice: [[11, 1]] }) },
    },
  });
  assert.equal(unknownRewardStatus.orders[0].flowerStockShortageConfirmed, true);
  assert.equal(unknownRewardStatus.orders[0].flowerCurrencyRewardKnown, false);
  assert.deepEqual(getAutoSubmitCustomerOrderActions(unknownRewardStatus), []);

  const tiedStatus = summarizeOrderCustomerStatus({
    $usrTot: { data: { bag: { 300101: 1, 300102: 1, 3001: 2, 23001: 0 } } },
    flowerArtTot: { flowerArt: { makeList: [300101, 300102] } },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1 },
          9: { artId: 300102, num: 1 },
        },
      },
    },
  }, {
    nowMs: NOW,
    customerOrderFlowerCurrencyRewardReleaseMask: 4,
    flowerArtConfig: {
      arts: {
        300101: customerArt(300101, 3, { vaseId: 3001, flowerIds: [23001] }),
        300102: customerArt(300102, 3, { vaseId: 3001, flowerIds: [23001] }),
      },
    },
  });
  assert.equal(tiedStatus.flowerCurrencySelection.status, "ready");
  assert.deepEqual(
    getAutoSubmitCustomerOrderActions(tiedStatus).map((action) => action.steps[0].type),
    ["finishCustomerOrder", "finishCustomerOrder"],
  );
});

