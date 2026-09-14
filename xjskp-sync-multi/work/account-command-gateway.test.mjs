import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createAccountCommandGateway,
  isAccountCommandGateway,
} from "./account-command-gateway.mjs";
import { estimateExperienceAction } from "./experience-settlement.mjs";
import {
  isRequestRateLimitedError,
} from "./rate-limit-guard.mjs";
import {
  createExperienceGuardRearmRequest,
  createExperienceGuardSettlementRecoveryRequest,
  createPersistentExperienceLevelGuard,
} from "./experience-guard-state.mjs";

function createGateway(transport, options = {}) {
  const syncRef = options.syncRef || { current: { marker: options.marker || "initial" } };
  const contextRef = options.contextRef || { cycle: 1 };
  return createAccountCommandGateway({
    transport,
    token: options.token || "test-token",
    syncRef,
    contextRef,
    runAtRequestBoundary: options.runAtRequestBoundary
      || (async (_context, operation) => operation()),
    createExperienceClient: options.createExperienceClient
      || ((safeTransport) => safeTransport),
    ...options,
  });
}

function createHarvestExperienceConfig() {
  return {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map([
      ["2300101", { id: "2300101", harvestExp: 10 }],
      ["2310801", { id: "2310801", harvestExp: 10 }],
    ]),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: { rewardBaseExperience: 8_000, orders: new Map() },
  };
}

test("gateway traces an explicit flower-order response without changing its return or merge", async () => {
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?flower-order-response-trace=${Date.now()}`,
  );
  const traces = [];
  const initial = {
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { finishCnt: 6, cTime: "old-satin", isVideo: 0 },
        orderDecorate: { finishCnt: 5, cTime: "old-decorate", isVideo: 1 },
      },
    },
  };
  const response = { v: {
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { finishCnt: 7, cTime: "new-satin", isVideo: 1 },
        orderDecorate: { finishCnt: 6, isVideo: 0 },
      },
    },
  } };
  const gateway = createAutomationAccountCommandGateway({
    async request() {
      return response;
    },
  }, "token", initial, {
    cycle: 42,
    getExperienceGuardThresholdPercent: () => 0,
    onFlowerOrderSyncTrace: (entry) => traces.push(entry),
  });

  const returned = await gateway.request("gs.usr.lazySync", {});

  assert.strictEqual(returned, response);
  assert.equal(gateway.getSyncValue().orderFlowerTot.orderFlower.orderSatin.finishCnt, 7);
  assert.equal(gateway.getSyncValue().orderFlowerTot.orderFlower.orderDecorate.finishCnt, 6);
  assert.deepEqual(traces, [{
    step: "flowerOrderResponseMergeTrace",
    iface: "gs.usr.lazySync",
    requestId: "exp-42-1",
    before: {
      present: true,
      satin: { present: true, finishCnt: 6, cTime: "old-satin", isVideo: 0, missing: [] },
      decorate: { present: true, finishCnt: 5, cTime: "old-decorate", isVideo: 1, missing: [] },
    },
    response: {
      present: true,
      satin: { present: true, finishCnt: 7, cTime: "new-satin", isVideo: 1, missing: [] },
      decorate: { present: true, finishCnt: 6, isVideo: 0, missing: ["cTime"] },
    },
    after: {
      present: true,
      satin: { present: true, finishCnt: 7, cTime: "new-satin", isVideo: 1, missing: [] },
      decorate: { present: true, finishCnt: 6, isVideo: 0, missing: ["cTime"] },
    },
  }]);
});

test("gateway does not trace a response that omits orderFlowerTot.orderFlower", async () => {
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?flower-order-response-omitted=${Date.now()}`,
  );
  const traces = [];
  const initial = {
    orderFlowerTot: {
      orderFlower: { orderSatin: { finishCnt: 6, cTime: "satin", isVideo: 0 } },
    },
  };
  const response = { v: { taskTot: { main: { curTaskId: 9 } } } };
  const gateway = createAutomationAccountCommandGateway({
    async request() {
      return response;
    },
  }, "token", initial, {
    getExperienceGuardThresholdPercent: () => 0,
    onFlowerOrderSyncTrace: (entry) => traces.push(entry),
  });

  const returned = await gateway.request("gs.usr.lazySync", {});

  assert.strictEqual(returned, response);
  assert.equal(gateway.getSyncValue().orderFlowerTot.orderFlower.orderSatin.finishCnt, 6);
  assert.deepEqual(traces, []);
});

test("gateway ignores a flower-order trace callback failure", async () => {
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?flower-order-trace-failure=${Date.now()}`,
  );
  const response = { v: {
    orderFlowerTot: {
      orderFlower: { orderSatin: { finishCnt: 7, cTime: "new", isVideo: 1 } },
    },
  } };
  const gateway = createAutomationAccountCommandGateway({
    async request() {
      return response;
    },
  }, "token", {
    orderFlowerTot: {
      orderFlower: { orderSatin: { finishCnt: 6, cTime: "old", isVideo: 0 } },
    },
  }, {
    getExperienceGuardThresholdPercent: () => 0,
    onFlowerOrderSyncTrace() {
      throw new Error("trace sink unavailable");
    },
  });

  assert.strictEqual(await gateway.request("gs.usr.lazySync", {}), response);
  assert.equal(gateway.getSyncValue().orderFlowerTot.orderFlower.orderSatin.finishCnt, 7);
});

test("gateway traces observeSync flower-order changes without changing the assigned sync", () => {
  const traces = [];
  const syncRef = {
    current: {
      orderFlowerTot: {
        orderFlower: { orderSatin: { finishCnt: 6, cTime: "old", isVideo: 0 } },
      },
    },
  };
  const gateway = createGateway({
    async request() {
      return { v: {} };
    },
  }, {
    syncRef,
    onFlowerOrderSyncTrace: (entry) => traces.push(entry),
  });
  const next = {
    orderFlowerTot: {
      orderFlower: { orderSatin: { finishCnt: 7, cTime: "new", isVideo: 1 } },
    },
  };

  assert.strictEqual(gateway.observeSync(next, {
    cycle: 9,
    source: "test-authority",
    step: "lazySync",
  }), next);
  assert.strictEqual(gateway.getSyncValue(), next);
  assert.deepEqual(traces, [{
    step: "flowerOrderObserveSyncTrace",
    context: { cycle: 9, source: "test-authority", step: "lazySync" },
    before: {
      present: true,
      satin: { present: true, finishCnt: 6, cTime: "old", isVideo: 0, missing: [] },
      decorate: { present: false, missing: ["finishCnt", "cTime", "isVideo"] },
    },
    after: {
      present: true,
      satin: { present: true, finishCnt: 7, cTime: "new", isVideo: 1, missing: [] },
      decorate: { present: false, missing: ["finishCnt", "cTime", "isVideo"] },
    },
  }]);
});

test("automation gateway forwards its flower-order trace sink to observeSync", async () => {
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?flower-order-observe-sync-trace=${Date.now()}`,
  );
  const traces = [];
  const gateway = createAutomationAccountCommandGateway({
    async request() {
      return { v: {} };
    },
  }, "token", {
    orderFlowerTot: {
      orderFlower: { orderSatin: { finishCnt: 6, cTime: "old", isVideo: 0 } },
    },
  }, {
    cycle: 10,
    onFlowerOrderSyncTrace: (entry) => traces.push(entry),
  });

  gateway.observeSync({
    orderFlowerTot: {
      orderFlower: { orderSatin: { finishCnt: 7, cTime: "new", isVideo: 1 } },
    },
  }, {
    cycle: 11,
    source: "test-wrapper",
    step: "lazySync",
  });

  assert.equal(traces.length, 1);
  assert.equal(traces[0].step, "flowerOrderObserveSyncTrace");
  assert.deepEqual(traces[0].context, {
    cycle: 11,
    source: "test-wrapper",
    step: "lazySync",
  });
  assert.equal(traces[0].before.satin.finishCnt, 6);
  assert.equal(traces[0].after.satin.finishCnt, 7);
});

