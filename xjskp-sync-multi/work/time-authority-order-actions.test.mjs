import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  FLOWER_CURRENCY_ITEM_ID,
  getAutoSubmitCustomerOrderActions,
  getAutoSubmitOrderActions,
  getAutoSubmitPalaceOrderActions,
  summarizeOrderCustomerStatus,
  summarizeOrderFlowerStatus,
  summarizeOrderPalaceStatus,
} from "./order-state.mjs";
import {
  createTimeAuthority,
  getTimeAuthoritySnapshot,
} from "./time-authority.mjs";
import { createCustomerOrderScheduler } from "./customer-order-scheduler.mjs";
import {
  getCustomerOrderGenerationStatus,
  getCustomerOrderNpcPlan,
  getResourceActionNowMs,
  refreshCustomerOrders,
} from "./inspect-garden-dryrun.mjs?time-authority-order-actions";

const SERVER_NOW = Date.parse("2026-08-22T15:50:30.000Z");
const LOCAL_SLOW = SERVER_NOW - 60_000;
const LOCAL_FAST = SERVER_NOW + 60_000;

function acceptedAuthority(localNowMs, serverNowMs = SERVER_NOW, maxAgeMs = 300_000) {
  const authority = createTimeAuthority({
    maxAgeMs,
    nowFn: () => localNowMs,
  });
  authority.beginHeartbeat(localNowMs - 400);
  authority.recordHeartbeat({
    serverMs: serverNowMs - 200,
    responseAtMs: localNowMs,
  });
  return authority.getState();
}

function withEnvironment(name, value, callback) {
  const previous = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (previous == null) delete process.env[name];
      else process.env[name] = previous;
    });
}

function customerArt(id, reward) {
  return {
    id,
    vaseId: 3061,
    flowerIds: [23001],
    cPrice: [[FLOWER_CURRENCY_ITEM_ID, reward]],
  };
}

const T3_CUSTOMER_NPC_CONFIG = {
  sourcePath: "fixture:c_orderCustomerNpc",
  npcIds: [8, 9],
  npcs: {
    8: { id: 8, maintaskId: 0 },
    9: { id: 9, maintaskId: 0 },
  },
  npcMaxDay: 350,
};

const T3_FLOWER_ART_CONFIG = {
  sourcePath: "fixture:c_flowerArt",
  customerMax: 3,
  arts: {},
};

function customerGenerationSync({ nowMs = SERVER_NOW, unverifiedGuestNpcIds, existingOrderNpcIds = [], dailyCount = 0 } = {}) {
  const orderCustomer = {
    nextGenTime: new Date(nowMs - 2_000).toISOString(),
    orderMap: Object.fromEntries(existingOrderNpcIds.map((npcId) => [npcId, { artId: 300101, num: 1 }])),
  };
    if (unverifiedGuestNpcIds !== undefined) {
      orderCustomer.guestNpcIds = unverifiedGuestNpcIds;
      orderCustomer.visitNpcIds = unverifiedGuestNpcIds;
      orderCustomer.visitorNpcIds = unverifiedGuestNpcIds;
      orderCustomer.guestNpcIdList = unverifiedGuestNpcIds;
    }
  return {
    $usrTot: { cntMap: { 107: { type: 107, tdyCnt: dailyCount } } },
    orderCustomerTot: { orderCustomer },
  };
}

async function runCustomerGenerationFixture(sync, options = {}) {
  const calls = [];
  const ws = {
    async request(iface, args) {
      calls.push({ iface, args });
      return {
        v: {
          orderCustomerTot: {
            orderCustomer: {
              nextGenTime: new Date(SERVER_NOW + 30_000).toISOString(),
              orderMap: sync.orderCustomerTot.orderCustomer.orderMap,
            },
          },
        },
      };
    },
  };
  const result = await refreshCustomerOrders(ws, "token", sync, "t3CustomerGeneration", {
    nowMs: SERVER_NOW,
    timeAuthorityNowFn: () => SERVER_NOW,
    flowerNames: {},
    orderCustomerNpcConfig: T3_CUSTOMER_NPC_CONFIG,
    flowerArtConfig: T3_FLOWER_ART_CONFIG,
    returnGenerationResult: true,
    ...options,
  });
  return { calls, result };
}

