import assert from "node:assert/strict";
import test from "node:test";

import {
  CYCLIC_STORY_ACTIVITY_TYPE,
  CYCLIC_STORY_IFACES,
  CYCLIC_STORY_SCORE_ITEM_ID,
  getAutoSubmitCyclicStoryActions,
  loadCyclicStoryConfig,
  summarizeCyclicStoryStatus,
} from "./cyclic-story-state.mjs";

const NOW_MS = Date.parse("2026-08-04T00:00:00.000Z");

const TEST_CONFIG = {
  orders: {
    1: { id: 1, cost: 80, items: [[1108, 8]] },
    2: { id: 2, cost: 90, items: [[1108, 9]] },
    3: { id: 3, cost: 100, items: [[1108, 10]] },
  },
  globals: {
    expOrderMax: 400,
    expValue: 1.25,
    goldValue: 2,
    qualityValue: [[1, 1], [2, 1.5]],
  },
  flowers: {
    23001: { id: 23001, name: "测试花甲", exp: 10, gld: 5 },
    23002: { id: 23002, name: "测试花乙", exp: 20, gld: 6 },
    23003: { id: 23003, name: "测试花丙", exp: 30, gld: 7 },
  },
  items: {
    23001: { id: 23001, name: "测试花甲", color: 2 },
    23002: { id: 23002, name: "测试花乙", color: 1 },
    23003: { id: 23003, name: "测试花丙", color: 1 },
  },
  itemNames: {
    1108: "花史残页",
  },
};

function makeSync({
  phase,
  status = 1,
  bms = NOW_MS - 60_000,
  ems = NOW_MS + 60_000,
  durationBefore = 120_000,
  durationAfter = 120_000,
  batchId = 99001,
  includeBatchId = true,
  expOrderNum = 12,
  orderInfo = {},
  bag = {},
  nested = false,
} = {}) {
  const cyclicStory = { expOrderNum, orderInfo };
  const act = {
    tmpId: CYCLIC_STORY_ACTIVITY_TYPE,
    tmpType: CYCLIC_STORY_ACTIVITY_TYPE,
    status,
    bms,
    ems,
    duration_before: durationBefore,
    duration_after: durationAfter,
    score: 21,
    ...(nested ? { d: { ext: { cyclicStory } } } : { ext: { cyclicStory } }),
  };
  if (phase != null) act.phase = phase;
  if (includeBatchId) act.batchId = batchId;
  return {
    $usrTot: { data: { bag } },
    actTot: { map: { [batchId]: act } },
  };
}

function makeStrategyOrder({ orderIdx, expectedExperience, status = "ready" }) {
  return {
    orderIdx,
    orderId: orderIdx + 1,
    flowerId: 23001 + orderIdx,
    flowerName: `测试花${orderIdx}`,
    cost: 80,
    have: status === "inventory-shortage" ? 0 : 80,
    remainingMs: status === "cooling" ? 1_000 : 0,
    status,
    ready: status === "ready",
    expectedExperience,
  };
}

function makeStrategyStatus(orders) {
  return {
    active: true,
    phase: 2,
    batchId: 99001,
    orders,
  };
}

test("cyclic story constants match the official client protocol", () => {
  assert.equal(CYCLIC_STORY_ACTIVITY_TYPE, 4003);
  assert.equal(CYCLIC_STORY_SCORE_ITEM_ID, 1108);
  assert.deepEqual(CYCLIC_STORY_IFACES, {
    enter: "gs.actCyclicStory.enter",
    recvOrderRwd: "gs.actCyclicStory.recvOrderRwd",
  });
});

test("loadCyclicStoryConfig decodes the current official order contract", () => {
  const config = loadCyclicStoryConfig();
  assert.equal(config.orders.size, 4);
  assert.equal(config.orders.get(1).cost, 80);
  assert.deepEqual(config.orders.get(4).items, [[1108, 12]]);
  assert.equal(config.globals.expOrderMax, 400);
  assert.equal(config.globals.expValue, 1.25);
  assert.equal(config.globals.goldValue, 2);
  assert.equal(config.globals.qualityValue.get(2), 1);
  assert.equal(config.flowers.get(23001).name, "白百合");
  assert.equal(config.items.get(23001).color, 1);
  assert.equal(config.itemNames[1108], "花史残页");
});