test("gateway rejects a resident-order send when lazySync changes the final authority snapshot", async () => {
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?resident-final-authority=${Date.now()}`,
  );
  const calls = [];
  const oldSatin = {
    flowers: [[23001, 1]], finishCnt: 1, isVideo: 0,
    cTime: "2026-09-01T18:50:00.000+08:00",
    cdTime: "2026-09-01T18:51:00.000+08:00",
  };
  const refreshedSatin = {
    flowers: [[23002, 2]], finishCnt: 2, isVideo: 0,
    cTime: "2026-09-01T18:52:00.000+08:00",
    cdTime: "2026-09-01T18:52:00.000+08:00",
  };
  const experienceConfig = {
    ...createHarvestExperienceConfig(),
    flowers: new Map([
      [23001, { id: 23001, experience: 10 }],
      [23002, { id: 23002, experience: 20 }],
    ]),
  };
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") return { v: {
        $usrTot: { data: { lvl: 19, lvlExp: 1, nextExp: 100_000, bag: { 23002: 2 } } },
        orderFlowerTot: { orderFlower: { orderSatin: refreshedSatin } },
      } };
      throw new Error(`unexpected send: ${iface}`);
    },
  }, "token", {
    $usrTot: { data: { lvl: 19, lvlExp: 1, nextExp: 100_000, bag: { 23001: 1 } } },
    orderFlowerTot: { orderFlower: { orderSatin: oldSatin } },
  }, {
    experienceConfig,
    getExperienceGuardThresholdPercent: () => 0,
  });

  await assert.rejects(
    gateway.request("gs.orderFlower.finishSatinOrder", {}, "token", {
      specialOrderExpectation: {
        kind: "satin",
        iface: "gs.orderFlower.finishSatinOrder",
        identity: JSON.stringify({
          requirements: [[23001, 1]], npcId: null, dialogId: null, finishCnt: 1,
          isVideo: 0, cTime: oldSatin.cTime, cdTime: oldSatin.cdTime,
        }),
        nowMs: Date.parse("2026-09-01T18:53:00.000+08:00"),
      },
    }),
    (error) => error?.code === "ACTION_AUTHORITY_REJECTED"
      && error?.authorityValidation?.reason === "resident-order-final-task-identity-changed",
  );
  assert.deepEqual(calls, ["gs.usr.lazySync"]);
  assert.deepEqual(
    gateway.getSyncValue().orderFlowerTot.orderFlower.orderSatin.flowers,
    [[23002, 2]],
  );
  assert.equal(estimateExperienceAction({
    iface: "gs.orderFlower.finishSatinOrder",
    arg: {},
    syncValue: gateway.getSyncValue(),
    config: experienceConfig,
  }).maxExp, 40);
});

test("gateway lets an authorized 49→50 crossing pass the final authority check when the resident order is unchanged and protection is released", async () => {
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?resident-crossing-released=${Date.now()}`,
  );
  const nowMs = Date.parse("2026-09-02T12:00:00.000+08:00");
  const rTime = "2026-09-02T10:00:00.000+08:00";
  const satin = {
    flowers: [[23001, 1]],
    finishCnt: 1,
    isVideo: 0,
    cTime: "2026-09-02T09:00:00.000+08:00",
    cdTime: "2026-09-02T09:05:00.000+08:00",
  };
  // Resident board total is 49: ordinary 0 + satin 23 + decorate 26.
  const base = {
    $usrTot: {
      data: { lvl: 19, lvlExp: 1, nextExp: 100_000, bag: { 23001: 5 } },
      cntMap: {
        105: { tdyCnt: 0, rTime },
        109: { tdyCnt: 24, rTime },
        116: { tdyCnt: 27, rTime },
      },
    },
    videoDouble: { eTime: "2026-09-02T20:00:00.000+08:00" },
    orderFlowerTot: { orderFlower: { orderSatin: satin } },
  };
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") {
        // The authoritative refresh returns the same unchanged resident order.
        return { v: { orderFlowerTot: { orderFlower: { orderSatin: satin } } } };
      }
      if (iface === "gs.orderFlower.finishSatinOrder") {
        return { v: { $usrTot: { data: { lvl: 19, lvlExp: 11, nextExp: 100_000 } } } };
      }
      throw new Error(`unexpected send: ${iface}`);
    },
  }, "token", base, {
    experienceConfig: {
      ...createHarvestExperienceConfig(),
      flowers: new Map([[23001, { id: 23001, experience: 10 }]]),
    },
    getExperienceGuardThresholdPercent: () => 0,
  });

  // Mirrors the real requestResidentOrderAction context: the release evidence
  // for an authorized crossing rides on teamTriggerDecision, and the plan-time
  // specialOrderExpectation carries only kind/iface/identity/nowMs.
  await gateway.request("gs.orderFlower.finishSatinOrder", {}, "token", {
    teamTriggerDecision: {
      blocked: false,
      coldStartBypass: false,
      reason: "historical-experience-space-available",
      teamOrderReservationId: "team-exp-test-crossing",
    },
    residentBoardTotalBefore: 49,
    residentBoardTotalAfter: 50,
    specialOrderExpectation: {
      kind: "satin",
      iface: "gs.orderFlower.finishSatinOrder",
      identity: JSON.stringify({
        requirements: [[23001, 1]], npcId: null, dialogId: null, finishCnt: 1,
        isVideo: 0, cTime: satin.cTime, cdTime: satin.cdTime,
      }),
      nowMs,
    },
  });

  assert.deepEqual(calls, ["gs.usr.lazySync", "gs.orderFlower.finishSatinOrder"]);
});

test("gateway still blocks an unreserved 49 crossing when no release evidence is attached to the request", async () => {
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?resident-crossing-unreleased=${Date.now()}`,
  );
  const nowMs = Date.parse("2026-09-02T12:00:00.000+08:00");
  const rTime = "2026-09-02T10:00:00.000+08:00";
  const satin = {
    flowers: [[23001, 1]],
    finishCnt: 1,
    isVideo: 0,
    cTime: "2026-09-02T09:00:00.000+08:00",
    cdTime: "2026-09-02T09:05:00.000+08:00",
  };
  const base = {
    $usrTot: {
      data: { lvl: 19, lvlExp: 1, nextExp: 100_000, bag: { 23001: 5 } },
      cntMap: {
        105: { tdyCnt: 0, rTime },
        109: { tdyCnt: 24, rTime },
        116: { tdyCnt: 27, rTime },
      },
    },
    videoDouble: { eTime: "2026-09-02T20:00:00.000+08:00" },
    orderFlowerTot: { orderFlower: { orderSatin: satin } },
  };
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") {
        return { v: { orderFlowerTot: { orderFlower: { orderSatin: satin } } } };
      }
      throw new Error(`unexpected send: ${iface}`);
    },
  }, "token", base, {
    experienceConfig: {
      ...createHarvestExperienceConfig(),
      flowers: new Map([[23001, { id: 23001, experience: 10 }]]),
    },
    getExperienceGuardThresholdPercent: () => 0,
  });

  await assert.rejects(
    gateway.request("gs.orderFlower.finishSatinOrder", {}, "token", {
      residentBoardTotalBefore: 49,
      residentBoardTotalAfter: 50,
      specialOrderExpectation: {
        kind: "satin",
        iface: "gs.orderFlower.finishSatinOrder",
        identity: JSON.stringify({
          requirements: [[23001, 1]], npcId: null, dialogId: null, finishCnt: 1,
          isVideo: 0, cTime: satin.cTime, cdTime: satin.cdTime,
        }),
        nowMs,
      },
    }),
    (error) => error?.code === "ACTION_AUTHORITY_REJECTED"
      && error?.authorityValidation?.reason === "resident-order-final-authority-unproven",
  );
  assert.deepEqual(calls, ["gs.usr.lazySync"]);
});

test("gateway validates ordinary resident orders after lazySync without a ReferenceError", async () => {
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?ordinary-final-authority=${Date.now()}`,
  );
  const order = {
    boxId: 8, flowers: [[23001, 1]], finishCnt: 3, isVideo: 0,
    cTime: "2026-09-01T18:50:00.000+08:00",
    cdTime: "2026-09-01T18:51:00.000+08:00",
  };
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") return { v: {} };
      if (iface === "gs.orderFlower.finishOrder") return { v: {} };
      throw new Error(`unexpected send: ${iface}`);
    },
  }, "token", {
    $usrTot: { data: { lvl: 19, lvlExp: 1, nextExp: 100_000, bag: { 23001: 1 } } },
    orderFlowerTot: { orderFlower: { orderMap: { 8: order } } },
  }, {
    experienceConfig: {
      ...createHarvestExperienceConfig(),
      flowers: new Map([[23001, { id: 23001, experience: 10 }]]),
    },
    getExperienceGuardThresholdPercent: () => 0,
  });

  await gateway.request("gs.orderFlower.finishOrder", { boxId: 8 }, "token", {
    ordinaryOrderExpectation: {
      boxId: 8,
      identity: JSON.stringify({
        boxId: 8, requirements: [[23001, 1]], finishCnt: 3, isVideo: 0,
        cTime: order.cTime, cdTime: order.cdTime,
      }),
      nowMs: Date.parse("2026-09-01T18:53:00.000+08:00"),
    },
  });
  assert.deepEqual(calls, ["gs.usr.lazySync", "gs.orderFlower.finishOrder"]);
});