test("customer generation sends an empty guest exclusion list when no real visitor is verifiable", async () => {
  const { calls, result } = await runCustomerGenerationFixture(customerGenerationSync());

  assert.deepEqual(calls, [{ iface: "gs.orderCustomer.genOrder", args: { guestNpcIdList: [] } }]);
  assert.equal(result.attempted, true);
  assert.deepEqual(result.customerNpcPlan.guestNpcIds, []);
  assert.deepEqual(result.customerNpcPlan.availableNpcIds, [8, 9]);
});

test("customer generation ignores unproven visitor-looking orderCustomer fields", async () => {
  const { calls, result } = await runCustomerGenerationFixture(
    customerGenerationSync({ unverifiedGuestNpcIds: [8] }),
  );

  assert.deepEqual(calls, [{ iface: "gs.orderCustomer.genOrder", args: { guestNpcIdList: [] } }]);
  assert.deepEqual(result.customerNpcPlan.guestNpcIds, []);
  assert.equal(
    result.customerNpcPlan.guestNpcIdSource,
    "unavailable/local-visitor-state-unavailable",
  );
  assert.deepEqual(result.customerNpcPlan.availableNpcIds, [8, 9]);
});

test("customer generation sends only verified real visitors and never available candidates", async () => {
  const { calls, result } = await runCustomerGenerationFixture(
    customerGenerationSync(),
    {
      customerOrderVerifiedGuestNpcState: {
        verified: true,
        provenance: "fixture:local-visitor-adapter",
        guestNpcIds: [8],
      },
    },
  );

  assert.deepEqual(calls, [{ iface: "gs.orderCustomer.genOrder", args: { guestNpcIdList: [8] } }]);
  assert.deepEqual(result.customerNpcPlan.guestNpcIds, [8]);
  assert.deepEqual(result.customerNpcPlan.availableNpcIds, [9]);
  assert.deepEqual(calls[0].args.guestNpcIdList, result.customerNpcPlan.guestNpcIds);
  assert.notDeepEqual(calls[0].args.guestNpcIdList, result.customerNpcPlan.availableNpcIds);
});

test("customer generation blocks when existing orders and real visitors occupy every configured NPC", async () => {
  const { calls, result } = await runCustomerGenerationFixture(
    customerGenerationSync({ existingOrderNpcIds: [9] }),
    {
      customerOrderVerifiedGuestNpcState: {
        verified: true,
        provenance: "fixture:local-visitor-adapter",
        guestNpcIds: [8],
      },
    },
  );

  assert.deepEqual(calls, []);
  assert.equal(result.attempted, false);
  assert.equal(result.reason, "no-available-npcs");
  assert.deepEqual(result.customerNpcPlan.existingOrderNpcIds, [9]);
  assert.deepEqual(result.customerNpcPlan.guestNpcIds, [8]);
  assert.deepEqual(result.customerNpcPlan.availableNpcIds, []);
});

