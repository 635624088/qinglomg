import test from "node:test";
import assert from "node:assert/strict";
import {
  TEAM_ORDER_IFACES,
  TEAM_ORDER_SCHEMA_NAMES,
  calculateTeamOrderReward,
  evaluateTeamOrderCapability,
  getTeamOrderNobleExpAdd,
  loadTeamOrderConfig,
  selectEarliestStoredOrder,
  shouldRefreshProtectedTeamOrderFlower,
  summarizeTeamOrder,
} from "./team-order-state.mjs";

function fixtureTeamConfig() {
  return {
    durationSeconds: 50,
    maxOrderNum: 160,
    refreshPerSecond: 4,
    orders: new Map(Array.from({ length: 160 }, (_, index) => [
      index + 1,
      { orderNum: index + 1, flowerNum: 15 },
    ])),
  };
}

test("team order protected flowers use exact refresh-only matching", () => {
  const cases = [
    { flowerName: "曼珠沙华", expected: true },
    { flowerName: "伯利恒之星", expected: true },
    { flowerName: "白百合", expected: false },
    { flowerName: "曼珠沙华·稀有", expected: false },
    { flowerName: "", expected: false },
    { flowerName: null, expected: false },
  ];

  for (const { flowerName, expected } of cases) {
    assert.equal(
      shouldRefreshProtectedTeamOrderFlower(flowerName),
      expected,
      `flowerName=${String(flowerName)}`,
    );
  }
});

test("loadTeamOrderConfig decodes the current c_orderTeam contract", () => {
  const config = loadTeamOrderConfig();

  assert.deepEqual(config.triggerCounts, [50, 100]);
  assert.equal(config.durationSeconds, 50);
  assert.equal(config.maxOrderNum, 160);
  assert.equal(config.refreshPerSecond, 4);
  assert.equal(config.storeSeconds, 1800);
  assert.deepEqual(config.paidRenewCost, [1, 60]);
  assert.equal(config.orders.get(1).flowerNum, 15);
  assert.equal(config.nobleExpAdd, 0.25);
});

test("getTeamOrderNobleExpAdd follows the client recharge-card validity rule", () => {
  const config = { nobleExpAdd: 0.25 };
  const nowMs = Date.parse("2026-07-27T00:00:00.000Z");

  assert.equal(getTeamOrderNobleExpAdd({
    rchgTot: { cardMap: { 1: { type: 1, isMain: true } } },
  }, config, { nowMs }), 0.25);
  assert.equal(getTeamOrderNobleExpAdd({
    rchgTot: {
      cardMap: {
        1: { type: 1, invalidTime: "2026-07-28T00:00:00.000Z" },
      },
    },
  }, config, { nowMs }), 0.25);
  assert.equal(getTeamOrderNobleExpAdd({
    rchgTot: {
      cardMap: {
        1: { type: 1, invalidTime: "2026-07-26T00:00:00.000Z" },
      },
    },
  }, config, { nowMs }), 0);
  assert.equal(getTeamOrderNobleExpAdd({}, config, { nowMs }), 0);
});

test("calculateTeamOrderReward follows the finish dialog config formula", () => {
  const config = {
    rewardBase: [[2, 8_000], [11, 10_000]],
    orders: new Map([[
      12,
      { orderNum: 12, flowerNum: 30, magnification: 120 },
    ]]),
  };

  assert.deepEqual(calculateTeamOrderReward({
    orderNum: 12,
    rwd: { 2: 500, 11: 1_000 },
  }, config, {
    nobleExpAdd: 0.1,
  }), {
    orderNum: 12,
    multiplier: 1.2,
    magnification: 120,
    base: { 2: 8_000, 11: 10_000 },
    bonus: { 2: 500, 11: 1_000 },
    nobleExpAdd: 0.1,
    displayed: { 2: 11_220, 11: 13_200 },
  });
});

test("calculateTeamOrderReward does not invent noble experience when account truth is absent", () => {
  const config = {
    rewardBase: [[2, 8_000], [11, 10_000]],
    orders: new Map([[
      1,
      { orderNum: 1, flowerNum: 15, magnification: 100 },
    ]]),
  };

  const reward = calculateTeamOrderReward({
    orderNum: 1,
    rwd: { 2: 25, 11: 50 },
  }, config);

  assert.equal(reward.displayed[11], 10_050);
  assert.equal(reward.displayed[2], null);
  assert.equal(reward.nobleExpAdd, null);
});

test("summarizeTeamOrder treats a timed-out status 2 as status 3", () => {
  const status = summarizeTeamOrder({
    orderTeamTot: { orderTeam: { status: 2, startTime: 1_000, orderNum: 9, flowerId: 23001 } },
    $usrTot: { data: { bag: { 23001: 20 } } },
  }, {
    config: fixtureTeamConfig(),
    nowMs: 51_001,
    flowerNames: { 23001: "白百合" },
  });

  assert.equal(status.effectiveStatus, 3);
  assert.equal(status.expiredByServerTime, true);
  assert.equal(status.flowerName, "白百合");
  assert.equal(status.have, 20);
});

