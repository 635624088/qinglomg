import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCustomerOrderScheduler } from "./customer-order-scheduler.mjs";

const { runGardenCycle, waitWithOnlineHeartTick } = await import(
  `./inspect-garden-dryrun.mjs?customer-order-t4=${Date.now()}`
);

const START_MS = Date.parse("2026-06-16T02:00:00.000Z");
const CUSTOMER_NPC_CONFIG = {
  sourcePath: "fixture:t4:c_orderCustomerNpc",
  npcIds: [8, 9, 10],
  npcs: {
    8: { id: 8, maintaskId: 0 },
    9: { id: 9, maintaskId: 0 },
    10: { id: 10, maintaskId: 0 },
  },
  npcMaxDay: 350,
};

const EXPERIENCE_CONFIG = {
  compatible: true,
  reasons: [],
  monthCardExpAdd: 0,
  flowers: new Map(),
  flowerLevelExact: new Map(),
  flowerLevelCfg: new Map(),
  flowerArts: new Map([
    [300101, { id: 300101, experiencePrice: 1, experiencePriceKnown: true, flowerIds: [] }],
    [300102, { id: 300102, experiencePrice: 1, experiencePriceKnown: true, flowerIds: [] }],
  ]),
  mainTasks: new Map(),
  cyclicNotes: new Map(),
  cyclicStory: new Map(),
  flowerAdvanceSkillById: new Map(),
  teamOrder: { rewardBaseExperience: 8_000, orders: new Map() },
};

const BASE_ENV = {
  PROFILE_ID: "customer-order-t4-account",
  AUTO_SUBMIT_SPECIAL_ORDERS: "0",
  AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: "0",
  AUTO_SUBMIT_PALACE_ORDERS: "0",
  AUTO_SUBMIT_MAIN_TASKS: "0",
  AUTO_SUBMIT_CUSTOMER_ORDERS: "1",
  AUTO_HANDLE_TEAM_ORDERS: "0",
  AUTO_HANDLE_GARDEN_LAND: "0",
  AUTO_HANDLE_FLOWER_RACK: "0",
  AUTO_HANDLE_PEARL: "0",
  AUTO_HANDLE_FML_LAND: "0",
  AUTO_HANDLE_FREE_WATER: "0",
  AUTO_HANDLE_WATERWHEEL: "0",
  AUTO_HANDLE_MATERIAL_SHOP: "0",
  AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
  AUTO_HANDLE_CYCLIC_NOTE: "0",
  AUTO_WATER: "0",
  AUTO_SPEEDUP_FREE: "0",
  CUSTOMER_ORDER_MAX_STEPS_PER_CYCLE: "8",
};

function raw(value) {
  return { v: value };
}

function artConfig(arts) {
  return {
    sourcePath: "fixture:t4:c_flowerArt",
    customerMax: 3,
    arts,
  };
}

function makeSync({ orderMap = {}, nextGenTimeMs = START_MS - 2_000, bag = {}, noble = true } = {}) {
  const sync = {
    $usrTot: {
      cntMap: { 107: { type: 107, tdyCnt: 0 } },
      data: {
        id: "customer-order-t4-account",
        lvl: 40,
        lvlExp: 1_000,
        nextExp: 1_000_000,
        bag: {
          7: 99,
          ...bag,
        },
      },
    },
    flowerArtTot: { flowerArt: { makeList: [300101, 300102] } },
    rchgTot: { cardMap: {} },
    videoDouble: { eTime: "2099-01-01T00:00:00.000Z" },
    orderCustomerTot: {
      orderCustomer: {
        nextGenTime: new Date(nextGenTimeMs).toISOString(),
        orderMap,
      },
    },
    usrLandTot: { usrLand: { landMap: {} } },
  };
  if (!noble) delete sync.rchgTot;
  return sync;
}

function makeTransport(clock, handler) {
  const requestLog = [];
  const ws = {
    requestLog,
    observeSync() {},
    async request(iface, args) {
      requestLog.push({ iface, args, atMs: clock.now });
      const value = await handler({ iface, args, requestLog, clock });
      return raw(value === undefined ? {} : value);
    },
  };
  return ws;
}

let fixtureQueue = Promise.resolve();