test("gateway response projection retains completed order fields through a later response that omits orderFlower", async () => {
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?order-flower-central-projection=${Date.now()}`,
  );
  const calls = [];
  const completed = {
    orderSatin: { finishCnt: 53, flowers: [[23031, 1]], isVideo: 1 },
    orderDecorate: { finishCnt: 52, flowers: [[23041, 1]], isVideo: 1 },
    orderMap: {},
  };
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (calls.length === 1) return { v: { orderFlowerTot: { orderFlower: completed } } };
      if (calls.length === 2) return { v: { taskTot: { main: { curTaskId: 9 } } } };
      throw new Error(`unexpected request: ${iface}`);
    },
  }, "token", {
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { finishCnt: 52, flowers: [[23030, 1]], isVideo: 0 },
        orderDecorate: { finishCnt: 51, flowers: [[23040, 1]], isVideo: 0 },
        orderMap: { 8: { boxId: 8, npcId: 1008 } },
      },
    },
  }, {
    getExperienceGuardThresholdPercent: () => 0,
  });

  await gateway.request("gs.usr.lazySync", {});
  await gateway.request("gs.usr.lazySync", {});

  assert.deepEqual(calls, ["gs.usr.lazySync", "gs.usr.lazySync"]);
  assert.deepEqual(gateway.getSyncValue().orderFlowerTot.orderFlower, completed);
  assert.equal(gateway.getSyncValue().orderFlowerTot.orderFlower.orderSatin.finishCnt, 53);
  assert.equal(gateway.getSyncValue().orderFlowerTot.orderFlower.orderDecorate.finishCnt, 52);
});

test("gateway keeps the account-5 8/7 then 9/8 order snapshot across missing fields and never replans the old decorate finish", async () => {
  const [{ createAutomationAccountCommandGateway }, { getAutoSubmitOrderActions, summarizeOrderFlowerStatus }] = await Promise.all([
    import(`./inspect-garden-dryrun.mjs?account-5-order-flower-regression=${Date.now()}`),
    import("./order-state.mjs"),
  ]);
  const calls = [];
  const orderAt8And7 = {
    orderSatin: {
      flowers: [[23081, 1]], finishCnt: 8, isVideo: 1,
      cTime: "2026-09-01T18:00:00.000+08:00", cdTime: "2026-09-01T18:00:00.000+08:00",
    },
    orderDecorate: {
      flowers: [[23071, 1]], finishCnt: 7, isVideo: 1,
      cTime: "2026-09-01T18:00:00.000+08:00", cdTime: "2026-09-01T18:00:00.000+08:00",
    },
  };
  const orderAt9And8 = {
    orderSatin: { ...orderAt8And7.orderSatin, finishCnt: 9 },
    orderDecorate: { ...orderAt8And7.orderDecorate, finishCnt: 8 },
  };
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      switch (calls.length) {
        case 1: return { v: { orderFlowerTot: { orderFlower: orderAt8And7 } } };
        case 2: return { v: { taskTot: { main: { curTaskId: 5 } } } };
        case 3: return { v: { orderFlowerTot: { orderFlower: orderAt9And8 } } };
        case 4: return { v: { $usrTot: { data: { gld: 1 } } } };
        default: throw new Error(`unexpected request: ${iface}`);
      }
    },
  }, "token", {
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { ...orderAt8And7.orderSatin, finishCnt: 7, isVideo: 0 },
        orderDecorate: { ...orderAt8And7.orderDecorate, finishCnt: 6, isVideo: 0 },
      },
    },
  }, {
    getExperienceGuardThresholdPercent: () => 0,
  });

  await gateway.request("gs.usr.lazySync", {});
  await gateway.request("gs.usr.lazySync", {});
  assert.equal(gateway.getSyncValue().orderFlowerTot.orderFlower.orderSatin.finishCnt, 8);
  assert.equal(gateway.getSyncValue().orderFlowerTot.orderFlower.orderDecorate.finishCnt, 7);

  await gateway.request("gs.usr.lazySync", {});
  await gateway.request("gs.usr.lazySync", {});
  const current = gateway.getSyncValue();
  assert.equal(current.orderFlowerTot.orderFlower.orderSatin.finishCnt, 9);
  assert.equal(current.orderFlowerTot.orderFlower.orderDecorate.finishCnt, 8);
  assert.equal(
    getAutoSubmitOrderActions(summarizeOrderFlowerStatus(current, {
      nowMs: Date.parse("2026-09-01T18:01:00.000+08:00"),
    })).some((action) => action.iface === "gs.orderFlower.finishDecorateOrder"),
    false,
  );
  assert.deepEqual(calls, [
    "gs.usr.lazySync",
    "gs.usr.lazySync",
    "gs.usr.lazySync",
    "gs.usr.lazySync",
  ]);
});

test("AccountCommandGateway serializes every account request and releases the queue after failure", async () => {
  let releaseFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => {
    firstStartedResolve = resolve;
  });
  const firstBlocked = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const gateway = createGateway({
    async request(_iface, args) {
      calls.push(args.id);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (args.id === 1) {
          firstStartedResolve();
          await firstBlocked;
          throw new Error("first request failed");
        }
        return { v: { id: args.id } };
      } finally {
        active -= 1;
      }
    },
  });

  const first = gateway.request("gs.usrLand.refresh", { id: 1 });
  await firstStarted;
  const second = gateway.request("gs.usrLand.refresh", { id: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [1]);

  releaseFirst();
  await assert.rejects(first, /first request failed/);
  await second;

  assert.deepEqual(calls, [1, 2]);
  assert.equal(maxActive, 1);
});

test("AccountCommandGateway applies the stop boundary before transport send", async () => {
  let transportCalls = 0;
  const stopped = new Error("user stopped");
  const gateway = createGateway(
    {
      async request() {
        transportCalls += 1;
        return { v: {} };
      },
    },
    {
      runAtRequestBoundary: async () => {
        throw stopped;
      },
    },
  );

  await assert.rejects(gateway.request("gs.usrLand.refresh", {}), (error) => error === stopped);
  assert.equal(transportCalls, 0);
});

test("AccountCommandGateway keeps account queues isolated", async () => {
  let releaseA;
  let startedAResolve;
  const startedA = new Promise((resolve) => {
    startedAResolve = resolve;
  });
  const blockedA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const gatewayA = createGateway({
    async request() {
      startedAResolve();
      await blockedA;
      return { v: { account: "A" } };
    },
  }, { marker: "A" });
  const gatewayB = createGateway({
    async request() {
      return { v: { account: "B" } };
    },
  }, { marker: "B" });

  const requestA = gatewayA.request("gs.usrLand.refresh", {});
  await startedA;
  const responseB = await gatewayB.request("gs.usrLand.refresh", {});
  assert.equal(responseB.v.account, "B");
  assert.equal(gatewayA.getSyncValue().marker, "A");
  assert.equal(gatewayB.getSyncValue().marker, "B");

  releaseA();
  await requestA;
});

test("AccountCommandGateway rebinds transport and token without exposing raw transport", async () => {
  const calls = [];
  const gateway = createGateway({
    async request(_iface, _args, token) {
      calls.push(["old", token]);
      return { v: {} };
    },
    close() {},
  }, { token: "old-token" });

  await gateway.request("gs.usrLand.refresh", {});
  await gateway.replaceTransport({
    async request(_iface, _args, token) {
      calls.push(["new", token]);
      return { v: {} };
    },
    close() {},
  }, {
    token: "new-token",
    syncValue: { marker: "reconnected" },
  });
  await gateway.request("gs.usrLand.refresh", {});

  assert.deepEqual(calls, [
    ["old", "old-token"],
    ["new", "new-token"],
  ]);
  assert.equal(gateway.getSyncValue().marker, "reconnected");
  assert.equal(isAccountCommandGateway(gateway), true);
  assert.equal("transport" in gateway, false);
  assert.equal("ws" in gateway, false);
  assert.equal("rawWs" in gateway, false);
});

test("AccountCommandGateway creates its experience client once and shares its state across contexts", async () => {
  let created = 0;
  const seen = [];
  const contextRef = { cycle: 1 };
  const gateway = createGateway(
    {
      async request(iface) {
        seen.push([iface, contextRef.cycle]);
        return { v: {} };
      },
    },
    {
      contextRef,
      createExperienceClient(safeTransport, _token, syncRef, sharedContext) {
        created += 1;
        let requestCount = 0;
        return {
          async request(iface, args, token, requestContext) {
            requestCount += 1;
            syncRef.current = { ...syncRef.current, requestCount };
            return safeTransport.request(iface, args, token, requestContext);
          },
        };
      },
    },
  );

  await gateway.request("gs.usrLand.refresh", {});
  gateway.observeSync({ marker: "wait" }, { cycle: 2 });
  await gateway.request("gs.usr.heartTick", {});

  assert.equal(created, 1);
  assert.deepEqual(seen, [
    ["gs.usrLand.refresh", 1],
    ["gs.usr.heartTick", 2],
  ]);
  assert.equal(gateway.getSyncValue().requestCount, 2);
});

test("automation session shares one AccountCommandGateway across cycle, wait, team binding, and reconnect", () => {
  const source = fs.readFileSync(
    path.join("work", "inspect-garden-dryrun.mjs"),
    "utf8",
  );
  const cycleSource = source.slice(
    source.indexOf("async function runGardenCycle("),
    source.indexOf("async function openGameWsSession("),
  );
  const waitSource = source.slice(
    source.indexOf("async function waitWithOnlineHeartTick("),
    source.indexOf("function getCustomerOrderGenerationDuringWaitRetryIntervalMs("),
  );
  const cycleCallStart = source.indexOf("syncValue = await runGardenCycle(");
  const cycleCallEnd = source.indexOf("        } catch (err) {", cycleCallStart);
  assert.ok(cycleCallStart >= 0);
  assert.ok(cycleCallEnd > cycleCallStart);
  const cycleCallSource = source.slice(cycleCallStart, cycleCallEnd);

  assert.match(
    source,
    /ws = createAutomationAccountCommandGateway\(ws, gsToken, syncValue, options\);/,
  );
  assert.match(source, /startupExperienceLevelGuard = createAutomationExperienceLevelGuard\(options\)/);
  assert.match(source, /startupPendingRearmRequestId = startupExperienceLevelGuard/);
  assert.match(source, /initialAuthorityEligibleRearmRequestId/);
  assert.match(source, /\{ returnEvidence: true \}/);
  assert.match(
    cycleCallSource,
    /runGardenCycle\(\s*ws,\s*gsToken,\s*syncValue,\s*cycle,\s*\{[\s\S]*\bteamOrderRuntime\b[\s\S]*\baccountScheduler\b[\s\S]*\}\s*\)/,
  );
  assert.match(
    source,
    /waitWithOnlineHeartTick\(ws, gsToken, syncValue, sleepSeconds \* 1000/,
  );
  assert.match(source, /runtime\.bind\(ws, gsToken\);/);
  assert.match(source, /await ws\.replaceTransport\(reopened\.ws/);
  assert.doesNotMatch(cycleSource, /createExperienceGuardedWs\(/);
  assert.doesNotMatch(waitSource, /createExperienceGuardedWs\(/);
});

test("persistent level breach is durable before the reward resolves and blocks later experience actions", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-level-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?persistent-level-guard=${Date.now()}`
  );
  const calls = [];
  const transport = {
    async request(iface, args) {
      calls.push([iface, args?.landId ?? null]);
      if (iface === "gs.usr.lazySync") {
        return { v: { $usrTot: { data: { lvl: 19, lvlExp: 79_290, nextExp: 81_400 } } } };
      }
      if (iface === "gs.usrLand.harvest") {
        return { v: { $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } } } };
      }
      return { v: {} };
    },
  };
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map([["2310801", { id: "2310801", harvestExp: 10 }]]),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: { rewardBaseExperience: 8_000, orders: new Map() },
  };
  const sync = {
    $usrTot: { data: { lvl: 19, lvlExp: 79_290, nextExp: 81_400 } },
    usrLandTot: {
      usrLand: {
        landMap: {
          1001: { flowerId: 23108, state: 3 },
          1002: { flowerId: 23108, state: 3 },
        },
      },
    },
    cultivateTot: { cultivateMap: { 23108: { flowerId: 23108, lvl: 1 } } },
  };
  const gateway = createAutomationAccountCommandGateway(transport, "token", sync, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    experienceConfig,
    getExperienceGuardThresholdPercent: () => 2,
  });

  await gateway.request("gs.usrLand.harvest", { landId: 1001 });
  assert.equal(levelGuard.getState().breached, true);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).breached, true);
  await assert.rejects(
    gateway.request("gs.usrLand.harvest", { landId: 1002 }),
    (error) => (
      error?.reason === "experience-action-blocked"
      && error?.experienceGuard?.reason === "experience-level-ceiling-breached"
    ),
  );
  await gateway.request("gs.usrLand.refresh", {});

  assert.equal(
    calls.filter(([iface]) => iface === "gs.usrLand.harvest").length,
    1,
  );
  assert.equal(calls.some(([iface]) => iface === "gs.usrLand.refresh"), true);
});