test("summarizeTeamOrder treats a missing order object as idle status 0", () => {
  const status = summarizeTeamOrder({
    orderTeamTot: {},
  }, {
    config: fixtureTeamConfig(),
    nowMs: 10_000,
  });

  assert.equal(status.status, 0);
  assert.equal(status.effectiveStatus, 0);
  assert.equal(status.expiredByServerTime, false);
});

test("summarizeTeamOrder accepts ISO, millisecond, and current second timestamps", () => {
  const config = fixtureTeamConfig();
  const nowMs = Date.parse("2026-07-24T00:01:00.000Z");
  const cases = [
    "2026-07-24T00:00:00.000Z",
    nowMs - 60_000,
    Math.floor((nowMs - 60_000) / 1000),
  ];

  for (const startTime of cases) {
    const status = summarizeTeamOrder({
      orderTeamTot: { orderTeam: { status: 2, startTime, orderNum: 1, flowerId: 23001 } },
    }, { config, nowMs });
    assert.equal(status.effectiveStatus, 3);
    assert.equal(status.expiredByServerTime, true);
  }
});

test("summarizeTeamOrder preserves Date(0) as a valid start time", () => {
  const status = summarizeTeamOrder({
    orderTeamTot: { orderTeam: { status: 2, startTime: new Date(0), orderNum: 1, flowerId: 23001 } },
  }, {
    config: fixtureTeamConfig(),
    nowMs: 49_999,
  });

  assert.equal(status.startTimeMs, 0);
  assert.equal(status.expiresAtMs, 50_000);
  assert.equal(status.expiredByServerTime, false);
});

test("summarizeTeamOrder preserves Unix epoch zero as a valid start time", () => {
  const status = summarizeTeamOrder({
    orderTeamTot: { orderTeam: { status: 2, startTime: 0, orderNum: 1, flowerId: 23001 } },
  }, {
    config: fixtureTeamConfig(),
    nowMs: 49_999,
  });

  assert.equal(status.startTimeMs, 0);
  assert.equal(status.expiresAtMs, 50_000);
  assert.equal(status.expiredByServerTime, false);
});

test("summarizeTeamOrder keeps the exact expiry instant active like the official client", () => {
  const status = summarizeTeamOrder({
    orderTeamTot: { orderTeam: { status: 2, startTime: 0, orderNum: 1, flowerId: 23001 } },
    $usrTot: { data: { bag: { 23001: 15 } } },
  }, {
    config: fixtureTeamConfig(),
    nowMs: 50_000,
  });

  assert.equal(status.effectiveStatus, 2);
  assert.equal(status.expiredByServerTime, false);
  assert.equal(status.canSubmit, true);

  const expired = summarizeTeamOrder({
    orderTeamTot: { orderTeam: { status: 2, startTime: 0, orderNum: 1, flowerId: 23001 } },
    $usrTot: { data: { bag: { 23001: 15 } } },
  }, {
    config: fixtureTeamConfig(),
    nowMs: 50_001,
  });
  assert.equal(expired.effectiveStatus, 3);
  assert.equal(expired.expiredByServerTime, true);
  assert.equal(expired.canSubmit, false);
});

test("selectEarliestStoredOrder ignores expired rows and selects the earliest expiry", () => {
  const selected = selectEarliestStoredOrder([
    { npcId: 2, expireTime: 9_000 },
    { npcId: 3, expireTime: 4_000 },
    { npcId: 4, expireTime: 500 },
  ], 1_000);

  assert.equal(selected.npcId, 3);
});

test("selectEarliestStoredOrder compares ISO and second-based expiry timestamps", () => {
  const nowMs = Date.parse("2026-07-24T00:00:00.000Z");
  const selected = selectEarliestStoredOrder([
    { npcId: 2, expireTime: "2026-07-24T00:02:00.000Z" },
    { npcId: 3, expireTime: Math.floor((nowMs + 30_000) / 1000) },
    { npcId: 4, expireTime: Math.floor((nowMs - 1_000) / 1000) },
  ], nowMs);

  assert.equal(selected.npcId, 3);
});

test("evaluateTeamOrderCapability checks only team config, state, and schemas", () => {
  const schemas = Object.fromEntries(
    Object.values(TEAM_ORDER_SCHEMA_NAMES).map((name) => [name, {}]),
  );
  schemas[TEAM_ORDER_SCHEMA_NAMES.takeOrder] = { isAgree: 0, isCost: 1 };
  schemas[TEAM_ORDER_SCHEMA_NAMES.takeStoredOrder] = { npcId: 0 };

  const capability = evaluateTeamOrderCapability(
    { orderTeamTot: { orderTeam: { status: 0 } } },
    fixtureTeamConfig(),
    { schemas, gameVersionNotice: { updateAvailable: true } },
  );

  assert.equal(capability.ready, true);
  assert.equal(capability.realValidated, false);
  assert.deepEqual(TEAM_ORDER_IFACES, {
    takeOrder: "gs.orderTeam.takeOrder",
    submitOrder: "gs.orderTeam.submitOrder",
    refreshOrder: "gs.orderTeam.refreshOrder",
    recvRwd: "gs.orderTeam.recvRwd",
    storeOrder: "gs.orderTeam.storeOrder",
    takeStoredOrder: "gs.orderTeam.takeStoredOrder",
  });
});