async function runFixture({ sync, ws, outDir, clock, orderCustomerNpcConfig = CUSTOMER_NPC_CONFIG, flowerArtConfig, releaseMask = 4, runOptions = {} }) {
  const previousFixture = fixtureQueue;
  let releaseFixture;
  fixtureQueue = new Promise((resolve) => {
    releaseFixture = resolve;
  });
  await previousFixture;
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  Object.assign(process.env, {
    ...BASE_ENV,
    STATUS_DOC_DIR: outDir,
    CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_PATH: historyPath,
    ...(runOptions.env || {}),
  });
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const result = await runGardenCycle(ws, "test-token", sync, 1, {
      profileId: BASE_ENV.PROFILE_ID,
      nowFn: () => {
        clock.now += 10;
        return clock.now;
      },
      orderCustomerNpcConfig,
      flowerArtConfig,
      customerOrderFlowerCurrencyRewardReleaseMask: releaseMask,
      experienceConfig: EXPERIENCE_CONFIG,
      ...(runOptions.options || {}),
    });
    return { result, logs, historyPath };
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    releaseFixture();
  }
}

async function runWaitFixture({ sync, ws, clock, orderCustomerNpcConfig = CUSTOMER_NPC_CONFIG, flowerArtConfig, runOptions = {} }) {
  const previousFixture = fixtureQueue;
  let releaseFixture;
  fixtureQueue = new Promise((resolve) => {
    releaseFixture = resolve;
  });
  await previousFixture;
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  Object.assign(process.env, {
    ...BASE_ENV,
    CUSTOMER_ORDER_GEN_DURING_WAIT: "1",
    ...(runOptions.env || {}),
  });
  console.log = (...args) => logs.push(args.join(" "));
  const customerOrderScheduler = runOptions.options?.customerOrderScheduler
    || createCustomerOrderScheduler({ nowFn: () => clock.now });
  try {
    const result = await waitWithOnlineHeartTick(ws, "test-token", sync, 16_000, {
      nowFn: () => clock.now,
      waitFn: async (ms) => {
        clock.now += ms;
      },
      customerOrderRequestStartNowFn: () => clock.now,
      statusRefreshIntervalMs: 0,
      assetSyncIntervalMs: 0,
      statusWriter: () => {},
      growthHandler: async (_ws, _gsToken, syncValue) => ({ syncValue }),
      orderCustomerNpcConfig,
      flowerArtConfig,
      customerOrderScheduler,
      ...(runOptions.options || {}),
    });
    return { result, logs, customerOrderScheduler };
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    releaseFixture();
  }
}

function parseLogs(logs) {
  return logs.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

test("T4 generation with a new authoritative order opens the first action in the same serial event", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-customer-order-t4-generation-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const clock = { now: START_MS };
  const generated = {
    orderCustomerTot: {
      orderCustomer: {
        nextGenTime: new Date(START_MS + 600_000).toISOString(),
        orderMap: {
          8: { artId: 300101, num: 1, cTime: new Date(START_MS).toISOString() },
        },
      },
    },
  };
  const ws = makeTransport(clock, async ({ iface }) => {
    if (iface === "gs.usrLand.refresh") return makeSync({ orderMap: {} });
    if (iface === "gs.orderCustomer.genOrder") return generated;
    return {};
  });
  const sync = makeSync({ orderMap: {}, bag: { 300101: 1 } });
  const { result, logs } = await runFixture({
    sync,
    ws,
    outDir,
    clock,
    flowerArtConfig: artConfig({
      300101: { id: 300101, vaseId: 3061, flowerIds: [], cPrice: [[1002, 3]] },
    }),
  });

  const actionIfaces = ws.requestLog
    .map((entry) => entry.iface)
    .filter((iface) => iface === "gs.orderCustomer.genOrder" || iface === "gs.orderCustomer.finishOrder");
  assert.deepEqual(actionIfaces, [
    "gs.orderCustomer.genOrder",
    "gs.orderCustomer.finishOrder",
  ]);
  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8], undefined);
  const parsed = parseLogs(logs);
  const generation = parsed.find((entry) => entry.step === "customerOrderGenerationRequestStart");
  assert.ok(generation);
  assert.deepEqual(generation.existingOrderNpcIds, []);
  assert.equal(generation.existingOrderNpcIdsKnown, true);
  assert.equal(typeof generation.existingOrderNpcIdsSource, "string");
  assert.deepEqual(generation.guestNpcIds, []);
  assert.equal(generation.guestNpcIdsKnown, false);
  assert.equal(typeof generation.guestNpcIdSource, "string");
  assert.deepEqual(generation.availableNpcIds, [8, 9, 10]);
  assert.equal(generation.availableNpcIdsKnown, true);
  assert.equal(typeof generation.availableNpcSource, "string");
  assert.ok(parsed.some((entry) => entry.step === "customerOrderActionRequestStart" && entry.npcId === 8));
  assert.ok(parsed.some((entry) => entry.step === "customerOrderActionResponse" && entry.success === true));
  const plan = parsed.find((entry) => entry.step === "customerOrderActionPlan");
  assert.equal(plan.customerOrderQueue.pendingCount, 1);
  assert.deepEqual(plan.customerOrderQueue.pendingNpcIds, [8]);
  assert.deepEqual(plan.customerOrderQueue.eligibleNpcIds, [8]);
});