test("summarizeCyclicStoryStatus applies official time, inventory, and experience rules", () => {
  const status = summarizeCyclicStoryStatus(makeSync({
    orderInfo: {
      0: { orderId: 1, flowerId: 23001, validTime: NOW_MS - 1 },
      1: { orderId: 2, flowerId: 23002, validTime: NOW_MS + 5_000 },
      2: { orderId: 3, flowerId: 23003, validTime: NOW_MS - 1 },
    },
    bag: { 23001: 100, 23002: 100, 23003: 99 },
  }), { cyclicStoryConfig: TEST_CONFIG, nowMs: NOW_MS });

  assert.equal(status.active, true);
  assert.equal(status.phase, 2);
  assert.equal(status.phaseSource, "official-time");
  assert.equal(status.score, 21);
  assert.equal(status.expOrderNum, 12);
  assert.equal(status.expOrderMax, 400);
  assert.deepEqual(status.orders.map((order) => order.status), [
    "ready",
    "cooling",
    "inventory-shortage",
  ]);
  assert.equal(status.orders[0].expectedExperience, 1_000);
  assert.equal(status.orders[0].expectedGold, 800);
  assert.equal(status.orders[0].quality, 2);
  assert.equal(status.orders[0].qualityRewardMultiplier, 1.5);
  assert.equal(status.orders[0].rewardText, "花史残页x12");
  assert.equal(status.orders[0].expectedRewardText, "花史残页x12、金币x800、经验x1000");
  assert.equal(status.orders[1].remainingMs, 5_000);
  assert.equal(status.orders[2].missing, 1);

  assert.deepEqual(getAutoSubmitCyclicStoryActions(status), [{
    kind: "cyclicStory",
    iface: "gs.actCyclicStory.recvOrderRwd",
    args: { batchId: 99001, orderIdx: 0 },
    batchId: 99001,
    orderIdx: 0,
    orderId: 1,
    flowerId: 23001,
    flowerName: "测试花甲",
    cost: 80,
    have: 100,
    expectedExperience: 1_000,
    rewardText: "花史残页x12",
    reason: "cyclic-story-order-ready",
  }]);
});

test("cyclic story computes the official lifecycle from bms and ems instead of record status", () => {
  const cases = [
    { nowMs: NOW_MS - 121_000, phase: 0, reason: "not-started", text: "尚未进入预告期" },
    { nowMs: NOW_MS - 61_000, phase: 1, reason: "preview", text: "预告期：活动尚未开始" },
    { nowMs: NOW_MS, phase: 2, reason: "active", text: "进行期：可提交订单" },
    { nowMs: NOW_MS + 61_000, phase: 3, reason: "exchange", text: "兑换期：订单提交已结束" },
    { nowMs: NOW_MS + 181_000, phase: 4, reason: "ended", text: "活动已结束" },
  ];
  const syncValue = makeSync({
    status: 1,
    bms: NOW_MS - 60_000,
    ems: NOW_MS + 60_000,
    durationBefore: 60_000,
    durationAfter: 120_000,
  });

  for (const expected of cases) {
    const status = summarizeCyclicStoryStatus(syncValue, {
      cyclicStoryConfig: TEST_CONFIG,
      nowMs: expected.nowMs,
    });
    assert.equal(status.phase, expected.phase);
    assert.equal(status.reason, expected.reason);
    assert.equal(status.reasonText, expected.text);
    assert.equal(status.phaseSource, "official-time");
    assert.equal(status.recordStatus, 1);
  }
});

test("cyclic story does not mistake the activity record status for phase 1", () => {
  const syncValue = makeSync({
    phase: undefined,
    status: 1,
    bms: null,
    ems: null,
  });
  const status = summarizeCyclicStoryStatus(syncValue, {
    cyclicStoryConfig: TEST_CONFIG,
    nowMs: NOW_MS,
  });

  assert.equal(status.phase, "unknown");
  assert.equal(status.phaseSource, "unknown");
  assert.equal(status.recordStatus, 1);
  assert.equal(status.reason, "unknown");
});

test("cyclic story uses orderId 1 fallback and disables experience after the configured limit", () => {
  const status = summarizeCyclicStoryStatus(makeSync({
    expOrderNum: 400,
    nested: true,
    orderInfo: {
      7: { flowerId: 23001, validTime: NOW_MS - 1 },
    },
    bag: { 23001: 80 },
  }), { cyclicStoryConfig: TEST_CONFIG, nowMs: NOW_MS });

  assert.equal(status.orders[0].orderId, 1);
  assert.equal(status.orders[0].expectedExperience, 0);
  assert.equal(status.orders[0].grantsExperience, false);
  assert.equal(getAutoSubmitCyclicStoryActions(status)[0].args.orderIdx, 7);
});