test("sticky level breach does not interrupt an already-started team-order flow", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-sticky-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const levelGuard = createPersistentExperienceLevelGuard({
    profileId: "main",
    statePath: path.join(dir, "main.json"),
  });
  levelGuard.observeAuthoritative({ level: 19, currentExp: 100, requiredExp: 1_000, enabled: true });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 2_000, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?sticky-level-guard=${Date.now()}`
  );
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      return { v: {} };
    },
  }, "token", {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 2_000 } },
    orderTeamTot: { orderTeam: { status: 3 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 2,
  });

  await gateway.request("gs.orderTeam.takeOrder", {});
  await gateway.request("gs.orderTeam.recvRwd", {});
  await gateway.request("gs.usrLand.refresh", {});
  assert.deepEqual(calls, [
    "gs.orderTeam.takeOrder",
    "gs.orderTeam.recvRwd",
    "gs.usrLand.refresh",
  ]);
});

test("external-session level-up is reported as a ceiling breach and never as refresh failure", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-external-level-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const levelGuard = createPersistentExperienceLevelGuard({
    profileId: "main",
    statePath: path.join(dir, "main.json"),
  });
  levelGuard.observeAuthoritative({ level: 19, currentExp: 79_000, requiredExp: 81_400, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?external-level-guard=${Date.now()}`
  );
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") {
        return { v: { $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } } } };
      }
      return { v: {} };
    },
  }, "token", {
    $usrTot: { data: { lvl: 19, lvlExp: 79_000, nextExp: 81_400 } },
    usrLandTot: { usrLand: { landMap: { 1001: { flowerId: 23108, state: 3 } } } },
    cultivateTot: { cultivateMap: { 23108: { flowerId: 23108, lvl: 1 } } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    experienceConfig: {
      compatible: true,
      reasons: [],
      monthCardExpAdd: 0,
      flowers: new Map(),
      flowerLevelExact: new Map([["2310801", { id: "2310801", harvestExp: 10 }]]),
      flowerLevelCfg: new Map(),
      flowerArts: new Map(),
      mainTasks: new Map(),
      cyclicNotes: new Map(),
      flowerAdvanceSkillById: new Map(),
      teamOrder: { rewardBaseExperience: 8_000, orders: new Map() },
    },
    getExperienceGuardThresholdPercent: () => 2,
  });

  await assert.rejects(
    gateway.request("gs.usrLand.harvest", { landId: 1001 }),
    (error) => (
      error?.experienceGuard?.reason === "experience-level-ceiling-breached"
      && error?.experienceGuard?.reason !== "experience-guard-refresh-failed"
    ),
  );
  assert.deepEqual(calls, ["gs.usr.lazySync"]);
});