test("customer generation source contains no simulated visitor or available-candidate request fallback", () => {
  const source = fs.readFileSync(new URL("./inspect-garden-dryrun.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /simulated-c_orderCustomerNpc/);
  assert.doesNotMatch(source, /availableNpcIds\.slice/);
  assert.doesNotMatch(source, /sync\.orderCustomer\.(?:guestNpcIds|visitNpcIds|visitorNpcIds|guestNpcIdList)/);
  assert.match(source, /customerOrderVerifiedGuestNpcState/);
  assert.match(source, /unavailable\/local-visitor-state-unavailable/);
});

test("customer generation fails closed for unknown official counts, configuration, or unlock state", async () => {
  const baseSync = customerGenerationSync();
  const cases = [
    ["cusMax", { flowerArtConfig: { sourcePath: "fixture:c_flowerArt", customerMax: null, arts: {} } }, "customer-max-state-unknown"],
    ["npcMaxDay", { orderCustomerNpcConfig: { ...T3_CUSTOMER_NPC_CONFIG, npcMaxDay: null } }, "daily-generation-state-unknown"],
    ["tdyCount", { sync: { ...baseSync, $usrTot: { cntMap: {} } } }, "daily-generation-state-unknown"],
    ["npc-config-source", { orderCustomerNpcConfig: { ...T3_CUSTOMER_NPC_CONFIG, sourcePath: null } }, "available-npc-state-unknown"],
    ["unlock-state", {
      orderCustomerNpcConfig: {
        ...T3_CUSTOMER_NPC_CONFIG,
        npcs: { 8: { id: 8, maintaskId: 10 }, 9: { id: 9, maintaskId: 10 } },
      },
    }, "available-npc-state-unknown"],
  ];

  for (const [label, entry, expectedReason] of cases) {
    const { calls, result } = await runCustomerGenerationFixture(entry.sync || baseSync, entry);
    assert.deepEqual(calls, [], label);
    assert.equal(result.attempted, false, label);
    assert.equal(result.reason, expectedReason, label);
  }
});

test("customer NPC sets keep existing orders, real visitors, and available candidates independent", () => {
  const plan = getCustomerOrderNpcPlan({
    taskTot: { main: { curTaskId: 10 } },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          7: { artId: 300101, num: 1 },
        },
      },
    },
  }, {}, {
    orderCustomerNpcConfig: {
      sourcePath: "fixture:c_orderCustomerNpc",
      npcIds: [7, 8, 9],
      npcs: {
        7: { id: 7, maintaskId: 1 },
        8: { id: 8, maintaskId: 1 },
        9: { id: 9, maintaskId: 1 },
      },
      npcMaxDay: 350,
    },
    customerOrderVerifiedGuestNpcState: {
      verified: true,
      provenance: "fixture:local-visitor-adapter",
      guestNpcIds: [8],
    },
  });

  assert.deepEqual(plan.existingOrderNpcIds, [7]);
  assert.deepEqual(plan.guestNpcIds, [8]);
  assert.deepEqual(plan.availableNpcIds, [9]);
  assert.deepEqual(plan.guestNpcIdList, [8]);
  assert.notDeepEqual(plan.guestNpcIdList, plan.availableNpcIds);
});

test("customer NPC candidates use only unlocked official rows at low main-task progress", () => {
  const plan = getCustomerOrderNpcPlan({
    taskTot: { main: { curTaskId: 10 } },
    orderCustomerTot: { orderCustomer: { orderMap: {} } },
  }, {}, {
    orderCustomerNpcConfig: {
      sourcePath: "fixture:c_orderCustomerNpc",
      npcIds: [7, 8, 9],
      npcs: {
        7: { id: 7, maintaskId: 5 },
        8: { id: 8, maintaskId: 10 },
        9: { id: 9, maintaskId: 11 },
      },
      npcMaxDay: 350,
    },
  });

  assert.deepEqual(plan.availableNpcIds, [7, 8]);
  assert.equal(plan.unlockStateKnown, true);
});

test("customer NPC candidate source fails closed when unlock state is unknown", () => {
  const plan = getCustomerOrderNpcPlan({
    orderCustomerTot: { orderCustomer: { orderMap: {} } },
  }, {}, {
    orderCustomerNpcConfig: {
      sourcePath: "fixture:c_orderCustomerNpc",
      npcIds: [8],
      npcs: { 8: { id: 8, maintaskId: 10 } },
      npcMaxDay: 350,
    },
  });

  assert.deepEqual(plan.guestNpcIds, []);
  assert.deepEqual(plan.availableNpcIds, []);
  assert.equal(plan.availableNpcSourceKnown, false);
  assert.equal(plan.reason, "main-task-state-unknown");
});

