import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getAccountCustomerOrderFlowerCurrencyHistory,
  loadCustomerOrderFlowerCurrencyHistory,
  updateCustomerOrderFlowerCurrencyHistory,
} from "./customer-order-flower-currency-history.mjs";

const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-order-runtime=${Date.now()}`);

const DISABLED_AUTOMATION_ENV = {
  AUTO_SUBMIT_SPECIAL_ORDERS: "0",
  AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: "0",
  AUTO_SUBMIT_PALACE_ORDERS: "0",
  AUTO_SUBMIT_MAIN_TASKS: "0",
  AUTO_SUBMIT_CUSTOMER_ORDERS: "1",
  CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0",
  CUSTOMER_ORDER_MAX_STEPS_PER_CYCLE: "1",
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

let runtimeCycleQueue = Promise.resolve();

function makeSync({
  accountId = "runtime-account",
  level = 40,
  currentExp = 1_000_000,
  nextExp = 10_000_000,
  num = 2,
  artCount = 0,
  flowerCount = 0,
  bagOverrides = {},
  orderMap = null,
  activeArtIds = null,
} = {}) {
  const sync = {
    $usrTot: {
      data: {
        id: accountId,
        lvl: level,
        lvlExp: currentExp,
        nextExp,
        bag: {
          7: 99,
          3001: num,
          300101: artCount,
          23001: flowerCount,
          23002: flowerCount,
          23003: flowerCount,
          ...bagOverrides,
        },
      },
    },
    videoDouble: { eTime: "2099-01-01T00:00:00.000Z" },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: orderMap || {
          8: { artId: 300101, num, cTime: "2026-08-23T00:00:00.000Z" },
        },
      },
    },
    usrLandTot: { usrLand: { landMap: {} } },
    cultivateTot: { cultivateMap: {} },
    rchgTot: { cardMap: {} },
  };
  if (activeArtIds !== null) {
    sync.flowerArtTot = { flowerArt: { makeList: activeArtIds } };
  }
  return sync;
}

function makeFakeWs({ rejectError = null, finishError = null } = {}) {
  const requestLog = [];
  return {
    requestLog,
    observeSync() {},
    async request(iface, args) {
      requestLog.push({ iface, args });
      if (iface === "gs.orderCustomer.rejectOrder" && rejectError) throw rejectError;
      if (iface === "gs.orderCustomer.finishOrder" && finishError) throw finishError;
      if (
        iface === "gs.usrLand.refresh"
        || iface === "gs.usr.heartTick"
        || iface === "gs.usr.lazySync"
        || iface === "gs.orderCustomer.refreshOrder"
        || iface === "gs.orderCustomer.rejectOrder"
        || iface === "gs.orderCustomer.finishOrder"
        || iface === "gs.flowerArt.makeFlowerArt"
      ) return { v: {} };
      throw new Error(`unexpected fake iface ${iface}`);
    },
  };
}

async function runCustomerCycle(t, {
  sync,
  historyPath,
  ws,
  accountId = "runtime-account",
  profileSettingsPath = null,
  runOptions = {},
} = {}) {
  const waitForPrevious = runtimeCycleQueue;
  let release;
  runtimeCycleQueue = new Promise((resolve) => {
    release = resolve;
  });
  await waitForPrevious;
  const outDir = path.dirname(historyPath);
  const oldEnv = { ...process.env };
  const originalLog = console.log;
  Object.assign(process.env, {
    ...DISABLED_AUTOMATION_ENV,
    PROFILE_ID: accountId,
    STATUS_DOC_DIR: outDir,
    CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_PATH: historyPath,
    ...(profileSettingsPath ? { PROFILE_SETTINGS_PATH: profileSettingsPath } : {}),
  });
  console.log = () => {};
  try {
    return await runGardenCycle(ws, "test-token", sync, 1, {
      profileId: accountId,
      ...runOptions,
    });
  } finally {
    console.log = originalLog;
    process.env = oldEnv;
    release();
  }
}

function makeCustomerExperienceConfig() {
  return {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map(),
    flowerLevelCfg: new Map(),
    flowerArts: new Map([[
      300101,
      {
        id: 300101,
        experiencePrice: 1,
        experiencePriceKnown: true,
        flowerIds: [],
      },
    ]]),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: { rewardBaseExperience: 8_000, orders: new Map() },
  };
}

test("a reward outside the default release list uses official reject, removes the order, and leaves history untouched", async (t) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-runtime-reject-"));
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  const ws = makeFakeWs();

  const result = await runCustomerCycle(t, {
    sync: makeSync({ num: 2, flowerCount: 2 }),
    historyPath,
    ws,
  });

  assert.deepEqual(result.orderCustomerTot.orderCustomer.orderMap, {});
  assert.deepEqual(ws.requestLog.filter((item) => item.iface === "gs.orderCustomer.rejectOrder"), [
    { iface: "gs.orderCustomer.rejectOrder", args: { npcId: 8 } },
  ]);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.makeFlowerArt"), false);
  assert.equal(fs.existsSync(historyPath), false);

  const statusJson = JSON.parse(await fsp.readFile(path.join(outDir, "garden-status.json"), "utf8"));
  assert.equal(statusJson.runHistory.customerOrderSubmissions[0].steps[0].type, "rejectCustomerOrder");
  assert.equal(statusJson.runHistory.customerOrderSubmissions[0].customerOrderFlowerCurrencyHistoryUpdate, "reject-no-history-update");
  assert.match(statusJson.runHistory.customerOrderSubmissions[0].customerOrderRejectReasonText, /收益 2 未在当前放行列表/);
  for (const fileName of ["garden-status.json", "garden-status.md", "garden-status.html"]) {
    const content = await fsp.readFile(path.join(outDir, fileName), "utf8");
    assert.match(content, /按官方按钮拒绝顾客订单/);
  }
});

test("failed official reject keeps the order and does not update history", async (t) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-runtime-reject-failed-"));
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  const ws = makeFakeWs({ rejectError: new Error("reject failed") });

  const result = await runCustomerCycle(t, {
    sync: makeSync({ num: 2, flowerCount: 2 }),
    historyPath,
    ws,
  });

  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8].num, 2);
  assert.equal(ws.requestLog.filter((item) => item.iface === "gs.orderCustomer.rejectOrder").length, 1);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
  assert.equal(fs.existsSync(historyPath), false);
  const statusJson = JSON.parse(await fsp.readFile(path.join(outDir, "garden-status.json"), "utf8"));
  const failedSubmission = statusJson.runHistory.customerOrderSubmissions.at(-1);
  assert.equal(failedSubmission.outcome, "failed");
  assert.equal(failedSubmission.customerOrderFlowerCurrencyHistoryUpdate, "reject-failed-no-history-update");
  assert.match(failedSubmission.outcomeText, /订单保留且不更新历史审计记录/);
});

test("successful selected finish records audit history, but a future reward is rejected by the exact release list", async (t) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-runtime-finish-"));
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  await updateCustomerOrderFlowerCurrencyHistory({
    historyPath,
    accountId: "runtime-account",
    reward: 3,
    completed: true,
    settlementStatus: "completed",
  });

  const ws = makeFakeWs();
  const result = await runCustomerCycle(t, {
    sync: makeSync({ num: 3, artCount: 3 }),
    historyPath,
    ws,
  });

  assert.deepEqual(result.orderCustomerTot.orderCustomer.orderMap, {});
  assert.equal(ws.requestLog.filter((item) => item.iface === "gs.orderCustomer.finishOrder").length, 1);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.rejectOrder"), false);
  const reloaded = loadCustomerOrderFlowerCurrencyHistory(historyPath);
  assert.equal(getAccountCustomerOrderFlowerCurrencyHistory(reloaded, "runtime-account").historicalMaxReward, 3);

  const highWs = makeFakeWs();
  const highResult = await runCustomerCycle(t, {
    sync: makeSync({ num: 4, artCount: 4 }),
    historyPath,
    ws: highWs,
  });
  assert.deepEqual(highResult.orderCustomerTot.orderCustomer.orderMap, {});
  assert.equal(highWs.requestLog.filter((item) => item.iface === "gs.orderCustomer.finishOrder").length, 0);
  assert.equal(highWs.requestLog.filter((item) => item.iface === "gs.orderCustomer.rejectOrder").length, 1);
  assert.equal(
    getAccountCustomerOrderFlowerCurrencyHistory(loadCustomerOrderFlowerCurrencyHistory(historyPath), "runtime-account").historicalMaxReward,
    3,
  );
});

test("failed selected final finish keeps the order and does not raise the historical maximum", async (t) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-runtime-finish-failed-"));
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  await updateCustomerOrderFlowerCurrencyHistory({
    historyPath,
    accountId: "runtime-account",
    reward: 3,
    completed: true,
    settlementStatus: "completed",
  });
  const ws = makeFakeWs({ finishError: new Error("finish failed") });

  const result = await runCustomerCycle(t, {
    sync: makeSync({ num: 3, artCount: 3 }),
    historyPath,
    ws,
  });

  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8].num, 3);
  assert.equal(ws.requestLog.filter((item) => item.iface === "gs.orderCustomer.finishOrder").length, 1);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.rejectOrder"), false);
  assert.equal(
    getAccountCustomerOrderFlowerCurrencyHistory(loadCustomerOrderFlowerCurrencyHistory(historyPath), "runtime-account").historicalMaxReward,
    3,
  );
});

test("selected customer finish is blocked by the unified experience gateway before transport and local completion", async (t) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-runtime-experience-block-"));
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  const ws = makeFakeWs();
  const sync = makeSync({
    currentExp: 99,
    nextExp: 100,
    num: 3,
    artCount: 3,
  });

  const result = await runCustomerCycle(t, {
    sync,
    historyPath,
    ws,
    runOptions: {
      experienceConfig: makeCustomerExperienceConfig(),
      getExperienceGuardThresholdPercent: () => 1,
    },
  });

  assert.equal(
    ws.requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"),
    false,
  );
  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8].num, 3);
  const statusJson = JSON.parse(await fsp.readFile(path.join(outDir, "garden-status.json")));
  assert.deepEqual(statusJson.customerOrders.flowerCurrencySelection.releaseRewards, [3]);
  assert.equal(statusJson.customerOrders.orders[0].flowerCurrencyDecision, "selected-reward");
  assert.equal(
    statusJson.summary.cycleErrors.some((error) => (
      error.reason === "experience-protection-boundary"
      && error.category === "action-blocked"
    )),
    true,
  );
  assert.equal(fs.existsSync(historyPath), false);
});

test("experience-protected customer cycle still sends official reject without finish or history", async (t) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-runtime-experience-reject-"));
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  const ws = makeFakeWs();
  const result = await runCustomerCycle(t, {
    sync: makeSync({
      currentExp: 99,
      nextExp: 100,
      num: 2,
      flowerCount: 2,
    }),
    historyPath,
    ws,
    runOptions: {
      experienceConfig: makeCustomerExperienceConfig(),
      getExperienceGuardThresholdPercent: () => 1,
    },
  });

  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8], undefined);
  assert.deepEqual(ws.requestLog.filter((item) => item.iface === "gs.orderCustomer.rejectOrder"), [
    { iface: "gs.orderCustomer.rejectOrder", args: { npcId: 8 } },
  ]);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
  assert.equal(fs.existsSync(historyPath), false);
});

test("an explicitly invalid customer reward mask pauses the cycle without finish or reject", async (t) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-runtime-invalid-mask-"));
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  const ws = makeFakeWs();
  const result = await runCustomerCycle(t, {
    sync: makeSync({ num: 3, artCount: 3 }),
    historyPath,
    ws,
    runOptions: {
      customerOrderFlowerCurrencyRewardReleaseMask: 8,
    },
  });

  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8].num, 3);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.rejectOrder"), false);
  const statusJson = JSON.parse(await fsp.readFile(path.join(outDir, "garden-status.json"), "utf8"));
  assert.deepEqual(statusJson.customerOrders.flowerCurrencySelection.releaseRewards, []);
  assert.equal(statusJson.customerOrders.flowerCurrencySelection.releaseMask, 0);
  assert.equal(statusJson.customerOrders.orders[0].flowerCurrencyDecision, "fail-closed-release-disabled");
  assert.equal(fs.existsSync(historyPath), false);
});

test("an unreadable customer reward settings file pauses the cycle without finish or reject", async (t) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-runtime-settings-fail-closed-"));
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  const settingsPath = path.join(outDir, "profile-settings.json");
  await fsp.writeFile(settingsPath, "{invalid json", "utf8");
  const ws = makeFakeWs();
  const result = await runCustomerCycle(t, {
    sync: makeSync({ num: 3, artCount: 3 }),
    historyPath,
    ws,
    profileSettingsPath: settingsPath,
    runOptions: {
      experienceGuardStatePath: path.join(outDir, "experience-guard.json"),
    },
  });

  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8].num, 3);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.rejectOrder"), false);
  const statusJson = JSON.parse(await fsp.readFile(path.join(outDir, "garden-status.json"), "utf8"));
  assert.deepEqual(statusJson.customerOrders.flowerCurrencySelection.releaseRewards, []);
  assert.equal(statusJson.customerOrders.flowerCurrencySelection.releaseMask, 0);
  assert.equal(statusJson.customerOrders.orders[0].flowerCurrencyDecision, "fail-closed-release-disabled");
  assert.equal(fs.existsSync(historyPath), false);
});

test("making flower art alone does not update history", async (t) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-runtime-make-"));
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  const ws = makeFakeWs();

  const result = await runCustomerCycle(t, {
    sync: makeSync({ num: 3, flowerCount: 3 }),
    historyPath,
    ws,
  });

  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8].num, 3);
  assert.equal(ws.requestLog.filter((item) => item.iface === "gs.flowerArt.makeFlowerArt").length, 1);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.rejectOrder"), false);
  assert.equal(fs.existsSync(historyPath), false);
});

test("confirmed flower shortage rejects a selected customer order and leaves history unchanged", async (t) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-runtime-priority-reject-"));
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  await updateCustomerOrderFlowerCurrencyHistory({
    historyPath,
    accountId: "runtime-account",
    reward: 3,
    completed: true,
    settlementStatus: "completed",
  });
  const ws = makeFakeWs();
  const result = await runCustomerCycle(t, {
    sync: makeSync({
      bagOverrides: {
        3001: 5,
        300101: 0,
        23001: 0,
        23002: 0,
        23003: 0,
      },
      orderMap: {
        8: { artId: 300101, num: 3, cTime: "2026-08-23T00:00:00.000Z" },
      },
      activeArtIds: [300101],
    }),
    historyPath,
    ws,
  });

  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8], undefined);
  assert.deepEqual(ws.requestLog.filter((item) => item.iface === "gs.orderCustomer.rejectOrder"), [
    { iface: "gs.orderCustomer.rejectOrder", args: { npcId: 8 } },
  ]);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.flowerArt.makeFlowerArt"), false);
  assert.equal(
    getAccountCustomerOrderFlowerCurrencyHistory(loadCustomerOrderFlowerCurrencyHistory(historyPath), "runtime-account").historicalMaxReward,
    3,
  );
  const submission = JSON.parse(await fsp.readFile(path.join(outDir, "garden-status.json"), "utf8"))
    .runHistory.customerOrderSubmissions.at(-1);
  assert.equal(submission.customerOrderPriorityReject, true);
  assert.equal(submission.customerOrderPriorityRejectReason, "flower-stock-insufficient");
  assert.equal(submission.customerOrderFlowerCurrencyHistoryUpdate, "reject-no-history-update");
  assert.match(submission.customerOrderRejectReasonText, /制作所需花朵库存不足/);
});

test("failed selected priority reject keeps the shortage order and does not update history", async (t) => {
  const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-runtime-priority-reject-failed-"));
  t.after(() => fsp.rm(outDir, { recursive: true, force: true }));
  const historyPath = path.join(outDir, "customer-order-flower-currency-history.json");
  await updateCustomerOrderFlowerCurrencyHistory({
    historyPath,
    accountId: "runtime-account",
    reward: 3,
    completed: true,
    settlementStatus: "completed",
  });
  const ws = makeFakeWs({ rejectError: new Error("priority reject failed") });
  const result = await runCustomerCycle(t, {
    sync: makeSync({
      bagOverrides: {
        3001: 5,
        300101: 0,
        23001: 0,
        23002: 0,
        23003: 0,
      },
      orderMap: {
        8: { artId: 300101, num: 3, cTime: "2026-08-23T00:00:00.000Z" },
      },
      activeArtIds: [300101],
    }),
    historyPath,
    ws,
  });

  assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8].artId, 300101);
  assert.equal(ws.requestLog.filter((item) => item.iface === "gs.orderCustomer.rejectOrder").length, 1);
  assert.equal(ws.requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
  assert.equal(
    getAccountCustomerOrderFlowerCurrencyHistory(loadCustomerOrderFlowerCurrencyHistory(historyPath), "runtime-account").historicalMaxReward,
    3,
  );
  const submission = JSON.parse(await fsp.readFile(path.join(outDir, "garden-status.json"), "utf8"))
    .runHistory.customerOrderSubmissions.at(-1);
  assert.equal(submission.customerOrderPriorityReject, true);
  assert.equal(submission.customerOrderPriorityRejectReason, "flower-stock-insufficient");
  assert.equal(submission.outcome, "failed");
  assert.equal(submission.customerOrderFlowerCurrencyHistoryUpdate, "reject-failed-no-history-update");
  assert.match(submission.outcomeText, /订单保留且不更新历史审计记录/);
  assert.match(submission.customerOrderRejectReasonText, /制作所需花朵库存不足/);
});