test("active team reward bypasses an external-session level-up guard", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-team-authority-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const levelGuard = createPersistentExperienceLevelGuard({
    profileId: "main",
    statePath: path.join(dir, "main.json"),
  });
  levelGuard.observeAuthoritative({ level: 19, currentExp: 79_000, requiredExp: 81_400, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?team-external-level-guard=${Date.now()}`
  );
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") {
        return { v: { $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } } } };
      }
      return { v: {} };
    },
  }, "token", {
    $usrTot: { data: { lvl: 19, lvlExp: 79_000, nextExp: 81_400 } },
    orderTeamTot: { orderTeam: { status: 3, orderNum: 160 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 2,
  });

  await gateway.request("gs.orderTeam.recvRwd", {});
  assert.deepEqual(calls, ["gs.orderTeam.recvRwd"]);
});

test("a successful post-request authority no-change response consumes pending rearm from cached authority", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-empty-authority-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({ level: 19, currentExp: 79_000, requiredExp: 81_400, enabled: true });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?empty-authority-rearm=${Date.now()}`
  );
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      assert.equal(iface, "gs.usr.heartTick");
      return { v: {} };
    },
  }, "token", {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 2,
  });
  createExperienceGuardRearmRequest({
    profileId: "main",
    statePath,
    expectedStateRevision: levelGuard.getState().stateRevision,
    confirmed: true,
    requestId: "rearm-empty-authority",
  });

  await gateway.request("gs.usr.heartTick", {});
  assert.equal(levelGuard.getDecision({ enabled: true }).blocked, false);
  assert.equal(levelGuard.getPendingRearm(), null);
});

test("an empty non-authority response cannot consume pending rearm", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-non-authority-rearm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({ level: 19, currentExp: 79_000, requiredExp: 81_400, enabled: true });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?non-authority-rearm=${Date.now()}`
  );
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      assert.equal(iface, "gs.usrLand.refresh");
      return { v: {} };
    },
  }, "token", {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 2,
  });
  createExperienceGuardRearmRequest({
    profileId: "main",
    statePath,
    expectedStateRevision: levelGuard.getState().stateRevision,
    confirmed: true,
    requestId: "rearm-non-authority",
  });

  await gateway.request("gs.usrLand.refresh", {});
  assert.equal(levelGuard.getDecision({ enabled: true }).blocked, true);
  assert.equal(levelGuard.getPendingRearm().requestId, "rearm-non-authority");
});

test("authority request already in flight before rearm cannot consume the new control request", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-inflight-rearm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({ level: 19, currentExp: 79_000, requiredExp: 81_400, enabled: true });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?inflight-authority-rearm=${Date.now()}`
  );
  let resolveFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => {
    firstStartedResolve = resolve;
  });
  const firstResponse = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  let requestCount = 0;
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      assert.equal(iface, "gs.usr.heartTick");
      requestCount += 1;
      if (requestCount === 1) {
        firstStartedResolve();
        return firstResponse;
      }
      return { v: { $usrTot: { data: { lvl: 20, lvlExp: 3, nextExp: 100_000 } } } };
    },
  }, "token", {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 2,
  });

  const oldAuthority = gateway.request("gs.usr.heartTick", {});
  await firstStarted;
  createExperienceGuardRearmRequest({
    profileId: "main",
    statePath,
    expectedStateRevision: levelGuard.getState().stateRevision,
    confirmed: true,
    requestId: "rearm-after-request-start",
  });
  resolveFirst({ v: { $usrTot: { data: { lvl: 20, lvlExp: 2, nextExp: 100_000 } } } });
  await oldAuthority;
  assert.equal(levelGuard.getDecision({ enabled: true }).blocked, true);
  assert.equal(levelGuard.getPendingRearm().requestId, "rearm-after-request-start");

  await gateway.request("gs.usr.heartTick", {});
  assert.equal(levelGuard.getDecision({ enabled: true }).blocked, false);
  assert.equal(levelGuard.getPendingRearm(), null);
});

test("reward response cannot resolve when durable breach write fails and restart stays fail-closed", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-write-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  let failMainStateWrites = false;
  const guardedFs = {
    ...fs,
    renameSync(source, destination) {
      if (failMainStateWrites && path.resolve(destination) === path.resolve(statePath)) {
        const error = new Error("controlled disk full");
        error.code = "ENOSPC";
        throw error;
      }
      return fs.renameSync(source, destination);
    },
  };
  const levelGuard = createPersistentExperienceLevelGuard({
    profileId: "main",
    statePath,
    fileSystem: guardedFs,
  });
  levelGuard.observeAuthoritative({ level: 19, currentExp: 79_000, requiredExp: 81_400, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?durable-write-failure=${Date.now()}`
  );
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") {
        return { v: { $usrTot: { data: { lvl: 19, lvlExp: 79_000, nextExp: 81_400 } } } };
      }
      if (iface === "gs.usrLand.harvest") {
        failMainStateWrites = true;
        return { v: { $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } } } };
      }
      return { v: {} };
    },
  }, "token", {
    $usrTot: { data: { lvl: 19, lvlExp: 79_000, nextExp: 81_400 } },
    usrLandTot: { usrLand: { landMap: { 1001: { flowerId: 23108, state: 3 } } } },
    cultivateTot: { cultivateMap: { 23108: { flowerId: 23108, lvl: 1 } } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    experienceConfig: {
      compatible: true,
      reasons: [],
      monthCardExpAdd: 0,
      flowers: new Map(),
      flowerLevelExact: new Map([["2310801", { id: "2310801", harvestExp: 10 }]]),
      flowerLevelCfg: new Map(),
      flowerArts: new Map(),
      mainTasks: new Map(),
      cyclicNotes: new Map(),
      flowerAdvanceSkillById: new Map(),
      teamOrder: { rewardBaseExperience: 8_000, orders: new Map() },
    },
    getExperienceGuardThresholdPercent: () => 2,
  });

  await assert.rejects(
    gateway.request("gs.usrLand.harvest", { landId: 1001 }),
    (error) => (
      error?.automationClassification?.category === "local-error"
      && /experience-guard-state-write-failed|experience-guard-settlement-unresolved/.test(
        error?.message || "",
      )
    ),
  );
  assert.deepEqual(calls, ["gs.usr.lazySync", "gs.usrLand.harvest"]);
  assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).breached, false);
  assert.equal(fs.existsSync(`${statePath}.settlement-pending.json`), true);

  const restarted = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  assert.equal(restarted.getDecision({ enabled: true }).blocked, true);
  assert.equal(restarted.getDecision({ enabled: true }).reason, "experience-guard-settlement-unresolved");
});

test("an active team reward bypasses explicit rearm and does not interrupt the flow", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-rearm-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({
    level: 19,
    currentExp: 79_000,
    requiredExp: 81_400,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  levelGuard.observeAuthoritative({
    level: 20,
    currentExp: 1,
    requiredExp: 100_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?protected-rearm-recovery=${Date.now()}`
  );
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") {
        return { v: {} };
      }
      return { v: {} };
    },
  }, "token", {
    $loginServerIdx: 1,
    $usrTot: { data: { id: "account-a", lvl: 20, lvlExp: 1, nextExp: 100_000 } },
    orderTeamTot: { orderTeam: { status: 3, orderNum: 160 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 2,
  });
  createExperienceGuardRearmRequest({
    profileId: "main",
    statePath,
    expectedStateRevision: levelGuard.getState().stateRevision,
    confirmed: true,
    requestId: "rearm-via-protected-request",
  });

  await gateway.request("gs.orderTeam.recvRwd", {});

  assert.deepEqual(calls, ["gs.orderTeam.recvRwd"]);
  assert.equal(levelGuard.getDecision({ enabled: true }).blocked, true);
  assert.equal(levelGuard.getState().lastAppliedRearmRequestId ?? null, null);
  assert.equal(levelGuard.getPendingRearm().requestId, "rearm-via-protected-request");
});

test("startup authority evidence applies an already pending rearm before the gateway becomes usable", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-startup-rearm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({
    level: 19,
    currentExp: 79_000,
    requiredExp: 81_400,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  levelGuard.observeAuthoritative({
    level: 20,
    currentExp: 1,
    requiredExp: 100_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  const request = createExperienceGuardRearmRequest({
    profileId: "main",
    statePath,
    expectedStateRevision: levelGuard.getState().stateRevision,
    confirmed: true,
    requestId: "startup-pending-rearm",
  });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?startup-pending-rearm=${Date.now()}`
  );

  const gateway = createAutomationAccountCommandGateway({
    async request() {
      throw new Error("startup rearm must not need another request");
    },
  }, "token", {
    $loginServerIdx: 1,
    $usrTot: { data: { id: "account-a", lvl: 20, lvlExp: 2, nextExp: 100_000 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    initialAuthorityEligibleRearmRequestId: request.requestId,
    getExperienceGuardThresholdPercent: () => 2,
  });

  assert.equal(levelGuard.getDecision({ enabled: true }).blocked, false);
  assert.equal(levelGuard.getState().lastAppliedRearmRequestId, "startup-pending-rearm");
  assert.equal(levelGuard.getPendingRearm(), null);
  assert.equal(gateway.getSyncValue().$experienceGuardState.breached, false);
});

test("unexpected experience does not interrupt an already-started team-order command", async () => {
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?none-unexpected-pending=${Date.now()}`
  );
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usrLand.water") {
        return { v: { $usrTot: { data: { lvl: 20, lvlExp: 2, nextExp: 100_000 } } } };
      }
      return { v: {} };
    },
  }, "token", {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
  }, {
    profileId: "main",
    getExperienceGuardThresholdPercent: () => 2,
  });

  await gateway.request("gs.usrLand.water", { landId: 1001 });
  await gateway.request("gs.orderTeam.takeOrder", {});
  assert.deepEqual(calls, ["gs.usrLand.water", "gs.orderTeam.takeOrder"]);
});