test("trusted corrected time controls customer generation cooldown across a one-minute local skew", async () => {
  const sync = {
    $usrTot: {
      cntMap: {
        107: { type: 107, tdyCnt: 0 },
      },
    },
    orderCustomerTot: {
      orderCustomer: {
        nextGenTime: new Date(SERVER_NOW - 2_000).toISOString(),
        guestNpcIdList: [8],
        orderMap: {},
      },
    },
  };
  const trustedAuthority = acceptedAuthority(LOCAL_SLOW);
  const calls = [];
  const ws = {
    async request(iface, args) {
      calls.push({ iface, args });
      return { v: {} };
    },
  };

  await withEnvironment("CUSTOMER_ORDER_GEN_BEFORE_ACTION", "1", async () => {
    await withEnvironment("CUSTOMER_ORDER_FORCE_GEN", "0", async () => {
      const trustedStatus = getCustomerOrderGenerationStatus(sync, {
        nowMs: LOCAL_SLOW,
        timeAuthority: trustedAuthority,
      });
      assert.equal(trustedStatus.nowMs, SERVER_NOW);
      assert.equal(trustedStatus.cooldownActive, false);

      await refreshCustomerOrders(ws, "token", sync, "trustedCustomerGeneration", {
        nowMs: LOCAL_SLOW,
        timeAuthority: trustedAuthority,
        flowerNames: {},
        orderCustomerNpcConfig: T3_CUSTOMER_NPC_CONFIG,
        flowerArtConfig: T3_FLOWER_ART_CONFIG,
      });
      assert.deepEqual(calls.map((call) => call.iface), ["gs.orderCustomer.genOrder"]);

      calls.length = 0;
      const missingStatus = getCustomerOrderGenerationStatus(sync, { nowMs: LOCAL_SLOW });
      assert.equal(missingStatus.nowMs, LOCAL_SLOW);
      assert.equal(missingStatus.cooldownActive, true);
      await refreshCustomerOrders(ws, "token", sync, "missingCustomerGeneration", {
        nowMs: LOCAL_SLOW,
        flowerNames: {},
      });
      assert.deepEqual(calls, []);

      calls.length = 0;
      const expiredAuthority = acceptedAuthority(LOCAL_SLOW, SERVER_NOW, 30_000);
      const expiredStatus = getCustomerOrderGenerationStatus(sync, {
        nowMs: LOCAL_SLOW + 31_000,
        timeAuthority: expiredAuthority,
      });
      assert.equal(expiredStatus.nowMs, LOCAL_SLOW + 31_000);
      assert.equal(expiredStatus.cooldownActive, true);
      await refreshCustomerOrders(ws, "token", sync, "expiredCustomerGeneration", {
        nowMs: LOCAL_SLOW + 31_000,
        timeAuthority: expiredAuthority,
        flowerNames: {},
      });
      assert.deepEqual(calls, []);
    });
  });
});

