import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mergeExperienceSync, mergeGameSync } from "./garden-state.mjs";
import {
  estimateExperienceAction,
  NOBLE_SESSION_STATE_FIELD,
} from "./experience-settlement.mjs";

const { openGameWsSession, runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-order-noble-starvation=${Date.now()}`);

const CONFIG = {
  compatible: true,
  reasons: [],
  monthCardExpAdd: 0.25,
  flowers: new Map([[101, { id: 101, experience: 10 }]]),
  flowerLevelExact: new Map(),
  flowerLevelCfg: new Map(),
  flowerArts: new Map([[9001, {
    id: 9001,
    experiencePrice: 100,
    experiencePriceKnown: true,
    flowerIds: [101],
  }]]),
  mainTasks: new Map(),
  cyclicNotes: new Map(),
  flowerAdvanceSkillById: new Map(),
  teamOrder: { rewardBaseExperience: 8_000, orders: new Map() },
};

const DISABLED_AUTOMATION_ENV = {
  AUTO_SUBMIT_SPECIAL_ORDERS: "0",
  AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: "0",
  AUTO_SUBMIT_PALACE_ORDERS: "0",
  AUTO_SUBMIT_MAIN_TASKS: "0",
  AUTO_SUBMIT_CUSTOMER_ORDERS: "1",
  CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0",
  CUSTOMER_ORDER_MAX_STEPS_PER_CYCLE: "3",
  AUTO_HANDLE_TEAM_ORDERS: "0",
  AUTO_HANDLE_GARDEN_LAND: "0",
  AUTO_HANDLE_FLOWER_RACK: "0",
  AUTO_HANDLE_FLOWER_UPGRADE: "0",
  AUTO_HANDLE_PEARL: "0",
  AUTO_HANDLE_FML_LAND: "0",
  AUTO_HANDLE_FREE_WATER: "0",
  AUTO_HANDLE_WATERWHEEL: "0",
  AUTO_HANDLE_MATERIAL_SHOP: "0",
  AUTO_WATER: "0",
  AUTO_SPEEDUP_FREE: "0",
  AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
  AUTO_HANDLE_CYCLIC_NOTE: "0",
};

function makeCustomerSync({
  currentExp = 1_000_000,
  nextExp = 10_000_000,
  orderMap = { 8: { artId: 300101, num: 3 } },
  bagOverrides = {},
  nobleState,
  cardMap,
} = {}) {
  const sync = {
    $usrTot: {
      data: {
        id: "customer-order-noble-starvation-account",
        lvl: 40,
        lvlExp: currentExp,
        nextExp,
        bag: {
          7: 99,
          3001: 99,
          300101: 3,
          23001: 3,
          23002: 3,
          23003: 3,
          23007: 3,
          ...bagOverrides,
        },
      },
    },
    videoDouble: { eTime: "2099-01-01T00:00:00.000Z" },
    orderCustomerTot: {
      orderCustomer: { orderMap },
    },
    usrLandTot: { usrLand: { landMap: {} } },
    cultivateTot: { cultivateMap: {} },
  };
  if (nobleState !== undefined) sync.$nobleState = nobleState;
  if (cardMap !== undefined) sync.rchgTot = { cardMap };
  return sync;
}

function makeFakeWs({ onRequest = null } = {}) {
  const requestLog = [];
  return {
    requestLog,
    observeSync() {},
    async request(iface, args) {
      requestLog.push({ iface, args });
      onRequest?.({ iface, args, requestLog });
      if (new Set([
        "gs.usrLand.refresh",
        "gs.usr.heartTick",
        "gs.usr.lazySync",
        "gs.orderCustomer.finishOrder",
        "gs.orderCustomer.rejectOrder",
        "gs.flowerArt.makeFlowerArt",
      ]).has(iface)) {
        return { v: {} };
      }
      throw new Error(`unexpected fake iface ${iface}`);
    },
  };
}

async function runCustomerCycle({ sync, ws, runOptions = {} }) {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-order-noble-starvation-"));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  const oldEnv = { ...process.env };
  const originalLog = console.log;
  Object.assign(process.env, {
    ...DISABLED_AUTOMATION_ENV,
    PROFILE_ID: "customer-order-noble-starvation-account",
    STATUS_DOC_DIR: outDir,
    CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_PATH: historyPath,
  });
  console.log = () => {};
  try {
    const result = await runGardenCycle(ws, "test-token", sync, 1, {
      profileId: "customer-order-noble-starvation-account",
      ...runOptions,
    });
    return { result, outDir, historyPath };
  } finally {
    console.log = originalLog;
    process.env = oldEnv;
  }
}

test("a complete gs.index.login with no noble card is a known non-noble customer estimate", async () => {
  const loginSnapshot = {
    $usrTot: { data: { id: "account-a" } },
    $other: { token: "login-token" },
  };
  const ws = {
    async connect() {},
    close() {},
    async request(iface) {
      assert.equal(iface, "gs.index.login");
      return { v: loginSnapshot };
    },
  };
  const opened = await openGameWsSession(
    { host: "127.0.0.1", port_ssl: 443 },
    { token: "login-token" },
    { rchgTot: { cardMap: { 1: { isMain: true } } } },
    { wsFactory: () => ws },
  );
  const markedLoginSnapshot = opened.syncValue;
  assert.equal(markedLoginSnapshot[NOBLE_SESSION_STATE_FIELD], "known-none");
  assert.equal(markedLoginSnapshot.rchgTot?.cardMap, undefined);

  const estimate = estimateExperienceAction({
    iface: "gs.orderCustomer.finishOrder",
    arg: { npcId: 7 },
    syncValue: {
      ...markedLoginSnapshot,
      orderCustomerTot: {
        orderCustomer: {
          orderMap: { 7: { artId: 9001, num: 1 } },
        },
      },
    },
    config: CONFIG,
  });

  assert.equal(estimate.known, true);
  assert.equal(estimate.maxExp, 100);
  assert.equal(estimate.details.nobleAdd, 0);
});

test("uninitialized and partial noble responses remain unknown", () => {
  for (const syncValue of [
    {
      orderCustomerTot: {
        orderCustomer: { orderMap: { 7: { artId: 9001, num: 1 } } },
      },
    },
    {
      rchgTot: {},
      orderCustomerTot: {
        orderCustomer: { orderMap: { 7: { artId: 9001, num: 1 } } },
      },
    },
  ]) {
    const estimate = estimateExperienceAction({
      iface: "gs.orderCustomer.finishOrder",
      arg: { npcId: 7 },
      syncValue,
      config: CONFIG,
    });
    assert.equal(estimate.known, false);
    assert.equal(estimate.source, "customer-order-noble-state-unknown");
  }
});

test("an active noble card and its experience increment survive a partial sync", () => {
  const base = {
    rchgTot: { cardMap: { 1: { isMain: true } } },
    orderCustomerTot: {
      orderCustomer: { orderMap: { 7: { artId: 9001, num: 1 } } },
    },
  };
  const merged = mergeGameSync(base, { rchgTot: {} });
  assert.deepEqual(merged.rchgTot.cardMap, base.rchgTot.cardMap);
  const experienceMerged = mergeExperienceSync(base, { rchgTot: {} });
  assert.deepEqual(experienceMerged.rchgTot.cardMap, base.rchgTot.cardMap);

  const estimate = estimateExperienceAction({
    iface: "gs.orderCustomer.finishOrder",
    arg: { npcId: 7 },
    syncValue: merged,
    config: CONFIG,
  });
  assert.equal(estimate.known, true);
  assert.equal(estimate.maxExp, 100);
  assert.equal(estimate.details.nobleAdd, 0.25);
});

test("a blocked customer finish keeps its order and continues to the later no-exp make-art action", async (t) => {
  const ws = makeFakeWs();
  const { result, outDir, historyPath } = await runCustomerCycle({
    sync: makeCustomerSync({
      currentExp: 99,
      nextExp: 100,
      cardMap: {},
      orderMap: {
        8: { artId: 300101, num: 3 },
        9: { artId: 300102, num: 3 },
      },
      bagOverrides: { 300102: 0 },
    }),
    ws,
    runOptions: {
      experienceConfig: {
        ...CONFIG,
        flowerArts: new Map([
          [300101, { id: 300101, experiencePrice: 1, experiencePriceKnown: true, flowerIds: [] }],
          [300102, { id: 300102, experiencePrice: 1, experiencePriceKnown: true, flowerIds: [] }],
        ]),
      },
      getExperienceGuardThresholdPercent: () => 1,
    },
  });
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));

  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
  assert.equal(
    ws.requestLog.filter((item) => item.iface === "gs.flowerArt.makeFlowerArt").length,
    1,
  );
  assert.ok(result.orderCustomerTot.orderCustomer.orderMap[8]);
  assert.ok(result.orderCustomerTot.orderCustomer.orderMap[9]);
  assert.equal(fs.existsSync(historyPath), false);
  const status = JSON.parse(await fsp.readFile(path.join(outDir, "garden-status.json"), "utf8"));
  assert.equal(
    status.runHistory.customerOrderSubmissions.some((entry) => (
      entry.npcId === 8 && entry.outcome === "completed"
    )),
    false,
  );
});

test("a blocked customer finish continues to a later no-exp reject in the same cycle", async (t) => {
  const orderState = { afterExperienceRefresh: false, lazySyncCount: 0 };
  const laterRejectOrder = {};
  Object.defineProperties(laterRejectOrder, {
    artId: { enumerable: true, value: 300102 },
    num: {
      enumerable: true,
      get: () => (orderState.afterExperienceRefresh ? 2 : 3),
    },
    automationPendingArtSync: {
      enumerable: true,
      get: () => (orderState.afterExperienceRefresh
        ? null
        : { artId: 300102, expectedCount: 3 }),
    },
  });
  const ws = makeFakeWs({
    onRequest({ iface }) {
      if (iface !== "gs.usr.lazySync") return;
      orderState.lazySyncCount += 1;
      if (orderState.lazySyncCount === 2) orderState.afterExperienceRefresh = true;
    },
  });
  const { result, outDir, historyPath } = await runCustomerCycle({
    sync: makeCustomerSync({
      currentExp: 99,
      nextExp: 100,
      cardMap: {},
      orderMap: {
        8: { artId: 300101, num: 3 },
        9: laterRejectOrder,
      },
      bagOverrides: { 300102: 0 },
    }),
    ws,
    runOptions: {
      experienceConfig: {
        ...CONFIG,
        flowerArts: new Map([
          [300101, { id: 300101, experiencePrice: 1, experiencePriceKnown: true, flowerIds: [] }],
          [300102, { id: 300102, experiencePrice: 1, experiencePriceKnown: true, flowerIds: [] }],
        ]),
      },
      getExperienceGuardThresholdPercent: () => 1,
    },
  });
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));

  assert.ok(orderState.lazySyncCount >= 2);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
  assert.deepEqual(ws.requestLog.filter((item) => item.iface === "gs.orderCustomer.rejectOrder"), [
    { iface: "gs.orderCustomer.rejectOrder", args: { npcId: 9 } },
  ]);
  assert.ok(result.orderCustomerTot.orderCustomer.orderMap[8]);
  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[9], undefined);
  assert.equal(fs.existsSync(historyPath), false);
  const status = JSON.parse(await fsp.readFile(path.join(outDir, "garden-status.json"), "utf8"));
  const submissions = status.runHistory.customerOrderSubmissions;
  assert.equal(
    submissions.some((entry) => entry.npcId === 8 && entry.outcome === "completed"),
    false,
  );
  assert.equal(
    submissions.some((entry) => (
      entry.npcId === 8
      && entry.customerOrderFlowerCurrencyHistoryUpdate === "completed"
    )),
    false,
  );
  assert.equal(
    submissions.some((entry) => (
      entry.npcId === 9
      && entry.customerOrderActionType === "rejectCustomerOrder"
      && entry.customerOrderFlowerCurrencyHistoryUpdate === "reject-no-history-update"
    )),
    true,
  );
  const blockedIndex = submissions.findIndex((entry) => (
    entry.npcId === 8
    && entry.outcome === "skipped"
    && entry.customerOrderFlowerCurrencyHistoryUpdate === "finish-blocked-no-history-update"
  ));
  const rejectIndex = submissions.findIndex((entry) => (
    entry.npcId === 9
    && entry.customerOrderActionType === "rejectCustomerOrder"
  ));
  assert.ok(blockedIndex >= 0);
  assert.ok(rejectIndex > blockedIndex);
});