test("a corrupt rearm marker does not interrupt a team-order command", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-corrupt-rearm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?corrupt-rearm-marker=${Date.now()}`
  );
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      return { v: {} };
    },
  }, "token", {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 2,
  });
  fs.writeFileSync(path.join(dir, "main.rearm.json"), "{broken", "utf8");

  await gateway.request("gs.orderTeam.takeOrder", {});
  assert.deepEqual(calls, ["gs.orderTeam.takeOrder"]);
});

test("active team reward does not depend on persistent intent writes", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-intent-write-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const settlementPath = `${statePath}.settlement-pending.json`;
  const guardedFs = {
    ...fs,
    renameSync(source, destination) {
      if (path.resolve(destination) === path.resolve(settlementPath)) {
        const error = new Error("controlled intent disk full");
        error.code = "ENOSPC";
        throw error;
      }
      return fs.renameSync(source, destination);
    },
  };
  const levelGuard = createPersistentExperienceLevelGuard({
    profileId: "main",
    statePath,
    fileSystem: guardedFs,
  });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?intent-write-failure=${Date.now()}`
  );
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") {
        return { v: { $usrTot: { data: { lvl: 20, lvlExp: 2, nextExp: 100_000 } } } };
      }
      return { v: {} };
    },
  }, "token", {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
    orderTeamTot: { orderTeam: { status: 3, orderNum: 160 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 2,
  });

  await gateway.request("gs.orderTeam.recvRwd", {});
  assert.deepEqual(calls, ["gs.orderTeam.recvRwd"]);
  assert.equal(fs.existsSync(settlementPath), false);
});

test("team-order transitions are not interrupted by experience rearm state", async (t) => {
  const cases = [
    ["gs.orderTeam.takeOrder", { isAgree: true, isCost: false }],
    ["gs.orderTeam.takeStoredOrder", { npcId: 7 }],
    ["gs.orderTeam.submitOrder", {}],
  ];
  for (const [iface, args] of cases) {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-team-transition-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const statePath = path.join(dir, "main.json");
    const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
    levelGuard.observeAuthoritative({
      level: 19,
      currentExp: 79_000,
      requiredExp: 81_400,
      accountUid: "account-a",
      serverIdx: 1,
      enabled: true,
    });
    const { createAutomationAccountCommandGateway } = await import(
      `./inspect-garden-dryrun.mjs?team-transition-post-refresh-${iface}-${Date.now()}`
    );
    const calls = [];
    const gateway = createAutomationAccountCommandGateway({
      async request(requestIface) {
        calls.push(requestIface);
        return { v: {} };
      },
    }, "token", {
      $loginServerIdx: 1,
      $usrTot: { data: { id: "account-a", lvl: 19, lvlExp: 79_000, nextExp: 81_400 } },
    }, {
      profileId: "main",
      experienceLevelGuard: levelGuard,
      getExperienceGuardThresholdPercent: () => 2,
    });
    createExperienceGuardRearmRequest({
      profileId: "main",
      statePath,
      expectedStateRevision: levelGuard.getState().stateRevision,
      confirmed: true,
      requestId: `team-transition-post-refresh-${iface}`,
    });

    await gateway.request(iface, args);

    assert.deepEqual(calls, [iface]);
    assert.equal(fs.existsSync(`${statePath}.settlement-pending.json`), false);
  }
});

test("an inconclusive team reward response does not interrupt the team-order flow", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-post-action-authority-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({
    level: 19,
    currentExp: 79_000,
    requiredExp: 81_400,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?post-action-authority=${Date.now()}`
  );
  const calls = [];
  let lazyCount = 0;
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") {
        lazyCount += 1;
        const level = lazyCount === 1 ? 19 : 20;
        return {
          v: {
            $usrTot: {
              data: {
                id: "account-a",
                lvl: level,
                lvlExp: level === 19 ? 79_000 : 1,
                nextExp: level === 19 ? 81_400 : 100_000,
              },
            },
          },
        };
      }
      return { v: {} };
    },
  }, "token", {
    $loginServerIdx: 1,
    $usrTot: { data: { id: "account-a", lvl: 19, lvlExp: 79_000, nextExp: 81_400 } },
    orderTeamTot: { orderTeam: { status: 3, orderNum: 160 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 2,
  });

  await gateway.request("gs.orderTeam.recvRwd", {});

  assert.deepEqual(calls, ["gs.orderTeam.recvRwd"]);
  assert.equal(levelGuard.getState().breached, false);
  assert.equal(levelGuard.getState().lastAuthoritativeLevel, 19);
  assert.equal(fs.existsSync(`${statePath}.settlement-pending.json`), false);
});

test("team-order submit uses action spacing without a persistent settlement intent", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-team-action-lock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({
    level: 19,
    currentExp: 79_000,
    requiredExp: 81_400,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  createExperienceGuardRearmRequest({
    profileId: "main",
    statePath,
    expectedStateRevision: levelGuard.getState().stateRevision,
    confirmed: true,
    requestId: "team-action-lock",
  });

  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?team-action-lock=${Date.now()}`
  );
  const calls = [];
  let releaseActionLock;
  let actionLockStartedResolve;
  const actionLockReleased = new Promise((resolve) => {
    releaseActionLock = resolve;
  });
  const actionLockStarted = new Promise((resolve) => {
    actionLockStartedResolve = resolve;
  });
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      return { v: {} };
    },
  }, "token", {
    $loginServerIdx: 1,
    $usrTot: { data: { id: "account-a", lvl: 19, lvlExp: 79_000, nextExp: 81_400 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 2,
    teamOrderActionSleep: async (milliseconds) => {
      assert.equal(milliseconds, 300);
      actionLockStartedResolve();
      await actionLockReleased;
    },
  });

  const request = gateway.request("gs.orderTeam.submitOrder", {});
  await Promise.race([
    actionLockStarted,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("team-order action lock did not start")),
      500,
    )),
  ]);
  assert.deepEqual(calls, [
    "gs.orderTeam.submitOrder",
  ]);
  assert.equal(fs.existsSync(`${statePath}.settlement-pending.json`), false);
  releaseActionLock();
  await request;
});