test("trusted corrected time controls resident cooldown and palace double-gold submission boundary", () => {
  const sync = {
    $usrTot: {
      data: {
        bag: {
          23001: 10,
          300101: 1,
          300102: 1,
        },
      },
      cntMap: {
        109: { tdyCnt: 120, rTime: new Date(SERVER_NOW).toISOString() },
        116: { tdyCnt: 120, rTime: new Date(SERVER_NOW).toISOString() },
      },
    },
    videoDouble: {
      eTime: new Date(SERVER_NOW + 90_000).toISOString(),
    },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: {
          flowers: [[23001, 1]],
          isVideo: 0,
          cdTime: new Date(SERVER_NOW + 30_000).toISOString(),
        },
        orderDecorate: {
          flowers: [[23001, 1]],
          isVideo: 0,
          cdTime: new Date(SERVER_NOW + 30_000).toISOString(),
        },
        orderMap: {
          1: {
            boxId: 1,
            flowers: [[23001, 1]],
            isVideo: 0,
            cdTime: new Date(SERVER_NOW + 30_000).toISOString(),
          },
        },
      },
    },
    orderPalaceTot: {
      orderPalace: {
        flowerId: 23001,
        num: 1,
        isFinish: false,
      },
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: {
          8: { artId: 300101, num: 1 },
        },
        visitNpcIds: [9],
      },
    },
  };
  const flowerArtConfig = {
    arts: {
      300101: customerArt(300101, 2),
    },
  };
  const trustedAuthority = acceptedAuthority(LOCAL_FAST);
  const trustedNowMs = getResourceActionNowMs(sync, {
    nowMs: LOCAL_FAST,
    timeAuthority: trustedAuthority,
  });
  assert.equal(trustedNowMs, SERVER_NOW);

  const trustedFlower = summarizeOrderFlowerStatus(sync, { nowMs: trustedNowMs });
  assert.equal(trustedFlower.satin.status, "cooldown");
  assert.equal(trustedFlower.decorate.status, "cooldown");
  assert.equal(trustedFlower.ordinary.orders[0].status, "cooldown");
  assert.deepEqual(
    getAutoSubmitOrderActions(trustedFlower, { autoSubmitEnabled: true }),
    [],
  );

  const fastLocalFlower = summarizeOrderFlowerStatus(sync, { nowMs: LOCAL_FAST });
  assert.equal(fastLocalFlower.satin.status, "ready");
  assert.equal(fastLocalFlower.decorate.status, "ready");
  assert.equal(fastLocalFlower.ordinary.orders[0].status, "ready");

  const ordinaryActionSync = {
    ...sync,
    $usrTot: {
      ...sync.$usrTot,
      cntMap: {
        109: { tdyCnt: 121, rTime: new Date(SERVER_NOW).toISOString() },
        116: { tdyCnt: 121, rTime: new Date(SERVER_NOW).toISOString() },
      },
    },
  };
  const ordinaryTrusted = summarizeOrderFlowerStatus(ordinaryActionSync, { nowMs: trustedNowMs });
  assert.equal(ordinaryTrusted.ordinary.orders[0].status, "cooldown");
  assert.deepEqual(getAutoSubmitOrderActions(ordinaryTrusted, { autoSubmitEnabled: true }), []);
  const ordinaryFast = summarizeOrderFlowerStatus(ordinaryActionSync, { nowMs: LOCAL_FAST });
  assert.equal(ordinaryFast.ordinary.orders[0].status, "ready");
  assert.deepEqual(
    getAutoSubmitOrderActions(ordinaryFast, { autoSubmitEnabled: true }).map((action) => action.boxId),
    [1],
  );

  const trustedPalace = summarizeOrderPalaceStatus(sync, { nowMs: trustedNowMs });
  assert.equal(trustedPalace.doubleGoldGate.remainingMs, 90_000);
  assert.equal(trustedPalace.canFinish, true);
  assert.equal(getAutoSubmitPalaceOrderActions(trustedPalace).length, 1);

  const fastLocalPalace = summarizeOrderPalaceStatus(sync, { nowMs: LOCAL_FAST });
  assert.equal(fastLocalPalace.doubleGoldGate.remainingMs, 30_000);
  assert.equal(fastLocalPalace.status, "waiting-double-gold");
  assert.deepEqual(getAutoSubmitPalaceOrderActions(fastLocalPalace), []);

  const trustedCustomer = summarizeOrderCustomerStatus(sync, {
    nowMs: trustedNowMs,
    flowerArtConfig,
  });
  assert.equal(trustedCustomer.doubleGoldGate.remainingMs, 90_000);
  const trustedCustomerActions = getAutoSubmitCustomerOrderActions(trustedCustomer);
  assert.deepEqual(
    trustedCustomer.orders.map((order) => order.npcId),
    [8],
  );
  assert.deepEqual(
    trustedCustomerActions.map((action) => action.npcId),
    [8],
  );

  const fastLocalCustomer = summarizeOrderCustomerStatus(sync, {
    nowMs: LOCAL_FAST,
    flowerArtConfig,
  });
  assert.equal(fastLocalCustomer.doubleGoldGate.remainingMs, 30_000);
  assert.deepEqual(
    getAutoSubmitCustomerOrderActions(fastLocalCustomer).map((action) => action.npcId),
    [8],
  );
});