test("T4 make waits for authoritative inventory confirmation and records request-start delay before finish", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-customer-order-t4-make-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const clock = { now: START_MS };
  let lazySyncCount = 0;
  const sync = makeSync({
    orderMap: { 8: { artId: 300101, num: 1 } },
    bag: { 300101: 0, 23001: 1, 3061: 1 },
    nextGenTimeMs: START_MS + 600_000,
  });
  const ws = makeTransport(clock, async ({ iface }) => {
    if (iface === "gs.usrLand.refresh") return sync;
    if (iface === "gs.flowerArt.makeFlowerArt") return {};
    if (iface === "gs.usr.lazySync") {
      lazySyncCount += 1;
      return lazySyncCount === 2
        ? { $usrTot: { data: { bag: { 300101: 1 } } } }
        : {};
    }
    return {};
  });
  const { result, logs } = await runFixture({
    sync,
    ws,
    outDir,
    clock,
    flowerArtConfig: artConfig({
      300101: { id: 300101, vaseId: 3061, flowerIds: [23001], cPrice: [[1002, 3]] },
    }),
    runOptions: { env: { CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0" } },
  });

  const actionIfaces = ws.requestLog
    .map((entry) => entry.iface)
    .filter((iface) => [
      "gs.flowerArt.makeFlowerArt",
      "gs.orderCustomer.finishOrder",
    ].includes(iface));
  assert.deepEqual(actionIfaces, [
    "gs.flowerArt.makeFlowerArt",
    "gs.orderCustomer.finishOrder",
  ]);
  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8], undefined);
  const parsed = parseLogs(logs);
  assert.ok(parsed.some((entry) => entry.step === "customerOrderAuthoritativeSyncAfterMake" && entry.confirmed === true));
  const finish = parsed.find((entry) => (
    entry.step === "customerOrderActionResponse"
      && entry.type === "finishCustomerOrder"
      && entry.success === true
  ));
  assert.ok(finish);
  const status = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
  const submission = [...status.runHistory.customerOrderSubmissions]
    .reverse()
    .find((entry) => entry.npcId === 8 && entry.outcome === "completed");
  assert.ok(submission);
  assert.equal(submission.latencyMetricBasis, "request-start");
  assert.ok(submission.makeToFinishRequestStartDelayMs > 0);
});