test("team-order submit transport uncertainty is left to team-order truth reconciliation", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-team-submit-uncertain-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({
    level: 31,
    currentExp: 103_931,
    requiredExp: 2_204_000,
    accountUid: "account-a",
    serverIdx: 726,
    enabled: true,
  });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?team-submit-uncertain=${Date.now()}`
  );
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      if (iface === "gs.usr.lazySync") return { v: {} };
      throw new Error("WS closed while waiting for gs.orderTeam.submitOrder");
    },
  }, "token", {
    $loginServerIdx: 726,
    $usrTot: { data: { id: "account-a", lvl: 31, lvlExp: 103_931, nextExp: 2_204_000 } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 0.2,
  });

  await assert.rejects(
    gateway.request("gs.orderTeam.submitOrder", {}),
    /WS closed while waiting for gs\.orderTeam\.submitOrder/,
  );
  assert.equal(fs.existsSync(`${statePath}.settlement-pending.json`), false);
  assert.equal(levelGuard.getDecision({ enabled: true }).blocked, false);
});

test("a protected action timeout is classified as unknown settlement, rethrown, and durable across restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-unknown-settlement-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({
    level: 20,
    currentExp: 1,
    requiredExp: 100_000,
    accountUid: "account-a",
    serverIdx: 1,
    enabled: true,
  });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?unknown-settlement=${Date.now()}`
  );
  const timeout = new Error("WS closed while waiting for gs.usrLand.harvest");
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") {
        return { v: {
          $usrTot: { data: { id: "account-a", lvl: 20, lvlExp: 1, nextExp: 100_000 } },
          usrLandTot: { usrLand: { landMap: { 1001: { landId: 1001, flowerId: 23001, state: 3, harvestCnt: 1, nextTime: "2026-06-16T00:00:00.000Z" } } } },
        } };
      }
      if (iface === "gs.usrLand.harvest") throw timeout;
      throw new Error(`unexpected iface ${iface}`);
    },
  }, "token", {
    $loginServerIdx: 1,
    $usrTot: { data: { id: "account-a", lvl: 20, lvlExp: 1, nextExp: 100_000 } },
    usrLandTot: { usrLand: { landMap: { 1001: { landId: 1001, flowerId: 23001, state: 3, harvestCnt: 1, nextTime: "2026-06-16T00:00:00.000Z" } } } },
    cultivateTot: { cultivateMap: { 23001: { flowerId: 23001, lvl: 1 } } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    experienceConfig: createHarvestExperienceConfig(),
    getExperienceGuardThresholdPercent: () => 1,
  });

  await assert.rejects(
    gateway.request("gs.usrLand.harvest", { landId: 1001 }),
    (error) => (
      error === timeout
      && error.automationClassification?.category === "settlement-unknown"
      && error.automationClassification?.phase === "request-in-flight"
    ),
  );
  assert.deepEqual(calls, ["gs.usr.lazySync", "gs.usrLand.harvest"]);
  assert.equal(levelGuard.getPendingSettlement().status, "unknown");
  assert.equal(levelGuard.getPendingSettlement().iface, "gs.usrLand.harvest");
  assert.equal(levelGuard.getDecision({ enabled: true }).reason, "experience-guard-settlement-unresolved");

  const restarted = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  assert.equal(restarted.getDecision({ enabled: true }).blocked, true);
  assert.equal(restarted.getPendingSettlement().requestId, levelGuard.getPendingSettlement().requestId);
});

test("a protected action post-response authority failure is distinct from transport unknown settlement", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-post-verification-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?post-verification-classification=${Date.now()}`
  );
  let lazyCount = 0;
  const verificationError = new Error("WS closed while waiting for gs.usr.lazySync");
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      if (iface === "gs.usr.lazySync") {
        lazyCount += 1;
        if (lazyCount > 1) throw verificationError;
        return { v: {
          $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
          usrLandTot: { usrLand: { landMap: { 1001: { landId: 1001, flowerId: 23001, state: 3, harvestCnt: 1, nextTime: "2026-06-16T00:00:00.000Z" } } } },
          cultivateTot: { cultivateMap: { 23001: { flowerId: 23001, lvl: 1 } } },
        } };
      }
      if (iface === "gs.usrLand.harvest") return { v: {} };
      throw new Error(`unexpected iface ${iface}`);
    },
  }, "token", {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
    usrLandTot: { usrLand: { landMap: { 1001: { landId: 1001, flowerId: 23001, state: 3, harvestCnt: 1, nextTime: "2026-06-16T00:00:00.000Z" } } } },
    cultivateTot: { cultivateMap: { 23001: { flowerId: 23001, lvl: 1 } } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    experienceConfig: createHarvestExperienceConfig(),
    getExperienceGuardThresholdPercent: () => 1,
  });

  await assert.rejects(
    gateway.request("gs.usrLand.harvest", { landId: 1001 }),
    (error) => (
      error === verificationError
      && error.automationClassification?.category === "post-action-verification-failed"
      && error.automationClassification?.phase === "post-action-verification"
    ),
  );
  assert.equal(levelGuard.getPendingSettlement().failureCategory, "post-action-verification-failed");
  assert.equal(levelGuard.getDecision({ enabled: true }).blocked, true);
});

test("a known business rejection completes the protected intent without a verification retry", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-business-rejection-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?business-rejection=${Date.now()}`
  );
  const calls = [];
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      calls.push(iface);
      if (iface === "gs.usr.lazySync") {
        return { v: {
          $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
          usrLandTot: { usrLand: { landMap: { 1001: { landId: 1001, flowerId: 23001, state: 3, harvestCnt: 1, nextTime: "2026-06-16T00:00:00.000Z" } } } },
          cultivateTot: { cultivateMap: { 23001: { flowerId: 23001, lvl: 1 } } },
        } };
      }
      if (iface === "gs.usrLand.harvest") {
        return { v: {}, m: { code: 301, msg: "土地状态已变化" } };
      }
      throw new Error(`unexpected iface ${iface}`);
    },
  }, "token", {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
    usrLandTot: { usrLand: { landMap: { 1001: { landId: 1001, flowerId: 23001, state: 3, harvestCnt: 1, nextTime: "2026-06-16T00:00:00.000Z" } } } },
    cultivateTot: { cultivateMap: { 23001: { flowerId: 23001, lvl: 1 } } },
  }, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    experienceConfig: createHarvestExperienceConfig(),
    getExperienceGuardThresholdPercent: () => 1,
  });

  const raw = await gateway.request("gs.usrLand.harvest", { landId: 1001 });
  assert.equal(raw.m.code, 301);
  assert.deepEqual(calls, ["gs.usr.lazySync", "gs.usrLand.harvest"]);
  assert.equal(levelGuard.getPendingSettlement(), null);
  assert.equal(levelGuard.getDecision({ enabled: true }).blocked, false);
});

test("a land refresh resolves an unknown harvest only when authoritative land state proves it settled", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-land-reconcile-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?land-reconcile=${Date.now()}`
  );
  const timeout = new Error("WS closed while waiting for gs.usrLand.harvest");
  const matureSync = {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
    usrLandTot: { usrLand: { landMap: { 1001: { landId: 1001, flowerId: 23001, state: 3, harvestCnt: 1, nextTime: "2026-06-16T00:00:00.000Z" } } } },
    cultivateTot: { cultivateMap: { 23001: { flowerId: 23001, lvl: 1 } } },
  };
  const firstGateway = createAutomationAccountCommandGateway({
    async request(iface) {
      if (iface === "gs.usr.lazySync") return { v: matureSync };
      if (iface === "gs.usrLand.harvest") throw timeout;
      throw new Error(`unexpected iface ${iface}`);
    },
  }, "token", matureSync, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 1,
  });
  await assert.rejects(firstGateway.request("gs.usrLand.harvest", { landId: 1001 }), timeout);

  const restarted = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  const recoveredGateway = createAutomationAccountCommandGateway({
    async request(iface) {
      if (iface === "gs.usrLand.refresh") {
        return {
          v: {
            usrLandTot: {
              usrLand: {
                landMap: { 1001: { landId: 1001, flowerId: 23001, state: 2, nextTime: "2099-01-01T00:00:00.000Z" } },
              },
            },
            cultivateTot: { cultivateMap: { 23001: { flowerId: 23001, lvl: 1 } } },
          },
        };
      }
      throw new Error(`unexpected iface ${iface}`);
    },
  }, "token", matureSync, {
    profileId: "main",
    experienceLevelGuard: restarted,
    experienceConfig: createHarvestExperienceConfig(),
    getExperienceGuardThresholdPercent: () => 1,
  });

  await recoveredGateway.request("gs.usrLand.refresh", {});
  assert.equal(restarted.getPendingSettlement(), null);
  assert.equal(restarted.getDecision({ enabled: true }).blocked, false);
});

test("same mature land clears a confirmed recovery only when its full pre-action snapshot is unchanged", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-land-recovery-proof-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
  const landBefore = {
    landId: 1001,
    flowerId: 23001,
    state: 3,
    harvestCnt: 1,
    nextTime: "2026-06-16T00:00:00.000Z",
  };
  levelGuard.beginProtectedAction({
    requestId: "same-land-proof",
    iface: "gs.usrLand.harvest",
    actionArgs: { landId: 1001 },
    actionEvidence: {
      land: { landId: 1001, snapshot: landBefore },
    },
  });
  levelGuard.markProtectedActionUncertain({ requestId: "same-land-proof" });
  const recovery = createExperienceGuardSettlementRecoveryRequest({
    profileId: "main",
    statePath,
    pendingRequestId: "same-land-proof",
    expectedStateRevision: levelGuard.getState().stateRevision,
    confirmed: true,
    requestId: "same-land-recovery",
  });
  const syncValue = {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
    usrLandTot: { usrLand: { landMap: { 1001: landBefore } } },
  };
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?same-land-recovery=${Date.now()}`
  );
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      assert.equal(iface, "gs.usrLand.refresh");
      return { v: { usrLandTot: { usrLand: { landMap: { 1001: landBefore } } } } };
    },
  }, "token", syncValue, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 1,
  });

  await gateway.request("gs.usrLand.refresh", {});
  assert.equal(levelGuard.getPendingSettlement(), null);
  assert.equal(levelGuard.getPendingSettlementRecovery(), null);
  assert.equal(levelGuard.getState().settlementResolution.outcome, "rejected");
  assert.equal(levelGuard.getState().settlementResolution.source, "gs.usrLand.refresh");
  assert.equal(recovery.pendingRequestId, "same-land-proof");
});