test("missing or expired time authority falls back locally and never submits palace early", () => {
  const sync = {
    $usrTot: { data: { bag: { 23001: 1 } } },
    videoDouble: { eTime: new Date(SERVER_NOW + 90_000).toISOString() },
    orderPalaceTot: {
      orderPalace: { flowerId: 23001, num: 1, isFinish: false },
    },
  };

  const missingNowMs = getResourceActionNowMs(sync, { nowMs: LOCAL_FAST });
  assert.equal(missingNowMs, LOCAL_FAST);
  const missingStatus = summarizeOrderPalaceStatus(sync, { nowMs: missingNowMs });
  assert.equal(missingStatus.status, "waiting-double-gold");
  assert.deepEqual(getAutoSubmitPalaceOrderActions(missingStatus), []);

  const expiredAuthority = acceptedAuthority(LOCAL_FAST, SERVER_NOW, 30_000);
  const expiredNowMs = getResourceActionNowMs(sync, {
    nowMs: LOCAL_FAST + 31_000,
    timeAuthority: expiredAuthority,
  });
  assert.equal(expiredNowMs, LOCAL_FAST + 31_000);
  const expiredStatus = summarizeOrderPalaceStatus(sync, { nowMs: expiredNowMs });
  assert.equal(expiredStatus.status, "waiting-double-gold");
  assert.deepEqual(getAutoSubmitPalaceOrderActions(expiredStatus), []);
});

test("customer generation uses a legal local fallback when no time authority exists", async () => {
  const nowMs = SERVER_NOW;
  const sync = {
    $usrTot: {
      cntMap: {
        107: { type: 107, tdyCnt: 0 },
      },
    },
    orderCustomerTot: {
      orderCustomer: {
        nextGenTime: new Date(nowMs - 2_000).toISOString(),
        guestNpcIdList: [8],
        orderMap: {},
      },
    },
  };
  const calls = [];
  const ws = {
    async request(iface, args) {
      calls.push({ iface, args });
      return {
        v: {
          $other: { ms: nowMs },
          orderCustomerTot: {
            orderCustomer: {
              nextGenTime: new Date(nowMs + 30_000).toISOString(),
              orderMap: {},
            },
          },
        },
      };
    },
  };

  const result = await refreshCustomerOrders(ws, "token", sync, "localFallbackCustomerGeneration", {
    nowMs,
    timeAuthorityNowFn: () => nowMs,
    flowerNames: {},
    orderCustomerNpcConfig: T3_CUSTOMER_NPC_CONFIG,
    flowerArtConfig: T3_FLOWER_ART_CONFIG,
    returnGenerationResult: true,
  });

  assert.deepEqual(calls.map((call) => call.iface), ["gs.orderCustomer.genOrder"]);
  assert.equal(result.attempted, true);
  assert.equal(result.syncValue.$timeAuthority.clockSource, "server-hard-sync");
});