test("T4 keeps the order pending when make and post-make sync have no authoritative art evidence", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-customer-order-t4-make-missing-authority-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const clock = { now: START_MS };
  const sync = makeSync({
    orderMap: { 8: { artId: 300101, num: 1 } },
    bag: { 300101: 0, 23001: 1, 3061: 1 },
    nextGenTimeMs: START_MS + 600_000,
  });
  const ws = makeTransport(clock, async ({ iface }) => {
    if (iface === "gs.usrLand.refresh") return sync;
    if (iface === "gs.flowerArt.makeFlowerArt") return {};
    if (iface === "gs.usr.lazySync") return {};
    return {};
  });
  const { result, logs } = await runFixture({
    sync,
    ws,
    outDir,
    clock,
    flowerArtConfig: artConfig({
      300101: { id: 300101, vaseId: 3061, flowerIds: [23001], cPrice: [[1002, 3]] },
    }),
    runOptions: { env: { CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0" } },
  });

  assert.equal(
    ws.requestLog.some((entry) => entry.iface === "gs.orderCustomer.finishOrder"),
    false,
  );
  const parsed = parseLogs(logs);
  assert.ok(result.orderCustomerTot.orderCustomer.orderMap[8]);
  const confirmation = parsed.find((entry) => entry.step === "customerOrderAuthoritativeSyncAfterMake");
  assert.equal(confirmation.confirmed, false);
  assert.equal(confirmation.failureCategory, "authoritative-confirmation-missing");
  assert.equal(confirmation.confirmationKnown, false);
  assert.deepEqual(confirmation.authorityEvidence, []);
  assert.deepEqual(confirmation.syncSource, []);
  assert.ok(parsed.some((entry) => entry.step === "customerOrderArtSyncPending" && entry.npcId === 8));
});

test("T4 treats a successful no-new generation as non-generated and continues the wait", async () => {
  const clock = { now: START_MS };
  const sync = makeSync({
    orderMap: {},
    nextGenTimeMs: START_MS + 3_000,
  });
  sync.$timeAuthority = {
    version: 1,
    lastAcceptedSample: {
      serverMs: START_MS,
      correctedServerMs: START_MS,
      requestStartedAtMs: START_MS,
      responseAtMs: START_MS,
      rttMs: 0,
      serverOffsetMs: 0,
      acceptedAtMs: START_MS,
    },
    sampleMaxAgeMs: 120_000,
  };
  const ws = makeTransport(clock, async ({ iface }) => {
    if (iface === "gs.usr.heartTick") return {};
    if (iface === "gs.orderCustomer.genOrder") {
      return {
        orderCustomerTot: {
          orderCustomer: {
            nextGenTime: new Date(START_MS + 5 * 60_000).toISOString(),
            orderMap: {},
          },
        },
      };
    }
    return {};
  });
  const processorCalls = [];
  const { result, logs, customerOrderScheduler } = await runWaitFixture({
    sync,
    ws,
    clock,
    flowerArtConfig: artConfig({}),
    runOptions: {
      options: {
        customerOrderProcessor: async () => {
          processorCalls.push(clock.now);
          throw new Error("no-new generation must not enter customer processor");
        },
      },
    },
  });

  assert.equal(processorCalls.length, 0);
  assert.equal(ws.requestLog.filter((entry) => entry.iface === "gs.orderCustomer.genOrder").length, 1);
  assert.equal(Object.keys(result.orderCustomerTot.orderCustomer.orderMap).length, 0);
  const parsed = parseLogs(logs);
  const generation = parsed.find((entry) => entry.step === "customerOrderGenerationResponse");
  assert.equal(generation.requestSucceeded, true);
  assert.equal(generation.generated, false);
  assert.equal(generation.generatedOrderCount, 0);
  assert.equal(generation.dedupeResult, "no-new-orders");
  assert.equal(generation.customerOrderScheduler.lastReason, "generation-success-no-new-orders");
  assert.equal(parsed.some((entry) => entry.step === "customerOrderGenerationReadyForAction"), false);
  assert.equal(parsed.some((entry) => entry.step === "customerOrderGenerationWaitReturnedEarly"), false);
  assert.equal(
    customerOrderScheduler.snapshot().retryAtMs,
    generation.requestStartedAtMs + 30_000,
  );
});

test("T4 scheduler ignores a stale smaller nextGenTime but adopts a newer larger one", () => {
  const scheduler = createCustomerOrderScheduler({ nowFn: () => START_MS });
  scheduler.observeSync({ nextGenTimeMs: START_MS + 1_000, nowMs: START_MS });
  scheduler.completeGeneration({
    nowMs: START_MS + 100,
    requestStartedAtMs: START_MS + 100,
    responseAtMs: START_MS + 100,
    nextGenTimeMs: START_MS + 10_000,
    generatedOrderCount: 1,
  });

  const stale = scheduler.observeSync({
    nextGenTimeMs: START_MS + 5_000,
    nowMs: START_MS + 200,
  });
  assert.equal(stale.nextGenTimeMs, START_MS + 10_000);
  assert.equal(stale.lastReason, "next-generation-time-stale");

  const newer = scheduler.observeSync({
    nextGenTimeMs: START_MS + 20_000,
    nowMs: START_MS + 300,
  });
  assert.equal(newer.nextGenTimeMs, START_MS + 20_000);
  assert.equal(newer.lastReason, "next-generation-time-updated");
});

test("T4 releaseMask 6 preserves reject-then-finish order and does not repeat a successful no-new generation", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-customer-order-t4-reevaluate-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const clock = { now: START_MS };
  const sync = makeSync({
    orderMap: {
      8: { artId: 300101, num: 1 },
      9: { artId: 300102, num: 1 },
    },
    bag: { 300101: 1, 300102: 1 },
  });
  const ws = makeTransport(clock, async ({ iface }) => {
    if (iface === "gs.usrLand.refresh") return sync;
    if (iface === "gs.orderCustomer.genOrder") return {
      orderCustomerTot: sync.orderCustomerTot,
    };
    return {};
  });
  const { logs } = await runFixture({
    sync,
    ws,
    outDir,
    clock,
    releaseMask: 6,
    flowerArtConfig: artConfig({
      300101: { id: 300101, vaseId: 3061, flowerIds: [], cPrice: [[1002, 1]] },
      300102: { id: 300102, vaseId: 3061, flowerIds: [], cPrice: [[1002, 3]] },
    }),
  });

  assert.equal(
    ws.requestLog.filter((entry) => entry.iface === "gs.orderCustomer.genOrder").length,
    1,
  );
  assert.deepEqual(
    ws.requestLog
      .map((entry) => entry.iface)
      .filter((iface) => [
        "gs.orderCustomer.rejectOrder",
        "gs.orderCustomer.finishOrder",
      ].includes(iface)),
    ["gs.orderCustomer.rejectOrder", "gs.orderCustomer.finishOrder"],
  );
  const parsed = parseLogs(logs);
  const reassessment = parsed.filter((entry) => entry.step === "customerOrderGenerationReassessment");
  assert.equal(reassessment.length, 2);
  assert.ok(reassessment.every((entry) => entry.generatedOrderCount === 0));
  assert.ok(reassessment.every((entry) => entry.reassessmentDepth === 0));
});