test("a changed mature land remains unknown even after explicit recovery confirmation", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-land-recovery-changed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
  const landBefore = {
    landId: 1001,
    flowerId: 23001,
    state: 3,
    harvestCnt: 1,
    nextTime: "2026-06-16T00:00:00.000Z",
  };
  levelGuard.beginProtectedAction({
    requestId: "changed-land-proof",
    iface: "gs.usrLand.harvest",
    actionArgs: { landId: 1001 },
    actionEvidence: { land: { landId: 1001, snapshot: landBefore } },
  });
  levelGuard.markProtectedActionUncertain({ requestId: "changed-land-proof" });
  createExperienceGuardSettlementRecoveryRequest({
    profileId: "main",
    statePath,
    pendingRequestId: "changed-land-proof",
    expectedStateRevision: levelGuard.getState().stateRevision,
    confirmed: true,
    requestId: "changed-land-recovery",
  });
  const changedLand = { ...landBefore, harvestCnt: 2 };
  const syncValue = {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
    usrLandTot: { usrLand: { landMap: { 1001: landBefore } } },
  };
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?changed-land-recovery=${Date.now()}`
  );
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      assert.equal(iface, "gs.usrLand.refresh");
      return { v: { usrLandTot: { usrLand: { landMap: { 1001: changedLand } } } } };
    },
  }, "token", syncValue, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 1,
  });

  await gateway.request("gs.usrLand.refresh", {});
  assert.equal(levelGuard.getDecision({ enabled: true }).reason, "experience-guard-settlement-unresolved");
  assert.equal(levelGuard.getPendingSettlement().lastCheckReason, "harvest-land-still-mature-authority-changed");
  assert.equal(levelGuard.getPendingSettlementRecovery().pendingRequestId, "changed-land-proof");
});

test("legacy no-fingerprint recovery waits for a matching authority refresh and records the risk", async (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), "account-gateway-legacy-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, "main.json");
  const levelGuard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
  levelGuard.observeAuthoritative({ level: 20, currentExp: 1, requiredExp: 100_000, enabled: true });
  levelGuard.beginProtectedAction({
    requestId: "legacy-land-proof",
    iface: "gs.usrLand.harvest",
    actionArgs: { landId: 1001 },
  });
  levelGuard.markProtectedActionUncertain({ requestId: "legacy-land-proof" });
  const recovery = createExperienceGuardSettlementRecoveryRequest({
    profileId: "main",
    statePath,
    pendingRequestId: "legacy-land-proof",
    expectedStateRevision: levelGuard.getState().stateRevision,
    confirmed: true,
    legacyUnverified: true,
    operatorReason: "人工接受历史请求无法核实的远端执行风险",
    requestId: "legacy-land-recovery",
  });
  const syncValue = {
    $usrTot: { data: { lvl: 20, lvlExp: 1, nextExp: 100_000 } },
    usrLandTot: { usrLand: { landMap: { 1001: { landId: 1001, state: 3, nextTime: "2099-01-01T00:00:00.000Z" } } } },
  };
  const { createAutomationAccountCommandGateway } = await import(
    `./inspect-garden-dryrun.mjs?legacy-land-recovery=${Date.now()}`
  );
  const gateway = createAutomationAccountCommandGateway({
    async request(iface) {
      if (iface === "gs.usr.lazySync") return { v: {} };
      assert.equal(iface, "gs.usrLand.refresh");
      return { v: { usrLandTot: { usrLand: { landMap: { 1001: { landId: 1001, state: 3, nextTime: "2099-01-01T00:00:00.000Z" } } } } } };
    },
  }, "token", syncValue, {
    profileId: "main",
    experienceLevelGuard: levelGuard,
    getExperienceGuardThresholdPercent: () => 1,
  });

  await gateway.request("gs.usr.lazySync", {});
  assert.equal(levelGuard.getPendingSettlement().requestId, "legacy-land-proof");
  await gateway.request("gs.usrLand.refresh", {});

  assert.equal(levelGuard.getPendingSettlement(), null);
  assert.equal(levelGuard.getDecision({ enabled: true }).blocked, false);
  assert.equal(levelGuard.getState().settlementResolution.recoveryMode, "legacy-unverified");
  assert.equal(levelGuard.getState().settlementResolution.operatorReason, recovery.operatorReason);
  assert.equal(levelGuard.getState().settlementResolution.source, "operator-confirmed-legacy-recovery");
});

test("gateway rate limit guard observes a server rate-limit error and backoff", async () => {
  const rateLimitedError = new Error("submit failed");
  rateLimitedError.errMsg = { code: 263, msg: "操作过于频繁" };
  const transportCalls = [];
  const gateway = createGateway({
    async request(iface, args) {
      transportCalls.push(iface);
      throw rateLimitedError;
    },
  });

  await assert.rejects(
    gateway.request("gs.orderTeam.submitOrder", {}),
    (error) => error === rateLimitedError,
  );
  assert.deepEqual(transportCalls, ["gs.orderTeam.submitOrder"]);

  const state = gateway.getRateLimitState();
  assert.ok(state["gs.orderTeam.submitOrder"], "rate limit state should track the iface");
  assert.equal(state["gs.orderTeam.submitOrder"].rateLimitedCount, 1);
  assert.equal(state["gs.orderTeam.submitOrder"].backoffCount, 1);
  assert.ok(state["gs.orderTeam.submitOrder"].backoffRemainingMs > 0);
});

test("gateway rate limit guard does not backoff unrelated errors", async () => {
  const transportError = new Error("water drop shortage");
  transportError.errMsg = { code: 301, param: { iid: 7 } };
  let calls = 0;
  const gateway = createGateway({
    async request() {
      calls += 1;
      throw transportError;
    },
  });

  await assert.rejects(gateway.request("gs.usrLand.water", {}), transportError);
  assert.equal(calls, 1);
  const state = gateway.getRateLimitState();
  assert.deepEqual(state, {}, "unrelated errors must not create rate limit state");
});

test("gateway rate limit guard is per-interface", async () => {
  let submitCalls = 0;
  let harvestCalls = 0;
  const gateway = createGateway({
    async request(iface) {
      if (iface === "gs.orderTeam.submitOrder") {
        submitCalls += 1;
        const err = new Error("submit rate limited");
        err.errMsg = { type: 263 };
        throw err;
      }
      harvestCalls += 1;
      return { v: {} };
    },
  });

  await assert.rejects(gateway.request("gs.orderTeam.submitOrder", {}), /submit rate limited/);
  await gateway.request("gs.usrLand.harvest", {});
  assert.equal(submitCalls, 1);
  assert.equal(harvestCalls, 1);

  const state = gateway.getRateLimitState();
  assert.ok(state["gs.orderTeam.submitOrder"]);
  assert.equal(state["gs.usrLand.harvest"], undefined, "harvest must not be rate limited");
});

test("gateway rate limit guard can be overridden with injected options", async () => {
  let rateLimitedCallbackCalls = 0;
  const rateLimitedError = new Error("rate limited");
  rateLimitedError.errMsg = { code: 263 };
  const gateway = createGateway(
    {
      async request() {
        throw rateLimitedError;
      },
    },
    {
      rateLimitWindowMs: 500,
      rateLimitMaxRequestsPerWindow: 1,
      rateLimitMinBackoffMs: 100,
      rateLimitMaxBackoffMs: 1_000,
      onRateLimited: () => {
        rateLimitedCallbackCalls += 1;
      },
    },
  );

  await assert.rejects(gateway.request("gs.orderTeam.submitOrder", {}), rateLimitedError);
  assert.equal(rateLimitedCallbackCalls, 1);
  const state = gateway.getRateLimitState();
  assert.equal(state["gs.orderTeam.submitOrder"].backoffCount, 1);
});

test("isRequestRateLimitedError is exported from the rate limit guard module", () => {
  const err = new Error("x");
  err.errMsg = { code: 263 };
  assert.equal(isRequestRateLimitedError(err), true);
  assert.equal(isRequestRateLimitedError(new Error("nope")), false);
});