test("customer genOrder hard-sync samples raw local time instead of corrected actionTime", async () => {
  const localNowMs = LOCAL_SLOW;
  const serverResponseMs = SERVER_NOW + 1_000;
  const existingAuthority = acceptedAuthority(localNowMs, SERVER_NOW);
  const sync = {
    $usrTot: {
      cntMap: {
        107: { type: 107, tdyCnt: 0 },
      },
    },
    $timeAuthority: existingAuthority,
    orderCustomerTot: {
      orderCustomer: {
        nextGenTime: new Date(SERVER_NOW - 2_000).toISOString(),
        guestNpcIdList: [8],
        orderMap: {},
      },
    },
  };
  const previousDateNow = Date.now;
  Date.now = () => localNowMs;
  try {
    const ws = {
      async request(iface) {
        assert.equal(iface, "gs.orderCustomer.genOrder");
        return {
          v: {
            $other: { ms: serverResponseMs },
            orderCustomerTot: {
              orderCustomer: {
                nextGenTime: new Date(SERVER_NOW + 30_000).toISOString(),
                orderMap: {},
              },
            },
          },
        };
      },
    };

    const result = await refreshCustomerOrders(ws, "token", sync, "rawLocalHardSync", {
      nowMs: localNowMs,
      nowFn: () => SERVER_NOW,
      timeAuthority: existingAuthority,
      flowerNames: {},
      orderCustomerNpcConfig: T3_CUSTOMER_NPC_CONFIG,
      flowerArtConfig: T3_FLOWER_ART_CONFIG,
      timeAuthorityMaxAgeMs: 300_000,
      returnGenerationResult: true,
    });
    const hardSync = result.syncValue.$timeAuthority;
    const laterLocalNowMs = localNowMs + 1_000;
    const later = getTimeAuthoritySnapshot(hardSync, {
      nowMs: laterLocalNowMs,
      maxAgeMs: 300_000,
    });

    assert.equal(hardSync.clockSource, "server-hard-sync");
    assert.equal(hardSync.lastAcceptedSample.requestStartedAtMs, localNowMs);
    assert.equal(hardSync.lastAcceptedSample.responseAtMs, localNowMs);
    assert.equal(later.correctedNowMs, serverResponseMs + 1_000);
    assert.equal(later.correctedNowMs - laterLocalNowMs, serverResponseMs - localNowMs);
  } finally {
    Date.now = previousDateNow;
  }
});

test("customer generation preserves an injected actionTime through the order decision chain", () => {
  const sync = {
    orderCustomerTot: {
      orderCustomer: {
        nextGenTime: new Date(SERVER_NOW - 2_000).toISOString(),
        guestNpcIdList: [8],
        orderMap: {},
      },
    },
  };
  const actionTime = {
    localNowMs: LOCAL_SLOW,
    nowMs: SERVER_NOW,
    timeTrusted: true,
    clockSource: "server-hard-sync",
    timeAuthority: null,
  };
  const status = getCustomerOrderGenerationStatus(sync, {
    nowMs: LOCAL_SLOW,
    actionTime,
  });

  assert.equal(status.nowMs, SERVER_NOW);
  assert.equal(status.localNowMs, LOCAL_SLOW);
  assert.equal(status.clockSource, "server-hard-sync");
});

test("customer generation adopts a valid nextGenTime returned by the response", async () => {
  const nowMs = SERVER_NOW;
  const nextGenTime = new Date(nowMs - 2_000).toISOString();
  const sync = {
    $usrTot: {
      cntMap: {
        107: { type: 107, tdyCnt: 0 },
      },
    },
    orderCustomerTot: {
      orderCustomer: {
        nextGenTime,
        guestNpcIdList: [8],
        orderMap: {},
      },
    },
  };
  const scheduler = createCustomerOrderScheduler({ nowFn: () => nowMs });
  const ws = {
    async request() {
      return {
        v: {
          orderCustomerTot: {
            orderCustomer: {
              nextGenTime,
              orderMap: {},
            },
          },
        },
      };
    },
  };

  await refreshCustomerOrders(ws, "token", sync, "responseNextGenTime", {
    nowMs,
    flowerNames: {},
    orderCustomerNpcConfig: T3_CUSTOMER_NPC_CONFIG,
    flowerArtConfig: T3_FLOWER_ART_CONFIG,
    customerOrderScheduler: scheduler,
  });

  assert.equal(scheduler.snapshot().nextGenTimeMs, Date.parse(nextGenTime));
  assert.equal(scheduler.snapshot().awaitingNextGenTime, false);
});