test("T4 exposes customer noble-state unknown as a finish guard category without blocking non-experience actions", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-customer-order-t4-guard-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const clock = { now: START_MS };
  const sync = makeSync({
    orderMap: { 8: { artId: 300101, num: 1 } },
    bag: { 300101: 1 },
    noble: false,
    nextGenTimeMs: START_MS + 600_000,
  });
  const ws = makeTransport(clock, async ({ iface }) => {
    if (iface === "gs.usrLand.refresh") return sync;
    return {};
  });
  const { logs } = await runFixture({
    sync,
    ws,
    outDir,
    clock,
    flowerArtConfig: artConfig({
      300101: { id: 300101, vaseId: 3061, flowerIds: [], cPrice: [[1002, 3]] },
    }),
    runOptions: {
      options: { getExperienceGuardThresholdPercent: () => 1 },
      env: { CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0" },
    },
  });

  assert.equal(ws.requestLog.some((entry) => entry.iface === "gs.orderCustomer.finishOrder"), false);
  const parsed = parseLogs(logs);
  const guard = parsed.find((entry) => entry.step === "experienceGuardActionSkip" && entry.iface === "gs.orderCustomer.finishOrder");
  assert.equal(guard.experienceEstimateSource, "customer-order-noble-state-unknown");
  const submitError = parsed.find((entry) => entry.step === "customerOrderSubmitError");
  assert.equal(submitError.experienceEstimateSource, "customer-order-noble-state-unknown");
  assert.equal(submitError.customerOrderFailureCategory, "experience-guard-blocked");
});

test("T4 classifies a transport submit failure and leaves the order recoverable", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-customer-order-t4-submit-error-"));
  t.after(() => fs.rmSync(outDir, { recursive: true, force: true }));
  const clock = { now: START_MS };
  const sync = makeSync({
    orderMap: { 8: { artId: 300101, num: 1 } },
    bag: { 300101: 1 },
    nextGenTimeMs: START_MS + 600_000,
  });
  const ws = makeTransport(clock, async ({ iface }) => {
    if (iface === "gs.usrLand.refresh") return sync;
    if (iface === "gs.orderCustomer.finishOrder") throw new Error("fixture finish submit failed");
    return {};
  });
  const { result, logs } = await runFixture({
    sync,
    ws,
    outDir,
    clock,
    flowerArtConfig: artConfig({
      300101: { id: 300101, vaseId: 3061, flowerIds: [], cPrice: [[1002, 3]] },
    }),
    runOptions: { env: { CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0" } },
  });

  assert.ok(result.orderCustomerTot.orderCustomer.orderMap[8]);
  const parsed = parseLogs(logs);
  const actionResponse = parsed.find((entry) => (
    entry.step === "customerOrderActionResponse"
      && entry.iface === "gs.orderCustomer.finishOrder"
      && entry.success === false
  ));
  assert.equal(actionResponse.failureCategory, "finish-submit-error");
  const submitError = parsed.find((entry) => entry.step === "customerOrderSubmitError");
  assert.equal(submitError.customerOrderFailureCategory, "finish-submit-error");
  assert.equal(submitError.submitErrorCategory, "finish-submit-error");
});