test("cyclic story auto submit toggle clears pending actions when disabled", () => {
  const syncValue = makeSync({
    orderInfo: {
      0: { orderId: 1, flowerId: 23001, validTime: NOW_MS - 1 },
    },
    bag: { 23001: 100 },
  });
  const baseOptions = { cyclicStoryConfig: TEST_CONFIG, nowMs: NOW_MS };

  const disabled = summarizeCyclicStoryStatus(syncValue, {
    ...baseOptions,
    autoSubmitEnabled: false,
  });
  assert.equal(disabled.active, true);
  assert.deepEqual(disabled.pendingAutoSubmitActions, []);

  const defaulted = summarizeCyclicStoryStatus(syncValue, baseOptions);
  assert.deepEqual(defaulted.pendingAutoSubmitActions, getAutoSubmitCyclicStoryActions(defaulted));
  assert.equal(defaulted.pendingAutoSubmitActions.length, 1);
});

test("cyclic story highest experience strategy locks the current three orders and chooses one stable winner", () => {
  const status = makeStrategyStatus([
    makeStrategyOrder({ orderIdx: 2, expectedExperience: 30 }),
    makeStrategyOrder({ orderIdx: 0, expectedExperience: 50 }),
    makeStrategyOrder({ orderIdx: 1, expectedExperience: 50 }),
    makeStrategyOrder({ orderIdx: 3, expectedExperience: 500 }),
  ]);

  assert.deepEqual(
    getAutoSubmitCyclicStoryActions(status, { onlyHighestExperienceOrder: true })
      .map((action) => action.orderIdx),
    [0],
  );
});

test("cyclic story highest experience strategy waits for every current order to leave cooldown", () => {
  const status = makeStrategyStatus([
    makeStrategyOrder({ orderIdx: 0, expectedExperience: 100 }),
    makeStrategyOrder({ orderIdx: 1, expectedExperience: 300, status: "cooling" }),
    makeStrategyOrder({ orderIdx: 2, expectedExperience: 200 }),
  ]);

  assert.deepEqual(
    getAutoSubmitCyclicStoryActions(status, { onlyHighestExperienceOrder: true }),
    [],
  );
});

test("cyclic story highest experience strategy does not downgrade when the winner lacks inventory", () => {
  const status = makeStrategyStatus([
    makeStrategyOrder({ orderIdx: 0, expectedExperience: 100 }),
    makeStrategyOrder({ orderIdx: 1, expectedExperience: 300, status: "inventory-shortage" }),
    makeStrategyOrder({ orderIdx: 2, expectedExperience: 200 }),
  ]);

  assert.deepEqual(
    getAutoSubmitCyclicStoryActions(status, { cyclicStoryOnlyHighestExperienceOrder: true }),
    [],
  );
});

test("cyclic story highest experience strategy fails closed for unknown experience and remains off by default", () => {
  const status = makeStrategyStatus([
    makeStrategyOrder({ orderIdx: 0, expectedExperience: 100 }),
    makeStrategyOrder({ orderIdx: 1, expectedExperience: null }),
    makeStrategyOrder({ orderIdx: 2, expectedExperience: 200 }),
  ]);

  assert.deepEqual(
    getAutoSubmitCyclicStoryActions(status, { onlyHighestExperienceOrder: true }),
    [],
  );
  assert.deepEqual(
    getAutoSubmitCyclicStoryActions(makeStrategyStatus([
      makeStrategyOrder({ orderIdx: 0, expectedExperience: 100 }),
      makeStrategyOrder({ orderIdx: 1, expectedExperience: 300 }),
      makeStrategyOrder({ orderIdx: 2, expectedExperience: 200 }),
    ])).map((action) => action.orderIdx),
    [0, 1, 2],
  );
});

test("cyclic story fails closed for inactive, missing batch, missing config, or missing validTime", () => {
  const cases = [
    makeSync({
      bms: NOW_MS + 60_000,
      ems: NOW_MS + 120_000,
      durationBefore: 120_000,
      orderInfo: { 0: { orderId: 1, flowerId: 23001, validTime: NOW_MS - 1 } },
      bag: { 23001: 80 },
    }),
    makeSync({ includeBatchId: false, orderInfo: { 0: { orderId: 1, flowerId: 23001, validTime: NOW_MS - 1 } }, bag: { 23001: 80 } }),
    makeSync({ orderInfo: { 0: { orderId: 99, flowerId: 23001, validTime: NOW_MS - 1 } }, bag: { 23001: 80 } }),
    makeSync({ orderInfo: { 0: { orderId: 1, flowerId: 23001 } }, bag: { 23001: 80 } }),
  ];

  for (const syncValue of cases) {
    const status = summarizeCyclicStoryStatus(syncValue, {
      cyclicStoryConfig: TEST_CONFIG,
      nowMs: NOW_MS,
    });
    assert.equal(getAutoSubmitCyclicStoryActions(status).length, 0);
  }
});