test("customer generation keeps the local fallback cooldown and fails closed for invalid times", async () => {
  const nowMs = SERVER_NOW;
  const baseSync = {
    $usrTot: {
      cntMap: {
        107: { type: 107, tdyCnt: 0 },
      },
    },
    orderCustomerTot: {
      orderCustomer: {
        nextGenTime: new Date(nowMs).toISOString(),
        guestNpcIdList: [8],
        orderMap: {},
      },
    },
  };
  const calls = [];
  const ws = {
    async request(iface, args) {
      calls.push({ iface, args });
      return { v: {} };
    },
  };
  const coolingStatus = getCustomerOrderGenerationStatus(baseSync, { nowMs });
  assert.equal(coolingStatus.clockSource, "local-fallback");
  assert.equal(coolingStatus.cooldownActive, true);
  const cooling = await refreshCustomerOrders(ws, "token", baseSync, "localFallbackCooldown", {
    nowMs,
    flowerNames: {},
    orderCustomerNpcConfig: T3_CUSTOMER_NPC_CONFIG,
    flowerArtConfig: T3_FLOWER_ART_CONFIG,
    returnGenerationResult: true,
  });
  assert.equal(cooling.reason, "next-generation-cooldown");
  assert.deepEqual(calls, []);

  const invalidClock = await refreshCustomerOrders(ws, "token", {
    ...baseSync,
    orderCustomerTot: {
      orderCustomer: {
        ...baseSync.orderCustomerTot.orderCustomer,
        nextGenTime: new Date(nowMs - 2_000).toISOString(),
      },
    },
  }, "invalidLocalClock", {
    nowMs: Number.NaN,
    timeAuthorityNowFn: () => Number.NaN,
    flowerNames: {},
    orderCustomerNpcConfig: T3_CUSTOMER_NPC_CONFIG,
    flowerArtConfig: T3_FLOWER_ART_CONFIG,
    returnGenerationResult: true,
  });
  assert.equal(invalidClock.reason, "invalid-clock");
  assert.deepEqual(calls, []);

  const invalidNext = await refreshCustomerOrders(ws, "token", {
    ...baseSync,
    orderCustomerTot: {
      orderCustomer: {
        ...baseSync.orderCustomerTot.orderCustomer,
        nextGenTime: "not-a-time",
      },
    },
  }, "invalidNextGenTime", {
    nowMs,
    flowerNames: {},
    orderCustomerNpcConfig: T3_CUSTOMER_NPC_CONFIG,
    flowerArtConfig: T3_FLOWER_ART_CONFIG,
    returnGenerationResult: true,
  });
  assert.equal(invalidNext.reason, "next-generation-time-invalid");
  assert.deepEqual(calls, []);
});

test("an expired accepted sample falls back to local time instead of blocking a due generation", async () => {
  const localNowMs = LOCAL_FAST + 31_000;
  const sync = {
    $usrTot: {
      cntMap: {
        107: { type: 107, tdyCnt: 0 },
      },
    },
    orderCustomerTot: {
      orderCustomer: {
        nextGenTime: new Date(LOCAL_FAST + 28_000).toISOString(),
        guestNpcIdList: [8],
        orderMap: {},
      },
    },
  };
  const expiredAuthority = acceptedAuthority(LOCAL_FAST, SERVER_NOW, 30_000);
  const calls = [];
  const ws = {
    async request(iface) {
      calls.push(iface);
      return { v: {} };
    },
  };

  const result = await refreshCustomerOrders(ws, "token", sync, "expiredDueCustomerGeneration", {
    nowMs: localNowMs,
    timeAuthority: expiredAuthority,
    flowerNames: {},
    orderCustomerNpcConfig: T3_CUSTOMER_NPC_CONFIG,
    flowerArtConfig: T3_FLOWER_ART_CONFIG,
    returnGenerationResult: true,
  });

  assert.equal(getCustomerOrderGenerationStatus(sync, {
    nowMs: localNowMs,
    timeAuthority: expiredAuthority,
  }).clockSource, "local-fallback");
  assert.deepEqual(calls, ["gs.orderCustomer.genOrder"]);
  assert.equal(result.attempted, true);
});
